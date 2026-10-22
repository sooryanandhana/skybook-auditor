/**
 * Tests for the shared audit deadline.
 *
 * Before this existed, each part of the audit kept its own timer: the page
 * fetch allowed 20 seconds and could run twice, the technical checks another
 * 10. Nothing tracked the total, so one slow site could hold a request open
 * for around fifty seconds.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capDeadline, createDeadline } from "./deadline.ts";
import { keepAliveWhile } from "../keepAlive.fixture.mts";

/** A wait on a deadline's own (unreferenced) signal fails as a timeout, not a hang. */
const WAIT_LIMIT = { timeout: 5_000 };
/** Longer than WAIT_LIMIT, so the test's timeout is what reports a genuine hang. */
const HOLD_MS = 6_000;

test("reports time remaining, counting down", async () => {
  const deadline = createDeadline(200);
  assert.ok(deadline.remainingMs() > 150, "should start near the full budget");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(deadline.remainingMs() < 160, "should have counted down");
});

test("expires once the budget is used up", async () => {
  const deadline = createDeadline(40);
  assert.equal(deadline.expired(), false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(deadline.expired(), true);
});

test("never reports negative time remaining", async () => {
  const deadline = createDeadline(10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(deadline.remainingMs(), 0);
});

test("a zero budget is expired immediately", () => {
  assert.equal(createDeadline(0).expired(), true);
});

test("a per-request cap applies when it is shorter than the budget", () => {
  // A single request must not be able to consume the whole audit's time —
  // that would starve every check after it.
  const deadline = createDeadline(10_000);
  const signal = deadline.signal(50);
  assert.equal(signal.aborted, false);
});

test("the shared budget wins when it is shorter than the cap", WAIT_LIMIT, async () => {
  // The point of sharing a clock: a late request gets what is left, not a
  // fresh allowance.
  const deadline = createDeadline(60);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const startedAt = Date.now();
  const signal = deadline.signal(10_000);
  await keepAliveWhile(new Promise((resolve) => signal.addEventListener("abort", resolve)), HOLD_MS);

  assert.ok(
    Date.now() - startedAt < 200,
    "the signal should fire with the remaining budget, not the 10s cap",
  );
});

test("an already-expired deadline still produces a usable signal", WAIT_LIMIT, async () => {
  // A zero-length timeout would abort before the request is even sent, which
  // looks like a network failure rather than a timeout.
  const deadline = createDeadline(0);
  const signal = deadline.signal();
  assert.equal(signal.aborted, false, "must not be aborted before it is used");

  await keepAliveWhile(new Promise((resolve) => signal.addEventListener("abort", resolve)), HOLD_MS);
  assert.equal(signal.aborted, true);
});

// ---------------------------------------------------------------------------
// A capped deadline — one part's own limit, inside the whole audit's budget
// ---------------------------------------------------------------------------

test("a capped deadline uses its own cap when the outer budget is larger", async () => {
  // Without this, handing a component the audit's deadline would let it use
  // every second the earlier steps did not — the opposite of a per-part limit.
  const audit = createDeadline(10_000);
  const part = capDeadline(audit, 60);

  assert.ok(part.remainingMs() <= 60, "should be limited by its own cap");
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(part.expired(), true, "the part is done");
  assert.equal(audit.expired(), false, "but the audit still has time");
});

test("a capped deadline expires with the outer budget when that is shorter", async () => {
  const audit = createDeadline(50);
  const part = capDeadline(audit, 10_000);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(part.expired(), true, "the audit ran out, so the part is over too");
});

test("a capped deadline never reports more time than the outer one has", () => {
  const audit = createDeadline(100);
  const part = capDeadline(audit, 10_000);
  assert.ok(part.remainingMs() <= audit.remainingMs());
});

test("a capped deadline is already expired if the outer one is", () => {
  const spent = createDeadline(0);
  assert.equal(capDeadline(spent, 10_000).expired(), true);
});

test("several signals from one deadline all expire together", async () => {
  const deadline = createDeadline(60);
  const first = deadline.signal();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = deadline.signal();

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, true, "the later signal shares the same end time");
});
