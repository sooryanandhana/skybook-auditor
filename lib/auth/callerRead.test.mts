/**
 * Tests for the `caller.read` diagnostic: whether a successful sign-in was
 * attributed to a client address, written without ever writing the address.
 *
 * WHAT IS PROVED:
 *
 *   - every reason a request can go unattributed is told apart, from fixed
 *     words alone, and the answer agrees with `trustedCaller` on every input;
 *   - what the classifier hands back holds no address, and the logger refuses
 *     any value not on its lists, so nothing a request sent can reach a line;
 *   - a line is written only after a correct password: wrong, unknown,
 *     rate-limited, busy and database-failure attempts write nothing;
 *   - each answer is written at most once per process, however many sign-ins,
 *     whatever values are passed, and however many other keys are logged.
 *
 * Fake accounts and passwords only. No network, no real database.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test, { beforeEach } from "node:test";
import { CLIENT_ADDRESS_HEADER, MAX_CLIENT_ADDRESS_LENGTH, UNATTRIBUTED, callerAttribution, trustedCaller } from "../callerAddress.ts";
import {
  ONCE_LIMIT,
  callerReadsWritten,
  logCallerReadOnce,
  logOutcome,
  logOutcomeOnce,
  reliabilityWords,
  resetLoggedOnce,
} from "../log/reliabilityLog.ts";
import { captureLog } from "../log/captureLog.fixture.mts";
import {
  MAX_ACTIVE_VERIFICATIONS,
  MAX_WAITING_VERIFICATIONS,
  claimVerificationSlot,
  hashPassword,
  resetAttempts,
  verificationLoad,
} from "./credentials.ts";
import { loginRoute } from "./loginRoute.ts";

const NOW = 1_757_000_000_000;
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const PASSWORD = "a-fake-password-for-this-test-only";
const HASH = await hashPassword(PASSWORD);
const ACCOUNT_ID = "c0ffee00-0000-4000-8000-00000000c0de";
const EMAIL = "sam@skybook.example";

/** Values that must never appear anywhere in what is written. */
const SENTINEL_IP = "203.0.113.77";
const SENTINEL_AGENT = "SentinelAgent/9.9 (do-not-log)";

const ACTIVE_USER = {
  id: ACCOUNT_ID,
  email: EMAIL,
  password_hash: HASH,
  role: "SALES",
  status: "ACTIVE",
  created_at: new Date(NOW),
  updated_at: new Date(NOW),
  approved_by: null,
  approved_at: null,
  last_login_at: null,
  must_change_password: false,
};

const db = {
  async query(sql: string, params: unknown[] = []) {
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: String(params[0] ?? "").toLowerCase() === EMAIL ? [ACTIVE_USER] : [] };
    }
    return { rows: [] };
  },
};
const brokenDb = {
  async query() {
    throw new Error("connection refused");
  },
};

const trusting = { db, secret: SECRET, sleep: async () => {}, trustProxy: true };

/** A sign-in request carrying the given client-address header, if any. */
function signInRequest(email: string, password: string, address: string | null = SENTINEL_IP) {
  const headers = new Headers({ "content-type": "application/json", "user-agent": SENTINEL_AGENT });
  if (address !== null) headers.set(CLIENT_ADDRESS_HEADER, address);
  return new Request("https://skybook.example/api/auth/login?from=sentinel-path", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
}

const withHeader = (value: string | null) => {
  const headers = new Headers();
  if (value !== null) headers.set(CLIENT_ADDRESS_HEADER, value);
  return new Request("https://skybook.example/", { headers });
};

beforeEach(() => {
  resetLoggedOnce();
  resetAttempts();
});

/* ---------------------------------------------------------------------------
   The classifier
   --------------------------------------------------------------------------- */

test("every reason a request goes unattributed is told apart", () => {
  const twice = new Headers();
  twice.append(CLIENT_ADDRESS_HEADER, "203.0.113.7");
  twice.append(CLIENT_ADDRESS_HEADER, "198.51.100.1");

  const cases: Array<[Request, boolean, unknown]> = [
    [withHeader("203.0.113.7"), false, { outcome: "unattributed", reason: "proxy-not-trusted" }],
    [withHeader(null), true, { outcome: "unattributed", reason: "missing" }],
    [withHeader(""), true, { outcome: "unattributed", reason: "empty" }],
    [withHeader("   "), true, { outcome: "unattributed", reason: "empty" }],
    [withHeader("203.0.113.7, 198.51.100.1"), true, { outcome: "unattributed", reason: "multiple" }],
    [new Request("https://skybook.example/", { headers: twice }), true, { outcome: "unattributed", reason: "multiple" }],
    [withHeader(`0${"ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"}`), true, { outcome: "unattributed", reason: "too-long" }],
    // Too long AND comma-separated: length is checked first, as `trustedCaller` always did.
    [withHeader("203.0.113.7, 198.51.100.1, 192.0.2.1, 192.0.2.2"), true, { outcome: "unattributed", reason: "too-long" }],
    [withHeader("not-an-ip"), true, { outcome: "unattributed", reason: "not-an-address" }],
    [withHeader("203.0.113.7:443"), true, { outcome: "unattributed", reason: "not-an-address" }],
    [withHeader("[2001:db8::1]"), true, { outcome: "unattributed", reason: "not-an-address" }],
    [withHeader("203.0.113.7"), true, { outcome: "attributed" }],
    [withHeader("2001:DB8::1"), true, { outcome: "attributed" }],
    [withHeader("::ffff:203.0.113.7"), true, { outcome: "attributed" }],
    [withHeader("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"), true, { outcome: "attributed" }],
  ];

  for (const [request, trust, expected] of cases) {
    assert.deepEqual(callerAttribution(request, trust), expected, JSON.stringify(expected));
  }
  assert.equal("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255".length, MAX_CLIENT_ADDRESS_LENGTH);
});

test("the answer never carries the address or the header", () => {
  for (const value of ["203.0.113.7", "::ffff:203.0.113.7", "not-an-ip", "", null]) {
    const answer = callerAttribution(withHeader(value), true);
    const keys = Object.keys(answer).sort();
    assert.ok(
      JSON.stringify(keys) === JSON.stringify(["outcome"]) || JSON.stringify(keys) === JSON.stringify(["outcome", "reason"]),
      `only an outcome and a reason, saw ${JSON.stringify(keys)}`,
    );
    if (value) assert.ok(!JSON.stringify(answer).includes(value), "the value is not in the answer");
  }
});

test("the classifier agrees with trustedCaller on every input", () => {
  // A deterministic generator over the characters an address, or a forgery of
  // one, is made of -- so the comparison covers far more than the table above.
  let seed = 20261017;
  const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  const alphabet = "0123456789abcdefABCDEF:.,%[] x-";
  const samples: (string | null)[] = [null, "", "  ", "1.2.3.4", "::1", "::ffff:7f00:1", "1.2.3.4,5.6.7.8"];
  for (let i = 0; i < 2000; i += 1) {
    const length = next(50);
    let value = "";
    for (let c = 0; c < length; c += 1) value += alphabet[next(alphabet.length)];
    samples.push(value);
  }
  for (let i = 0; i < 200; i += 1) samples.push(`${next(256)}.${next(256)}.${next(256)}.${next(300)}`);

  for (const value of samples) {
    for (const trust of [true, false]) {
      let request: Request;
      try {
        request = withHeader(value);
      } catch {
        continue; // not a value a header can hold at all
      }
      const attributed = callerAttribution(request, trust).outcome === "attributed";
      assert.equal(attributed, trustedCaller(request, trust) !== UNATTRIBUTED, JSON.stringify({ value, trust }));
    }
  }
});

/* ---------------------------------------------------------------------------
   The logger
   --------------------------------------------------------------------------- */

test("caller.read lines can hold only the approved words", () => {
  assert.deepEqual([...reliabilityWords("caller.read").outcomes], ["attributed", "unattributed"]);
  assert.deepEqual(
    [...reliabilityWords("caller.read").reasons],
    ["proxy-not-trusted", "missing", "empty", "multiple", "too-long", "not-an-address"],
  );
});

test("a sentinel value in any field never reaches a caller.read line", async () => {
  const leaks = [SENTINEL_IP, "::ffff:198.51.100.1", "skybook_session=abc.def", "https://skybook.example/x", EMAIL];
  const captured = await captureLog(() => {
    for (const leak of leaks) {
      // Through the general logger, with the value in every field it has.
      logOutcome({
        op: "caller.read",
        outcome: "attributed",
        reason: leak,
        job: leak,
        via: leak,
        aiText: leak,
        aiState: leak,
        size: leak,
      } as never);
      logOutcome({ op: "caller.read", outcome: leak } as never);
      // And through the diagnostic's own writer.
      logCallerReadOnce(leak);
      logCallerReadOnce("unattributed", leak);
    }
  });

  const text = captured.all.join("\n");
  for (const leak of leaks) assert.ok(!text.includes(leak), `${leak} was written`);
  for (const line of captured.lines) {
    assert.deepEqual(Object.keys(line).sort(), ["op", "outcome", "ts"], "no field beyond the time, the operation and the outcome");
  }
});

/** The seven combinations the diagnostic may write, and nothing else. */
const PERMITTED: Array<[string, string | undefined]> = [
  ["attributed", undefined],
  ["unattributed", "proxy-not-trusted"],
  ["unattributed", "missing"],
  ["unattributed", "empty"],
  ["unattributed", "multiple"],
  ["unattributed", "too-long"],
  ["unattributed", "not-an-address"],
];

test("each of the seven permitted combinations is written once per process, however often", async () => {
  assert.equal(PERMITTED.length, 1 + reliabilityWords("caller.read").reasons.length);

  const captured = await captureLog(() => {
    for (let round = 0; round < 50; round += 1) {
      for (const [outcome, reason] of PERMITTED) logCallerReadOnce(outcome, reason);
    }
  });

  assert.equal(captured.lines.length, 7, "one line for each permitted combination");
  assert.equal(callerReadsWritten(), 7, "and the memory holds exactly those seven");
  assert.deepEqual(
    captured.lines.map((line) => [line.outcome, line.reason]),
    PERMITTED.map(([outcome, reason]) => [outcome, reason]),
  );
});

test("a combination that is not permitted is neither written nor remembered", async () => {
  const words = reliabilityWords("caller.read");
  const captured = await captureLog(() => {
    for (let round = 0; round < 50; round += 1) {
      // attributed with a reason, approved or not
      for (const reason of words.reasons) logCallerReadOnce("attributed", reason);
      logCallerReadOnce("attributed", `reason-${round}`);
      // unattributed without a reason, or with one off the list
      logCallerReadOnce("unattributed");
      logCallerReadOnce("unattributed", `reason-${round}`);
      logCallerReadOnce("unattributed", "");
      // outcomes off the list, with and without a reason
      logCallerReadOnce(`attributed-${round}`);
      logCallerReadOnce("Attributed");
      logCallerReadOnce("", "missing");
      logCallerReadOnce("succeeded", "missing");
    }
  });

  assert.equal(captured.all.length, 0, "nothing was written");
  assert.equal(callerReadsWritten(), 0, "and nothing was remembered");
});

test("rejected combinations do not use up any of the seven places", async () => {
  const captured = await captureLog(() => {
    for (const reason of reliabilityWords("caller.read").reasons) logCallerReadOnce("attributed", reason);
    logCallerReadOnce("unattributed");
    for (const [outcome, reason] of PERMITTED) logCallerReadOnce(outcome, reason);
  });

  assert.equal(captured.lines.length, 7, "every permitted combination is still written");
  assert.equal(callerReadsWritten(), 7);
});

test("other one-time keys cannot push a caller.read answer out and make it repeat", async () => {
  const captured = await captureLog(() => {
    logCallerReadOnce("attributed");
    for (let i = 0; i < ONCE_LIMIT + 50; i += 1) {
      logOutcomeOnce(`ai.explain:job-${i}`, { op: "ai.explain", outcome: "not-started", reason: "no-page-measurements" });
    }
    logCallerReadOnce("attributed");
  });

  assert.equal(captured.lines.filter((line) => line.op === "caller.read").length, 1);
});

/* ---------------------------------------------------------------------------
   Through the sign-in route
   --------------------------------------------------------------------------- */

test("a successful sign-in writes one line, and nothing it carried", async () => {
  const captured = await captureLog(() => loginRoute(signInRequest(EMAIL, PASSWORD), trusting, NOW));
  const outcome = captured.result;
  assert.equal(outcome.ok, true);
  const cookie = outcome.ok ? outcome.cookie : "";

  assert.equal(captured.all.length, 1, "exactly one thing was written");
  assert.deepEqual(Object.keys(captured.lines[0]).sort(), ["op", "outcome", "ts"]);
  assert.equal(captured.lines[0].op, "caller.read");
  assert.equal(captured.lines[0].outcome, "attributed");

  const text = captured.all.join("\n");
  for (const secret of [SENTINEL_IP, EMAIL, PASSWORD, ACCOUNT_ID, cookie, "sentinel-path", "/api/auth/login", SENTINEL_AGENT]) {
    assert.ok(secret.length > 0 && !text.includes(secret), `${secret.slice(0, 20)} was written`);
  }
});

test("a successful sign-in with no client-address header is written as missing", async () => {
  const captured = await captureLog(() => loginRoute(signInRequest(EMAIL, PASSWORD, null), trusting, NOW));
  assert.equal(captured.result.ok, true);
  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0].outcome, "unattributed");
  assert.equal(captured.lines[0].reason, "missing");
});

test("twenty successful sign-ins write one line", async () => {
  const captured = await captureLog(async () => {
    for (let i = 0; i < 20; i += 1) await loginRoute(signInRequest(EMAIL, PASSWORD), trusting, NOW);
  });
  assert.equal(captured.lines.filter((line) => line.op === "caller.read").length, 1);
});

test("no attempt that fails writes a line: wrong, unknown, locked, busy or database failure", async () => {
  const captured = await captureLog(async () => {
    // Wrong password and unknown address.
    assert.equal((await loginRoute(signInRequest(EMAIL, "wrong-password"), trusting, NOW)).ok, false);
    assert.equal((await loginRoute(signInRequest("nobody@skybook.example", PASSWORD), trusting, NOW)).ok, false);

    // Locked for failures from one address.
    resetAttempts();
    for (let i = 0; i < 10; i += 1) await loginRoute(signInRequest(EMAIL, "wrong-password", "198.51.100.9"), trusting, NOW);
    const locked = await loginRoute(signInRequest(EMAIL, PASSWORD, "198.51.100.9"), trusting, NOW);
    assert.equal(locked.ok === false && locked.status, 429);

    // Busy: every verification place taken and the queue full.
    const held = await Promise.all(Array.from({ length: MAX_ACTIVE_VERIFICATIONS }, () => claimVerificationSlot()));
    const waiting = Array.from({ length: MAX_WAITING_VERIFICATIONS }, () => claimVerificationSlot());
    const busy = await loginRoute(signInRequest(EMAIL, PASSWORD, "198.51.100.10"), trusting, NOW);
    assert.equal(busy.ok === false && busy.status, 503);
    // Each release lets in the next waiter, so they are released one by one as admitted.
    for (const release of held) release?.();
    for (const admitted of waiting) (await admitted)?.();
    assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });

    // The database unreachable.
    const outage = await loginRoute(signInRequest(EMAIL, PASSWORD), { ...trusting, db: brokenDb }, NOW);
    assert.equal(outage.ok === false && outage.status, 503);
  });

  assert.equal(captured.lines.filter((line) => line.op === "caller.read").length, 0);
  assert.equal(callerReadsWritten(), 0);
});

test("the diagnostic is written from the sign-in route and nowhere else", () => {
  const sources: string[] = [];
  const walk = (directory: URL) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) walk(url);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.|\.fixture\./.test(entry.name)) sources.push(url.pathname);
    }
  };
  walk(new URL("../", import.meta.url));
  walk(new URL("../../app/", import.meta.url));

  const callers = sources.filter((file) => {
    const text = fs.readFileSync(new URL(`file://${file}`), "utf8");
    return /logCallerReadOnce\(|callerAttribution\(/.test(text) && !file.endsWith("/callerAddress.ts") && !file.endsWith("/reliabilityLog.ts");
  });
  assert.deepEqual(callers.map((file) => file.replace(/^.*\/(lib|app)\//, "$1/")), ["lib/auth/loginRoute.ts"]);
});
