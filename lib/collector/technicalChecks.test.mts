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
  runTechnicalChecks as runTechnicalChecksImpl,
} from "./technicalChecks.ts";
import { createDeadline, type Deadline } from "./deadline.ts";
import { fetchRobots, parseRobots, robotsMeasurement } from "./robots.ts";
import type { TechnicalData } from "@/lib/types";
import { keepAliveWhile } from "../keepAlive.fixture.mts";
import fs from "node:fs";

/** Hanging-request tests whose deadline is a few hundred milliseconds. */
const QUICK_LIMIT = { timeout: 5_000 };
/** The one test that waits out the checks' own ~10 s budget (it asserts < 12 s). */
const OWN_BUDGET_LIMIT = { timeout: 20_000 };
/** Longer than the largest limit above, so a test timeout reports a genuine hang. */
const HANG_HOLD_MS = 21_000;

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
  // Held open while it hangs: the deadline's AbortSignal.timeout is unreferenced.
  return keepAliveWhile(new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    const fail = () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      reject(error);
    };
    if (!signal) return;
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail);
  }), HANG_HOLD_MS);
}

const notFound = async () => new Response("", { status: 404 });
const xml = (status = 200) =>
  new Response("<urlset/>", { status, headers: { "content-type": "application/xml" } });

function sitemapRequests(): string[] {
  return requests.filter((r) => r.includes("/sitemap.xml"));
}


/**
 * The technical checks as the AUDIT runs them.
 *
 * This module no longer fetches robots.txt. The crawler reads it once, before
 * anything is queued, and hands the measurement on -- which is what stops one
 * audit holding two answers about the same file. These tests drive that same
 * pair on one shared clock, so every state asserted below is a state
 * production actually produces, and the classification of a 404, a 5xx or a
 * timeout is exercised where it now lives.
 */
async function runTechnicalChecks(
  pageUrl: string,
  budget: number | Deadline = 10_000,
): Promise<TechnicalData> {
  const deadline = typeof budget === "number" ? createDeadline(budget) : budget;
  const robots = robotsMeasurement(await fetchRobots({ site: new URL(pageUrl), deadline }));
  return runTechnicalChecksImpl(pageUrl, robots, deadline);
}

test("all requests together stay inside ONE shared budget", QUICK_LIMIT, async () => {
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
  // Nothing was learned, and nothing is invented. "unavailable", NOT
  // "absent": a request that hung tells us nothing about the client site.
  assert.equal(result.robotsTxtStatus, "unavailable");
  assert.equal(result.sitemapStatus, "unavailable");
  assert.equal(result.sitemapUrl, null);
});

test("a timed-out HEAD does NOT trigger the GET fallback", QUICK_LIMIT, async () => {
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

  assert.equal(result.robotsTxtStatus, "found");
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

test("a slow robots.txt leaves less time for the sitemap, not a fresh budget", QUICK_LIMIT, async () => {
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

test("given the audit's clock, the checks still keep their OWN budget", OWN_BUDGET_LIMIT, async () => {
  // Handing these checks the audit's deadline must not let them use all the
  // time the page fetch did not. Their ten-second limit still applies.
  mockFetch(async (_method, _url, init) => hangUntilAborted(init));

  // An audit deadline far larger than the technical checks' own budget.
  const auditDeadline = createDeadline(30_000);
  const startedAt = Date.now();
  /*
   * The module directly, not the audit pair above.
   *
   * This test is about THIS module's own budget. Reading robots.txt is no
   * longer part of it -- the crawler does that, on the crawl's clock -- so
   * measuring the pair would time two budgets and answer a different question.
   */
  await runTechnicalChecksImpl(PAGE, { status: "absent" }, auditDeadline);
  const elapsed = Date.now() - startedAt;

  assert.ok(
    elapsed < 12_000,
    `the checks should stop at their own ~10s budget, not run for the audit's 30s; took ${elapsed}ms`,
  );
  assert.ok(auditDeadline.remainingMs() > 15_000, "the audit should still have time left");
});

test("the checks stop early when the audit's clock runs out first", QUICK_LIMIT, async () => {
  mockFetch(async (_method, _url, init) => hangUntilAborted(init));

  const nearlySpent = createDeadline(150);
  const startedAt = Date.now();
  await runTechnicalChecks(PAGE, nearlySpent);

  assert.ok(
    Date.now() - startedAt < 600,
    "should follow the audit's shorter clock, not its own longer one",
  );
});

test("no request is made at all once the budget is already gone", async () => {
  mockFetch(async () => xml());
  // A budget of zero is already expired before the first request.
  const result = await runTechnicalChecks(PAGE, 0);

  assert.equal(requests.length, 0, "nothing should have been requested");
  // We never looked, so we may not claim the files are missing.
  assert.equal(result.robotsTxtStatus, "unavailable");
  assert.equal(result.sitemapStatus, "unavailable");
  assert.equal(result.sitemapUrl, null);
});

// ---------------------------------------------------------------------------
// Three states, not two
//
// A boolean could only say "found" or "not found", so a request that timed out
// was recorded as the client having no robots.txt — reporting a file as absent
// from somebody's website on the strength of our own failed request.
//
// Only the SERVER saying so makes a file absent. Everything else is
// "unavailable", which says nothing about the website at all.
// ---------------------------------------------------------------------------

const robotsText = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

/** Answers robots.txt with `reply`; everything else 404s. */
function robotsReplies(reply: () => Promise<Response>) {
  mockFetch(async (_method, url, init) => {
    if (url.includes("/robots.txt")) return reply();
    void init;
    return notFound();
  });
}

test("a readable robots.txt is FOUND", async () => {
  robotsReplies(async () => robotsText("User-agent: *\nDisallow: /admin/"));

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.robotsTxtStatus, "found");
  assert.equal(result.robotsBlocksEverything, false);
});

test("a 404 is ABSENT — the server told us", async () => {
  robotsReplies(async () => new Response("", { status: 404 }));

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "absent");
});

test("a 410 is ABSENT — the server told us it is gone", async () => {
  robotsReplies(async () => new Response("", { status: 410 }));

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "absent");
});

test("a 5xx is UNAVAILABLE — the server has one and would not show us", async () => {
  robotsReplies(async () => new Response("", { status: 503 }));

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "unavailable");
});

test("a 403 is UNAVAILABLE, not absent", async () => {
  // A firewall refusing our scanner is not a website without a robots.txt.
  robotsReplies(async () => new Response("", { status: 403 }));

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "unavailable");
});

test("a timeout is UNAVAILABLE", QUICK_LIMIT, async () => {
  mockFetch((_method, _url, init) => hangUntilAborted(init));

  assert.equal((await runTechnicalChecks(PAGE, 200)).robotsTxtStatus, "unavailable");
});

test("a network failure is UNAVAILABLE", async () => {
  robotsReplies(async () => {
    throw new TypeError("fetch failed");
  });

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "unavailable");
});

test("an oversized robots.txt is UNAVAILABLE — it exists, we could not read it", async () => {
  // Past MAX_ROBOTS_BYTES. The file is plainly there; we just have not read it,
  // so we cannot say what it contains or that it is missing.
  robotsReplies(async () => robotsText("#".repeat(600_000)));

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "unavailable");
});

test("an exhausted budget is UNAVAILABLE — we never looked", async () => {
  mockFetch(async () => robotsText("User-agent: *"));

  const result = await runTechnicalChecks(PAGE, 0);

  assert.equal(requests.length, 0);
  assert.equal(result.robotsTxtStatus, "unavailable");
});

test("HTML served for robots.txt is ABSENT — the server answered fine", async () => {
  // Many sites return their homepage for any unknown path. That is a genuine
  // "there is no robots.txt here", not a failure to find out.
  robotsReplies(
    async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  );

  assert.equal((await runTechnicalChecks(PAGE, 5_000)).robotsTxtStatus, "absent");
});

test("robotsBlocksEverything is false when the file was never read", async () => {
  // False here means "no information", not "this site blocks nobody" — which
  // is exactly why the rule consults the status rather than this flag.
  robotsReplies(async () => new Response("", { status: 500 }));

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.robotsTxtStatus, "unavailable");
  assert.equal(result.robotsBlocksEverything, false);
});

test("a blocking robots.txt is still detected", async () => {
  // The new states must not stop the rule seeing a real problem.
  robotsReplies(async () => robotsText("User-agent: *\nDisallow: /"));

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.robotsTxtStatus, "found");
  assert.equal(result.robotsBlocksEverything, true);
});

test("the sitemap carries the same three states", async () => {
  mockFetch(async (_m, url) =>
    url.includes("/sitemap.xml") ? new Response("", { status: 503 }) : notFound(),
  );

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.sitemapStatus, "unavailable", "a 503 is not 'no sitemap'");
  assert.equal(result.sitemapUrl, null);
});

test("a sitemap that 404s is genuinely absent", async () => {
  mockFetch(async () => notFound());

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.sitemapStatus, "absent");
  assert.equal(result.sitemapUrl, null);
});

test("a sitemap declared in robots.txt is found without a second request", async () => {
  robotsReplies(async () => robotsText("Sitemap: https://93.184.216.34/custom.xml"));

  const result = await runTechnicalChecks(PAGE, 5_000);

  assert.equal(result.sitemapStatus, "found");
  assert.equal(result.sitemapUrl, "https://93.184.216.34/custom.xml");
  assert.equal(sitemapRequests().length, 0, "robots already told us");
});

// ---------------------------------------------------------------------------
// ONE PARSER, NOT TWO
//
// This rule is CRITICAL: it tells a client their site is invisible to search.
// It used to read robots.txt with its own line scanner, which discarded the
// wildcard group's verdict as soon as another `User-agent` line appeared. That
// shape is common — sites routinely add groups for SEO crawlers — so a site
// left with `Disallow: /` passed the audit in silence.
//
// It now reads the file through `parseGroups` / `selectRules` / `isPathAllowed`,
// the very functions the crawler obeys when deciding whether it may fetch a
// page, so the two cannot disagree about a file again.
// ---------------------------------------------------------------------------

const BLOCKS_ALL = "User-agent: *\nDisallow: /";

test("a later agent-specific group does not cancel the wildcard block", () => {
  /*
   * THE BUG, AS A TEST. Googlebot has no group of its own here, so the
   * wildcard applies to it and the whole site is hidden from search. The
   * AhrefsBot group changes nothing about that.
   */
  const robots = `${BLOCKS_ALL}\n\nUser-agent: AhrefsBot\nDisallow: /admin`;

  assert.equal(blocksEveryCrawler(robots), true);
});

test("several agent-specific groups still do not cancel it", () => {
  const robots = [
    BLOCKS_ALL,
    "User-agent: AhrefsBot\nDisallow: /a",
    "User-agent: SemrushBot\nDisallow: /b",
    "User-agent: DotBot\nCrawl-delay: 10",
  ].join("\n\n");

  assert.equal(blocksEveryCrawler(robots), true);
});

test("Disallow: /* blocks the whole site, because the pattern matcher says so", () => {
  // Not special-cased anywhere: `patternMatches` already understands `*`, and
  // the rule simply asks it.
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /*"), true);
  assert.equal(
    blocksEveryCrawler("User-agent: *\nDisallow: /*\n\nUser-agent: AhrefsBot\nDisallow: /admin"),
    true,
  );
});

test("Disallow: /$ blocks only the home page, so the whole site is NOT blocked", () => {
  // `$` anchors the end of the path, so the pattern matches only the exact
  // address "/" -- /about and every other page stay crawlable. Reporting the
  // whole site as blocked here was a false Critical (was a defect, J3).
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /$"), false);
});

test("the three canonical root patterns are told apart", () => {
  // The whole point of probing a non-root path as well as "/".
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /"), true, "/ blocks everything");
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /*"), true, "/* blocks everything");
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /$"), false, "/$ blocks only the root");
});

test("under Disallow: /$ a non-root page really is allowed", () => {
  // The behaviour the finding depends on, asserted through the same policy the
  // crawler obeys so the rule and the crawler cannot drift: /about is crawlable.
  const policy = parseRobots("User-agent: *\nDisallow: /$");
  assert.equal(policy.isAllowed("https://example.com/"), false, "the home page is disallowed");
  assert.equal(policy.isAllowed("https://example.com/about"), true, "but /about is not");
});

test("Disallow: /$ with an Allow exception is still not a whole-site block", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /$\nAllow: /public/"), false);
});

test("the wildcard group on its own still fires", () => {
  assert.equal(blocksEveryCrawler(BLOCKS_ALL), true);
});

// --- the other direction: a group that legitimately overrides the wildcard --

test("an applicable Googlebot group overrides the wildcard block", () => {
  /*
   * Blocking every OTHER crawler while inviting Google is a deliberate, common
   * configuration. The site is not hidden from search, and claiming it was
   * would be the false claim this rule exists to avoid.
   */
  assert.equal(blocksEveryCrawler(`${BLOCKS_ALL}\n\nUser-agent: Googlebot\nDisallow:`), false);
  assert.equal(blocksEveryCrawler(`${BLOCKS_ALL}\n\nUser-agent: Googlebot\nAllow: /`), false);
});

test("an Allow rule means the site is not entirely blocked", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /\nAllow: /public/"), false);
});

test("blocking part of a site is not blocking a site", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /admin"), false);
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /admin/"), false);
  assert.equal(blocksEveryCrawler("User-agent: *\nCrawl-delay: 10"), false);
});

test("a block aimed at one named crawler is not a block on search", () => {
  assert.equal(blocksEveryCrawler("User-agent: BadBot\nDisallow: /"), false);
});

test("a group naming a prefix of a search engine applies to it", () => {
  // `selectRules` matches by prefix, so a group written "Bing" is Bingbot's.
  // Bing may crawl, so the site is not hidden from every search engine.
  assert.equal(blocksEveryCrawler(`${BLOCKS_ALL}\n\nUser-agent: Bing\nDisallow:`), false);
});

// --- the two implementations agree -----------------------------------------

test("the rule and the crawler read the same file the same way", () => {
  /*
   * The property that matters: whenever the rule claims the whole site is
   * blocked, a real crawler must also be refused the root. The converse is NOT
   * asserted — an Allow carve-out blocks the root while leaving part of the
   * site reachable, so the crawler is refused while the site is not entirely
   * hidden. They answer different questions and both answers are right.
   */
  const files = [
    BLOCKS_ALL,
    `${BLOCKS_ALL}\n\nUser-agent: AhrefsBot\nDisallow: /admin`,
    "User-agent: *\nDisallow: /*",
    `${BLOCKS_ALL}\n\nUser-agent: Googlebot\nDisallow:`,
    "User-agent: *\nDisallow: /\nAllow: /public/",
    "User-agent: *\nDisallow: /admin",
    "User-agent: BadBot\nDisallow: /",
    "User-agent: *\nDisallow:",
    "",
    "# nothing but a comment",
    "Sitemap: https://x.test/sitemap.xml",
  ];

  for (const text of files) {
    const ruleSaysBlocked = blocksEveryCrawler(text);
    const crawlerRefusedRoot = !parseRobots(text, "googlebot").isAllowed("https://x.test/");

    if (ruleSaysBlocked) {
      assert.equal(crawlerRefusedRoot, true, `the crawler must agree about: ${JSON.stringify(text)}`);
    }
  }
});

test("the rule keeps no robots parser of its own", () => {
  /*
   * A structural guard, because the bug was not a wrong line — it was a second
   * implementation. If this file starts reading User-agent or Disallow lines
   * again, the two readings can drift apart again.
   */
  const source = fs.readFileSync(new URL("./technicalChecks.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function blocksEveryCrawler"));

  assert.ok(!/split\(\/\\r\?\\n\//.test(body), "no line splitting of its own");
  assert.ok(/parseGroups|selectRules|isPathAllowed/.test(body), "it uses the shared parser");
});

// ---------------------------------------------------------------------------
// ONE MEASUREMENT, NOT TWO
//
// This module used to fetch robots.txt for itself while the crawler fetched it
// for the rules. Two requests for one file can come back differently, and the
// report then said both: "no robots.txt" in one panel, "robots.txt could not
// be checked" in the other. One is a claim about the client's website and the
// other is a claim about our own request.
// ---------------------------------------------------------------------------

test("the robots status is the measurement handed in, never a second opinion", async () => {
  // Any request for robots.txt here would be a second opinion, so the stub
  // answers only the sitemap and records everything.
  mockFetch(async (_method, url) => (url.includes("/sitemap.xml") ? notFound() : notFound()));

  const cases = [
    { given: { status: "found" as const, text: "" }, expected: "found" },
    { given: { status: "absent" as const }, expected: "absent" },
    { given: { status: "unavailable" as const }, expected: "unavailable" },
  ];

  for (const situation of cases) {
    requests = [];
    const result = await runTechnicalChecksImpl(PAGE, situation.given, 5_000);

    assert.equal(result.robotsTxtStatus, situation.expected, situation.expected);
    assert.equal(
      requests.filter((r) => r.includes("/robots.txt")).length,
      0,
      "robots.txt must not be fetched here at all",
    );
  }
});

test("an unreadable robots.txt never becomes a blocked-site verdict", async () => {
  mockFetch(async () => notFound());

  const result = await runTechnicalChecksImpl(PAGE, { status: "unavailable" }, 5_000);

  assert.equal(result.robotsTxtStatus, "unavailable");
  assert.equal(
    result.robotsBlocksEverything,
    false,
    "there is no text to read, so nothing may be concluded from it",
  );
});

test("the Sitemap: line is read from the crawler's copy, with no second request", async () => {
  mockFetch(async () => notFound());

  const result = await runTechnicalChecksImpl(
    PAGE,
    { status: "found", text: "Sitemap: https://example.com/from-robots.xml" },
    5_000,
  );

  assert.equal(result.sitemapUrl, "https://example.com/from-robots.xml");
  assert.equal(result.sitemapStatus, "found");
  assert.equal(
    requests.filter((r) => r.includes("/robots.txt")).length,
    0,
    "the text was already in hand",
  );
});
