/**
 * Tests for the sequential crawl loop.
 *
 * This is the first stage that performs network requests, so most of what
 * follows exists to prove the crawler does NOT have its own idea about
 * security. It delegates every request to `fetchPage`, which validates the
 * hostname before each request and again on every redirect hop.
 *
 * No test here reaches the internet. Almost all of them inject `fetchImpl`; the
 * few that use the real `fetchPage` do so against addresses that are refused
 * before a socket is opened, which is the point of those tests.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { createDeadline, type Deadline } from "./deadline.ts";
import { crawlSite, PAGE_BUDGET_MS, UnusableStartingUrlError, type CrawlOptions } from "./crawlSite.ts";
import { fetchPage, NOT_A_WEB_PAGE, type FetchPageResult, type FetchedPage } from "./fetchPage.ts";
import { createFrontier, DEFAULT_CRAWL_LIMITS } from "./crawlFrontier.ts";
import { normalizeCrawlUrl } from "./crawlUrl.ts";
import type { SitemapFetcher } from "./sitemap.ts";

const SITE = "https://example.com/";

/** Never actually waits. Every politeness delay in this file is instant. */
const noSleep = async () => {};

/**
 * A crawl that reaches no network and spends no real time.
 *
 * Sitemap discovery and robots are both ON in production and both fetch from
 * the site, so without disabling them every test in this file would make a real
 * request for example.com's /robots.txt and /sitemap.xml. The tests that are
 * ABOUT those opt back in and pass their own fetcher.
 */
const crawl = (options: CrawlOptions) =>
  crawlSite({ useSitemaps: false, useRobots: false, sleepImpl: noSleep, ...options });

/** As above, but with the site-level fetching left on for tests that need it. */
const crawlSite_ = (options: CrawlOptions) => crawlSite({ sleepImpl: noSleep, ...options });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function page(
  url: string,
  html = "<html><head><title>T</title></head><body>t</body></html>",
): FetchedPage {
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

const OK = (url: string): FetchPageResult => ({ ok: true, page: page(url) });

const FAILED = (reason: string): FetchPageResult => ({ ok: false, reason, uptime: null });

const NON_HTML: FetchPageResult = {
  ok: false,
  reason: NOT_A_WEB_PAGE,
  uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 30 },
};

/** A stand-in fetcher that answers from a script and records what it was asked. */
function scriptedFetch(answers: (url: string) => FetchPageResult) {
  const calls: string[] = [];
  // Typed as the real function, so a stub with a looser contract will not
  // compile — the substitute can never promise less than what it replaces.
  const impl: typeof fetchPage = async (url) => {
    calls.push(url);
    return answers(url);
  };
  return { impl, calls };
}

/** A fetcher that records how much time each page was given. */
function budgetRecordingFetch() {
  const budgets: number[] = [];
  const impl: typeof fetchPage = async (_url, deadline?: Deadline) => {
    // -1 would mean the loop handed over no clock at all, itself a bug.
    budgets.push(deadline === undefined ? -1 : deadline.remainingMs());
    return FAILED("gone");
  };
  return { impl, budgets };
}

/**
 * A fetcher backed by a little website: a map of address to HTML.
 *
 * Anything not in the map answers as "not found", which is what lets a test
 * prove a link was NOT followed — the crawl would have recorded a failure.
 */
function siteFetch(
  pages: Record<string, string>,
  redirects: Record<string, string> = {},
) {
  const calls: string[] = [];
  const impl: typeof fetchPage = async (url) => {
    calls.push(url);
    const finalUrl = redirects[url] ?? url;
    const html = pages[finalUrl];
    if (html === undefined) return FAILED("That website address could not be found.");
    return { ok: true, page: page(finalUrl, html) };
  };
  return { impl, calls };
}

/** Links to every address given, as a page would write them. */
const linksTo = (...hrefs: string[]) =>
  `<html><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join("")}</body></html>`;

/** A clock the test drives by hand, so no test waits for real time to pass. */
function clock() {
  let value = 0;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

function sourceOf(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

/** Source with comments removed, so prose about fetch() is not read as a call. */
function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// The things that can happen to one page
// ---------------------------------------------------------------------------

test("a successful starting page is evaluated", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.pages.length, 1);
  assert.equal(result.summary.evaluated, 1);
  assert.equal(result.summary.unavailable.length, 0);
  assert.equal(result.summary.skippedNonHtml, 0);
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.complete, true);
  assert.equal(result.attempts[0].outcome, "evaluated");
});

test("a failed starting page still produces an honest summary", async () => {
  const fetcher = scriptedFetch(() => FAILED("That website address could not be found."));
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(result.pages.length, 0, "there is nothing to audit");
  assert.equal(result.summary.evaluated, 0);
  assert.equal(result.summary.unavailable.length, 1);
  assert.equal(result.summary.unavailable[0].url, SITE);
  assert.match(result.summary.unavailable[0].reason, /could not be found/);
  // Nothing was left unvisited, so the crawl itself did finish.
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.discovered, 1);
});

test("a timeout is recorded as unavailable, in the collector's own words", async () => {
  const fetcher = scriptedFetch(() => FAILED("The website took too long to respond."));
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(result.attempts[0].outcome, "unavailable");
  // The crawler adds no words of its own: the reason passes through intact.
  assert.equal(result.summary.unavailable[0].reason, "The website took too long to respond.");
});

test("a non-HTML response is skipped, not counted as a failure", async () => {
  const fetcher = scriptedFetch(() => NON_HTML);
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(result.summary.skippedNonHtml, 1);
  assert.equal(result.summary.unavailable.length, 0, "a PDF is not a broken page");
  assert.equal(result.summary.evaluated, 0, "and it is not an audited page either");
  assert.equal(result.attempts[0].outcome, "non-html");
  assert.equal(result.pages.length, 0);
});

test("non-HTML is told apart by the exported constant, not by its wording", () => {
  // Matching on the sentence would mean that rewording it silently reclassifies
  // every PDF on every site as a broken page.
  const code = codeOf("./crawlSite.ts");
  assert.ok(code.includes("NOT_A_WEB_PAGE"), "compared against the symbol");
  assert.ok(
    !code.includes("doesn't point to a web page"),
    "the sentence itself must not appear in the crawler",
  );
});

// ---------------------------------------------------------------------------
// None of this is a finding
// ---------------------------------------------------------------------------

test("an unavailable page carries an address and a reason and nothing else", async () => {
  const fetcher = scriptedFetch(() => FAILED("The website refused our request."));
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // No severity, no evidence, no remediation: the fields a finding would have.
  assert.deepEqual(Object.keys(result.summary.unavailable[0]).sort(), ["reason", "url"]);
});

test("a crawl produces no findings at all — that is not this layer's job", async () => {
  const fetcher = scriptedFetch(() => FAILED("gone"));
  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(Object.keys(result).sort(), ["attempts", "pages", "robots", "summary"]);
  const asRecord: Record<string, unknown> = { ...result };
  assert.equal(asRecord.findings, undefined);
  assert.equal(asRecord.skippedChecks, undefined);
});

test("the crawler assigns no severity anywhere", () => {
  const code = codeOf("./crawlSite.ts");
  assert.ok(!/\b(critical|severity|warning|passed|failed)\s*[:=]/i.test(code));
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("maxPages stops the crawl before a single request is made", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxPages: 0 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 0, "no request may be made once the budget is spent");
  assert.equal(result.summary.stoppedBecause, "max-pages");
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.queuedAtStop, 1, "the page was discovered and never visited");
});

test("an attempted page counts toward maxPages even when the fetch fails", async () => {
  const fetcher = scriptedFetch(() => FAILED("timeout"));
  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxPages: 1 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 1, "a failed request still costs a request");
  assert.equal(result.summary.evaluated, 0);
  assert.equal(result.summary.unavailable.length, 1);
  // The budget is spent — the loop stops rather than retrying or continuing —
  // and the queue emptied on the same turn, so nothing was left unvisited.
  // That is a complete crawl of a site we could not read, not a partial one.
  assert.equal(result.summary.queuedAtStop, 0);
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.complete, true);
});

test("running out of crawl time stops the loop and names max-duration", async () => {
  const time = clock();
  const fetcher = scriptedFetch((url) => {
    time.advance(600); // this page eats the whole budget
    return OK(url);
  });

  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxDurationMs: 500 },
    now: time.now,
    fetchImpl: fetcher.impl,
  });

  // The first page was allowed: the budget was intact when it was claimed.
  assert.equal(fetcher.calls.length, 1);
  assert.equal(result.summary.evaluated, 1);
  assert.equal(result.summary.stoppedBecause, "max-duration");
  assert.equal(result.summary.complete, false);
});

test("the surrounding audit's clock stops the crawl, and is named separately", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  const result = await crawl({
    requestedUrl: SITE,
    outerDeadline: createDeadline(0), // already expired
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 0);
  // Not "max-duration": the crawl did not use its budget, the audit ran out.
  assert.equal(result.summary.stoppedBecause, "deadline");
  assert.equal(result.summary.complete, false);
});

test("an empty queue is completion, not a limit", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxPages: 50, maxDurationMs: 300_000 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(result.summary.queuedAtStop, 0);
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.complete, true);
});

test("the counts in a summary reconcile against what was discovered", async () => {
  for (const answer of [OK(SITE), FAILED("gone"), NON_HTML]) {
    const fetcher = scriptedFetch(() => answer);
    const { summary } = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

    assert.equal(
      summary.evaluated +
        summary.unavailable.length +
        summary.skippedNonHtml +
        summary.queuedAtStop,
      summary.discovered,
    );
  }
});

// ---------------------------------------------------------------------------
// The starting URL goes through the Stage 1 gate
// ---------------------------------------------------------------------------

test("an unsupported starting scheme is refused before anything is fetched", async () => {
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "mailto:a@b.com",
    "data:text/html,x",
  ]) {
    const fetcher = scriptedFetch((url) => OK(url));
    await assert.rejects(
      () => crawl({ requestedUrl: bad, fetchImpl: fetcher.impl }),
      UnusableStartingUrlError,
      bad,
    );
    assert.equal(fetcher.calls.length, 0, `${bad} must never be fetched`);
  }
});

test("a dotless starting host is refused before anything is fetched", async () => {
  for (const bad of ["http://localhost:3000/", "http://intranet/", "http://[::1]/"]) {
    const fetcher = scriptedFetch((url) => OK(url));
    await assert.rejects(
      () => crawl({ requestedUrl: bad, fetchImpl: fetcher.impl }),
      UnusableStartingUrlError,
      bad,
    );
    assert.equal(fetcher.calls.length, 0, `${bad} must never be fetched`);
  }
});

test("a malformed starting address is refused rather than crashing obscurely", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  await assert.rejects(
    () => crawl({ requestedUrl: "not a url", fetchImpl: fetcher.impl }),
    (error: unknown) => error instanceof UnusableStartingUrlError && error.reason === "malformed",
  );
  assert.equal(fetcher.calls.length, 0);
});

test("the refusal says which address and why", async () => {
  await assert.rejects(
    () => crawl({ requestedUrl: "javascript:alert(1)" }),
    (error: unknown) =>
      error instanceof UnusableStartingUrlError &&
      error.requestedUrl === "javascript:alert(1)" &&
      error.reason === "unsupported-scheme" &&
      error.message.includes("unsupported-scheme"),
  );
});

test("the starting URL is normalised before it is fetched", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  await crawl({
    requestedUrl: "https://EXAMPLE.com/about/?utm_source=news&id=7#team",
    fetchImpl: fetcher.impl,
  });

  // Host lowercased, fragment and tracking parameter gone, real parameter kept.
  assert.deepEqual(fetcher.calls, ["https://example.com/about/?id=7"]);
});

test("credentials in the starting URL are never sent on", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  await crawl({ requestedUrl: "https://user:secret@example.com/", fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, ["https://example.com/"]);
});

test("the site boundary is taken from the normalised starting URL", async () => {
  const fetcher = scriptedFetch((url) => OK(url));
  const { summary } = await crawl({
    requestedUrl: "https://www.example.com/shop?utm_id=9",
    fetchImpl: fetcher.impl,
  });

  assert.equal(summary.requestedUrl, "https://www.example.com/shop");
});

// ---------------------------------------------------------------------------
// fetchPage is the only HTTP boundary
// ---------------------------------------------------------------------------

test("the crawler performs no HTTP of its own", () => {
  const code = codeOf("./crawlSite.ts");

  assert.ok(!/\bfetch\s*\(/.test(code), "no raw fetch() call");
  assert.ok(!/\bXMLHttpRequest\b/.test(code));
  assert.ok(!/\brequire\s*\(\s*["']https?["']\s*\)/.test(code), "no node http module");
  assert.ok(!/from\s+["']node:https?["']/.test(code));
  assert.ok(!/\bnew\s+Request\b/.test(code));
});

test("the crawler imports its fetching from fetchPage and nowhere else", () => {
  const imports = [...sourceOf("./crawlSite.ts").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(imports.sort(), [
    "./crawlFrontier.ts",
    "./crawlUrl.ts",
    "./deadline.ts",
    "./extractLinks.ts",
    "./fetchPage.ts",
    "./robots.ts",
    "./sitemap.ts",
  ]);
});

test("no HTTP or crawling dependency was introduced", () => {
  const pkg = JSON.parse(sourceOf("../../package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const banned of [
    "crawlee",
    "axios",
    "got",
    "got-scraping",
    "node-fetch",
    "undici",
    "puppeteer",
    "playwright",
    "request",
    "superagent",
  ]) {
    assert.equal(all[banned], undefined, `${banned} must not be a dependency`);
  }

  /*
   * The whole list, so a NEW dependency has to be argued for here rather than
   * appearing quietly. `@google/genai` was argued for and added in Phase 5D:
   * it is the AI provider's own SDK, it is imported only by `lib/ai/gemini`,
   * and a test in that folder walks the tree to prove nothing else reaches it.
   * The crawler never sees it, which is the property this guard protects.
   */
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "@google/genai",
    "cheerio",
    "next",
    "react",
    "react-dom",
  ]);
});

test("the SSRF check is not reimplemented in the crawler", () => {
  // Two copies of a security check means one of them drifts, and the one that
  // drifts is the one that lets something through.
  const code = codeOf("./crawlSite.ts");
  assert.ok(!/isPublicAddress|checkHostnameIsPublic|isPrivateIPv|safety\.ts/.test(code));
});

test("the link extractor performs no HTTP and knows nothing about safety", () => {
  const code = codeOf("./extractLinks.ts");

  assert.ok(!/\bfetch\s*\(/.test(code), "no raw fetch() call");
  assert.ok(!/from\s+["']node:https?["']/.test(code));
  assert.ok(!/isPublicAddress|checkHostnameIsPublic|isPrivateIPv/.test(code));
  // It must not re-decide any of these either — one list of unsafe schemes,
  // one same-site rule, one visited set, all of them elsewhere.
  assert.ok(!/javascript:|mailto:|isSameSite|dedupKey/.test(code));
});

test("the link extractor parses markup rather than pattern-matching it", () => {
  const source = sourceOf("./extractLinks.ts");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

  assert.deepEqual(imports, ["cheerio"], "the parser already used by the SEO checks");
});

test("every discovered link is requested through the same boundary", async () => {
  // Discovery produces addresses; it never fetches them. The proof is that the
  // injected fetcher sees every single request the crawl makes, including the
  // ones that came from a page's own markup.
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b"),
    "https://example.com/a": linksTo("/c"),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(result.summary.evaluated, 4);
  assert.equal(fetcher.calls.length, 4, "four pages read, four requests seen");
});

test("the production default is the real fetcher", () => {
  const code = codeOf("./crawlSite.ts");
  assert.ok(
    /options\.fetchImpl\s*\?\?\s*fetchPage/.test(code),
    "an absent stub must fall back to the secured implementation",
  );
});

// ---------------------------------------------------------------------------
// The delegated boundary actually holds
// ---------------------------------------------------------------------------

test("the REAL fetcher refuses loopback, private and link-local addresses", async () => {
  // No fetchImpl: this exercises the production path. Each address is refused
  // by fetchPage's hostname check before a socket is opened, so these are fast
  // and make no network request.
  for (const address of [
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
  ]) {
    const result = await crawl({
      requestedUrl: address,
      limits: { maxPages: 1, maxDurationMs: 5_000 },
    });

    assert.equal(result.pages.length, 0, `${address} must never be read`);
    assert.equal(result.summary.evaluated, 0, address);
    assert.equal(result.summary.unavailable.length, 1, address);
    // The exact wording matters here. "Could not connect" would mean the
    // request was ATTEMPTED and merely happened to find nothing listening —
    // which on a machine that does have something listening is a breach. This
    // sentence only comes from the safety check, before any socket is opened.
    assert.match(
      result.summary.unavailable[0].reason,
      /private or internal network/,
      `${address} must be refused by the safety check, not by a failed connection`,
    );
  }
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

test("each page is given a capped slice of the crawl's clock", async () => {
  const fetcher = budgetRecordingFetch();
  await crawl({
    requestedUrl: SITE,
    limits: { maxDurationMs: 300_000 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.budgets.length, 1);
  assert.notEqual(fetcher.budgets[0], -1, "the loop must hand over a clock");
  assert.ok(
    fetcher.budgets[0] <= PAGE_BUDGET_MS,
    `one slow page must not spend the whole crawl (got ${fetcher.budgets[0]}ms)`,
  );
});

test("the crawl's clock never outlives the surrounding audit", async () => {
  const fetcher = budgetRecordingFetch();
  await crawl({
    requestedUrl: SITE,
    outerDeadline: createDeadline(4_000),
    limits: { maxDurationMs: 300_000 },
    fetchImpl: fetcher.impl,
  });

  assert.ok(
    fetcher.budgets[0] <= 4_000,
    `the audit's clock wins when it is the shorter one (got ${fetcher.budgets[0]}ms)`,
  );
});

// ---------------------------------------------------------------------------
// Link discovery: the shapes a link can take
// ---------------------------------------------------------------------------

test("an absolute same-site link is followed", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("https://example.com/about"),
    "https://example.com/about": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/about"]);
  assert.equal(result.summary.evaluated, 2);
  assert.equal(result.summary.sources.html, 1);
  assert.equal(result.summary.complete, true);
});

test("a root-relative link is resolved and followed", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/about"),
    "https://example.com/about": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/about"]);
});

test("a nested relative link resolves against the directory it was found in", async () => {
  const fetcher = siteFetch({
    "https://example.com/docs/guide/intro": linksTo("../setup", "advanced"),
    "https://example.com/docs/setup": linksTo(),
    "https://example.com/docs/guide/advanced": linksTo(),
  });

  await crawl({
    requestedUrl: "https://example.com/docs/guide/intro",
    fetchImpl: fetcher.impl,
  });

  assert.deepEqual(fetcher.calls, [
    "https://example.com/docs/guide/intro",
    "https://example.com/docs/setup",
    "https://example.com/docs/guide/advanced",
  ]);
});

test("a protocol-relative link takes the scheme of the page it was found on", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("//example.com/shop", "//other.example/away"),
    "https://example.com/shop": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop"]);
});

test("a query-only link is a different page and is followed", async () => {
  const fetcher = siteFetch({
    "https://example.com/list": linksTo("?page=2"),
    "https://example.com/list?page=2": linksTo(),
  });

  await crawl({ requestedUrl: "https://example.com/list", fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [
    "https://example.com/list",
    "https://example.com/list?page=2",
  ]);
});

test("a fragment-only link is the same page and is not fetched again", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo("#top", "#section-2") });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE], "an anchor never leaves the page");
  assert.equal(result.summary.discovered, 1);
});

test("a link back to the current page does not queue it again", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/", SITE, "https://www.example.com/", "index.html"),
    "https://example.com/index.html": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // "/" , the absolute form and the www form are all this page. index.html is
  // NOT — a server may or may not serve the same thing, and we do not guess.
  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/index.html"]);
  assert.equal(result.summary.evaluated, 2);
});

test("the same page linked many ways is crawled once", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/a", "/a/", "/a?utm_source=news", "https://www.example.com/a"),
    "https://example.com/a": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/a"]);
  assert.equal(result.summary.discovered, 2);
});

test("www and non-www are one site, and both are crawlable", async () => {
  const fetcher = siteFetch({
    "https://www.example.com/": linksTo("https://example.com/plain"),
    "https://example.com/plain": linksTo(),
  });

  await crawl({ requestedUrl: "https://www.example.com/", fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [
    "https://www.example.com/",
    "https://example.com/plain",
  ]);
});

test("a link to another domain is never fetched", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(
      "https://other.example/page",
      "http://example.com.evil.test/",
      "https://blog.example.com/post",
      "https://example.co.uk/",
    ),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE]);
  // Off-site pages are not "discovered" either: discovered counts THIS site.
  assert.equal(result.summary.discovered, 1);
  assert.equal(result.summary.complete, true);
});

test("unsafe and non-web schemes in links are never fetched", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(
      "javascript:alert(1)",
      "mailto:sales@example.com",
      "tel:+441234567890",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "ftp://example.com/pub",
    ),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
});

test("malformed and oversized links are skipped without stopping the crawl", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(
      "http://", // a scheme with no host
      "https://[", // an unterminated IPv6 host
      "//", // protocol-relative with nothing after it
      "http://a b/", // a space in the host
      `https://example.com/${"x".repeat(3000)}`, // past MAX_URL_LENGTH
      "/good",
    ),
    "https://example.com/good": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // The good link is still found: one bad href does not abandon the page.
  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/good"]);
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.unavailable.length, 0, "a bad link is not a failure");
});

test("an href that merely LOOKS malformed is a real relative path", async () => {
  // ":::::" and "%%%" parse perfectly well as filenames, and a server may
  // genuinely serve them. Calling them malformed would silently skip real
  // pages — the same trap Stage 1 has a test for.
  const fetcher = siteFetch({
    [SITE]: linksTo(":::::", "%%%", "\\evil.example"),
    "https://example.com/:::::": linksTo(),
    "https://example.com/%%%": linksTo(),
    // Backslashes do not introduce a host: this stays a path on our own site.
    "https://example.com/evil.example": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(fetcher.calls.length, 4);
  assert.equal(result.summary.evaluated, 4);
  assert.equal(result.summary.complete, true);
});

test("a link to an internal address is refused before any request is made", async () => {
  // fetchPage would refuse these too. The same-site rule stops them earlier,
  // which is the point: a link on a public page cannot aim the crawler inward.
  const fetcher = siteFetch({
    [SITE]: linksTo(
      "http://127.0.0.1/",
      "http://localhost:3000/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/",
      "http://intranet/",
    ),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE], "not one of them may be requested");
  assert.equal(result.summary.discovered, 1);
});

// ---------------------------------------------------------------------------
// <base href>
// ---------------------------------------------------------------------------

/** A page carrying a <base href>, plus the links to resolve through it. */
const withBase = (base: string, ...hrefs: string[]) =>
  `<html><head><base href="${base}"></head><body>${hrefs
    .map((h) => `<a href="${h}">x</a>`)
    .join("")}</body></html>`;

test("an absolute base redirects where relative links point", async () => {
  const fetcher = siteFetch({
    [SITE]: withBase("https://example.com/shop/", "widgets"),
    "https://example.com/shop/widgets": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // Without the base this would have asked for /widgets, which does not exist.
  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop/widgets"]);
});

test("a relative base resolves against the page before it is used", async () => {
  const fetcher = siteFetch({
    "https://example.com/docs/index.html": withBase("../shop/", "widgets"),
    "https://example.com/shop/widgets": linksTo(),
  });

  await crawl({
    requestedUrl: "https://example.com/docs/index.html",
    fetchImpl: fetcher.impl,
  });

  assert.deepEqual(fetcher.calls, [
    "https://example.com/docs/index.html",
    "https://example.com/shop/widgets",
  ]);
});

test("a trailing slash on the base decides whether the last segment is a directory", async () => {
  // The difference is standard URL resolution, and it is not cosmetic.
  const withSlash = siteFetch({
    [SITE]: withBase("/shop/", "widgets"),
    "https://example.com/shop/widgets": linksTo(),
  });
  await crawl({ requestedUrl: SITE, fetchImpl: withSlash.impl });
  assert.deepEqual(withSlash.calls, [SITE, "https://example.com/shop/widgets"]);

  const withoutSlash = siteFetch({
    [SITE]: withBase("/shop", "widgets"),
    "https://example.com/widgets": linksTo(),
  });
  await crawl({ requestedUrl: SITE, fetchImpl: withoutSlash.impl });
  assert.deepEqual(withoutSlash.calls, [SITE, "https://example.com/widgets"]);
});

test("an absolute link ignores the base entirely", async () => {
  const fetcher = siteFetch({
    [SITE]: withBase("https://example.com/shop/", "https://example.com/about", "/root"),
    "https://example.com/about": linksTo(),
    "https://example.com/root": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // A root-relative link is absolute in path terms too: the base's directory
  // does not apply to it.
  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/about",
    "https://example.com/root",
  ]);
});

test("a base we cannot use falls back to the page's own address", async () => {
  for (const unusable of ["not a url", "http://", "javascript:alert(1)", "http://intranet/"]) {
    const fetcher = siteFetch({
      "https://example.com/docs/index.html": withBase(unusable, "guide"),
      "https://example.com/docs/guide": linksTo(),
    });

    await crawl({
      requestedUrl: "https://example.com/docs/index.html",
      fetchImpl: fetcher.impl,
    });

    assert.deepEqual(
      fetcher.calls,
      ["https://example.com/docs/index.html", "https://example.com/docs/guide"],
      `base ${unusable} should have been ignored, not crashed the crawl`,
    );
  }
});

test("an external base does NOT grant permission to crawl externally", async () => {
  const fetcher = siteFetch({
    [SITE]: withBase("https://evil.test/", "steal", "/also-steal", "https://evil.test/direct"),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // Every link now resolves onto evil.test, and every one is refused by the
  // same-site rule. A base decides where links POINT, never what may be read.
  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
  assert.equal(result.summary.complete, true);
});

test("unsafe schemes are still refused when a base is present", async () => {
  const fetcher = siteFetch({
    [SITE]: withBase(
      "https://example.com/shop/",
      "javascript:alert(1)",
      "mailto:x@example.com",
      "data:text/html,x",
      "file:///etc/passwd",
    ),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
});

test("a base cannot aim the crawler at an internal address", async () => {
  // The property that matters is not "no links were followed" — it is that
  // NOTHING INTERNAL WAS EVER REQUESTED. Two different bases reach that same
  // end by two different routes, and both are tested below.
  for (const base of [
    "http://127.0.0.1/",
    "http://localhost:3000/",
    "http://192.168.0.1/",
    "http://169.254.169.254/",
    "http://intranet/",
  ]) {
    const fetcher = siteFetch({
      [SITE]: withBase(base, "admin", "/secrets"),
      "https://example.com/admin": linksTo(),
      "https://example.com/secrets": linksTo(),
    });

    await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

    for (const requested of fetcher.calls) {
      assert.ok(
        requested.startsWith("https://example.com/"),
        `base ${base} caused a request to ${requested}`,
      );
    }
  }
});

test("a usable but off-site base makes every relative link off-site", async () => {
  // 127.0.0.1 has dots, so it is a usable base. Every relative link then
  // resolves onto it — and every one is refused by the same-site rule.
  const fetcher = siteFetch({ [SITE]: withBase("http://127.0.0.1/", "admin", "/secrets") });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
});

test("an unusable base leaves the page's own links working normally", async () => {
  // "localhost" has no dot, so Stage 1 refuses it as a base at all and
  // resolution falls back to the page. The links are ordinary same-site pages
  // and are crawled — refusing the base must not silently discard the page's
  // real navigation.
  const fetcher = siteFetch({
    [SITE]: withBase("http://localhost:3000/", "admin", "/secrets"),
    "https://example.com/admin": linksTo(),
    "https://example.com/secrets": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/admin",
    "https://example.com/secrets",
  ]);
  assert.equal(result.summary.evaluated, 3);
});

test("tracking parameters and fragments are still stripped through a base", async () => {
  const fetcher = siteFetch({
    [SITE]: withBase("https://example.com/shop/", "widgets?utm_source=news&id=4#top"),
    "https://example.com/shop/widgets?id=4": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop/widgets?id=4"]);
});

// ---------------------------------------------------------------------------
// Port as part of site identity
// ---------------------------------------------------------------------------

test("a non-default port is a different site and is not crawled", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("https://example.com:8080/staging", "http://example.com:8080/staging"),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // :8080 is routinely staging, an admin panel, or unrelated software sharing
  // a hostname. Auditing it while reporting on the public site would describe
  // the wrong application.
  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
});

test("a default port is not part of the identity", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("https://example.com:443/a", "http://example.com:80/b"),
    "https://example.com/a": linksTo(),
    "http://example.com/b": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // The URL parser drops :443 from https and :80 from http before we see them.
  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/a",
    "http://example.com/b",
  ]);
});

test("a crawl started on a non-default port stays on that port", async () => {
  const fetcher = siteFetch({
    "https://example.com:8080/": linksTo("/staging-page", "https://example.com/public"),
    "https://example.com:8080/staging-page": linksTo(),
  });

  const result = await crawl({
    requestedUrl: "https://example.com:8080/",
    fetchImpl: fetcher.impl,
  });

  // The relative link stays on :8080; the link to the ordinary site is off-site.
  assert.deepEqual(fetcher.calls, [
    "https://example.com:8080/",
    "https://example.com:8080/staging-page",
  ]);
  assert.equal(result.summary.discovered, 2);
});

// ---------------------------------------------------------------------------
// Sitemap discovery, wired into the crawl
// ---------------------------------------------------------------------------

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join("")}</urlset>`;

const sitemapindex = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

/** Serves sitemap files from a map; anything else is absent. */
function sitemapFiles(files: Record<string, string>) {
  const calls: string[] = [];
  const impl: SitemapFetcher = async (url) => {
    calls.push(url);
    const body = files[url];
    return body === undefined ? { ok: false, reason: "absent" } : { ok: true, body };
  };
  return { impl, calls };
}

test("pages only a sitemap knows about are crawled", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(), // nothing links to the deep page
    "https://example.com/deep/buried": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/deep/buried"),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/deep/buried"]);
  assert.equal(result.summary.sources.sitemap, 1);
  assert.equal(result.summary.sources.html, 0);
  assert.equal(result.summary.complete, true);
});

test("a sitemap index is walked and every page crawled", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/one.xml",
      "https://example.com/two.xml",
    ),
    "https://example.com/one.xml": urlset("https://example.com/a"),
    "https://example.com/two.xml": urlset("https://example.com/b"),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/a", "https://example.com/b"]);
  assert.equal(result.summary.sources.sitemap, 2);
});

test("sitemap addresses go through the same gate as page links", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset(
      "https://evil.test/steal", // another domain
      "http://127.0.0.1/admin", // an internal address
      "http://localhost/admin", // a dotless host
      "javascript:alert(1)", // an unsafe scheme
      "https://example.com:8080/staging", // a different port is a different site
      "ftp://example.com/pub", // not a web scheme
    ),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  // A sitemap is written by the site being audited. Being named in one is not
  // permission to fetch anything.
  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(result.summary.discovered, 1);
  assert.equal(result.summary.sources.sitemap, 0);
});

test("a page in both the sitemap and the markup is crawled once", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/shared", "/shared/?utm_source=x"),
    "https://example.com/shared": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/shared"),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shared"]);
  assert.equal(result.summary.discovered, 2);
  // Counted against whichever source reached it first — the sitemap, since
  // sitemaps are read before any page is fetched.
  assert.equal(result.summary.sources.sitemap, 1);
  assert.equal(result.summary.sources.html, 0);
});

test("the crawl order is the seed, then the sitemap, then the markup", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/from-link"),
    "https://example.com/from-sitemap": linksTo(),
    "https://example.com/from-link": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/from-sitemap"),
  });

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  // Deterministic, and the same on every run: the site's own declared list is
  // spent before navigation, so a crawl cut short by a limit covers what the
  // site says matters.
  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/from-sitemap",
    "https://example.com/from-link",
  ]);
});

test("sitemap pages still obey maxPages", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo() };
  for (const url of many) pages[url] = linksTo();

  const fetcher = siteFetch(pages);
  const sitemaps = sitemapFiles({ "https://example.com/sitemap.xml": urlset(...many) });

  const result = await crawlSite_({
    requestedUrl: SITE,
    limits: { maxPages: 4 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.equal(fetcher.calls.length, 4);
  assert.equal(result.summary.stoppedBecause, "max-pages");
  assert.equal(result.summary.complete, false);
});

test("sitemap pages still obey maxQueueSize", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo() };
  for (const url of many) pages[url] = linksTo();

  const fetcher = siteFetch(pages);
  const sitemaps = sitemapFiles({ "https://example.com/sitemap.xml": urlset(...many) });

  const result = await crawlSite_({
    requestedUrl: SITE,
    limits: { maxQueueSize: 3 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.equal(result.summary.stoppedBecause, "max-queue");
  assert.equal(result.summary.complete, false, "pages were declared and never visited");
});

test("an expired outer deadline stops the crawl before any sitemap is read", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    outerDeadline: createDeadline(0),
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(sitemaps.calls, [], "no time even to look");
  assert.deepEqual(fetcher.calls, []);
  assert.equal(result.summary.stoppedBecause, "deadline");
});

test("a site with no sitemap crawls exactly as before", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });
  const sitemaps = sitemapFiles({});

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/a"]);
  assert.equal(result.summary.sources.sitemap, 0);
  assert.equal(result.summary.sources.html, 1);
  assert.equal(result.summary.complete, true);
});

test("an unreachable sitemap is not a failure and not a finding", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps: SitemapFetcher = async () => ({ ok: false, reason: "absent" });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps,
  });

  assert.equal(result.summary.unavailable.length, 0, "a missing sitemap is not a broken page");
  assert.equal(result.summary.complete, true);
  assert.deepEqual(Object.keys(result).sort(), ["attempts", "pages", "robots", "summary"]);
});

test("a truncated sitemap still contributes the entries it did contain", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  });
  const sitemaps = sitemapFiles({
    // Cut off mid-document, as a connection dropped part-way would leave it.
    "https://example.com/sitemap.xml": "<urlset><url><loc>https://example.com/b",
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  // Half a sitemap is still a list of real pages, and the markup discovery is
  // unaffected either way.
  assert.ok(fetcher.calls.includes("https://example.com/b"), "the readable entry is used");
  assert.ok(fetcher.calls.includes("https://example.com/a"), "markup discovery is unaffected");
  assert.equal(result.summary.unavailable.length, 0);
  assert.equal(result.summary.complete, true);
});

test("unreadable nonsense in a sitemap yields nothing and breaks nothing", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": "<html><body>404 Not Found</body></html>",
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/a"]);
  assert.equal(result.summary.sources.sitemap, 0);
  assert.equal(result.summary.unavailable.length, 0);
});

test("a relative address in a sitemap resolves against the site, not rejected", async () => {
  // The specification calls for absolute addresses, but a relative one is
  // still a real page on this site — and Stage 1 resolves it like any other.
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/relative-entry": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("/relative-entry"),
  });

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/relative-entry"]);
});

test("sitemap discovery can be turned off", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  await crawlSite_({
    requestedUrl: SITE,
    useSitemaps: false,
    useRobots: false,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(sitemaps.calls, []);
  assert.deepEqual(fetcher.calls, [SITE]);
});

test("robots.txt is still read when sitemap discovery is off", async () => {
  // They are separate concerns sharing one file. Declining the site's list of
  // pages is not declining the site's rules about them.
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({});

  await crawlSite_({
    requestedUrl: SITE,
    useSitemaps: false,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(sitemaps.calls, ["https://example.com/robots.txt"]);
});

test("robots.txt is fetched once, not once per purpose", async () => {
  // The rules and the Sitemap: lines live in the same file. Reading it twice
  // would be two requests to a stranger's server for one document.
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({
    "https://example.com/robots.txt": "Sitemap: https://example.com/s.xml",
    "https://example.com/s.xml": urlset(),
  });

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  const robotsFetches = sitemaps.calls.filter((c) => c.endsWith("/robots.txt"));
  assert.equal(robotsFetches.length, 1);
  assert.ok(sitemaps.calls.includes("https://example.com/s.xml"), "and its lines were used");
});

test("sitemap discovery is on unless a caller turns it off", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const sitemaps = sitemapFiles({});

  // No `useSitemaps` given: the production default must be to look.
  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.deepEqual(sitemaps.calls, [
    "https://example.com/robots.txt",
    "https://example.com/sitemap.xml",
  ]);
});

// ---------------------------------------------------------------------------
// robots.txt enforcement
// ---------------------------------------------------------------------------

/** Serves a robots.txt plus any sitemap files. */
function robotsAnd(robotsTxt: string | null, files: Record<string, string> = {}) {
  const calls: string[] = [];
  const impl: SitemapFetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/robots.txt")) {
      return robotsTxt === null ? { ok: false, reason: "absent" } : { ok: true, body: robotsTxt };
    }
    const body = files[url];
    return body === undefined ? { ok: false, reason: "absent" } : { ok: true, body };
  };
  return { impl, calls };
}

test("a disallowed page discovered in markup is never fetched", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/admin/users", "/shop"),
    "https://example.com/shop": linksTo(),
    "https://example.com/admin/users": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop"]);
  assert.equal(summary.robots.excluded, 1);
  assert.equal(summary.robots.status, "rules");
  assert.equal(summary.robots.enforced, true);
});

test("a disallowed page is not a finding and not an evaluated page", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/admin/secret"),
    "https://example.com/admin/secret": linksTo(),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  // A page the site asked us not to visit is a well-run website behaving
  // normally. It is neither a fault nor a page we looked at.
  assert.equal(result.summary.unavailable.length, 0);
  assert.equal(result.summary.evaluated, 1, "only the home page");
  assert.equal(result.pages.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ["attempts", "pages", "robots", "summary"]);
  assert.deepEqual(
    Object.keys(result.summary.robots).sort(),
    ["enforced", "excluded", "status"],
    "no severity anywhere",
  );
});

test("a disallowed page discovered in a sitemap is never fetched either", async () => {
  // Being listed in the site's own sitemap is not an exemption from the rules
  // the same site published in its own robots.txt.
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/admin/panel": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin", {
      "https://example.com/sitemap.xml": urlset("https://example.com/admin/panel"),
    }).impl,
  });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(summary.robots.excluded, 1);
  assert.equal(summary.sitemapDiscovery.complete, true, "discovery itself still finished");
});

test("a page excluded from both sources is counted once", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo("/admin/x") });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin", {
      "https://example.com/sitemap.xml": urlset("https://example.com/admin/x"),
    }).impl,
  });

  assert.equal(summary.robots.excluded, 1, "one page, not two exclusions");
});

test("an Allow rule reopens part of a disallowed section", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/shop/private", "/shop/public"),
    "https://example.com/shop/public": linksTo(),
    "https://example.com/shop/private": linksTo(),
  });

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /shop\nAllow: /shop/public").impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop/public"]);
});

test("a rule aimed at another crawler does not restrict us", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/admin"),
    "https://example.com/admin": linksTo(),
  });

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: Googlebot\nDisallow: /admin").impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/admin"]);
});

test("a rule naming us specifically is obeyed", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/admin"),
    "https://example.com/admin": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: SkybookAuditBot\nDisallow: /admin").impl,
  });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(summary.robots.excluded, 1);
});

test("the requested page itself is not exempt from the rules", async () => {
  const fetcher = siteFetch({ "https://example.com/admin/panel": linksTo() });

  const { summary } = await crawlSite_({
    requestedUrl: "https://example.com/admin/panel",
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.deepEqual(fetcher.calls, [], "asking for it does not override the site's answer");
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.robots.excluded, 1);
  assert.equal(summary.unavailable.length, 0, "still not a fault of the site");
});

test("Disallow: / stops the crawl before anything is fetched", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo("/a", "/b") });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /").impl,
  });

  assert.deepEqual(fetcher.calls, []);
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.unavailable.length, 0);
  assert.equal(summary.robots.enforced, true);
});

test("no robots.txt means everything is permitted, and enforcement applied", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd(null).impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/a"]);
  assert.equal(summary.robots.status, "absent");
  assert.equal(summary.robots.enforced, true);
  assert.equal(summary.robots.excluded, 0);
});

test("an empty robots.txt permits everything", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("").impl,
  });

  assert.equal(fetcher.calls.length, 2);
  assert.equal(summary.robots.status, "empty");
  assert.equal(summary.robots.enforced, true);
});

test("an unreachable robots.txt crawls on, but says enforcement did NOT apply", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });
  const unreachable: SitemapFetcher = async () => ({ ok: false, reason: "unavailable" });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: unreachable,
  });

  // The audit is not abandoned because a file timed out — but nothing may
  // claim the site's rules were respected, because they were never read.
  assert.equal(fetcher.calls.length, 2);
  assert.equal(summary.robots.status, "unavailable");
  assert.equal(summary.robots.enforced, false);
});

test("a robots.txt that times out does not become a finding", async () => {
  const timingOut: SitemapFetcher = async (_url, deadline) => {
    void deadline;
    return { ok: false, reason: "unavailable" };
  };

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
    sitemapFetchImpl: timingOut,
  });

  // Still not a finding, and not a page failure: nothing about the website
  // went wrong.
  assert.equal(result.summary.unavailable.length, 0);
  assert.equal(result.summary.robots.enforced, false);

  /*
   * But the crawl is NOT complete. An unreadable robots.txt may have declared
   * sitemaps we will now never look for, so there may be sections of the site
   * we never heard of — and "we audited your whole site" would be false.
   */
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.sitemapDiscovery.complete, false);
  assert.equal(result.summary.sitemapDiscovery.stoppedBecause, "unavailable");
});

test("robots cannot make an off-site or private address crawlable", async () => {
  // The rules are consulted only for addresses that already passed the
  // same-site check, and everything surviving is still fetched through the
  // boundary that checks hostnames. An Allow line is not a key.
  const fetcher = siteFetch({
    [SITE]: linksTo(
      "https://evil.test/steal",
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "https://example.com:8080/staging",
    ),
  });

  const permissive = `User-agent: *
Allow: /
Allow: https://evil.test/steal
Allow: http://127.0.0.1/admin
Allow: http://169.254.169.254/`;

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd(permissive).impl,
  });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(summary.discovered, 1);
});

test("robots cannot make a sitemap's off-site entries crawlable", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nAllow: /", {
      "https://example.com/sitemap.xml": urlset(
        "https://evil.test/a",
        "http://127.0.0.1/b",
        "https://example.com/ok",
      ),
    }).impl,
  });

  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/ok"]);
  assert.equal(summary.discovered, 2);
});

test("an off-site link is refused as off-site, never counted as a robots exclusion", async () => {
  // Pins the ORDER of the gate: same-site is decided before robots is asked.
  // Without that, a Disallow: /admin would claim credit for excluding
  // evil.test/admin — a page robots.txt has no authority over at all, and the
  // count would overstate what the site asked us to skip.
  const fetcher = siteFetch({ [SITE]: linksTo("https://evil.test/admin/x") });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.deepEqual(fetcher.calls, [SITE]);
  assert.equal(summary.robots.excluded, 0, "off-site is not a robots exclusion");
  assert.equal(summary.discovered, 1);
});

test("the robots request itself goes through the shared secure fetcher", async () => {
  // Same injected boundary as the sitemaps: whatever fetches robots.txt is the
  // per-hop-checked one, and a test can see every address it was given.
  const robots = robotsAnd("User-agent: *\nDisallow: /x");

  await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
    sitemapFetchImpl: robots.impl,
  });

  assert.equal(robots.calls[0], "https://example.com/robots.txt");
  for (const called of robots.calls) {
    assert.ok(called.startsWith("https://example.com/"), called);
  }
});

test("a robots.txt reached through a redirect is still governed by the fetcher", async () => {
  // safeFetch follows redirects itself, checking every hop. The crawler never
  // sees them, which is the point — there is no second redirect policy here.
  const code = codeOf("./robots.ts");
  assert.ok(!/redirect/i.test(code), "no redirect handling of its own");
  assert.ok(/safeFetch|createSitemapFetcher/.test(sourceOf("./robots.ts")));
});

test("robots enforcement can be turned off", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/admin"),
    "https://example.com/admin": linksTo(),
  });

  await crawlSite_({
    requestedUrl: SITE,
    useRobots: false,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.equal(fetcher.calls.length, 2);
});

test("robots exclusions do not interfere with maxPages", async () => {
  const many = Array.from({ length: 8 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many, "/admin/x") };
  for (const p of many) pages[`https://example.com${p}`] = linksTo();

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    limits: { maxPages: 3 },
    fetchImpl: siteFetch(pages).impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.equal(summary.stoppedBecause, "max-pages");
  assert.equal(summary.robots.excluded, 1);
  assert.equal(summary.complete, false);
});

test("a disallowed page never enters the queue, so it is not counted as discovered", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo("/admin/a", "/admin/b", "/ok") });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  // `discovered` counts pages the crawl may visit. The excluded ones are
  // reported separately rather than inflating a number a reader will read as
  // "pages we know about and intend to audit".
  assert.equal(summary.discovered, 2, "the home page and /ok");
  assert.equal(summary.robots.excluded, 2);
});

test("every crawl reports a robots section, whatever happened", async () => {
  const cases: Array<[string, SitemapFetcher]> = [
    ["rules", robotsAnd("User-agent: *\nDisallow: /x").impl],
    ["empty", robotsAnd("").impl],
    ["absent", robotsAnd(null).impl],
    ["unavailable", (async () => ({ ok: false, reason: "unavailable" })) as SitemapFetcher],
  ];

  for (const [expected, impl] of cases) {
    const { summary } = await crawlSite_({
      requestedUrl: SITE,
      fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
      sitemapFetchImpl: impl,
    });

    assert.equal(summary.robots.status, expected);
    assert.equal(summary.robots.enforced, expected !== "unavailable", expected);
  }
});

test("robots does not change the completion semantics", async () => {
  // A crawl stopped by the site's own rules is not a crawl cut short by our
  // limits. There was no further work we were permitted to do.
  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: siteFetch({ [SITE]: linksTo("/admin/x") }).impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.sitemapDiscovery.complete, true);
  assert.equal(summary.complete, true);
  assert.equal(summary.robots.excluded, 1, "and the exclusion is still reported");
});

// ---------------------------------------------------------------------------
// A crawl is complete only if BOTH halves finished
// ---------------------------------------------------------------------------

test("a full page crawl plus a full sitemap read is a complete crawl", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/a": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.sitemapDiscovery.complete, true);
  assert.equal(summary.complete, true);
});

test("a complete page crawl with truncated discovery is NOT a complete crawl", async () => {
  // The case this correction exists for. Every page we knew about was visited,
  // so the page crawl really did complete — but a sitemap we knew existed was
  // never read, so there is a part of the site we never heard of. Reporting
  // "we audited your whole site" here would be false.
  const files: Record<string, string> = {
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/one.xml",
      "https://example.com/two.xml",
      "https://example.com/three.xml",
    ),
    "https://example.com/one.xml": urlset("https://example.com/a"),
    "https://example.com/two.xml": urlset("https://example.com/b"),
    "https://example.com/three.xml": urlset("https://example.com/c"),
  };

  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    sitemapLimits: { maxFiles: 2 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemapFiles(files).impl,
  });

  // The page crawl's own reason is untouched and still honest.
  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.queuedAtStop, 0);
  // The sitemap side says what went wrong, and where.
  assert.equal(summary.sitemapDiscovery.attempted, true);
  assert.equal(summary.sitemapDiscovery.complete, false);
  assert.equal(summary.sitemapDiscovery.stoppedBecause, "max-files");
  // And the claim about the SITE is lowered.
  assert.equal(summary.complete, false);
});

test("maxUrls truncating discovery makes the crawl incomplete", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo() };
  for (const url of many) pages[url] = linksTo();

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    sitemapLimits: { maxUrls: 3 },
    fetchImpl: siteFetch(pages).impl,
    sitemapFetchImpl: sitemapFiles({
      "https://example.com/sitemap.xml": urlset(...many),
    }).impl,
  });

  assert.equal(summary.sitemapDiscovery.stoppedBecause, "max-urls");
  assert.equal(summary.complete, false);
});

test("discovery running out of its own budget makes the crawl incomplete", async () => {
  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    sitemapLimits: { budgetMs: 0 },
    fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
    sitemapFetchImpl: sitemapFiles({
      "https://example.com/sitemap.xml": urlset("https://example.com/a"),
    }).impl,
  });

  assert.equal(summary.sitemapDiscovery.complete, false);
  assert.equal(summary.sitemapDiscovery.stoppedBecause, "budget");
  assert.equal(summary.complete, false);
});

test("a page-crawl limit still reports its own reason, not the sitemap's", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo() };
  for (const url of many) pages[url] = linksTo();

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    limits: { maxPages: 3 },
    fetchImpl: siteFetch(pages).impl,
    sitemapFetchImpl: sitemapFiles({
      "https://example.com/sitemap.xml": urlset(...many),
    }).impl,
  });

  // Sitemap discovery finished fine; it was the page budget that ran out, and
  // that is what the page stop reason must say.
  assert.equal(summary.sitemapDiscovery.complete, true);
  assert.equal(summary.stoppedBecause, "max-pages");
  assert.equal(summary.complete, false);
});

test("a crawl with sitemaps turned off is complete on the page crawl alone", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    useSitemaps: false,
    fetchImpl: fetcher.impl,
    // Turning sitemaps off does not turn robots.txt off, and robots.txt is
    // fetched through this same client. Without a stand-in it would be a real
    // request to a real address.
    sitemapFetchImpl: sitemapFiles({}).impl,
  });

  assert.equal(summary.sitemapDiscovery.attempted, false);
  assert.equal(summary.complete, true);
  assert.equal(summary.stoppedBecause, "completed");
});

test("every crawl reports a sitemapDiscovery, whatever happened", async () => {
  const shapes = [
    // The stand-in is still needed with sitemaps off: robots.txt uses it too.
    { useSitemaps: false, sitemapFetchImpl: sitemapFiles({}).impl },
    { sitemapFetchImpl: sitemapFiles({}).impl },
    {
      sitemapFetchImpl: sitemapFiles({
        "https://example.com/sitemap.xml": urlset("https://example.com/a"),
      }).impl,
    },
  ];

  for (const shape of shapes) {
    const { summary } = await crawlSite_({
      requestedUrl: SITE,
      fetchImpl: siteFetch({ [SITE]: linksTo(), "https://example.com/a": linksTo() }).impl,
      ...shape,
    });

    assert.deepEqual(
      Object.keys(summary.sitemapDiscovery).sort(),
      ["attempted", "complete", "stoppedBecause"],
      JSON.stringify(Object.keys(shape)),
    );
  }
});

test("truncated discovery is still not a finding", async () => {
  const { summary, ...rest } = await crawlSite_({
    requestedUrl: SITE,
    sitemapLimits: { maxFiles: 1 },
    fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
    sitemapFetchImpl: sitemapFiles({
      "https://example.com/sitemap.xml": sitemapindex("https://example.com/more.xml"),
    }).impl,
  });

  assert.equal(summary.complete, false);
  assert.equal(summary.unavailable.length, 0, "a bound we set is not the site's fault");
  assert.deepEqual(Object.keys(rest).sort(), ["attempts", "pages", "robots"]);
});

test("sitemap pages are fetched through fetchPage like any other page", async () => {
  // Discovery produces addresses; the page boundary fetches them. The injected
  // page fetcher sees every request, including the sitemap-declared ones.
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/declared": linksTo(),
  });
  const sitemaps = sitemapFiles({
    "https://example.com/sitemap.xml": urlset("https://example.com/declared"),
  });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemaps.impl,
  });

  assert.equal(fetcher.calls.length, 2);
  assert.equal(result.summary.evaluated, 2);
});

// ---------------------------------------------------------------------------
// Which pages may be mined for links
// ---------------------------------------------------------------------------

test("relative links resolve against the address we ENDED UP at", async () => {
  // /blog redirects to /articles/. A link to "2024-review" is a page inside
  // /articles/, not at the site root — resolving against what we ASKED for
  // would spend the crawl budget collecting 404s.
  const fetcher = siteFetch(
    {
      "https://example.com/articles/": linksTo("2024-review"),
      "https://example.com/articles/2024-review": linksTo(),
    },
    { "https://example.com/blog": "https://example.com/articles/" },
  );

  await crawl({ requestedUrl: "https://example.com/blog", fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [
    "https://example.com/blog",
    "https://example.com/articles/2024-review",
  ]);
});

test("a page that redirected is not fetched twice by its own self-link", async () => {
  // The frontier remembers the address we ASKED for. The address we ended up
  // at was never offered, so without a guard a self-link looks like a new page.
  const fetcher = siteFetch(
    { "https://example.com/final": linksTo("/final", "https://example.com/final") },
    { "https://example.com/start": "https://example.com/final" },
  );

  const result = await crawl({
    requestedUrl: "https://example.com/start",
    fetchImpl: fetcher.impl,
  });

  assert.deepEqual(fetcher.calls, ["https://example.com/start"]);
  assert.equal(result.summary.evaluated, 1, "the page is audited once, not twice");
});

test("a link to any address in the page's redirect chain is not re-crawled", async () => {
  // /start → /middle → /final. A link to /middle would just redirect back to
  // the page we are already reading, and audit it a second time.
  const html = linksTo("/start", "/middle", "/final");
  const calls: string[] = [];
  const impl: typeof fetchPage = async (url) => {
    calls.push(url);
    return {
      ok: true,
      page: {
        ...page("https://example.com/final", html),
        redirectChain: [
          "https://example.com/start",
          "https://example.com/middle",
          "https://example.com/final",
        ],
      },
    };
  };

  const result = await crawl({
    requestedUrl: "https://example.com/start",
    fetchImpl: impl,
  });

  assert.deepEqual(calls, ["https://example.com/start"]);
  assert.equal(result.summary.evaluated, 1);
});

test("a redirect that ends off-site is recorded but never mined", async () => {
  const fetcher = siteFetch(
    { "https://other.example/landing": linksTo("/a", "/b", "https://example.com/back") },
    { [SITE]: "https://other.example/landing" },
  );

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(fetcher.calls, [SITE], "its navigation is a stranger's, not ours");
  assert.equal(result.summary.evaluated, 1, "the page we were sent to is still recorded");
  assert.equal(result.summary.discovered, 1);
});

test("a page we could not read contributes no links", async () => {
  const fetcher = scriptedFetch(() => FAILED("The website took too long to respond."));

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(fetcher.calls.length, 1);
  assert.equal(result.summary.discovered, 1, "a timeout tells us nothing about the site");
  assert.equal(result.summary.sources.html, 0);
});

test("a non-HTML page contributes no links", async () => {
  const fetcher = scriptedFetch(() => NON_HTML);

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(fetcher.calls.length, 1);
  assert.equal(result.summary.discovered, 1);
  assert.equal(result.summary.sources.html, 0);
});

// ---------------------------------------------------------------------------
// Discovery obeys the limits it was given
// ---------------------------------------------------------------------------

test("discovered pages are crawled first-in-first-out, in document order", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b", "/c"),
    "https://example.com/a": linksTo("/a1"),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
    "https://example.com/a1": linksTo(),
  });

  await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  // Breadth first: every page of the first level before the second level's.
  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
    "https://example.com/a1",
  ]);
});

test("discovered pages still obey maxPages", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b", "/c", "/d", "/e"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
    "https://example.com/d": linksTo(),
    "https://example.com/e": linksTo(),
  });

  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxPages: 3 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 3);
  assert.equal(result.summary.discovered, 6);
  assert.equal(result.summary.queuedAtStop, 3);
  assert.equal(result.summary.stoppedBecause, "max-pages");
  assert.equal(result.summary.complete, false, "half a site is never a complete audit");
});

test("discovered pages still obey maxQueueSize", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many) };
  for (const path of many) pages[`https://example.com${path}`] = linksTo();

  const fetcher = siteFetch(pages);

  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxQueueSize: 3 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 4, "the seed plus what fitted in the queue");
  assert.equal(result.summary.discovered, 11, "all eleven were found");
  assert.equal(result.summary.stoppedBecause, "max-queue");
  assert.equal(result.summary.complete, false, "pages were found and never visited");
});

test("discovery cannot outrun the crawl's clock", async () => {
  const time = clock();
  const pages: Record<string, string> = { [SITE]: linksTo("/a", "/b", "/c") };
  for (const p of ["a", "b", "c"]) pages[`https://example.com/${p}`] = linksTo();

  const inner = siteFetch(pages);
  const impl: typeof fetchPage = async (url, deadline) => {
    time.advance(400);
    return inner.impl(url, deadline);
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { maxDurationMs: 1_000 },
    now: time.now,
    fetchImpl: impl,
  });

  assert.ok(inner.calls.length < 4, "it stopped before the queue drained");
  assert.equal(result.summary.stoppedBecause, "max-duration");
  assert.equal(result.summary.complete, false);
});

test("a crawl of a whole small site reports itself complete", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/about", "/contact"),
    "https://example.com/about": linksTo("/", "/contact"),
    "https://example.com/contact": linksTo("/about"),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.equal(fetcher.calls.length, 3, "the links between them do not cause re-crawls");
  assert.equal(result.summary.evaluated, 3);
  assert.equal(result.summary.discovered, 3);
  assert.equal(result.summary.sources.html, 2);
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.complete, true);
});

// ---------------------------------------------------------------------------
// Stage 4A scope
// ---------------------------------------------------------------------------

test("discovery adds no findings — it only produces more crawl work", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "javascript:x", "https://other.example/b"),
    "https://example.com/a": linksTo(),
  });

  const result = await crawl({ requestedUrl: SITE, fetchImpl: fetcher.impl });

  assert.deepEqual(Object.keys(result).sort(), ["attempts", "pages", "robots", "summary"]);
  assert.equal(result.summary.unavailable.length, 0);
  // A mailto: link and an outbound link are normal markup, not faults.
  assert.equal(result.attempts.every((a) => a.outcome === "evaluated"), true);
});

test("robots.txt is read for its Sitemap: lines and nothing else", () => {
  // Reading a signpost is not obeying a rule. Disallow is a separate stage,
  // and until it exists nothing may pretend to honour it — a crawler that
  // half-implements robots.txt is worse than one that plainly does not.
  const code = codeOf("./sitemap.ts") + codeOf("./crawlSite.ts");

  assert.ok(!/[Dd]isallow/.test(code), "no Disallow parsing");
  assert.ok(!/[Uu]ser-agent\s*[:=]/.test(code.replace(/USER_AGENT/g, "")), "no rule groups");
  assert.ok(!/blocksEveryCrawler/.test(code));
});

test("the worker pool is fixed, never one worker per queued page", () => {
  // The pool is built once from `concurrency`. Spawning a task per URL would
  // put the whole queue on a stranger's server at once.
  const code = codeOf("./crawlSite.ts");

  assert.ok(/length: workerCount/.test(code), "a fixed number of workers");
  assert.ok(!/Promise\.(all|allSettled|race|any)\s*\(\s*queue/.test(code));
});

// ---------------------------------------------------------------------------
// Concurrency and politeness
//
// Nothing below waits for real time or races. A gated fetcher holds every
// request open until the test releases it by name, so the number in flight,
// the order of completion and "nothing started after the stop" are all
// asserted exactly.
// ---------------------------------------------------------------------------

/**
 * A page fetcher the test opens and closes by hand.
 *
 * Every request parks until `release(url)` is called, which is what makes an
 * in-flight count observable rather than something to guess at.
 */
function gatedFetch(pages: Record<string, string>) {
  const started: string[] = [];
  const finished: string[] = [];
  const waiting = new Map<string, () => void>();
  let inFlight = 0;
  let peak = 0;

  const impl: typeof fetchPage = async (url) => {
    started.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);

    await new Promise<void>((resolve) => waiting.set(url, resolve));

    inFlight -= 1;
    finished.push(url);
    const html = pages[url];
    return html === undefined
      ? FAILED("That website address could not be found.")
      : { ok: true, page: page(url, html) };
  };

  return {
    impl,
    started,
    finished,
    get inFlight() {
      return inFlight;
    },
    get peak() {
      return peak;
    },
    /** Lets one parked request complete. Returns false if it was not parked. */
    release(url: string): boolean {
      const resume = waiting.get(url);
      if (resume === undefined) return false;
      waiting.delete(url);
      resume();
      return true;
    },
    releaseAll(): void {
      for (const [url, resume] of [...waiting]) {
        waiting.delete(url);
        resume();
      }
    },
    get parked(): string[] {
      return [...waiting.keys()];
    },
  };
}

/** Lets every pending microtask and timer callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Runs a gated crawl to completion, releasing whatever it parks.
 *
 * Bounded, so a crawl that never finishes fails the test instead of hanging
 * the suite — which is how the worker-pool deadlock was found in the first
 * place.
 */
async function drain<T>(crawling: Promise<T>, fetcher: { releaseAll(): void }): Promise<T> {
  let done = false;
  const result = crawling.then((value) => {
    done = true;
    return value;
  });

  for (let turn = 0; turn < 500 && !done; turn += 1) {
    await settle();
    fetcher.releaseAll();
  }

  assert.ok(done, "the crawl never finished");
  return result;
}

test("concurrency of 1 behaves exactly like the sequential crawler", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b"),
    "https://example.com/a": linksTo("/c"),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
  });

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 1 },
    fetchImpl: fetcher.impl,
  });

  // Same breadth-first order, same counts, same completion as before workers.
  assert.deepEqual(fetcher.calls, [
    SITE,
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
  assert.equal(result.summary.evaluated, 4);
  assert.equal(result.summary.complete, true);
});

test("concurrency of 3 really does keep three requests in flight", async () => {
  const fetcher = gatedFetch({
    [SITE]: linksTo("/a", "/b", "/c", "/d"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
    "https://example.com/d": linksTo(),
  });

  const crawling = crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
  });

  await settle();
  assert.deepEqual(fetcher.parked, [SITE], "only the seed is available at first");

  fetcher.release(SITE);
  await settle();

  // The seed's four links are now queued and three workers should be busy.
  assert.equal(fetcher.inFlight, 3);
  assert.deepEqual(fetcher.parked, [
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);

  const result = await drain(crawling, fetcher);
  assert.equal(result.summary.evaluated, 5);
  assert.equal(fetcher.peak, 3, "and never more than three");
});

test("no more than `concurrency` requests are ever in flight", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many) };
  for (const p of many) pages[`https://example.com${p}`] = linksTo();

  const fetcher = gatedFetch(pages);
  const crawling = crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
  });

  let done = false;
  const settled = crawling.then((value) => {
    done = true;
    return value;
  });

  for (let turn = 0; turn < 200 && !done; turn += 1) {
    await settle();
    assert.ok(fetcher.inFlight <= 3, `in flight reached ${fetcher.inFlight}`);
    fetcher.releaseAll();
  }

  const result = await settled;
  assert.equal(fetcher.peak, 3);
  assert.equal(result.summary.evaluated, 21);
});

test("maxPages cannot be exceeded no matter how many workers are running", async () => {
  // The failure this prevents: `processed` only rises when a page is RECORDED,
  // so three workers checking a budget of one would each see nothing spent.
  for (const maxPages of [1, 2, 5, 7]) {
    const many = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    const pages: Record<string, string> = { [SITE]: linksTo(...many) };
    for (const p of many) pages[`https://example.com${p}`] = linksTo();

    const fetcher = siteFetch(pages);
    const result = await crawl({
      requestedUrl: SITE,
      limits: { concurrency: 3, maxPages },
      fetchImpl: fetcher.impl,
    });

    assert.equal(fetcher.calls.length, maxPages, `budget of ${maxPages}`);
    assert.equal(result.attempts.length, maxPages, `budget of ${maxPages}`);
    assert.equal(result.summary.stoppedBecause, "max-pages");
    assert.equal(result.summary.complete, false);
  }
});

test("the exact maxPages boundary is still a complete crawl", async () => {
  // Three pages, a budget of three, three workers: nothing was declined.
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  });

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxPages: 3 },
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 3);
  assert.equal(result.summary.stoppedBecause, "completed");
  assert.equal(result.summary.complete, true);
});

test("a page attempt consumes the budget exactly once, however it turns out", async () => {
  // A timeout, a PDF and a good page each cost one request and no more.
  const answers: Record<string, FetchPageResult> = {
    [SITE]: { ok: true, page: page(SITE, linksTo("/a", "/b", "/c")) },
    "https://example.com/a": FAILED("timeout"),
    "https://example.com/b": NON_HTML,
    "https://example.com/c": { ok: true, page: page("https://example.com/c") },
  };
  const calls: string[] = [];
  const impl: typeof fetchPage = async (url) => {
    calls.push(url);
    return answers[url] ?? FAILED("gone");
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxPages: 4 },
    fetchImpl: impl,
  });

  assert.equal(calls.length, 4);
  assert.equal(result.summary.evaluated, 2);
  assert.equal(result.summary.unavailable.length, 1);
  assert.equal(result.summary.skippedNonHtml, 1);
  assert.equal(result.summary.complete, true);
});

test("maxQueueSize is not exceeded when workers discover at the same time", async () => {
  // Three workers all finishing near-simultaneously, each with links to offer.
  const pages: Record<string, string> = {
    [SITE]: linksTo("/a", "/b", "/c"),
    "https://example.com/a": linksTo(...Array.from({ length: 8 }, (_, i) => `/a${i}`)),
    "https://example.com/b": linksTo(...Array.from({ length: 8 }, (_, i) => `/b${i}`)),
    "https://example.com/c": linksTo(...Array.from({ length: 8 }, (_, i) => `/c${i}`)),
  };
  for (const prefix of ["a", "b", "c"]) {
    for (let i = 0; i < 8; i += 1) pages[`https://example.com/${prefix}${i}`] = linksTo();
  }

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxQueueSize: 5, maxPages: 100 },
    fetchImpl: siteFetch(pages).impl,
  });

  assert.equal(result.summary.stoppedBecause, "max-queue");
  assert.equal(result.summary.complete, false);
});

test("an expired deadline stops new work while running requests finish", async () => {
  const fetcher = gatedFetch({
    [SITE]: linksTo("/a", "/b", "/c"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
  });

  const outer = createDeadline(50_000);
  const crawling = crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    outerDeadline: outer,
    fetchImpl: fetcher.impl,
  });

  await settle();
  fetcher.release(SITE);
  await settle();

  assert.equal(fetcher.inFlight, 3, "three pages are in flight");
  const startedBefore = fetcher.started.length;

  // The audit runs out while those three are still open.
  const expired = createDeadline(0);
  outer.expired = expired.expired;
  outer.remainingMs = expired.remainingMs;

  const result = await drain(crawling, fetcher);

  assert.equal(
    fetcher.started.length,
    startedBefore,
    "requests already open finished, and no new page was started",
  );
  assert.equal(result.summary.stoppedBecause, "deadline");
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.evaluated, 4, "the in-flight pages were still recorded");
});

test("requests finishing out of order are all recorded correctly", async () => {
  const fetcher = gatedFetch({
    [SITE]: linksTo("/slow", "/quick", "/middle"),
    "https://example.com/slow": linksTo(),
    "https://example.com/quick": linksTo(),
    "https://example.com/middle": linksTo(),
  });

  const crawling = crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
  });

  await settle();
  fetcher.release(SITE);
  await settle();

  // Released in the opposite order to the one they were started in.
  fetcher.release("https://example.com/middle");
  await settle();
  fetcher.release("https://example.com/quick");
  await settle();
  fetcher.release("https://example.com/slow");

  const result = await drain(crawling, fetcher);

  assert.equal(result.summary.evaluated, 4);
  assert.deepEqual(fetcher.finished.slice(1), [
    "https://example.com/middle",
    "https://example.com/quick",
    "https://example.com/slow",
  ]);
  assert.equal(result.summary.complete, true);
});

test("two workers cannot both claim the same page", async () => {
  const pages: Record<string, string> = {
    [SITE]: linksTo("/shared", "/shared", "/shared/", "/other"),
    "https://example.com/shared": linksTo("/other"),
    "https://example.com/other": linksTo("/shared"),
  };

  const fetcher = siteFetch(pages);
  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
  });

  const shared = fetcher.calls.filter((c) => c === "https://example.com/shared");
  assert.equal(shared.length, 1);
  assert.equal(fetcher.calls.length, 3);
  assert.equal(result.summary.evaluated, 3);
});

test("robots exclusions hold with three workers running", async () => {
  const pages: Record<string, string> = {
    [SITE]: linksTo("/admin/a", "/ok/a", "/admin/b", "/ok/b"),
    "https://example.com/ok/a": linksTo("/admin/c"),
    "https://example.com/ok/b": linksTo("/admin/d"),
  };
  for (const p of ["a", "b", "c", "d"]) pages[`https://example.com/admin/${p}`] = linksTo();

  const fetcher = siteFetch(pages);
  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow: /admin").impl,
  });

  for (const called of fetcher.calls) {
    assert.ok(!called.includes("/admin"), `${called} was disallowed`);
  }
  assert.equal(summary.robots.excluded, 4);
});

test("sitemap and markup discovery interleave safely under concurrency", async () => {
  const pages: Record<string, string> = {
    [SITE]: linksTo("/from-link-1", "/from-link-2"),
    "https://example.com/from-sitemap-1": linksTo("/deep-1"),
    "https://example.com/from-sitemap-2": linksTo("/deep-2"),
    "https://example.com/from-link-1": linksTo(),
    "https://example.com/from-link-2": linksTo(),
    "https://example.com/deep-1": linksTo(),
    "https://example.com/deep-2": linksTo(),
  };

  const fetcher = siteFetch(pages);
  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("", {
      "https://example.com/sitemap.xml": urlset(
        "https://example.com/from-sitemap-1",
        "https://example.com/from-sitemap-2",
      ),
    }).impl,
  });

  assert.equal(fetcher.calls.length, 7);
  assert.equal(new Set(fetcher.calls).size, 7, "every page fetched exactly once");
  assert.equal(summary.evaluated, 7);
  assert.equal(summary.sources.sitemap, 2);
  assert.equal(summary.sources.html, 4);
  assert.equal(summary.complete, true);
});

test("failures, non-HTML and redirects all behave under concurrency", async () => {
  const fetcher = siteFetch(
    {
      [SITE]: linksTo("/gone", "/pdf", "/redirects", "/fine"),
      "https://example.com/fine": linksTo(),
      "https://example.com/landing": linksTo(),
    },
    { "https://example.com/redirects": "https://example.com/landing" },
  );

  const impl: typeof fetchPage = async (url, deadline) => {
    if (url === "https://example.com/pdf") return NON_HTML;
    return fetcher.impl(url, deadline);
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3 },
    fetchImpl: impl,
  });

  assert.equal(result.summary.skippedNonHtml, 1);
  assert.equal(result.summary.unavailable.length, 1);
  assert.equal(result.summary.unavailable[0].url, "https://example.com/gone");
  assert.equal(result.summary.evaluated, 3, "home, /fine and the redirect target");
  assert.equal(result.summary.complete, true);
});

test("the SSRF boundary is unchanged with workers running", async () => {
  // No fetchImpl: the real fetchPage, refusing before any socket is opened.
  const result = await crawlSite({
    requestedUrl: "http://169.254.169.254/latest/meta-data/",
    limits: { concurrency: 3, maxPages: 3, maxDurationMs: 5_000 },
    useSitemaps: false,
    useRobots: false,
    sleepImpl: noSleep,
  });

  assert.equal(result.pages.length, 0);
  assert.match(result.summary.unavailable[0].reason, /private or internal network/);
});

test("every stop reason still works with three workers", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many) };
  for (const p of many) pages[`https://example.com${p}`] = linksTo();

  const cases: Array<[string, Partial<CrawlOptions>]> = [
    ["max-pages", { limits: { concurrency: 3, maxPages: 4 } }],
    ["max-queue", { limits: { concurrency: 3, maxQueueSize: 4, maxPages: 100 } }],
    ["deadline", { limits: { concurrency: 3 }, outerDeadline: createDeadline(0) }],
  ];

  for (const [expected, overrides] of cases) {
    const result = await crawl({
      requestedUrl: SITE,
      fetchImpl: siteFetch(pages).impl,
      ...overrides,
    });
    assert.equal(result.summary.stoppedBecause, expected, expected);
    assert.equal(result.summary.complete, false, expected);
  }

  const completed = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxPages: 100 },
    fetchImpl: siteFetch(pages).impl,
  });
  assert.equal(completed.summary.stoppedBecause, "completed");
  assert.equal(completed.summary.complete, true);
});

test("max-duration still stops a concurrent crawl", async () => {
  const time = clock();
  const inner = siteFetch({
    [SITE]: linksTo(...Array.from({ length: 10 }, (_, i) => `/p${i}`)),
  });
  const impl: typeof fetchPage = async (url, deadline) => {
    time.advance(400);
    return inner.impl(url, deadline);
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxDurationMs: 1_000 },
    now: time.now,
    fetchImpl: impl,
  });

  assert.equal(result.summary.stoppedBecause, "max-duration");
  assert.equal(result.summary.complete, false);
});

// ---------------------------------------------------------------------------
// Politeness
// ---------------------------------------------------------------------------

/** Records every pause the crawl asks for, and advances a fake clock by it. */
function fakeSleep(time: { now: () => number; advance: (ms: number) => void }) {
  const waits: number[] = [];
  const impl = async (ms: number) => {
    waits.push(ms);
    time.advance(ms);
  };
  return { impl, waits };
}

test("requests are spaced by the politeness delay", async () => {
  const time = clock();
  const sleeper = fakeSleep(time);

  const pages: Record<string, string> = { [SITE]: linksTo("/a", "/b") };
  pages["https://example.com/a"] = linksTo();
  pages["https://example.com/b"] = linksTo();

  await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 1, perRequestDelayMs: 200 },
    now: time.now,
    sleepImpl: sleeper.impl,
    fetchImpl: siteFetch(pages).impl,
  });

  // Three pages: the first slot is free, then one 200ms wait before each of
  // the others.
  assert.deepEqual(sleeper.waits.filter((w) => w > 0), [200, 200]);
});

test("the delay spaces the whole crawl, not each worker separately", async () => {
  /*
   * Three workers each pausing 200ms between their OWN requests would be
   * fifteen requests a second at a stranger's server. Sharing one spacing is
   * five, which is what the approved defaults describe.
   *
   * Asserted on the SLOTS RESERVED rather than on wall-clock start times: the
   * clock is held still here, so each request's wait is the distance from now
   * to its reserved slot. Under one shared spacing those grow 200, 400, 600 —
   * each request booking the moment after the previous one. Were the spacing
   * per worker, three workers would each book from zero and the sequence would
   * repeat instead of climbing.
   */
  const frozen = { now: () => 0 };
  const waits: number[] = [];
  const recordOnly = async (ms: number) => {
    waits.push(ms);
  };

  const many = Array.from({ length: 6 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many) };
  for (const p of many) pages[`https://example.com${p}`] = linksTo();

  const fetcher = siteFetch(pages);
  await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, perRequestDelayMs: 200 },
    now: frozen.now,
    sleepImpl: recordOnly,
    fetchImpl: fetcher.impl,
  });

  assert.equal(fetcher.calls.length, 7);
  // The first request takes the free slot; every one after books 200ms later.
  assert.deepEqual(waits.slice(0, 6), [200, 400, 600, 800, 1000, 1200]);
});

test("a delay of zero asks for no waits at all", async () => {
  const time = clock();
  const sleeper = fakeSleep(time);

  await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, perRequestDelayMs: 0 },
    now: time.now,
    sleepImpl: sleeper.impl,
    fetchImpl: siteFetch({ [SITE]: linksTo("/a"), "https://example.com/a": linksTo() }).impl,
  });

  assert.deepEqual(sleeper.waits, []);
});

test("the politeness delay applies to real requests, not to idle workers", async () => {
  const time = clock();
  const sleeper = fakeSleep(time);

  // One page and three workers: the two that find nothing must not each have
  // spent a slot before discovering that.
  await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, perRequestDelayMs: 200 },
    now: time.now,
    sleepImpl: sleeper.impl,
    fetchImpl: siteFetch({ [SITE]: linksTo() }).impl,
  });

  // Four slots are reserved (one per worker attempt plus the retry), but the
  // crawl must not have waited longer than a couple of spacings for one page.
  assert.ok(time.now() <= 800, `the crawl advanced ${time.now()}ms for one page`);
});

test("a deadline that expires DURING a politeness wait stops the request", async () => {
  // The one window concurrency opens: a worker reserves its slot, waits, and
  // the crawl runs out of time while it is sleeping. What it was about to
  // fetch must not be fetched.
  const outer = createDeadline(50_000);
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  });

  // The first request takes the free slot without waiting, so the first actual
  // wait is the one before the second page.
  let waits = 0;
  const expireOnSecondWait = async () => {
    waits += 1;
    if (waits === 1) {
      const done = createDeadline(0);
      outer.expired = done.expired;
      outer.remainingMs = done.remainingMs;
    }
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 1, perRequestDelayMs: 200 },
    outerDeadline: outer,
    sleepImpl: expireOnSecondWait,
    fetchImpl: fetcher.impl,
  });

  assert.deepEqual(fetcher.calls, [SITE], "nothing started once time was up");
  assert.equal(result.summary.stoppedBecause, "deadline");
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.queuedAtStop, 2, "and the pages stay unvisited");
});

test("no request is made after the crawl has stopped", async () => {
  const time = clock();
  const sleeper = fakeSleep(time);
  const many = Array.from({ length: 20 }, (_, i) => `/p${i}`);
  const pages: Record<string, string> = { [SITE]: linksTo(...many) };
  for (const p of many) pages[`https://example.com${p}`] = linksTo();

  const inner = siteFetch(pages);
  let stopped = false;
  const impl: typeof fetchPage = async (url, deadline) => {
    assert.equal(stopped, false, `${url} was requested after the crawl returned`);
    return inner.impl(url, deadline);
  };

  const result = await crawl({
    requestedUrl: SITE,
    limits: { concurrency: 3, maxPages: 5, perRequestDelayMs: 200 },
    now: time.now,
    sleepImpl: sleeper.impl,
    fetchImpl: impl,
  });
  stopped = true;

  // Nothing may still be pending when the crawl resolves.
  await settle();
  await settle();

  assert.equal(inner.calls.length, 5);
  assert.equal(result.summary.stoppedBecause, "max-pages");
});

// ---------------------------------------------------------------------------
// Stage 1 and Stage 2 behaviour is unchanged
// ---------------------------------------------------------------------------

test("Stage 1 still resolves, canonicalises and rejects as it did", () => {
  const resolved = normalizeCrawlUrl("/about/?b=2&a=1#top", "https://www.example.com/products");
  assert.ok(resolved.ok);
  assert.equal(resolved.url.toString(), "https://www.example.com/about/?b=2&a=1");
  assert.equal(resolved.key, "example.com/about?a=1&b=2");

  const refused = normalizeCrawlUrl("javascript:alert(1)", "https://example.com/");
  assert.ok(!refused.ok);
  assert.equal(refused.reason, "unsupported-scheme");
});

test("Stage 2 still records the limit that actually stopped it", () => {
  const time = clock();
  const frontier = createFrontier({
    requestedUrl: SITE,
    limits: { maxPages: 1, maxDurationMs: 1_000 },
    now: time.now,
  });

  // Two pages and a budget of one, so the budget genuinely curtails the crawl.
  frontier.offer(SITE, "seed");
  frontier.offer("/second", "html");
  assert.notEqual(frontier.next(), null);
  frontier.recordEvaluated(SITE);
  assert.equal(frontier.next(), null, "the page budget is spent");

  // The duration limit is now true as well, and outranks max-pages in the
  // ordering — so a summary that recomputed the reason would report the wrong
  // one. It reports the limit that actually bit.
  time.advance(10_000);
  assert.equal(frontier.summary().stoppedBecause, "max-pages");
});

test("Stage 2 still treats an untouched frontier as a completed crawl", () => {
  const summary = createFrontier({ requestedUrl: SITE }).summary();

  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.complete, true);
  assert.equal(summary.discovered, 0);
});

test("the approved default limits are unchanged", () => {
  assert.deepEqual(DEFAULT_CRAWL_LIMITS, {
    maxPages: 150,
    maxDurationMs: 300_000,
    maxQueueSize: 2_000,
    maxResponseBytes: 5_000_000,
    concurrency: 3,
    perRequestDelayMs: 200,
  });
});

// ---------------------------------------------------------------------------
// The configured response limit is the one that applies
//
// `maxResponseBytes` sat in the limits unread for several stages. A caller
// could set it and silently receive the fetcher's own built-in default — a
// limit the API advertised and did not honour.
// ---------------------------------------------------------------------------

test("the crawl's maxResponseBytes reaches the fetcher", async () => {
  const seen: Array<number | undefined> = [];
  const impl: typeof fetchPage = async (url, _deadline, maxBytes?: number) => {
    seen.push(maxBytes);
    return OK(url);
  };

  await crawl({
    requestedUrl: SITE,
    limits: { maxResponseBytes: 250_000 },
    fetchImpl: impl,
  });

  assert.deepEqual(seen, [250_000], "the configured value, not a default");
});

test("the default limit is passed through as well", async () => {
  const seen: Array<number | undefined> = [];
  const impl: typeof fetchPage = async (url, _deadline, maxBytes?: number) => {
    seen.push(maxBytes);
    return OK(url);
  };

  await crawl({ requestedUrl: SITE, fetchImpl: impl });

  assert.deepEqual(seen, [DEFAULT_CRAWL_LIMITS.maxResponseBytes]);
});

test("every page of a crawl gets the configured limit, not just the first", async () => {
  const seen: number[] = [];
  const pages: Record<string, string> = {
    [SITE]: linksTo("/a", "/b"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  };
  const inner = siteFetch(pages);
  const impl: typeof fetchPage = async (url, deadline, maxBytes?: number) => {
    if (maxBytes !== undefined) seen.push(maxBytes);
    return inner.impl(url, deadline);
  };

  await crawl({
    requestedUrl: SITE,
    limits: { maxResponseBytes: 99_000 },
    fetchImpl: impl,
  });

  assert.deepEqual(seen, [99_000, 99_000, 99_000]);
});

// ---------------------------------------------------------------------------
// A failed sitemap must reach the crawl result, and must stay out of the report
//
// Two separate obligations, and the fix is only half done if either is missed.
// The crawl may not call itself whole when part of the site was never learned
// about. And a file we could not read is OUR gap, not a fault in the client's
// website, so it must never turn into something the client is told to fix.
// ---------------------------------------------------------------------------

/** A sitemap fetcher where robots.txt is fine and the sitemaps are not. */
function robotsAndUnreadableSitemaps(robotsTxt: string) {
  const impl: SitemapFetcher = async (url) =>
    url.endsWith("/robots.txt")
      ? { ok: true, body: robotsTxt }
      : { ok: false, reason: "unavailable" };
  return impl;
}

test("a crawl that drained the queue is NOT complete when a sitemap was unreadable", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAndUnreadableSitemaps("User-agent: *\nDisallow:"),
  });

  // The page crawl genuinely did finish, and still says so.
  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.evaluated, 2);

  // But a sitemap we could not read may have listed pages we never queued,
  // so the crawl as a whole cannot claim to have seen the site.
  assert.equal(summary.sitemapDiscovery.complete, false);
  assert.equal(summary.sitemapDiscovery.stoppedBecause, "unavailable");
  assert.equal(summary.complete, false);
});

test("an unreadable sitemap produces no finding and no failed page", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary, pages, attempts } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAndUnreadableSitemaps("User-agent: *\nDisallow:"),
  });

  // Nothing about the sitemap request appears among the pages we tried to
  // audit. It is not a broken page, and it is not the client's problem.
  assert.equal(pages.length, 2);
  assert.equal(attempts.length, 2);
  assert.equal(summary.unavailable.length, 0);
  assert.ok(attempts.every((a) => !a.url.includes("sitemap")));
});

test("a site with genuinely no sitemap IS a complete crawl", async () => {
  // The opposite direction. Nothing went wrong here: the site publishes no
  // sitemap, we established that, and every page it links to was visited.
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd(null).impl,
  });

  assert.equal(summary.sitemapDiscovery.complete, true);
  assert.equal(summary.sitemapDiscovery.stoppedBecause, "completed");
  assert.equal(summary.complete, true);
});

test("a sitemap that was read keeps the crawl complete", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo(),
    "https://example.com/b": linksTo(),
  });
  const sitemapXml =
    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    "<url><loc>https://example.com/b</loc></url></urlset>";

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("User-agent: *\nDisallow:", {
      "https://example.com/sitemap.xml": sitemapXml,
    }).impl,
  });

  assert.equal(summary.evaluated, 2, "the sitemap page was crawled");
  assert.equal(summary.sitemapDiscovery.complete, true);
  assert.equal(summary.complete, true);
});

test("an unreadable robots.txt leaves the crawl incomplete but unblocked", async () => {
  const fetcher = siteFetch({
    [SITE]: linksTo("/a"),
    "https://example.com/a": linksTo(),
  });
  const unreadable: SitemapFetcher = async () => ({ ok: false, reason: "unavailable" });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: unreadable,
  });

  // Unchanged: the crawl goes ahead, and does not pretend rules were applied.
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.robots.enforced, false);

  // New, and the point of the fix: it may have declared sitemaps we never
  // looked for, so the crawl is not whole.
  assert.equal(summary.sitemapDiscovery.complete, false);
  assert.equal(summary.complete, false);
});

test("a page-crawl limit is still reported as the page-crawl limit", async () => {
  // Sitemap state must not overwrite the frontier's own reason for stopping.
  const fetcher = siteFetch({
    [SITE]: linksTo("/a", "/b", "/c"),
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
    "https://example.com/c": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    limits: { maxPages: 2 },
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAndUnreadableSitemaps("User-agent: *\nDisallow:"),
  });

  assert.equal(summary.stoppedBecause, "max-pages");
  assert.equal(summary.sitemapDiscovery.stoppedBecause, "unavailable");
  assert.equal(summary.complete, false);
});

// ---------------------------------------------------------------------------
// A TEMPLATE PLACEHOLDER MUST NOT REACH THE CRAWL AT ALL
//
// Not discovered, not queued, not fetched, not counted, and above all not
// reported back to the client as a page of their site that could not be read.
// The extractor drops the element; this proves nothing downstream re-admits it.
// ---------------------------------------------------------------------------

test("a template placeholder is never discovered, queued, fetched or counted", async () => {
  const productListing = `<html><body>
    <a href="/shop">Shop</a>
    <template id="card">
      <a href="/product/{{id}}">name</a>
      <a href="/product/{{id}}/reviews">reviews</a>
    </template>
  </body></html>`;

  const fetcher = siteFetch({
    [SITE]: productListing,
    "https://example.com/shop": linksTo(),
  });

  const { summary, attempts } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemapFiles({}).impl,
  });

  // NOT FETCHED. The crawler asked for exactly the two real addresses.
  assert.deepEqual(fetcher.calls, [SITE, "https://example.com/shop"]);
  assert.ok(
    !fetcher.calls.some((url) => url.includes("product")),
    "no placeholder address was requested",
  );

  // NOT COUNTED. A browser finds one link here, and so does the crawl.
  assert.equal(summary.discovered, 2, "the entry page and /shop, nothing else");
  assert.equal(summary.evaluated, 2);

  // NOT REPORTED AS THE CLIENT'S BROKEN PAGE. This is the part that would have
  // put "{{id}}" in front of a prospect.
  assert.equal(summary.unavailable.length, 0);
  assert.ok(!attempts.some((a) => a.url.includes("product")));

  // And the crawl is honestly complete, rather than partial because of pages
  // that never existed.
  assert.equal(summary.complete, true);
  assert.equal(summary.stoppedBecause, "completed");
});

test("a template does not stop the real links around it being crawled", async () => {
  const fetcher = siteFetch({
    [SITE]: `<html><body><a href="/a">a</a>
      <template><a href="/ghost">g</a></template>
      <a href="/b">b</a></body></html>`,
    "https://example.com/a": linksTo(),
    "https://example.com/b": linksTo(),
  });

  const { summary } = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: sitemapFiles({}).impl,
  });

  assert.equal(summary.evaluated, 3, "entry, /a and /b");
  assert.ok(!fetcher.calls.some((url) => url.includes("ghost")));
});

test("template exclusion happens in the extractor, not by filtering addresses", () => {
  /*
   * A structural guard. Filtering placeholder-looking URLs later would mean
   * teaching the crawler to recognise `{{...}}` — a guess about what an
   * address means. Dropping the inert element is not a guess, and it has to
   * stay the mechanism.
   */
  const extractor = codeOf("./extractLinks.ts");
  const crawler = codeOf("./crawlSite.ts");

  assert.match(extractor, /\$\("template"\)\.remove\(\)/, "the extractor drops the element");
  assert.ok(!/\{\{|placeholder/i.test(crawler), "the crawler recognises no placeholder syntax");
});

// ---------------------------------------------------------------------------
// THE ONE ROBOTS.TXT MEASUREMENT LEAVES WITH THE CRAWL
//
// The site-file checks used to fetch this file for themselves. Two requests
// for one file can come back differently, and one report then carried both
// answers: "no robots.txt" beside "robots.txt could not be checked". The
// crawl now hands its measurement on, so these assert that what leaves is
// what was actually read.
// ---------------------------------------------------------------------------

test("the crawl hands on the robots.txt it actually read", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const rules = "User-agent: *\nDisallow: /admin/";

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd(rules).impl,
  });

  assert.deepEqual(result.robots, { status: "found", text: rules });
  assert.equal(
    result.summary.robots.status,
    "rules",
    "and the summary still reports in its own vocabulary",
  );
});

test("a robots.txt the server says is not there leaves as absent", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd(null).impl,
  });

  assert.deepEqual(result.robots, { status: "absent" });
});

test("a robots.txt that could not be read never leaves as absent", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });
  const unreachable: SitemapFetcher = async () => ({ ok: false, reason: "unavailable" });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: unreachable,
  });

  assert.deepEqual(result.robots, { status: "unavailable" });
  assert.notEqual(
    result.robots.status,
    "absent",
    "everything downstream reads this, and none of it may claim the file is missing",
  );
});

test("an empty robots.txt leaves as read, with the text it had", async () => {
  const fetcher = siteFetch({ [SITE]: linksTo() });

  const result = await crawlSite_({
    requestedUrl: SITE,
    fetchImpl: fetcher.impl,
    sitemapFetchImpl: robotsAnd("").impl,
  });

  assert.deepEqual(result.robots, { status: "found", text: "" });
});
