/**
 * Tests for the user repository.
 *
 * NO REAL DATABASE. Every function takes a `Db`, so these drive it with a fake
 * that records the SQL and parameters it was asked to run and returns whatever
 * rows the test sets up. What is tested is the repository's behaviour — the
 * right statement, values as parameters (never spliced in), and the row mapped
 * to a `User` — not PostgreSQL itself.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  countActiveManagers,
  create,
  findByEmail,
  findById,
  isUniqueViolation,
  listUsers,
  setPassword,
  setStatus,
  updateLastLogin,
  type Db,
  type User,
} from "./userRepository.ts";

/** A fake connection that returns queued rows and records every call. */
function fakeDb(...responses: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let next = 0;
  const db: Db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return responses[next++] ?? { rows: [] };
    },
  };
  return { db, calls };
}

/** One row exactly as PostgreSQL returns it (snake_case, real Date objects). */
const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "Sam@Shop.com",
  password_hash: "scrypt:0123abcd:" + "a".repeat(64),
  role: "SALES",
  status: "PENDING",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-02T00:00:00.000Z"),
  approved_by: null,
  approved_at: null,
  last_login_at: null,
  must_change_password: false,
};

/** The only part of a statement that matters for "is this parameterised". */
function assertValueIsParameterised(sql: string, params: unknown[], value: string) {
  assert.ok(!sql.includes(value), `the value must not be spliced into the SQL: ${value}`);
  assert.ok(params.includes(value), `the value must travel as a parameter: ${value}`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("findByEmail returns the mapped user, and passes the email as a parameter", async () => {
  const { db, calls } = fakeDb({ rows: [ROW] });

  const user = await findByEmail("  Sam@Shop.com  ", db);

  assert.ok(user);
  assert.equal(user.id, ROW.id);
  assert.match(calls[0].sql, /SELECT[\s\S]*FROM users[\s\S]*WHERE email = \$1/i);
  // Trimmed, and carried as a parameter rather than built into the statement.
  assert.deepEqual(calls[0].params, ["Sam@Shop.com"]);
  assert.ok(!calls[0].sql.includes("Sam@Shop.com"));
});

test("findByEmail returns null when there is no such account", async () => {
  const { db } = fakeDb({ rows: [] });
  assert.equal(await findByEmail("nobody@shop.com", db), null);
});

test("findById looks up by id, as a parameter", async () => {
  const { db, calls } = fakeDb({ rows: [ROW] });

  const user = await findById(ROW.id, db);

  assert.ok(user);
  assert.match(calls[0].sql, /WHERE id = \$1/i);
  assertValueIsParameterised(calls[0].sql, calls[0].params, ROW.id);
});

test("findById returns null when nothing matches", async () => {
  const { db } = fakeDb({ rows: [] });
  assert.equal(await findById("00000000-0000-0000-0000-000000000000", db), null);
});

test("listUsers maps every row and orders newest first", async () => {
  const second = { ...ROW, id: "22222222-2222-2222-2222-222222222222", email: "a@b.com" };
  const { db, calls } = fakeDb({ rows: [ROW, second] });

  const users = await listUsers(db);

  assert.deepEqual(users.map((u) => u.id), [ROW.id, second.id]);
  assert.match(calls[0].sql, /ORDER BY created_at DESC/i);
});

// ---------------------------------------------------------------------------
// The row → User mapping
// ---------------------------------------------------------------------------

test("a row is mapped to camelCase, with the hash and flags carried through", async () => {
  const { db } = fakeDb({ rows: [ROW] });
  const user = (await findByEmail("sam@shop.com", db)) as User;

  assert.equal(user.passwordHash, ROW.password_hash, "the scrypt hash is returned verbatim");
  assert.equal(user.role, "SALES");
  assert.equal(user.status, "PENDING");
  assert.equal(user.mustChangePassword, false);
  assert.equal(user.approvedBy, null);
  assert.equal(user.lastLoginAt, null);
  assert.deepEqual(user.createdAt, ROW.created_at);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test("create inserts the given fields as parameters and returns the stored user", async () => {
  const stored = { ...ROW, role: "MANAGEMENT", status: "ACTIVE" };
  const { db, calls } = fakeDb({ rows: [stored] });

  const user = await create(
    { email: " boss@shop.com ", passwordHash: "scrypt:aa:bb", role: "MANAGEMENT", status: "ACTIVE" },
    db,
  );

  assert.equal(user.role, "MANAGEMENT");
  assert.match(calls[0].sql, /INSERT INTO users[\s\S]*RETURNING/i);
  // Email trimmed; role and status passed through; the flag defaults to false.
  assert.deepEqual(calls[0].params, ["boss@shop.com", "scrypt:aa:bb", "MANAGEMENT", "ACTIVE", false]);
});

test("create preserves the scrypt hash exactly — it is never re-hashed or altered", async () => {
  const hash = "scrypt:deadbeef:" + "f".repeat(64);
  const { db, calls } = fakeDb({ rows: [{ ...ROW, password_hash: hash }] });

  const user = await create({ email: "x@y.com", passwordHash: hash, role: "SALES", status: "PENDING" }, db);

  assert.equal(calls[0].params[1], hash, "the hash is stored byte-for-byte");
  assert.equal(user.passwordHash, hash);
});

test("create carries must_change_password when asked", async () => {
  const { db, calls } = fakeDb({ rows: [{ ...ROW, must_change_password: true }] });
  await create({ email: "x@y.com", passwordHash: "scrypt:a:b", role: "SALES", status: "PENDING", mustChangePassword: true }, db);
  assert.equal(calls[0].params[4], true);
});

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

test("setStatus updates the status and records the acting manager and time", async () => {
  const approver = "99999999-9999-9999-9999-999999999999";
  const { db, calls } = fakeDb({ rows: [{ ...ROW, status: "ACTIVE", approved_by: approver }] });

  const user = await setStatus(ROW.id, "ACTIVE", approver, db);

  assert.ok(user);
  assert.equal(user.status, "ACTIVE");
  assert.match(calls[0].sql, /UPDATE users[\s\S]*SET status = \$2[\s\S]*WHERE id = \$1[\s\S]*RETURNING/i);
  assert.match(calls[0].sql, /approved_at = CASE WHEN \$3 IS NOT NULL THEN now\(\) ELSE approved_at END/i);
  assert.deepEqual(calls[0].params, [ROW.id, "ACTIVE", approver]);
});

test("setStatus with no acting manager leaves the audit fields untouched", async () => {
  const { db, calls } = fakeDb({ rows: [{ ...ROW, status: "INACTIVE" }] });
  await setStatus(ROW.id, "INACTIVE", null, db);
  assert.deepEqual(calls[0].params, [ROW.id, "INACTIVE", null]);
  assert.match(calls[0].sql, /approved_by = COALESCE\(\$3, approved_by\)/i);
});

test("setStatus returns null when no account has that id", async () => {
  const { db } = fakeDb({ rows: [] });
  assert.equal(await setStatus("missing", "ACTIVE", null, db), null);
});

// ---------------------------------------------------------------------------
// setPassword
// ---------------------------------------------------------------------------

test("setPassword stores the new hash verbatim and sets the change flag", async () => {
  const hash = "scrypt:newsalt:" + "c".repeat(64);
  const { db, calls } = fakeDb({ rows: [{ ...ROW, password_hash: hash, must_change_password: true }] });

  const user = await setPassword(ROW.id, hash, true, db);

  assert.ok(user);
  assert.match(calls[0].sql, /UPDATE users[\s\S]*SET password_hash = \$2[\s\S]*must_change_password = \$3/i);
  assert.deepEqual(calls[0].params, [ROW.id, hash, true]);
  assert.equal(user.mustChangePassword, true);
});

test("setPassword defaults the change flag to false", async () => {
  const { db, calls } = fakeDb({ rows: [ROW] });
  await setPassword(ROW.id, "scrypt:a:b", undefined, db);
  assert.equal(calls[0].params[2], false);
});

test("setPassword returns null when no account has that id", async () => {
  const { db } = fakeDb({ rows: [] });
  assert.equal(await setPassword("missing", "scrypt:a:b", false, db), null);
});

// ---------------------------------------------------------------------------
// updateLastLogin
// ---------------------------------------------------------------------------

test("updateLastLogin stamps now() for the id, as a parameter", async () => {
  const { db, calls } = fakeDb({ rows: [] });

  await updateLastLogin(ROW.id, db);

  assert.match(calls[0].sql, /UPDATE users SET last_login_at = now\(\) WHERE id = \$1/i);
  assert.deepEqual(calls[0].params, [ROW.id]);
});

// ---------------------------------------------------------------------------
// Parameterisation, across every write that takes a value
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// countActiveManagers
// ---------------------------------------------------------------------------

test("countActiveManagers counts only MANAGEMENT + ACTIVE and returns a number", async () => {
  const { db, calls } = fakeDb({ rows: [{ count: 3 }] });
  const n = await countActiveManagers(db);

  assert.equal(n, 3);
  assert.match(
    calls[0].sql,
    /SELECT COUNT\(\*\)[\s\S]*role = 'MANAGEMENT'[\s\S]*status = 'ACTIVE'/i,
    "filters to active managers",
  );
});

test("countActiveManagers coerces a string count, and reads 0 from no rows", async () => {
  assert.equal(await countActiveManagers(fakeDb({ rows: [{ count: "2" }] }).db), 2, "pg bigint comes back as a string");
  assert.equal(await countActiveManagers(fakeDb({ rows: [] }).db), 0);
});

// ---------------------------------------------------------------------------
// isUniqueViolation
// ---------------------------------------------------------------------------

test("isUniqueViolation recognises PostgreSQL's unique_violation, and nothing else", () => {
  assert.equal(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })), true);
  assert.equal(isUniqueViolation({ code: "23505" }), true);

  for (const other of [
    Object.assign(new Error("x"), { code: "23503" }), // foreign_key_violation
    new Error("no code at all"),
    { code: 23505 }, // a number, not the string code pg sends
    null,
    undefined,
    "23505",
  ]) {
    assert.equal(isUniqueViolation(other), false, JSON.stringify(other));
  }
});

test("no caller value is ever spliced into a statement", async () => {
  const email = "inject'; DROP TABLE users;--@evil.test";
  const hash = "scrypt:zz:yy";

  const created = fakeDb({ rows: [ROW] });
  await create({ email, passwordHash: hash, role: "SALES", status: "PENDING" }, created.db);
  assertValueIsParameterised(created.calls[0].sql, created.calls[0].params, email.trim());
  assertValueIsParameterised(created.calls[0].sql, created.calls[0].params, hash);

  const looked = fakeDb({ rows: [] });
  await findByEmail(email, looked.db);
  assertValueIsParameterised(looked.calls[0].sql, looked.calls[0].params, email.trim());
});
