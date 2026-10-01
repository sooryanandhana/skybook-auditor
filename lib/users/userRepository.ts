/**
 * Reading and writing user accounts.
 *
 * THE ONLY PLACE THAT TALKS ABOUT THE `users` TABLE. Everything above this —
 * login, the management console, registration — asks for a user or changes one
 * through these functions, and none of them writes SQL of its own. Database
 * access is confined to `lib/db` (the pool) and here (the queries), which is the
 * property the dependency guard in `lib/db` protects.
 *
 * PARAMETERISED SQL ONLY. Every value a caller supplies travels as a `$1`
 * parameter, never spliced into the query text, so an email or an id can never
 * be read as SQL. The tests assert this directly: a value handed in must appear
 * in the parameters and not in the statement.
 *
 * IT DOES NOT HASH PASSWORDS. A password hash arrives already made by the
 * existing scrypt code in `lib/auth/credentials.ts`, and is stored exactly as
 * given. This file never sees a plaintext password and never changes the hash
 * format — it is a string column like any other here.
 *
 * ROLE AND STATUS ARE THE DATABASE'S TO ENFORCE. The `CHECK` constraints in the
 * `0001` migration are the real guard: a value outside the allowed set is
 * rejected by PostgreSQL. The TypeScript unions below describe the same sets so
 * the mistake is usually caught earlier, at the call site.
 */
import { getPool } from "../db/pool.ts";

/** The two roles an account may hold. Mirrors the `role` CHECK constraint. */
export type Role = "MANAGEMENT" | "SALES";

/** Where an account is in its lifecycle. Mirrors the `status` CHECK constraint. */
export type UserStatus = "PENDING" | "ACTIVE" | "REJECTED" | "INACTIVE";

/** One account, as the rest of the application reads it (camelCase). */
export interface User {
  id: string;
  email: string;
  /** The scrypt hash, stored and returned verbatim. Never a plaintext password. */
  passwordHash: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  /** The manager who last acted on this account's status, or null. */
  approvedBy: string | null;
  approvedAt: Date | null;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
}

/** What `create` needs. The id, timestamps and audit fields are set by the row. */
export interface NewUser {
  email: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  mustChangePassword?: boolean;
}

/**
 * The least a database connection must do for this file to use it.
 *
 * Narrow on purpose, so a test can pass a fake with no real PostgreSQL. A `pg`
 * `Pool` satisfies it, which is why the functions default to the shared pool.
 */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The columns every read returns, in one place so the shape cannot drift. */
const COLUMNS = `
  id, email, password_hash, role, status,
  created_at, updated_at, approved_by, approved_at,
  last_login_at, must_change_password
`;

/** The raw row shape PostgreSQL hands back (snake_case). */
interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  last_login_at: Date | null;
  must_change_password: boolean;
}

/** Turns a database row into the camelCase `User` the application uses. */
function rowToUser(row: unknown): User {
  const r = row as UserRow;
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role as Role,
    status: r.status as UserStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    lastLoginAt: r.last_login_at,
    mustChangePassword: r.must_change_password,
  };
}

/**
 * The account for an email address, or null when there is none.
 *
 * The lookup is case-insensitive because `email` is a `citext` column, so the
 * address is passed as typed (only trimmed) and PostgreSQL matches it however
 * it was capitalised when the account was made.
 */
export async function findByEmail(email: string, db: Db = getPool()): Promise<User | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email.trim()]);
  const row = result.rows[0];
  return row === undefined ? null : rowToUser(row);
}

/** The account with this id, or null when there is none. */
export async function findById(id: string, db: Db = getPool()): Promise<User | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : rowToUser(row);
}

/** Every account, newest first — the management console's list. */
export async function listUsers(db: Db = getPool()): Promise<User[]> {
  const result = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY created_at DESC`);
  return result.rows.map(rowToUser);
}

/**
 * How many accounts are MANAGEMENT and ACTIVE right now.
 *
 * Used to protect the last active manager: an action that would switch one off
 * checks this first, so the system can never be left with nobody able to manage
 * it. The role and status are literals in the query, not caller input. `::int`
 * casts PostgreSQL's bigint COUNT down to a number the driver returns as a plain
 * integer rather than a string.
 */
export async function countActiveManagers(db: Db = getPool()): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM users WHERE role = 'MANAGEMENT' AND status = 'ACTIVE'`,
  );
  const row = result.rows[0] as { count?: number | string } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Inserts a new account and returns it as stored.
 *
 * The caller decides the role and status: a self-registration passes SALES and
 * PENDING, a bootstrapped manager passes MANAGEMENT and ACTIVE. The `CHECK`
 * constraints reject anything outside the allowed sets.
 */
export async function create(input: NewUser, db: Db = getPool()): Promise<User> {
  const result = await db.query(
    `INSERT INTO users (email, password_hash, role, status, must_change_password)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [input.email.trim(), input.passwordHash, input.role, input.status, input.mustChangePassword ?? false],
  );
  return rowToUser(result.rows[0]);
}

/**
 * Changes an account's status, and returns the updated account or null when no
 * account has that id.
 *
 * `approvedBy` records the manager who acted — on an approve, a reject, a
 * deactivation or a reactivation alike — and stamps the time. Passing null
 * leaves the existing audit fields untouched, so a status change made by the
 * system rather than a person does not erase who last acted.
 */
export async function setStatus(
  id: string,
  status: UserStatus,
  approvedBy: string | null = null,
  db: Db = getPool(),
): Promise<User | null> {
  const result = await db.query(
    `UPDATE users
        SET status = $2,
            updated_at = now(),
            approved_by = COALESCE($3, approved_by),
            approved_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE approved_at END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, status, approvedBy],
  );
  const row = result.rows[0];
  return row === undefined ? null : rowToUser(row);
}

/**
 * Replaces an account's password hash, and returns the updated account or null
 * when no account has that id.
 *
 * The hash is stored exactly as given — see the file header: hashing lives in
 * the auth layer, not here. `mustChangePassword` is set true when a manager
 * assigns a temporary password, so the application can later require a change.
 */
export async function setPassword(
  id: string,
  passwordHash: string,
  mustChangePassword = false,
  db: Db = getPool(),
): Promise<User | null> {
  const result = await db.query(
    `UPDATE users
        SET password_hash = $2,
            must_change_password = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, passwordHash, mustChangePassword],
  );
  const row = result.rows[0];
  return row === undefined ? null : rowToUser(row);
}

/** Stamps the moment of a successful sign-in. Nothing to return. */
export async function updateLastLogin(id: string, db: Db = getPool()): Promise<void> {
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

/**
 * Whether an error is PostgreSQL refusing a duplicate on a unique constraint.
 *
 * `23505` is the standard `unique_violation` SQLSTATE. Checking the CODE rather
 * than the message means a registration can tell "this email already exists"
 * from a real failure without parsing English, and without a racy "does it
 * exist?" read first: it simply inserts, and lets the UNIQUE constraint on
 * `email` be the one source of truth. Reads a property; imports nothing.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
