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
  GLOBAL_LIMIT,
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

test("the forwarding header is ignored unless a proxy is trusted", () => {
  const request = new Request("http://localhost/api/audit", {
    headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" },
  });
  // Default: the header is the client's own word and is not believed, so every
  // request is the one shared bucket rather than a caller of its choosing.
  assert.equal(callerKey(request), "unattributed");
});

test("behind a trusted proxy, the first forwarding hop is the caller", () => {
  const request = new Request("http://localhost/api/audit", {
    headers: { "x-forwarded-for": "203.0.113.5, 70.41.3.18" },
  });
  assert.equal(callerKey(request, true), "203.0.113.5");
});

test("behind a trusted proxy, x-real-ip is the fallback, then the shared key", () => {
  const withRealIp = new Request("http://localhost/api/audit", {
    headers: { "x-real-ip": "203.0.113.9" },
  });
  assert.equal(callerKey(withRealIp, true), "203.0.113.9");

  const withNeither = new Request("http://localhost/api/audit");
  assert.equal(callerKey(withNeither, true), "unattributed");
});

test("callers with no identifying header share one allowance", () => {
  // Better to limit them together than to leave them unlimited.
  const anonymous = new Request("http://localhost/api/audit");
  const key = callerKey(anonymous, true);

  for (let i = 0; i < 10; i++) checkRateLimit(key);
  assert.equal(checkRateLimit(key).allowed, false);
});

// ---------------------------------------------------------------------------
// THE CEILING NO HEADER CAN GET OUT FROM UNDER
//
// The per-caller limit is keyed on an address read from `x-forwarded-for`, and
// that header is set by the client. A script that changes it on every request
// is a new caller every time, so its own allowance never runs out — one line
// of code, and the limit is gone.
//
// So there is a second limit, counted across every caller together. These
// tests are what stop it being quietly removed or made configurable.
// ---------------------------------------------------------------------------

/** A request as the route receives one, with whatever headers a caller sent. */
const requestWith = (headers: Record<string, string>) =>
  new Request("https://audit.test/api/audit", { method: "POST", headers });

test("one caller still gets exactly their own allowance", () => {
  // Unchanged behaviour, restated here so the ceiling cannot be blamed for a
  // caller being cut off early.
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
    const result = checkRateLimit("198.51.100.7");
    assert.equal(result.allowed, true, `request ${i + 1} of ${DEFAULT_LIMIT}`);
    assert.equal(result.scope, "caller");
  }

  const blocked = checkRateLimit("198.51.100.7");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "caller");
  assert.equal(blocked.limit, DEFAULT_LIMIT);
});

test("a blocked caller stays blocked, and does not extend their own lockout", () => {
  const at = Date.now();
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) checkRateLimit("198.51.100.8", at);

  const first = checkRateLimit("198.51.100.8", at + 1_000);
  const second = checkRateLimit("198.51.100.8", at + 2_000);

  assert.equal(first.allowed, false);
  assert.equal(second.allowed, false);
  // The wait shrinks as the window slides. It must never grow because they
  // knocked again.
  assert.ok(second.retryAfterSeconds <= first.retryAfterSeconds);
});

test("changing X-Forwarded-For does NOT buy unlimited audits", () => {
  /*
   * The bug, closed. Every request sets a different header, but by default the
   * header is not trusted, so all two hundred are the one shared bucket and the
   * per-caller limit stops them at ten. Without the fix this returned allowed
   * two hundred times; before the global ceiling, it returned thirty.
   */
  let allowed = 0;
  for (let i = 0; i < 200; i += 1) {
    const caller = callerKey(requestWith({ "x-forwarded-for": `203.0.113.${i % 256}` }));
    if (checkRateLimit(caller).allowed) allowed += 1;
  }

  assert.equal(allowed, DEFAULT_LIMIT, "rotation buys nothing; the per-caller limit holds");
  assert.ok(allowed < 200);
});

test("in the default posture a rotated header is refused by the per-caller limit", () => {
  // Untrusted, every spoofed request is the shared bucket, so it is that
  // bucket's own ten that stops them -- not the global ceiling.
  const fresh = (i: number) => callerKey(requestWith({ "x-forwarded-for": `203.0.113.${i}` }));

  for (let i = 0; i < DEFAULT_LIMIT; i += 1) checkRateLimit(fresh(i));

  const next = checkRateLimit(fresh(DEFAULT_LIMIT + 1));
  assert.equal(next.allowed, false);
  assert.equal(next.scope, "caller");
  assert.equal(next.limit, DEFAULT_LIMIT);
  assert.ok(next.retryAfterSeconds >= 1);
});

test("many honest callers together cannot exceed the ceiling either", () => {
  // Four separate addresses, each politely inside its own allowance of ten.
  const callers = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
  let allowed = 0;

  for (let round = 0; round < DEFAULT_LIMIT; round += 1) {
    for (const caller of callers) {
      if (checkRateLimit(caller).allowed) allowed += 1;
    }
  }

  assert.equal(allowed, GLOBAL_LIMIT);
  assert.ok(allowed < callers.length * DEFAULT_LIMIT, "the sum of allowances is not available");
});

test("requests arriving at the same instant cannot race past the ceiling", () => {
  /*
   * Every one of these is stamped with the SAME millisecond, which is the
   * closest thing to simultaneous arrival that this limiter can see. The whole
   * check-and-record is synchronous — there is no await inside it — so the
   * second request runs only after the first has finished writing, and no two
   * can both read the same last free slot.
   */
  const at = Date.now();
  const results = Array.from({ length: 100 }, (_, i) =>
    checkRateLimit(`203.0.113.${i}`, at),
  );

  assert.equal(results.filter((r) => r.allowed).length, GLOBAL_LIMIT);
});

test("interleaving callers does not let anyone slip through", () => {
  const at = Date.now();
  let allowed = 0;
  for (let i = 0; i < 90; i += 1) {
    // Round-robin between three addresses, all in the same millisecond.
    if (checkRateLimit(`198.51.100.${i % 3}`, at).allowed) allowed += 1;
  }

  assert.equal(allowed, GLOBAL_LIMIT);
});

test("a refused request does not spend the global budget", () => {
  const at = Date.now();

  // One caller uses their ten, then knocks twenty more times and is refused.
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) checkRateLimit("198.51.100.9", at);
  for (let i = 0; i < 20; i += 1) checkRateLimit("198.51.100.9", at);

  // Those refusals cost nothing, so the rest of the ceiling is still there
  // for everybody else. Charging them would let one blocked caller lock out
  // the whole server.
  let allowed = 0;
  for (let i = 0; i < 100; i += 1) {
    if (checkRateLimit(`203.0.113.${i}`, at).allowed) allowed += 1;
  }

  assert.equal(allowed, GLOBAL_LIMIT - DEFAULT_LIMIT);
});

test("the ceiling slides rather than resetting on the minute", () => {
  const at = Date.now();
  for (let i = 0; i < GLOBAL_LIMIT; i += 1) checkRateLimit(`203.0.113.${i}`, at);

  assert.equal(checkRateLimit("198.51.100.20", at + 59_000).allowed, false, "still inside");
  assert.equal(checkRateLimit("198.51.100.20", at + 61_000).allowed, true, "window passed");
});

test("the ceiling is not configurable by the environment", () => {
  /*
   * A limit that exists because the other one can be evaded is worth nothing
   * if it can be switched off the same way. The override raises one caller's
   * allowance; it must not raise the total.
   */
  process.env.AUDIT_RATE_LIMIT_PER_MINUTE = String(MAX_LIMIT);

  let allowed = 0;
  for (let i = 0; i < 200; i += 1) {
    if (checkRateLimit(`203.0.113.${i % 256}`).allowed) allowed += 1;
  }

  assert.equal(allowed, Math.max(GLOBAL_LIMIT, MAX_LIMIT));
  assert.ok(allowed < 200);
});

test("the ceiling never sits below a single caller's own allowance", () => {
  // Otherwise raising the per-caller limit for local testing would block that
  // caller before their own limit was reached, which reads as a bug.
  process.env.AUDIT_RATE_LIMIT_PER_MINUTE = String(MAX_LIMIT);

  for (let i = 0; i < MAX_LIMIT; i += 1) {
    assert.equal(checkRateLimit("198.51.100.30").allowed, true, `request ${i + 1}`);
  }
});

test("a 429 still carries a usable Retry-After, whichever limit refused it", () => {
  const at = Date.now();
  for (let i = 0; i < GLOBAL_LIMIT; i += 1) checkRateLimit(`203.0.113.${i}`, at);

  const global = checkRateLimit("198.51.100.40", at);
  assert.equal(global.allowed, false);
  assert.equal(global.scope, "global");
  assert.ok(global.retryAfterSeconds >= 1 && global.retryAfterSeconds <= 60);
  assert.equal(global.remaining, 0);
});

/* ---------------------------------------------------------------------------
   The trust posture and address normalisation
   --------------------------------------------------------------------------- */

test("behind a trusted proxy, thirty distinct callers still hit the global ceiling", () => {
  // The ceiling is the same value keyed on nobody, so distinct trusted callers
  // fill it just as spoofed ones would have — but now they must be distinct.
  resetRateLimits();
  for (let i = 0; i < GLOBAL_LIMIT; i += 1) {
    checkRateLimit(callerKey(requestWith({ "x-forwarded-for": `203.0.113.${i}` }), true));
  }
  const next = checkRateLimit(callerKey(requestWith({ "x-forwarded-for": "203.0.113.200" }), true));
  assert.equal(next.allowed, false);
  assert.equal(next.scope, "global");
  assert.equal(next.limit, GLOBAL_LIMIT);
});

test("behind a trusted proxy, alternate spellings of one address share one bucket", () => {
  resetRateLimits();
  const spellings = ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:127.0.0.1"];
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) {
    if (checkRateLimit(callerKey(requestWith({ "x-forwarded-for": spellings[i % spellings.length] }), true)).allowed) {
      allowed += 1;
    }
  }
  assert.equal(allowed, DEFAULT_LIMIT, "one machine, one allowance, whatever the spelling");
});

test("behind a trusted proxy, a junk header cannot mint a fresh bucket per request", () => {
  resetRateLimits();
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) {
    if (checkRateLimit(callerKey(requestWith({ "x-forwarded-for": `not-an-ip-${i}` }), true)).allowed) allowed += 1;
  }
  assert.equal(allowed, DEFAULT_LIMIT, "junk collapses to the shared bucket");
});

test("the trust posture is read from SKYBOOK_TRUST_PROXY when no flag is passed", () => {
  const previous = process.env.SKYBOOK_TRUST_PROXY;
  try {
    process.env.SKYBOOK_TRUST_PROXY = "1";
    assert.equal(callerKey(requestWith({ "x-forwarded-for": "203.0.113.5" })), "203.0.113.5");
    delete process.env.SKYBOOK_TRUST_PROXY;
    assert.equal(callerKey(requestWith({ "x-forwarded-for": "203.0.113.5" })), "unattributed");
  } finally {
    if (previous === undefined) delete process.env.SKYBOOK_TRUST_PROXY;
    else process.env.SKYBOOK_TRUST_PROXY = previous;
  }
});
