/**
 * Tests for the limit on how many audits run at once.
 *
 * THE PROBLEM THIS SOLVES. Before the job API, POST /api/audit did the whole
 * audit while the caller waited, so the ten-per-minute request limit bounded
 * the WORK as well as the requests. Now POST returns in milliseconds and the
 * crawl carries on behind it — so ten accepted requests meant ten simultaneous
 * crawls, thirty outbound workers, and ten sets of results in memory.
 *
 * The invariant defended below is one line: at no moment may more than
 * MAX_CONCURRENT_AUDITS audits be running. Not "at the end" — at no moment.
 *
 * THAT LIMIT IS ONE. It was two until the server ran out of memory in the
 * middle of an audit: each running audit holds its own crawl, so two at once
 * is twice the peak. The last section below is about that default. The rest is
 * about the scheduler, and asks for two slots by name so that it can be seen
 * choosing between them.
 *
 * Every audit here is a controlled promise the test releases by hand, so
 * nothing waits on real time and nothing reaches the network.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  queuedAuditCount,
  runningAuditCount,
  startAudit,
  UNEXPECTED_FAILURE,
} from "./auditJobs.ts";
import { createJobStore, type JobStore } from "./jobStore.ts";
import { MAX_CONCURRENT_AUDITS } from "../budgets.ts";
import { EntryPageUnavailableError } from "../audit/siteAudit.ts";
import type { SiteAuditResult } from "../types";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const summary = (complete: boolean): SiteCrawlSummary => ({
  requestedUrl: "https://fixture.test/",
  limits: {
    maxPages: 150,
    maxDurationMs: 300_000,
    maxQueueSize: 2_000,
    maxResponseBytes: 5_000_000,
    concurrency: 3,
    perRequestDelayMs: 200,
  },
  stoppedBecause: complete ? "completed" : "max-pages",
  complete,
  discovered: 1,
  queuedAtStop: 0,
  evaluated: 1,
  unavailable: [],
  skippedNonHtml: 0,
  sources: { html: 0, sitemap: 0 },
  sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
  robots: { status: "absent", enforced: true, excluded: 0 },
});

const auditResult = (complete = true): SiteAuditResult => ({
  data: {} as SiteAuditResult["data"],
  site: { findings: [], skippedChecks: [], evaluatedPages: 1 },
  pages: [],
  crawl: summary(complete),
});

/**
 * A set of audits the test opens and closes by hand.
 *
 * Each run parks until released by name, which is what makes "how many are
 * running right now" an observable fact rather than a guess.
 */
function controlledAudits() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  /** The highest number seen running at any instant, not just at the end. */
  let peak = 0;

  const runImpl = (outcome: (url: string) => SiteAuditResult | Error = () => auditResult()) =>
    (async (options: { requestedUrl: string }) => {
      started.push(options.requestedUrl);
      peak = Math.max(peak, runningAuditCount());

      await new Promise<void>((resolve) => gates.set(options.requestedUrl, resolve));

      peak = Math.max(peak, runningAuditCount());
      const answer = outcome(options.requestedUrl);
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as typeof import("../audit/siteAudit.ts").runSiteAudit;

  return {
    runImpl,
    started,
    get peak() {
      return peak;
    },
    release(url: string): boolean {
      const gate = gates.get(url);
      if (gate === undefined) return false;
      gates.delete(url);
      gate();
      return true;
    },
    releaseAll(): void {
      for (const [url, gate] of [...gates]) {
        gates.delete(url);
        gate();
      }
    },
  };
}

/** Lets queued microtasks run, so a released job can actually finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const freshStore = (): JobStore<SiteAuditResult> => createJobStore<SiteAuditResult>();

/**
 * Two slots, asked for by name.
 *
 * THE SERVER RUNS ONE AUDIT AT A TIME; MOST OF THIS FILE IS NOT ABOUT THAT. It
 * is about the scheduler: that a slot is reserved before anything is awaited,
 * that the oldest waiting audit is the next to start, that every way an audit
 * can end gives its slot back. Those are only visible with more than one slot,
 * so these tests ask for two outright. They used to get two from the default,
 * and would have gone on passing or failing with whatever the default became.
 *
 * What the server actually does by default has its own section at the end.
 */
const TWO = 2;

/**
 * Drains the shared scheduler between tests.
 *
 * The scheduler is one object for the process, exactly as it is in the server,
 * so a test that left a job running would spend a slot belonging to the next.
 */
async function drainScheduler(audits: ReturnType<typeof controlledAudits>) {
  for (let turn = 0; turn < 50 && (runningAuditCount() > 0 || queuedAuditCount() > 0); turn += 1) {
    audits.releaseAll();
    await settle();
  }
  assert.equal(runningAuditCount(), 0, "a test leaked a running slot");
  assert.equal(queuedAuditCount(), 0, "a test leaked a queued job");
}

/** Releases everything and waits for every job to be done. */
async function finishAll(
  audits: ReturnType<typeof controlledAudits>,
  jobs: Array<{ finished: Promise<void> }>,
) {
  for (let turn = 0; turn < 30; turn += 1) {
    audits.releaseAll();
    await settle();
  }

  /*
   * Bounded on purpose. A slot that is never released leaves queued jobs that
   * can never begin, so waiting for them would hang the suite instead of
   * failing it — and a hanging test says nothing about what went wrong.
   */
  const stalled = Symbol("stalled");
  const outcome = await Promise.race([
    Promise.all(jobs.map((job) => job.finished)),
    new Promise((resolve) => setTimeout(() => resolve(stalled), 200)),
  ]);
  assert.notEqual(outcome, stalled, "a job never finished — a slot was probably not released");

  await drainScheduler(audits);
}

// ---------------------------------------------------------------------------
// The limit
// ---------------------------------------------------------------------------

test("the configured limit is one, and it is not the crawler's concurrency", () => {
  assert.equal(MAX_CONCURRENT_AUDITS, 1);
  // Different numbers for different things: this bounds AUDITS, while the
  // crawler's own concurrency bounds pages within one audit and is still 3.
  assert.equal(summary(true).limits.concurrency, 3);
});

test("with two slots, the first two audits start immediately; the third waits", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();

  assert.equal(runningAuditCount(), 2);
  assert.equal(queuedAuditCount(), 1);
  assert.deepEqual(audits.started, ["https://a.test/", "https://b.test/"]);

  // And the third has NOT begun its crawl — that is the whole point.
  assert.equal(store.get(c.jobId)?.status, "queued");
  assert.equal(store.get(a.jobId)?.status, "running");
  assert.equal(store.get(b.jobId)?.status, "running");

  await finishAll(audits, [a, b, c]);
});

test("a queued job still gets its id straight away", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c", "d"].map((n) =>
    startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  );

  // A full queue is not a reason to refuse a valid audit.
  for (const job of jobs) {
    assert.ok(job.jobId.length > 0);
    assert.notEqual(store.get(job.jobId), null);
  }

  await settle();
  assert.equal(queuedAuditCount(), 2, "c and d are waiting");

  await finishAll(audits, jobs);
});

test("NEVER more than the limit run, at any instant", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  // Eight submitted at once, as eight near-simultaneous POSTs would be.
  const jobs = Array.from({ length: 8 }, (_, i) =>
    startAudit(`https://s${i}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  );

  for (let turn = 0; turn < 20; turn += 1) {
    await settle();
    assert.ok(
      runningAuditCount() <= TWO,
      `${runningAuditCount()} audits were running at once`,
    );
    audits.releaseAll();
  }

  await Promise.all(jobs.map((job) => job.finished));
  assert.equal(audits.peak, TWO, "the limit was reached but never passed");
  await drainScheduler(audits);
});

test("submissions arriving in the same tick cannot both take the last slot", async () => {
  /*
   * The check-then-act race, if there were one. Four audits are created in a
   * single synchronous run of statements, with no chance for the event loop to
   * interleave — which is exactly when a reservation made after an await would
   * hand the same slot out twice.
   */
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = [
    startAudit("https://one.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
    startAudit("https://two.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
    startAudit("https://three.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
    startAudit("https://four.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  ];

  assert.equal(runningAuditCount(), TWO, "reserved synchronously");
  assert.equal(queuedAuditCount(), 2);

  await finishAll(audits, jobs);
});

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

test("when a slot frees, the OLDEST queued audit starts", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c", "d"].map((n) =>
    startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  );

  await settle();
  assert.deepEqual(audits.started, ["https://a.test/", "https://b.test/"]);

  // A finishes: C is next, not D.
  audits.release("https://a.test/");
  await settle();
  assert.deepEqual(audits.started, [
    "https://a.test/",
    "https://b.test/",
    "https://c.test/",
  ]);
  assert.equal(store.get(jobs[3].jobId)?.status, "queued", "D still waits its turn");

  // B finishes: now D.
  audits.release("https://b.test/");
  await settle();
  assert.deepEqual(audits.started, [
    "https://a.test/",
    "https://b.test/",
    "https://c.test/",
    "https://d.test/",
  ]);

  await finishAll(audits, jobs);
});

test("order is preserved across a longer queue", async () => {
  const store = freshStore();
  const audits = controlledAudits();
  const expected = Array.from({ length: 6 }, (_, i) => `https://q${i}.test/`);

  const jobs = expected.map((url) => startAudit(url, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }));

  await finishAll(audits, jobs);

  assert.deepEqual(audits.started, expected, "started in submission order");
});

// ---------------------------------------------------------------------------
// Releasing the slot
// ---------------------------------------------------------------------------

test("a completed audit releases its slot", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();
  audits.release("https://a.test/");
  await a.finished;

  assert.equal(store.get(a.jobId)?.status, "completed");
  assert.ok(audits.started.includes("https://c.test/"), "the slot went to the next audit");

  await finishAll(audits, [b, c]);
});

test("a PARTIAL audit releases its slot", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", {
    store,
    runImpl: audits.runImpl(() => auditResult(false)),
    maxConcurrent: TWO,
  });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();
  audits.release("https://a.test/");
  await a.finished;

  assert.equal(store.get(a.jobId)?.status, "partial");
  assert.ok(audits.started.includes("https://c.test/"));

  await finishAll(audits, [b, c]);
});

test("a FAILED audit releases its slot", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", {
    store,
    runImpl: audits.runImpl(
      () => new EntryPageUnavailableError("That address could not be found."),
    ),
    maxConcurrent: TWO,
  });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();
  audits.release("https://a.test/");
  await a.finished;

  assert.equal(store.get(a.jobId)?.status, "failed");
  // A failed audit must never permanently block the queue behind it.
  assert.ok(audits.started.includes("https://c.test/"));

  await finishAll(audits, [b, c]);
});

test("an UNEXPECTED exception releases its slot too", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", {
    store,
    runImpl: audits.runImpl(() => new Error("something nobody predicted")),
    maxConcurrent: TWO,
  });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();
  audits.release("https://a.test/");
  await a.finished;

  assert.equal(store.get(a.jobId)?.status, "failed");
  assert.equal(store.get(a.jobId)?.error, UNEXPECTED_FAILURE);
  assert.ok(audits.started.includes("https://c.test/"), "the slot came back");

  await finishAll(audits, [b, c]);
});

// ---------------------------------------------------------------------------
// What a queued job may claim
// ---------------------------------------------------------------------------

test("a queued job claims no progress it has not made", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c"].map((n) =>
    startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  );

  await settle();
  const waiting = store.get(jobs[2].jobId);

  assert.equal(waiting?.status, "queued");
  // Every counter zero, and `complete` false. Nothing has happened, and
  // nothing pretends otherwise.
  assert.equal(waiting?.progress.discovered, 0);
  assert.equal(waiting?.progress.evaluated, 0);
  assert.equal(waiting?.progress.unavailable, 0);
  assert.equal(waiting?.progress.complete, false);
  assert.equal(waiting?.result, null);
  assert.equal(waiting?.error, null);

  await finishAll(audits, jobs);
});

test("a job is only marked running once it truly is", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c"].map((n) =>
    startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: TWO }),
  );

  await settle();
  assert.equal(store.get(jobs[2].jobId)?.status, "queued");
  assert.ok(!audits.started.includes("https://c.test/"), "its crawl has not begun");

  audits.release("https://a.test/");
  await settle();

  assert.equal(store.get(jobs[2].jobId)?.status, "running");
  assert.ok(audits.started.includes("https://c.test/"));

  await finishAll(audits, jobs);
});

// ---------------------------------------------------------------------------
// Lifecycle edges
// ---------------------------------------------------------------------------

test("a job that expired while queued takes no slot", async () => {
  let clock = 0;
  const store = createJobStore<SiteAuditResult>({ ttlMs: 1_000, now: () => clock });
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });
  const c = startAudit("https://c.test/", { store, runImpl: audits.runImpl(), maxConcurrent: TWO });

  await settle();
  // C waits so long that it is swept away before a slot ever frees.
  clock += 2_000;

  await finishAll(audits, [a, b, c]);

  assert.equal(store.get(c.jobId), null, "it expired, as the TTL says it should");
  assert.ok(!audits.started.includes("https://c.test/"), "and it never ran");
});

test("the limit can be raised or lowered for a run", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c"].map((n) =>
    startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl(), maxConcurrent: 1 }),
  );

  await settle();
  assert.equal(runningAuditCount(), 1, "one at a time when asked for");
  assert.deepEqual(audits.started, ["https://a.test/"]);

  await finishAll(audits, jobs);
});

// ---------------------------------------------------------------------------
// The default: one audit at a time
//
// No test below passes `maxConcurrent`. What they see is what the server does.
// ---------------------------------------------------------------------------

test("by default one audit runs and the second waits", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl() });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl() });

  await settle();

  assert.equal(runningAuditCount(), 1);
  assert.equal(queuedAuditCount(), 1);
  assert.deepEqual(audits.started, ["https://a.test/"], "the second has not begun its crawl");
  assert.equal(store.get(a.jobId)?.status, "running");
  assert.equal(store.get(b.jobId)?.status, "queued");

  await finishAll(audits, [a, b]);
});

test("by default a waiting audit is accepted at once, never refused", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = ["a", "b", "c", "d"].map((n) => startAudit(`https://${n}.test/`, { store, runImpl: audits.runImpl() }));

  for (const job of jobs) {
    assert.ok(job.jobId.length > 0, "it has its id");
    assert.notEqual(store.get(job.jobId), null, "and its job");
  }
  assert.equal(runningAuditCount(), 1, "one reserved synchronously");
  assert.equal(queuedAuditCount(), 3, "and the rest wait");

  await finishAll(audits, jobs);
});

test("by default NEVER more than one audit runs, at any instant", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const jobs = Array.from({ length: 6 }, (_, i) => startAudit(`https://s${i}.test/`, { store, runImpl: audits.runImpl() }));

  for (let turn = 0; turn < 20; turn += 1) {
    await settle();
    assert.ok(runningAuditCount() <= 1, `${runningAuditCount()} audits were running at once`);
    audits.releaseAll();
  }

  await Promise.all(jobs.map((job) => job.finished));
  assert.equal(audits.peak, 1, "two audits never overlapped");
  assert.deepEqual(audits.started, jobs.map((_, i) => `https://s${i}.test/`), "and they ran in the order they arrived");
  await drainScheduler(audits);
});

test("by default the waiting audit starts only when the running one has ended", async () => {
  const store = freshStore();
  const audits = controlledAudits();

  const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl() });
  const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl() });

  // However long the first takes, the second does not start beside it.
  for (let turn = 0; turn < 5; turn += 1) {
    await settle();
    assert.deepEqual(audits.started, ["https://a.test/"]);
    assert.equal(store.get(b.jobId)?.status, "queued");
  }

  audits.release("https://a.test/");
  await a.finished;
  await settle();

  assert.equal(store.get(a.jobId)?.status, "completed");
  assert.equal(store.get(b.jobId)?.status, "running", "now it is its turn");
  assert.equal(runningAuditCount(), 1);

  await finishAll(audits, [a, b]);
});

test("by default an audit that fails, expectedly or not, still lets the next one start", async () => {
  for (const failure of [new EntryPageUnavailableError("That address could not be found."), new Error("something nobody predicted")]) {
    const store = freshStore();
    const audits = controlledAudits();

    const a = startAudit("https://a.test/", { store, runImpl: audits.runImpl(() => failure) });
    const b = startAudit("https://b.test/", { store, runImpl: audits.runImpl() });

    await settle();
    audits.release("https://a.test/");
    await a.finished;
    await settle();

    assert.equal(store.get(a.jobId)?.status, "failed");
    assert.ok(audits.started.includes("https://b.test/"), "the only slot came back");

    await finishAll(audits, [a, b]);
  }
});
