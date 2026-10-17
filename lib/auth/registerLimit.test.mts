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
import { UNATTRIBUTED } from "../callerAddress.ts";

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

/* ---------------------------------------------------------------------------
   The unattributed caller: everybody whose address could not be read
   --------------------------------------------------------------------------- */

test("unattributed sign-ups are held by the global ceiling, not a shared per-caller five", () => {
  resetRegisterLimits();

  for (let i = 0; i < REGISTER_GLOBAL; i += 1) {
    assert.equal(checkRegisterLimit(UNATTRIBUTED, NOW).allowed, true, `attempt ${i}`);
  }

  const blocked = checkRegisterLimit(UNATTRIBUTED, NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "global");
  assert.ok(blocked.retryAfterSeconds > 0);
});

test("unattributed sign-ups spend the same global budget identified callers use", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_GLOBAL - 1; i += 1) checkRegisterLimit(UNATTRIBUTED, NOW);

  assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, true, "the last place in the window");
  const blocked = checkRegisterLimit("5.6.7.8", NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "global");
});

test("unattributed sign-ups do not use up an identified caller's own five", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) checkRegisterLimit(UNATTRIBUTED, NOW);

  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) {
    assert.equal(checkRegisterLimit("1.2.3.4", NOW).allowed, true, `identified attempt ${i}`);
  }
  const blocked = checkRegisterLimit("1.2.3.4", NOW);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "caller", "the identified caller's own limit is unchanged");
});

test("the global window still slides for unattributed sign-ups", () => {
  resetRegisterLimits();
  for (let i = 0; i < REGISTER_GLOBAL; i += 1) checkRegisterLimit(UNATTRIBUTED, NOW);
  assert.equal(checkRegisterLimit(UNATTRIBUTED, NOW + WINDOW_MS - 1).allowed, false);
  assert.equal(checkRegisterLimit(UNATTRIBUTED, NOW + WINDOW_MS + 1).allowed, true);
});
