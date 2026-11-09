/**
 * Tests for joining the speed check back onto the audit it belongs to.
 *
 * Two things are being protected here.
 *
 * THAT THE JOIN IS HONEST. The speed check asked Google about ONE address. It
 * read no page of the site, discovered nothing and evaluated nothing, so it
 * may not move a crawl count or borrow the crawl's denominator. "1 of 128
 * pages" about a measurement that never looked at the other 127 is exactly the
 * kind of false proportion this project exists to avoid.
 *
 * THAT NOTHING ELSE MOVES. Severity, evidence, remediation and every existing
 * finding arrive already decided and must come out the other side untouched.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { withSpeed } from "./withSpeed.ts";
import type {
  Finding,
  PerformanceData,
  SiteAuditResult,
  SkippedCheck,
  SpeedResult,
} from "../types";

const MEASURED = "https://example.com/";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function performanceData(overrides: Partial<PerformanceData> = {}): PerformanceData {
  return {
    status: "checked",
    strategy: "mobile",
    requestedUrl: MEASURED,
    failureReason: null,
    field: {
      status: "found",
      measuredUrl: MEASURED,
      scope: "origin",
      overall: "SLOW",
      lcp: { percentileMs: 4200, category: "SLOW" },
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: null,
    },
    lab: {
      status: "found",
      measuredUrl: MEASURED,
      score: 41,
      lcpMs: 4800,
      fcpMs: 2200,
      tbtMs: 600,
      speedIndexMs: 5100,
      cls: 0.02,
      error: null,
    },
    notInspected: ["Pages other than the one measured."],
    message: "Speed measured.",
    ...overrides,
  };
}

const speedFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "speed.field.lcp.slow",
  title: "Largest Contentful Paint is slow",
  category: "speed",
  severity: "high",
  evidence: "Real visitors saw the largest element at 4,200ms.",
  remediation: "Reduce the size of the largest element above the fold.",
  scope: "page",
  ...overrides,
});

const auditFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "seo.meta-description.missing",
  title: "No meta description",
  category: "seo",
  severity: "medium",
  evidence: "No meta description tag was found.",
  remediation: "Write one.",
  scope: "page",
  affected: [{ url: "https://example.com/a", evidence: "No meta description tag was found." }],
  affectedCount: 40,
  evaluatedPages: 128,
  ...overrides,
});

function auditResult(overrides: Partial<SiteAuditResult> = {}): SiteAuditResult {
  const data = {
    website: { requestedUrl: "https://example.com", checkedAt: "2026-09-07T10:00:00.000Z" },
    fetch: {
      finalUrl: MEASURED,
      redirectChain: [MEASURED],
      wasRedirected: false,
      servedOverHttps: true,
      httpsUnavailable: false,
      certificateProblem: null,
      contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 120 },
    // Only the fields these tests read are meaningful; the rest are structural.
    seo: {} as SiteAuditResult["data"]["seo"],
    technical: null,
    performance: {
      status: "pending",
      strategy: "mobile",
      requestedUrl: MEASURED,
      failureReason: null,
      field: {
        status: "absent",
        measuredUrl: null,
        scope: null,
        overall: null,
        lcp: null,
        inp: null,
        cls: null,
        fcp: null,
        ttfb: null,
        error: null,
      },
      lab: {
        status: "error",
        measuredUrl: null,
        score: null,
        lcpMs: null,
        fcpMs: null,
        tbtMs: null,
        speedIndexMs: null,
        cls: null,
        error: "not run",
      },
      notInspected: [],
      message: "The speed check is running.",
    } as PerformanceData,
    security: {} as SiteAuditResult["data"]["security"],
    ssl: {} as SiteAuditResult["data"]["ssl"],
    dns: {} as SiteAuditResult["data"]["dns"],
    hosting: null,
    findings: [auditFinding()],
    skippedChecks: [{ ruleId: "security.ssl.expired", reason: "No HTTPS." }] as SkippedCheck[],
    timedOut: false,
  } as SiteAuditResult["data"];

  return {
    data,
    site: {
      findings: [auditFinding()],
      skippedChecks: [{ ruleId: "security.ssl.expired", reason: "No HTTPS." }],
      evaluatedPages: 128,
    },
    pages: [{ url: MEASURED, data }],
    crawl: {
      requestedUrl: "https://example.com",
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
      discovered: 128,
      queuedAtStop: 0,
      evaluated: 128,
      unavailable: [],
      skippedNonHtml: 0,
      sources: { html: 128, sitemap: 0 },
      sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
      robots: { status: "absent", enforced: true, excluded: 0 },
    },
    ...overrides,
  };
}

const speedResult = (overrides: Partial<SpeedResult> = {}): SpeedResult => ({
  data: performanceData(),
  findings: [speedFinding()],
  skippedChecks: [{ ruleId: "speed.field.inp.slow", reason: "Google reported no INP for this address." }],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The measurement arrives
// ---------------------------------------------------------------------------

test("the real speed measurement replaces the placeholder", () => {
  const joined = withSpeed(auditResult(), speedResult());

  assert.equal(joined.data.performance.status, "checked");
  assert.equal(joined.data.performance.field.status, "found");
  assert.equal(joined.data.performance.lab.score, 41);
});

test("the speed findings arrive, keeping the severity the rule decided", () => {
  const joined = withSpeed(auditResult(), speedResult());

  const found = joined.site.findings.find((f) => f.id === "speed.field.lcp.slow");
  assert.ok(found, "the speed finding should be in the site findings");
  assert.equal(found.severity, "high", "copied from the rule, never recalculated");
  assert.equal(found.evidence, "Real visitors saw the largest element at 4,200ms.");
  assert.equal(found.remediation, "Reduce the size of the largest element above the fold.");
});

test("speed checks that could not run stay skipped, never findings", () => {
  const joined = withSpeed(auditResult(), speedResult());

  assert.ok(joined.site.skippedChecks.some((s) => s.ruleId === "speed.field.inp.slow"));
  assert.ok(!joined.site.findings.some((f) => f.id === "speed.field.inp.slow"));
});

// ---------------------------------------------------------------------------
// The join is honest about reach
// ---------------------------------------------------------------------------

test("a speed finding reaches one page, because one page was measured", () => {
  const joined = withSpeed(auditResult(), speedResult());
  const found = joined.site.findings.find((f) => f.id === "speed.field.lcp.slow");

  assert.equal(found?.affectedCount, 1);
  assert.equal(found?.evaluatedPages, 1, "the rule ran once, on one address");
  assert.deepEqual(
    found?.affected?.map((a) => a.url),
    [MEASURED],
  );
});

test("a speed finding never borrows the crawl's denominator", () => {
  /*
   * THE FALSE PROPORTION THIS GUARDS AGAINST. The crawl evaluated 128 pages.
   * The speed check looked at one. Reporting "1 of 128" would describe 127
   * pages nobody measured.
   */
  const joined = withSpeed(auditResult(), speedResult());
  const found = joined.site.findings.find((f) => f.id === "speed.field.lcp.slow");

  assert.notEqual(found?.evaluatedPages, 128);
});

test("a finding with no rule behind it gets no reach invented for it", () => {
  /*
   * WHY SCOPE IS READ FROM THE RULE RATHER THAN ASSUMED.
   *
   * Every speed rule today declares itself page-scoped, so hardcoding that
   * would pass every other test in this file. It would also mean a rule that
   * was renamed, or one that ever declares itself site-scoped, quietly
   * acquiring a one-of-one page denominator it never earned.
   *
   * An id with nothing behind it is reported as measured, with no claim about
   * how far it reaches. That is what the contract calls "unstated".
   */
  const stranger = speedResult({
    findings: [speedFinding({ id: "speed.no.such.rule" })],
  });

  const joined = withSpeed(auditResult(), stranger);
  const found = joined.site.findings.find((f) => f.id === "speed.no.such.rule");

  assert.ok(found, "the finding is still carried; it was graded by something");
  assert.equal(found.scope, undefined, "nothing is claimed about its scope");
  assert.equal(found.affectedCount, undefined, "and no count is invented");
  assert.equal(found.evaluatedPages, undefined);
  assert.equal(found.affected, undefined);
});

test("the crawl's own denominator is untouched", () => {
  const joined = withSpeed(auditResult(), speedResult());

  assert.equal(joined.site.evaluatedPages, 128, "the speed check read no page of the site");
});

test("no crawl count moves", () => {
  const before = auditResult();
  const joined = withSpeed(before, speedResult());

  assert.deepEqual(joined.crawl, before.crawl, "the speed check visited nothing");
  assert.equal(joined.pages.length, before.pages.length);
});

// ---------------------------------------------------------------------------
// Nothing already decided changes
// ---------------------------------------------------------------------------

test("every existing finding survives exactly as it was", () => {
  const before = auditResult();
  const joined = withSpeed(before, speedResult());

  const original = joined.site.findings.find((f) => f.id === "seo.meta-description.missing");
  assert.deepEqual(original, before.site.findings[0], "not touched, not re-counted, not re-graded");
});

test("findings come out worst first, like every other list in the report", () => {
  const joined = withSpeed(auditResult(), speedResult());

  assert.deepEqual(
    joined.site.findings.map((f) => f.severity),
    ["high", "medium"],
  );
});

test("the audit handed in is never modified", () => {
  const before = auditResult();
  const snapshot = JSON.stringify(before);

  withSpeed(before, speedResult());

  assert.equal(JSON.stringify(before), snapshot, "the stored job keeps what the crawl produced");
});

test("joining twice gives the same answer", () => {
  const audit = auditResult();
  const speed = speedResult();

  assert.deepEqual(withSpeed(audit, speed), withSpeed(audit, speed));
});

// ---------------------------------------------------------------------------
// No speed check
// ---------------------------------------------------------------------------

test("an audit with no speed check comes back exactly as it went in", () => {
  const before = auditResult();

  assert.equal(withSpeed(before, null), before, "not requested is a complete audit");
});

test("a speed check that failed still replaces the placeholder with its own words", () => {
  const failed = speedResult({
    data: performanceData({
      status: "error",
      failureReason: "timeout",
      message: "Google did not answer in time.",
    }),
    findings: [],
    skippedChecks: [{ ruleId: "speed.field.lcp.slow", reason: "Speed was not measured." }],
  });

  const joined = withSpeed(auditResult(), failed);

  assert.equal(joined.data.performance.status, "error");
  assert.equal(joined.site.findings.length, 1, "no speed finding was invented from a failure");
  assert.ok(joined.site.skippedChecks.some((s) => s.ruleId === "speed.field.lcp.slow"));
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test("this layer measures nothing and grades nothing", () => {
  const source = fs
    .readFileSync(new URL("./withSpeed.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/severity\s*[:=]\s*["']/.test(source), "no severity is ever written here");
  assert.ok(!/fetch\(|await\s+\w+\(/.test(source), "nothing is measured here");
  assert.ok(!/\bgemini\b|@google\/genai|anthropic|openai/i.test(source), "no provider");
});

// ---------------------------------------------------------------------------
// Security: a speed finding never carries the measured address's credentials
//
// `requestedUrl` keeps a username and password if one was typed. A speed
// finding's affected address is printed (the PDF's speed card names it twice),
// so it is stripped with the shared `withoutCredentials`; every other part of
// the address is kept, and the measurement itself is not touched.
// ---------------------------------------------------------------------------

/** The affected addresses of the joined speed finding, for a measurement of `requestedUrl`. */
const affectedFor = (requestedUrl: string) =>
  withSpeed(auditResult(), speedResult({ data: performanceData({ requestedUrl }) }))
    .site.findings.find((f) => f.id === "speed.field.lcp.slow")
    ?.affected?.map((a) => a.url);

test("security: a username and password never reach a speed finding's address; everything else is kept", () => {
  assert.deepEqual(
    affectedFor("https://username:password@example.com/path?ref=mail#section"),
    ["https://example.com/path?ref=mail#section"],
    "scheme, host, path, query and fragment kept",
  );
  // A port is kept too.
  assert.deepEqual(affectedFor("https://username:password@example.com:8443/a?b=1&c=2"), ["https://example.com:8443/a?b=1&c=2"]);
});

test("security: an address with no credentials is passed through exactly as it was", () => {
  for (const url of ["https://example.com/", "https://example.com", "https://example.com/shop?item=7&ref=mail", "http://example.com:8080/x#y"]) {
    assert.deepEqual(affectedFor(url), [url], url);
  }
});

test("security: a username alone, or a password alone, is removed as well", () => {
  const userOnly = affectedFor("https://username@example.com/path?ref=mail");
  assert.deepEqual(userOnly, ["https://example.com/path?ref=mail"]);
  assert.ok(!JSON.stringify(userOnly).includes("username"));

  // The WHATWG URL parser accepts an empty username with a password.
  assert.equal(new URL("https://:password@example.com/").password, "password", "the parser supports a password-only address");
  const passwordOnly = affectedFor("https://:password@example.com/path?ref=mail");
  assert.deepEqual(passwordOnly, ["https://example.com/path?ref=mail"]);
  assert.ok(!JSON.stringify(passwordOnly).includes("password"));
});

test("security: the measurement keeps the address it was made for; only the finding's address is stripped", () => {
  const requested = "https://username:password@example.com/path?ref=mail";
  const joined = withSpeed(auditResult(), speedResult({ data: performanceData({ requestedUrl: requested }) }));
  assert.equal(joined.data.performance.requestedUrl, requested, "the measurement record is not rewritten");
  for (const finding of [...joined.site.findings, ...joined.data.findings].filter((f) => f.category === "speed")) {
    assert.ok(!JSON.stringify(finding).includes("password") && !JSON.stringify(finding).includes("username"), finding.id);
  }
  // Findings that are not speed findings are untouched.
  assert.deepEqual(
    joined.site.findings.filter((f) => f.category !== "speed"),
    auditResult().site.findings.filter((f) => f.category !== "speed"),
  );
});

test("security: the PDF's speed card shows the address without credentials, query kept", async () => {
  const { buildPdfDocument } = await import("./pdfDocument.ts");
  const { createJobStore } = await import("../jobs/jobStore.ts");
  const { documentHtml } = await import("./pdf/shell.ts");
  const { escapeHtml } = await import("./pdf/escape.ts");
  const { runRealAudit } = await import("./pdf/realAudit.fixture.mts");

  // A complete audit through the production crawler and rules (the minimal fixture above is not a full PDF input).
  const audit = await runRealAudit({
    site: { "https://example.com/": { html: `<!doctype html><html lang="en"><head><title>Example</title></head><body><h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p></body></html>` } },
  });
  const store = createJobStore<SiteAuditResult, SpeedResult, never, PerformanceData>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "completed", audit);
  store.attach(job.id, speedResult({ data: performanceData({ requestedUrl: "https://username:password@example.com/path?ref=mail" }) }));
  const outcome = buildPdfDocument(job.id, store);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  assert.equal(outcome.document.speedFindings.length, 1, "the speed card is printed");
  const html = documentHtml(outcome.document);
  const clean = "https://example.com/path?ref=mail";
  assert.ok(html.includes(`<p class="finding-meta">${escapeHtml(`Measured on ${clean} (mobile).`)}</p>`), "the scope line names the clean address");
  assert.ok(html.includes(`<li>${escapeHtml(clean)}</li>`), "the address list names the clean address, query kept");
  assert.ok(!html.includes("username"), "the username is printed nowhere");
  assert.ok(!html.includes("password"), "the password is printed nowhere");
});
