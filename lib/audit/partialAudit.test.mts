/**
 * An audit whose entry page could not be fetched securely, end to end.
 *
 * WHAT THIS SUITE IS FOR. A site whose certificate fails used to produce a
 * failed job and no report at all — the one finding that mattered, thrown away
 * with the failure. It now produces a partial audit, and the claim worth
 * testing is not that a report exists but that everything in it is true: the
 * certificate was measured, the page was not, and the report says which is
 * which.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The shared fixture's fetcher stands in for
 * the socket and its site checks stand in for the certificate and DNS lookups,
 * with `runRealAudit`'s own guard failing the call if anything reaches out.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { PAGE_CHECKS_NOT_RUN } from "./siteAudit.ts";
import { buildPdfDocument } from "./pdfDocument.ts";
import { explainJob } from "./explainJob.ts";
import { renderPdf } from "./pdf/render.ts";
import { extractText } from "./pdf/pdfText.fixture.mts";
import {
  fetcherFor,
  runRealCertificateFailure,
  siteChecksFor,
  siteFilesFor,
  type FakeSite,
  type FakeSiteChecks,
} from "./pdf/realAudit.fixture.mts";
import { startAudit } from "../jobs/auditJobs.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { resultAnswer } from "../jobs/jobResponses.ts";
import { PAGE_RULES } from "../rules/all.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import type { AuditResult, SpeedResult } from "../types.ts";

const ENTRY = "https://example.com/";

/** A site whose entry page answers the fetch with a refused certificate. */
const BROKEN: FakeSite = {
  [ENTRY]: {
    html: "",
    unreadable: "The website's security certificate has expired.",
    certificateProblem: "expired",
  },
};

/** The same address, readable. */
const HEALTHY: FakeSite = {
  [ENTRY]: {
    html:
      '<!doctype html><html lang="en"><head><title>Example Company</title></head><body><h1>Welcome</h1>' +
      "<p>We sell widgets to businesses across the country and have done so since 1994.</p></body></html>",
  },
};

/** One audit, run through the job runner exactly as the route runs it. */
async function runJob(site: FakeSite, checks: FakeSiteChecks = { certificateExpired: true }) {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult>();
  const { jobId, finished } = await Promise.resolve(
    startAudit(ENTRY, {
      store,
      audit: {
        crawl: {
          fetchImpl: fetcherFor(site),
          sitemapFetchImpl: siteFilesFor(),
          useSitemaps: false,
        },
        siteChecksImpl: siteChecksFor(checks),
      },
    }),
  );
  await finished;
  return { store, jobId, job: store.get(jobId) };
}

// ---------------------------------------------------------------------------
// The audit itself
// ---------------------------------------------------------------------------

test("an entry page whose certificate failed produces an audit, not a failure", async () => {
  const audit = await runRealCertificateFailure({ site: BROKEN, checks: { certificateExpired: true } });

  assert.equal(audit.kind, "certificate-failure");
  assert.equal(audit.certificateProblem, "expired", "the fetcher's own classification, carried");
  assert.equal(audit.reason, "The website's security certificate has expired.");
  assert.equal(audit.failedUrl, ENTRY);
  assert.equal(audit.website.requestedUrl, ENTRY);
});

test("the certificate was read, graded, and reaches the report", async () => {
  const audit = await runRealCertificateFailure({ site: BROKEN, checks: { certificateExpired: true } });
  const expired = audit.site.findings.find((finding) => finding.id === "security.ssl.expired");

  assert.ok(expired, "the expiry rule fired on the certificate the check read");
  assert.equal(expired.severity, "critical");
  assert.equal(expired.scope, "site");
  assert.match(expired.evidence, /expired \d+ day\(s\) ago/);
  assert.equal(audit.ssl.status, "checked");
  assert.equal(audit.ssl.trusted, false);
});

test("nothing page-shaped is reported, and no count pretends a page was read", async () => {
  const audit = await runRealCertificateFailure({ site: BROKEN });

  // The shape itself carries no page: there is nothing to read a heading,
  // an image count or a response header from.
  assert.equal("data" in audit, false);
  assert.equal("pages" in audit, false);

  assert.equal(audit.site.evaluatedPages, 0);
  assert.equal(audit.crawl.evaluated, 0);
  assert.equal(audit.crawl.unavailable.length, 1, "the address that could not be read");

  // No page-scoped rule produced a finding, because none of them ran.
  assert.deepEqual(
    audit.site.findings.filter((finding) => finding.scope === "page"),
    [],
  );
});

test("every page check is listed as one that did not run, with one reason", async () => {
  const audit = await runRealCertificateFailure({ site: BROKEN });
  const skipped = new Map(audit.site.skippedChecks.map((check) => [check.ruleId, check.reason]));

  for (const rule of PAGE_RULES) {
    assert.equal(skipped.get(rule.id), PAGE_CHECKS_NOT_RUN, `${rule.id} must say it did not run`);
  }
  assert.ok(PAGE_RULES.length >= 10, "and that is most of the audit's checks");
});

// ---------------------------------------------------------------------------
// The job, and what the result endpoint hands over
// ---------------------------------------------------------------------------

test("the job finishes as partial, with the audit stored rather than an error", async () => {
  const { job } = await runJob(BROKEN);

  assert.equal(job?.status, "partial", "not failed: there is a report to read");
  assert.equal(job?.error, null);
  assert.ok(job?.result && isCertificateFailureAudit(job.result));
});

test("the result endpoint answers with the audit, and its certificate problem", async () => {
  const { store, jobId } = await runJob(BROKEN);
  const answer = resultAnswer(jobId, store.get(jobId));

  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  if (!answer.body.ok) return;
  assert.equal(answer.body.status, "partial");
  assert.ok(isCertificateFailureAudit(answer.body.result));
  if (!isCertificateFailureAudit(answer.body.result)) return;
  assert.equal(answer.body.result.certificateProblem, "expired");
});

test("a connection failure that is not about a certificate still fails the job", async () => {
  // The same shape of audit, refused for a reason the fetcher did not classify
  // as a certificate problem. Nothing about the site was measured, so there is
  // nothing to report and the job says so.
  const unreachable: FakeSite = {
    [ENTRY]: { html: "", unreadable: "That website address could not be found." },
  };
  const { job } = await runJob(unreachable);

  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "That website address could not be found.");
  assert.equal(job?.result, null);
});

test("a site that could be read is audited exactly as before", async () => {
  const { job } = await runJob(HEALTHY, { spfMissing: true });

  assert.equal(job?.status, "completed");
  assert.ok(job?.result && !isCertificateFailureAudit(job.result));
  if (!job?.result || isCertificateFailureAudit(job.result)) return;
  assert.equal(job.result.crawl.evaluated, 1);
  assert.equal(job.result.pages.length, 1);
  assert.equal(job.result.data.fetch.finalUrl, ENTRY);
});

// ---------------------------------------------------------------------------
// The commentary, which is not asked for
// ---------------------------------------------------------------------------

test("no model is asked about an audit with no page measurements", async () => {
  const { store, jobId } = await runJob(BROKEN);
  let asked = 0;

  const outcome = await explainJob(jobId, store, {
    explain: async () => {
      asked += 1;
      return { state: "not-explained", reason: "internal-error", message: "should not be asked" };
    },
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "no-page-measurements");
  assert.equal(asked, 0, "the provider was never reached");
  assert.equal(store.get(jobId)?.explanation, null, "and nothing was stored as an answer");
});

// ---------------------------------------------------------------------------
// The document, and the PDF made from it
// ---------------------------------------------------------------------------

/** The projection for a finished partial audit, as the export route builds it. */
async function partialDocument() {
  const { store, jobId } = await runJob(BROKEN);
  const outcome = buildPdfDocument(jobId, store, { companyName: "Acme Widgets Ltd" });
  if (!outcome.ok) assert.fail(`the projection refused a partial audit: ${outcome.reason}`);
  return outcome.document;
}

test("the document says it is partial, and why, in the report layer's words", async () => {
  const document = await partialDocument();

  assert.equal(document.cover.partial, true);
  assert.equal(document.cover.statusLine, "Partial website audit");
  assert.equal(document.cover.auditedUrl, ENTRY);
  assert.equal(document.coverage.partial, true);
  assert.match(document.coverage.headline, /could not be fetched securely/);
  assert.equal(document.coverage.stopReason, "The website's security certificate has expired.");
  assert.deepEqual(
    document.coverage.facts.map((fact) => fact.label),
    ["Address", "Certificate problem", "Checked", "Not checked"],
  );
});

test("the document carries the certificate and the domain records, and no page sections", async () => {
  const document = await partialDocument();

  assert.deepEqual(
    document.measured.map((section) => section.heading),
    ["Certificate", "Domain and email records"],
    "no content section and no response headers: no page was read",
  );
  assert.ok(
    document.measured[0].facts.some((fact) => fact.label === "Certificate problem"),
    "the problem seen while connecting is stated",
  );
  assert.equal(document.coverageDetail.length, 0, "crawl counts describe a crawl that read nothing");

  // The findings it does carry are the site's own.
  assert.ok(document.siteFindings.count > 0);
  assert.equal(document.pageFindings.count, 0);
  assert.equal(document.summary.ai, null, "nothing was asked, so nothing is quoted");
});

test("the document says the speed check did not run, rather than leaving it blank", async () => {
  const document = await partialDocument();

  assert.equal(document.speed.measured, false);
  if (document.speed.measured) return;
  assert.match(document.speed.message, /Page speed was not measured/);
  assert.match(document.speed.message, /no page to measure/);
});

test("the checks that did not run are listed, grouped under one reason", async () => {
  const document = await partialDocument();

  assert.ok(document.skipped, "the panel is shown");
  if (!document.skipped) return;
  assert.ok(document.skipped.count >= PAGE_RULES.length);
  const reasons = document.skipped.groups.map((group) => group.reason);
  assert.ok(reasons.includes(PAGE_CHECKS_NOT_RUN), "in the audit's own words");
});

test("the PDF renders, and reads as a partial audit naming the certificate problem", async () => {
  const pdf = await renderPdf(await partialDocument());

  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.includes(Buffer.from("%%EOF")));

  const text = extractText(pdf);
  assert.match(text, /Partial audit/, "the marker a reader cannot miss");
  assert.match(text, /could not be fetched securely/);
  assert.match(text, /security certificate has expired/);
  assert.match(text, /TLS certificate has expired/, "and the graded finding itself");

  // The two sentences that would make it read as a finished whole-site audit.
  assert.doesNotMatch(text, /Website audit complete/);
  assert.doesNotMatch(text, /Every page we found was visited/);
});
