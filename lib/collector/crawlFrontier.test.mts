/**
 * Tests for the crawl frontier and its limits.
 *
 * The limits are the whole point. A crawl that stops at page 150 of 4000 has
 * audited a prefix of a site, and saying otherwise would be the same class of
 * lie this project has spent its life refusing — so most of what follows checks
 * that `complete` is false and `stoppedBecause` names the real cause.
 *
 * The clock is injected, so every duration case is exact rather than timed.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createDeadline } from "./deadline.ts";
import {
  DEFAULT_CRAWL_LIMITS,
  createFrontier,
  crawlDeadline,
  type CrawlLimits,
  type Frontier,
} from "./crawlFrontier.ts";

const SITE = "https://example.com/";

/** A frontier with a clock the test drives by hand. */
function frontierAt(limits: Partial<CrawlLimits> = {}, startMs = 0) {
  let clock = startMs;
  const frontier = createFrontier({
    requestedUrl: SITE,
    limits,
    now: () => clock,
  });
  return {
    frontier,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function plain(limits: Partial<CrawlLimits> = {}): Frontier {
  return createFrontier({ requestedUrl: SITE, limits, now: () => 0 });
}

/** Queues n distinct pages and returns how many were accepted. */
function offerPages(frontier: Frontier, count: number, from = 0): number {
  let queued = 0;
  for (let i = from; i < from + count; i += 1) {
    if (frontier.offer(`/page-${i}`, "html").outcome === "queued") queued += 1;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("the approved defaults are exactly these", () => {
  assert.deepEqual(DEFAULT_CRAWL_LIMITS, {
    maxPages: 150,
    maxDurationMs: 300_000,
    maxQueueSize: 2_000,
    maxResponseBytes: 5_000_000,
    concurrency: 3,
    perRequestDelayMs: 200,
  });
});

test("limits are configurable, and an override leaves the rest alone", () => {
  const frontier = plain({ maxPages: 7 });
  const { limits } = frontier.summary();

  assert.equal(limits.maxPages, 7);
  assert.equal(limits.maxQueueSize, DEFAULT_CRAWL_LIMITS.maxQueueSize);
  assert.equal(limits.concurrency, DEFAULT_CRAWL_LIMITS.concurrency);
});

test("the limits used are reported back in the summary", () => {
  // A report that does not say what the limits were cannot be checked.
  const frontier = plain({ maxPages: 12, maxDurationMs: 900 });
  assert.equal(frontier.summary().limits.maxPages, 12);
  assert.equal(frontier.summary().limits.maxDurationMs, 900);
});

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

test("pages come back in the order they were offered", () => {
  const frontier = plain();
  for (const path of ["/a", "/b", "/c"]) frontier.offer(path, "html");

  assert.equal(frontier.next()?.pathname, "/a");
  assert.equal(frontier.next()?.pathname, "/b");
  assert.equal(frontier.next()?.pathname, "/c");
  assert.equal(frontier.next(), null);
});

test("FIFO means breadth first: a page queued later is served later", () => {
  const frontier = plain();
  frontier.offer("/depth-1", "html");
  frontier.next();
  frontier.offer("/depth-2", "html");
  frontier.offer("/sibling", "html");

  // The sibling of the first page is reached before the child of the second.
  assert.equal(frontier.next()?.pathname, "/depth-2");
  assert.equal(frontier.next()?.pathname, "/sibling");
});

test("an empty queue returns null, not an error", () => {
  const frontier = plain();
  assert.equal(frontier.next(), null);
  assert.equal(frontier.next(), null);
});

// ---------------------------------------------------------------------------
// What may enter
// ---------------------------------------------------------------------------

test("stage 1 normalisation still governs what is accepted", () => {
  const frontier = plain();

  assert.equal(frontier.offer("javascript:alert(1)", "html").outcome, "rejected");
  assert.equal(frontier.offer("mailto:a@b.com", "html").outcome, "rejected");
  assert.equal(frontier.offer("", "html").outcome, "rejected");
  assert.equal(frontier.offer("http://localhost/", "html").outcome, "rejected");
  assert.equal(frontier.offer("file:///etc/passwd", "html").outcome, "rejected");
});

test("a rejection says which rule refused it", () => {
  assert.equal(frontier1().offer("javascript:x", "html").reason, "unsupported-scheme");
  assert.equal(frontier1().offer("http://intranet/", "html").reason, "dotless-host");
  assert.equal(frontier1().offer("   ", "html").reason, "empty");
  function frontier1() {
    return plain();
  }
});

test("another site's pages are refused and not counted as discovered", () => {
  const frontier = plain();

  assert.equal(frontier.offer("https://evil.net/a", "html").outcome, "off-site");
  assert.equal(frontier.offer("https://blog.example.com/a", "html").outcome, "off-site");
  assert.equal(frontier.offer("https://example.com.evil.net/", "html").outcome, "off-site");
  assert.equal(frontier.discovered, 0, "off-site pages are not pages of this site");
  assert.equal(frontier.queued, 0);
});

test("www and apex count as the same site", () => {
  const frontier = plain();
  assert.equal(frontier.offer("https://www.example.com/a", "html").outcome, "queued");
});

test("relative links resolve against the page they came from", () => {
  const frontier = plain();
  frontier.offer("teapots", "html", "https://example.com/products/kettles");

  assert.equal(frontier.next()?.pathname, "/products/teapots");
});

test("with no base given, links resolve against the requested URL", () => {
  const frontier = plain();
  frontier.offer("/about", "html");
  assert.equal(frontier.next()?.href, "https://example.com/about");
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

test("the same page offered twice is queued once", () => {
  const frontier = plain();

  assert.equal(frontier.offer("/about", "html").outcome, "queued");
  assert.equal(frontier.offer("/about", "html").outcome, "duplicate");
  assert.equal(frontier.queued, 1);
  assert.equal(frontier.discovered, 1);
});

test("equivalent addresses are one page", () => {
  const frontier = plain();
  frontier.offer("/about", "html");

  for (const same of [
    "/about/",
    "https://www.example.com/about",
    "http://example.com/about",
    "/about#team",
    "/about?utm_source=x",
  ]) {
    assert.equal(frontier.offer(same, "html").outcome, "duplicate", same);
  }
  assert.equal(frontier.discovered, 1);
});

test("a page stays known after it has been taken from the queue", () => {
  // Otherwise a link back to an already-crawled page requeues it forever.
  const frontier = plain();
  frontier.offer("/a", "html");
  frontier.next();

  assert.equal(frontier.offer("/a", "html").outcome, "duplicate");
  assert.equal(frontier.queued, 0);
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test("discoveries are counted by where they came from", () => {
  const frontier = plain();
  frontier.offer("/a", "html");
  frontier.offer("/b", "html");
  frontier.offer("/c", "sitemap");

  assert.deepEqual(frontier.summary().sources, { html: 2, sitemap: 1 });
});

test("the seed is not counted as a source", () => {
  // It is the requested URL, reported in its own field.
  const frontier = plain();
  frontier.offer(SITE, "seed");

  assert.deepEqual(frontier.summary().sources, { html: 0, sitemap: 0 });
  assert.equal(frontier.discovered, 1);
});

test("a page found twice counts once, under whoever found it first", () => {
  const frontier = plain();
  frontier.offer("/a", "sitemap");
  frontier.offer("/a", "html");

  assert.deepEqual(frontier.summary().sources, { html: 0, sitemap: 1 });
});

// ---------------------------------------------------------------------------
// Outcomes recorded against pages
// ---------------------------------------------------------------------------

test("evaluated, unavailable and non-HTML are counted apart", () => {
  const frontier = plain();
  frontier.recordEvaluated("https://example.com/a");
  frontier.recordEvaluated("https://example.com/b");
  frontier.recordUnavailable("https://example.com/c", "The server took too long to respond.");
  frontier.recordSkippedNonHtml("https://example.com/d.pdf");

  const summary = frontier.summary();
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.unavailable.length, 1);
  assert.equal(summary.skippedNonHtml, 1);
  assert.equal(frontier.processed, 4, "all four cost a request");
});

test("an unavailable page keeps its address and reason, and is not a finding", () => {
  const frontier = plain();
  frontier.recordUnavailable("https://example.com/gone", "The server took too long to respond.");

  const [failure] = frontier.summary().unavailable;
  assert.equal(failure.url, "https://example.com/gone");
  assert.match(failure.reason, /took too long/);
  // A page we could not read is not a page that failed a check. It carries an
  // address and a reason and nothing else — no severity, no title, no evidence,
  // none of the shape a Finding has.
  assert.deepEqual(Object.keys(failure).sort(), ["reason", "url"]);
});

test("the summary's unavailable list cannot be mutated from outside", () => {
  const frontier = plain();
  frontier.recordUnavailable("https://example.com/x", "gone");

  frontier.summary().unavailable.push({ url: "injected", reason: "injected" });
  assert.equal(frontier.summary().unavailable.length, 1);
});

// ---------------------------------------------------------------------------
// maxPages
// ---------------------------------------------------------------------------

test("maxPages stops the crawl and names itself", () => {
  const frontier = plain({ maxPages: 3 });
  offerPages(frontier, 10);

  let taken = 0;
  for (;;) {
    const url = frontier.next();
    if (url === null) break;
    frontier.recordEvaluated(url);
    taken += 1;
  }

  assert.equal(taken, 3);
  assert.equal(frontier.summary().stoppedBecause, "max-pages");
  assert.equal(frontier.summary().complete, false);
  assert.ok(frontier.summary().queuedAtStop > 0, "pages were left unvisited");
});

test("maxPages counts attempts, not successes", () => {
  // A page that timed out still cost a request, so it must count.
  const frontier = plain({ maxPages: 3 });
  offerPages(frontier, 10);

  frontier.recordUnavailable(frontier.next()!, "timeout");
  frontier.recordSkippedNonHtml(frontier.next()!);
  frontier.recordEvaluated(frontier.next()!);

  assert.equal(frontier.next(), null, "the budget is spent");
  assert.equal(frontier.summary().stoppedBecause, "max-pages");
  assert.equal(frontier.summary().evaluated, 1);
});

// ---------------------------------------------------------------------------
// maxPages: the exact-limit case
//
// Spending the budget on the last turn is two different situations depending on
// what was left behind, and the difference is what a client is told about how
// much of their site we looked at.
// ---------------------------------------------------------------------------

test("spending the budget exactly as the queue empties is a COMPLETE crawl", () => {
  // Case A: 3 pages found, 3 pages allowed, 3 pages visited. Nothing was
  // declined, so calling this partial would understate a finished audit.
  const frontier = plain({ maxPages: 3 });
  assert.equal(offerPages(frontier, 3), 3);

  let taken = 0;
  for (;;) {
    const url = frontier.next();
    if (url === null) break;
    frontier.recordEvaluated(url);
    taken += 1;
  }

  const summary = frontier.summary();
  assert.equal(taken, 3, "every page was visited");
  assert.equal(summary.queuedAtStop, 0, "and none were left waiting");
  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.complete, true);
});

test("spending the budget with even ONE page still queued is a PARTIAL crawl", () => {
  // Case B: the same budget, one more page. That page exists, we found it, and
  // the budget is the reason we are not visiting it — which is exactly what
  // "partial" means.
  const frontier = plain({ maxPages: 3 });
  assert.equal(offerPages(frontier, 4), 4);

  for (let i = 0; i < 3; i += 1) frontier.recordEvaluated(frontier.next()!);

  const summary = frontier.summary();
  assert.equal(summary.queuedAtStop, 1);
  assert.equal(summary.stoppedBecause, "max-pages");
  assert.equal(summary.complete, false);
  assert.equal(frontier.next(), null, "and the extra page is never handed out");
});

test("an exactly-spent budget still refuses to hand out another page", () => {
  // The completion path must not become a way to exceed the limit: the moment
  // anything is queued, the budget is binding again.
  const frontier = plain({ maxPages: 2 });
  offerPages(frontier, 2);
  frontier.recordEvaluated(frontier.next()!);
  frontier.recordEvaluated(frontier.next()!);

  assert.equal(frontier.next(), null);
  assert.equal(frontier.summary().stoppedBecause, "completed");

  // A page discovered after the budget ran out — what stage 4's link
  // extraction will do — must not be visited, and must turn the crawl partial.
  assert.equal(frontier.offer("/late-arrival", "html").outcome, "queued");
  assert.equal(frontier.next(), null, "the budget is spent, whatever arrives now");
  assert.equal(frontier.summary().stoppedBecause, "max-pages");
  assert.equal(frontier.summary().complete, false);
});

test("attempts of every kind count toward the exact-limit case", () => {
  // Completion must not depend on the pages having gone well: a timeout and a
  // PDF cost a request just as a good page does.
  const frontier = plain({ maxPages: 3 });
  offerPages(frontier, 3);

  frontier.recordUnavailable(frontier.next()!, "timeout");
  frontier.recordSkippedNonHtml(frontier.next()!);
  frontier.recordEvaluated(frontier.next()!);

  const summary = frontier.summary();
  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.complete, true);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.unavailable.length, 1);
  assert.equal(summary.skippedNonHtml, 1);
});

test("an overflowed queue stays partial even when the budget comes out even", () => {
  // Pages were discovered and dropped. The queue being empty at the end does
  // not undo that, and completion must not launder it away.
  const frontier = plain({ maxPages: 2, maxQueueSize: 2 });
  offerPages(frontier, 5); // two queued, three dropped

  frontier.recordEvaluated(frontier.next()!);
  frontier.recordEvaluated(frontier.next()!);

  const summary = frontier.summary();
  assert.equal(summary.queuedAtStop, 0);
  assert.equal(summary.stoppedBecause, "max-queue");
  assert.equal(summary.complete, false);
});

test("an expired clock still outranks an exactly-spent budget", () => {
  // Completion is only for a crawl that ran out of work. One that ran out of
  // time has not finished, however tidily its queue happened to empty.
  const { frontier, advance } = frontierAt({ maxPages: 2, maxDurationMs: 1_000 });
  offerPages(frontier, 2);
  frontier.recordEvaluated(frontier.next()!);
  frontier.recordEvaluated(frontier.next()!);

  advance(1_000);

  assert.equal(frontier.summary().stoppedBecause, "max-duration");
  assert.equal(frontier.summary().complete, false);
});

// ---------------------------------------------------------------------------
// maxDurationMs
// ---------------------------------------------------------------------------

test("running out of time stops the crawl and names itself", () => {
  const { frontier, advance } = frontierAt({ maxDurationMs: 1_000 });
  offerPages(frontier, 5);

  frontier.recordEvaluated(frontier.next()!);
  advance(1_000);

  assert.equal(frontier.next(), null);
  assert.equal(frontier.summary().stoppedBecause, "max-duration");
  assert.equal(frontier.summary().complete, false);
});

test("the duration boundary is inclusive at exactly the limit", () => {
  const { frontier, advance } = frontierAt({ maxDurationMs: 1_000 });
  offerPages(frontier, 3);

  advance(999);
  assert.ok(frontier.next() !== null, "999ms is still inside the budget");
  advance(1);
  assert.equal(frontier.next(), null, "1000ms is spent");
});

test("the audit's own clock is reported separately from the crawl's budget", () => {
  // "The audit ran out of time" and "the crawl used its budget" are different
  // facts, and merging them would hide which limit needs raising.
  const outer = createDeadline(0); // already expired
  const frontier = createFrontier({ requestedUrl: SITE, outerDeadline: outer, now: () => 0 });
  frontier.offer("/a", "html");

  assert.equal(frontier.next(), null);
  assert.equal(frontier.summary().stoppedBecause, "deadline");
  assert.equal(frontier.summary().complete, false);
});

// ---------------------------------------------------------------------------
// maxQueueSize
// ---------------------------------------------------------------------------

test("a full queue stops accepting, but the crawl finishes what it has", () => {
  const frontier = plain({ maxQueueSize: 3 });

  assert.equal(offerPages(frontier, 3), 3);
  assert.equal(frontier.offer("/page-99", "html").outcome, "queue-full");
  assert.equal(frontier.queued, 3);
});

test("a page refused by a full queue still counts as discovered", () => {
  // It exists, we found it, and we are not going to look at it. Pretending we
  // never saw it would make the crawl look more complete than it was.
  const frontier = plain({ maxQueueSize: 2 });
  offerPages(frontier, 2);
  frontier.offer("/page-99", "html");

  assert.equal(frontier.discovered, 3);
  assert.equal(frontier.queued, 2);
});

test("queue overflow makes the crawl partial even after it drains tidily", () => {
  const frontier = plain({ maxQueueSize: 2 });
  offerPages(frontier, 2);
  frontier.offer("/page-99", "html"); // refused

  // Drain everything.
  for (;;) {
    const url = frontier.next();
    if (url === null) break;
    frontier.recordEvaluated(url);
  }

  const summary = frontier.summary();
  assert.equal(summary.queuedAtStop, 0, "the queue did drain");
  assert.equal(summary.stoppedBecause, "max-queue");
  assert.equal(summary.complete, false, "pages were discovered and never visited");
});

test("a duplicate offered to a full queue is still just a duplicate", () => {
  const frontier = plain({ maxQueueSize: 1 });
  frontier.offer("/a", "html");

  assert.equal(frontier.offer("/a/", "html").outcome, "duplicate");
  assert.equal(frontier.discovered, 1);
});

// ---------------------------------------------------------------------------
// Completion, and the precedence between limits
// ---------------------------------------------------------------------------

test("a drained queue with no limit hit is the only complete crawl", () => {
  const frontier = plain();
  offerPages(frontier, 4);

  for (;;) {
    const url = frontier.next();
    if (url === null) break;
    frontier.recordEvaluated(url);
  }

  const summary = frontier.summary();
  assert.equal(summary.stoppedBecause, "completed");
  assert.equal(summary.complete, true);
  assert.equal(summary.queuedAtStop, 0);
  assert.equal(summary.evaluated, 4);
});

test("complete is false for every stop reason except completion", () => {
  const cases: Array<[string, () => Frontier]> = [
    ["max-pages", () => { const f = plain({ maxPages: 1 }); offerPages(f, 3); f.recordEvaluated(f.next()!); f.next(); return f; }],
    ["max-queue", () => { const f = plain({ maxQueueSize: 1 }); offerPages(f, 3); return f; }],
    ["deadline", () => { const f = createFrontier({ requestedUrl: SITE, outerDeadline: createDeadline(0), now: () => 0 }); f.next(); return f; }],
  ];

  for (const [expected, build] of cases) {
    const summary = build().summary();
    assert.equal(summary.stoppedBecause, expected);
    assert.equal(summary.complete, false, `${expected} must never read as complete`);
  }
});

test("the first limit to bite is the one reported", () => {
  // Time runs out while pages are still available, so the page budget is not
  // the reason even though it would have been hit later.
  const { frontier, advance } = frontierAt({ maxPages: 100, maxDurationMs: 500 });
  offerPages(frontier, 50);
  frontier.recordEvaluated(frontier.next()!);
  advance(500);
  frontier.next();

  assert.equal(frontier.summary().stoppedBecause, "max-duration");
});

test("the reason does not drift once a limit has bitten", () => {
  // The clock keeps moving after a crawl halts. The recorded reason must stay
  // the one that actually stopped it.
  const { frontier, advance } = frontierAt({ maxPages: 1, maxDurationMs: 10_000 });
  offerPages(frontier, 5);
  frontier.recordEvaluated(frontier.next()!);
  frontier.next(); // halts on max-pages

  advance(10_000); // now the duration limit would also be true

  assert.equal(frontier.summary().stoppedBecause, "max-pages");
});

test("stopReason is null while the crawl may continue", () => {
  const frontier = plain({ maxPages: 5 });
  offerPages(frontier, 2);

  assert.equal(frontier.stopReason(), null);
  frontier.recordEvaluated(frontier.next()!);
  assert.equal(frontier.stopReason(), null, "an emptying queue is not a limit");
});

test("an empty queue on its own is completion, not a stop reason", () => {
  const frontier = plain();

  assert.equal(frontier.next(), null);
  assert.equal(frontier.stopReason(), null);
  assert.equal(frontier.summary().stoppedBecause, "completed");
});

// ---------------------------------------------------------------------------
// The summary as a whole
// ---------------------------------------------------------------------------

test("a partial crawl reports every number a reader needs to judge it", () => {
  const frontier = plain({ maxPages: 2 });
  offerPages(frontier, 6);
  frontier.recordEvaluated(frontier.next()!);
  frontier.recordUnavailable(frontier.next()!, "timeout");
  frontier.next();

  const s = frontier.summary();
  assert.equal(s.requestedUrl, SITE);
  assert.equal(s.stoppedBecause, "max-pages");
  assert.equal(s.complete, false);
  assert.equal(s.discovered, 6);
  assert.equal(s.evaluated, 1);
  assert.equal(s.unavailable.length, 1);
  assert.equal(s.queuedAtStop, 4);
  // 6 discovered, 1 evaluated, 1 unavailable, 4 never visited — a reader can
  // see exactly how much of the site this covered.
  assert.equal(s.evaluated + s.unavailable.length + s.queuedAtStop, s.discovered);
});

test("the summary is a snapshot, not a live view", () => {
  const frontier = plain();
  frontier.offer("/a", "html");
  const before = frontier.summary();

  frontier.recordEvaluated(frontier.next()!);
  assert.equal(before.evaluated, 0, "the earlier snapshot did not change");
  assert.equal(frontier.summary().evaluated, 1);
});

test("crawlDeadline builds a clock from the crawl's own budget", () => {
  const deadline = crawlDeadline({ ...DEFAULT_CRAWL_LIMITS, maxDurationMs: 5_000 });

  assert.equal(deadline.expired(), false);
  assert.ok(deadline.remainingMs() > 4_000 && deadline.remainingMs() <= 5_000);
});
