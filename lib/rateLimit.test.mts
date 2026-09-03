/**
 * Tests for the audit rate limit.
 *
 * Every audit makes several outbound requests, and from the next step onward
 * each will also cost money. The limit exists so one script cannot run that up
 * unnoticed.
 *
 * Run with:  npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  callerKey,
  resetRateLimits,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./rateLimit.ts";

/**
 * NODE_ENV is typed read-only (the framework narrows it to known values), so
 * a test that needs to pretend to be production writes through this view of
 * the same object rather than fighting the type.
 */
const env = process.env as Record<string, string | undefined>;

const realNodeEnv = env.NODE_ENV;
const realWarn = console.warn;
/** Warnings captured while a test runs, so the output stays readable. */
let warnings: string[] = [];

beforeEach(() => {
  resetRateLimits();
  delete process.env.AUDIT_RATE_LIMIT_PER_MINUTE;
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = realWarn;
  if (realNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = realNodeEnv;
});

/** Sets the override and returns the limit actually applied. */
function limitFor(value: string | undefined, nodeEnv?: string): number {
  resetRateLimits();
  if (value === undefined) delete env.AUDIT_RATE_LIMIT_PER_MINUTE;
  else env.AUDIT_RATE_LIMIT_PER_MINUTE = value;
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  return checkRateLimit("config-probe").limit;
}

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

// ---------------------------------------------------------------------------
// Configuring the limit
//
// The override exists so someone testing by hand is not blocked after ten
// audits. It must not become a way to switch the protection off.
// ---------------------------------------------------------------------------

test("uses the default when nothing is configured", () => {
  assert.equal(limitFor(undefined), DEFAULT_LIMIT);
});

test("accepts a normal configured value", () => {
  assert.equal(limitFor("30", "development"), 30);
  assert.equal(limitFor("25"), 25);
  assert.equal(limitFor("1"), 1, "one a minute is a valid, if strict, choice");
});

test("accepts exactly the maximum allowed value", () => {
  assert.equal(limitFor(String(MAX_LIMIT)), MAX_LIMIT);
});

test("rejects a value one above the maximum", () => {
  // Not clamped: a setting outside the allowed range is a misconfiguration,
  // and the safe answer to a misconfiguration is the default.
  assert.equal(limitFor(String(MAX_LIMIT + 1)), DEFAULT_LIMIT);
});

test("rejects an extremely large value rather than disabling protection", () => {
  // This is the case the review found: 9999999 made the limit unreachable.
  for (const huge of ["9999999", "1e9", "100000", "999999999999999"]) {
    assert.equal(limitFor(huge), DEFAULT_LIMIT, `for "${huge}"`);
  }
});

test("rejects invalid values of every kind", () => {
  const invalid = [
    "abc", // text
    "-5", // negative
    "-1",
    "0", // zero would block everything
    "", // empty
    "   ", // whitespace
    "10.5", // fractional
    "Infinity", // not finite
    "NaN",
    "1e400", // overflows to Infinity
    "0x10", // hex: Number() reads this as 16, which nobody typing a limit means
    "0xFF",
    "10abc",
    "+10", // a sign is not a plain digit
    "1_0", // numeric separators are a code feature, not a config format
  ];
  for (const value of invalid) {
    assert.equal(limitFor(value), DEFAULT_LIMIT, `for "${value}"`);
  }
});

test("PRODUCTION ignores the override entirely", () => {
  // A developer's .env copied to a server, or a value left over from
  // debugging, must not quietly remove the limit where it matters most.
  assert.equal(limitFor("60", "production"), DEFAULT_LIMIT);
  assert.equal(limitFor("50", "production"), DEFAULT_LIMIT);
  assert.equal(limitFor("9999999", "production"), DEFAULT_LIMIT);
});

test("DEVELOPMENT honours a valid override", () => {
  assert.equal(limitFor("40", "development"), 40);
  assert.equal(limitFor("40", "test"), 40);
  assert.equal(limitFor("40", undefined), 40, "unset NODE_ENV is treated as non-production");
});

test("production is limited even when the override would otherwise be valid", () => {
  env.NODE_ENV = "production";
  env.AUDIT_RATE_LIMIT_PER_MINUTE = "60";
  resetRateLimits();

  for (let i = 0; i < DEFAULT_LIMIT; i++) {
    assert.equal(checkRateLimit("prod-caller").allowed, true, `request ${i + 1}`);
  }
  assert.equal(
    checkRateLimit("prod-caller").allowed,
    false,
    "the eleventh must be blocked despite the override asking for 60",
  );
});

test("a raised limit still limits, just higher", () => {
  process.env.AUDIT_RATE_LIMIT_PER_MINUTE = "50";
  resetRateLimits();

  for (let i = 0; i < 50; i++) {
    assert.equal(checkRateLimit("1.2.3.4").allowed, true, `request ${i + 1}`);
  }
  assert.equal(checkRateLimit("1.2.3.4").allowed, false, "still limited at the raised value");
});

test("says on the console when a setting was ignored", () => {
  // A developer whose value was rejected should find out, not wonder why they
  // are still being limited.
  limitFor("9999999");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /9999999/);
  assert.match(warnings[0], /above the maximum/i);
});

test("explains that production ignores the override", () => {
  limitFor("50", "production");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not available in production/i);
});

test("mentions an ignored setting once, not on every request", () => {
  process.env.AUDIT_RATE_LIMIT_PER_MINUTE = "9999999";
  resetRateLimits();
  warnings = [];

  for (let i = 0; i < 5; i++) checkRateLimit("noisy");
  assert.equal(warnings.length, 1, "the warning must not repeat per request");
});

test("says nothing when the setting is valid or absent", () => {
  limitFor("30");
  assert.deepEqual(warnings, [], "a valid setting is not a problem to report");

  warnings = [];
  limitFor(undefined);
  assert.deepEqual(warnings, [], "no setting at all is not a problem either");
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
