/**
 * Tests for the in-memory job store.
 *
 * The properties that matter: a job's outcome is written exactly once, an
 * expired job is gone rather than stale, and nothing here ever invents a state
 * for something it no longer holds.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  createJobStore,
  EMPTY_PROGRESS,
  isTerminal,
  JOB_TTL_MS,
  type JobProgress,
} from "./jobStore.ts";

/** A store with a clock and ids the test drives by hand. */
function storeAt(startMs = 0, ttlMs = 1_000) {
  let value = startMs;
  let counter = 0;
  const store = createJobStore<{ tag: string }>({
    ttlMs,
    now: () => value,
    newId: () => `job-${++counter}`,
  });
  return { store, advance: (ms: number) => (value += ms), now: () => value };
}

const progress = (overrides: Partial<JobProgress> = {}): JobProgress => ({
  ...EMPTY_PROGRESS,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Creating and reading
// ---------------------------------------------------------------------------

test("a new job starts queued, with nothing measured", () => {
  const { store } = storeAt();
  const job = store.create("https://example.com/");

  assert.equal(job.status, "queued");
  assert.equal(job.requestedUrl, "https://example.com/");
  assert.equal(job.result, null);
  assert.equal(job.error, null);
  // Not a hopeful zero-of-something: nothing has happened yet.
  assert.deepEqual(job.progress, EMPTY_PROGRESS);
  assert.equal(job.progress.complete, false);
});

test("a job can be read back by its id", () => {
  const { store } = storeAt();
  const created = store.create("https://example.com/");

  assert.equal(store.get(created.id)?.id, created.id);
});

test("every job gets its own id", () => {
  const store = createJobStore<{ tag: string }>();
  const ids = new Set(Array.from({ length: 20 }, () => store.create("https://x.test/").id));

  assert.equal(ids.size, 20);
});

test("callers get a snapshot, never the store's own record", () => {
  // Handing out the live object would let anything holding it rewrite a job's
  // status by accident, and a route holding one across an await would read
  // state that had changed underneath it.
  const { store } = storeAt();
  const created = store.create("https://example.com/");

  created.status = "completed";
  created.result = { tag: "forged" };
  created.progress.evaluated = 999;

  const stored = store.get(created.id);
  assert.equal(stored?.status, "queued");
  assert.equal(stored?.result, null);
  assert.equal(stored?.progress.evaluated, 0);

  // And the same for a read: mutating what get() returned changes nothing.
  if (stored !== null && stored !== undefined) stored.status = "failed";
  assert.equal(store.get(created.id)?.status, "queued");
});

test("an unknown id is null, not an invented job", () => {
  const { store } = storeAt();

  assert.equal(store.get("no-such-job"), null);
  assert.equal(store.get(""), null);
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test("queued to running to completed", () => {
  const { store } = storeAt();
  const { id } = store.create("https://example.com/");

  store.markRunning(id);
  assert.equal(store.get(id)?.status, "running");

  store.finish(id, "completed", { tag: "done" });
  assert.equal(store.get(id)?.status, "completed");
  assert.deepEqual(store.get(id)?.result, { tag: "done" });
});

test("a partial crawl is its own terminal state, with its result kept", () => {
  const { store } = storeAt();
  const { id } = store.create("https://example.com/");

  store.markRunning(id);
  store.finish(id, "partial", { tag: "some-of-it" });

  const job = store.get(id);
  assert.equal(job?.status, "partial");
  // The findings are real and are still there. What changed is the claim.
  assert.deepEqual(job?.result, { tag: "some-of-it" });
  assert.equal(job?.progress.complete, false, "partial is never complete");
});

test("completing sets progress.complete; partial does not", () => {
  const { store } = storeAt();

  const a = store.create("https://a.test/");
  store.finish(a.id, "completed", { tag: "x" });
  assert.equal(store.get(a.id)?.progress.complete, true);

  const b = store.create("https://b.test/");
  store.finish(b.id, "partial", { tag: "x" });
  assert.equal(store.get(b.id)?.progress.complete, false);
});

test("a failed job keeps its message and holds no result", () => {
  const { store } = storeAt();
  const { id } = store.create("https://example.com/");

  store.markRunning(id);
  store.fail(id, "That website address could not be found.");

  const job = store.get(id);
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "That website address could not be found.");
  assert.equal(job?.result, null);
});

test("THE FIRST TERMINAL WRITE WINS", () => {
  // A late error must not overwrite a good result, and a result must not
  // overwrite a failure that already happened.
  const { store } = storeAt();

  const a = store.create("https://a.test/");
  store.finish(a.id, "completed", { tag: "first" });
  store.finish(a.id, "partial", { tag: "second" });
  store.fail(a.id, "too late");
  assert.equal(store.get(a.id)?.status, "completed");
  assert.deepEqual(store.get(a.id)?.result, { tag: "first" });

  const b = store.create("https://b.test/");
  store.fail(b.id, "the real reason");
  store.finish(b.id, "completed", { tag: "too late" });
  assert.equal(store.get(b.id)?.status, "failed");
  assert.equal(store.get(b.id)?.error, "the real reason");
  assert.equal(store.get(b.id)?.result, null);
});

test("a terminal job stops accepting progress", () => {
  const { store } = storeAt();
  const { id } = store.create("https://example.com/");

  store.finish(id, "completed", { tag: "x" });
  store.setProgress(id, progress({ evaluated: 99 }));
  store.markRunning(id);

  assert.equal(store.get(id)?.status, "completed");
  assert.equal(store.get(id)?.progress.evaluated, 0);
});

test("updating an unknown job does nothing and throws nothing", () => {
  const { store } = storeAt();

  store.markRunning("nope");
  store.setProgress("nope", progress({ evaluated: 5 }));
  store.finish("nope", "completed", { tag: "x" });
  store.fail("nope", "x");

  assert.equal(store.size, 0);
});

test("isTerminal names exactly the three states that never change again", () => {
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("partial"), true);
  assert.equal(isTerminal("failed"), true);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("progress is stored as given, and copied rather than shared", () => {
  const { store } = storeAt();
  const { id } = store.create("https://example.com/");

  const live = progress({ discovered: 40, queued: 28, evaluated: 12 });
  store.setProgress(id, live);
  live.evaluated = 999;

  assert.equal(store.get(id)?.progress.evaluated, 12);
  assert.equal(store.get(id)?.progress.discovered, 40);
});

test("progress carries counts and never a percentage", () => {
  // There is no honest denominator while a crawl is running, so there is no
  // field here that could hold one.
  assert.deepEqual(Object.keys(EMPTY_PROGRESS).sort(), [
    "complete",
    "discovered",
    "evaluated",
    "queued",
    "robotsExcluded",
    "skippedNonHtml",
    "unavailable",
  ]);
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("a job disappears once its time is up", () => {
  const { store, advance } = storeAt(0, 1_000);
  const { id } = store.create("https://example.com/");

  advance(999);
  assert.notEqual(store.get(id), null);

  advance(1);
  assert.equal(store.get(id), null, "expired is gone, not stale");
  assert.equal(store.size, 0);
});

test("work on a job keeps it alive", () => {
  // A long crawl must not expire out from underneath itself.
  const { store, advance } = storeAt(0, 1_000);
  const { id } = store.create("https://example.com/");

  for (let i = 0; i < 5; i += 1) {
    advance(900);
    store.setProgress(id, progress({ evaluated: i }));
  }

  advance(900);
  assert.notEqual(store.get(id), null, "still alive after 4500ms of a 1000ms ttl");
});

test("a finished job stays readable for its full time, then goes", () => {
  const { store, advance } = storeAt(0, 1_000);
  const { id } = store.create("https://example.com/");
  store.finish(id, "completed", { tag: "x" });

  advance(999);
  assert.equal(store.get(id)?.status, "completed");

  advance(2);
  assert.equal(store.get(id), null);
});

test("sweeping drops only the jobs that are actually expired", () => {
  const { store, advance } = storeAt(0, 1_000);
  const old = store.create("https://old.test/");
  advance(600);
  const fresh = store.create("https://fresh.test/");
  advance(500);

  store.sweep();

  assert.equal(store.get(old.id), null);
  assert.notEqual(store.get(fresh.id), null);
  assert.equal(store.size, 1);
});

test("the default lifetime is half an hour", () => {
  assert.equal(JOB_TTL_MS, 30 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// ATTACHING SOMETHING MEASURED SEPARATELY
//
// One part of an audit is measured in its own request, on its own budget, and
// arrives after the job has already finished. It is attached rather than
// written into the outcome, so first-write-wins stays exactly as it was.
// ---------------------------------------------------------------------------

/** A store that also declares what may be attached to its jobs. */
function attachableStoreAt(startMs = 0, ttlMs = 1_000) {
  let value = startMs;
  let counter = 0;
  const store = createJobStore<{ tag: string }, { speed: string }>({
    ttlMs,
    now: () => value,
    newId: () => `job-${++counter}`,
  });
  return { store, advance: (ms: number) => (value += ms) };
}

test("a new job has nothing attached", () => {
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");

  assert.equal(job.attached, null);
});

test("a finished job accepts an attachment", () => {
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });

  store.attach(job.id, { speed: "measured" });

  assert.deepEqual(store.get(job.id)?.attached, { speed: "measured" });
});

test("attaching changes nothing about the outcome", () => {
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.finish(job.id, "partial", { tag: "audit" });

  store.attach(job.id, { speed: "measured" });

  const after = store.get(job.id);
  assert.equal(after?.status, "partial", "the crawl said partial and still does");
  assert.deepEqual(after?.result, { tag: "audit" });
  assert.equal(after?.error, null);
});

test("a job still running accepts nothing", () => {
  // There is no finished audit for it to belong beside yet.
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.markRunning(job.id);

  store.attach(job.id, { speed: "measured" });

  assert.equal(store.get(job.id)?.attached, null);
});

test("a failed job accepts nothing", () => {
  // There is no result for this to sit beside, and inventing a half-audit out
  // of one measurement would be worse than having none.
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.fail(job.id, "The page could not be read.");

  store.attach(job.id, { speed: "measured" });

  assert.equal(store.get(job.id)?.attached, null);
});

test("the first attachment wins, like the first terminal write", () => {
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });

  store.attach(job.id, { speed: "first" });
  store.attach(job.id, { speed: "second" });

  assert.deepEqual(store.get(job.id)?.attached, { speed: "first" });
});

test("attaching to a job that never existed does nothing and does not throw", () => {
  const { store } = attachableStoreAt();

  store.attach("no-such-job", { speed: "measured" });

  assert.equal(store.size, 0);
});

test("attaching to an expired job does nothing", () => {
  const { store, advance } = attachableStoreAt(0, 1_000);
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });

  advance(2_000);
  store.attach(job.id, { speed: "measured" });

  assert.equal(store.get(job.id), null, "the job is gone, and nothing recreated it");
});

test("an attachment travels on the snapshot, not by reference to the store", () => {
  const { store } = attachableStoreAt();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });
  store.attach(job.id, { speed: "measured" });

  const taken = store.get(job.id);
  assert.deepEqual(taken?.attached, { speed: "measured" });
  assert.deepEqual(store.get(job.id)?.attached, { speed: "measured" });
});

// ---------------------------------------------------------------------------
// THE EXPLANATION SLOT
//
// A second slot, for writing produced ABOUT the finished audit rather than
// measured for it. It carries a claim as well as a value, because asking a
// model is slow and costs money: the claim is what makes one audit cost one
// request however many times a browser asks.
// ---------------------------------------------------------------------------

/** A store declaring both slots, so neither can be tested by accident. */
function explainableStoreAt(startMs = 0, ttlMs = 1_000) {
  let value = startMs;
  let counter = 0;
  const store = createJobStore<{ tag: string }, { speed: string }, { prose: string }>({
    ttlMs,
    now: () => value,
    newId: () => `job-${++counter}`,
  });
  return { store, advance: (ms: number) => (value += ms) };
}

function finished(store: ReturnType<typeof explainableStoreAt>["store"]) {
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });
  return job.id;
}

test("a new job has no explanation and no claim on one", () => {
  const { store } = explainableStoreAt();
  const job = store.create("https://example.com");

  assert.equal(job.explanation, null);
  assert.equal(job.explanationClaimed, false);
});

test("exactly one caller may claim the right to explain a job", () => {
  const { store } = explainableStoreAt();
  const id = finished(store);

  assert.equal(store.claimExplanation(id), true);
  assert.equal(store.claimExplanation(id), false);
  assert.equal(store.claimExplanation(id), false);
});

test("a claim is refused before there is an audit to explain", () => {
  const { store } = explainableStoreAt();
  const job = store.create("https://example.com");

  assert.equal(store.claimExplanation(job.id), false, "queued");
  store.markRunning(job.id);
  assert.equal(store.claimExplanation(job.id), false, "running");
});

test("a failed job may not be explained", () => {
  const { store } = explainableStoreAt();
  const job = store.create("https://example.com");
  store.fail(job.id, "The entry page could not be read.");

  assert.equal(store.claimExplanation(job.id), false);
  store.setExplanation(job.id, { prose: "about nothing" });
  assert.equal(store.get(job.id)?.explanation, null);
});

test("a job that never existed, or expired, grants no claim", () => {
  const { store, advance } = explainableStoreAt();
  const id = finished(store);

  assert.equal(store.claimExplanation("no-such-job"), false);
  advance(2_000);
  assert.equal(store.claimExplanation(id), false);
});

test("the first explanation wins, like the first terminal write", () => {
  const { store } = explainableStoreAt();
  const id = finished(store);

  store.setExplanation(id, { prose: "the first answer" });
  store.setExplanation(id, { prose: "a second, different answer" });

  assert.deepEqual(store.get(id)?.explanation, { prose: "the first answer" });
});

test("explaining changes nothing about the audit or its other slot", () => {
  const { store } = explainableStoreAt();
  const id = finished(store);
  store.attach(id, { speed: "measured" });

  store.claimExplanation(id);
  store.setExplanation(id, { prose: "commentary" });

  const job = store.get(id);
  assert.equal(job?.status, "completed");
  assert.deepEqual(job?.result, { tag: "audit" });
  assert.equal(job?.error, null);
  assert.deepEqual(job?.attached, { speed: "measured" });
});

test("an explanation travels on the snapshot, not by reference to the store", () => {
  const { store } = explainableStoreAt();
  const id = finished(store);
  store.setExplanation(id, { prose: "commentary" });

  const taken = store.get(id);
  assert.ok(taken);
  taken.explanation = { prose: "rewritten by a caller" };

  assert.deepEqual(store.get(id)?.explanation, { prose: "commentary" });
});

test("an unfinished job stores no explanation even if one is offered", () => {
  const { store } = explainableStoreAt();
  const job = store.create("https://example.com");

  store.setExplanation(job.id, { prose: "premature" });

  assert.equal(store.get(job.id)?.explanation, null);
});

// ---------------------------------------------------------------------------
// The desktop slot: separate from the graded attachment
// ---------------------------------------------------------------------------

function desktopStore() {
  let counter = 0;
  return createJobStore<{ tag: string }, { speed: string }, never, { desktop: string }>({
    newId: () => `job-${++counter}`,
  });
}

test("a finished job keeps a desktop measurement in its own slot", () => {
  const store = desktopStore();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });

  store.attachDesktop(job.id, { desktop: "measured" });

  const after = store.get(job.id);
  assert.deepEqual(after?.desktop, { desktop: "measured" });
  assert.equal(after?.attached, null, "the graded slot is untouched");
  assert.deepEqual(after?.result, { tag: "audit" });
});

test("the desktop slot and the graded slot do not lock each other out", () => {
  const store = desktopStore();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", { tag: "audit" });

  store.attachDesktop(job.id, { desktop: "measured" });
  store.attach(job.id, { speed: "mobile" });

  assert.deepEqual(store.get(job.id)?.attached, { speed: "mobile" });
  assert.deepEqual(store.get(job.id)?.desktop, { desktop: "measured" });
});

test("desktop: unfinished or failed jobs accept nothing, and the first write wins", () => {
  const store = desktopStore();
  const running = store.create("https://example.com");
  store.markRunning(running.id);
  store.attachDesktop(running.id, { desktop: "early" });
  assert.equal(store.get(running.id)?.desktop, null);

  const failed = store.create("https://example.com");
  store.fail(failed.id, "It failed.");
  store.attachDesktop(failed.id, { desktop: "orphan" });
  assert.equal(store.get(failed.id)?.desktop, null);

  const done = store.create("https://example.com");
  store.finish(done.id, "completed", { tag: "audit" });
  store.attachDesktop(done.id, { desktop: "first" });
  store.attachDesktop(done.id, { desktop: "second" });
  assert.deepEqual(store.get(done.id)?.desktop, { desktop: "first" });

  store.attachDesktop("no-such-job", { desktop: "x" });
});
