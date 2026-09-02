/**
 * Tests for robots.txt parsing.
 *
 * Getting this wrong matters in both directions: saying a site blocks all
 * search engines when it doesn't would put a false critical claim in a
 * client-facing report, and missing a real block would hide a costly problem.
 *
 * Run with:  npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  blocksEveryCrawler,
  findSitemapDirective,
  runTechnicalChecks,
} from "./technicalChecks.ts";

test("detects a site blocking all crawlers", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /"), true);
});

test("an empty Disallow means nothing is blocked", () => {
  // "Disallow:" with no value is the standard way to say "allow everything".
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow:"), false);
});

test("blocking one folder is not blocking the site", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /admin/"), false);
});

test("a block aimed at one named crawler does not count", () => {
  // Blocking a single bot is normal and deliberate; it does not mean the site
  // is hidden from search engines.
  assert.equal(blocksEveryCrawler("User-agent: BadBot\nDisallow: /"), false);
});

test("consecutive User-agent lines share the rules that follow", () => {
  // This blocks everyone, including *. Treating each User-agent line as a
  // fresh group would miss it entirely.
  const robots = "User-agent: *\nUser-agent: Googlebot\nDisallow: /";
  assert.equal(blocksEveryCrawler(robots), true);
});

test("an Allow rule means the site is not entirely blocked", () => {
  const robots = "User-agent: *\nDisallow: /\nAllow: /public/";
  assert.equal(blocksEveryCrawler(robots), false);
});

test("rules for a named bot do not leak into the wildcard group", () => {
  const robots = "User-agent: *\nDisallow: /admin/\n\nUser-agent: BadBot\nDisallow: /";
  assert.equal(blocksEveryCrawler(robots), false);
});

test("ignores comments and odd spacing", () => {
  const robots = "# our robots file\n  User-agent :  *  \n  Disallow :  /   # everything\n";
  assert.equal(blocksEveryCrawler(robots), true);
});

test("handles an empty file", () => {
  assert.equal(blocksEveryCrawler(""), false);
});

test("finds a Sitemap directive", () => {
  const robots = "User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap.xml";
  assert.equal(findSitemapDirective(robots), "https://example.com/sitemap.xml");
});

test("finds a Sitemap directive regardless of case", () => {
  assert.equal(
    findSitemapDirective("SITEMAP: https://example.com/s.xml"),
    "https://example.com/s.xml",
  );
});

test("returns null when there is no Sitemap line", () => {
  assert.equal(findSitemapDirective("User-agent: *\nDisallow:"), null);
});

// ---------------------------------------------------------------------------
// The shared time budget
//
// Every request the technical checks make shares ONE clock. Before this, each
// got its own timeout, so a slow sitemap could spend a full timeout on HEAD
// and another on the GET fallback, on top of whatever robots.txt had used —
// which is how a single audit reached twenty seconds on a real site.
//
// `fetch` is replaced with a stand-in and the host is a public IP literal, so
// these tests contact nothing and need no DNS.
// ---------------------------------------------------------------------------

const PAGE = "https://93.184.216.34/";
const realFetch = globalThis.fetch;

/** Every request made, in order: "METHOD url". */
let requests: string[] = [];

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Installs a stand-in fetch that records requests and answers via `reply`. */
function mockFetch(
  reply: (method: string, url: string, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = input.toString();
    requests.push(`${method} ${url}`);
    return reply(method, url, init);
  }) as typeof fetch;
}

/** A request that never answers until the shared deadline aborts it. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    const fail = () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      reject(error);
    };
    if (!signal) return;
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail);
  });
}

const notFound = async () => new Response("", { status: 404 });
const xml = (status = 200) =>
  new Response("<urlset/>", { status, headers: { "content-type": "application/xml" } });

function sitemapRequests(): string[] {
  return requests.filter((r) => r.includes("/sitemap.xml"));
}

test("all requests together stay inside ONE shared budget", async () => {
  // Both robots.txt and sitemap.xml hang. With a per-request timeout this
  // would take two full budgets; with a shared one it takes a little over one.
  mockFetch((_method, _url, init) => hangUntilAborted(init));

  const budget = 300;
  const startedAt = Date.now();
  const result = await runTechnicalChecks(PAGE, budget);
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < budget * 1.8,
    `two hanging requests took ${elapsed}ms; a shared ${budget}ms budget should not be spent twice`,
  );
  // Nothing was learned, and nothing is invented.
  assert.equal(result.robotsTxtFound, false);
  assert.equal(result.sitemapUrl, null);
});

test("a timed-out HEAD does NOT trigger the GET fallback", async () => {
  // This doubling is what made a single audit take twenty seconds.
  mockFetch(async (_method, url, init) => {
    if (url.endsWith("/robots.txt")) return notFound();
    return hangUntilAborted(init);
  });

  await runTechnicalChecks(PAGE, 200);

  const made = sitemapRequests();
  assert.equal(made.length, 1, `expected only the HEAD, got: ${made.join(", ")}`);
  assert.ok(made[0].startsWith("HEAD"), "the single request should be the HEAD");
});

test("a 405 from the server DOES still trigger the GET fallback", async () => {
  // 405 means the server answered and said it does not support HEAD, which is
  // a real reason to ask again properly.
  mockFetch(async (method, url) => {
    if (url.endsWith("/robots.txt")) return notFound();
    return method === "HEAD" ? new Response("", { status: 405 }) : xml();
  });

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.deepEqual(sitemapRequests(), [
    `HEAD ${PAGE}sitemap.xml`,
    `GET ${PAGE}sitemap.xml`,
  ]);
  assert.equal(result.sitemapUrl, `${PAGE}sitemap.xml`);
});

test("a 501 from the server also triggers the GET fallback", async () => {
  mockFetch(async (method, url) => {
    if (url.endsWith("/robots.txt")) return notFound();
    return method === "HEAD" ? new Response("", { status: 501 }) : xml();
  });

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(sitemapRequests().length, 2);
  assert.equal(result.sitemapUrl, `${PAGE}sitemap.xml`);
});

test("an ordinary 404 on HEAD does not trigger a pointless GET", async () => {
  mockFetch(notFound);

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(sitemapRequests().length, 1);
  assert.equal(result.sitemapUrl, null);
});

test("a successful HEAD does not trigger a GET either", async () => {
  mockFetch(async (_method, url) => (url.endsWith("/robots.txt") ? notFound() : xml()));

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(sitemapRequests().length, 1);
  assert.equal(result.sitemapUrl, `${PAGE}sitemap.xml`);
});

test("normal robots.txt and sitemap checks still work", async () => {
  mockFetch(async (_method, url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response(
        "User-agent: *\nDisallow: /admin/\nSitemap: https://93.184.216.34/sm.xml",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    return notFound();
  });

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.robotsTxtFound, true);
  assert.equal(result.robotsBlocksEverything, false);
  assert.equal(result.sitemapUrl, "https://93.184.216.34/sm.xml");
  // A sitemap named in robots.txt means the conventional location is not tried.
  assert.equal(sitemapRequests().length, 0);
});

test("a site blocking all crawlers is still detected", async () => {
  mockFetch(async (_method, url) => {
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nDisallow: /", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return notFound();
  });

  const result = await runTechnicalChecks(PAGE, 5_000);
  assert.equal(result.robotsBlocksEverything, true);
});

test("a slow robots.txt leaves less time for the sitemap, not a fresh budget", async () => {
  // The point of a shared clock: time spent early is time no longer available.
  mockFetch(async (_method, url, init) => {
    if (url.endsWith("/robots.txt")) return hangUntilAborted(init);
    return xml();
  });

  const budget = 250;
  const startedAt = Date.now();
  await runTechnicalChecks(PAGE, budget);
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < budget * 1.8,
    `robots.txt consumed the budget, so the run should end near ${budget}ms; took ${elapsed}ms`,
  );
});

test("no request is made at all once the budget is already gone", async () => {
  mockFetch(async () => xml());
  // A budget of zero is already expired before the first request.
  const result = await runTechnicalChecks(PAGE, 0);

  assert.equal(requests.length, 0, "nothing should have been requested");
  assert.equal(result.robotsTxtFound, false);
  assert.equal(result.sitemapUrl, null);
});
