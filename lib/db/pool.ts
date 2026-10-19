/**
 * The one PostgreSQL connection pool for the whole application.
 *
 * LAZY, SO IMPORTING THIS FILE CONNECTS TO NOTHING. The pool is created the
 * first time `getPool()` is called, which means a test or the build can import
 * a module that reaches the database without a socket being opened just by the
 * import. Nothing here runs at module load.
 *
 * ONE POOL PER PROCESS. node-postgres keeps a small set of connections open and
 * lends one out for each query. Render's free PostgreSQL allows only a handful
 * of connections at once, and the app runs as a single instance, so the pool is
 * deliberately small — see `MAX_CONNECTIONS`.
 */
import { Pool, type PoolConfig } from "pg";

/** Where the connection string is read from. Never prefixed `NEXT_PUBLIC_`. */
export const DATABASE_URL_VARIABLE = "DATABASE_URL";

/**
 * How many connections the pool may open at once.
 *
 * Small on purpose: Render's free database caps total connections low, and a
 * single instance asking for a dozen would exhaust them. Five is ample for one
 * salesperson at a time and leaves room for a migration to connect alongside.
 */
const MAX_CONNECTIONS = 5;

/**
 * How long to wait for a connection -- a new one, or a free one from the pool --
 * before giving up, in milliseconds.
 *
 * WHY THERE IS A LIMIT AT ALL. node-postgres waits forever by default. A
 * database that stopped answering would then hold every request that touched it,
 * and a sign-in holds one of its few verification places while it waits, so a
 * stall became an outage that lasted until the process restarted. Five seconds
 * is many times a healthy connection and still fails a dead one quickly.
 */
export const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * How long any one query may take before the driver gives up on it, in
 * milliseconds. Enforced by the driver, not the database server.
 *
 * Every query this application makes is a single-row lookup or update on a
 * small table, and the one migration creates a table and an index, so ten
 * seconds is far beyond any of them. A query that times out rejects; the pool
 * then discards that connection rather than lending it out again.
 *
 * MIGRATIONS SHARE THIS POOL AND THIS LIMIT. A future migration that rewrites a
 * large table could need longer, and would need its own client with its own
 * limit; none does today.
 */
export const QUERY_TIMEOUT_MS = 10_000;

/** The options the shared pool is created with. Separate so they can be tested. */
export function poolConfig(connectionString: string, nodeEnv: string | undefined = process.env.NODE_ENV): PoolConfig {
  return {
    connectionString,
    max: MAX_CONNECTIONS,
    ssl: nodeEnv === "production" ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  };
}

let pool: Pool | null = null;

/**
 * The shared pool, created on first use.
 *
 * Throws a clear error when `DATABASE_URL` is missing rather than letting pg
 * fail later with a vaguer one. TLS is enabled in production because Render
 * serves database connections over it; in development it is left off so a plain
 * local Postgres connects without certificate fuss. `NODE_ENV` decides this and
 * a request cannot influence it.
 */
export function getPool(): Pool {
  if (pool !== null) return pool;

  const connectionString = (process.env[DATABASE_URL_VARIABLE] ?? "").trim();
  if (connectionString === "") {
    throw new Error(
      `${DATABASE_URL_VARIABLE} is not set, so the application cannot reach the database.`,
    );
  }

  pool = new Pool(poolConfig(connectionString));

  return pool;
}

/**
 * Closes the pool so a short-lived script can exit cleanly.
 *
 * The web server never calls this — it keeps the pool for the life of the
 * process — but the migration CLI does, so node does not hang with an open
 * connection after its work is done.
 */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  await pool.end();
  pool = null;
}
