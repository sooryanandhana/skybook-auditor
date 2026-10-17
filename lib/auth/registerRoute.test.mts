/**
 * Tests for the sign-up decision.
 *
 * NO REAL DATABASE. `registerRoute` writes through the repository, which takes
 * an injected `Db`; these drive it with fakes that record the INSERT, simulate a
 * duplicate, or hold a tiny in-memory table for the end-to-end flow. The real
 * scrypt hash runs, because storing a real hash is part of what is being tested.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  INVALID_EMAIL,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  REGISTERED,
  WEAK_PASSWORD,
  registerRoute,
} from "./registerRoute.ts";
import { REGISTER_GLOBAL, REGISTER_PER_CALLER, resetRegisterLimits } from "./registerLimit.ts";
import { checkPassword, resetAttempts, signIn } from "./credentials.ts";

const PASSWORD = "a-long-enough-password";
const NOW = 1_757_000_000_000;

function post(body: unknown, caller = "1.2.3.4") {
  return new Request("https://skybook.example/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": caller },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A fake that records each INSERT and echoes the row back so create() maps it. */
function recordingDb() {
  const inserts: unknown[][] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*INSERT INTO users/i.test(sql)) {
        inserts.push(params);
        const [email, password_hash, role, status, must_change_password] = params;
        return {
          rows: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              email,
              password_hash,
              role,
              status,
              created_at: new Date(NOW),
              updated_at: new Date(NOW),
              approved_by: null,
              approved_at: null,
              last_login_at: null,
              must_change_password,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { db, inserts };
}

/** A fake that refuses an INSERT with PostgreSQL's unique_violation code. */
const duplicateDb = {
  async query(sql: string) {
    if (/^\s*INSERT/i.test(sql)) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return { rows: [] };
  },
};

/** A fake that is simply unreachable. */
const brokenDb = {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error("database unavailable");
  },
};

/** A tiny in-memory table: INSERT (unique by email), SELECT-by-email, UPDATE. */
function statefulDb() {
  const users: Array<Record<string, unknown>> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*INSERT INTO users/i.test(sql)) {
        const [email, password_hash, role, status, must_change_password] = params;
        if (users.some((u) => String(u.email).toLowerCase() === String(email).toLowerCase())) {
          throw Object.assign(new Error("duplicate"), { code: "23505" });
        }
        const row = {
          id: `id-${users.length + 1}`,
          email,
          password_hash,
          role,
          status,
          created_at: new Date(NOW),
          updated_at: new Date(NOW),
          approved_by: null,
          approved_at: null,
          last_login_at: null,
          must_change_password,
        };
        users.push(row);
        return { rows: [row] };
      }
      if (/^\s*SELECT[\s\S]*WHERE email = \$1/i.test(sql)) {
        const wanted = String(params[0] ?? "").toLowerCase();
        return { rows: users.filter((u) => String(u.email).toLowerCase() === wanted) };
      }
      return { rows: [] };
    },
  };
  return { db, users };
}

// ---------------------------------------------------------------------------
// A valid registration
// ---------------------------------------------------------------------------

test("a valid registration is accepted and creates a PENDING, SALES account", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();

  const outcome = await registerRoute(post({ email: "sam@shop.com", password: PASSWORD }), { db });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.status, 202);
  assert.equal(outcome.ok === true && outcome.message, REGISTERED);

  assert.equal(inserts.length, 1);
  const [email, hash, role, status] = inserts[0] as string[];
  assert.equal(email, "sam@shop.com");
  assert.equal(role, "SALES", "always SALES");
  assert.equal(status, "PENDING", "always PENDING");
  assert.ok(typeof hash === "string" && hash.length > 0);
});

test("the password is stored as a scrypt hash, never in plaintext", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();

  await registerRoute(post({ email: "sam@shop.com", password: PASSWORD }), { db });

  const hash = (inserts[0] as string[])[1];
  assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "a salted scrypt hash");
  assert.ok(!hash.includes(PASSWORD), "the plaintext is not in the stored value");
  assert.equal(await checkPassword(PASSWORD, hash), true, "and the hash verifies the password");
});

test("the email is normalised the same way sign-in normalises it", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();

  await registerRoute(post({ email: "  Sam@Shop.COM  ", password: PASSWORD }), { db });

  assert.equal((inserts[0] as string[])[0], "sam@shop.com", "trimmed and lower-cased");
});

// ---------------------------------------------------------------------------
// The client controls neither role nor status
// ---------------------------------------------------------------------------

test("a client cannot choose its role or status, however it dresses the body", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();

  await registerRoute(
    post({ email: "sam@shop.com", password: PASSWORD, role: "MANAGEMENT", status: "ACTIVE", isAdmin: true }),
    { db },
  );

  const [, , role, status] = inserts[0] as string[];
  assert.equal(role, "SALES", "the role is decided by the server, not the body");
  assert.equal(status, "PENDING", "the status is decided by the server, not the body");
});

// ---------------------------------------------------------------------------
// A duplicate address reveals nothing
// ---------------------------------------------------------------------------

test("a duplicate address is answered exactly as a new sign-up, revealing nothing", async () => {
  resetRegisterLimits();
  const fresh = await registerRoute(post({ email: "new@shop.com", password: PASSWORD }), { db: recordingDb().db });

  resetRegisterLimits();
  const duplicate = await registerRoute(post({ email: "taken@shop.com", password: PASSWORD }), { db: duplicateDb });

  assert.deepEqual(duplicate, fresh, "the two answers are identical — the form leaks no account's existence");
  assert.equal(duplicate.ok === true && duplicate.message, REGISTERED);
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

test("an invalid email is refused with 400", async () => {
  for (const email of ["", "not-an-email", "no@domain", "a b@shop.com", "two@@shop.com", "dots@sh..op.com", "@shop.com", "sam@"]) {
    resetRegisterLimits();
    const outcome = await registerRoute(post({ email, password: PASSWORD }), { db: recordingDb().db });
    assert.equal(outcome.ok, false, email);
    assert.equal(outcome.ok === false && outcome.status, 400, email);
    assert.equal(outcome.ok === false && outcome.error, INVALID_EMAIL, email);
  }
});

test("a password that is too short or too long is refused with 400", async () => {
  for (const password of ["", "short", "x".repeat(MIN_PASSWORD_LENGTH - 1), "y".repeat(MAX_PASSWORD_LENGTH + 1), "          "]) {
    resetRegisterLimits();
    const outcome = await registerRoute(post({ email: "sam@shop.com", password }), { db: recordingDb().db });
    assert.equal(outcome.ok, false, JSON.stringify(password).slice(0, 20));
    assert.equal(outcome.ok === false && outcome.status, 400);
    assert.equal(outcome.ok === false && outcome.error, WEAK_PASSWORD);
  }
});

test("a malformed body is refused rather than crashing", async () => {
  for (const body of ["not json", "null", "[]", "{}", '{"email":42,"password":true}']) {
    resetRegisterLimits();
    const outcome = await registerRoute(post(body), { db: recordingDb().db });
    assert.equal(outcome.ok, false, body);
    assert.equal(outcome.ok === false && outcome.status, 400, body);
  }
});

test("a validation failure never reaches the database", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();
  await registerRoute(post({ email: "nope", password: PASSWORD }), { db });
  assert.equal(inserts.length, 0, "a bad address is turned away before any INSERT");
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test("too many sign-ups from one caller are refused with 429", async () => {
  resetRegisterLimits();
  const { db } = recordingDb();

  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) {
    const ok = await registerRoute(post({ email: `sam${i}@shop.com`, password: PASSWORD }), { db, trustProxy: true });
    assert.equal(ok.ok, true, `attempt ${i}`);
  }

  const blocked = await registerRoute(post({ email: "one-too-many@shop.com", password: PASSWORD }), { db, trustProxy: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.status, 429);
});

test("behind a trusted proxy, rotating X-Forwarded-For under one CF-Connecting-IP is one caller", async () => {
  resetRegisterLimits();
  const { db } = recordingDb();
  const forged = (i: number) =>
    new Request("https://skybook.example/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `198.51.100.${i}` },
      body: JSON.stringify({ email: `rot${i}@shop.com`, password: PASSWORD }),
    });

  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) {
    assert.equal((await registerRoute(forged(i), { db, trustProxy: true })).ok, true, `attempt ${i}`);
  }
  const blocked = await registerRoute(forged(REGISTER_PER_CALLER), { db, trustProxy: true });
  assert.equal(blocked.ok === false && blocked.status, 429);
});

test("without a readable address, sign-ups are held by the global ceiling, not a shared five", async () => {
  // The default posture: no trusted proxy, so every request is unattributed.
  // Five attempts by anybody must not close sign-up for everybody.
  resetRegisterLimits();
  const { db } = recordingDb();

  for (let i = 0; i < REGISTER_GLOBAL; i += 1) {
    const ok = await registerRoute(post({ email: `any${i}@shop.com`, password: PASSWORD }), { db });
    assert.equal(ok.ok, true, `attempt ${i}`);
  }

  const blocked = await registerRoute(post({ email: "one-too-many@shop.com", password: PASSWORD }), { db });
  assert.equal(blocked.ok === false && blocked.status, 429);
});

test("the rate check comes before the database — a blocked sign-up writes nothing", async () => {
  resetRegisterLimits();
  const { db, inserts } = recordingDb();
  for (let i = 0; i < REGISTER_PER_CALLER; i += 1) {
    await registerRoute(post({ email: `a${i}@shop.com`, password: PASSWORD }), { db, trustProxy: true });
  }
  const before = inserts.length;
  await registerRoute(post({ email: "blocked@shop.com", password: PASSWORD }), { db, trustProxy: true });
  assert.equal(inserts.length, before, "the blocked attempt did not insert");
});

// ---------------------------------------------------------------------------
// The server's own failure
// ---------------------------------------------------------------------------

test("a database failure that is not a duplicate is a 503, not a false success", async () => {
  resetRegisterLimits();
  const outcome = await registerRoute(post({ email: "sam@shop.com", password: PASSWORD }), { db: brokenDb });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.status, 503);
});

// ---------------------------------------------------------------------------
// End to end: a registered account cannot sign in until it is approved
// ---------------------------------------------------------------------------

test("a freshly registered account is PENDING and cannot sign in until approved", async () => {
  resetRegisterLimits();
  resetAttempts();
  const { db, users } = statefulDb();

  // 1. Register.
  const registered = await registerRoute(post({ email: "sam@shop.com", password: PASSWORD }), { db });
  assert.equal(registered.ok, true);
  assert.equal(users.length, 1);
  assert.equal(users[0].status, "PENDING");
  assert.equal(users[0].role, "SALES");

  // 2. PENDING: sign-in is refused.
  const whilePending = await signIn("sam@shop.com", PASSWORD, "1.2.3.4", { db }, NOW);
  assert.equal(whilePending.ok, false, "a PENDING account cannot sign in");

  // 3. A manager approves (Step 6 will do this through the console; here it is
  //    the same state change applied directly).
  users[0].status = "ACTIVE";

  // 4. Now the same credentials sign in.
  const afterApproval = await signIn("sam@shop.com", PASSWORD, "1.2.3.4", { db }, NOW);
  assert.equal(afterApproval.ok, true, "once ACTIVE, the account signs in");
  assert.equal(afterApproval.ok === true && afterApproval.user.role, "SALES");
});

test("registering the same address twice does not create a second account", async () => {
  resetRegisterLimits();
  const { db, users } = statefulDb();

  await registerRoute(post({ email: "sam@shop.com", password: PASSWORD }), { db });
  const second = await registerRoute(post({ email: "Sam@Shop.com", password: "another-password" }), { db });

  assert.equal(second.ok, true, "still a generic success");
  assert.equal(users.length, 1, "but no second row, case-insensitively");
});
