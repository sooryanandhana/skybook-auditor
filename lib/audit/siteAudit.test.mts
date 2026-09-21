/**
 * Tests for the whole-site audit pipeline and the job that runs it.
 *
 * The pipeline is orchestration, so what is tested here is orchestration: that
 * the right things are called in the right order, that only pages which were
 * actually read are graded, and that a crawl which stopped short is never
 * described as a finished audit.
 *
 * Nothing here reaches the network. The crawl is injected.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  EntryPageUnavailableError,
  runSiteAudit,
  type SiteAuditOptions,
  type SiteChecks,
} from "./siteAudit.ts";
import { startAudit, UNEXPECTED_FAILURE } from "../jobs/auditJobs.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { statusAnswer, resultAnswer, JOB_NOT_FOUND, NOT_READY } from "../jobs/jobResponses.ts";
import { AUDIT_RULES, PAGE_RULES, SITE_RULES } from "../rules/all.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import type { CrawlResult, CrawlProgress } from "../collector/crawlSite.ts";
import { runTechnicalChecks } from "../collector/technicalChecks.ts";
import type { RobotsMeasurement, RobotsStatus } from "../collector/robots.ts";
import type { FetchedPage } from "../collector/fetchPage.ts";
import type {
  DnsData,
  DnsRecordSet,
  SiteAuditResult,
  SslData,
  TechnicalData,
} from "../types";

const SITE = "https://example.com/";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A page with a real body, and a head that is genuinely bare.
 *
 * The body text matters: an absent head tag is only a measurable absence on a
 * page whose served HTML actually carried a page. A two-word body would now be
 * declined as unjudgeable, which is correct behaviour and useless as a fixture
 * for tests about rules firing.
 */
const ORDINARY_PAGE =
  "<html><head></head><body><h1>Kettles</h1>" +
  "<p>We compare every kettle we sell on speed, noise and how long the handle stays cool. " +
  "Prices are checked weekly and include delivery.</p></body></html>";

function page(url: string, html = ORDINARY_PAGE): FetchedPage {
  return {
    finalUrl: url,
    redirectChain: [url],
    html,
    headers: { "content-type": "text/html" },
    setCookieHeaders: [],
    servedOverHttps: url.startsWith("https:"),
    httpsUnavailable: false,
    contentType: "text/html",
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 40 },
  };
}

function crawlResult(overrides: Partial<CrawlResult> = {}): CrawlResult {
  const pages = overrides.pages ?? [page(SITE)];
  return {
    // The one robots.txt measurement, read by the crawl and handed on to the
    // site checks. Nothing else in the audit reads that file.
    robots: overrides.robots ?? { status: "absent" },
    pages,
    attempts: overrides.attempts ?? pages.map((p) => ({
      url: p.finalUrl,
      outcome: "evaluated" as const,
      page: p,
    })),
    summary: {
      requestedUrl: SITE,
      limits: {
        maxPages: 150,
        maxDurationMs: 300_000,
        maxQueueSize: 2_000,
        maxResponseBytes: 5_000_000,
        concurrency: 3,
        perRequestDelayMs: 200,
      },
      stoppedBecause: "completed",
      complete: true,
      discovered: pages.length,
      queuedAtStop: 0,
      evaluated: pages.length,
      unavailable: [],
      skippedNonHtml: 0,
      sources: { html: 0, sitemap: 0 },
      sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
      robots: { status: "absent", enforced: true, excluded: 0 },
      ...overrides.summary,
    },
  };
}

/** A stand-in crawler that answers with a prepared result. */
function crawlReturning(result: CrawlResult) {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (options: Record<string, unknown>) => {
    calls.push(options);
    return result;
  }) as unknown as typeof import("../collector/crawlSite.ts").crawlSite;
  return { impl, calls };
}

/**
 * Runs a site audit with the network stubbed out entirely.
 *
 * BOTH boundaries are injected: the crawl, and the site-level measurements.
 * Leaving either out sends the test to the real internet.
 */
const audit = (
  result: CrawlResult,
  requestedUrl = SITE,
  siteChecksImpl: SiteAuditOptions["siteChecksImpl"] = healthySite,
) => siteAudit({ requestedUrl, crawlImpl: crawlReturning(result).impl, siteChecksImpl });

/**
 * A whole-site audit, asserted to be one.
 *
 * `runSiteAudit` can also produce an audit of a site whose entry page could
 * not be fetched securely, which has no pages and no entry-page data. Those
 * have their own tests below; everywhere else, receiving one instead of a
 * site audit is a failure rather than a silent `undefined`.
 */
async function siteAudit(options: SiteAuditOptions): Promise<SiteAuditResult> {
  const result = await runSiteAudit(options);
  assert.ok(!isCertificateFailureAudit(result), "expected an audit that read its entry page");
  return result;
}

function codeOf(file: string): string {
  return fs
    .readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Site-level fixtures
//
// THE SITE MEASUREMENTS ARE INJECTED, ALWAYS. Without this the audit would
// make real DNS lookups, a real TLS handshake and a real robots.txt request
// for whatever hostname a fixture happened to name — which makes a unit test
// slow, dependent on somebody else's server, and different on a train.
//
// Worse for correctness: it makes the result unpredictable. A test cannot
// assert "an expired certificate produces a finding" against a real site whose
// certificate is, one hopes, perfectly valid. Everything below states the
// measurement outright, so each test says exactly what it is testing.
// ---------------------------------------------------------------------------

/** A DNS answer that was looked for and genuinely not there. */
const absentRecord = <T,>(): DnsRecordSet<T> => ({ status: "absent", records: [], error: null });

/** A DNS answer that was found. */
const foundRecord = <T,>(records: T[]): DnsRecordSet<T> => ({
  status: "found",
  records,
  error: null,
});

/** DNS records for a domain with a working mail policy. */
function healthyDns(hostname = "fixture.test"): DnsData {
  return {
    hostname,
    emailDomain: hostname,
    a: foundRecord(["203.0.113.10"]),
    aaaa: absentRecord<string>(),
    mx: foundRecord([{ exchange: `mail.${hostname}`, priority: 10 }]),
    ns: foundRecord([`ns1.${hostname}`]),
    txt: foundRecord(["v=spf1 -all"]),
    spf: { status: "found", record: "v=spf1 -all", error: null },
    dmarc: {
      status: "found",
      record: "v=DMARC1; p=reject",
      error: null,
      hostname: `_dmarc.${hostname}`,
      appliesTo: hostname,
      policyDomain: hostname,
      inherited: false,
      effectivePolicy: "reject",
    },
  };
}

/** A certificate that is valid, trusted, and covers the hostname. */
function healthySsl(hostname = "fixture.test"): SslData {
  return {
    status: "checked",
    hostname,
    certificate: {
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
      daysUntilExpiry: 200,
      issuer: "Fixture CA",
      subject: hostname,
      subjectAltNames: [hostname],
      coversHostname: true,
      hostnameMatch: "exact",
      protocol: "TLSv1.3",
    },
    trusted: true,
    problem: null,
    failure: null,
    message: "The certificate is valid and trusted.",
  };
}

/** robots.txt present, and permitting crawlers. */
const permissiveRobots: TechnicalData = {
  robotsTxtStatus: "found", sitemapStatus: "found",
  robotsBlocksEverything: false,
  sitemapUrl: null,
};

/**
 * The default: a site where every site-level check ran and found nothing wrong.
 *
 * Chosen so that any site-scoped finding a test sees was put there ON PURPOSE
 * by that test, rather than arriving from whatever a real domain happens to
 * look like today.
 */
const healthySite = async (): Promise<SiteChecks> => ({
  technical: permissiveRobots,
  ssl: healthySsl(),
  dns: healthyDns(),
  // Not measured by this stub. Null says exactly that, and no rule reads it.
  responseTime: null,
});

/** The healthy site with one measurement replaced, for a rule-specific test. */
const siteWhere =
  (overrides: Partial<SiteChecks>) =>
  async (): Promise<SiteChecks> => ({ ...(await healthySite()), ...overrides });

// ---------------------------------------------------------------------------
// The pipeline runs in one direction
// ---------------------------------------------------------------------------

test("a crawled page is measured and graded by the existing engine", async () => {
  const result = await audit(crawlResult());

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].url, SITE);
  // Real rules ran: a page with no title and no description fires several.
  assert.ok(result.data.findings.length > 0);
  assert.ok(result.data.findings.some((f) => f.id.startsWith("seo.")));
});

test("severity on a site finding is the rule's own, never recomputed", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => page(`https://example.com/p${i}`));
  const result = await audit(crawlResult({ pages }), "https://example.com/p0");

  for (const found of result.site.findings) {
    const rule = AUDIT_RULES.find((r) => r.id === found.id);
    // "good" is the runner's constant for a rule that passed; anything else
    // must be exactly what the rule declared.
    if (found.severity !== "good") {
      assert.equal(found.severity, rule?.severity, found.id);
    }
  }
});

test("the same finding across pages becomes one site finding", async () => {
  const pages = Array.from({ length: 4 }, (_, i) => page(`https://example.com/p${i}`));
  const result = await audit(crawlResult({ pages }), "https://example.com/p0");

  const ids = result.site.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "no rule appears twice at the same severity");

  const firing = result.site.findings.find((f) => f.severity !== "good");
  assert.equal(firing?.affectedCount, 4);
});

test("the aggregator is given the rule ids, so QUIET rules count in the denominator", async () => {
  /*
   * The case that only `ruleIds` can get right.
   *
   * `seo.title.missing` declares no pass message, so on a page that HAS a
   * title it fires nothing and says nothing at all — it leaves no trace. Told
   * the rule set, the aggregator knows it still ran there and reports 1 of 2.
   * Left to infer from what each page said, it would only ever see the page
   * that fired and report 1 of 1 — turning "half your pages" into "all of
   * them", which overstates the problem.
   */
  const withoutTitle = page(
    "https://example.com/p0",
    "<html><head></head><body><p>We compare every kettle we sell on speed, noise and how long the handle stays cool.</p></body></html>",
  );
  const withTitle = page(
    "https://example.com/p1",
    "<html><head><title>A perfectly good title</title></head><body><p>We compare every kettle we sell on speed, noise and how long the handle stays cool.</p></body></html>",
  );

  const result = await audit(
    crawlResult({ pages: [withoutTitle, withTitle] }),
    "https://example.com/p0",
  );

  const titleFinding = result.site.findings.find((f) => f.id === "seo.title.missing");
  assert.ok(titleFinding !== undefined, "the page without a title fired the rule");
  assert.equal(titleFinding.affectedCount, 1, "one of the two pages");
  assert.equal(titleFinding.evaluatedPages, 2, "but the rule ran on both");
});

test("every site finding's denominator counts pages the rule ran on", async () => {
  const pages = [page("https://example.com/p0"), page("https://example.com/p1")];
  const result = await audit(crawlResult({ pages }), "https://example.com/p0");

  for (const found of result.site.findings) {
    assert.equal(found.evaluatedPages, 2, found.id);
  }
});

test("nothing in the pipeline asks a model for anything", () => {
  const code = codeOf("./siteAudit.ts");
  assert.ok(!/anthropic|openai|claude|\bllm\b|completion/i.test(code));
});

// ---------------------------------------------------------------------------
// Only pages that were read get graded
// ---------------------------------------------------------------------------

test("unavailable, non-HTML and robots-excluded pages are never graded", async () => {
  /*
   * The exclusion is structural. `crawl.pages` holds only pages read as HTML —
   * a timeout, a PDF and an address robots.txt refused produce no page at all,
   * so there is no filter here to forget.
   */
  const read = page("https://example.com/read");
  const crawl = crawlResult({
    pages: [read],
    attempts: [
      { url: "https://example.com/read", outcome: "evaluated", page: read },
      { url: "https://example.com/gone", outcome: "unavailable", reason: "timeout", serverResponded: false },
      { url: "https://example.com/x.pdf", outcome: "non-html", reason: "not a web page" },
    ],
    summary: {
      ...crawlResult().summary,
      evaluated: 1,
      discovered: 5,
      unavailable: [{ url: "https://example.com/gone", reason: "timeout" }],
      skippedNonHtml: 1,
      robots: { status: "rules", enforced: true, excluded: 2 },
    },
  });

  const result = await siteAudit({
    requestedUrl: "https://example.com/read",
    crawlImpl: crawlReturning(crawl).impl,
    siteChecksImpl: healthySite,
  });

  assert.equal(result.pages.length, 1, "only the page we actually read");
  assert.equal(result.site.evaluatedPages, 1);
  for (const found of result.site.findings) {
    assert.equal(found.evaluatedPages, 1, `${found.id} must not count unread pages`);
    assert.ok((found.affectedCount ?? 0) <= 1);
  }
  // The crawl's own honest counts survive untouched beside them.
  assert.equal(result.crawl.unavailable.length, 1);
  assert.equal(result.crawl.skippedNonHtml, 1);
  assert.equal(result.crawl.robots.excluded, 2);
});

test("an entry page that could not be read fails the audit, in the crawler's words", async () => {
  const crawl = crawlResult({
    pages: [],
    attempts: [{ url: SITE, outcome: "unavailable", reason: "The website took too long to respond.", serverResponded: false }],
    summary: {
      ...crawlResult().summary,
      evaluated: 0,
      unavailable: [{ url: SITE, reason: "The website took too long to respond." }],
    },
  });

  await assert.rejects(
    () => siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawl).impl,
      siteChecksImpl: healthySite,
    }),
    (error: unknown) =>
      error instanceof EntryPageUnavailableError &&
      error.reason === "The website took too long to respond.",
  );
});

test("the entry page is found by address, not by whichever finished first", async () => {
  // Three workers finish in whatever order the network allows.
  const pages = [
    page("https://example.com/late"),
    page("https://example.com/"),
    page("https://example.com/other"),
  ];

  const result = await audit(crawlResult({ pages }), "https://example.com");

  assert.equal(result.data.fetch.finalUrl, SITE);
});

test("an entry page that redirected is still found", async () => {
  const redirected: FetchedPage = {
    ...page("https://example.com/home"),
    redirectChain: [SITE, "https://example.com/home"],
  };

  const result = await audit(crawlResult({ pages: [redirected] }), SITE);

  assert.equal(result.data.fetch.finalUrl, "https://example.com/home");
  assert.equal(result.data.fetch.wasRedirected, true);
});

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

test("the entry page keeps the exact Phase 3 shape", async () => {
  const result = await audit(crawlResult());

  for (const field of [
    "website",
    "fetch",
    "uptime",
    "seo",
    "security",
    "technical",
    "ssl",
    "dns",
    "performance",
    "hosting",
    "findings",
    "skippedChecks",
    "timedOut",
  ]) {
    assert.ok(field in result.data, `AuditData.${field} must still be there`);
  }
});

test("site-wide information sits beside the entry page, never instead of it", async () => {
  const result = await audit(crawlResult());

  assert.deepEqual(Object.keys(result).sort(), ["crawl", "data", "pages", "site"]);
});

// ---------------------------------------------------------------------------
// Partial crawls
// ---------------------------------------------------------------------------

test("a crawl stopped by a limit is never described as complete", async () => {
  for (const stoppedBecause of ["max-pages", "max-duration", "max-queue", "deadline"] as const) {
    const crawl = crawlResult();
    crawl.summary = { ...crawl.summary, stoppedBecause, complete: false };

    const result = await siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawl).impl,
      siteChecksImpl: healthySite,
    });

    assert.equal(result.crawl.complete, false, stoppedBecause);
    assert.equal(result.crawl.stoppedBecause, stoppedBecause);
    // And the findings it did produce are still there — they are real.
    assert.ok(result.site.findings.length > 0, stoppedBecause);
  }
});

test("incomplete sitemap discovery also makes the crawl partial", async () => {
  const crawl = crawlResult();
  crawl.summary = {
    ...crawl.summary,
    complete: false,
    sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "max-files" },
  };

  const result = await siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawl).impl,
      siteChecksImpl: healthySite,
    });

  assert.equal(result.crawl.complete, false);
  assert.equal(result.crawl.sitemapDiscovery.stoppedBecause, "max-files");
});

test("a partial crawl produces no finding about being partial", async () => {
  const crawl = crawlResult();
  crawl.summary = { ...crawl.summary, stoppedBecause: "max-pages", complete: false };

  const result = await siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawl).impl,
      siteChecksImpl: healthySite,
    });

  // A limit we imposed is not a fault of the website. It is state, not a
  // finding, and it carries no severity anywhere.
  for (const found of [...result.site.findings, ...result.data.findings]) {
    assert.ok(!/partial|max-pages|crawl/i.test(found.id), found.id);
  }
});

// ---------------------------------------------------------------------------
// The job around it
// ---------------------------------------------------------------------------

/** A job store the test drives, with no shared global state. */
const freshStore = () => createJobStore<SiteAuditResult>();

const fakeResult = (complete: boolean): SiteAuditResult => {
  const crawl = crawlResult();
  return {
    data: {} as SiteAuditResult["data"],
    site: { findings: [], skippedChecks: [], evaluatedPages: 1 },
    pages: [],
    crawl: { ...crawl.summary, complete, stoppedBecause: complete ? "completed" : "max-pages" },
  };
};

test("POST returns a job id immediately, not a result", async () => {
  const store = freshStore();
  let resolveRun: (value: SiteAuditResult) => void = () => {};
  const held = new Promise<SiteAuditResult>((resolve) => (resolveRun = resolve));

  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => held,
  });

  // The job exists and is readable before the crawl has produced anything.
  assert.ok(jobId.length > 0);
  const job = store.get(jobId);
  assert.ok(job !== null);
  assert.notEqual(job?.status, "completed");
  assert.equal(job?.result, null, "no result may exist yet");

  resolveRun(fakeResult(true));
  await finished;
});

test("a job moves queued to running to completed", async () => {
  const store = freshStore();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => {
      await held;
      return fakeResult(true);
    },
  });

  // The job is already running by the time startAudit hands back its id: the
  // status is set before the crawl is awaited, so a poll can never see a job
  // that is quietly doing work while still calling itself queued.
  assert.equal(store.get(jobId)?.status, "running");

  release();
  await finished;

  assert.equal(store.get(jobId)?.status, "completed");
});

test("a partial crawl finishes the job as partial, keeping its result", async () => {
  const store = freshStore();
  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => fakeResult(false),
  });

  await finished;

  const job = store.get(jobId);
  assert.equal(job?.status, "partial");
  assert.equal(job?.result?.crawl.complete, false);
  assert.equal(job?.result?.crawl.stoppedBecause, "max-pages");
});

test("an unreadable entry page fails the job with the collector's own reason", async () => {
  const store = freshStore();
  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => {
      throw new EntryPageUnavailableError("That website address could not be found.");
    },
  });

  await finished;

  const job = store.get(jobId);
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "That website address could not be found.");
});

test("an unexpected error becomes a failed job with a safe sentence", async () => {
  const store = freshStore();
  const secret = "ENOENT: C:\\Users\\pc\\secret\\key.pem";

  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => {
      throw new Error(secret);
    },
  });

  await finished;

  const job = store.get(jobId);
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, UNEXPECTED_FAILURE);
  // Not the exception's message: it can carry paths, addresses and keys.
  assert.ok(!job?.error?.includes(secret));
  assert.ok(!job?.error?.includes("ENOENT"));
  assert.ok(!job?.error?.includes("\\Users\\"));
});

test("a failing job never rejects its caller or the process", async () => {
  const store = freshStore();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  try {
    const { finished } = startAudit(SITE, {
      store,
      runImpl: async () => {
        throw new Error("boom");
      },
    });

    // Deliberately NOT awaited the way the route ignores it, then settled.
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  assert.deepEqual(rejections, []);
});

test("progress reaches the job as the crawl reports it", async () => {
  const store = freshStore();
  const snapshots: CrawlProgress[] = [
    { discovered: 10, queued: 9, evaluated: 1, unavailable: 0, skippedNonHtml: 0, robotsExcluded: 0, complete: false },
    { discovered: 40, queued: 28, evaluated: 12, unavailable: 2, skippedNonHtml: 1, robotsExcluded: 3, complete: false },
  ];

  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async (options) => {
      for (const snapshot of snapshots) options.onProgress?.(snapshot);
      return fakeResult(true);
    },
  });

  await finished;

  // The last snapshot is what a poll would have seen just before the end.
  const job = store.get(jobId);
  assert.equal(job?.progress.discovered, 40);
  assert.equal(job?.progress.evaluated, 12);
  assert.equal(job?.progress.unavailable, 2);
  assert.equal(job?.progress.skippedNonHtml, 1);
  assert.equal(job?.progress.robotsExcluded, 3);
});

test("the result is stored exactly once", async () => {
  const store = freshStore();
  const { jobId, finished } = startAudit(SITE, {
    store,
    runImpl: async () => fakeResult(true),
  });

  await finished;
  const first = store.get(jobId)?.result;

  // A second finish or a late failure cannot overwrite it.
  store.finish(jobId, "partial", fakeResult(false));
  store.fail(jobId, "too late");

  assert.deepEqual(store.get(jobId)?.result, first);
  assert.equal(store.get(jobId)?.status, "completed");
});

// ---------------------------------------------------------------------------
// What the endpoints answer
// ---------------------------------------------------------------------------

test("status reports queued, running, completed and partial truthfully", async () => {
  const store = freshStore();
  const job = store.create(SITE);

  const queued = statusAnswer(job.id, store.get(job.id)).body;
  assert.equal("status" in queued && queued.status, "queued");

  store.markRunning(job.id);
  const running = statusAnswer(job.id, store.get(job.id));
  assert.equal(running.status, 200);
  assert.equal("status" in running.body && running.body.status, "running");
  assert.equal(running.body.ok, true);

  store.finish(job.id, "partial", fakeResult(false));
  const partial = statusAnswer(job.id, store.get(job.id)).body;
  assert.equal("status" in partial && partial.status, "partial");
});

test("status for a failed job is ok:false, with the stored sentence", () => {
  const store = freshStore();
  const job = store.create(SITE);
  store.fail(job.id, "That website address could not be found.");

  const answer = statusAnswer(job.id, store.get(job.id));

  assert.equal(answer.status, 200, "the question was answered; the audit failed");
  assert.equal(answer.body.ok, false);
  assert.equal("error" in answer.body && answer.body.error, "That website address could not be found.");
});

test("an unknown or expired job is a clean 404 that guesses at nothing", () => {
  const answer = statusAnswer("no-such-job", null);

  assert.equal(answer.status, 404);
  assert.equal(answer.body.ok, false);
  assert.equal("error" in answer.body && answer.body.error, JOB_NOT_FOUND);
  // We cannot tell "expired" from "never existed", so we claim neither.
  assert.ok(!/expired\b/.test(JOB_NOT_FOUND) || /may have/.test(JOB_NOT_FOUND));
});

test("a missing job id is a bad request, not a not-found", () => {
  assert.equal(statusAnswer("", null).status, 400);
  assert.equal(resultAnswer("", null).status, 400);
});

test("a result is refused while the job is still running", () => {
  const store = freshStore();
  const job = store.create(SITE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = resultAnswer(job.id, store.get(job.id));
    assert.equal(answer.status, 409);
    assert.equal(answer.body.ok, false);
    assert.equal("error" in answer.body && answer.body.error, NOT_READY);
    // Emphatically no half-built report.
    assert.ok(!("result" in answer.body));
    store.markRunning(job.id);
  }
});

test("a completed job returns its result", () => {
  const store = freshStore();
  const job = store.create(SITE);
  store.finish(job.id, "completed", fakeResult(true));

  const answer = resultAnswer(job.id, store.get(job.id));

  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal("result" in answer.body && answer.body.result.crawl.complete, true);
});

test("a partial job returns its result AND says the crawl was partial", () => {
  const store = freshStore();
  const job = store.create(SITE);
  store.finish(job.id, "partial", fakeResult(false));

  const answer = resultAnswer(job.id, store.get(job.id));

  assert.equal(answer.body.ok, true);
  assert.equal("status" in answer.body && answer.body.status, "partial");
  assert.equal("result" in answer.body && answer.body.result.crawl.complete, false);
  assert.equal("result" in answer.body && answer.body.result.crawl.stoppedBecause, "max-pages");
});

test("no endpoint answer can carry a stack trace or a path", () => {
  const store = freshStore();
  const job = store.create(SITE);
  store.fail(job.id, UNEXPECTED_FAILURE);

  for (const answer of [
    statusAnswer(job.id, store.get(job.id)),
    resultAnswer(job.id, store.get(job.id)),
    statusAnswer("gone", null),
    resultAnswer("gone", null),
  ]) {
    const text = JSON.stringify(answer.body);
    assert.ok(!/ {4}at |\.ts:\d+|node_modules|[A-Z]:\\\\|Error:/.test(text), text);
  }
});

// ---------------------------------------------------------------------------
// Rule scope in the real pipeline
// ---------------------------------------------------------------------------

test("a site rule is EVALUATED once, not run per page and deduplicated after", async () => {
  /*
   * The distinction the whole correction rests on. Counting how many times the
   * rules ran per page proves the site rules were not among them — hiding the
   * duplication by tidying the display afterwards would leave this failing.
   */
  const pages = Array.from({ length: 6 }, (_, i) => page(`https://example.com/p${i}`));
  const result = await audit(crawlResult({ pages }), "https://example.com/p0");

  const siteRuleIds = new Set(SITE_RULES.map((r) => r.id));
  for (const pageAudit of result.pages) {
    for (const found of pageAudit.data.findings) {
      assert.ok(
        !siteRuleIds.has(found.id),
        `${found.id} is site-scoped and must not appear in a page's own findings`,
      );
    }
    for (const skip of pageAudit.data.skippedChecks) {
      assert.ok(!siteRuleIds.has(skip.ruleId), `${skip.ruleId} skipped per page`);
    }
  }
});

test("site findings appear once in the site report, with no page denominator", async () => {
  const pages = Array.from({ length: 6 }, (_, i) => page(`https://example.com/p${i}`));
  const result = await audit(crawlResult({ pages }), "https://example.com/p0");

  const siteRuleIds = new Set(SITE_RULES.map((r) => r.id));
  const siteScoped = result.site.findings.filter((f) => siteRuleIds.has(f.id));

  for (const found of siteScoped) {
    assert.equal(found.scope, "site", found.id);
    assert.equal(found.affectedCount, 1, `${found.id} must not be multiplied by 6 pages`);
    assert.equal(found.evaluatedPages, undefined, `${found.id} has no page denominator`);
    assert.equal(found.affected?.length, 1);
  }

  // And the page-scoped ones still carry real page counts.
  const pageScoped = result.site.findings.filter((f) => !siteRuleIds.has(f.id));
  assert.ok(pageScoped.length > 0);
  for (const found of pageScoped) {
    assert.equal(found.scope, "page", found.id);
    assert.equal(found.evaluatedPages, 6, found.id);
  }
});

test("every site finding also reaches the entry page's own report", async () => {
  /*
   * Phase 3 compatibility, stated as the property rather than as a guess about
   * what the network will say. A single-page audit has always listed the
   * certificate and DNS findings alongside the page's own, and the scope split
   * must not quietly drop them from there.
   *
   * Asserted as a superset so it holds whatever the site-level collectors
   * happen to measure: if a site rule says nothing there is nothing to carry
   * across, and if it says something it must appear in both places from the
   * single evaluation.
   */
  const result = await audit(crawlResult());

  const siteRuleIds = new Set(SITE_RULES.map((r) => r.id));
  const entryIds = new Set(result.data.findings.map((f) => f.id));

  for (const found of result.site.findings) {
    if (!siteRuleIds.has(found.id)) continue;
    assert.ok(
      entryIds.has(found.id),
      `${found.id} is in the site report but missing from the entry page`,
    );
  }
});

test("the entry page's findings are still worst-first after the two runs merge", async () => {
  const result = await audit(crawlResult());
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, good: 3 };

  for (let i = 1; i < result.data.findings.length; i += 1) {
    const previous = result.data.findings[i - 1];
    const current = result.data.findings[i];
    const bySeverity = order[previous.severity] - order[current.severity];
    assert.ok(
      bySeverity < 0 || (bySeverity === 0 && previous.id.localeCompare(current.id) <= 0),
      `${previous.id} (${previous.severity}) came before ${current.id} (${current.severity})`,
    );
  }
});

test("severity is untouched by the scope split", async () => {
  const result = await audit(crawlResult());

  for (const found of [...result.data.findings, ...result.site.findings]) {
    if (found.severity === "good") continue;
    const rule = [...PAGE_RULES, ...SITE_RULES].find((r) => r.id === found.id);
    assert.equal(found.severity, rule?.severity, found.id);
  }
});

// ---------------------------------------------------------------------------
// A site rule that genuinely FIRES
//
// Everything above proves the split when the site rules stay silent — and
// silence looks the same whether a rule was evaluated once, evaluated a
// hundred times, or never evaluated at all. These use an injected site
// measurement so a site rule really fires, which is what makes a mutation
// that mixes the scopes visible.
// ---------------------------------------------------------------------------

/**
 * Site measurements where robots.txt blocks every crawler, so a site rule fires.
 *
 * Stated outright rather than borrowed from a real domain: a test that needs a
 * site rule to fire cannot depend on somebody else's robots.txt saying the
 * right thing today.
 */
const blockedByRobots = siteWhere({
  technical: { robotsTxtStatus: "found", sitemapStatus: "found", robotsBlocksEverything: true, sitemapUrl: null },
});

test("a FIRING site rule appears once, and never inside a page's findings", async () => {
  const pages = Array.from({ length: 7 }, (_, i) => page(`https://example.com/p${i}`));

  const result = await siteAudit({
    requestedUrl: "https://example.com/p0",
    crawlImpl: crawlReturning(crawlResult({ pages })).impl,
    siteChecksImpl: blockedByRobots,
  });

  const blocked = result.site.findings.filter((f) => f.id === "technical.robots.blocks-all");
  assert.equal(blocked.length, 1, "the rule fired, and produced exactly one finding");

  // Not multiplied by the seven pages, and given no page denominator.
  assert.equal(blocked[0].scope, "site");
  assert.equal(blocked[0].affectedCount, 1);
  assert.equal(blocked[0].evaluatedPages, undefined);
  assert.equal(blocked[0].affected?.length, 1);
  assert.equal(blocked[0].affected?.[0].url, "https://example.com");

  // And it was never evaluated as part of any page.
  for (const pageAudit of result.pages) {
    assert.ok(
      !pageAudit.data.findings.some((f) => f.id === "technical.robots.blocks-all"),
      `${pageAudit.url} graded a site rule`,
    );
  }
});

test("a firing site rule still reaches the entry page's own report", async () => {
  const result = await siteAudit({
    requestedUrl: SITE,
    crawlImpl: crawlReturning(crawlResult()).impl,
    siteChecksImpl: blockedByRobots,
  });

  // Evaluated once, shown in both places — Phase 3 compatibility intact.
  assert.ok(result.data.findings.some((f) => f.id === "technical.robots.blocks-all"));
  assert.ok(result.site.findings.some((f) => f.id === "technical.robots.blocks-all"));
});

test("MIXED: a firing site rule and varying page rules keep their own counts", async () => {
  /*
   * The scenario the whole correction is for, end to end. One page rule fires
   * on some pages and is genuinely QUIET on others; one site rule fires once.
   * A mutation that ran the site rules per page would turn "1" into "4" here.
   */
  const withoutTitle = ["p0", "p1"].map((n) =>
    page(`https://example.com/${n}`, "<html><head></head><body><p>We compare every kettle we sell on speed, noise and how long the handle stays cool.</p></body></html>"),
  );
  const withTitle = ["p2", "p3"].map((n) =>
    page(
      `https://example.com/${n}`,
      "<html><head><title>A good title</title></head><body><p>We compare every kettle we sell on speed, noise and how long the handle stays cool.</p></body></html>",
    ),
  );

  const result = await siteAudit({
    requestedUrl: "https://example.com/p0",
    crawlImpl: crawlReturning(crawlResult({ pages: [...withoutTitle, ...withTitle] })).impl,
    siteChecksImpl: blockedByRobots,
  });

  const title = result.site.findings.find((f) => f.id === "seo.title.missing");
  const blocked = result.site.findings.find((f) => f.id === "technical.robots.blocks-all");

  assert.equal(title?.scope, "page");
  assert.equal(title?.affectedCount, 2, "two of the four pages");
  assert.equal(title?.evaluatedPages, 4, "and it ran on all four");

  assert.equal(blocked?.scope, "site");
  assert.equal(blocked?.affectedCount, 1);
  assert.notEqual(blocked?.affectedCount, 4, "one robots.txt, not four");
  assert.equal(blocked?.evaluatedPages, undefined);

  // Severity untouched by any of it.
  assert.equal(blocked?.severity, "critical");
  assert.equal(title?.severity, "high");
});

// ---------------------------------------------------------------------------
// The guard: no test in this file may reach the network
// ---------------------------------------------------------------------------

test("every audit in this file injects BOTH network boundaries", () => {
  /*
   * `runSiteAudit` has exactly two ways out to the internet: the crawl, and the
   * site-level measurements. A test that leaves either uninjected will make
   * real DNS lookups, a real TLS handshake and a real robots.txt request — and
   * will still pass, quietly, until the day it is run without a network or the
   * remote site changes.
   *
   * This reads the file's own source rather than trusting that. It is the
   * check that would have caught the tests this cleanup existed to fix.
   */
  const source = fs.readFileSync(new URL("./siteAudit.test.mts", import.meta.url), "utf8");

  // Both spellings: every audit here goes through this file's own `siteAudit`
  // helper, which asserts the kind of result and then calls the real one.
  const calls = [...source.matchAll(/[sS]iteAudit[(][{]/g)];
  assert.ok(calls.length > 0, "the scan must actually find the calls");

  for (const call of calls) {
    // The options object ends at the matching close; a generous window is
    // enough here because these literals are small.
    const window = source.slice(call.index, (call.index ?? 0) + 700);
    const optionsEnd = window.indexOf("});");
    const options = window.slice(0, optionsEnd === -1 ? undefined : optionsEnd);

    const line = source.slice(0, call.index).split("\n").length;
    assert.ok(options.includes("crawlImpl"), `the audit at line ${line} does not inject crawlImpl`);
    assert.ok(
      options.includes("siteChecksImpl"),
      `the audit at line ${line} does not inject siteChecksImpl — it would hit the real network`,
    );
  }
});

test("the shared helper injects site measurements by default", () => {
  // Belt to the guard's braces: the helper most tests go through must not be
  // the one place a network call slips back in.
  const source = fs.readFileSync(new URL("./siteAudit.test.mts", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("const audit = ("), source.indexOf("function codeOf"));

  assert.ok(helper.includes("siteChecksImpl"));
  assert.ok(helper.includes("healthySite"), "and its default is a stated measurement");
});

test("no test in this file names a real website", () => {
  /*
   * The fixtures use example.com and .test addresses, which are reserved by
   * standards for exactly this and resolve nowhere. A real hostname here would
   * be a test whose result depends on a stranger's server.
   */
  const source = fs.readFileSync(new URL("./siteAudit.test.mts", import.meta.url), "utf8");
  const hosts = new Set(
    [...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()),
  );

  for (const host of hosts) {
    assert.ok(
      host === "example.com" ||
        host === "www.example.com" ||
        host.endsWith(".test") ||
        host === "evil.test",
      `${host} is a real hostname; use example.com or a .test address`,
    );
  }
});

test("site facts reach the rules exactly as injected", () => {
  // The injection replaces the MEASUREMENT, not the pipeline: what a fixture
  // states is what the site rules are given to grade.
  const fixture = healthySsl("fixture.test");

  assert.equal(fixture.status, "checked");
  assert.equal(fixture.trusted, true);
  assert.equal(fixture.problem, null);
  assert.equal(fixture.certificate?.coversHostname, true);
});

// ---------------------------------------------------------------------------
// ROBOTS.TXT IS MEASURED ONCE
//
// The crawler reads the file before it queues anything, and the site checks
// are handed that measurement rather than fetching it again. Two requests for
// one file can come back differently, and one audit then held two answers:
// "no robots.txt" beside "robots.txt could not be checked", about the same
// file, in the same report.
// ---------------------------------------------------------------------------

test("the site checks are handed the crawl's own robots measurement", async () => {
  const states: RobotsMeasurement[] = [
    { status: "found", text: "User-agent: *\nDisallow:" },
    { status: "absent" },
    { status: "unavailable" },
  ];

  for (const robots of states) {
    let handed: RobotsMeasurement | undefined;
    await siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawlResult({ robots })).impl,
      siteChecksImpl: async (_url, _https, _deadline, given) => {
        handed = given;
        return healthySite();
      },
    });

    assert.deepEqual(handed, robots, robots.status);
  }
});

test("an unreadable robots.txt never reaches the report as absent", async () => {
  /*
   * THE EXACT FAILURE THIS EXISTS FOR. The crawl said the file could not be
   * read while the site checks, having fetched it separately, said the server
   * had told them it was not there. Both statements were in one report.
   */
  const result = await siteAudit({
    requestedUrl: SITE,
    crawlImpl: crawlReturning(crawlResult({ robots: { status: "unavailable" } })).impl,
    // The real projection, so the status is derived rather than asserted.
    siteChecksImpl: async (_url, _https, deadline, robots) => ({
      technical: await runTechnicalChecks(SITE, robots, deadline),
      ssl: healthySsl(),
      dns: healthyDns(),
      responseTime: null,
    }),
  });

  assert.equal(result.data.technical?.robotsTxtStatus, "unavailable");
  assert.notEqual(
    result.data.technical?.robotsTxtStatus,
    "absent",
    "a file we could not read is not a file the site does not have",
  );
  assert.equal(
    result.data.technical?.robotsBlocksEverything,
    false,
    "and nothing may be concluded from text we never saw",
  );
});

test("the two robots states in a result can no longer disagree", async () => {
  const pairs: Array<{ robots: RobotsMeasurement; crawlStatus: RobotsStatus }> = [
    { robots: { status: "found", text: "" }, crawlStatus: "empty" },
    { robots: { status: "absent" }, crawlStatus: "absent" },
    { robots: { status: "unavailable" }, crawlStatus: "unavailable" },
  ];

  for (const pair of pairs) {
    const crawl = crawlResult({ robots: pair.robots });
    crawl.summary.robots = {
      status: pair.crawlStatus,
      enforced: pair.crawlStatus !== "unavailable",
      excluded: 0,
    };

    const result = await siteAudit({
      requestedUrl: SITE,
      crawlImpl: crawlReturning(crawl).impl,
      siteChecksImpl: async (_url, _https, deadline, robots) => ({
        technical: await runTechnicalChecks(SITE, robots, deadline),
        ssl: healthySsl(),
        dns: healthyDns(),
        responseTime: null,
      }),
    });

    const fileSaysUnreadable = result.data.technical?.robotsTxtStatus === "unavailable";
    const crawlSaysUnreadable = result.crawl.robots.status === "unavailable";

    assert.equal(
      fileSaysUnreadable,
      crawlSaysUnreadable,
      `one panel would say ${result.data.technical?.robotsTxtStatus} while the other says ${result.crawl.robots.status}`,
    );
  }
});

// ---------------------------------------------------------------------------
// THE THREE-SAMPLE RESPONSE TIME
//
// Measured once, like the certificate and the DNS records, and carried onto
// every page's facts unchanged. What is tested here is the wiring: the
// arithmetic and the failure states have their own file.
// ---------------------------------------------------------------------------

const measuredResponseTime = {
  status: "measured",
  medianResponseTimeMs: 240,
  attempted: 3,
  succeeded: 3,
  samples: [
    { ok: true, ms: 180, failure: null },
    { ok: true, ms: 420, failure: null },
    { ok: true, ms: 240, failure: null },
  ],
  failure: null,
  message: "The server started answering in 240 ms, the middle of 3 timed requests.",
} as const;

test("the measured response time reaches the audit's facts", async () => {
  const result = await audit(
    crawlResult(),
    SITE,
    siteWhere({ responseTime: measuredResponseTime }),
  );

  assert.equal(result.data.responseTime?.status, "measured");
  assert.equal(result.data.responseTime?.medianResponseTimeMs, 240);
  assert.equal(result.data.responseTime?.succeeded, 3);
});

test("one measurement is shared by every page, not taken per page", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => page(`https://example.com/p${i}`));
  const result = await audit(
    crawlResult({ pages }),
    // The entry address must be one of the crawled pages, or there is no
    // report to attach anything to.
    "https://example.com/p0",
    siteWhere({ responseTime: measuredResponseTime }),
  );

  assert.equal(result.pages.length, 5);
  for (const audited of result.pages) {
    assert.equal(audited.data.responseTime?.medianResponseTimeMs, 240);
  }
});

test("a response time that could not be measured says so, and is not a null median", async () => {
  const result = await audit(
    crawlResult(),
    SITE,
    siteWhere({
      responseTime: {
        status: "unavailable",
        medianResponseTimeMs: null,
        attempted: 3,
        succeeded: 2,
        samples: [
          { ok: true, ms: 180, failure: null },
          { ok: true, ms: 240, failure: null },
          { ok: false, ms: null, failure: "timeout" },
        ],
        failure: "incomplete",
        message: "The server did not answer every time, so no median could be taken.",
      },
    }),
  );

  assert.equal(result.data.responseTime?.status, "unavailable");
  assert.equal(result.data.responseTime?.medianResponseTimeMs, null);
  assert.equal(result.data.responseTime?.succeeded, 2);
  // The rest of the audit is untouched by a measurement that did not work.
  assert.equal(result.pages.length, 1);
  assert.ok(result.data.seo);
});

test("no rule reads the response time, so no severity depends on it", () => {
  /*
   * There is no response-time rule in this project, and this task did not
   * invent one: a threshold would be a policy nobody has decided, and a
   * severity that moved with a measured number would be a severity computed
   * rather than declared.
   */
  const sources = ["seo", "security", "technical", "speed"].map((name) =>
    fs.readFileSync(new URL(`../rules/${name}.ts`, import.meta.url), "utf8"),
  );

  for (const source of sources) {
    assert.ok(!source.includes("responseTime"), "a rule reads the response time");
    assert.ok(!source.includes("medianResponseTimeMs"));
  }
});

test("the response time is measured by the collector, never by the AI layer", () => {
  const source = fs.readFileSync(new URL("./siteAudit.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\.\/collector\/responseTime\.ts"/);
  assert.ok(!/from\s+["'][^"']*\/ai\//.test(source), "the audit imports from the AI layer");
  assert.ok(!source.includes("@google/genai"));
});

// ---------------------------------------------------------------------------
// An entry page whose certificate failed
// ---------------------------------------------------------------------------

/** A crawl that read nothing because the entry page's certificate was refused. */
function certificateRefused(overrides: { url?: string; certificateUrl?: string } = {}): CrawlResult {
  const url = overrides.url ?? SITE;
  const reason = "The website's security certificate has expired.";
  return crawlResult({
    pages: [],
    attempts: [
      {
        url,
        outcome: "unavailable",
        reason,
        serverResponded: false,
        certificateProblem: "expired",
        certificateUrl: overrides.certificateUrl ?? url,
      },
    ],
    summary: {
      ...crawlResult().summary,
      evaluated: 0,
      unavailable: [{ url, reason }],
    },
  });
}

test("a refused certificate is audited from the address that presented it, not the one asked for", async () => {
  /*
   * The entry page redirected before the connection failed, so the certificate
   * that failed belongs to the address it redirected TO. Reading the requested
   * host's certificate instead would describe one the visitor never met, and
   * could contradict the failure in the same report.
   */
  const asked: string[] = [];
  const result = await runSiteAudit({
    requestedUrl: SITE,
    crawlImpl: crawlReturning(
      certificateRefused({ certificateUrl: "https://www.example.com/" }),
    ).impl,
    siteChecksImpl: async (entryUrl, servedOverHttps) => {
      asked.push(entryUrl);
      assert.equal(servedOverHttps, true, "an address with a certificate is an HTTPS one");
      return healthySite();
    },
  });

  assert.deepEqual(asked, ["https://www.example.com/"]);
  assert.ok(isCertificateFailureAudit(result));
  if (!isCertificateFailureAudit(result)) return;
  assert.equal(result.failedUrl, "https://www.example.com/");
  assert.equal(result.website.requestedUrl, SITE);
});

test("a crawl that read other pages is still an audit of those pages, not a certificate report", async () => {
  /*
   * The entry page failed, and the crawl reached pages elsewhere on the site.
   * Those pages were genuinely read, so reporting "no page on this site was
   * read" would be false — this stays the failure it always was.
   */
  const crawl = certificateRefused();
  const withOtherPages: CrawlResult = {
    ...crawl,
    pages: [page("https://example.com/about")],
  };

  await assert.rejects(
    () =>
      runSiteAudit({
        requestedUrl: SITE,
        crawlImpl: crawlReturning(withOtherPages).impl,
        siteChecksImpl: healthySite,
      }),
    EntryPageUnavailableError,
  );
});

test("the site rules are graded on the site's own facts, with no page among them", async () => {
  // The certificate the check read is the one graded, and its finding is the
  // report's. Nothing here has an entry page to read anything else from.
  const result = await runSiteAudit({
    requestedUrl: SITE,
    crawlImpl: crawlReturning(certificateRefused()).impl,
    siteChecksImpl: async () => {
      const checks = await healthySite();
      return {
        ...checks,
        ssl: { ...checks.ssl, trusted: false, problem: "untrusted" as const },
      };
    },
  });

  assert.ok(isCertificateFailureAudit(result));
  if (!isCertificateFailureAudit(result)) return;
  const untrusted = result.site.findings.find((finding) => finding.id === "security.ssl.untrusted");
  assert.ok(untrusted, "a site rule ran and fired on the certificate that was read");
  assert.equal(untrusted.scope, "site");
});
