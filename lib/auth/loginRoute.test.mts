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
import { AFTER_LOGIN, CANNOT_SIGN_IN, LOGIN_PATH, loginRoute, logoutRoute } from "./loginRoute.ts";

const PASSWORD = "a-password-the-salesperson-chose";
const HASH = hashPassword(PASSWORD);
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const NOW = 1_757_000_000_000;

const options = { email: "ana@skybook.example", passwordHash: HASH, secret: SECRET };

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

    // The end-to-end property: what sign-in issues, the guard accepts.
    assert.deepEqual(readSession(result.cookie, options, NOW)?.email, "ana@skybook.example");
    assert.equal(result.email, "ana@skybook.example");
    assert.equal(result.maxAgeSeconds, sessionCookieOptions().maxAge);
  });
});

test("the session carries an address and nothing else", () => {
  /*
   * No role, no permissions, no user type, no flag. The whole model is who is
   * signed in, and that is what keeps a later move to Google a change to one
   * file.
   */
  resetAttempts();

  return loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }), options, NOW).then(
    (result) => {
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const session = readSession(result.cookie, options, NOW);
      assert.deepEqual(Object.keys(session ?? {}).sort(), ["email", "expiresAt"]);
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
  assert.deepEqual(Object.keys(session ?? {}).sort(), ["email", "expiresAt"]);
});

test("too many attempts are refused with 429 rather than 401", async () => {
  resetAttempts();

  for (let n = 0; n < 10; n += 1) {
    await loginRoute(attempt({ email: "ana@skybook.example", password: "no" }, "9.9.9.9"), options, NOW);
  }

  const blocked = await loginRoute(attempt({ email: "ana@skybook.example", password: PASSWORD }, "9.9.9.9"), options, NOW);

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

test("a server with no account configured refuses with 503, not 401", async () => {
  resetAttempts();

  const outcome = await loginRoute(
    attempt({ email: "ana@skybook.example", password: PASSWORD }),
    { secret: SECRET },
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
