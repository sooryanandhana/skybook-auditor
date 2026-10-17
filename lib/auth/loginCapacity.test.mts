/**
 * Tests for the bound on concurrent sign-in verification work.
 *
 * WHAT IS PROVED:
 *
 *   - at most MAX_ACTIVE_VERIFICATIONS attempts look an account up and check a
 *     password at once, at most MAX_WAITING_VERIFICATIONS wait behind them, and
 *     anything beyond is answered at once as busy;
 *   - a busy answer runs no lookup and no scrypt, records no failure, and is the
 *     same for an address with an account and one without;
 *   - a place is given back however an attempt ends, so none is ever left held;
 *   - the route answers busy with a 503 and a Retry-After.
 *
 * DETERMINISTIC WITHOUT A CLOCK. The fake database holds every account lookup
 * open until the test lets it go, so "how many are running" is read while they
 * are provably still running, not guessed from timings. The only waiting is for
 * the event loop to finish what it already has queued.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import {
  MAX_ACTIVE_VERIFICATIONS,
  MAX_WAITING_VERIFICATIONS,
  SIGN_IN_BUSY,
  UNATTRIBUTED,
  VERIFICATION_RETRY_AFTER_SECONDS,
  claimVerificationSlot,
  hashPassword,
  resetAttempts,
  signIn,
  trackedFailureCounts,
  verificationLoad,
  type SignInResult,
} from "./credentials.ts";
import { loginRoute } from "./loginRoute.ts";

const NOW = 1_757_000_000_000;
const PASSWORD = "ana-has-a-long-password-1";
const HASH = await hashPassword(PASSWORD);
const KNOWN = "ana@skybook.example";
const UNKNOWN = "nobody@skybook.example";
const CAPACITY = MAX_ACTIVE_VERIFICATIONS + MAX_WAITING_VERIFICATIONS;

function row(email: string, status = "ACTIVE") {
  return {
    id: "a",
    email,
    password_hash: HASH,
    role: "SALES",
    status,
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    approved_by: null,
    approved_at: null,
    last_login_at: null,
    must_change_password: false,
  };
}

/** Lets everything already queued on the event loop run to completion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A database whose account lookups stay open until `open()` is called.
 *
 * It counts every lookup, and records how many sign-ins held a place at the
 * moment each lookup began -- which is the number running at once.
 */
function heldDatabase(rows: Record<string, unknown>[] = [row(KNOWN)]) {
  let held = true;
  const waiting: Array<() => void> = [];
  const state = { lookups: 0, peakActive: 0 };
  return {
    state,
    open() {
      held = false;
      for (const go of waiting.splice(0)) go();
    },
    db: {
      async query(sql: string, params: unknown[] = []) {
        if (!/^\s*SELECT/i.test(sql)) return { rows: [] };
        state.lookups += 1;
        state.peakActive = Math.max(state.peakActive, verificationLoad().active);
        if (held) await new Promise<void>((resolve) => waiting.push(resolve));
        const wanted = String(params[0] ?? "").toLowerCase();
        return { rows: rows.filter((r) => r.email === wanted) };
      },
    },
  };
}

/** Starts `count` attempts and notes, for each, whether it has finished yet. */
function startAttempts(count: number, db: unknown, email = UNKNOWN, password = "wrong-password") {
  const finished: (SignInResult | undefined)[] = Array.from({ length: count }, () => undefined);
  const all = Array.from({ length: count }, (_, i) =>
    signIn(email, password, UNATTRIBUTED, { db: db as never }, NOW).then((result) => {
      finished[i] = result;
      return result;
    }),
  );
  return { all, finished };
}

const BUSY: SignInResult = { ok: false, reason: "busy", message: SIGN_IN_BUSY, delayMs: 0 };

test("the bound is four running and sixteen waiting", () => {
  assert.equal(MAX_ACTIVE_VERIFICATIONS, 4);
  assert.equal(MAX_WAITING_VERIFICATIONS, 16);
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("at most four run at once, sixteen wait, and every attempt beyond is busy at once", async () => {
  resetAttempts();
  const held = heldDatabase();
  const extra = 10;
  const { all, finished } = startAttempts(CAPACITY + extra, held.db);

  await settle();

  // Four are inside the lookup, sixteen are queued, and the rest have answered.
  assert.equal(held.state.lookups, MAX_ACTIVE_VERIFICATIONS, "only four reached the database");
  assert.deepEqual(verificationLoad(), { active: MAX_ACTIVE_VERIFICATIONS, waiting: MAX_WAITING_VERIFICATIONS });
  const answered = finished.filter((r) => r !== undefined);
  assert.equal(answered.length, extra, "the ten beyond capacity answered without waiting");
  for (const result of answered) assert.deepEqual(result, BUSY);
  assert.deepEqual(trackedFailureCounts(), { callers: 0, accounts: 0, spray: 0 }, "a busy answer records nothing");

  // Let them go: the twenty admitted ones each look up, check and fail.
  held.open();
  const results = await Promise.all(all);

  assert.equal(held.state.lookups, CAPACITY, "exactly the admitted attempts were checked");
  assert.ok(held.state.peakActive <= MAX_ACTIVE_VERIFICATIONS, `never more than four at once, saw ${held.state.peakActive}`);
  assert.equal(results.filter((r) => r.ok === false && r.reason === "rejected").length, CAPACITY);
  assert.equal(results.filter((r) => r.ok === false && r.reason === "busy").length, extra);
  assert.equal(trackedFailureCounts().spray, CAPACITY, "only checked attempts were counted as failures");
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 }, "every place was given back");
});

test("the busy answer is the same for an address with an account and one without", async () => {
  resetAttempts();
  const held = heldDatabase();
  const filling = startAttempts(CAPACITY, held.db);
  await settle();
  const lookupsBefore = held.state.lookups;

  const known = await signIn(KNOWN, PASSWORD, UNATTRIBUTED, { db: held.db as never }, NOW);
  const unknown = await signIn(UNKNOWN, "wrong-password", UNATTRIBUTED, { db: held.db as never }, NOW);

  assert.deepEqual(known, BUSY, "even the right password is not checked when there is no room");
  assert.deepEqual(unknown, BUSY);
  assert.deepEqual(known, unknown, "nothing in the answer depends on the address");
  assert.equal(held.state.lookups, lookupsBefore, "neither reached the database, so neither ran scrypt");

  held.open();
  await Promise.all(filling.all);
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("waiting attempts are let in oldest first, one per place freed", async () => {
  const running = await Promise.all(Array.from({ length: MAX_ACTIVE_VERIFICATIONS }, () => claimVerificationSlot()));
  const admitted: number[] = [];
  const waiters = [0, 1, 2].map((i) =>
    claimVerificationSlot()!.then((release) => {
      admitted.push(i);
      return release;
    }),
  );
  await settle();
  assert.deepEqual(admitted, [], "nobody is let in while every place is taken");
  assert.deepEqual(verificationLoad(), { active: MAX_ACTIVE_VERIFICATIONS, waiting: 3 });

  running[0]!();
  await settle();
  assert.deepEqual(admitted, [0], "one place freed lets in exactly the oldest waiter");
  assert.deepEqual(verificationLoad(), { active: MAX_ACTIVE_VERIFICATIONS, waiting: 2 }, "the place passed over, not added");

  running[1]!();
  running[2]!();
  await settle();
  assert.deepEqual(admitted, [0, 1, 2]);

  running[3]!();
  for (const release of await Promise.all(waiters)) release();
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("a place is given back however an attempt ends", async () => {
  const empty = { active: 0, waiting: 0 };
  const plain = (rows: Record<string, unknown>[]) => ({
    async query(sql: string, params: unknown[] = []) {
      if (!/^\s*SELECT/i.test(sql)) return { rows: [] };
      const wanted = String(params[0] ?? "").toLowerCase();
      return { rows: rows.filter((r) => r.email === wanted) };
    },
  });

  resetAttempts();
  const success = await signIn(KNOWN, PASSWORD, UNATTRIBUTED, { db: plain([row(KNOWN)]) }, NOW);
  assert.equal(success.ok, true, "success");
  assert.deepEqual(verificationLoad(), empty);

  const wrong = await signIn(KNOWN, "wrong-password", UNATTRIBUTED, { db: plain([row(KNOWN)]) }, NOW);
  assert.equal(wrong.ok === false && wrong.reason, "rejected", "wrong password");
  assert.deepEqual(verificationLoad(), empty);

  const unknown = await signIn(UNKNOWN, "wrong-password", UNATTRIBUTED, { db: plain([]) }, NOW);
  assert.equal(unknown.ok === false && unknown.reason, "rejected", "unknown address");
  assert.deepEqual(verificationLoad(), empty);

  const inactive = await signIn(KNOWN, PASSWORD, UNATTRIBUTED, { db: plain([row(KNOWN, "INACTIVE")]) }, NOW);
  assert.equal(inactive.ok === false && inactive.reason, "rejected", "inactive account");
  assert.deepEqual(verificationLoad(), empty);

  const broken = { async query() { throw new Error("connection refused"); } };
  const outage = await signIn(KNOWN, PASSWORD, UNATTRIBUTED, { db: broken }, NOW);
  assert.equal(outage.ok === false && outage.reason, "not-configured", "database error");
  assert.deepEqual(verificationLoad(), empty);

  // An unexpected exception inside the attempt still gives its place back.
  await assert.rejects(signIn(undefined as unknown as string, PASSWORD, UNATTRIBUTED, { db: plain([]) }, NOW));
  assert.deepEqual(verificationLoad(), empty, "unexpected exception");

  // And a full burst afterwards is admitted exactly as before: nothing leaked.
  const held = heldDatabase();
  const burst = startAttempts(MAX_ACTIVE_VERIFICATIONS, held.db);
  await settle();
  assert.equal(held.state.lookups, MAX_ACTIVE_VERIFICATIONS);
  held.open();
  await Promise.all(burst.all);
  assert.deepEqual(verificationLoad(), empty);
});

test("a caller locked out for failures is refused before it takes a place", async () => {
  resetAttempts();
  const plain = { async query() { return { rows: [] }; } };
  for (let i = 0; i < 10; i += 1) await signIn(UNKNOWN, "wrong-password", "203.0.113.9", { db: plain }, NOW);

  const held = heldDatabase();
  const filling = startAttempts(CAPACITY, held.db);
  await settle();

  const locked = await signIn(UNKNOWN, "wrong-password", "203.0.113.9", { db: plain }, NOW);
  assert.equal(locked.ok === false && locked.reason, "rate-limited", "the per-caller lock answers first, as before");

  held.open();
  await Promise.all(filling.all);
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("releasing a place twice gives back only one", async () => {
  const first = await claimVerificationSlot();
  assert.ok(first);
  first();
  first();
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });

  const places = await Promise.all(Array.from({ length: MAX_ACTIVE_VERIFICATIONS }, () => claimVerificationSlot()));
  assert.deepEqual(verificationLoad(), { active: MAX_ACTIVE_VERIFICATIONS, waiting: 0 });
  places[0]?.();
  places[0]?.();
  assert.deepEqual(verificationLoad(), { active: MAX_ACTIVE_VERIFICATIONS - 1, waiting: 0 }, "a repeated release is ignored");
  for (const release of places) release?.();
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("the route answers busy with a 503 and a Retry-After, for any address", async () => {
  resetAttempts();
  const held = heldDatabase();
  const filling = startAttempts(CAPACITY, held.db);
  await settle();

  const ask = (email: string, password: string) =>
    loginRoute(
      new Request("https://skybook.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
      { db: held.db as never, secret: "test-secret-that-is-long-enough-to-be-accepted-0123456789", sleep: async () => {} },
      NOW,
    );

  const known = await ask(KNOWN, PASSWORD);
  const unknown = await ask(UNKNOWN, "wrong-password");
  assert.deepEqual(known, { ok: false, status: 503, error: SIGN_IN_BUSY, retryAfterSeconds: VERIFICATION_RETRY_AFTER_SECONDS });
  assert.deepEqual(unknown, known);

  held.open();
  await Promise.all(filling.all);
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 });
});

test("the login route file sends Retry-After when one is given, and only then", () => {
  const source = fs.readFileSync(new URL("../../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(source, /"Retry-After": String\(outcome\.retryAfterSeconds\)/);
  assert.match(source, /outcome\.retryAfterSeconds === undefined \? undefined/);
});
