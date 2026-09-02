/**
 * Tests for the audit rate limit.
 *
 * Every audit makes several outbound requests, and from the next step onward
 * each will also cost money. The limit exists so one script cannot run that up
 * unnoticed.
 *
 * Run with:  npm test
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, callerKey, resetRateLimits } from "./rateLimit.ts";

beforeEach(() => {
  resetRateLimits();
  delete process.env.AUDIT_RATE_LIMIT_PER_MINUTE;
});

test("allows requests up to the limit", () => {
  for (let i = 1; i <= 10; i++) {
    const result = checkRateLimit("1.2.3.4");
    assert.equal(result.allowed, true, `request ${i} should be allowed`);
  }
});

test("blocks the request after the limit", () => {
  for (let i = 0; i < 10; i++) checkRateLimit("1.2.3.4");

  const blocked = checkRateLimit("1.2.3.4");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0, "must say when to try again");
});

test("counts down the remaining allowance", () => {
  assert.equal(checkRateLimit("1.2.3.4").remaining, 9);
  assert.equal(checkRateLimit("1.2.3.4").remaining, 8);
  assert.equal(checkRateLimit("1.2.3.4").remaining, 7);
});

test("keeps callers separate", () => {
  // One caller hitting the limit must not lock anyone else out.
  for (let i = 0; i < 10; i++) checkRateLimit("1.1.1.1");

  assert.equal(checkRateLimit("1.1.1.1").allowed, false);
  assert.equal(checkRateLimit("2.2.2.2").allowed, true);
});

test("allows requests again once the window has passed", () => {
  const start = 1_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit("1.2.3.4", start);
  assert.equal(checkRateLimit("1.2.3.4", start).allowed, false);

  // Just over a minute later the earlier requests no longer count.
  assert.equal(checkRateLimit("1.2.3.4", start + 60_001).allowed, true);
});

test("uses a sliding window, not a counter that resets on the minute", () => {
  // A fixed reset would let a caller send the limit at the end of one window
  // and the limit again at the start of the next — twice the intended rate.
  const start = 1_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit("1.2.3.4", start + i);

  // 30 seconds later, those ten are still inside the last minute.
  assert.equal(checkRateLimit("1.2.3.4", start + 30_000).allowed, false);
});

test("a blocked caller does not extend their own lockout", () => {
  const start = 1_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit("1.2.3.4", start);

  // Hammering while blocked must not push the retry time further away.
  const first = checkRateLimit("1.2.3.4", start + 1_000);
  for (let i = 0; i < 50; i++) checkRateLimit("1.2.3.4", start + 1_000);
  const afterHammering = checkRateLimit("1.2.3.4", start + 1_000);

  assert.equal(first.allowed, false);
  assert.equal(afterHammering.retryAfterSeconds, first.retryAfterSeconds);
});

test("the limit can be raised for local development", () => {
  // Someone testing by hand may legitimately run more than ten in a minute.
  process.env.AUDIT_RATE_LIMIT_PER_MINUTE = "50";

  for (let i = 0; i < 50; i++) {
    assert.equal(checkRateLimit("1.2.3.4").allowed, true, `request ${i + 1}`);
  }
  assert.equal(checkRateLimit("1.2.3.4").allowed, false, "still limited, just higher");
});

test("ignores a nonsense limit setting and uses the default", () => {
  for (const bad of ["abc", "-5", "0", ""]) {
    resetRateLimits();
    process.env.AUDIT_RATE_LIMIT_PER_MINUTE = bad;
    assert.equal(checkRateLimit("1.2.3.4").limit, 10, `for "${bad}"`);
  }
});

test("identifies the caller from the forwarding header", () => {
  const request = new Request("http://localhost/api/audit", {
    headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" },
  });
  // The first entry is the original client; the rest are proxies.
  assert.equal(callerKey(request), "203.0.113.5");
});

test("falls back to x-real-ip, then to a shared key", () => {
  const withRealIp = new Request("http://localhost/api/audit", {
    headers: { "x-real-ip": "203.0.113.9" },
  });
  assert.equal(callerKey(withRealIp), "203.0.113.9");

  const withNeither = new Request("http://localhost/api/audit");
  assert.equal(callerKey(withNeither), "unknown");
});

test("callers with no identifying header share one allowance", () => {
  // Better to limit them together than to leave them unlimited.
  const anonymous = new Request("http://localhost/api/audit");
  const key = callerKey(anonymous);

  for (let i = 0; i < 10; i++) checkRateLimit(key);
  assert.equal(checkRateLimit(key).allowed, false);
});
