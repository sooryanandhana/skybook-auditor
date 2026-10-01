/**
 * Tests for the sign-in and sign-out endpoints' decisions.
 *
 * DRIVEN WITH PLAIN REQUESTS AND NO SERVER, the way every other route in this
 * project is tested. The adapters above these are glue, and the thing worth
 * checking is what the glue is given.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { RATE_LIMITED, REJECTED, hashPassword, resetAttempts } from "./credentials.ts";
import { readSession, sessionCookieOptions } from "./session.ts";
import { AFTER_LOGIN, CANNOT_SIGN_IN, LOGIN_PATH, callerAddress, loginRoute, logoutRoute, normaliseCaller } from "./loginRoute.ts";

const PASSWORD = "a-password-the-salesperson-chose";
const HASH = hashPassword(PASSWORD);
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const NOW = 1_757_000_000_000;

/** The ACTIVE account the salesperson signs in with, as a database row. */
const ACTIVE_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "ana@skybook.example",
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

/** A fake database returning the account for its own address, case-insensitively. */
function dbReturning(user: Record<string, unknown>) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*SELECT/i.test(sql)) {
        const wanted = String(params[0] ?? "").toLowerCase();
        return { rows: wanted === String(user.email).toLowerCase() ? [user] : [] };
      }
      return { rows: [] };
    },
  };
}

/** A database that cannot be reached, for the server-fault path. */
const brokenDb = {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error("database unavailable");
  },
};

/**
 * The shared options. `db` holds the ACTIVE account; `sleep` is instant so the
 * account slow-down is exercised without a test ever waiting; `trustProxy`
 * defaults off, exactly as production does, so a test that wants the per-caller
 * limit asks for it explicitly.
 */
const options = { db: dbReturning(ACTIVE_USER), secret: SECRET, sleep: async () => {} };
const trusting = { ...options, trustProxy: true };

const attempt = (body: unknown, caller = "1.2.3.4") =>
  new Request("https://skybook.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": caller },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* ---------------------------------------------------------------------------
   Signing in
   --------------------------------------------------------------------------- */

test("the right credentials produce a session that the guard will believe", () => {
  resetAttempts();

  const outcome = loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }), options, NOW);

  return outcome.then((result) => {
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // The end-to-end property: what sign-in issues, the guard reads back — the
    // user's id and role, not their address.
    const issued = readSession(result.cookie, options, NOW);
    assert.equal(issued?.userId, ACTIVE_USER.id);
    assert.equal(issued?.role, "SALES");
    // The address still comes back in the response body, for the page to greet.
    assert.equal(result.email, "ana@skybook.example");
    assert.equal(result.maxAgeSeconds, sessionCookieOptions().maxAge);
  });
});

test("the session carries the id, role and expiry, and nothing else", () => {
  /*
   * No password, no hash, no address inside the cookie — the id is who to look
   * up and the role is a signed claim. Keeping the payload to exactly these
   * three is what stops anything sensitive drifting into a value anyone holding
   * the cookie can read.
   */
  resetAttempts();

  return loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }), options, NOW).then(
    (result) => {
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const session = readSession(result.cookie, options, NOW);
      assert.deepEqual(Object.keys(session ?? {}).sort(), ["expiresAt", "role", "userId"]);
    },
  );
});

/* ---------------------------------------------------------------------------
   Being refused
   --------------------------------------------------------------------------- */

test("a wrong password and a wrong address are refused in the same words, with 401", async () => {
  resetAttempts();

  const wrongPassword = await loginRoute(attempt({ email: "ana@skybook.example", password: "no" }), options, NOW);
  const wrongAddress = await loginRoute(attempt({ email: "who@else.example", password: PASSWORD }, "5.6.7.8"), options, NOW);

  for (const refused of [wrongPassword, wrongAddress]) {
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.status, 401);
    assert.equal(refused.ok === false && refused.error, REJECTED);
  }
});

test("a malformed body is refused rather than crashing the route", async () => {
  /*
   * Something posting nonsense gets the same sentence as somebody with the
   * wrong password, because it is the same amount of no.
   */
  resetAttempts();

  for (const body of ["not json", "null", "[]", '{"email":42,"password":true}', "{}"]) {
    const refused = await loginRoute(attempt(body), options, NOW);

    assert.equal(refused.ok, false, body);
    assert.equal(refused.ok === false && refused.status, 401, body);
  }
});

test("extra fields in the body are ignored rather than read", async () => {
  // Only the two a sign-in form may send cross into the decision.
  resetAttempts();

  const outcome = await loginRoute(
    attempt({ email: "ana@skybook.example", password: PASSWORD, role: "admin", isAdmin: true }),
    options,
    NOW,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const session = readSession(outcome.cookie, options, NOW);
  assert.deepEqual(Object.keys(session ?? {}).sort(), ["expiresAt", "role", "userId"]);
});

test("behind a trusted proxy, too many attempts from one address are refused with 429", async () => {
  // The hard per-caller limit is only meaningful when the caller can be
  // trusted, which is when a proxy in front sets the forwarded address.
  resetAttempts();

  for (let n = 0; n < 10; n += 1) {
    await loginRoute(attempt({ email: "ana@skybook.example", password: "no" }, "9.9.9.9"), trusting, NOW);
  }

  const blocked = await loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }, "9.9.9.9"), trusting, NOW);

  assert.equal(blocked.ok === false && blocked.status, 429);
  assert.equal(blocked.ok === false && blocked.error, RATE_LIMITED);
});

test("a server that cannot sign a session says so rather than blaming the password", async () => {
  /*
   * The password was right and the server still cannot issue a session. Not
   * the person's fault, and it must not send them hunting for a typo.
   */
  resetAttempts();

  const outcome = await loginRoute(
    attempt({ email: "ana@skybook.example", password: PASSWORD }),
    { ...options, secret: "" },
    NOW,
  );

  assert.equal(outcome.ok === false && outcome.status, 503);
  assert.equal(outcome.ok === false && outcome.error, CANNOT_SIGN_IN);
});

test("a server whose database cannot be reached refuses with 503, not 401", async () => {
  // The password may well be right; the server simply cannot check it. That is
  // the server's fault, so it must not read as a typo.
  resetAttempts();

  const outcome = await loginRoute(
    attempt({ email: "ana@skybook.example", password: PASSWORD }),
    { db: brokenDb, secret: SECRET },
    NOW,
  );

  assert.equal(outcome.ok === false && outcome.status, 503);
});

/* ---------------------------------------------------------------------------
   Nothing comes back that should not
   --------------------------------------------------------------------------- */

test("no answer carries the password or the hash", async () => {
  resetAttempts();

  const answers = [
    await loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }), options, NOW),
    await loginRoute(attempt({ email: "ana@skybook.example", password: "wrong" }, "5.5.5.5"), options, NOW),
  ];

  for (const answer of answers) {
    const serialised = JSON.stringify(answer);

    assert.ok(!serialised.includes(PASSWORD), "no password");
    assert.ok(!serialised.includes(HASH), "no hash");
    assert.ok(!serialised.includes(SECRET), "no signing secret");
  }
});

test("nothing in the authentication path writes to the console", () => {
  const source =
    fs.readFileSync(new URL("./loginRoute.ts", import.meta.url), "utf8") +
    fs.readFileSync(new URL("./session.ts", import.meta.url), "utf8") +
    fs.readFileSync(new URL("./guard.ts", import.meta.url), "utf8");

  for (const forbidden of ["console.log", "console.warn", "console.error", "console.debug"]) {
    assert.ok(!source.includes(forbidden), `must not ${forbidden}`);
  }
});

/* ---------------------------------------------------------------------------
   Signing out
   --------------------------------------------------------------------------- */

test("signing out replaces the cookie with nothing that expires immediately", () => {
  /*
   * There is no session store to delete a row from, so the cookie IS the
   * session. Ending one early means replacing it in the browser that holds it.
   */
  const { cookie, maxAgeSeconds } = logoutRoute();

  assert.equal(cookie, "");
  assert.equal(maxAgeSeconds, 0);
  assert.equal(readSession(cookie, options, NOW), null, "and the empty value is believed by nobody");
});

test("signing out touches no audit, no result and no report", () => {
  /*
   * It takes no arguments and reaches nothing. There is no path from here to
   * anything the job store holds.
   *
   * NAMED AS IMPORTS RATHER THAN AS WORDS, and this file is the third place in
   * this project where that distinction had to be learned: an earlier version
   * forbade "store" and failed on a comment saying there is no session store to
   * delete from. A test that cannot tell prose from a dependency punishes
   * explaining yourself.
   */
  const source = fs.readFileSync(new URL("./loginRoute.ts", import.meta.url), "utf8");

  for (const forbidden of ["jobStore", "auditJobs", "createJobStore", "../audit/", "../jobs/", "../api/"]) {
    assert.ok(!source.includes(forbidden), `signing out must not reach ${forbidden}`);
  }
});

test("the two paths a person is sent to are named once each", () => {
  assert.equal(LOGIN_PATH, "/login");
  assert.equal(AFTER_LOGIN, "/");
});

/* ---------------------------------------------------------------------------
   The rate-limit bypass, closed at the route
   --------------------------------------------------------------------------- */

/** Every failed guess in a run, tallied by HTTP status, and the delays spent. */
async function guessRun(opts: Record<string, unknown>, count: number, headersFor: (i: number) => Record<string, string>) {
  resetAttempts();
  const waited: number[] = [];
  const withRecorder = { ...opts, sleep: async (ms: number) => { waited.push(ms); } };
  const status: Record<number, number> = {};
  for (let i = 0; i < count; i += 1) {
    const request = new Request("https://skybook.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headersFor(i) },
      body: JSON.stringify({ email: "ana@skybook.example", password: "wrong" }),
    });
    const outcome = await loginRoute(request, withRecorder, NOW);
    const code = outcome.ok ? 200 : outcome.status;
    status[code] = (status[code] ?? 0) + 1;
  }
  return { status, waited };
}

test("by default the forwarded address is not trusted, so rotating it does not mint new callers", async () => {
  // The whole bypass: change X-Forwarded-For every request and never be the
  // same caller twice. Untrusted, every one of them is the single shared
  // bucket, so the per-caller lock is never fooled into staying open.
  const rotated = await guessRun({ ...options }, 40, (i) => ({ "x-forwarded-for": `198.51.100.${i}` }));

  // No per-caller 429 in default mode — that would let one attacker lock the
  // one user out. The account slow-down is the defence, and it is engaged.
  assert.equal(rotated.status[429] ?? 0, 0);
  assert.ok(rotated.waited.some((ms) => ms > 0), "the account slow-down is spent");
});

test("X-Real-IP is not trusted by default either", async () => {
  const rotated = await guessRun({ ...options }, 40, (i) => ({ "x-real-ip": `198.51.100.${i}` }));
  assert.equal(rotated.status[429] ?? 0, 0);
  assert.ok(rotated.waited.some((ms) => ms > 0));
});

test("a spoofed first hop in front of the real proxy address is ignored when untrusted", async () => {
  const spoofed = await guessRun({ ...options }, 40, (i) => ({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` }));
  assert.equal(spoofed.status[429] ?? 0, 0);
});

test("behind a trusted proxy, alternate spellings of one address share one bucket", async () => {
  // ::ffff:127.0.0.1 and ::ffff:7f00:1 are 127.0.0.1; a limit that counted
  // them apart would let one machine act as three.
  const spellings = ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:127.0.0.1"];
  const run = await guessRun({ ...trusting }, 40, (i) => ({ "x-forwarded-for": spellings[i % spellings.length] }));

  // One bucket: after ten failures it locks, so most of the forty are 429.
  assert.ok((run.status[429] ?? 0) >= 25, `expected a locked bucket, saw ${JSON.stringify(run.status)}`);
});

test("behind a trusted proxy, a header of junk cannot mint a fresh bucket per request", async () => {
  // Not an address, so it is treated as unattributed rather than a new caller.
  const junk = await guessRun({ ...trusting }, 40, (i) => ({ "x-forwarded-for": `not-an-ip-${i}` }));
  assert.equal(junk.status[429] ?? 0, 0, "junk keys do not lock, but they also do not multiply");
});

test("the account slow-down grows and then holds, and the right password still gets through", async () => {
  resetAttempts();
  const waited: number[] = [];
  const recording = { ...options, sleep: async (ms: number) => { waited.push(ms); } };
  const wrong = (i: number) => new Request("https://skybook.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i}` },
    body: JSON.stringify({ email: "ana@skybook.example", password: "wrong" }),
  });

  for (let i = 0; i < 13; i += 1) await loginRoute(wrong(i), recording, NOW);

  assert.deepEqual(waited, [0, 0, 0, 0, 0, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);

  // No lockout: the real user, with the real password, still signs in.
  const right = new Request("https://skybook.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ana@skybook.example", password: PASSWORD }),
  });
  const success = await loginRoute(right, recording, NOW);
  assert.equal(success.ok, true);
});

test("the trust-proxy flag is read from the environment when the option is absent", async () => {
  const previous = process.env.SKYBOOK_TRUST_PROXY;
  try {
    process.env.SKYBOOK_TRUST_PROXY = "true";
    resetAttempts();
    const envOptions = { db: dbReturning(ACTIVE_USER), secret: SECRET, sleep: async () => {} };
    for (let n = 0; n < 10; n += 1) {
      await loginRoute(attempt({ email: "ana@skybook.example", password: "no" }, "9.9.9.9"), envOptions, NOW);
    }
    const blocked = await loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }, "9.9.9.9"), envOptions, NOW);
    assert.equal(blocked.ok === false && blocked.status, 429);
  } finally {
    if (previous === undefined) delete process.env.SKYBOOK_TRUST_PROXY;
    else process.env.SKYBOOK_TRUST_PROXY = previous;
  }
});

/* ---------------------------------------------------------------------------
   Address normalisation
   --------------------------------------------------------------------------- */

test("one machine written many ways normalises to one key", () => {
  const forms = ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1"];
  for (const form of forms) {
    assert.equal(normaliseCaller(form), "127.0.0.1", form);
  }
});

test("a public IPv4-mapped address unwraps too", () => {
  assert.equal(normaliseCaller("::ffff:203.0.113.7"), "203.0.113.7");
});

test("an ordinary IPv6 address is lower-cased and kept", () => {
  assert.equal(normaliseCaller("2001:DB8::1"), "2001:db8::1");
});

test("anything that is not an address is refused, so it cannot mint a bucket", () => {
  for (const junk of ["not-an-ip", "127.000.000.001", "", "   ", "1.2.3.4.5", "example.com", "<script>"]) {
    assert.equal(normaliseCaller(junk), null, JSON.stringify(junk));
  }
});

test("callerAddress ignores the headers entirely when the proxy is not trusted", () => {
  const request = new Request("https://skybook.example/api/auth/login", {
    headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1" },
  });
  assert.equal(callerAddress(request, false), "unattributed");
});

test("callerAddress reads and normalises the first forwarded hop when trusted", () => {
  const request = new Request("https://skybook.example/api/auth/login", {
    headers: { "x-forwarded-for": "::ffff:203.0.113.7, 10.0.0.1" },
  });
  assert.equal(callerAddress(request, true), "203.0.113.7");
});

test("callerAddress falls back to unattributed when a trusted header is junk", () => {
  const request = new Request("https://skybook.example/api/auth/login", {
    headers: { "x-forwarded-for": "not-an-ip" },
  });
  assert.equal(callerAddress(request, true), "unattributed");
});
