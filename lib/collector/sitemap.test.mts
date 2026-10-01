/**
 * Tests for sitemap discovery.
 *
 * Two halves. `parseSitemap` is pure and is tested exhaustively against the
 * shapes real sitemaps come in, including the broken ones. `discoverSitemapUrls`
 * walks a site's sitemaps with an injected fetcher, so no test here touches the
 * network, and the limits can be driven exactly rather than waited for.
 *
 * The thing being defended throughout: a sitemap is a file written by the site
 * being audited. It is a suggestion about where to look, never an instruction,
 * and never permission.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { createDeadline, type Deadline } from "./deadline.ts";
import {
  createSitemapFetcher,
  DEFAULT_SITEMAP_LIMITS,
  discoverSitemapUrls,
  findAllSitemapDirectives,
  parseSitemap,
  SITEMAP_DISCOVERY_SKIPPED,
  type SitemapFetchResult,
  type SitemapFetcher,
  type SitemapLimits,
  type SitemapStopReason,
} from "./sitemap.ts";

const SITE = new URL("https://example.com/");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${locs.map((l) => `<url><loc>${l}</loc><changefreq>daily</changefreq></url>`).join("")}
   </urlset>`;

const sitemapindex = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     ${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}
   </sitemapindex>`;

/** A fetcher backed by a map of address to body, recording what it was asked. */
function fileFetch(files: Record<string, string>) {
  const calls: string[] = [];
  const impl: SitemapFetcher = async (url) => {
    calls.push(url);
    const body = files[url];
    // A miss means the file is genuinely not there, which is a successful
    // measurement. Tests that need an unreadable file say so explicitly.
    return body === undefined ? { ok: false, reason: "absent" } : { ok: true, body };
  };
  return { impl, calls };
}

/** A site that genuinely publishes no robots.txt and no sitemap. */
const NOTHING: SitemapFetcher = async () => ({ ok: false, reason: "absent" });

const limits = (overrides: Partial<SitemapLimits> = {}): SitemapLimits => ({
  ...DEFAULT_SITEMAP_LIMITS,
  ...overrides,
});

const discoverFull = (fetchImpl: SitemapFetcher, overrides: Partial<SitemapLimits> = {}) =>
  discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(30_000),
    limits: overrides,
    fetchImpl,
  });

/** Just the addresses, for the many tests that do not care how it stopped. */
const discover = async (fetchImpl: SitemapFetcher, overrides: Partial<SitemapLimits> = {}) =>
  (await discoverFull(fetchImpl, overrides)).urls;

function sourceOf(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a normal sitemap yields its page addresses", () => {
  const parsed = parseSitemap(urlset("https://example.com/a", "https://example.com/b"), limits());

  assert.deepEqual(parsed.urls, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(parsed.sitemaps, []);
});

test("a sitemap index yields sitemap addresses, not page addresses", () => {
  // The distinction is the whole difference between the two formats. Reading
  // an index as a list of pages would crawl XML files as if they were pages.
  const parsed = parseSitemap(
    sitemapindex("https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"),
    limits(),
  );

  assert.deepEqual(parsed.urls, []);
  assert.deepEqual(parsed.sitemaps, [
    "https://example.com/sitemap-1.xml",
    "https://example.com/sitemap-2.xml",
  ]);
});

test("a <loc> is read by what contains it, not by the document's root element", () => {
  // A malformed file mixing both is read entry by entry rather than guessed at.
  const mixed = `<urlset>
      <url><loc>https://example.com/page</loc></url>
      <sitemap><loc>https://example.com/nested.xml</loc></sitemap>
    </urlset>`;

  const parsed = parseSitemap(mixed, limits());

  assert.deepEqual(parsed.urls, ["https://example.com/page"]);
  assert.deepEqual(parsed.sitemaps, ["https://example.com/nested.xml"]);
});

test("namespace prefixes are tolerated", () => {
  // Plenty of real sitemaps are written this way, and a parser that only knew
  // the unprefixed form would read them as empty.
  const prefixed = `<sitemap:urlset xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap:url><sitemap:loc>https://example.com/a</sitemap:loc></sitemap:url>
    </sitemap:urlset>`;

  assert.deepEqual(parseSitemap(prefixed, limits()).urls, ["https://example.com/a"]);
});

test("surrounding whitespace in a loc is trimmed", () => {
  const padded = `<urlset><url><loc>
      https://example.com/a
    </loc></url></urlset>`;

  assert.deepEqual(parseSitemap(padded, limits()).urls, ["https://example.com/a"]);
});

test("an empty loc names no address", () => {
  const empty = `<urlset><url><loc></loc></url><url><loc>   </loc></url></urlset>`;

  assert.deepEqual(parseSitemap(empty, limits()).urls, []);
});

test("an empty sitemap is not an error", () => {
  assert.deepEqual(parseSitemap(urlset(), limits()).urls, []);
  assert.deepEqual(parseSitemap("<urlset></urlset>", limits()).urls, []);
});

test("a malformed or non-XML document yields nothing rather than throwing", () => {
  for (const body of [
    "",
    "not xml at all",
    "<urlset><url><loc>https://example.com/a", // truncated mid-document
    "<html><body><h1>404 Not Found</h1></body></html>",
    '{"json":"instead"}',
    "<<<>>>",
  ]) {
    const parsed = parseSitemap(body, limits());
    assert.ok(Array.isArray(parsed.urls), body.slice(0, 20));
    assert.ok(Array.isArray(parsed.sitemaps), body.slice(0, 20));
  }
});

test("an HTML page that happens to contain the word loc yields nothing", () => {
  const html = "<html><body><p>See our loc pages</p><a href='/x'>x</a></body></html>";

  assert.deepEqual(parseSitemap(html, limits()).urls, []);
});

test("a truncated document still yields the entries it did contain", () => {
  const partial = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b`;

  // Forgiving on purpose: half a sitemap is still a list of real pages.
  assert.ok(parseSitemap(partial, limits()).urls.includes("https://example.com/a"));
});

test("parsing stops collecting page addresses at maxUrls", () => {
  const many = Array.from({ length: 50 }, (_, i) => `https://example.com/p${i}`);

  const parsed = parseSitemap(urlset(...many), limits({ maxUrls: 10 }));

  assert.equal(parsed.urls.length, 10);
  assert.equal(parsed.urls[0], "https://example.com/p0", "and it keeps the first, in order");
});

// ---------------------------------------------------------------------------
// robots.txt, read only for its signposts
// ---------------------------------------------------------------------------

test("every Sitemap: line is read, in order", () => {
  const robots = `User-agent: *
Disallow: /admin
Sitemap: https://example.com/sitemap-a.xml
Sitemap: https://example.com/sitemap-b.xml`;

  assert.deepEqual(findAllSitemapDirectives(robots), [
    "https://example.com/sitemap-a.xml",
    "https://example.com/sitemap-b.xml",
  ]);
});

test("the Sitemap: directive is matched however it is written", () => {
  assert.deepEqual(findAllSitemapDirectives("SITEMAP:https://example.com/s.xml"), [
    "https://example.com/s.xml",
  ]);
  assert.deepEqual(findAllSitemapDirectives("  sitemap  :   https://example.com/s.xml  "), [
    "https://example.com/s.xml",
  ]);
  assert.deepEqual(findAllSitemapDirectives("# Sitemap: https://example.com/s.xml"), []);
});

test("a robots.txt with no sitemap line yields none", () => {
  assert.deepEqual(findAllSitemapDirectives("User-agent: *\nDisallow: /"), []);
  assert.deepEqual(findAllSitemapDirectives(""), []);
});

// ---------------------------------------------------------------------------
// Walking a site's sitemaps
// ---------------------------------------------------------------------------

test("the conventional address is tried even with no robots.txt", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  const urls = await discover(fetcher.impl);

  assert.deepEqual(fetcher.calls, [
    "https://example.com/robots.txt",
    "https://example.com/sitemap.xml",
  ]);
  assert.deepEqual(urls, ["https://example.com/a"]);
});

test("sitemaps declared in robots.txt are followed", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt": "Sitemap: https://example.com/custom.xml",
    "https://example.com/custom.xml": urlset("https://example.com/a"),
  });

  const urls = await discover(fetcher.impl);

  assert.deepEqual(urls, ["https://example.com/a"]);
});

test("multiple declared sitemaps are all read", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt":
      "Sitemap: https://example.com/one.xml\nSitemap: https://example.com/two.xml",
    "https://example.com/one.xml": urlset("https://example.com/a"),
    "https://example.com/two.xml": urlset("https://example.com/b"),
    "https://example.com/sitemap.xml": urlset("https://example.com/c"),
  });

  const urls = await discover(fetcher.impl);

  assert.deepEqual(urls, [
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
});

test("a relative sitemap address in robots.txt resolves against the site", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt": "Sitemap: /maps/pages.xml",
    "https://example.com/maps/pages.xml": urlset("https://example.com/a"),
  });

  assert.deepEqual(await discover(fetcher.impl), ["https://example.com/a"]);
});

test("a sitemap index is followed one level down", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/posts.xml",
      "https://example.com/pages.xml",
    ),
    "https://example.com/posts.xml": urlset("https://example.com/post-1"),
    "https://example.com/pages.xml": urlset("https://example.com/about"),
  });

  assert.deepEqual(await discover(fetcher.impl), [
    "https://example.com/post-1",
    "https://example.com/about",
  ]);
});

test("a nested sitemap index is followed further down", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex("https://example.com/level-2.xml"),
    "https://example.com/level-2.xml": sitemapindex("https://example.com/level-3.xml"),
    "https://example.com/level-3.xml": urlset("https://example.com/deep"),
  });

  assert.deepEqual(await discover(fetcher.impl), ["https://example.com/deep"]);
});

test("a relative address inside a sitemap resolves against that sitemap", async () => {
  const fetcher = fileFetch({
    "https://example.com/maps/index.xml": sitemapindex("posts.xml"),
    "https://example.com/robots.txt": "Sitemap: /maps/index.xml",
    "https://example.com/maps/posts.xml": urlset("https://example.com/a"),
  });

  assert.deepEqual(await discover(fetcher.impl), ["https://example.com/a"]);
});

test("a sitemap that references itself is fetched once", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/sitemap.xml",
      "https://example.com/real.xml",
    ),
    "https://example.com/real.xml": urlset("https://example.com/a"),
  });

  const urls = await discover(fetcher.impl);

  const sitemapFetches = fetcher.calls.filter((c) => c === "https://example.com/sitemap.xml");
  assert.equal(sitemapFetches.length, 1, "a self-reference must not loop");
  assert.deepEqual(urls, ["https://example.com/a"]);
});

test("two sitemaps referencing each other terminate", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex("https://example.com/b.xml"),
    "https://example.com/b.xml": sitemapindex("https://example.com/sitemap.xml"),
  });

  const urls = await discover(fetcher.impl);

  assert.deepEqual(urls, []);
  assert.equal(fetcher.calls.length, 3, "robots, then each sitemap exactly once");
});

test("the same sitemap under equivalent addresses is fetched once", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt":
      "Sitemap: https://example.com/s.xml\nSitemap: https://www.example.com/s.xml",
    "https://example.com/s.xml": urlset("https://example.com/a"),
  });

  await discover(fetcher.impl);

  // www and apex are one site, so these are one file.
  assert.equal(fetcher.calls.filter((c) => c.includes("s.xml")).length, 1);
});

test("duplicate page addresses are returned as found, for the frontier to fold", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset(
      "https://example.com/a",
      "https://example.com/a",
      "https://example.com/a/",
    ),
  });

  // De-duplication belongs to the frontier, which compares canonical keys.
  assert.equal((await discover(fetcher.impl)).length, 3);
});

// ---------------------------------------------------------------------------
// Nothing here is a failure
// ---------------------------------------------------------------------------

test("a site with no sitemap at all yields nothing, quietly", async () => {
  const result = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(30_000),
    fetchImpl: NOTHING,
  });

  assert.deepEqual(result.urls, []);
  // Having looked and found nothing is a COMPLETE discovery. There is no
  // sitemap, so there is nothing left unread — quite different from having
  // run out of time before finding out.
  assert.deepEqual(result.discovery, {
    attempted: true,
    complete: true,
    stoppedBecause: "completed",
  });
});

test("a sitemap that fails to fetch is skipped, and the others still read", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt":
      "Sitemap: https://example.com/broken.xml\nSitemap: https://example.com/works.xml",
    "https://example.com/works.xml": urlset("https://example.com/a"),
  });

  assert.deepEqual(await discover(fetcher.impl), ["https://example.com/a"]);
});

test("a sitemap fetch that never answers ends discovery without failing", async () => {
  const slow: SitemapFetcher = async (_url, deadline) => {
    // Stands in for a request that consumed its whole budget.
    while (!deadline.expired()) return { ok: false };
    return { ok: false };
  };

  const result = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(30_000),
    fetchImpl: slow,
  });

  assert.deepEqual(result.urls, []);
});

test("discovery returns addresses only — never a finding of any shape", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  const urls = await discover(fetcher.impl);

  assert.ok(Array.isArray(urls));
  assert.ok(urls.every((u) => typeof u === "string"));
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("no more than maxFiles sitemaps are downloaded", async () => {
  const files: Record<string, string> = {
    "https://example.com/sitemap.xml": sitemapindex(
      ...Array.from({ length: 30 }, (_, i) => `https://example.com/s${i}.xml`),
    ),
  };
  for (let i = 0; i < 30; i += 1) {
    files[`https://example.com/s${i}.xml`] = urlset(`https://example.com/p${i}`);
  }

  const fetcher = fileFetch(files);
  const urls = await discover(fetcher.impl, { maxFiles: 5 });

  const xmlFetches = fetcher.calls.filter((c) => c.endsWith(".xml"));
  assert.equal(xmlFetches.length, 5);
  assert.equal(urls.length, 4, "the index itself was one of the five");
});

test("no more than maxUrls addresses are collected across all sitemaps", async () => {
  const files: Record<string, string> = {
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/a.xml",
      "https://example.com/b.xml",
    ),
    "https://example.com/a.xml": urlset(
      ...Array.from({ length: 10 }, (_, i) => `https://example.com/a${i}`),
    ),
    "https://example.com/b.xml": urlset(
      ...Array.from({ length: 10 }, (_, i) => `https://example.com/b${i}`),
    ),
  };

  const urls = await discover(fileFetch(files).impl, { maxUrls: 12 });

  assert.equal(urls.length, 12);
});

test("an expired clock stops discovery before it starts", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset("https://example.com/a"),
  });

  const result = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(0),
    fetchImpl: fetcher.impl,
  });

  assert.deepEqual(result.urls, []);
  assert.deepEqual(fetcher.calls, [], "not one request");
  assert.equal(result.discovery.complete, false);
  assert.equal(result.discovery.stoppedBecause, "deadline");
});

test("discovery takes a capped slice of the crawl's clock, not all of it", async () => {
  const budgets: number[] = [];
  const watching: SitemapFetcher = async (_url, deadline: Deadline) => {
    budgets.push(deadline.remainingMs());
    return { ok: false };
  };

  await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(300_000),
    fetchImpl: watching,
  });

  assert.ok(budgets.length > 0);
  assert.ok(
    budgets[0] <= DEFAULT_SITEMAP_LIMITS.budgetMs,
    `sitemaps must not be able to spend the whole crawl (got ${budgets[0]}ms)`,
  );
});

test("the crawl's own clock still wins when it is the shorter one", async () => {
  const budgets: number[] = [];
  const watching: SitemapFetcher = async (_url, deadline: Deadline) => {
    budgets.push(deadline.remainingMs());
    return { ok: false };
  };

  await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(3_000),
    fetchImpl: watching,
  });

  assert.ok(budgets[0] <= 3_000);
});

// ---------------------------------------------------------------------------
// Did discovery read everything, or did it stop short?
//
// The distinction the whole crawl's honesty rests on: a crawl that never
// learned about a section of a site must not report a whole-site audit.
// ---------------------------------------------------------------------------

test("draining every sitemap naturally is a COMPLETE discovery", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex("https://example.com/a.xml"),
    "https://example.com/a.xml": urlset("https://example.com/a", "https://example.com/b"),
  });

  const { discovery } = await discoverFull(fetcher.impl);

  assert.deepEqual(discovery, { attempted: true, complete: true, stoppedBecause: "completed" });
});

test("maxFiles leaves sitemaps unread, so discovery is INCOMPLETE", async () => {
  const files: Record<string, string> = {
    "https://example.com/sitemap.xml": sitemapindex(
      ...Array.from({ length: 10 }, (_, i) => `https://example.com/s${i}.xml`),
    ),
  };
  for (let i = 0; i < 10; i += 1) {
    files[`https://example.com/s${i}.xml`] = urlset(`https://example.com/p${i}`);
  }

  const { discovery } = await discoverFull(fileFetch(files).impl, { maxFiles: 3 });

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "max-files");
});

test("maxUrls leaves pages uncollected, so discovery is INCOMPLETE", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset(
      ...Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`),
    ),
  });

  const { discovery } = await discoverFull(fetcher.impl, { maxUrls: 5 });

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "max-urls");
});

test("a site with exactly maxUrls pages is complete, not truncated", async () => {
  // The exact-limit rule, the same one the page frontier follows: a bound only
  // counts as a stop when it actually left something behind.
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset(
      ...Array.from({ length: 5 }, (_, i) => `https://example.com/p${i}`),
    ),
  });

  const { urls, discovery } = await discoverFull(fetcher.impl, { maxUrls: 5 });

  assert.equal(urls.length, 5);
  assert.equal(discovery.complete, true, "every page it listed was collected");
  assert.equal(discovery.stoppedBecause, "completed");
});

test("running out of discovery's own budget is reported as the budget", async () => {
  // The crawl's clock is intact; discovery spent the slice it was given.
  let calls = 0;
  const slow: SitemapFetcher = async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, body: sitemapindex("https://example.com/a.xml") }
      : { ok: false };
  };

  const { discovery } = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(60_000),
    limits: { budgetMs: 0 },
    fetchImpl: slow,
  });

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "budget");
});

test("the surrounding clock running out is reported as the deadline", async () => {
  const { discovery } = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(0),
    fetchImpl: NOTHING,
  });

  // Not "budget": discovery did not use its slice, the crawl ran out.
  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "deadline");
});

test("a discovery that stopped short is never marked complete, whatever the reason", async () => {
  for (const reason of ["max-files", "max-urls", "budget", "deadline"] as const) {
    // Every stop reason other than "completed" must read as incomplete.
    assert.notEqual(reason, "completed");
  }

  const files: Record<string, string> = {
    "https://example.com/sitemap.xml": sitemapindex(
      "https://example.com/a.xml",
      "https://example.com/b.xml",
    ),
    "https://example.com/a.xml": urlset("https://example.com/a"),
    "https://example.com/b.xml": urlset("https://example.com/b"),
  };

  for (const overrides of [{ maxFiles: 2 }, { maxUrls: 1 }, { budgetMs: 0 }]) {
    const { discovery } = await discoverFull(fileFetch(files).impl, overrides);
    assert.equal(discovery.complete, false, JSON.stringify(overrides));
    assert.notEqual(discovery.stoppedBecause, "completed", JSON.stringify(overrides));
  }
});

test("a sitemap that failed to fetch does not make discovery incomplete", async () => {
  // We asked, and learned there was nothing readable there. That is an answer,
  // not an interruption — and it is not a fault of the site either.
  const fetcher = fileFetch({
    "https://example.com/robots.txt": "Sitemap: https://example.com/gone.xml",
  });

  const { discovery } = await discoverFull(fetcher.impl);

  assert.equal(discovery.complete, true);
  assert.equal(discovery.stoppedBecause, "completed");
});

test("the skipped state says it was never attempted", () => {
  assert.deepEqual(SITEMAP_DISCOVERY_SKIPPED, {
    attempted: false,
    // Vacuous: discovery that read nothing left nothing unread. `attempted`
    // is the field that says the site's own list was never consulted.
    complete: true,
    stoppedBecause: "completed",
  });
});

test("parsing reports when a file held more than it was allowed to keep", () => {
  const many = Array.from({ length: 20 }, (_, i) => `https://example.com/p${i}`);

  assert.equal(parseSitemap(urlset(...many), limits({ maxUrls: 5 })).truncated, true);
  assert.equal(parseSitemap(urlset(...many), limits({ maxUrls: 20 })).truncated, false);
  assert.equal(parseSitemap(urlset(), limits()).truncated, false);
});

test("the default bounds are the intended ones", () => {
  assert.deepEqual(DEFAULT_SITEMAP_LIMITS, {
    maxFiles: 20,
    maxUrls: 10_000,
    maxBytes: 5_000_000,
    budgetMs: 20_000,
  });
});

// ---------------------------------------------------------------------------
// A sitemap is never permission
// ---------------------------------------------------------------------------

test("a sitemap on another domain is never fetched", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt":
      "Sitemap: https://evil.test/sitemap.xml\nSitemap: https://cdn.example.com/sitemap.xml",
    "https://evil.test/sitemap.xml": urlset("https://evil.test/a"),
  });

  await discover(fetcher.impl);

  for (const called of fetcher.calls) {
    assert.ok(called.startsWith("https://example.com/"), `must not fetch ${called}`);
  }
});

test("a nested index pointing off-site is refused too", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex(
      "https://evil.test/nested.xml",
      "http://127.0.0.1/nested.xml",
      "http://169.254.169.254/nested.xml",
    ),
  });

  await discover(fetcher.impl);

  for (const called of fetcher.calls) {
    assert.ok(called.startsWith("https://example.com/"), `must not fetch ${called}`);
  }
});

test("a sitemap at an unsafe scheme is never fetched", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt":
      "Sitemap: file:///etc/passwd\nSitemap: javascript:alert(1)\nSitemap: ftp://example.com/s.xml",
  });

  await discover(fetcher.impl);

  assert.deepEqual(fetcher.calls, [
    "https://example.com/robots.txt",
    "https://example.com/sitemap.xml",
  ]);
});

test("a non-default port in a sitemap reference is a different site", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": sitemapindex("https://example.com:8080/staging.xml"),
  });

  await discover(fetcher.impl);

  assert.ok(!fetcher.calls.some((c) => c.includes(":8080")));
});

test("www and apex sitemap references are both accepted", async () => {
  const fetcher = fileFetch({
    "https://example.com/robots.txt": "Sitemap: https://www.example.com/w.xml",
    "https://www.example.com/w.xml": urlset("https://example.com/a"),
  });

  assert.deepEqual(await discover(fetcher.impl), ["https://example.com/a"]);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("sitemap fetching goes through safeFetch and nothing else", () => {
  const code = codeOf("./sitemap.ts");

  // safeFetch is the existing per-hop-checked boundary. The only literal
  // `fetch(` in this file must be the one inside safeFetch's own module.
  assert.ok(/safeFetch\(/.test(code), "requests go through safeFetch");
  assert.ok(!/[^e]\bfetch\s*\(\s*(url|current|address)/.test(code), "no raw fetch of a URL");
  assert.ok(!/\bXMLHttpRequest\b/.test(code));
  assert.ok(!/from\s+["']node:https?["']/.test(code));
});

test("the SSRF check is not reimplemented for sitemaps", () => {
  const code = codeOf("./sitemap.ts");

  assert.ok(!/isPublicAddress|checkHostnameIsPublic|isPrivateIPv/.test(code));
});

test("sitemap discovery imports only existing modules", () => {
  const imports = [...sourceOf("./sitemap.ts").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (m) => m[1],
  );

  assert.deepEqual(imports.sort(), ["./crawlUrl.ts", "./deadline.ts", "./safety.ts", "cheerio"]);
});

test("no HTTP or XML dependency was introduced", () => {
  const pkg = JSON.parse(sourceOf("../../package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const banned of [
    "crawlee",
    "axios",
    "got",
    "node-fetch",
    "undici",
    /*
     * `puppeteer` was on this list until Phase 7C-1, when the PDF renderer
     * was built on it. The ban existed to stop the CRAWLER fetching pages
     * through a browser -- headless Chromium runs the site's JavaScript,
     * which would change what the audit measures and would make every crawled
     * page cost a browser. That property is unchanged and is now asserted
     * where it belongs: the import walk below, and a matching walk in
     * lib/audit/pdf proving nothing outside the renderer reaches it.
     *
     * `playwright` stays banned. Nothing here has a use for a second browser.
     */
    "playwright",
    "sitemapper",
    "xml2js",
    "fast-xml-parser",
    "sax",
    "xmldom",
    "@xmldom/xmldom",
  ]) {
    assert.equal(all[banned], undefined, `${banned} must not be a dependency`);
  }

  /*
   * The whole list, so a NEW dependency has to be argued for here rather than
   * appearing quietly. `@google/genai` was argued for and added in Phase 5D:
   * it is the AI provider's own SDK, it is imported only by `lib/ai/gemini`,
   * and a test in that folder walks the tree to prove nothing else reaches it.
   * Sitemap reading never sees it, which is the property this guard protects.
   * `puppeteer` was argued for the same way in Phase 7C-1: it draws the PDF
   * report, it is imported only by `lib/audit/pdf`, and a test in that folder
   * walks the tree to prove nothing else reaches it.
   * `pg` was argued for and added when the single env-var login was replaced
   * with database-backed user accounts: it is the PostgreSQL driver, imported
   * only by `lib/db`, and a test there walks the tree to prove nothing else
   * reaches it. Sitemap reading never sees it, which is what this guards.
   */
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "@google/genai",
    "cheerio",
    "next",
    "pg",
    "puppeteer",
    "react",
    "react-dom",
  ]);
});

test("robots.txt is read for signposts, never for rules", () => {
  const code = codeOf("./sitemap.ts");

  assert.ok(!/[Dd]isallow/.test(code), "Disallow enforcement is a later stage");
  assert.ok(!/\bAllow\s*[:=]/.test(code));
});

// ---------------------------------------------------------------------------
// The result is raw, for the frontier to judge
// ---------------------------------------------------------------------------

test("addresses come back exactly as the sitemap wrote them", async () => {
  const fetcher = fileFetch({
    "https://example.com/sitemap.xml": urlset(
      "https://example.com/a?utm_source=news#frag",
      "https://evil.test/off-site",
      "not-a-url",
    ),
  });

  const urls = await discover(fetcher.impl);

  // Nothing is normalised, filtered or judged here: the caller puts every one
  // through the same frontier gate a link in the page body goes through, so a
  // sitemap gets no privilege a link lacks.
  assert.deepEqual(urls, [
    "https://example.com/a?utm_source=news#frag",
    "https://evil.test/off-site",
    "not-a-url",
  ]);
});

test("a fetch result carries a body or nothing, never a reason to report", () => {
  const ok: SitemapFetchResult = { ok: true, body: "<urlset/>" };
  const no: SitemapFetchResult = { ok: false };

  assert.deepEqual(Object.keys(ok).sort(), ["body", "ok"]);
  assert.deepEqual(Object.keys(no), ["ok"]);
});

// ---------------------------------------------------------------------------
// What each kind of failed request MEANS
//
// The fetcher is the only place that turns an HTTP answer into one of two very
// different statements:
//
//   absent      the server told us there is no such file. We looked, we know.
//   unavailable something went wrong. The file may exist and we cannot say
//               what is in it.
//
// `fetch` is replaced with a stand-in and the host is a public IP literal, so
// these tests contact nothing and need no DNS.
// ---------------------------------------------------------------------------

const HOST = "https://93.184.216.34";
const SITEMAP = `${HOST}/sitemap.xml`;
const realFetch = globalThis.fetch;

/** Runs `body` with `fetch` answering through `reply`, then puts it back. */
async function withFetch<T>(
  reply: (url: string) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    reply(String(input))) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Fetches one sitemap through the real production fetcher. */
async function fetchSitemap(
  reply: (url: string) => Promise<Response>,
  options: { maxBytes?: number; budgetMs?: number } = {},
): Promise<SitemapFetchResult> {
  const fetcher = createSitemapFetcher(options.maxBytes ?? 10_000_000);
  return withFetch(reply, () =>
    fetcher(SITEMAP, createDeadline(options.budgetMs ?? 30_000)),
  );
}

const answering = (status: number, body = "", headers: Record<string, string> = {}) =>
  async () => new Response(body, { status, headers });

test("a sitemap that is served is read", async () => {
  const xml = urlset("https://example.com/a");
  const result = await fetchSitemap(answering(200, xml, { "content-type": "application/xml" }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.body, xml);
});

test("404 and 410 mean the sitemap is ABSENT, which is knowledge", async () => {
  for (const status of [404, 410]) {
    const result = await fetchSitemap(answering(status));
    assert.deepEqual(result, { ok: false, reason: "absent" }, `status ${status}`);
  }
});

test("a server that answers with HTML has no sitemap there", async () => {
  // Many sites serve their homepage for any address they do not recognise.
  // That is the same statement as a 404, and it is a measurement.
  const result = await fetchSitemap(
    answering(200, "<!doctype html><title>Home</title>", { "content-type": "text/html" }),
  );

  assert.deepEqual(result, { ok: false, reason: "absent" });
});

test("refusals and server faults mean UNAVAILABLE, not absent", async () => {
  // Every one of these is a file that may well exist and that we did not read.
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    const result = await fetchSitemap(answering(status));
    assert.deepEqual(result, { ok: false, reason: "unavailable" }, `status ${status}`);
  }
});

test("a request that never completes is UNAVAILABLE", async () => {
  const result = await fetchSitemap(async () => {
    throw new DOMException("The operation was aborted.", "TimeoutError");
  });

  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("a refused connection is UNAVAILABLE", async () => {
  const result = await fetchSitemap(async () => {
    throw new TypeError("fetch failed");
  });

  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("a sitemap too large to read is UNAVAILABLE", async () => {
  // We stopped reading partway. What the rest of the file listed is unknown,
  // and a half-read sitemap must never pass for a complete one.
  const result = await fetchSitemap(
    answering(200, "x".repeat(5_000), { "content-type": "application/xml" }),
    { maxBytes: 100 },
  );

  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("a redirect chain that never lands is UNAVAILABLE", async () => {
  const result = await fetchSitemap(
    async () =>
      new Response("", { status: 302, headers: { location: `${HOST}/next.xml` } }),
  );

  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("no time left to look is UNAVAILABLE, never absent", async () => {
  // The most tempting shortcut in the file, and the most dishonest: never
  // having made the request tells us nothing whatever about the sitemap.
  let requested = false;
  const result = await fetchSitemap(
    async () => {
      requested = true;
      return new Response("", { status: 200 });
    },
    { budgetMs: 0 },
  );

  assert.equal(requested, false, "no request should be made");
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

// ---------------------------------------------------------------------------
// A sitemap we could not read is not a finished discovery
//
// The bug this fixes: any failed sitemap fetch was skipped over, so a timeout
// on one of a site's sitemaps still ended the walk as "completed". There may
// be a whole section of the site listed inside the file we failed to read.
//
// The opposite direction matters just as much. A site that genuinely has NO
// sitemap has been successfully examined, and must not be reported as one we
// failed to examine.
// ---------------------------------------------------------------------------

/** A fetcher whose answers are stated outright, failure reasons included. */
function statedFetch(answers: Record<string, SitemapFetchResult>): SitemapFetcher {
  return async (url) => answers[url] ?? { ok: false, reason: "absent" };
}

const NO_ROBOTS = { status: "absent" } as const;

type RobotsInput = Parameters<typeof discoverSitemapUrls>[0]["robots"];

const discoverWith = (fetchImpl: SitemapFetcher, robots: RobotsInput = NO_ROBOTS) =>
  discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(30_000),
    fetchImpl,
    robots,
  });

// --- what an unreadable sitemap does to the result -------------------------

test("an unreadable sitemap makes discovery INCOMPLETE", async () => {
  const { discovery } = await discoverWith(
    statedFetch({ "https://example.com/sitemap.xml": { ok: false, reason: "unavailable" } }),
  );

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "unavailable");
});

test("a failure with no stated reason counts as unavailable, not absent", async () => {
  // "We do not know" is the honest reading of an unexplained failure, and it
  // is the reading that refuses to claim a finished discovery.
  const { discovery } = await discoverWith(
    statedFetch({ "https://example.com/sitemap.xml": { ok: false } }),
  );

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "unavailable");
});

// --- the opposite direction ------------------------------------------------

test("a site that genuinely has NO sitemap is a COMPLETE discovery", async () => {
  // The server told us. We looked, we established there is nothing, and that
  // is a finished piece of work rather than a failure to examine the site.
  const { urls, discovery } = await discoverWith(
    statedFetch({ "https://example.com/sitemap.xml": { ok: false, reason: "absent" } }),
  );

  assert.deepEqual(urls, []);
  assert.equal(discovery.complete, true);
  assert.equal(discovery.stoppedBecause, "completed");
});

test("an absent sitemap never drifts into unavailable", async () => {
  const { discovery } = await discoverWith(NOTHING);

  assert.notEqual(discovery.stoppedBecause, "unavailable");
  assert.equal(discovery.complete, true);
});

test("a sitemap that IS read never drifts into incomplete", async () => {
  const { urls, discovery } = await discoverWith(
    statedFetch({
      "https://example.com/sitemap.xml": {
        ok: true,
        body: urlset("https://example.com/a", "https://example.com/b"),
      },
    }),
  );

  assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(discovery.complete, true);
  assert.equal(discovery.stoppedBecause, "completed");
});

// --- mixtures --------------------------------------------------------------

test("read alongside ABSENT is still complete", async () => {
  const { urls, discovery } = await discoverWith(
    statedFetch({
      "https://example.com/a.xml": { ok: true, body: urlset("https://example.com/a") },
      "https://example.com/gone.xml": { ok: false, reason: "absent" },
    }),
    {
      status: "found",
      text: "Sitemap: https://example.com/a.xml\nSitemap: https://example.com/gone.xml",
    },
  );

  // Every piece of work resolved: one file read, one confirmed missing.
  assert.deepEqual(urls, ["https://example.com/a"]);
  assert.equal(discovery.complete, true);
});

test("read alongside UNAVAILABLE is incomplete, and still returns what it read", async () => {
  const { urls, discovery } = await discoverWith(
    statedFetch({
      "https://example.com/a.xml": { ok: true, body: urlset("https://example.com/a") },
      "https://example.com/down.xml": { ok: false, reason: "unavailable" },
    }),
    {
      status: "found",
      text: "Sitemap: https://example.com/a.xml\nSitemap: https://example.com/down.xml",
    },
  );

  // The walk carries on, because what the other sitemaps hold is still worth
  // having. Only the claim of completeness is withdrawn.
  assert.deepEqual(urls, ["https://example.com/a"]);
  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "unavailable");
});

test("an index whose CHILD is unavailable is incomplete", async () => {
  const { urls, discovery } = await discoverWith(
    statedFetch({
      "https://example.com/sitemap.xml": {
        ok: true,
        body: sitemapindex("https://example.com/a.xml", "https://example.com/b.xml"),
      },
      "https://example.com/a.xml": { ok: true, body: urlset("https://example.com/a") },
      "https://example.com/b.xml": { ok: false, reason: "unavailable" },
    }),
  );

  assert.deepEqual(urls, ["https://example.com/a"], "a.xml was still read");
  assert.equal(discovery.complete, false, "b.xml may list a section we never saw");
  assert.equal(discovery.stoppedBecause, "unavailable");
});

test("an index whose child is genuinely ABSENT is still complete", async () => {
  const { discovery } = await discoverWith(
    statedFetch({
      "https://example.com/sitemap.xml": {
        ok: true,
        body: sitemapindex("https://example.com/a.xml", "https://example.com/gone.xml"),
      },
      "https://example.com/a.xml": { ok: true, body: urlset("https://example.com/a") },
      "https://example.com/gone.xml": { ok: false, reason: "absent" },
    }),
  );

  assert.equal(discovery.complete, true);
});

// --- robots.txt, which is where the sitemap addresses come from ------------

test("an UNREADABLE robots.txt makes discovery incomplete", async () => {
  /*
   * It may have declared sitemaps we will now never look for. The crawl itself
   * is not blocked — that is robots enforcement's business, and unchanged —
   * but discovery cannot claim to have found everything the site publishes.
   */
  const { discovery } = await discoverWith(NOTHING, { status: "unavailable" });

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "unavailable");
});

test("a robots.txt that genuinely does not exist keeps discovery complete", async () => {
  // It declared nothing because there was nothing to declare with.
  const { discovery } = await discoverWith(NOTHING, { status: "absent" });

  assert.equal(discovery.complete, true);
});

test("a readable robots.txt naming an unavailable sitemap is incomplete", async () => {
  const { discovery } = await discoverWith(
    statedFetch({ "https://example.com/named.xml": { ok: false, reason: "unavailable" } }),
    { status: "found", text: "Sitemap: https://example.com/named.xml" },
  );

  assert.equal(discovery.complete, false);
  assert.equal(discovery.stoppedBecause, "unavailable");
});

test("a readable robots.txt naming no sitemap keeps discovery complete", async () => {
  const { discovery } = await discoverWith(NOTHING, {
    status: "found",
    text: "User-agent: *\nDisallow: /admin",
  });

  assert.equal(discovery.complete, true);
});

// --- which reason gets reported --------------------------------------------

test("a limit that actually halted the walk still names itself", async () => {
  // Both readings mean incomplete, so no truth is lost either way. This only
  // decides which reason is the more useful one to show.
  const children = Array.from({ length: 10 }, (_, i) => `https://example.com/s${i}.xml`);
  const answers: Record<string, SitemapFetchResult> = {
    "https://example.com/sitemap.xml": { ok: true, body: sitemapindex(...children) },
  };
  children.forEach((url, i) => {
    answers[url] = i === 0 ? { ok: false, reason: "unavailable" } : { ok: true, body: urlset() };
  });

  const { discovery } = await discoverSitemapUrls({
    site: SITE,
    deadline: createDeadline(30_000),
    limits: { maxFiles: 3 },
    fetchImpl: statedFetch(answers),
    robots: NO_ROBOTS,
  });

  assert.equal(discovery.stoppedBecause, "max-files");
  assert.equal(discovery.complete, false);
});

test("only a completed walk is ever called complete", async () => {
  const cases: Array<[SitemapStopReason, SitemapFetcher]> = [
    ["completed", NOTHING],
    [
      "unavailable",
      statedFetch({ "https://example.com/sitemap.xml": { ok: false, reason: "unavailable" } }),
    ],
  ];

  for (const [expected, fetchImpl] of cases) {
    const { discovery } = await discoverWith(fetchImpl);
    assert.equal(discovery.stoppedBecause, expected);
    assert.equal(discovery.complete, expected === "completed", expected);
  }
});
