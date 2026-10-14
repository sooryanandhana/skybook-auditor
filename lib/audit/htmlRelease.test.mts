/**
 * Tests for letting a page's markup go as soon as it has been measured.
 *
 * WHY THIS EXISTS. A crawl used to keep the full HTML of every page it had read
 * until the whole crawl ended, because the checks that read it ran afterwards.
 * A production server ran out of memory in the middle of an audit doing that.
 * Each page is now measured as it arrives and its markup released.
 *
 * TWO THINGS ARE PROVED, and the second matters as much as the first:
 *
 *   - the markup really is let go, during the crawl and not only at its end;
 *   - the audit that comes out is THE SAME AUDIT. Every finding, severity,
 *     count and score is compared against the audit produced the old way --
 *     the whole crawl first, every page measured afterwards -- which this file
 *     can still run, because a crawl that does not measure as it goes is
 *     measured afterwards exactly as before.
 *
 * No network: every site below exists only in this file.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { runSiteAudit } from "./siteAudit.ts";
import { crawlSite, type CrawlOptions, type CrawlResult } from "../collector/crawlSite.ts";
import { scoreAudit } from "../scoring/score.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import {
  fetcherFor,
  siteChecksFor,
  siteFilesFor,
  withNetworkUnplugged,
  type FakeSite,
  type FakeSiteChecks,
} from "./pdf/realAudit.fixture.mts";
import type { FetchedPage } from "../collector/fetchPage.ts";
import type { AuditResult } from "../types.ts";

const ROOT = "https://example.com/";
const noPause = async () => {};

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** A page with a recognisable body, and whichever faults are asked for. */
function pageHtml(title: string, links: readonly string[], options: { description?: boolean; viewport?: boolean; mixed?: boolean; filler?: number } = {}) {
  const head =
    `<title>${title}</title>` +
    (options.description === false ? "" : `<meta name="description" content="About ${title}, at some length for a reader.">`) +
    (options.viewport === false ? "" : `<meta name="viewport" content="width=device-width, initial-scale=1">`);
  const body =
    `<h1>${title}</h1><p>MARKUP-OF-${title.toUpperCase().replace(/\W/g, "-")} We have sold widgets since 1994.</p>` +
    links.map((href) => `<a href="${href}">${href}</a>`).join("") +
    (options.mixed === true ? `<img src="http://example.com/insecure.png" alt="">` : `<img src="/ok.png">`) +
    "<p>filler</p>".repeat(options.filler ?? 0);
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

/** Six pages with a spread of faults, one address that cannot be read, and cookies on one. */
const MIXED: FakeSite = {
  [ROOT]: { html: pageHtml("Home", ["/about", "/services", "/contact", "/blog", "/broken", "/legal"]) },
  [`${ROOT}about`]: { html: pageHtml("About", ["/"], { description: false }) },
  [`${ROOT}services`]: { html: pageHtml("Services", ["/", "/about"], { viewport: false, filler: 400 }) },
  [`${ROOT}contact`]: {
    html: pageHtml("Contact", ["/"], { mixed: true }),
    setCookieHeaders: ["session=abc; Path=/"],
  },
  [`${ROOT}blog`]: { html: pageHtml("Blog", ["/", "/services"], { description: false, viewport: false }) },
  [`${ROOT}legal`]: { html: pageHtml("Legal", ["/"]), headers: { "strict-transport-security": "max-age=31536000" } },
  [`${ROOT}broken`]: { html: "", unreadable: "The server answered with an error." },
};

/** Twelve pages, for a crawl that is stopped at a page limit. */
const LARGER: FakeSite = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => {
    const url = index === 0 ? ROOT : `${ROOT}p${index}`;
    const links = Array.from({ length: 12 }, (_unused, other) => (other === 0 ? "/" : `/p${other}`));
    return [url, { html: pageHtml(`Page ${index}`, links, { description: index % 2 === 0, viewport: index % 3 !== 0 }) }];
  }),
);

// ---------------------------------------------------------------------------
// Running an audit, the new way and the old
// ---------------------------------------------------------------------------

interface Run {
  readonly audit: AuditResult;
  /** What the crawl handed back, exactly as the audit received it. */
  readonly crawl: CrawlResult;
}

/**
 * Runs the production audit over a fake site.
 *
 * \`mode\` chooses how the crawl treats markup:
 *
 *   "release"  the production path. Each page is measured as it arrives and its
 *              markup let go.
 *   "retain"   the path before this change. The crawl is not given a measurer,
 *              so it keeps every page's markup, and the audit measures them all
 *              afterwards. Nothing about the audit is stubbed either way.
 */
async function audit(
  site: FakeSite,
  mode: "release" | "retain",
  options: { checks?: FakeSiteChecks; maxPages?: number; spy?: (page: FetchedPage) => void; crawl?: Partial<CrawlOptions> } = {},
): Promise<Run> {
  let crawl: CrawlResult | null = null;

  const crawlImpl: typeof crawlSite = async (crawlOptions) => {
    const given = crawlOptions.measurePage;
    crawl = await crawlSite({
      ...crawlOptions,
      measurePage:
        mode === "retain" || given === undefined
          ? undefined
          : (page) => {
              options.spy?.(page);
              given(page);
            },
    });
    return crawl;
  };

  const result = await withNetworkUnplugged(() =>
    runSiteAudit({
      requestedUrl: ROOT,
      crawlImpl,
      crawl: {
        fetchImpl: fetcherFor(site),
        sitemapFetchImpl: siteFilesFor(),
        useSitemaps: false,
        sleepImpl: noPause,
        ...(options.maxPages === undefined ? {} : { limits: { maxPages: options.maxPages } }),
        ...options.crawl,
      },
      siteChecksImpl: siteChecksFor(options.checks),
    }),
  );

  assert.ok(crawl !== null, "the crawl ran");
  return { audit: result, crawl };
}

/** An audit with the one thing that differs between any two runs -- the clock -- taken out. */
function comparable(result: AuditResult): unknown {
  return JSON.parse(JSON.stringify(result, (key, value) => (key === "checkedAt" ? "<when>" : value)));
}

const pagesOf = (run: Run) => run.crawl.pages;

// ---------------------------------------------------------------------------
// The markup is let go
// ---------------------------------------------------------------------------

test("after an audit, no page the crawl read still holds its markup", async () => {
  const run = await audit(MIXED, "release");

  assert.equal(pagesOf(run).length, 6, "six pages were read");
  for (const page of pagesOf(run)) {
    assert.equal(page.html, "", `${page.finalUrl} still holds its markup`);
  }
});

test("the record of attempts holds no markup either", async () => {
  // The crawl keeps each page in two lists. They are the same objects, and a
  // release that reached only one of them would have freed nothing.
  const run = await audit(MIXED, "release");

  const evaluated = run.crawl.attempts.filter((attempt) => attempt.outcome === "evaluated");
  assert.equal(evaluated.length, 6);
  for (const attempt of evaluated) {
    assert.equal(attempt.outcome === "evaluated" && attempt.page.html, "");
  }
});

test("the markup is let go during the crawl, not only at its end", async () => {
  /*
   * The property that matters for memory. At the moment each page is measured,
   * every page measured before it must already be empty: so however many pages
   * a site has, the crawl holds the markup of the one in hand.
   */
  const seen: FetchedPage[] = [];
  const stillHeld: number[] = [];

  await audit(LARGER, "release", {
    spy: (page) => {
      stillHeld.push(seen.filter((earlier) => earlier.html !== "").length);
      seen.push(page);
    },
  });

  assert.equal(seen.length, 12);
  assert.deepEqual(stillHeld, Array(12).fill(0), "no earlier page held its markup when the next was measured");
});

test("each page is measured once, with its whole markup, before that markup goes", async () => {
  const lengths = new Map<string, number>();
  const calls: string[] = [];

  const run = await audit(MIXED, "release", {
    spy: (page) => {
      calls.push(page.finalUrl);
      lengths.set(page.finalUrl, page.html.length);
    },
  });

  assert.equal(calls.length, 6, "once for each page read");
  assert.equal(new Set(calls).size, 6, "and never twice for the same page");
  for (const page of pagesOf(run)) {
    const original = MIXED[page.finalUrl] ?? MIXED[page.finalUrl.replace(/\/$/, "")];
    assert.equal(lengths.get(page.finalUrl), original?.html.length, `${page.finalUrl} was measured whole`);
  }
});

test("links are followed before the markup goes, so every page is still reached", async () => {
  const run = await audit(MIXED, "release");

  assert.deepEqual(
    pagesOf(run).map((page) => page.finalUrl).sort(),
    [ROOT, `${ROOT}about`, `${ROOT}blog`, `${ROOT}contact`, `${ROOT}legal`, `${ROOT}services`],
  );
  assert.equal(run.crawl.summary.unavailable.length, 1, "and the one that could not be read is still recorded");
});

test("everything about a page except its markup is kept", async () => {
  const run = await audit(MIXED, "release");
  const contact = pagesOf(run).find((page) => page.finalUrl === `${ROOT}contact`);

  assert.ok(contact);
  assert.deepEqual(contact.setCookieHeaders, ["session=abc; Path=/"]);
  assert.deepEqual(contact.redirectChain, [`${ROOT}contact`]);
  assert.equal(contact.servedOverHttps, true);
  assert.equal(contact.contentType, "text/html; charset=utf-8");
  assert.equal(contact.uptime?.statusCode, 200);
});

test("no markup reaches the audit's result", async () => {
  const run = await audit(MIXED, "release");
  const text = JSON.stringify(run.audit);

  for (const marker of ["MARKUP-OF-HOME", "MARKUP-OF-ABOUT", "MARKUP-OF-SERVICES", "<!doctype"]) {
    assert.ok(!text.includes(marker), `${marker} is in the result`);
  }
});

// ---------------------------------------------------------------------------
// The crawler on its own
// ---------------------------------------------------------------------------

const crawlOf = (site: FakeSite, extra: Partial<CrawlOptions> = {}) =>
  withNetworkUnplugged(() =>
    crawlSite({
      requestedUrl: ROOT,
      fetchImpl: fetcherFor(site),
      sitemapFetchImpl: siteFilesFor(),
      useSitemaps: false,
      sleepImpl: noPause,
      ...extra,
    }),
  );

test("a crawl that is not asked to measure keeps every page's markup, as it always did", async () => {
  const crawl = await crawlOf(MIXED);

  assert.equal(crawl.pages.length, 6);
  for (const page of crawl.pages) {
    assert.ok(page.html.includes("<!doctype html>"), `${page.finalUrl} lost its markup`);
  }
});

test("a crawl that is asked to measure reads the same pages in the same order", async () => {
  const kept = await crawlOf(MIXED, { limits: { concurrency: 1 } });
  const released = await crawlOf(MIXED, { limits: { concurrency: 1 }, measurePage: () => {} });

  assert.deepEqual(
    released.pages.map((page) => page.finalUrl),
    kept.pages.map((page) => page.finalUrl),
  );
  assert.deepEqual(released.summary, kept.summary, "and reports the same crawl");
});

test("a measurer that throws still has the markup released, and ends the crawl", async () => {
  const seen: FetchedPage[] = [];

  await assert.rejects(
    crawlOf(MIXED, {
      limits: { concurrency: 1 },
      measurePage: (page) => {
        seen.push(page);
        throw new Error("the measurer failed");
      },
    }),
    /the measurer failed/,
  );

  assert.ok(seen.length >= 1);
  for (const page of seen) assert.equal(page.html, "", "released even though measuring it failed");
});

// ---------------------------------------------------------------------------
// It is the same audit
// ---------------------------------------------------------------------------

const SCENARIOS: readonly { name: string; site: FakeSite; checks?: FakeSiteChecks; maxPages?: number }[] = [
  { name: "a mixed six-page site with one unreadable address", site: MIXED, checks: { spfMissing: true } },
  { name: "a twelve-page site read in full", site: LARGER },
  { name: "a twelve-page site stopped at five pages (a partial audit)", site: LARGER, maxPages: 5 },
  { name: "a site whose certificate has expired but whose pages were read", site: MIXED, checks: { certificateExpired: true } },
  { name: "a site whose DNS lookup failed", site: MIXED, checks: { dnsError: true } },
  { name: "a one-page site", site: { [ROOT]: MIXED[ROOT] } },
];

for (const scenario of SCENARIOS) {
  test(`the audit is unchanged: ${scenario.name}`, async () => {
    const options = { checks: scenario.checks, maxPages: scenario.maxPages, crawl: { limits: { concurrency: 1, ...(scenario.maxPages === undefined ? {} : { maxPages: scenario.maxPages }) } } };

    const before = await audit(scenario.site, "retain", options);
    const after = await audit(scenario.site, "release", options);

    // The reference really is the old path, and the new one really released.
    assert.ok(pagesOf(before).every((page) => page.html !== ""), "the reference run kept its markup");
    assert.ok(pagesOf(after).every((page) => page.html === ""), "the new run released it");

    assert.ok(!isCertificateFailureAudit(before.audit) && !isCertificateFailureAudit(after.audit));
    if (isCertificateFailureAudit(before.audit) || isCertificateFailureAudit(after.audit)) return;

    // Findings, with their severities, evidence, affected pages and counts.
    assert.deepEqual(after.audit.site.findings, before.audit.site.findings, "site findings");
    assert.deepEqual(after.audit.site.skippedChecks, before.audit.site.skippedChecks, "skipped checks");
    assert.equal(after.audit.site.evaluatedPages, before.audit.site.evaluatedPages, "pages evaluated");
    assert.ok(before.audit.site.findings.length > 0, "the scenario has findings to compare");

    // Every page, and everything measured on it.
    assert.equal(after.audit.pages.length, before.audit.pages.length, "page count");
    assert.deepEqual(
      after.audit.pages.map((page) => page.url),
      before.audit.pages.map((page) => page.url),
      "the same pages in the same order",
    );

    // The crawl's own account: how many found, read, unavailable, and why it stopped.
    assert.deepEqual(after.audit.crawl, before.audit.crawl, "crawl summary");

    // The grade.
    assert.deepEqual(scoreAudit(after.audit), scoreAudit(before.audit), "score");

    // And everything else, in one comparison, with only the clock removed.
    assert.deepEqual(comparable(after.audit), comparable(before.audit), "the whole audit");
  });
}

test("a partial audit is still partial, and says the same thing about why", async () => {
  const options = { maxPages: 5, crawl: { limits: { concurrency: 1, maxPages: 5 } } };
  const before = await audit(LARGER, "retain", options);
  const after = await audit(LARGER, "release", options);

  assert.equal(after.audit.crawl.complete, false);
  assert.equal(after.audit.crawl.evaluated, 5);
  assert.equal(after.audit.crawl.stoppedBecause, before.audit.crawl.stoppedBecause);
  assert.equal(after.audit.crawl.discovered, before.audit.crawl.discovered);
});

test("the same audit is produced with the crawler's usual three workers", async () => {
  // Order of arrival can differ with several workers, so the comparison is of
  // what was found rather than of the order it was found in.
  const before = await audit(LARGER, "retain");
  const after = await audit(LARGER, "release");

  assert.ok(!isCertificateFailureAudit(before.audit) && !isCertificateFailureAudit(after.audit));
  if (isCertificateFailureAudit(before.audit) || isCertificateFailureAudit(after.audit)) return;

  const byId = (result: typeof before.audit) =>
    [...result.site.findings].sort((a, b) => a.id.localeCompare(b.id)).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      affectedCount: finding.affectedCount,
      evaluatedPages: finding.evaluatedPages,
    }));

  assert.deepEqual(byId(after.audit), byId(before.audit));
  assert.deepEqual(scoreAudit(after.audit), scoreAudit(before.audit));
  assert.equal(after.audit.pages.length, 12);
});

// ---------------------------------------------------------------------------
// A check that fails
// ---------------------------------------------------------------------------

test("a check that throws ends the audit with the same error as before, and the crawl still finishes first", async () => {
  /*
   * The checks now run inside the crawl. If one throwing ended the crawl from
   * the inside, a fault in one page's check would lose the pages after it and
   * surface as a different failure. The error is kept and thrown where the
   * checks used to run.
   */
  const boom = new Error("a check failed on this page");
  const poison = (page: FetchedPage) => {
    if (page.finalUrl !== `${ROOT}about`) return;
    Object.defineProperty(page, "headers", {
      get() {
        throw boom;
      },
    });
  };

  const run = async (mode: "release" | "retain") => {
    let crawl: CrawlResult | null = null;
    const crawlImpl: typeof crawlSite = async (options) => {
      const given = options.measurePage;
      crawl = await crawlSite({
        ...options,
        measurePage: (page) => {
          poison(page);
          if (mode === "release") given?.(page);
        },
      });
      // The old path: the crawl measured nothing, so the audit must.
      if (mode === "retain") for (const page of crawl.pages) page.html = MIXED[page.finalUrl]?.html ?? "";
      return crawl;
    };

    const outcome = await withNetworkUnplugged(() =>
      runSiteAudit({
        requestedUrl: ROOT,
        crawlImpl,
        crawl: { fetchImpl: fetcherFor(MIXED), sitemapFetchImpl: siteFilesFor(), useSitemaps: false, sleepImpl: noPause, limits: { concurrency: 1 } },
        siteChecksImpl: siteChecksFor(),
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    return { outcome, crawl: crawl as CrawlResult | null };
  };

  const after = await run("release");
  const before = await run("retain");

  assert.equal(after.outcome, boom, "the very error the check threw");
  assert.equal(before.outcome, boom, "as it was before");
  assert.equal(after.crawl?.pages.length, 6, "and the crawl read every page before the audit failed");
});

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

test("a page's markup is read in exactly three places", () => {
  /*
   * The release is safe because nothing reads the markup after it. This is
   * that fact, asserted: link discovery in the crawler, and the two checks in
   * the audit's one measuring function. A fourth reader added later would be
   * reading an empty string, and this test is where that is caught.
   */
  const code = (file: string) =>
    fs
      .readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const audit = code("./siteAudit.ts");
  const crawler = code("../collector/crawlSite.ts");

  assert.equal(audit.split("page.html").length - 1, 2, "the two checks, in one function");
  assert.equal(crawler.split("extractLinks(page.html)").length - 1, 1, "link discovery");
  assert.equal(crawler.split("Buffer.byteLength(result.page.html").length - 1, 1, "measuring its size, which parses nothing");
  assert.equal(crawler.split('result.page.html = ""').length - 1, 2, "and the two releases: after measuring, or at once when too large");
  assert.equal(crawler.split(".html").length - 1, 4, "nothing else in the crawler touches markup");
});
