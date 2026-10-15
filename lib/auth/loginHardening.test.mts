/**
 * Tests for the login hardening: per-account slow-down, the spraying guard,
 * bounded failure records, and asynchronous password hashing.
 *
 * WHAT IS PROVED:
 *
 *   - one account's failures never delay another account's attempts, and a
 *     success clears only the account that succeeded;
 *   - an address with no account builds up its delay exactly as a real one
 *     does, so the delay reveals nothing about who is registered;
 *   - failures spread across many accounts are slowed by the spraying guard,
 *     which never delays a correct password and is not cleared by a success;
 *   - every failure record expires and stays within its limit;
 *   - hashing is the same function as before, byte for byte, and no longer
 *     holds up the server while it runs.
 *
 * Deterministic: time is passed in, nothing sleeps. No network, no real database.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { scryptSync } from "node:crypto";
import {
  ACCOUNT_BASE_DELAY_MS,
  ACCOUNT_FREE_ATTEMPTS,
  ACCOUNT_MAX_DELAY_MS,
  ATTEMPT_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_TRACKED_ACCOUNTS,
  MAX_TRACKED_CALLERS,
  SPRAY_FREE_FAILURES,
  UNATTRIBUTED,
  accountDelayMs,
  checkPassword,
  hashPassword,
  recordFailure,
  resetAttempts,
  signIn,
  sprayDelayMs,
  trackedFailureCounts,
} from "./credentials.ts";

const NOW = 1_757_000_000_000;
const PASSWORD_A = "ana-has-a-long-password-1";
const PASSWORD_B = "ben-has-a-long-password-2";
const HASH_A = await hashPassword(PASSWORD_A);
const HASH_B = await hashPassword(PASSWORD_B);

function row(id: string, email: string, hash: string) {
  return {
    id,
    email,
    password_hash: hash,
    role: "SALES",
    status: "ACTIVE",
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    approved_by: null,
    approved_at: null,
    last_login_at: null,
    must_change_password: false,
  };
}

/** Two real accounts, Ana and Ben. Any other address has no account. */
const USERS = [row("a", "ana@skybook.example", HASH_A), row("b", "ben@skybook.example", HASH_B)];
const db = {
  async query(sql: string, params: unknown[] = []) {
    if (/^\s*SELECT/i.test(sql)) {
      const wanted = String(params[0] ?? "").toLowerCase();
      return { rows: USERS.filter((user) => user.email === wanted) };
    }
    return { rows: [] };
  },
};
const options = { db };

const attempt = (email: string, password: string, now = NOW, caller = UNATTRIBUTED) =>
  signIn(email, password, caller, options, now);

/** Fails `count` times against `email`. */
async function failTimes(email: string, count: number, now = NOW, caller = UNATTRIBUTED) {
  for (let i = 0; i < count; i += 1) await attempt(email, "wrong-password", now, caller);
}

// ---------------------------------------------------------------------------
// Per-account slow-down
// ---------------------------------------------------------------------------

test("one account's failures do not delay another account, right or wrong", async () => {
  resetAttempts();
  await failTimes("ana@skybook.example", ACCOUNT_FREE_ATTEMPTS + 5);

  const anaNext = await attempt("ana@skybook.example", "wrong-password");
  assert.ok(anaNext.ok === false && anaNext.delayMs > 0, "Ana's account is slowed");

  const benWrong = await attempt("ben@skybook.example", "wrong-password");
  assert.equal(benWrong.ok === false && benWrong.delayMs, 0, "Ben's mistake is not slowed by Ana's");

  const benRight = await attempt("ben@skybook.example", PASSWORD_B);
  assert.equal(benRight.ok, true);
  assert.equal(benRight.delayMs, 0, "and Ben's correct password is not held up at all");
});

test("a success clears only the account that succeeded", async () => {
  resetAttempts();
  await failTimes("ana@skybook.example", ACCOUNT_FREE_ATTEMPTS + 3);

  const ben = await attempt("ben@skybook.example", PASSWORD_B);
  assert.equal(ben.ok, true);

  const ana = await attempt("ana@skybook.example", "wrong-password");
  assert.ok(ana.ok === false && ana.delayMs > 0, "Ben signing in did not wipe Ana's record");
});

test("the per-account delay follows the same curve as before", async () => {
  resetAttempts();
  const delays: number[] = [];
  for (let i = 0; i < ACCOUNT_FREE_ATTEMPTS + 8; i += 1) {
    const result = await attempt("ana@skybook.example", "wrong-password");
    delays.push(result.delayMs);
  }
  const expected = Array.from({ length: ACCOUNT_FREE_ATTEMPTS + 8 }, (_, failuresSoFar) => accountDelayMs(failuresSoFar));
  assert.deepEqual(delays, expected);
  assert.equal(accountDelayMs(ACCOUNT_FREE_ATTEMPTS), ACCOUNT_BASE_DELAY_MS);
  assert.equal(accountDelayMs(ACCOUNT_FREE_ATTEMPTS + 50), ACCOUNT_MAX_DELAY_MS);
});

test("addresses are one account however they are typed", async () => {
  resetAttempts();
  await failTimes("  ANA@Skybook.Example ", ACCOUNT_FREE_ATTEMPTS);

  const next = await attempt("ana@skybook.example", "wrong-password");
  assert.ok(next.ok === false && next.delayMs > 0, "case and spaces do not make a new account");
});

test("an address with no account is slowed exactly as a real one is", async () => {
  resetAttempts();
  const real: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < ACCOUNT_FREE_ATTEMPTS + 4; i += 1) {
    real.push((await attempt("ana@skybook.example", "wrong-password")).delayMs);
    unknown.push((await attempt("nobody@skybook.example", "wrong-password")).delayMs);
  }
  assert.deepEqual(unknown, real, "the delay says nothing about whether the address is registered");
});

test("an account's record expires after the window", async () => {
  resetAttempts();
  await failTimes("ana@skybook.example", ACCOUNT_FREE_ATTEMPTS + 3);

  const later = await attempt("ana@skybook.example", "wrong-password", NOW + ATTEMPT_WINDOW_MS + 1);
  assert.equal(later.ok === false && later.delayMs, 0, "old failures no longer count");
});

test("the right password still succeeds during an account's slow-down", async () => {
  resetAttempts();
  await failTimes("ana@skybook.example", ACCOUNT_FREE_ATTEMPTS + 5);

  const right = await attempt("ana@skybook.example", PASSWORD_A);
  assert.equal(right.ok, true, "slowed, never locked");
  assert.ok(right.delayMs > 0, "and held for as long as a wrong guess, so the delay leaks nothing");
});

// ---------------------------------------------------------------------------
// Spraying guard
// ---------------------------------------------------------------------------

test("failures spread across many accounts are slowed once past the guard's threshold", async () => {
  resetAttempts();
  for (let i = 0; i < SPRAY_FREE_FAILURES; i += 1) {
    const result = await attempt(`sprayed-${i}@skybook.example`, "wrong-password");
    assert.equal(result.delayMs, 0, `failure ${i + 1} is within the allowance`);
  }

  const next = await attempt("one-more@skybook.example", "wrong-password");
  assert.equal(next.ok === false && next.delayMs, sprayDelayMs(SPRAY_FREE_FAILURES));
  assert.ok(next.delayMs > 0);
});

test("the spraying guard never delays a correct password", async () => {
  resetAttempts();
  for (let i = 0; i < SPRAY_FREE_FAILURES + 10; i += 1) await attempt(`sprayed-${i}@skybook.example`, "wrong-password");

  const ben = await attempt("ben@skybook.example", PASSWORD_B);
  assert.equal(ben.ok, true);
  assert.equal(ben.delayMs, 0, "a correct password is not held up by other accounts' failures");
});

test("the spraying guard is not cleared by somebody else's success, and does expire", async () => {
  resetAttempts();
  for (let i = 0; i < SPRAY_FREE_FAILURES + 2; i += 1) await attempt(`sprayed-${i}@skybook.example`, "wrong-password");

  assert.equal((await attempt("ben@skybook.example", PASSWORD_B)).ok, true);

  const stillSlowed = await attempt("another@skybook.example", "wrong-password");
  assert.ok(stillSlowed.ok === false && stillSlowed.delayMs > 0, "Ben signing in did not reset the guard");

  const later = await attempt("later@skybook.example", "wrong-password", NOW + ATTEMPT_WINDOW_MS + 1);
  assert.equal(later.ok === false && later.delayMs, 0, "and it forgets after the window");
});

test("the spraying guard keeps a bounded number of failures", async () => {
  resetAttempts();
  for (let i = 0; i < SPRAY_FREE_FAILURES + 150; i += 1) await attempt(`sprayed-${i}@skybook.example`, "wrong-password");

  assert.ok(trackedFailureCounts().spray <= SPRAY_FREE_FAILURES + 100, `kept ${trackedFailureCounts().spray}`);
  assert.equal(sprayDelayMs(SPRAY_FREE_FAILURES + 100), ACCOUNT_MAX_DELAY_MS, "and that is already enough to reach the longest delay");
});

// ---------------------------------------------------------------------------
// The per-caller limit, unchanged
// ---------------------------------------------------------------------------

test("the per-caller limit is unchanged: ten failures from one trusted caller, then 429", async () => {
  resetAttempts();
  assert.equal(MAX_FAILED_ATTEMPTS, 10);
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
    await attempt(`target-${i}@skybook.example`, "wrong-password", NOW, "203.0.113.7");
  }
  const refused = await attempt("ben@skybook.example", PASSWORD_B, NOW, "203.0.113.7");
  assert.equal(refused.ok === false && refused.reason, "rate-limited");
});

// ---------------------------------------------------------------------------
// Parallel attempts
//
// Every attempt waits for the database and for scrypt between reading the
// failure history and recording its own failure. Attempts running at the same
// time must each be counted, not overwrite one another. No sleeps: the burst is
// started in one go with Promise.all, so every attempt reads the history before
// any of them records a failure -- the exact situation the race needs.
// ---------------------------------------------------------------------------

const BURST = 20;

test("twenty parallel failures from one caller are all counted", async () => {
  resetAttempts();
  const caller = "203.0.113.20";

  const burst = await Promise.all(
    Array.from({ length: BURST }, (_, i) => attempt(`burst-${i}@skybook.example`, "wrong-password", NOW, caller)),
  );
  assert.ok(burst.every((result) => result.ok === false), "every attempt in the burst failed");

  const next = await attempt("ben@skybook.example", PASSWORD_B, NOW, caller);
  assert.equal(next.ok === false && next.reason, "rate-limited", "no further attempt is allowed before the per-caller limit");
});

test("twenty parallel failures on one account all add to its delay", async () => {
  resetAttempts();

  await Promise.all(Array.from({ length: BURST }, () => attempt("ana@skybook.example", "wrong-password")));

  const next = await attempt("ana@skybook.example", "wrong-password");
  assert.equal(accountDelayMs(BURST), ACCOUNT_MAX_DELAY_MS, "twenty failures reach the longest delay on the existing curve");
  assert.equal(next.ok === false && next.delayMs, ACCOUNT_MAX_DELAY_MS);
});

test("parallel failures on two accounts stay separate", async () => {
  resetAttempts();

  await Promise.all([
    ...Array.from({ length: ACCOUNT_FREE_ATTEMPTS + 3 }, () => attempt("ana@skybook.example", "wrong-password")),
    attempt("ben@skybook.example", "wrong-password"),
  ]);

  const ana = await attempt("ana@skybook.example", "wrong-password");
  const ben = await attempt("ben@skybook.example", PASSWORD_B);
  assert.equal(ana.ok === false && ana.delayMs, accountDelayMs(ACCOUNT_FREE_ATTEMPTS + 3), "Ana has all her own failures");
  assert.equal(ben.ok, true);
  assert.equal(ben.delayMs, 0, "and none of them reached Ben");
});

test("a burst that arrives before any failure is recorded is still admitted as a whole", async () => {
  // The limit of the minimal fix, stated as a test so nobody mistakes it for
  // more: the per-caller check runs before any attempt in the burst has failed,
  // so a burst larger than the limit is admitted. Every failure is then counted.
  resetAttempts();
  const caller = "203.0.113.21";

  const burst = await Promise.all(
    Array.from({ length: MAX_FAILED_ATTEMPTS + 5 }, () => attempt("ana@skybook.example", "wrong-password", NOW, caller)),
  );
  assert.equal(burst.filter((result) => result.ok === false && result.reason === "rate-limited").length, 0);

  const after = await attempt("ana@skybook.example", "wrong-password", NOW, caller);
  assert.equal(after.ok === false && after.reason, "rate-limited");
});

// ---------------------------------------------------------------------------
// Bounded records
// ---------------------------------------------------------------------------

test("a failure record keeps within its limit, dropping expired entries first", () => {
  const map = new Map<string, number[]>();
  // Three expired entries and two live ones.
  for (const key of ["old-1", "old-2", "old-3"]) recordFailure(map, key, [NOW - ATTEMPT_WINDOW_MS - 10], 100, NOW);
  for (const key of ["live-1", "live-2"]) recordFailure(map, key, [NOW - 1_000], 100, NOW);
  assert.equal(map.size, 5, "nothing is dropped while under the limit");

  recordFailure(map, "new", [NOW], 3, NOW);
  assert.deepEqual([...map.keys()], ["live-1", "live-2", "new"], "over the limit, the expired go first");
});

test("when nothing has expired, the entries whose last failure is oldest are dropped", () => {
  const map = new Map<string, number[]>();
  for (let i = 0; i < 5; i += 1) recordFailure(map, `k${i}`, [NOW + i], 100, NOW + i);
  recordFailure(map, "k0", [NOW, NOW + 10], 100, NOW + 10); // k0 fails again: now the newest
  recordFailure(map, "k5", [NOW + 11], 4, NOW + 11);

  assert.equal(map.size, 4);
  assert.deepEqual([...map.keys()], ["k3", "k4", "k0", "k5"], "k1 and k2 had the oldest last failures");
});

test("the documented limits are the intended ones", () => {
  assert.equal(MAX_TRACKED_ACCOUNTS, 1_000);
  assert.equal(MAX_TRACKED_CALLERS, 10_000);
  assert.equal(SPRAY_FREE_FAILURES, 50);
});

test("signing in records failures through the bounded maps, and a success removes them", async () => {
  resetAttempts();
  await attempt("ana@skybook.example", "wrong-password", NOW, "203.0.113.8");
  await attempt("nobody@skybook.example", "wrong-password", NOW, "203.0.113.9");
  assert.deepEqual(trackedFailureCounts(), { callers: 2, accounts: 2, spray: 2 });

  await attempt("ana@skybook.example", PASSWORD_A, NOW, "203.0.113.8");
  assert.deepEqual(trackedFailureCounts(), { callers: 1, accounts: 1, spray: 2 }, "Ana's own records only");
});

// ---------------------------------------------------------------------------
// Asynchronous hashing, byte-identical to before
// ---------------------------------------------------------------------------

/** The hash exactly as the previous, synchronous code produced it. */
function previousHash(password: string, salt: string): string {
  const key = scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }).toString("hex");
  return ["scrypt", salt, key].join(":");
}

test("the same password and salt produce exactly the hash the previous code produced", async () => {
  const salt = "00112233445566778899aabbccddeeff";
  assert.equal(await hashPassword("a-stored-password", salt), previousHash("a-stored-password", salt));
});

test("a hash stored by the previous code still verifies, and only for its own password", async () => {
  const stored = previousHash("an-existing-account-password", "a1b2c3d4e5f60718293a4b5c6d7e8f90");

  assert.equal(await checkPassword("an-existing-account-password", stored), true);
  assert.equal(await checkPassword("an-existing-account-passworD", stored), false);
});

test("the server keeps answering while a password is being checked", async () => {
  let timerRan = false;
  let hashDone = false;
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerRan = true;
      assert.equal(hashDone, false, "the timer ran while the hash was still being computed");
      resolve();
    }, 1),
  );

  const checking = checkPassword(PASSWORD_A, HASH_A).then((result) => {
    hashDone = true;
    return result;
  });

  await timer;
  assert.equal(await checking, true);
  assert.equal(timerRan, true);
});

test("a hashing failure is a plain false, never a thrown error or a detail", async () => {
  // A salt Node refuses to use would make the derivation fail; the stored value
  // here is well-formed but its key cannot match, and nothing throws.
  for (const stored of ["scrypt:00:zz", "scrypt:salt:" + "0".repeat(64)]) {
    assert.equal(await checkPassword("anything", stored), false);
  }
});
