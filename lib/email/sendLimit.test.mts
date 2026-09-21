/**
 * Tests for how many client emails one caller may send.
 *
 * THE POINT OF THIS BUCKET IS THAT IT IS NOT THE OTHER BUCKETS. Most of what
 * is worth asserting here is about separation and about a refused attempt not
 * punishing the person who made it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { codeOnly } from "./provider.test.mts";
import {
  GLOBAL_SENDS,
  MAX_SENDS,
  SEND_RATE_LIMITED,
  SEND_WINDOW_MS,
  recordSend,
  resetSendLimit,
  sendAllowance,
} from "./sendLimit.ts";

const NOW = 1_757_000_000_000;

/**
 * Ask and then spend, which is what one call used to do.
 *
 * The two are separate now so that a request refused for some other reason
 * does not consume an allowance. These tests are about the counting, so they
 * do both and say so.
 */
const spend = (caller: string, now: number = NOW) => {
  const allowance = sendAllowance(caller, now);
  if (allowance.allowed) recordSend(caller, now);
  return allowance;
};

test("a caller may send up to the allowance and no further", () => {
  resetSendLimit();

  for (let n = 0; n < MAX_SENDS; n += 1) {
    assert.equal(spend("1.2.3.4", NOW).allowed, true, `send ${n}`);
  }

  assert.equal(spend("1.2.3.4", NOW).allowed, false);
});

test("the remaining count says what is left, not what was just used", () => {
  /*
   * IT READS BEFORE THE SPEND, because asking and spending are now separate
   * and the question is "may I send". A caller who has sent nothing has the
   * whole allowance, and each recorded send takes one.
   */
  resetSendLimit();

  assert.equal(sendAllowance("1.2.3.4", NOW).remaining, MAX_SENDS, "nothing sent yet");

  recordSend("1.2.3.4", NOW);
  assert.equal(sendAllowance("1.2.3.4", NOW).remaining, MAX_SENDS - 1);

  recordSend("1.2.3.4", NOW);
  assert.equal(sendAllowance("1.2.3.4", NOW).remaining, MAX_SENDS - 2);
});

test("one caller's sending does not stop anybody else", () => {
  resetSendLimit();
  for (let n = 0; n < MAX_SENDS; n += 1) spend("9.9.9.9", NOW);

  assert.equal(spend("1.2.3.4", NOW).allowed, true);
});

test("a refused attempt does not extend the caller's own wait", () => {
  /*
   * Otherwise somebody who hits the limit and keeps pressing keeps themselves
   * locked out for ever. The audit limiter settled this once already.
   */
  resetSendLimit();
  for (let n = 0; n < MAX_SENDS + 20; n += 1) spend("9.9.9.9", NOW);

  assert.equal(spend("9.9.9.9", NOW + SEND_WINDOW_MS + 1).allowed, true);
});

test("the window slides rather than resetting on a boundary", () => {
  // A counter that reset on the clock would let twice the limit through.
  resetSendLimit();
  for (let n = 0; n < MAX_SENDS; n += 1) spend("1.2.3.4", NOW + n);

  assert.equal(spend("1.2.3.4", NOW + SEND_WINDOW_MS - 1).allowed, false);
  assert.equal(spend("1.2.3.4", NOW + SEND_WINDOW_MS + 1).allowed, true);
});

test("a refused caller is told roughly how long to wait", () => {
  resetSendLimit();
  for (let n = 0; n < MAX_SENDS; n += 1) spend("1.2.3.4", NOW);

  const refused = spend("1.2.3.4", NOW);
  assert.equal(refused.retryAfterSeconds > 0, true);
  assert.equal(refused.retryAfterSeconds <= SEND_WINDOW_MS / 1000, true);
});

test("the allowance is tighter than anything else in the project", () => {
  /*
   * Deliberately. A salesperson sends a handful of reports a day and will
   * never meet this; a loop or a stuck retry meets it after a few messages
   * rather than after a few hundred.
   */
  assert.ok(MAX_SENDS <= 10, "a send allowance in single figures");
});

test("this bucket is not the audit limiter", () => {
  const source = codeOnly(fs.readFileSync(new URL("./sendLimit.ts", import.meta.url), "utf8"));

  assert.ok(!source.includes("checkRateLimit"), "it does not consult the audit limiter");
  assert.ok(!source.includes("rateLimit"), "and does not import it");
});

test("nothing is keyed on a recipient, so no client's address is remembered", () => {
  // The bucket counts who is sending, never who is being sent to. An address
  // book is the one thing this application has deliberately never had.
  const source = codeOnly(fs.readFileSync(new URL("./sendLimit.ts", import.meta.url), "utf8"));

  assert.ok(!source.includes("recipient"), "no recipient anywhere in the limiter");
  assert.ok(!source.includes("to:"), "and nothing shaped like an address");
});

test("the sentence a refused caller sees says what to do", () => {
  assert.match(SEND_RATE_LIMITED, /Wait a few minutes/);
  assert.ok(!SEND_RATE_LIMITED.includes("audit"), "and does not mention the audit allowance");
});

test("asking does not spend, however many times it is asked", () => {
  /*
   * THE WHOLE POINT OF THE SPLIT. A send request is refused for eight reasons
   * other than this limit, and every one of those used to consume an
   * allowance despite sending nothing.
   */
  resetSendLimit();

  for (let n = 0; n < 50; n += 1) {
    assert.equal(sendAllowance("1.2.3.4", NOW).allowed, true, `ask ${n}`);
  }

  assert.equal(sendAllowance("1.2.3.4", NOW).remaining, MAX_SENDS, "nothing was spent");
});

test("spending is what counts down, one at a time", () => {
  resetSendLimit();

  for (let n = 0; n < MAX_SENDS; n += 1) {
    assert.equal(sendAllowance("1.2.3.4", NOW).remaining, MAX_SENDS - n, `before spend ${n}`);
    recordSend("1.2.3.4", NOW);
  }

  assert.equal(sendAllowance("1.2.3.4", NOW).allowed, false);
});

/* ---------------------------------------------------------------------------
   The server-wide ceiling
   --------------------------------------------------------------------------- */

test("the whole server may send GLOBAL_SENDS before it refuses everyone", () => {
  resetSendLimit();
  // Spread across many distinct callers, each well under their own MAX_SENDS.
  let sent = 0;
  for (let i = 0; i < GLOBAL_SENDS + 10; i += 1) {
    const caller = `203.0.113.${i}`;
    if (sendAllowance(caller, NOW).allowed) {
      recordSend(caller, NOW);
      sent += 1;
    }
  }
  assert.equal(sent, GLOBAL_SENDS, "the ceiling holds however the sends are spread");
});

test("the ceiling refuses a caller who still has their own allowance", () => {
  resetSendLimit();
  for (let i = 0; i < GLOBAL_SENDS; i += 1) {
    const caller = `203.0.113.${i}`;
    recordSend(caller, NOW);
  }
  // A brand-new caller, nothing spent individually, is still refused.
  const fresh = sendAllowance("198.51.100.99", NOW);
  assert.equal(fresh.allowed, false);
  assert.ok(fresh.retryAfterSeconds >= 1);
});

test("the ceiling sits above one caller's own limit", () => {
  // A single caller is still stopped at MAX_SENDS, before the ceiling matters.
  resetSendLimit();
  let sent = 0;
  for (let i = 0; i < GLOBAL_SENDS + 5; i += 1) {
    if (sendAllowance("203.0.113.7", NOW).allowed) {
      recordSend("203.0.113.7", NOW);
      sent += 1;
    }
  }
  assert.equal(sent, MAX_SENDS);
  assert.ok(MAX_SENDS < GLOBAL_SENDS);
});

test("the ceiling forgets sends once the window has passed", () => {
  resetSendLimit();
  for (let i = 0; i < GLOBAL_SENDS; i += 1) recordSend(`203.0.113.${i}`, NOW);
  assert.equal(sendAllowance("198.51.100.99", NOW).allowed, false);
  assert.equal(sendAllowance("198.51.100.99", NOW + SEND_WINDOW_MS + 1).allowed, true);
});
