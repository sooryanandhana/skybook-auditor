/**
 * Corpus H — response size, response bodies, and pages large enough to stress
 * the parser.
 *
 * This file demonstrates current behaviour and changes none of it. Nothing here
 * sets or proposes a new limit.
 *
 * Yardsticks: the fetcher's documented 5 MB cap (MAX_BYTES, `total > maxBytes`),
 * the project rule that no raw HTML is kept in an audit result, and the
 * resource guidance for Node's fetch that a response body which will not be
 * read should be consumed or cancelled so its connection is released.
 *
 * THE HEAVY CASE IS OPT-IN. A 2 MB page with a flat DOM takes seconds, and its
 * timing depends on the machine, so it never runs in `npm test`. Set
 * SKYBOOK_HEAVY_CORPUS=1 to run it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { crawlSite } from "../collector/crawlSite.ts";
import { createDeadline } from "../collector/deadline.ts";
import { fetchPage } from "../collector/fetchPage.ts";
import { safeFetch } from "../collector/safety.ts";
import { fetcherFor } from "../audit/pdf/realAudit.fixture.mts";
import {
  auditFixtureSite,
  correct,
  defect,
  findingsOf,
  HTML,
  noSiteFiles,
  OTHER_PUBLIC_HOST,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  installOfflineCorpus,
  withServer,
  type Script,
} from "./corpus.fixture.mts";

installOfflineCorpus();
const ROOT = `https://${PUBLIC_HOST}/`;
const MAX_BYTES = 5_000_000;

/** An HTML document of exactly `bytes` single-byte characters. */
function htmlOfSize(bytes: number): string {
  const head = "<!doctype html><html><body>";
  return head + "a".repeat(bytes - head.length);
}

function fetchWith(script: Script) {
  return withServer(script, async (server) => ({ result: await fetchPage(`${ROOT}page`, createDeadline(30_000)), server }));
}

/** A page whose body is `bytes` of repeated cards, every one a direct child of <body> unless wrapped. */
function cardsPage(title: string, bytes: number, wrap: boolean): string {
  const card = '<div class="card"><a href="/p1">Read more</a><img src="/i.png"><p>Opening hours and prices.</p></div>';
  const cards = card.repeat(Math.floor(bytes / card.length));
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><nav><a href="/p1">One</a><a href="/p2">Two</a></nav>` +
    `${wrap ? `<main>${cards}</main>` : cards}</body></html>`
  );
}

/** A three-page site of `bytes`-sized flat pages, each linking to the other two. */
function threeLargePages(bytes: number) {
  return {
    [ROOT]: { html: cardsPage("Home", bytes, false), headers: PROTECTED_HEADERS },
    [`${ROOT}p1`]: { html: cardsPage("One", bytes, false), headers: PROTECTED_HEADERS },
    [`${ROOT}p2`]: { html: cardsPage("Two", bytes, false), headers: PROTECTED_HEADERS },
  };
}

// ---------------------------------------------------------------------------
// The body cap
// ---------------------------------------------------------------------------

correct("H1 a page of exactly 5,000,000 bytes is read in full", async () => {
  const { result } = await fetchWith((_url, server) => server.respond("exact", { headers: HTML, body: htmlOfSize(MAX_BYTES) }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.html.length, MAX_BYTES);
});

correct("H2 a page of 5,000,001 bytes is refused as not readable in full, and the server is still recorded as online", async () => {
  const { result } = await fetchWith((_url, server) => server.respond("over", { headers: HTML, body: htmlOfSize(MAX_BYTES + 1) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "That page could not be read in full.");
  assert.equal(result.uptime?.isOnline, true);
});

correct("H3 reading stops at the cap and the rest of an oversized body is released", async () => {
  const { result, server } = await fetchWith((_url, s) => s.respond("oversized", { headers: HTML, body: htmlOfSize(6_000_000) }));
  assert.equal(result.ok, false);
  assert.deepEqual(server.cancelled, ["oversized"]);
});

// ---------------------------------------------------------------------------
// Bodies that are never read
// ---------------------------------------------------------------------------

correct("H4 the bodies of error, redirect and non-HTML responses are released before the early return", async () => {
  // An abandoned fetch body holds its connection open. The success path drains
  // it; every path that receives a response it will not read must cancel it.
  // The harness records a release as the response's label in `cancelled`, and
  // proves it can observe one (harness.corpus.test.mts), so these are evidence.

  // An HTTP error status: read as "the server answered", not as a page.
  const notFound = await fetchWith((_url, s) => s.respond("404", { status: 404, headers: HTML, body: "missing ".repeat(20_000) }));
  assert.deepEqual(notFound.server.cancelled, ["404"]);

  // A redirect that is followed: its own body is not read.
  const redirected = await fetchWith((url, s) =>
    url.pathname === "/page"
      ? s.respond("301", { status: 301, headers: { location: "/next" }, body: "moved ".repeat(20_000) })
      : s.respond("final", { headers: HTML }),
  );
  assert.equal(redirected.result.ok, true);
  assert.deepEqual(redirected.server.cancelled, ["301"]);

  // A non-HTML answer (a PDF): the server said what it is; it is not read.
  const pdf = await fetchWith((_url, s) => s.respond("pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF".repeat(50_000) }));
  assert.deepEqual(pdf.server.cancelled, ["pdf"]);

  // safeFetch follows redirects too, and the intermediate hop's body is released
  // before the next hop; the final 200 is returned to the caller to consume.
  await withServer(
    (url, s) =>
      url.hostname === PUBLIC_HOST
        ? s.respond("safe-301", { status: 301, headers: { location: `https://${OTHER_PUBLIC_HOST}/robots.txt` }, body: "moved ".repeat(20_000) })
        : s.respond("safe-200", { body: "User-agent: *" }),
    async (s) => {
      const response = await safeFetch(`${ROOT}robots.txt`);
      assert.equal(response?.status, 200);
      assert.ok(s.cancelled.includes("safe-301"), "the intermediate redirect body was released");
      await response?.body?.cancel();
    },
  );
});

// ---------------------------------------------------------------------------
// Large pages
// ---------------------------------------------------------------------------

correct("H5 three 300 KB pages of dense markup are audited with exact counts, and no raw HTML reaches the result", async () => {
  const result = await auditFixtureSite(threeLargePages(300_000));
  assert.equal(result.crawl.evaluated, 3);
  assert.equal(findingsOf(result).get("seo.images.alt")?.affectedCount, 3);
  assert.equal(JSON.stringify(result).includes("Opening hours and prices."), false);
});

defect("H6 the crawl holds the full HTML of every page it has read until the whole crawl ends", {
  // Collectors run after the crawl, so every page's markup stays in memory at
  // once. With parsing that costs about 200 MB per MB of dense HTML, the review
  // measured 1.5 GB of memory for three 4.7 MB pages. How to fix it — analyse
  // as pages arrive, or cap the bytes a crawl may hold — is open, so no
  // after-fix shape is asserted here.
  now: async () => {
    const crawl = await crawlSite({
      requestedUrl: ROOT,
      fetchImpl: fetcherFor(threeLargePages(250_000)),
      useSitemaps: false,
      sitemapFetchImpl: noSiteFiles,
      sleepImpl: async () => {},
    });
    assert.equal(crawl.pages.length, 3);
    for (const fetched of crawl.pages) assert.ok(fetched.html.length > 240_000, fetched.finalUrl);
  },
});

test(
  "[defect] H7 parsing cost grows much faster than page size when many elements sit directly under <body> — opt-in measurement",
  { skip: process.env.SKYBOOK_HEAVY_CORPUS === "1" ? false : "set SKYBOOK_HEAVY_CORPUS=1 to run the heavy measurement" },
  async () => {
    // Identical markup, once flat and once inside one <main>. The review's CPU
    // profile traced the gap to cheerio de-duplicating the body's direct
    // children on every `.find()`, which is quadratic. Timed as a ratio so the
    // machine's speed cancels out.
    const time = async (wrap: boolean) => {
      const started = performance.now();
      await auditFixtureSite({ [ROOT]: { html: cardsPage("Big", 2_000_000, wrap), headers: PROTECTED_HEADERS } });
      return performance.now() - started;
    };
    await time(true); // warm-up
    const flat = await time(false);
    const wrapped = await time(true);
    assert.ok(flat > wrapped * 1.5, `flat ${Math.round(flat)} ms vs wrapped ${Math.round(wrapped)} ms`);
  },
);
