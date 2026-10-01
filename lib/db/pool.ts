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
import { Pool } from "pg";

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

  pool = new Pool({
    connectionString,
    max: MAX_CONNECTIONS,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });

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
