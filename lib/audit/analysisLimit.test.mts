/**
 * Tests for the analysis limit: a page above 1.5 MB is not parsed.
 *
 * WHY. Parsing turns a page into a tree of objects many times its own size,
 * and one large page was enough to exhaust the production server's memory on
 * its own. The download limit (5 MB) is untouched; this is a second, lower
 * limit on what is parsed.
 *
 * WHAT IS PROVED:
 *
 *   - the boundary is exact: a page of exactly the limit is analysed, one byte
 *     more is not;
 *   - an oversized page is never parsed, its markup is let go, and its links
 *     are not followed;
 *   - it is never graded and never counted as clean: the audit comes out
 *     exactly as if that page could not be read at all, which is how the rest
 *     of the application already treats a page where nothing was measured;
 *   - the report names it, separately from pages that could not be read;
 *   - the diagnostic line written before each parse carries only the approved
 *     fields: the job's short id, the page's order, and a rounded size band.
 *
 * No network: every site here exists only in this file.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { runSiteAudit, EntryPageUnavailableError } from "./siteAudit.ts";
import { crawlSite, type CrawlOptions, type CrawlResult } from "../collector/crawlSite.ts";
import { MAX_ANALYSIS_BYTES, TOO_LARGE_TO_ANALYSE } from "../collector/analysisLimit.ts";
import { crawlView } from "../report/siteFindingsView.ts";
import { scoreAudit } from "../scoring/score.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import { sizeBand } from "../log/reliabilityLog.ts";
import { APPROVED_FIELDS, captureLog, linesFor } from "../log/captureLog.fixture.mts";
import {
  fetcherFor,
  siteChecksFor,
  siteFilesFor,
  withNetworkUnplugged,
  type FakeSite,
} from "./pdf/realAudit.fixture.mts";
import type { FetchedPage } from "../collector/fetchPage.ts";
import type { AuditResult, SiteAuditResult } from "../types.ts";

const ROOT = "https://example.com/";
const BIG = `${ROOT}big`;
const BEYOND = `${ROOT}only-linked-from-the-big-page`;
const JOB = "4c7e9a21-0000-4000-8000-000000000000";
const noPause = async () => {};

// ---------------------------------------------------------------------------
// Pages of an exact size
// ---------------------------------------------------------------------------

/**
 * A page of exactly \`bytes\` bytes of UTF-8, padded with plain text.
 *
 * Text rather than elements, so a page at the limit is cheap to parse in a
 * test: what is being tested is where the limit falls, not how hard parsing is.
 */
function pageOf(title: string, links: readonly string[], bytes: number, marker = ""): string {
  const head = `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${marker}`;
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  const tail = `</p></body></html>`;
  const open = `${anchors}<p>`;
  const fixed = Buffer.byteLength(head + open + tail, "utf8");
  assert.ok(bytes >= fixed, "the page cannot be that small");
  return head + open + "x".repeat(bytes - fixed) + tail;
}

const small = (title: string, links: readonly string[] = ["/"]) => pageOf(title, links, 2_000);

/** A site whose middle page is \`bigBytes\` long and is the only way to reach one further page. */
function siteWithBigPage(bigBytes: number): FakeSite {
  return {
    [ROOT]: { html: small("Home", ["/about", "/big", "/contact"]) },
    [`${ROOT}about`]: { html: small("About") },
    [`${ROOT}contact`]: { html: small("Contact") },
    [BIG]: { html: pageOf("Big", ["/", "/only-linked-from-the-big-page"], bigBytes, "MARKUP-OF-THE-BIG-PAGE") },
    [BEYOND]: { html: small("Beyond") },
  };
}

/** The same site with the big page replaced by one that could not be read. */
function siteWithUnreadablePage(): FakeSite {
  const site = { ...siteWithBigPage(10_000) };
  site[BIG] = { html: "", unreadable: TOO_LARGE_TO_ANALYSE };
  return site;
}

// ---------------------------------------------------------------------------
// Running an audit
// ---------------------------------------------------------------------------

interface Run {
  readonly audit: AuditResult;
  readonly crawl: CrawlResult;
  readonly asked: string[];
  /** Every page handed to the audit's measurer, which is where its checks parse it. */
  readonly measured: string[];
}

async function audit(site: FakeSite, extra: { crawl?: Partial<CrawlOptions>; jobId?: string; onMeasure?: (page: FetchedPage) => void } = {}): Promise<Run> {
  const asked: string[] = [];
  const measured: string[] = [];
  let crawl: CrawlResult | null = null;

  const crawlImpl: typeof crawlSite = async (options) => {
    const given = options.measurePage;
    crawl = await crawlSite({
      ...options,
      measurePage: (page) => {
        measured.push(page.finalUrl);
        extra.onMeasure?.(page);
        given?.(page);
      },
    });
    return crawl;
  };

  const result = await withNetworkUnplugged(() =>
    runSiteAudit({
      requestedUrl: ROOT,
      jobId: extra.jobId,
      crawlImpl,
      crawl: {
        fetchImpl: fetcherFor(site, asked),
        sitemapFetchImpl: siteFilesFor(),
        useSitemaps: false,
        sleepImpl: noPause,
        limits: { concurrency: 1 },
        ...extra.crawl,
      },
      siteChecksImpl: siteChecksFor({ spfMissing: true }),
    }),
  );

  assert.ok(crawl !== null);
  return { audit: result, crawl, asked, measured };
}

const siteAuditOf = (run: Run): SiteAuditResult => {
  assert.ok(!isCertificateFailureAudit(run.audit));
  return run.audit as SiteAuditResult;
};

const comparable = (result: AuditResult): unknown =>
  JSON.parse(JSON.stringify(result, (key, value) => (key === "checkedAt" ? "<when>" : value)));

// ---------------------------------------------------------------------------
// The limit, and where it falls
// ---------------------------------------------------------------------------

test("the analysis limit is 1.5 MB, and the download limit is untouched at 5 MB", async () => {
  assert.equal(MAX_ANALYSIS_BYTES, 1_500_000);
  const { DEFAULT_CRAWL_LIMITS } = await import("../collector/crawlFrontier.ts");
  assert.equal(DEFAULT_CRAWL_LIMITS.maxResponseBytes, 5_000_000);
  assert.ok(MAX_ANALYSIS_BYTES < DEFAULT_CRAWL_LIMITS.maxResponseBytes, "the analysis limit is the lower of the two");
});

test("a page of exactly the limit is analysed", async () => {
  const run = await audit(siteWithBigPage(MAX_ANALYSIS_BYTES));

  assert.ok(run.measured.includes(BIG), "it was measured");
  assert.ok(siteAuditOf(run).pages.some((page) => page.url === BIG), "and is one of the audited pages");
  assert.ok(!run.crawl.summary.unavailable.some((failure) => failure.url === BIG));
  assert.ok(run.asked.includes(BEYOND), "and its links were followed");
});

test("a page one byte over the limit is not analysed", async () => {
  const run = await audit(siteWithBigPage(MAX_ANALYSIS_BYTES + 1));

  assert.ok(!run.measured.includes(BIG), "it was never handed to the checks");
  assert.ok(!siteAuditOf(run).pages.some((page) => page.url === BIG), "and is not an audited page");
  assert.deepEqual(
    run.crawl.summary.unavailable.filter((failure) => failure.url === BIG),
    [{ url: BIG, reason: TOO_LARGE_TO_ANALYSE }],
    "it is recorded, with its own reason",
  );
});

test("the limit can be set for a crawl, and is measured in bytes of UTF-8", async () => {
  // Two-byte characters: 1,000 of them are 2,000 bytes, not 1,000.
  const site: FakeSite = { [ROOT]: { html: pageOf("Home", ["/wide"], 600) }, [`${ROOT}wide`]: { html: `<p>${"é".repeat(1_000)}</p>` } };

  const tight = await audit(site, { crawl: { maxAnalysisBytes: 1_500 } });
  const loose = await audit(site, { crawl: { maxAnalysisBytes: 3_000 } });

  assert.ok(!tight.measured.includes(`${ROOT}wide`), "1,000 characters is more than 1,500 bytes");
  assert.ok(loose.measured.includes(`${ROOT}wide`));
});

// ---------------------------------------------------------------------------
// An oversized page is not parsed, not kept and not followed
// ---------------------------------------------------------------------------

test("an oversized page's links are not followed", async () => {
  const run = await audit(siteWithBigPage(1_600_000));

  assert.ok(run.asked.includes(BIG), "it was downloaded");
  assert.ok(!run.asked.includes(BEYOND), "but nothing only it links to was ever requested");
  assert.ok(!run.crawl.summary.unavailable.some((failure) => failure.url === BEYOND));
});

test("an oversized page's markup is let go, and none of it reaches the result", async () => {
  const run = await audit(siteWithBigPage(1_600_000));

  for (const attempt of run.crawl.attempts) {
    if (attempt.outcome === "evaluated") assert.equal(attempt.page.html, "", attempt.url);
  }
  assert.ok(!run.crawl.pages.some((page) => page.finalUrl === BIG), "it is not among the pages read");
  assert.ok(!JSON.stringify(run.audit).includes("MARKUP-OF-THE-BIG-PAGE"));
});

test("a crawl on its own, with no measurer, applies the same limit", async () => {
  // Link discovery parses the page too, so the limit belongs to the crawl and
  // holds whoever is using it.
  const asked: string[] = [];
  const crawl = await withNetworkUnplugged(() =>
    crawlSite({
      requestedUrl: ROOT,
      fetchImpl: fetcherFor(siteWithBigPage(1_600_000), asked),
      sitemapFetchImpl: siteFilesFor(),
      useSitemaps: false,
      sleepImpl: noPause,
    }),
  );

  assert.ok(!crawl.pages.some((page) => page.finalUrl === BIG));
  assert.ok(!asked.includes(BEYOND));
  assert.deepEqual(crawl.summary.unavailable, [{ url: BIG, reason: TOO_LARGE_TO_ANALYSE }]);
});

// ---------------------------------------------------------------------------
// Never graded, never clean
// ---------------------------------------------------------------------------

test("the audit is exactly the audit of the same site with that page unreadable", async () => {
  /*
   * THE PROPERTY THAT MATTERS. Nothing was checked on the oversized page, so
   * the audit must say exactly what it says about a page where nothing could be
   * checked: not graded, not clean, counted among the pages not read. The two
   * runs differ only in the one thing that is different -- the reason given.
   */
  const oversized = await audit(siteWithBigPage(1_600_000));
  const unreadable = await audit(siteWithUnreadablePage());

  // In the unreadable run, BEYOND is also unreached: the page linking to it was never read.
  assert.ok(!unreadable.asked.includes(BEYOND));

  assert.deepEqual(comparable(oversized.audit), comparable(unreadable.audit), "the whole audit");
  assert.deepEqual(scoreAudit(oversized.audit), scoreAudit(unreadable.audit), "and the score");
});

test("the oversized page is counted as not read, and every other page keeps its findings", async () => {
  const oversized = siteAuditOf(await audit(siteWithBigPage(1_600_000)));

  assert.deepEqual(oversized.pages.map((page) => page.url).sort(), [ROOT, `${ROOT}about`, `${ROOT}contact`]);
  assert.equal(oversized.site.evaluatedPages, 3, "three pages graded, not four");
  assert.equal(oversized.crawl.evaluated, 3);
  assert.equal(oversized.crawl.unavailable.length, 1);
  for (const finding of oversized.site.findings) {
    assert.ok(!(finding.affected ?? []).some((entry) => entry.url === BIG), `${finding.id} names the oversized page`);
  }
  assert.ok(oversized.site.findings.length > 0, "the other pages' findings are still there");
});

test("an oversized entry page ends the audit with that reason, rather than a report of nothing", async () => {
  const site: FakeSite = { [ROOT]: { html: pageOf("Home", ["/about"], 1_600_000) }, [`${ROOT}about`]: { html: small("About") } };

  const outcome = await audit(site).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(outcome instanceof EntryPageUnavailableError);
  assert.equal(outcome.reason, TOO_LARGE_TO_ANALYSE);
});

// ---------------------------------------------------------------------------
// The report names it
// ---------------------------------------------------------------------------

test("the coverage facts name a page too large to analyse, apart from pages that could not be read", async () => {
  const site: FakeSite = {
    ...siteWithBigPage(1_600_000),
    [`${ROOT}contact`]: { html: "", unreadable: "The server answered with an error." },
  };

  const view = crawlView(siteAuditOf(await audit(site)).crawl);
  const facts = Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]));

  assert.equal(facts["page too large to analyse"], "1");
  assert.equal(facts["page that could not be read"], "1", "the unreadable page alone");
  assert.equal(facts["Pages read"], "2");
});

test("with nothing oversized, the coverage facts are as they were", async () => {
  const view = crawlView(siteAuditOf(await audit(siteWithBigPage(10_000))).crawl);

  assert.ok(!view.facts.some((fact) => fact.label.includes("too large")));
  assert.ok(!view.facts.some((fact) => fact.label.includes("could not be read")));
});

// ---------------------------------------------------------------------------
// The diagnostic line
// ---------------------------------------------------------------------------

test("one line is written before each page is parsed, and one for a page too large to parse", async () => {
  const captured = await captureLog(() => audit(siteWithBigPage(1_600_000), { jobId: JOB }));
  const lines = linesFor(captured, "page.parse");

  const parsing = lines.filter((line) => line.outcome === "parsing");
  const skipped = lines.filter((line) => line.outcome === "skipped");

  assert.equal(parsing.length, 3, "one for each page parsed");
  assert.equal(skipped.length, 1, "one for the page that was not");
  assert.equal(skipped[0].reason, "too-large");
  assert.equal(skipped[0].size, "1.5mb-2mb");
  for (const line of lines) {
    assert.equal(line.job, JOB.slice(0, 8));
    assert.equal(typeof line.order, "number");
    assert.equal(typeof line.size, "string");
  }
  assert.deepEqual(
    lines.map((line) => line.order),
    [1, 2, 3, 4],
    "each page has its place in the crawl",
  );
});

test("the line is written before the page is parsed, not after", async () => {
  // At the moment the checks receive a page, its line is already written. If
  // parsing it is what kills the server, the last line says how big it was.
  // The console is watched live, so what had been written can be read at the
  // very moment each page reaches the checks.
  const seenAtMeasure: number[] = [];
  const lines: string[] = [];
  const real = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await audit(siteWithBigPage(10_000), {
      jobId: JOB,
      onMeasure: () => seenAtMeasure.push(lines.filter((line) => line.includes('"op":"page.parse"')).length),
    });
  } finally {
    console.log = real;
  }

  // Five pages: with the "big" page small here, the page beyond it is reached too.
  assert.deepEqual(seenAtMeasure, [1, 2, 3, 4, 5], "page N's line was already written when page N was measured");
});

test("the line carries only approved fields, and nothing about the page or the site", async () => {
  const captured = await captureLog(() => audit(siteWithBigPage(1_600_000), { jobId: JOB }));

  assert.ok(captured.lines.length > 0);
  for (const line of captured.lines) {
    for (const name of Object.keys(line)) {
      assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is not an approved field`);
    }
  }
  for (const entry of captured.all) {
    for (const forbidden of ["example.com", "https://", "MARKUP-OF-THE-BIG-PAGE", "Home", "About", JOB]) {
      assert.ok(!entry.includes(forbidden), `"${forbidden}" reached the log: ${entry}`);
    }
  }
});

test("without a job id, the line is still written, and simply has no job", async () => {
  const captured = await captureLog(() => audit(siteWithBigPage(10_000)));
  const lines = linesFor(captured, "page.parse");

  assert.equal(lines.length, 5, "home, about, contact, the (small) big page, and the page beyond it");
  for (const line of lines) assert.ok(!("job" in line));
});

test("sizes are reported in bands, never exactly", () => {
  assert.equal(sizeBand(0), "under-100kb");
  assert.equal(sizeBand(100_000), "under-100kb");
  assert.equal(sizeBand(100_001), "100kb-500kb");
  assert.equal(sizeBand(999_999), "500kb-1mb");
  assert.equal(sizeBand(MAX_ANALYSIS_BYTES), "1mb-1.5mb", "a page of exactly the limit is in the band below it");
  assert.equal(sizeBand(MAX_ANALYSIS_BYTES + 1), "1.5mb-2mb", "and one byte over is in the band above");
  assert.equal(sizeBand(2_500_000), "2mb-3mb");
  assert.equal(sizeBand(5_000_000), "3mb-5mb");
  assert.equal(sizeBand(5_000_001), "over-5mb");
});
