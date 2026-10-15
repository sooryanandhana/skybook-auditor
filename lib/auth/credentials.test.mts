/**
 * Tests for authentication and the guard on guessing an account.
 *
 * THESE RUN THE REAL HASH, which is deliberately slow, so this file is slower
 * than anything else in the suite. Substituting a fast hash for the tests
 * would be testing a different function: the cost IS the protection, and a
 * test that never pays it cannot notice the day somebody turns it down.
 *
 * NO REAL DATABASE. `signIn` reads accounts through the repository, which takes
 * an injected `Db`; these drive it with a fake that returns a chosen account
 * and records any writes, so the whole flow is exercised without PostgreSQL.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  ATTEMPT_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  RATE_LIMITED,
  REJECTED,
  UNATTRIBUTED,
  ACCOUNT_FREE_ATTEMPTS,
  ACCOUNT_BASE_DELAY_MS,
  ACCOUNT_MAX_DELAY_MS,
  accountDelayMs,
  checkPassword,
  hashPassword,
  resetAttempts,
  signIn,
  SPRAY_FREE_FAILURES,
} from "./credentials.ts";

/** Hashed once, because scrypt is slow on purpose and this file uses it a lot. */
const PASSWORD = "a-password-the-salesperson-chose";
const HASH = await hashPassword(PASSWORD);

const NOW = 1_757_000_000_000;
const USER_ID = "11111111-1111-1111-1111-111111111111";

/** One account row, exactly as PostgreSQL returns it (snake_case). */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
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
    ...overrides,
  };
}

/**
 * A fake database that returns `user` for its own address (case-insensitively,
 * as citext would) and nothing for any other, recording every write so a test
 * can see whether the login time was stamped.
 */
function dbWith(user: Record<string, unknown> | null) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*SELECT/i.test(sql)) {
        const wanted = String(params[0] ?? "").toLowerCase();
        const match = user !== null && wanted === String(user.email).toLowerCase();
        return { rows: match ? [user] : [] };
      }
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
  return { db, writes };
}

/** A database that cannot be reached. */
const brokenDb = {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error("database unavailable");
  },
};

/** Sign-in options pointing at a fresh fake holding the given account. */
function opts(user: Record<string, unknown> | null = userRow()) {
  return { db: dbWith(user).db };
}

/** The ACTIVE salesperson, as a single reusable fake for the guessing tests. */
const account = { db: dbWith(userRow()).db };

/* ---------------------------------------------------------------------------
   Hashing — unchanged by the move to a database
   --------------------------------------------------------------------------- */

test("a password is stored as a salted hash and never as itself", async () => {
  const stored = await hashPassword("hunter2");

  assert.ok(!stored.includes("hunter2"), "the password is not in the stored value");
  assert.match(stored, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "scheme, salt and hash");
});

test("a stored hash survives an environment file unescaped", async () => {
  /*
   * THE REGRESSION TEST FOR A REAL OUTAGE, and the reason this format uses a
   * colon rather than the dollar sign every Unix crypt format uses.
   *
   * A stored hash lived in `.env.local`, and the framework's environment loader
   * expands `$name` as a reference to another variable, so `scrypt$<salt>$<key>`
   * reached the server as the six characters "scrypt". The hash is in the
   * database now, but the format is unchanged and the property is still cheap to
   * keep: a value with no dollar sign cannot be mangled that way wherever it is
   * pasted.
   */
  const stored = await hashPassword("any password at all");

  assert.ok(!stored.includes("$"), "no dollar sign for an env loader to expand");
  assert.ok(!stored.includes("\\"), "and no escape anybody has to remember");
});

test("the same password hashes differently every time", async () => {
  /*
   * The salt earning its place. Without one, two people choosing the same
   * password store the same bytes, and one precomputed table covers both.
   */
  assert.notEqual(await hashPassword("hunter2"), await hashPassword("hunter2"));
});

test("a hash matches its own password and nothing else", async () => {
  assert.equal(await checkPassword(PASSWORD, HASH), true);

  for (const wrong of ["", " ", PASSWORD.toUpperCase(), `${PASSWORD} `, "hunter2"]) {
    assert.equal(await checkPassword(wrong, HASH), false, JSON.stringify(wrong));
  }
});

test("a password is case-sensitive, because everybody knows one is", async () => {
  assert.equal(await checkPassword(PASSWORD.toUpperCase(), HASH), false);
});

test("a mistyped hash locks the door rather than opening it", async () => {
  /*
   * FALSE FOR EVERY MALFORMED VALUE, never a throw and never true. A broken hash
   * in the database must leave the owner unable to sign in, not able to sign in
   * with anything.
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
    assert.equal(await checkPassword(PASSWORD, broken), false, JSON.stringify(broken));
  }
});

/* ---------------------------------------------------------------------------
   Signing in
   --------------------------------------------------------------------------- */

test("the right address and password sign in, carrying id, email and role", async () => {
  resetAttempts();
  const result = await signIn("ana@skybook.example", PASSWORD, "1.2.3.4", opts(userRow({ role: "MANAGEMENT" })), NOW);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.user.id, USER_ID);
  assert.equal(result.user.email, "ana@skybook.example");
  assert.equal(result.user.role, "MANAGEMENT");
});

test("the address is matched without regard to case or surrounding space", async () => {
  // Nobody thinks of their email address as having a case.
  resetAttempts();

  for (const typed of ["ANA@SKYBOOK.EXAMPLE", "  Ana@Skybook.Example  "]) {
    assert.equal((await signIn(typed, PASSWORD, "1.2.3.4", account, NOW)).ok, true, typed);
  }
});

test("a wrong address and a wrong password are refused in the same words", async () => {
  /*
   * ONE SENTENCE FOR BOTH. Telling somebody the address was right and only the
   * password wrong confirms the account exists, which is the first thing
   * anybody guessing wants to know.
   */
  resetAttempts();

  const wrongAddress = await signIn("someone@else.example", PASSWORD, "1.2.3.4", account, NOW);
  const wrongPassword = await signIn("ana@skybook.example", "not-it", "5.6.7.8", account, NOW);

  assert.equal(wrongAddress.ok, false);
  assert.equal(wrongPassword.ok, false);
  assert.equal(
    wrongAddress.ok === false ? wrongAddress.message : "",
    wrongPassword.ok === false ? wrongPassword.message : "-",
  );
  assert.equal(wrongAddress.ok === false ? wrongAddress.message : "", REJECTED);
});

test("no refusal names the address, the password or the hash", async () => {
  resetAttempts();
  const refused = await signIn("someone@else.example", "guess", "1.2.3.4", account, NOW);

  assert.equal(refused.ok, false);
  if (refused.ok) return;

  for (const secret of [PASSWORD, HASH, "someone@else.example", "ana@skybook.example"]) {
    assert.ok(!refused.message.includes(secret), `must not quote ${secret.slice(0, 12)}`);
  }
});

test("an empty password is refused even against a real account", async () => {
  resetAttempts();
  assert.equal((await signIn("ana@skybook.example", "", "1.2.3.4", account, NOW)).ok, false);
});

/* ---------------------------------------------------------------------------
   Database-backed accounts and their status
   --------------------------------------------------------------------------- */

test("only an ACTIVE account may sign in — PENDING, REJECTED and INACTIVE are refused", async () => {
  // The whole point of the status column: an account that exists and whose
  // password is correct still may not sign in unless it is ACTIVE.
  for (const status of ["PENDING", "REJECTED", "INACTIVE"] as const) {
    resetAttempts();
    const result = await signIn("ana@skybook.example", PASSWORD, "1.2.3.4", opts(userRow({ status })), NOW);

    assert.equal(result.ok, false, status);
    assert.equal(result.ok === false && result.reason, "rejected", status);
    // Refused in the SAME words as a wrong password, so the attempt learns
    // nothing about why — not even that the account exists.
    assert.equal(result.ok === false && result.message, REJECTED, status);
  }
});

test("an unknown email is refused in the same words as a wrong password", async () => {
  resetAttempts();
  const unknown = await signIn("nobody@skybook.example", PASSWORD, "1.2.3.4", opts(userRow()), NOW);
  const wrongPassword = await signIn("ana@skybook.example", "nope", "1.2.3.4", opts(userRow()), NOW);

  assert.equal(unknown.ok === false && unknown.message, REJECTED);
  assert.equal(wrongPassword.ok === false && wrongPassword.message, REJECTED);
});

test("a successful sign-in stamps last_login_at for that user", async () => {
  resetAttempts();
  const { db, writes } = dbWith(userRow());

  const result = await signIn("ana@skybook.example", PASSWORD, "1.2.3.4", { db }, NOW);

  assert.equal(result.ok, true);
  const stamp = writes.find((w) => /UPDATE users SET last_login_at/i.test(w.sql));
  assert.ok(stamp, "last_login_at was updated");
  assert.deepEqual(stamp?.params, [USER_ID], "for that user's id, as a parameter");
});

test("a failed sign-in stamps nothing", async () => {
  resetAttempts();
  const { db, writes } = dbWith(userRow());

  await signIn("ana@skybook.example", "wrong", "1.2.3.4", { db }, NOW);

  assert.equal(writes.length, 0, "a refusal writes nothing");
});

test("a database that cannot be reached is a server fault, not a wrong password", async () => {
  // Fails safe the other way: nobody is let in, and it is reported as the
  // server's problem (503 at the route) rather than as a typo.
  resetAttempts();
  const result = await signIn("ana@skybook.example", PASSWORD, "1.2.3.4", { db: brokenDb }, NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "not-configured");
});

/* ---------------------------------------------------------------------------
   Guessing
   --------------------------------------------------------------------------- */

test("a caller is locked out after too many wrong attempts", async () => {
  resetAttempts();

  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    const refused = await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
    assert.equal(refused.ok === false && refused.reason, "rejected", `attempt ${attempt}`);
  }

  const blocked = await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  assert.equal(blocked.ok === false && blocked.reason, "rate-limited");
  assert.equal(blocked.ok === false && blocked.message, RATE_LIMITED);
});

test("the lock holds even when the password is finally right", async () => {
  /*
   * THE TEST THAT MATTERS. A lock that opens for a correct password is not a
   * lock, because a correct password is exactly what somebody guessing is
   * looking for.
   */
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal((await signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW)).ok, false);
});

test("one caller's guessing does not lock anybody else out", async () => {
  // Keyed per caller, so a script somewhere must not shut the salesperson out.
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal((await signIn("ana@skybook.example", PASSWORD, "1.2.3.4", account, NOW)).ok, true);
});

test("the lock lifts once the window has passed", async () => {
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal((await signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW)).ok, false);
  assert.equal(
    (await signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW + ATTEMPT_WINDOW_MS + 1)).ok,
    true,
  );
});

test("a blocked attempt does not extend its own lockout", async () => {
  /*
   * Otherwise somebody hammering the form keeps themselves locked out for
   * ever, including the salesperson who typed their password wrong and then
   * refreshed the page a few times.
   */
  resetAttempts();
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS + 20; attempt += 1) {
    await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  const justAfter = NOW + ATTEMPT_WINDOW_MS + 1;
  assert.equal((await signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, justAfter)).ok, true);
});

test("getting it right clears the failures behind it", async () => {
  // Four typos and then success is not four typos away from a lockout.
  resetAttempts();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
  }

  assert.equal((await signIn("ana@skybook.example", PASSWORD, "9.9.9.9", account, NOW)).ok, true);

  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    const refused = await signIn("ana@skybook.example", "wrong", "9.9.9.9", account, NOW);
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

test("credentials reaches the database only through the repository, nothing else", () => {
  const source = fs.readFileSync(new URL("./credentials.ts", import.meta.url), "utf8");

  // The one database door it may use.
  assert.ok(source.includes('from "../users/userRepository.ts"'), "it reads accounts through the repository");

  // Note: the pg driver itself is proven confined to lib/db by the walk in
  // lib/db/dependencies.test.mts; naming the import string here would trip that
  // walk (a mention read as an import), so credentials asserts the positive —
  // it reads the database ONLY through the repository, never the pool directly.
  for (const forbidden of [
    "fetch(",
    "localStorage",
    "prisma",
    "resend",
    "../ai/",
    "../audit/",
    "../collector/",
    "../rules/",
    "../db/",
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

/* ---------------------------------------------------------------------------
   The account-level slow-down
   --------------------------------------------------------------------------- */

test("the account delay is zero for the free attempts, then doubles to a cap", () => {
  // Five free, then 500ms doubling: the sixth failed attempt is the first slowed.
  assert.equal(accountDelayMs(0), 0);
  assert.equal(accountDelayMs(ACCOUNT_FREE_ATTEMPTS - 1), 0, "the fifth attempt is still free");
  assert.equal(accountDelayMs(ACCOUNT_FREE_ATTEMPTS), ACCOUNT_BASE_DELAY_MS, "the sixth is the first slowed");
  assert.deepEqual(
    [5, 6, 7, 8, 9, 10, 11, 12].map(accountDelayMs),
    [500, 1000, 2000, 4000, 8000, 16000, ACCOUNT_MAX_DELAY_MS, ACCOUNT_MAX_DELAY_MS],
  );
});

test("the account delay never exceeds its cap, however many failures pile up", () => {
  for (const n of [30, 100, 10_000]) {
    assert.equal(accountDelayMs(n), ACCOUNT_MAX_DELAY_MS, `n=${n}`);
  }
});

test("an unattributed caller is slowed by the account, not hard-locked", async () => {
  // The default posture: no trusted proxy, so every guess is the shared bucket.
  // It must never return rate-limited, or one attacker locks out the one user.
  resetAttempts();

  const delays: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const outcome = await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
    assert.equal(outcome.ok === false && outcome.reason, "rejected", `attempt ${i} must not be rate-limited`);
    if (!outcome.ok) delays.push(outcome.delayMs);
  }

  assert.equal(delays.slice(0, ACCOUNT_FREE_ATTEMPTS).every((ms) => ms === 0), true, "the free ones are instant");
  assert.ok(delays.some((ms) => ms === ACCOUNT_MAX_DELAY_MS), "and later ones reach the cap");
});

test("an attributed caller is still hard-locked after too many failures", async () => {
  // With a trusted address the per-caller limit stands, as it always did.
  resetAttempts();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    await signIn("ana@skybook.example", "wrong", "203.0.113.7", account, NOW);
  }
  const blocked = await signIn("ana@skybook.example", "wrong", "203.0.113.7", account, NOW);
  assert.equal(blocked.ok === false && blocked.reason, "rate-limited");
});

test("the account slow-down is shared, so a second address cannot reset it", async () => {
  // The bypass in miniature at the credential layer: guessing from a fresh
  // address every time still climbs the one account counter.
  resetAttempts();
  for (let i = 0; i < ACCOUNT_FREE_ATTEMPTS + 3; i += 1) {
    await signIn("ana@skybook.example", "wrong", `10.0.0.${i}`, account, NOW);
  }
  const next = await signIn("ana@skybook.example", "wrong", "10.0.0.250", account, NOW);
  assert.ok(next.ok === false && next.delayMs > 0, "a brand-new address is slowed by the shared counter");
});

test("the right password still succeeds during an active account slow-down, and clears it", async () => {
  // No lockout: the point of the slow-down over a hard lock.
  resetAttempts();
  for (let i = 0; i < ACCOUNT_FREE_ATTEMPTS + 5; i += 1) {
    await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
  }
  const success = await signIn("ana@skybook.example", PASSWORD, UNATTRIBUTED, account, NOW);
  assert.equal(success.ok, true);

  // Cleared: the next failure is a fresh, fast attempt.
  const after = await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
  assert.equal(after.ok === false && after.delayMs, 0);
});

test("the account slow-down forgets failures once the window has passed", async () => {
  resetAttempts();
  for (let i = 0; i < ACCOUNT_FREE_ATTEMPTS + 5; i += 1) {
    await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
  }
  const slowed = await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
  assert.ok(slowed.ok === false && slowed.delayMs > 0);

  const later = await signIn("ana@skybook.example", "wrong", UNATTRIBUTED, account, NOW + ATTEMPT_WINDOW_MS + 1);
  assert.equal(later.ok === false && later.delayMs, 0, "old failures no longer count");
});

test("guessing across many addresses feeds the spraying guard, not any one account", async () => {
  // Guessing the username is guessing too. Spread across many addresses it never
  // builds up any one account's delay, so the spraying guard counts it instead:
  // past SPRAY_FREE_FAILURES failures in the window, further failures are slowed.
  resetAttempts();
  for (let i = 0; i < SPRAY_FREE_FAILURES; i += 1) {
    const free = await signIn(`nobody-${i}@skybook.example`, "wrong", UNATTRIBUTED, account, NOW);
    assert.equal(free.ok === false && free.delayMs, 0, `failure ${i + 1} is within the guard's free allowance`);
  }
  const slowed = await signIn("still-wrong@skybook.example", "wrong", UNATTRIBUTED, account, NOW);
  assert.ok(slowed.ok === false && slowed.delayMs > 0, "the next failure, on yet another address, is slowed");
});
