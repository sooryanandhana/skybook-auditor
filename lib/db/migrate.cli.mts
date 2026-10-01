/**
 * Runs the database migrations, then exits.
 *
 * Used by `npm run migrate`: by hand during development, and as the deploy step
 * that brings the database up to date before the new code serves. It opens ONE
 * connection, runs every pending migration on it (so each migration's `BEGIN`
 * and `COMMIT` share that connection), prints what it did, and closes the pool
 * so node exits rather than hanging on an open connection.
 */
import { getPool, closePool } from "./pool.ts";
import { runMigrations } from "./migrate.ts";

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    const applied = await runMigrations(client);
    console.log(
      applied.length === 0
        ? "Migrations: already up to date."
        : `Migrations applied: ${applied.join(", ")}`,
    );
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error) => {
  // The message only, never the stack: a connection string can carry a password.
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
