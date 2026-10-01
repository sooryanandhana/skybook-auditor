/**
 * `npm run setup:management -- <email> <password>`
 *
 * Creates the first MANAGEMENT account from the command line, once. It reads
 * DATABASE_URL, creates the account, and prints the outcome — never the password
 * or the hash — then closes the pool so node exits. Any refusal exits non-zero,
 * so a script can tell it did not create the account.
 */
import { closePool, getPool } from "../db/pool.ts";
import { createManagementAccount } from "./setupManagement.ts";

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);
  if (email === undefined || email === "" || password === undefined || password === "") {
    console.error("Usage: npm run setup:management -- <email> <password>");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await createManagementAccount(email, password, { db: getPool() });
    if (result.ok) {
      console.log(`Created a MANAGEMENT account for ${result.email}.`);
    } else {
      console.error(result.message);
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  // The message only (e.g. "DATABASE_URL is not set…"), never a stack: a
  // connection string can carry a password.
  console.error("Setup failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
