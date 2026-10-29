/**
 * The overall summary covers every area, keeps "not found", "could not be
 * determined", "not measured" and "not checked by this audit" apart, and says
 * nothing the audit did not measure.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSecurityChecks } from "../collector/securityChecks.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import type { AuditData, Finding, PerformanceData } from "../types.ts";
import {
  NOT_CHECKED_BY_THIS_AUDIT,
  buildOverallSummary,
  skybookHelp,
  type OverallSummary,
  type OverallSummaryInput,
} from "./overallSummary.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function performance(over: Partial<PerformanceData> = {}): PerformanceData {
  return {
    status: "not-requested",
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: null,
    field: { status: "absent", measuredUrl: null, scope: null, overall: null, lcp: null, inp: null, cls: null, fcp: null, ttfb: null, error: null },
    lab: { status: "error", measuredUrl: null, score: null, lcpMs: null, fcpMs: null, tbtMs: null, speedIndexMs: null, cls: null, error: null },
    notInspected: [],
    message: "Speed was not measured.",
    ...over,
  } as PerformanceData;
}

function checkedPerformance(strategy: "mobile" | "desktop", score: number, withField: boolean): PerformanceData {
  return performance({
    status: "checked",
    strategy,
    field: withField
      ? {
          status: "found", measuredUrl: "https://example.com/", scope: "page", overall: "AVERAGE",
          lcp: { percentileMs: 3100, category: "AVERAGE" },
          inp: { percentileMs: 180, category: "FAST" },
          cls: { percentile: 0.31, category: "SLOW" },
          fcp: null, ttfb: null, error: null,
        }
      : { status: "absent", measuredUrl: null, scope: null, overall: null, lcp: null, inp: null, cls: null, fcp: null, ttfb: null, error: null },
    lab: { status: "found", measuredUrl: "https://example.com/", score, lcpMs: 2400, fcpMs: 1200, tbtMs: 300, speedIndexMs: 2000, cls: 0.05, error: null },
  } as unknown as Partial<PerformanceData>);
}

function auditData(over: Partial<Record<keyof AuditData, unknown>> = {}): AuditData {
  return {
    website: { requestedUrl: "https://example.com", checkedAt: "2026-10-28T10:00:00.000Z" },
    fetch: {
      finalUrl: "https://example.com/", redirectChain: ["https://example.com/"], wasRedirected: false,
      servedOverHttps: true, httpsUnavailable: false, certificateProblem: null, contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 120 },
    responseTime: null,
    seo: {},
    technical: { robotsTxtStatus: "found", sitemapStatus: "absent", robotsBlocksEverything: false, sitemapUrl: null },
    performance: performance(),
    security: runSecurityChecks({ "content-type": "text/html" }, "<html><body><p>x</p></body></html>", true, []),
    ssl: {
      status: "checked", hostname: "example.com", trusted: true, problem: null, failure: null, message: "Checked.",
      certificate: {
        validFrom: "2026-09-26T00:00:00.000Z", validTo: "2026-12-25T00:00:00.000Z", daysUntilExpiry: 58,
        issuer: "Example CA", subject: "example.com", subjectAltNames: ["example.com", "*.example.com"],
        coversHostname: true, hostnameMatch: null, protocol: "TLSv1.3",
      },
    },
    dns: {
      hostname: "example.com", emailDomain: "example.com",
      a: { status: "found", records: ["93.184.216.34"], error: null },
      aaaa: { status: "absent", records: [], error: null },
      mx: { status: "found", records: [{ exchange: "mail.example.com", priority: 10 }], error: null },
      ns: { status: "found", records: ["ns1.example.com", "ns2.example.com"], error: null },
      txt: { status: "found", records: [], error: null },
      spf: { status: "absent", record: null, error: null },
      dmarc: { status: "found", record: "v=DMARC1; p=reject", error: null, hostname: "_dmarc.example.com", appliesTo: "example.com", policyDomain: "example.com", inherited: false, effectivePolicy: "reject" },
    },
    hosting: null,
    findings: [],
    skippedChecks: [],
    timedOut: false,
    ...over,
  } as unknown as AuditData;
}

const crawl = (over: Record<string, unknown> = {}): SiteCrawlSummary =>
  ({
    requestedUrl: "https://example.com",
    limits: { maxPages: 150, maxDurationMs: 300_000, maxQueueSize: 2_000, maxResponseBytes: 5_000_000, concurrency: 3, perRequestDelayMs: 200 },
    stoppedBecause: "completed", complete: true, discovered: 12, queuedAtStop: 0,
    evaluated: 12, unavailable: [], skippedNonHtml: 0,
    sources: { html: 12, sitemap: 0 },
    sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
    robots: { status: "found", enforced: true, excluded: 0 },
    ...over,
  }) as unknown as SiteCrawlSummary;

const finding = (id: string, severity: Finding["severity"], category: Finding["category"], over: Record<string, unknown> = {}): Finding =>
  ({
    id, title: `Title of ${id}`, category, severity,
    evidence: "Measured.", remediation: "Do the thing.", scope: "site", ...over,
  }) as unknown as Finding;

function input(over: Partial<OverallSummaryInput> = {}): OverallSummaryInput {
  return {
    auditedUrl: "https://example.com/",
    checkedAt: "28/10/2026, 10:00",
    data: auditData(),
    crawl: crawl(),
    findings: [],
    skippedChecks: [],
    ranRules: null,
    grade: "B",
    gradeLabel: "Good",
    desktop: null,
    ...over,
  };
}

const textOf = (summary: OverallSummary): string =>
  JSON.stringify(summary);
const areaText = (summary: OverallSummary, key: string): string =>
  summary.areas.find((area) => area.key === key)?.paragraphs.join(" ") ?? "";
const areaStatus = (summary: OverallSummary, key: string) =>
  summary.areas.find((area) => area.key === key)?.status;

// ---------------------------------------------------------------------------
// Coverage of every area
// ---------------------------------------------------------------------------

test("every audited area is present, in a fixed order, with a status", () => {
  const summary = buildOverallSummary(input());
  assert.deepEqual(
    summary.areas.map((area) => area.key),
    ["speed", "seo", "security", "certificate", "domain", "site"],
  );
  for (const area of summary.areas) {
    assert.ok(area.heading.length > 0 && area.statusLabel.length > 0 && area.paragraphs.length > 0, area.key);
  }
});

test("the overview names the site, the date, the existing grade and the scope", () => {
  const summary = buildOverallSummary(input());
  const overview = summary.overview.join(" ");
  assert.match(overview, /https:\/\/example\.com\//);
  assert.match(overview, /28\/10\/2026/);
  assert.match(overview, /grade of B \(Good\)/);
  assert.match(overview, /No problems were found/);
});

test("problem counts come from the findings, worded by severity", () => {
  const summary = buildOverallSummary(
    input({
      findings: [
        finding("security.ssl.expired", "critical", "security"),
        finding("seo.title.missing", "high", "seo", { scope: "page" }),
        finding("security.dns.spf", "medium", "security"),
        finding("security.dns.dmarc", "medium", "security"),
      ],
    }),
  );
  assert.match(summary.overview.join(" "), /found 4 issues that need attention: 1 critical, 1 high priority and 2 medium priority/);
});

test("with no grade the overview says so instead of inventing one", () => {
  const summary = buildOverallSummary(input({ grade: null, gradeLabel: null }));
  assert.match(summary.overview.join(" "), /not enough completed checks to give an overall grade/);
});

// ---------------------------------------------------------------------------
// Speed: mobile and desktop, separately and honestly
// ---------------------------------------------------------------------------

test("mobile and desktop are reported separately, with their own measured values", () => {
  const summary = buildOverallSummary(
    input({
      data: auditData({ performance: checkedPerformance("mobile", 42, true) }),
      desktop: checkedPerformance("desktop", 91, false),
    }),
  );
  const speed = areaText(summary, "speed");
  assert.match(speed, /Mobile, simulated test: the page scored 42 out of 100, which Google classes as poor/);
  assert.match(speed, /Desktop, simulated test: the page scored 91 out of 100, which Google classes as good/);
  assert.match(speed, /Mobile, real visitors: according to Google's records of real visits/);
  assert.match(speed, /Desktop, real visitors: Google does not have enough real-visitor data/);
  assert.match(speed, /This does not mean the page is slow/);
  assert.match(speed, /does not measure every visitor's experience/);
  assert.equal(areaStatus(summary, "speed"), "attention", "the worst reading decides");
});

test("a missing desktop result is 'not measured', never borrowed from mobile", () => {
  const summary = buildOverallSummary(input({ data: auditData({ performance: checkedPerformance("mobile", 95, false) }) }));
  const speed = areaText(summary, "speed");
  assert.match(speed, /Desktop: speed was not measured for this report/);
  assert.doesNotMatch(speed, /Desktop, simulated test/);
});

test("a weaker desktop reading sets the speed status, and the summary says desktop is not graded", () => {
  const graded = /only the mobile result is graded: the desktop result does not create audit findings or change the grade/;
  const mobileOnly = buildOverallSummary(input({ data: auditData({ performance: checkedPerformance("mobile", 95, false) }) }));
  const withDesktop = buildOverallSummary(
    input({
      data: auditData({ performance: checkedPerformance("mobile", 95, false) }),
      desktop: checkedPerformance("desktop", 30, false),
    }),
  );

  assert.doesNotMatch(areaText(mobileOnly, "speed"), graded);
  assert.match(areaText(withDesktop, "speed"), graded);

  assert.equal(areaStatus(mobileOnly, "speed"), "good");
  assert.equal(areaStatus(withDesktop, "speed"), "attention", "the worst reading decides");

  // The desktop result reaches the speed area only: grade, issue counts and priorities are untouched.
  assert.deepEqual(withDesktop.overview, mobileOnly.overview);
  assert.match(withDesktop.overview.join(" "), /grade of B \(Good\)/);
  assert.deepEqual(withDesktop.priorities, mobileOnly.priorities);
  assert.doesNotMatch(areaText(withDesktop, "speed"), /Speed issues found/);
});

test("speed that could not be measured is not a verdict on the site", () => {
  const noKey = buildOverallSummary(input({ data: auditData({ performance: performance({ status: "no-api-key" }) }) }));
  assert.match(areaText(noKey, "speed"), /not set up on our server\. This says nothing about the website itself/);
  assert.equal(areaStatus(noKey, "speed"), "not-measured");

  const failed = buildOverallSummary(input({ data: auditData({ performance: performance({ status: "error" }) }) }));
  assert.match(areaText(failed, "speed"), /did not complete, so speed could not be measured/);
  assert.equal(areaStatus(failed, "speed"), "not-measured");
});

test("a middling simulated score is 'room for improvement', not a problem", () => {
  const summary = buildOverallSummary(input({ data: auditData({ performance: checkedPerformance("mobile", 70, false) }) }));
  assert.match(areaText(summary, "speed"), /scored 70 out of 100, which Google classes as needs improvement/);
  assert.equal(areaStatus(summary, "speed"), "improve");
});

// ---------------------------------------------------------------------------
// Domain and email: found, not found, failed, not checked
// ---------------------------------------------------------------------------

test("domain records distinguish found, not found, a failed lookup and not checked", () => {
  const summary = buildOverallSummary(
    input({
      data: auditData({
        dns: {
          ...auditData().dns,
          mx: { status: "error", records: [], error: "The lookup timed out." },
          spf: { status: "absent", record: null, error: null },
        },
      }),
    }),
  );
  const domain = areaText(summary, "domain");
  assert.match(domain, /No SPF record was found/, "a record looked for and not found");
  assert.match(domain, /mail servers failed, so they could not be determined/, "a failed lookup");
  assert.match(domain, /DMARC policy was found with the setting "reject", which asks receiving email systems to refuse failing messages/);
  assert.match(domain, /DKIM email signing: Not checked by this audit/);
  assert.match(domain, /does not by itself mean that the domain's email is failing to arrive/);
  assert.equal(areaStatus(summary, "domain"), "incomplete", "a failed lookup without a finding is partly checked");
});

test("a failed SPF lookup is never described as a missing record", () => {
  const summary = buildOverallSummary(
    input({ data: auditData({ dns: { ...auditData().dns, spf: { status: "error", record: null, error: "SERVFAIL" } } }) }),
  );
  const domain = areaText(summary, "domain");
  assert.match(domain, /SPF lookup failed, so whether the domain publishes an SPF record could not be determined/);
  assert.doesNotMatch(domain, /No SPF record was found/);
});

test("a null mail-server record is read as 'does not receive email'", () => {
  const summary = buildOverallSummary(
    input({ data: auditData({ dns: { ...auditData().dns, mx: { status: "found", records: [{ exchange: ".", priority: 0 }], error: null } } }) }),
  );
  assert.match(areaText(summary, "domain"), /states that it does not receive email/);
});

// ---------------------------------------------------------------------------
// Certificate and security
// ---------------------------------------------------------------------------

test("the certificate is described from its measurements, with a caveat", () => {
  const summary = buildOverallSummary(input());
  const cert = areaText(summary, "certificate");
  assert.match(cert, /trusted by the system that checked it/);
  assert.match(cert, /covers the address/);
  assert.match(cert, /issued for: example\.com and \*\.example\.com/);
  assert.match(cert, /valid until 25 December 2026 \(58 days from the date of the check\)/);
  assert.match(cert, /used TLSv1\.3/);
  assert.match(cert, /does not by itself show that every other part of the site's security is in order/);
  assert.equal(areaStatus(summary, "certificate"), "good");
});

test("an unchecked certificate is never reported as a problem", () => {
  const notHttps = buildOverallSummary(
    input({ data: auditData({ ssl: { ...auditData().ssl, status: "not-applicable", certificate: null } }) }),
  );
  assert.match(areaText(notHttps, "certificate"), /No certificate was checked, because the site was not served over HTTPS/);
  assert.equal(areaStatus(notHttps, "certificate"), "not-measured");

  const unreachable = buildOverallSummary(
    input({ data: auditData({ ssl: { ...auditData().ssl, status: "unreachable", certificate: null, message: "The connection timed out." } }) }),
  );
  assert.match(areaText(unreachable, "certificate"), /could not be checked: The connection timed out\. This says nothing about the website itself/);
  assert.equal(areaStatus(unreachable, "certificate"), "incomplete");
});

test("missing protective headers are described as missing safeguards, not attacks", () => {
  const summary = buildOverallSummary(input());
  const security = areaText(summary, "security");
  assert.match(security, /does not send a Content-Security-Policy/);
  assert.match(security, /not evidence that the site has a weakness or has been attacked/);
});

// ---------------------------------------------------------------------------
// Strengths, priorities, limitations, help
// ---------------------------------------------------------------------------

test("strengths come only from rules that ran and did not fire", () => {
  const ran = ["seo.title.missing", "security.dns.spf", "security.headers.hsts"];
  const summary = buildOverallSummary(
    input({ ranRules: ran, findings: [finding("security.dns.spf", "medium", "security")] }),
  );
  assert.ok(summary.strengths.includes("Every page read has a title."));
  assert.ok(summary.strengths.some((line) => /HSTS/.test(line)));
  assert.ok(!summary.strengths.some((line) => /SPF/.test(line)), "a rule that fired is not a strength");

  const noLedger = buildOverallSummary(input({ ranRules: null }));
  assert.deepEqual(noLedger.strengths, [], "without a record of what ran, nothing is claimed to have passed");
});

test("priorities are the worst problems first, at most five, with who fixes them", () => {
  const findings = [
    finding("seo.lang.missing", "medium", "seo", { scope: "page" }),
    finding("security.ssl.expired", "critical", "security"),
    finding("seo.title.missing", "high", "seo", { scope: "page" }),
    finding("seo.h1.missing", "medium", "seo", { scope: "page" }),
    finding("seo.images.alt", "medium", "seo", { scope: "page" }),
    finding("security.dns.spf", "medium", "security"),
    finding("security.dns.dmarc", "medium", "security"),
  ];
  const summary = buildOverallSummary(input({ findings }));
  assert.equal(summary.priorities.length, 5);
  assert.equal(summary.priorities[0].severityLabel, "Critical");
  assert.equal(summary.priorities[1].severityLabel, "High priority");
  assert.equal(summary.priorities[0].whoFixes, "Hosting or server administrator");
  assert.match(summary.priorities[0].whyItMatters, /full-page warning/);
});

test("limitations include a partial crawl and every check that could not run", () => {
  const summary = buildOverallSummary(
    input({
      crawl: crawl({ complete: false, stoppedBecause: "max-pages", evaluated: 150, discovered: 400, queuedAtStop: 250 }),
      skippedChecks: [{ ruleId: "security.cookies.secure", reason: "This response set no cookies." }],
    }),
  );
  const limits = summary.limitations.join(" ");
  assert.match(limits, /Not every page of the site was read/);
  assert.match(limits, /Could not be checked — Cookies sent without the Secure flag: This response set no cookies\./);
  assert.match(limits, /Content that appears only after scripts run/);
  assert.equal(areaStatus(summary, "site"), "incomplete");
});

test("the not-checked list names what this audit does not examine", () => {
  const summary = buildOverallSummary(input());
  assert.deepEqual(summary.notChecked, NOT_CHECKED_BY_THIS_AUDIT);
  const text = summary.notChecked.join(" ");
  for (const item of ["DKIM", "Broken links", "Structured data", "noindex", "redirect", "Visual layout", "search rankings"]) {
    assert.ok(text.includes(item), item);
  }
});

test("help is chosen by what was found, always offers a follow-up, and promises nothing", () => {
  const help = skybookHelp([finding("security.dns.dmarc", "medium", "security"), finding("seo.title.missing", "high", "seo")]);
  const text = [help.intro, ...help.items, help.closing].join(" ");
  assert.match(text, /email records \(SPF and DMARC\)/);
  assert.match(text, /search-visibility and content improvements/);
  assert.doesNotMatch(text, /speed results/, "no speed help without a speed finding");
  assert.match(help.items[help.items.length - 1], /follow-up audit/);
  assert.doesNotMatch(text, /guarantee|will (improve|increase|fix)|\bphone\b|@|www\./i);

  const clean = skybookHelp([]);
  assert.equal(clean.items.length, 1, "only the follow-up when nothing was found");
  assert.match(clean.intro, /keep the website in good shape/);
});

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

test("every address in the summary is one the audit read", () => {
  const data = auditData({ performance: checkedPerformance("mobile", 42, true) });
  const summary = buildOverallSummary(input({ data, desktop: checkedPerformance("desktop", 88, false) }));
  const source = JSON.stringify({ data, auditedUrl: "https://example.com/" });
  const addresses = textOf(summary).match(/https?:\/\/[^\s"),]+/g) ?? [];
  for (const address of addresses) assert.ok(source.includes(address), `${address} came from the audit`);
});

test("the summary states no consequence as fact and promises no result", () => {
  const summary = buildOverallSummary(
    input({
      data: auditData({ performance: checkedPerformance("mobile", 30, true) }),
      findings: [
        finding("security.headers.csp", "medium", "security", { scope: "page" }),
        finding("security.dns.spf", "medium", "security"),
        finding("speed.lab.score", "medium", "speed", { scope: "page" }),
      ],
    }),
  );
  const text = textOf(summary);
  for (const phrase of [/\bguarantee/i, /has been (hacked|compromised|breached)/i, /\bpenali[sz]/i, /lost (rankings|traffic|sales)/i, /will (lose|rank|improve|increase)/i]) {
    assert.doesNotMatch(text, phrase);
  }
});
