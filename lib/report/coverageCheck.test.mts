/**
 * The shared coverage check, and every view that relies on it.
 *
 * Every invariant from the approved plan has its own labelled failure case, so
 * each stated requirement can be traced to a test. Each failure case breaks
 * exactly the invariants it names and holds the rest, so a pass proves the
 * check caught THAT failure rather than some other one.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageCheck, coverageInvariants, type CoverageInvariant } from "./coverageCheck.ts";
import {
  affectedView,
  affectedViewFor,
  crawlView,
  pagesReadFigure,
  stopReasonText,
} from "./siteFindingsView.ts";
import {
  addressesFoundLabel,
  configuredLimitsText,
  crawlCountTiles,
  crawlLimitFacts,
  expiryNote,
  robotsFacts,
} from "./measurementsView.ts";
import { SAFETY_LIMIT_STOP } from "./reportSections.ts";
import { runRealAudit, runRealCertificateFailure } from "../audit/pdf/realAudit.fixture.mts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import type { Finding, TechnicalData } from "../types.ts";

const ALL: readonly CoverageInvariant[] = ["I1", "I2", "I3", "I4", "I5", "I6"];

/** A crawl a real audit could produce: the starting address plus nine pages found by links, all read. */
function crawl(overrides: Partial<SiteCrawlSummary> = {}): SiteCrawlSummary {
  return {
    requestedUrl: "https://example.com/",
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
    discovered: 10,
    queuedAtStop: 0,
    evaluated: 10,
    unavailable: [],
    skippedNonHtml: 0,
    sources: { html: 9, sitemap: 0 },
    sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
    robots: { status: "rules", enforced: true, excluded: 0 },
    ...overrides,
  };
}

/** The same crawl, stopped at its page limit. */
const partial = (overrides: Partial<SiteCrawlSummary> = {}) =>
  crawl({ complete: false, stoppedBecause: "max-pages", ...overrides });

const failures = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://example.com/broken-${i + 1}`, reason: "timeout" }));

/** The invariants a crawl breaks, in order. */
const broken = (summary: SiteCrawlSummary) =>
  ALL.filter((name) => !coverageInvariants(summary)[name]);

// ---------------------------------------------------------------------------
// Counts that reconcile
// ---------------------------------------------------------------------------

const VALID: ReadonlyArray<[string, SiteCrawlSummary]> = [
  ["V-1 every address found was read", crawl()],
  ["V-2 some pages could not be read", crawl({ evaluated: 8, unavailable: failures(2) })],
  ["V-3 some addresses were not web pages", crawl({ evaluated: 8, skippedNonHtml: 2 })],
  [
    "V-4 the Adems mix: 8 = 6 + 1 + 1, starting address included",
    crawl({ discovered: 8, sources: { html: 7, sitemap: 0 }, evaluated: 6, unavailable: failures(1), skippedNonHtml: 1 }),
  ],
  [
    "V-5 partial, with addresses still queued",
    crawl({ complete: false, stoppedBecause: "max-pages", discovered: 20, sources: { html: 19, sitemap: 0 }, evaluated: 10, queuedAtStop: 10 }),
  ],
  [
    "V-6 queue overflow: found, never queued, counted in no outcome",
    crawl({ complete: false, stoppedBecause: "max-queue", discovered: 30, sources: { html: 29, sitemap: 0 }, evaluated: 10, queuedAtStop: 15 }),
  ],
  ["V-7 robots.txt exclusions sit outside the found total", crawl({ robots: { status: "rules", enforced: true, excluded: 5 } })],
  ["V-8 defensive: the starting address not counted (s = 0)", crawl({ discovered: 9, sources: { html: 9, sitemap: 0 }, evaluated: 9 })],
  ["V-9 an address offered by both sources is counted once", crawl({ sources: { html: 6, sitemap: 3 } })],
  ["V-10 a single page", crawl({ discovered: 1, sources: { html: 0, sitemap: 0 }, evaluated: 1 })],
  [
    "boundary: read + unreadable + non-pages exactly equals found",
    crawl({ evaluated: 7, unavailable: failures(2), skippedNonHtml: 1 }),
  ],
  [
    "boundary: partial with nothing left over (r = 0)",
    crawl({ complete: false, stoppedBecause: "completed", sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "max-files" } }),
  ],
];

for (const [name, summary] of VALID) {
  test(`reconciles: ${name}`, () => {
    assert.deepEqual(broken(summary), [], "no invariant is broken");
    const check = coverageCheck(summary);
    assert.equal(check.valid, true);
    assert.ok(check.valid && check.pagesRead === summary.evaluated);
  });
}

test("the starting address is reported exactly when the found total includes it", () => {
  const withStart = coverageCheck(crawl());
  const withoutStart = coverageCheck(crawl({ discovered: 9, sources: { html: 9, sitemap: 0 }, evaluated: 9 }));
  assert.ok(withStart.valid && withStart.includesStartingAddress);
  assert.ok(withoutStart.valid && !withoutStart.includesStartingAddress);
  assert.equal(addressesFoundLabel(withStart), "Addresses found (including the starting address)");
  assert.equal(addressesFoundLabel(withoutStart), "Addresses found");
});

// ---------------------------------------------------------------------------
// Counts that do not: one labelled case per stated invariant
// ---------------------------------------------------------------------------

const FAILING: ReadonlyArray<[string, SiteCrawlSummary, readonly CoverageInvariant[]]> = [
  ["F-I1a two addresses unexplained by any source (s = 2)", crawl({ sources: { html: 8, sitemap: 0 } }), ["I1"]],
  ["F-I1b sources add up to more than was found (s = -1)", crawl({ sources: { html: 11, sitemap: 0 } }), ["I1"]],
  // I2 and I3 state one condition two ways; each has its own case. Partial, so
  // the "complete means nothing unreached" pair is not also broken.
  ["F-I2 more outcomes than addresses found (e + u + n = found + 1)", partial({ evaluated: 11 }), ["I2", "I3"]],
  ["F-I3 a negative remainder (r = -3)", partial({ evaluated: 13 }), ["I2", "I3"]],
  // I4 and I5 likewise.
  ["F-I4 complete, yet two addresses unreached (r = 2)", crawl({ evaluated: 8 }), ["I4", "I5"]],
  ["F-I5 one address unreached, yet called complete (r = 1)", crawl({ evaluated: 9 }), ["I4", "I5"]],
  [
    "F-I6 the same unreadable address listed twice",
    crawl({ evaluated: 8, unavailable: [failures(1)[0], failures(1)[0]] }),
    ["I6"],
  ],
  ["F-multi several at once (I1 and I3)", partial({ sources: { html: 5, sitemap: 0 }, evaluated: 12 }), ["I1", "I2", "I3"]],
];

/**
 * The failing crawl as the views would meet it with every figure in play:
 * exclusions present, and stopped at its page limit unless the failure itself
 * is about being complete.
 */
function asFailed(summary: SiteCrawlSummary, expected: readonly CoverageInvariant[]): SiteCrawlSummary {
  const withExclusions = { ...summary, robots: { status: "rules" as const, enforced: true, excluded: 4 } };
  return expected.includes("I4") ? withExclusions : { ...withExclusions, complete: false, stoppedBecause: "max-pages" };
}

for (const [name, summary, expected] of FAILING) {
  test(`refuses: ${name}`, () => {
    assert.deepEqual(broken(summary), [...expected], "exactly the named invariants are broken");
    assert.deepEqual(coverageCheck(summary), { valid: false });
  });
}

test("L3 boundary, documented rather than detected: one address counted as read AND unreadable", () => {
  /*
   * The summary holds read pages as a count only. Here one address was
   * genuinely unreadable but was also counted as read, and the totals still fit
   * within what was found. The check cannot see this, and this test records
   * that limit so nobody mistakes it for detection.
   */
  const doubleCounted = crawl({
    complete: false,
    stoppedBecause: "max-pages",
    evaluated: 9, // truly 8
    unavailable: failures(1),
  });
  assert.equal(coverageCheck(doubleCounted).valid, true);
});

// ---------------------------------------------------------------------------
// The figures the dashboard shows
// ---------------------------------------------------------------------------

test("pages read is shown only from a reconciled check", () => {
  assert.equal(pagesReadFigure(coverageCheck(crawl())), 10);
  for (const [, summary] of FAILING) assert.equal(pagesReadFigure(coverageCheck(summary)), null);
  assert.equal(pagesReadFigure(null), null, "no crawl summary, no figure");
});

const pageFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "seo.meta-description.missing",
  title: "No meta description",
  category: "seo",
  severity: "medium",
  evidence: "The page has no meta description.",
  remediation: "Add a meta description.",
  scope: "page",
  affected: [
    { url: "https://example.com/a", evidence: "No meta description." },
    { url: "https://example.com/b", evidence: "No meta description." },
  ],
  affectedCount: 60,
  evaluatedPages: 128,
  ...overrides,
});

const siteFinding = (): Finding => ({
  id: "security.dns.spf",
  title: "No SPF record",
  category: "security",
  severity: "medium",
  evidence: "No SPF record was found.",
  remediation: "Publish an SPF record.",
  scope: "site",
  affected: [{ url: "https://example.com", evidence: "No SPF record was found." }],
  affectedCount: 1,
});

test("finding reach is unchanged when the counts reconcile", () => {
  const ok = coverageCheck(crawl());
  for (const finding of [pageFinding(), siteFinding(), pageFinding({ affectedCount: 2 })]) {
    assert.deepEqual(affectedViewFor(finding, ok), affectedView(finding));
  }
  assert.equal(affectedViewFor(pageFinding(), ok).reach, "60 of 128 evaluated pages");
  assert.equal(affectedViewFor(pageFinding(), ok).sample, "Showing 2 of 60");
});

test("finding reach loses its figures, but never its pages, when the counts fail or are missing", () => {
  const inputs = [...FAILING.map(([, summary]) => coverageCheck(summary)), null];
  for (const coverage of inputs) {
    const view = affectedViewFor(pageFinding(), coverage);
    assert.equal(view.reach, null);
    assert.equal(view.sample, null);
    assert.deepEqual(view.pages, pageFinding().affected, "every affected address is kept");
  }
});

test("the certificate-failure audit looks exactly as before on the dashboard", async () => {
  /*
   * That path passes no crawl summary at all. Its findings are site-level --
   * no page was read -- and a site finding never carried a figure, so hiding
   * figures for a missing summary changes nothing a reader can see.
   */
  const audit = await runRealCertificateFailure({
    site: {
      "https://example.com/": {
        html: "",
        unreadable: "The website's security certificate has expired.",
        certificateProblem: "expired",
      },
    },
    checks: { certificateExpired: true },
  });
  assert.ok(audit.site.findings.length > 0, "the audit has findings to show");
  for (const finding of audit.site.findings) {
    assert.deepEqual(affectedViewFor(finding, null), affectedView(finding), finding.id);
  }
});

// ---------------------------------------------------------------------------
// The four shared functions that check internally always agree with the check
// ---------------------------------------------------------------------------

const technical: TechnicalData = {
  robotsTxtStatus: "found",
  robotsBlocksEverything: false,
  sitemapStatus: "found",
  sitemapUrl: "https://example.com/sitemap.xml",
} as TechnicalData;

/** Whether each function showed its coverage figures for this crawl. */
function shownBy(summary: SiteCrawlSummary) {
  const view = crawlView(summary);
  const exclusionRow = robotsFacts(summary, technical).some((row) => row.label === "Pages the site asked us to skip");
  return {
    crawlViewHeadline: view.headline !== "",
    crawlViewFacts: view.facts.length > 0,
    tiles: crawlCountTiles(summary).length > 0,
    robotsExclusion: exclusionRow,
    stopReasonFigure: stopReasonText(summary) !== SAFETY_LIMIT_STOP,
  };
}

/** The same crawl, stopped at its page limit with exclusions, so every function has a figure to show. */
const atLimit = (summary: SiteCrawlSummary): SiteCrawlSummary => ({
  ...summary,
  complete: false,
  stoppedBecause: "max-pages",
  robots: { status: "rules", enforced: true, excluded: 4 },
});

test("all four shared functions follow the coverage check, on every case", () => {
  const cases = [
    ...VALID.map(([name, summary]) => [name, atLimit(summary)] as const),
    ...FAILING.map(([name, summary, expected]) => [name, asFailed(summary, expected)] as const),
  ];

  for (const [name, summary] of cases) {
    const valid = coverageCheck(summary).valid;
    const shown = shownBy(summary);
    assert.equal(shown.crawlViewHeadline, valid, `${name}: crawlView headline`);
    assert.equal(shown.crawlViewFacts, valid, `${name}: crawlView facts`);
    assert.equal(shown.tiles, valid, `${name}: crawlCountTiles`);
    assert.equal(shown.robotsExclusion, valid, `${name}: robotsFacts exclusion row`);
    if (summary.stoppedBecause === "max-pages") {
      assert.equal(shown.stopReasonFigure, valid, `${name}: stopReasonText`);
    }
  }
});

test("when the counts fail, nothing these views produce carries a coverage figure", () => {
  for (const [name, summary, expected] of FAILING) {
    const failed = asFailed(summary, expected);
    assert.equal(coverageCheck(failed).valid, false, name);
    const view = crawlView(failed);
    assert.equal(view.headline, "", name);
    assert.deepEqual(view.facts, [], name);
    // A partial crawl still says why it stopped, without a figure; a complete one has no reason line.
    assert.equal(view.reason, failed.complete ? null : SAFETY_LIMIT_STOP, name);
    assert.deepEqual(crawlCountTiles(failed), [], name);
    assert.doesNotMatch(stopReasonText(failed), /\d/, name);
  }
});

test("a limit stop keeps its own reason, and its figure, when the counts reconcile", () => {
  assert.equal(stopReasonText(atLimit(crawl({ evaluated: 8, unavailable: failures(2) }))), "Stopped at the 150-page safety limit.");
  // Stops that are not a configured limit keep their wording either way; it carries no figure.
  for (const stoppedBecause of ["deadline", "completed"] as const) {
    const failed = { ...crawl({ evaluated: 13 }), complete: false, stoppedBecause };
    assert.notEqual(stopReasonText(failed), SAFETY_LIMIT_STOP);
    assert.doesNotMatch(stopReasonText(failed), /\d/);
  }
});

test("figures unrelated to coverage survive a failed check (S4)", () => {
  const failed = atLimit(crawl({ evaluated: 13 }));
  assert.equal(coverageCheck(failed).valid, false);
  // Configured limits are settings, not measurements, and stay.
  assert.equal(configuredLimitsText(failed.limits), "Configured limits for this audit: up to 150 pages and 5 minutes.");
  assert.equal(crawlLimitFacts(failed.limits).find((row) => row.label === "Most pages read")?.value, "150");
  // A certificate's remaining days are not a coverage count.
  assert.equal(expiryNote(84), "84 days after the audit date");
  // robots.txt's own state is still described.
  assert.ok(robotsFacts(failed, technical).some((row) => row.label === "robots.txt"));
});

test("the configured duration always carries its unit", () => {
  assert.match(configuredLimitsText(crawl().limits), /up to 150 pages and 5 minutes\.$/);
  assert.match(configuredLimitsText({ ...crawl().limits, maxDurationMs: 90_000 }), /and 90 seconds\.$/);
  assert.match(configuredLimitsText({ ...crawl().limits, maxDurationMs: 60_000 }), /and 1 minute\.$/);
});

// ---------------------------------------------------------------------------
// The production collector's own summaries reconcile
// ---------------------------------------------------------------------------

test("a real crawl, with an unreadable page and a page limit, reconciles", async () => {
  const page = (title: string, links: string) =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><p>Widgets supplied, installed and maintained for businesses of every size.</p>${links}</body></html>`;
  const audit = await runRealAudit({
    site: {
      "https://example.com/": { html: page("Home", '<a href="/a">A</a> <a href="/b">B</a> <a href="/gone">Gone</a> <a href="/c">C</a>') },
      "https://example.com/a": { html: page("A", '<a href="/">Home</a>') },
      "https://example.com/b": { html: page("B", '<a href="/">Home</a>') },
      "https://example.com/c": { html: page("C", '<a href="/">Home</a>') },
      "https://example.com/gone": { html: "", unreadable: "The server returned an error." },
    },
    maxPages: 3,
  });

  assert.ok(audit.crawl.unavailable.length + audit.crawl.queuedAtStop > 0, "the crawl did not simply read everything");
  assert.deepEqual(broken(audit.crawl), [], "the collector's counts satisfy every invariant, I6 included");
  assert.equal(coverageCheck(audit.crawl).valid, true);
});
