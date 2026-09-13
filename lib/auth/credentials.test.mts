/**
 * Tests for the one seeded account and the guard on guessing it.
 *
 * THESE RUN THE REAL HASH, which is deliberately slow, so this file is slower
 * than anything else in the suite. Substituting a fast hash for the tests
 * would be testing a different function: the cost IS the protection, and a
 * test that never pays it cannot notice the day somebody turns it down.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  ATTEMPT_WINDOW_MS,
  EMAIL_VARIABLE,
  MAX_FAILED_ATTEMPTS,
  PASSWORD_HASH_VARIABLE,
  RATE_LIMITED,
  REJECTED,
  checkPassword,
  credentialsAvailable,
  hashPassword,
  resetAttempts,
  signIn,
} from "./credentials.ts";

/** Hashed once, because scrypt is slow on purpose and this file uses it a lot. */
const PASSWORD = "a-password-the-salesperson-chose";
const HASH = hashPassword(PASSWORD);

const account = { email: "ana@skybook.example", passwordHash: HASH };
const NOW = 1_757_000_000_000;

/* ---------------------------------------------------------------------------
   Hashing
   --------------------------------------------------------------------------- */

test("a password is stored as a salted hash and never as itself", () => {
  const stored = hashPassword("hunter2");

  assert.ok(!stored.includes("hunter2"), "the password is not in the stored value");
  assert.match(stored, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "scheme, salt and hash");
});

test("a stored hash survives an environment file unescaped", () => {
  /*
   * THE REGRESSION TEST FOR A REAL OUTAGE, and the reason this format uses a
   * colon rather than the dollar sign every Unix crypt format uses.
   *
   * A stored hash lives in `.env.local` and nowhere else. The framework's
   * environment loader expands `$name` as a reference to another variable, so
   * `scrypt$<salt>$<key>` reached the server as the six characters "scrypt":
   * both halves were read as references to variables that do not exist and
   * replaced with nothing. Every password was then wrong, with a message
   * saying exactly that.
   *
   * Asserting the absence of a dollar sign is the property that matters, and
   * it is cheap. Loading the framework here to prove it end to end would make
   * this test slow and this file dependent on a bundler.
   */
  const stored = hashPassword("any password at all");

  assert.ok(!stored.includes("$"), "no dollar sign for an env loader to expand");
  assert.ok(!stored.includes("\\"), "and no escape anybody has to remember");
});

test("the same password hashes differently every time", () => {
  /*
   * The salt earning its place. Without one, two people choosing the same
   * password store the same bytes, and one precomputed table covers both.
   */
  assert.notEqual(hashPassword("hunter2"), hashPassword("hunter2"));
});

test("a hash matches its own password and nothing else", () => {
  assert.equal(checkPassword(PASSWORD, HASH), true);

  for (const wrong of ["", " ", PASSWORD.toUpperCase(), `${PASSWORD} `, "hunter2"]) {
    assert.equal(checkPassword(wrong, HASH), false, JSON.stringify(wrong));
  }
});

test("a password is case-sensitive, because everybody knows one is", () => {
  assert.equal(checkPassword(PASSWORD.toUpperCase(), HASH), false);
});

test("a mistyped hash locks the door rather than opening it", () => {
  /*
   * FALSE FOR EVERY MALFORMED VALUE, never a throw and never true. Somebody
   * pasting half a hash into the environment file must end up unable to sign
   * in, not able to sign in with anything.
   */
  for (const broken of [
    "",
    "scrypt",
    "scrypt:",
    "scrypt:salt",
    "bcrypt:salt:hash",
    "scrypt:salt:not-hex",
    HASH.slice(0, 20),
    // The old dollar-separated format. It must not be quietly accepted.
    "scrypt$0123456789abcdef$0123456789abcdef",
    // What the environment loader turned that format into, which is what was
    // actually reaching the server when nobody could sign in.
    "scrypt",
  ]) {
    assert.equal(checkPassword(PASSWORD, broken), false, JSON.stringify(broken));
  }
});

/* ---------------------------------------------------------------------------
   Signing in
   --------------------------------------------------------------------------- */

test("the right address and password sign in", () => {
  resetAttempts();
  const result = signIn("ana@skybook.example", PASSWORD, "1.2.3.4", account, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.email : "", "ana@skybook.example");
});

test("the address is matched without regard to case or surrounding space", () => {
  // Nobody thinks of their email address as having a case.
  resetAttempts();

  for (const typed of ["ANA@SKYBOOK.EXAMPLE", "  Ana@Skybook.Example  "]) {
    assert.equal(signIn(typed, PASSWORD, "1.2.3.4", account, NOW).ok, true, typed);
  }
});

test("a wrong address and a wrong password are refused in the same words", () => {
  /*
   * ONE SENTENCE FOR BOTH. Telling somebody the address was right and only the
   * password wrong confirms the account exists, which is the first thing
   * anybody guessing wants to know.
   */
  resetAttempts();

  const wrongAddress = signIn("someone@else.example", PASSWORD, "1.2.3.4", account, NOW);
  const wrongPassword = signIn("ana@skybook.example", "not-it", "5.6.7.8", account, NOW);

  assert.equal(wrongAddress.ok, false);
  assert.equal(wrongPassword.ok, false);
  assert.equal(
    wrongAddress.ok === false ? wrongAddress.message : "",
    wrongPassword.ok === false ? wrongPassword.message : "-",
  );
  assert.equal(wrongAddress.ok === false ? wrongAddress.message : "", REJECTED);
});

test("no refusal names the address, the password or the hash", () => {
  resetAttempts();
  const refused = signIn("someone@else.example", "guess", "1.2.3.4", account, NOW);

  assert.equal(refused.ok, false);
  if (refused.ok) return;

  for (const secret of [PASSWORD, HASH, "someone@else.example", "ana@skybook.example"]) {
    assert.ok(!refused.message.includes(secret), `must not quote ${secret.slice(0, 12)}`);
  }
});

test("a server with no account configured refuses everybody", () => {
  /*
   * FAILS CLOSED. The wrong behaviour is not an error: it is an application
   * that lets anybody in because there is nothing to check against.
   */
  resetAttempts();

  for (const missing of [
    {},
    { email: "ana@skybook.example", passwordHash: "" },
    { email: "", passwordHash: HASH },
  ]) {
    assert.equal(credentialsAvailable(missing), false, JSON.stringify(missing));
    assert.equal(signIn("ana@skybook.example", PASSWORD, "1.2.3.4", missing, NOW).ok, false);
  }
});

test("an empty password is refused even against a configured account", () => {
  resetAttempts();
  assert.equal(signIn("ana@skybook.example", "", "1.2.3.4", account, NOW).ok, false);
});

/* ---------------------------------------------------------------------------
   Guessing
   --------------------------------------------------------------------------- */

test("a caller is locked out after too many wrong attempts", () => {
  resetAttempts();

  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    const refused = signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
    assert.equal(refused.ok === false && refused.reason, "rejected", `attempt ${attempt}`);
  }

  const blocked = signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  assert.equal(blocked.ok === false && blocked.reason, "rate-limited");
  assert.equal(blocked.ok === false && blocked.message, RATE_LIMITED);
});

test("the lock holds even when the password is finally right", () => {
  /*
   * THE TEST THAT MATTERS. A lock that opens for a correct password is not a
   * lock, because a correct password is exactly what somebody guessing is
   * looking for.
   */
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal(signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW).ok, false);
});

test("one caller's guessing does not lock anybody else out", () => {
  // Keyed per caller, so a script somewhere must not shut the salesperson out.
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal(signIn("ana@skybook.example", PASSWORD, "1.2.3.4", account, NOW).ok, true);
});

test("the lock lifts once the window has passed", () => {
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal(signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW).ok, false);
  assert.equal(
    signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW + ATTEMPT_WINDOW_MS + 1).ok,
    true,
  );
});

test("a blocked attempt does not extend its own lockout", () => {
  /*
   * Otherwise somebody hammering the form keeps themselves locked out for
   * ever, including the salesperson who typed their password wrong and then
   * refreshed the page a few times.
   */
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS + 20; attempt += 1) {
    signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  const justAfter = NOW + ATTEMPT_WINDOW_MS + 1;
  assert.equal(signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, justAfter).ok, true);
});

test("getting it right clears the failures behind it", () => {
  // Four typos and then success is not four typos away from a lockout.
  resetAttempts();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal(signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW).ok, true);

  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    const refused = signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
    assert.equal(refused.ok === false && refused.reason, "rejected", `attempt ${attempt}`);
  }
});

/* ---------------------------------------------------------------------------
   What this module cannot do, asserted against the source
   --------------------------------------------------------------------------- */

test("guessing is counted apart from the audit allowance", () => {
  /*
   * THE SAME DECISION THIS PROJECT ALREADY MADE ABOUT EXPORTING A REPORT. That
   * bucket bounds how many audits a caller may start and how much metered
   * Google quota they may spend. Sharing it would let somebody guessing
   * passwords block the salesperson from running an audit, and would let a
   * busy morning of auditing lock the login.
   */
  const source = fs.readFileSync(new URL("./credentials.ts", import.meta.url), "utf8");

  assert.ok(!source.includes("checkRateLimit"), "it does not consult the audit limiter");
  assert.ok(!source.includes("rateLimit"), "and does not import it");
});

test("nothing here stores, sends or measures anything", () => {
  const source = fs.readFileSync(new URL("./credentials.ts", import.meta.url), "utf8");

  for (const forbidden of [
    "fetch(",
    "localStorage",
    "postgres",
    "prisma",
    "resend",
    "../ai/",
    "../audit/",
    "../collector/",
    "../rules/",
  ]) {
    assert.ok(!source.includes(forbidden), `the credentials module must not reach ${forbidden}`);
  }
});

test("no password or hash is ever written to the console", () => {
  const source = fs.readFileSync(new URL("./credentials.ts", import.meta.url), "utf8");

  for (const forbidden of ["console.log", "console.warn", "console.error"]) {
    assert.ok(!source.includes(forbidden), `the credentials module must not ${forbidden}`);
  }
});

test("the account is read from variables no bundler will publish", () => {
  // The one prefix that puts a value in the browser bundle is the one prefix
  // neither of these may ever have.
  for (const variable of [EMAIL_VARIABLE, PASSWORD_HASH_VARIABLE]) {
    assert.ok(!variable.startsWith("NEXT_PUBLIC"), variable);
  }
});
