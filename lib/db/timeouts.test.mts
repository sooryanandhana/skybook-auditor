/**
 * Tests for the database time limits.
 *
 * WHAT IS PROVED:
 *
 *   - the shared pool is created with a finite connection wait and a finite
 *     query time, and with nothing else changed;
 *   - with those options, the real `pg` driver gives up on a database that
 *     accepts a connection and never answers, instead of waiting forever, and a
 *     sign-in waiting on it gets the existing 503 and gives its place back;
 *   - a sign-in whose query times out does the same;
 *   - what the session guard does on a timeout today (it counts the request as
 *     not signed in, which every protected route answers as 401) -- recorded so
 *     a deliberate change to that is a visible one;
 *   - migrations use the same pool, so the same limits, and a migration whose
 *     query times out is rolled back and not recorded.
 *
 * Local only. The "database" here is a socket on 127.0.0.1 that never replies,
 * or a fake that rejects the way the driver does. Nothing reaches a real server.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { CONNECTION_TIMEOUT_MS, DATABASE_URL_VARIABLE, QUERY_TIMEOUT_MS, closePool, getPool, poolConfig } from "./pool.ts";
import { runMigrations, type Queryable } from "./migrate.ts";
import { UNATTRIBUTED, resetAttempts, signIn, verificationLoad } from "../auth/credentials.ts";
import { requireSession } from "../auth/guard.ts";
import { SESSION_COOKIE, signSession } from "../auth/session.ts";

const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";

/**
 * The errors the installed driver raises for these limits, word for word: one
 * for a new connection that never completes, one for waiting on a full pool,
 * and one for a query that never answers.
 */
const NEW_CONNECTION_TIMEOUT_ERROR = "Connection terminated due to connection timeout";
const CONNECTION_TIMEOUT_ERROR = "timeout exceeded when trying to connect";
const QUERY_TIMEOUT_ERROR = "Query read timeout";

/* ---------------------------------------------------------------------------
   The options
   --------------------------------------------------------------------------- */

test("the pool waits at most five seconds for a connection and ten for a query", () => {
  assert.equal(CONNECTION_TIMEOUT_MS, 5_000);
  assert.equal(QUERY_TIMEOUT_MS, 10_000);

  const config = poolConfig("postgres://user:pass@db.example/app", "development");
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.query_timeout, 10_000);
});

test("nothing else about the pool changed", () => {
  const development = poolConfig("postgres://user:pass@db.example/app", "development");
  const production = poolConfig("postgres://user:pass@db.example/app", "production");

  assert.deepEqual(Object.keys(development).sort(), ["connectionString", "connectionTimeoutMillis", "max", "query_timeout", "ssl"]);
  assert.equal(development.max, 5);
  assert.equal(development.connectionString, "postgres://user:pass@db.example/app");
  assert.equal(development.ssl, undefined, "no TLS for a local database");
  assert.deepEqual(production.ssl, { rejectUnauthorized: false }, "TLS in production, as before");
  assert.equal("statement_timeout" in development, false, "no server-side limit is set");
  assert.equal("keepAlive" in development, false);
});

test("the shared pool is built from those options", async () => {
  const previous = process.env[DATABASE_URL_VARIABLE];
  try {
    process.env[DATABASE_URL_VARIABLE] = "postgres://user:pass@127.0.0.1:1/never-connected";
    const options = (getPool() as unknown as { options: Record<string, unknown> }).options;
    assert.equal(options.connectionTimeoutMillis, CONNECTION_TIMEOUT_MS);
    assert.equal(options.query_timeout, QUERY_TIMEOUT_MS);
    assert.equal(options.max, 5);
  } finally {
    await closePool();
    if (previous === undefined) delete process.env[DATABASE_URL_VARIABLE];
    else process.env[DATABASE_URL_VARIABLE] = previous;
  }
});

/* ---------------------------------------------------------------------------
   The real driver against a database that never answers
   --------------------------------------------------------------------------- */

/** What `within` resolves to when the work did not finish in time. */
const DID_NOT_FINISH = Symbol("did not finish");

/**
 * `work`, or DID_NOT_FINISH once `ms` have passed -- whichever comes first.
 *
 * WHY THE TEST NEEDS IT. If the driver ever waited forever again, an `await`
 * on it would never return: the assertions after it would never fail, the
 * `finally` below would never run, and the open sockets would keep the test
 * process alive. Bounding each wait means a regression FAILS, and the clean-up
 * still runs.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof DID_NOT_FINISH> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof DID_NOT_FINISH>((resolve) => {
    timer = setTimeout(() => resolve(DID_NOT_FINISH), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Longest the driver may take to give up before the test calls it a hang. */
const GIVE_UP_BY_MS = CONNECTION_TIMEOUT_MS + 5_000;

test(
  "with these options the driver gives up on a silent database, and the sign-in gives its place back",
  { timeout: 20_000 },
  async () => {
    // Accepts every connection and never says a word: a stalled database.
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as net.AddressInfo).port;
    const pool = new Pool(poolConfig(`postgres://user:pass@127.0.0.1:${port}/app`, "development"));

    try {
      resetAttempts();
      const started = performance.now();
      const outcome = await within(
        signIn("sam@skybook.example", "a-fake-password", UNATTRIBUTED, { db: pool }, Date.now()),
        GIVE_UP_BY_MS,
      );
      const waited = performance.now() - started;

      assert.notEqual(outcome, DID_NOT_FINISH, `the sign-in was still waiting after ${GIVE_UP_BY_MS} ms`);
      if (outcome === DID_NOT_FINISH) return;
      assert.equal(outcome.ok === false && outcome.reason, "not-configured", "the existing 503 answer");
      assert.ok(waited >= CONNECTION_TIMEOUT_MS - 250, `gave up after the limit, not before (${Math.round(waited)} ms)`);
      assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 }, "the verification place was given back");

      const query = await within(
        pool.query("SELECT 1").then(
          () => "answered",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        GIVE_UP_BY_MS,
      );
      assert.notEqual(query, DID_NOT_FINISH, `the query was still waiting after ${GIVE_UP_BY_MS} ms`);
      assert.match(String(query), new RegExp(`${NEW_CONNECTION_TIMEOUT_ERROR}|${CONNECTION_TIMEOUT_ERROR}`));
    } finally {
      // The sockets go first: with them closed, anything still connecting fails
      // at once, so ending the pool cannot wait on a connection that never comes.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
      await within(pool.end().catch(() => undefined), 5_000);
    }
  },
);

/* ---------------------------------------------------------------------------
   A query that times out
   --------------------------------------------------------------------------- */

/** A database whose every query fails the way the driver fails a timed-out one. */
const timingOut = (message: string) => ({
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error(message);
  },
});

test("a sign-in whose query times out gets the existing 503 and gives its place back", async () => {
  for (const message of [QUERY_TIMEOUT_ERROR, CONNECTION_TIMEOUT_ERROR, NEW_CONNECTION_TIMEOUT_ERROR]) {
    resetAttempts();
    const outcome = await signIn("sam@skybook.example", "a-fake-password", UNATTRIBUTED, { db: timingOut(message) }, Date.now());
    assert.equal(outcome.ok === false && outcome.reason, "not-configured", message);
    assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 }, message);
  }
});

test("today a protected request whose session lookup times out is treated as not signed in", async () => {
  /*
   * RECORDED, NOT ENDORSED. The guard answers "no session" for any database
   * failure, so every protected route returns its 401 "Sign in to use this."
   * during an outage. Changing that touches every route and is a separate,
   * approved change; this test makes sure it does not change by accident.
   */
  const cookie = signSession("c0ffee00-0000-4000-8000-00000000c0de", "SALES", { secret: SECRET });
  assert.ok(cookie);
  const request = new Request("https://skybook.example/api/audit/status?jobId=x", {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });

  for (const message of [QUERY_TIMEOUT_ERROR, CONNECTION_TIMEOUT_ERROR, NEW_CONNECTION_TIMEOUT_ERROR]) {
    assert.equal(await requireSession(request, { secret: SECRET, db: timingOut(message) }), null, message);
  }
});

/* ---------------------------------------------------------------------------
   Migrations
   --------------------------------------------------------------------------- */

test("migrations take their connection from the shared pool, so the same limits apply", () => {
  const cli = fs.readFileSync(new URL("./migrate.cli.mts", import.meta.url), "utf8");
  assert.match(cli, /getPool\(\)\.connect\(\)/, "the migration client comes from getPool");
  assert.doesNotMatch(cli, /new Pool\(|new Client\(/, "and no second pool or client with other limits");
});

test("a migration whose query times out is rolled back and not recorded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skybook-migrate-timeout-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_ok.sql"), "CREATE TABLE ok ();");
    fs.writeFileSync(path.join(dir, "0002_slow.sql"), "SLOW STATEMENT;");

    const sqls: string[] = [];
    const applied = new Set<string>();
    const client: Queryable = {
      async query(sql: string, params?: unknown[]) {
        sqls.push(sql);
        if (sql.includes("SLOW STATEMENT")) throw new Error(QUERY_TIMEOUT_ERROR);
        if (/^INSERT INTO schema_migrations/.test(sql)) applied.add(String(params?.[0]));
        return { rows: [] };
      },
    };

    await assert.rejects(() => runMigrations(client, dir), new RegExp(QUERY_TIMEOUT_ERROR));
    assert.ok(sqls.includes("ROLLBACK"), "the timed-out migration is rolled back");
    assert.ok(applied.has("0001_ok.sql"));
    assert.ok(!applied.has("0002_slow.sql"), "and is not recorded as applied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the existing migration is far inside the query limit: one table and one index", () => {
  const files = fs.readdirSync(new URL("./migrations/", import.meta.url)).filter((name) => name.endsWith(".sql"));
  assert.deepEqual(files, ["0001_create_users.sql"], "a new migration should be checked against QUERY_TIMEOUT_MS");
  const sql = fs.readFileSync(new URL("./migrations/0001_create_users.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS users_status_idx/);
});
