/**
 * A very small SQL migration runner.
 *
 * WHY NOT A LIBRARY. The whole job is: find the `.sql` files, see which have
 * already run, and run the rest once each, in order. That is a few dozen lines,
 * and a dependency to do it would be more to understand than the code it would
 * replace.
 *
 * HOW IT TRACKS PROGRESS. A table called `schema_migrations` holds one row per
 * applied file. A migration whose filename is already in that table is skipped,
 * so running this twice is safe, and running it after adding a new file applies
 * only the new one.
 *
 * EACH MIGRATION IS ALL-OR-NOTHING. A file runs inside a transaction together
 * with the row that records it, so a migration that fails half-way leaves the
 * database exactly as it was and is not marked as applied. The caller must hand
 * in a single connection (not a pool), so `BEGIN` and `COMMIT` land on the same
 * connection as the statements between them.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The least a database connection must do for the runner to use it. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One migration file: its name (used as the key) and the SQL it contains. */
export interface Migration {
  filename: string;
  sql: string;
}

/** The directory this file's migrations live in, resolved relative to here. */
export const MIGRATIONS_DIR = path.join(
  // On Windows `import.meta.url` is like file:///C:/..., whose pathname keeps a
  // leading slash before the drive letter; strip it so fs reads a real path.
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "migrations",
);

/**
 * Reads every `.sql` migration from a directory, sorted by filename.
 *
 * Sorting by name is why the files are numbered (`0001_`, `0002_`, ...): the
 * number fixes the order, so a later migration can rely on an earlier one
 * having already run.
 */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, sql: readFileSync(path.join(dir, filename), "utf8") }));
}

/** The bookkeeping table, created before anything else and safe to re-run. */
const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

/**
 * Applies every migration that has not run yet, in order.
 *
 * Returns the filenames it applied this time, so a caller — or a test — can see
 * what happened. Takes any `Queryable`, so a test can drive it with a fake
 * connection and no real database.
 */
export async function runMigrations(
  client: Queryable,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await client.query(CREATE_MIGRATIONS_TABLE);

  const appliedRows = await client.query("SELECT filename FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => (row as { filename: string }).filename));

  const ran: string[] = [];
  for (const migration of readMigrations(dir)) {
    if (applied.has(migration.filename)) continue;

    // The migration and the row that records it share one transaction, so a
    // failure part-way leaves nothing behind and nothing marked as applied.
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [migration.filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    ran.push(migration.filename);
  }

  return ran;
}
