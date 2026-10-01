/**
 * Tests for the registration rate limit — its own bucket, in memory.
 *
 * Driven directly with a caller key and a clock, the way the audit limiter is,
 * so the sliding window and the two ceilings are exercised without any request
 * plumbing.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  REGISTER_GLOBAL,
  REGISTER_PER_CALLER,
  checkRegisterLimit,
  resetRegisterLimits,
} from "./registerLimit.ts";

const NOW = 1_757_000_000_000;
const WINDOW_MS = 15 * 60 * 1000;

test("a caller may register up to the per-caller limit, then is refused", () => {
  resetRegisterLimits();

  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) {
    assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, true, `attempt ${i}`);
  }

  const blocked = checkRegisterLimit("1.2.3.4", NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "caller");
  assert.ok(blocked.retryAfterSeconds > 0);
});

test("a blocked attempt is not recorded, so it does not extend the lockout", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) checkRegisterLimit("1.2.3.4", NOW);

  // Hammer while blocked; none of these should push the window forward.
  for (let i = 0; i < 5; i += 1) checkRegisterLimit("1.2.3.4", NOW);

  // The moment the oldest real attempt ages out, one more is allowed again.
  assert.equal(checkRegisterLimit("1.2.3.4", NOW + WINDOW_MS + 1).allowed, true);
});

test("one caller's limit does not touch another's", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) checkRegisterLimit("1.1.1.1", NOW);

  assert.equal(checkRegisterLimit("1.1.1.1", NOW).allowed, false, "the first is spent");
  assert.equal(checkRegisterLimit("2.2.2.2", NOW).allowed, true, "the second is untouched");
});

test("the global ceiling catches many callers each under their own limit", () => {
  resetRegisterLimits();

  // Distinct callers, a few each, up to the global ceiling.
  let count = 0;
  for (let caller = 0; count < REGISTER_GLOBAL; caller += 1) {
    assert.equal(checkRegisterLimit(`ip-${caller}`, NOW).allowed, true, `global attempt ${count}`);
    count += 1;
  }

  const blocked = checkRegisterLimit("ip-fresh", NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "global", "the server-wide ceiling answered, not the caller's own");
});

test("the window slides: old attempts stop counting", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) checkRegisterLimit("1.2.3.4", NOW);

  assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, false, "spent now");
  assert.equal(checkRegisterLimit("1.2.3.4", NOW + WINDOW_MS + 1).allowed, true, "but not a window later");
});

test("reset forgets everything", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) checkRegisterLimit("1.2.3.4", NOW);
  assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, false);

  resetRegisterLimits();
  assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, true);
});
