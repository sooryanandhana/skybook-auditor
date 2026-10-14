/**
 * Tests for the diagnostics that say where an audit's time went.
 *
 * THREE NEW KINDS OF LINE:
 *
 *   audit.run  "started"    when an audit leaves the queue, with how long it waited;
 *   audit.run  <end state>  when it ends: completed, partial or failed, with how
 *                           long it ran, how many pages it read and why the crawl
 *                           stopped -- or, for a failure, which kind;
 *   page.parse "measured"   after each page's parsing and checking, with how
 *                           long that work took.
 *
 * WHAT IS PROVED: the fields are right; nothing about the site, the user or an
 * error's wording is written; a value outside the allowed lists is dropped; and
 * neither a broken console nor a strangely shaped result can change what the
 * audit does.
 *
 * Audits here are fakes the test opens and closes by hand, except where a real
 * audit of a site that exists only in this file is needed. No network.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { queuedAuditCount, runningAuditCount, startAudit, UNEXPECTED_FAILURE, type AuditJobStore } from "./auditJobs.ts";
import { createJobStore } from "./jobStore.ts";
import { EntryPageUnavailableError, runSiteAudit } from "../audit/siteAudit.ts";
import { elapsedMs, logOutcome, reliabilityWords } from "../log/reliabilityLog.ts";
import { APPROVED_FIELDS, captureLog, linesFor } from "../log/captureLog.fixture.mts";
import { fetcherFor, siteChecksFor, siteFilesFor, withNetworkUnplugged, type FakeSite } from "../audit/pdf/realAudit.fixture.mts";
import type { SiteAuditResult } from "../types.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";

const SECRET_URL = "https://harbour-dental-sentinel.example/private?token=abc123";
const SECRET_MESSAGE = "SENTINEL could not read https://harbour-dental-sentinel.example/ for ana@harbour.example";

// ---------------------------------------------------------------------------
// Fake audits, released by hand
// ---------------------------------------------------------------------------

const summary = (over: Partial<SiteCrawlSummary> = {}): SiteCrawlSummary => ({
  requestedUrl: SECRET_URL,
  limits: { maxPages: 150, maxDurationMs: 300_000, maxQueueSize: 2_000, maxResponseBytes: 5_000_000, concurrency: 3, perRequestDelayMs: 200 },
  stoppedBecause: "completed",
  complete: true,
  discovered: 7,
  queuedAtStop: 0,
  evaluated: 7,
  unavailable: [],
  skippedNonHtml: 0,
  sources: { html: 0, sitemap: 0 },
  sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
  robots: { status: "absent", enforced: true, excluded: 0 },
  ...over,
});

const result = (crawl: Partial<SiteCrawlSummary> = {}): SiteAuditResult => ({
  data: {} as SiteAuditResult["data"],
  site: { findings: [], skippedChecks: [], evaluatedPages: 7 },
  pages: [],
  crawl: summary(crawl),
});

/** An audit run whose outcome is chosen by the test and which waits to be released. */
function gated(outcome: () => unknown) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runImpl = (async () => {
    await gate;
    const answer = outcome();
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof runSiteAudit;
  return { runImpl, release: () => release() };
}

const freshStore = () => createJobStore() as unknown as AuditJobStore;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one audit to its end, capturing everything written. */
async function runOne(outcome: () => unknown) {
  const store = freshStore();
  const audit = gated(outcome);
  const captured = await captureLog(async () => {
    const started = startAudit(SECRET_URL, { store, runImpl: audit.runImpl });
    await settle();
    audit.release();
    await started.finished;
    return started.jobId;
  });
  return { store, jobId: captured.result, captured, lines: linesFor(captured, "audit.run") };
}

function assertPrivate(entries: readonly string[]) {
  for (const entry of entries) {
    for (const forbidden of ["harbour", "sentinel", "SENTINEL", "token", "https://", "@"]) {
      assert.ok(!entry.includes(forbidden), `"${forbidden}" reached the log: ${entry}`);
    }
  }
}

test.afterEach(() => {
  assert.equal(runningAuditCount(), 0, "a test left an audit running");
  assert.equal(queuedAuditCount(), 0, "a test left an audit queued");
});

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

test("an audit that starts says so once, with how long it waited", async () => {
  const { lines, jobId } = await runOne(() => result());
  const started = lines.filter((line) => line.outcome === "started");

  assert.equal(started.length, 1);
  assert.equal(started[0].job, jobId.slice(0, 8));
  assert.equal(typeof started[0].waitMs, "number");
  assert.ok((started[0].waitMs as number) >= 0);
  assert.ok(lines.indexOf(started[0]) === 0, "and it is the first line about the audit");
});

test("an audit that had to queue reports how long it waited", async () => {
  const store = freshStore();
  const first = gated(() => result());
  const second = gated(() => result());

  const captured = await captureLog(async () => {
    const a = startAudit(SECRET_URL, { store, runImpl: first.runImpl, maxConcurrent: 1 });
    const b = startAudit(SECRET_URL, { store, runImpl: second.runImpl, maxConcurrent: 1 });
    await settle();
    await sleep(60);
    first.release();
    await a.finished;
    await settle();
    second.release();
    await b.finished;
    return b.jobId;
  });

  const started = linesFor(captured, "audit.run").filter((line) => line.outcome === "started");
  const waited = started.find((line) => line.job === captured.result.slice(0, 8));

  assert.equal(started.length, 2);
  assert.ok(waited !== undefined);
  assert.ok((waited.waitMs as number) >= 50, `waited ${String(waited.waitMs)} ms behind the first audit`);
});

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

test("a completed audit reports its time, its pages and why the crawl stopped", async () => {
  const { lines, store, jobId } = await runOne(() => result({ evaluated: 19, stoppedBecause: "completed", complete: true }));
  const end = lines[lines.length - 1];

  assert.equal(store.get(jobId)?.status, "completed");
  assert.equal(end.outcome, "completed");
  assert.equal(end.pages, 19);
  assert.equal(end.stop, "completed");
  assert.equal(typeof end.ms, "number");
  assert.ok(!("reason" in end));
});

test("a partial audit reports the limit that stopped its crawl", async () => {
  const { lines, store, jobId } = await runOne(() => result({ evaluated: 150, stoppedBecause: "max-pages", complete: false }));
  const end = lines[lines.length - 1];

  assert.equal(store.get(jobId)?.status, "partial");
  assert.deepEqual([end.outcome, end.pages, end.stop], ["partial", 150, "max-pages"]);
});

for (const stop of ["max-duration", "max-queue", "deadline"] as const) {
  test(`the stop reason "${stop}" is written as it is`, async () => {
    const { lines } = await runOne(() => result({ stoppedBecause: stop, complete: false }));
    assert.equal(lines[lines.length - 1].stop, stop);
  });
}

test("an audit that read no page because of its certificate is partial, with that reason and no crawl", async () => {
  const { lines, store, jobId } = await runOne(() => ({ kind: "certificate-failure", website: {}, site: { findings: [], skippedChecks: [] } }));
  const end = lines[lines.length - 1];

  assert.equal(store.get(jobId)?.status, "partial");
  assert.deepEqual([end.outcome, end.reason, end.pages], ["partial", "certificate-failure", 0]);
  assert.ok(!("stop" in end));
});

test("an audit whose entry page could not be read is a failure of that kind, without its words", async () => {
  const { lines, captured, store, jobId } = await runOne(() => new EntryPageUnavailableError(SECRET_MESSAGE));
  const end = lines[lines.length - 1];

  assert.equal(store.get(jobId)?.status, "failed");
  assert.deepEqual([end.outcome, end.reason], ["failed", "entry-unavailable"]);
  assert.equal(typeof end.ms, "number");
  assert.ok(!("pages" in end) && !("stop" in end));
  assertPrivate(captured.all);
});

test("an unexpected failure is a failure of that kind, without its words", async () => {
  const { lines, captured, store, jobId } = await runOne(() => new TypeError(SECRET_MESSAGE));
  const end = lines[lines.length - 1];

  assert.equal(store.get(jobId)?.error, UNEXPECTED_FAILURE);
  assert.deepEqual([end.outcome, end.reason], ["failed", "unexpected"]);
  assertPrivate(captured.all);
});

test("every audit writes exactly one start and one end", async () => {
  for (const outcome of [() => result(), () => result({ complete: false, stoppedBecause: "max-pages" }), () => new Error("x")]) {
    const { lines } = await runOne(outcome);
    assert.deepEqual(
      lines.map((line) => (line.outcome === "started" ? "start" : "end")),
      ["start", "end"],
    );
  }
});

// ---------------------------------------------------------------------------
// Privacy and the allowlist
// ---------------------------------------------------------------------------

test("audit lines carry only approved fields, and nothing about the site", async () => {
  const { captured } = await runOne(() => result());

  for (const line of captured.lines) {
    for (const name of Object.keys(line)) {
      assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is not an approved field`);
    }
  }
  assertPrivate(captured.all);
});

test("a stop reason that is not one of the crawl's own codes is not written", async () => {
  const { lines } = await runOne(() => result({ stoppedBecause: "https://harbour-dental-sentinel.example/" as never }));
  const end = lines[lines.length - 1];

  assert.equal(end.outcome, "completed", "the line is still written");
  assert.ok(!("stop" in end), "without the value that was not a code");
});

test("a page count or wait that is not a whole number is not written", async () => {
  const { lines } = await runOne(() => result({ evaluated: -3 as never }));
  assert.ok(!("pages" in lines[lines.length - 1]));

  const captured = await captureLog(() =>
    logOutcome({ op: "audit.run", outcome: "started", waitMs: 1.5 } as never),
  );
  assert.ok(!("waitMs" in captured.lines[0]));
});

test("the audit.run outcomes and reasons are exactly the ones listed", () => {
  assert.deepEqual([...reliabilityWords("audit.run").outcomes], ["started", "completed", "partial", "failed"]);
  assert.deepEqual([...reliabilityWords("audit.run").reasons], ["entry-unavailable", "unexpected", "certificate-failure"]);
  assert.ok(reliabilityWords("page.parse").outcomes.includes("measured"));
});

// ---------------------------------------------------------------------------
// The log cannot change the audit
// ---------------------------------------------------------------------------

test("an audit ends the same way when the console cannot be written to", async () => {
  for (const outcome of [() => result(), () => result({ complete: false, stoppedBecause: "max-pages" }), () => new EntryPageUnavailableError("gone")]) {
    const quiet = await runOne(outcome);

    const store = freshStore();
    const audit = gated(outcome);
    const real = console.log;
    console.log = () => {
      throw new Error("the console is closed");
    };
    let jobId = "";
    try {
      const started = startAudit(SECRET_URL, { store, runImpl: audit.runImpl });
      jobId = started.jobId;
      await settle();
      audit.release();
      await started.finished;
    } finally {
      console.log = real;
    }

    const broken = store.get(jobId);
    const expected = quiet.store.get(quiet.jobId);
    assert.equal(broken?.status, expected?.status);
    assert.equal(broken?.error, expected?.error);
  }
});

test("a result that cannot be read for the log costs the line, never the audit", async () => {
  // The crawl summary answers once -- when the job decides whether the audit is
  // partial -- and throws every time after, as a strangely built result might.
  let reads = 0;
  const odd = result();
  Object.defineProperty(odd, "crawl", {
    get() {
      reads += 1;
      if (reads > 1) throw new Error("https://harbour-dental-sentinel.example/ must not be printed");
      return summary();
    },
  });

  const { lines, store, jobId, captured } = await runOne(() => odd);

  assert.equal(store.get(jobId)?.status, "completed", "the audit finished as it would have");
  assert.equal(lines.filter((line) => line.outcome === "completed").length, 0, "and only its end line is missing");
  assert.equal(lines.filter((line) => line.outcome === "started").length, 1);
  assertPrivate(captured.all);
});

// ---------------------------------------------------------------------------
// How long each page took
// ---------------------------------------------------------------------------

const ROOT = "https://example.com/";
const SITE: FakeSite = {
  [ROOT]: { html: `<!doctype html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1><a href="/a">a</a><a href="/b">b</a></body></html>` },
  [`${ROOT}a`]: { html: `<!doctype html><html lang="en"><head><title>A</title></head><body><h1>A</h1><p>${"words ".repeat(30_000)}</p></body></html>` },
  [`${ROOT}b`]: { html: `<!doctype html><html lang="en"><head><title>B</title></head><body><h1>B</h1></body></html>` },
};

test("after each page is parsed and checked, a line says how long that took", async () => {
  const captured = await captureLog(() =>
    withNetworkUnplugged(() =>
      runSiteAudit({
        requestedUrl: ROOT,
        jobId: "4c7e9a21-0000-4000-8000-000000000000",
        crawl: { fetchImpl: fetcherFor(SITE), sitemapFetchImpl: siteFilesFor(), useSitemaps: false, sleepImpl: async () => {}, limits: { concurrency: 1 } },
        siteChecksImpl: siteChecksFor(),
      }),
    ),
  );
  const lines = linesFor(captured, "page.parse");
  const parsing = lines.filter((line) => line.outcome === "parsing");
  const measured = lines.filter((line) => line.outcome === "measured");

  assert.equal(parsing.length, 3);
  assert.equal(measured.length, 3, "one for each page parsed");
  for (const line of measured) {
    assert.equal(line.job, "4c7e9a21");
    assert.ok(Number.isInteger(line.ms) && (line.ms as number) >= 0, `ms ${String(line.ms)}`);
    assert.equal(typeof line.size, "string");
    // Each page's "measured" line comes after its own "parsing" line.
    const start = lines.findIndex((other) => other.outcome === "parsing" && other.order === line.order);
    assert.ok(start !== -1 && start < lines.indexOf(line), `page ${String(line.order)}`);
  }
  assert.deepEqual(measured.map((line) => line.order), [1, 2, 3]);
  assert.equal(measured[1].size, "100kb-500kb", "the larger page is in its band");
  assertPrivate(captured.all);
});

test("a page too large to analyse has no measured line, because it was not parsed", async () => {
  const big: FakeSite = {
    [ROOT]: { html: `<!doctype html><html><body><a href="/big">big</a></body></html>` },
    [`${ROOT}big`]: { html: `<p>${"x".repeat(1_600_000)}</p>` },
  };

  const captured = await captureLog(() =>
    withNetworkUnplugged(() =>
      runSiteAudit({
        requestedUrl: ROOT,
        crawl: { fetchImpl: fetcherFor(big), sitemapFetchImpl: siteFilesFor(), useSitemaps: false, sleepImpl: async () => {} },
        siteChecksImpl: siteChecksFor(),
      }),
    ),
  );
  const lines = linesFor(captured, "page.parse");

  assert.deepEqual(
    lines.map((line) => line.outcome).sort(),
    ["measured", "parsing", "skipped"],
    "the home page parsed and measured; the big page skipped",
  );
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

test("durations come from the monotonic clock and are whole, non-negative milliseconds", async () => {
  const since = performance.now();
  await sleep(20);
  const elapsed = elapsedMs(since);

  assert.ok(Number.isInteger(elapsed) && elapsed >= 15, `elapsed ${elapsed}`);
  assert.equal(elapsedMs(performance.now() + 10_000), 0, "a start in the future is never a negative duration");
});
