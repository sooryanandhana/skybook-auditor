/**
 * Tests for the small migration runner.
 *
 * NO REAL DATABASE. The runner takes any `Queryable`, so these drive it with a
 * fake connection that records the SQL it was asked to run and pretends to be an
 * empty (or already-migrated) database. What is being tested is the runner's
 * logic — ordering, idempotency, transactions, rollback — not PostgreSQL.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR, readMigrations, runMigrations, type Queryable } from "./migrate.ts";

/**
 * A stand-in connection.
 *
 * It answers `SELECT filename FROM schema_migrations` from an in-memory set,
 * grows that set when a filename is inserted, records every statement for the
 * test to inspect, and can be told to throw on a particular piece of SQL.
 */
function fakeClient(options: { applied?: string[]; failOn?: (sql: string) => boolean } = {}) {
  const applied = new Set(options.applied ?? []);
  const sqls: string[] = [];

  const client: Queryable = {
    async query(sql: string, params?: unknown[]) {
      sqls.push(sql);

      if (options.failOn?.(sql)) throw new Error("migration blew up");

      if (/^\s*SELECT filename FROM schema_migrations/i.test(sql)) {
        return { rows: [...applied].map((filename) => ({ filename })) };
      }
      if (/^\s*INSERT INTO schema_migrations/i.test(sql)) {
        applied.add(String((params ?? [])[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  return { client, sqls, applied };
}

/** A throwaway directory holding the given `name -> sql` migration files. */
function migrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skybook-migrate-"));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

test("readMigrations returns only .sql files, sorted by name, with their contents", () => {
  const dir = migrationsDir({
    "0002_second.sql": "SELECT 2;",
    "0001_first.sql": "SELECT 1;",
    "notes.txt": "ignore me",
  });

  const migrations = readMigrations(dir);
  assert.deepEqual(migrations.map((m) => m.filename), ["0001_first.sql", "0002_second.sql"]);
  assert.equal(migrations[0].sql, "SELECT 1;");
});

test("a fresh database gets the bookkeeping table, then every migration in order", async () => {
  const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a ();", "0002_b.sql": "CREATE TABLE b ();" });
  const { client, sqls, applied } = fakeClient();

  const ran = await runMigrations(client, dir);

  assert.deepEqual(ran, ["0001_a.sql", "0002_b.sql"], "both applied, in order");
  assert.ok(sqls[0].includes("CREATE TABLE IF NOT EXISTS schema_migrations"), "bookkeeping table first");
  // Each migration is wrapped in its own transaction.
  assert.equal(sqls.filter((s) => s.trim() === "BEGIN").length, 2);
  assert.equal(sqls.filter((s) => s.trim() === "COMMIT").length, 2);
  assert.equal(sqls.filter((s) => s.trim() === "ROLLBACK").length, 0);
  // The second table is created only after the first's transaction commits.
  assert.ok(sqls.indexOf("CREATE TABLE a ();") < sqls.indexOf("CREATE TABLE b ();"));
  assert.deepEqual([...applied].sort(), ["0001_a.sql", "0002_b.sql"]);
});

test("a migration already recorded is skipped — running twice applies nothing new", async () => {
  const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a ();" });
  const { client, sqls } = fakeClient({ applied: ["0001_a.sql"] });

  const ran = await runMigrations(client, dir);

  assert.deepEqual(ran, [], "nothing to do");
  assert.ok(!sqls.includes("CREATE TABLE a ();"), "the applied migration is not re-run");
  assert.equal(sqls.filter((s) => s.trim() === "BEGIN").length, 0);
});

test("a failing migration rolls back, is not recorded, and stops the run", async () => {
  const dir = migrationsDir({ "0001_ok.sql": "CREATE TABLE ok ();", "0002_bad.sql": "BROKEN SQL;" });
  const { client, sqls, applied } = fakeClient({ failOn: (sql) => sql.includes("BROKEN SQL") });

  await assert.rejects(() => runMigrations(client, dir), /blew up/);

  assert.ok(sqls.includes("ROLLBACK"), "the failed migration is rolled back");
  assert.ok(applied.has("0001_ok.sql"), "the earlier migration still committed");
  assert.ok(!applied.has("0002_bad.sql"), "the failed migration is NOT recorded as applied");
});

// ---------------------------------------------------------------------------
// The real 0001 migration — its shape is part of the contract
// ---------------------------------------------------------------------------

test("the users migration defines every required column and constraint", () => {
  const [first, ...rest] = readMigrations(MIGRATIONS_DIR);
  assert.equal(first.filename, "0001_create_users.sql", "0001 is the first migration");
  assert.equal(rest.length >= 0, true);

  const sql = first.sql;
  for (const column of [
    "id",
    "email",
    "password_hash",
    "role",
    "status",
    "created_at",
    "updated_at",
    "approved_by",
    "approved_at",
    "last_login_at",
    "must_change_password",
  ]) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(sql), `column ${column} is defined`);
  }

  assert.match(sql, /email\s+citext\s+NOT NULL\s+UNIQUE/i, "email is a case-insensitive unique column");
  assert.match(sql, /role[\s\S]*CHECK[\s\S]*'MANAGEMENT'[\s\S]*'SALES'/i, "role is constrained to the two roles");
  assert.match(
    sql,
    /status[\s\S]*CHECK[\s\S]*'PENDING'[\s\S]*'ACTIVE'[\s\S]*'REJECTED'[\s\S]*'INACTIVE'/i,
    "status is constrained to the four statuses",
  );
  assert.match(sql, /approved_by\s+uuid\s+REFERENCES users/i, "approved_by references a user");
  assert.match(sql, /must_change_password\s+boolean\s+NOT NULL\s+DEFAULT false/i, "temp-password flag defaults false");
  assert.match(sql, /INDEX[\s\S]*users_status_idx[\s\S]*\(status\)/i, "status is indexed");
});
