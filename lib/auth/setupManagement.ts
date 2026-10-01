/**
 * Creating the first MANAGEMENT account, out of band.
 *
 * WHY A SEPARATE PATH FROM REGISTRATION. The public sign-up makes a SALES
 * account that waits for a manager's approval — but the very first manager has
 * nobody to approve them. This creates that account directly: MANAGEMENT and
 * ACTIVE, from a command a person runs against the database, never from a web
 * request. It shares the repository and the hashing with the rest of auth and
 * nothing else: it cannot make a SALES or a PENDING account (the role and status
 * are fixed here), and the registration flow cannot make a MANAGEMENT one.
 *
 * THE PASSWORD IS READ, HASHED, AND DROPPED. It is never printed, never logged,
 * and never stored except as its scrypt hash. An address that already has an
 * account is refused rather than duplicated or overwritten.
 */
import { create, isUniqueViolation, type Db } from "../users/userRepository.ts";
import { hashPassword } from "./credentials.ts";
import { isAcceptablePassword, isValidEmail, MIN_PASSWORD_LENGTH } from "./registerRoute.ts";

export type SetupResult =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-email" | "weak-password" | "exists" | "error";
      readonly message: string;
    };

export interface SetupOptions {
  /** Injected database, so tests drive this with a fake and no live PostgreSQL. */
  readonly db?: Db;
}

/**
 * Creates one MANAGEMENT, ACTIVE account, or says why it could not.
 *
 * Pure of the console: it returns a result rather than printing, so a test can
 * drive it and the CLI can decide what to say. The role and status are written
 * here, not taken from anywhere, so this can only ever make a manager.
 */
export async function createManagementAccount(
  email: string,
  password: string,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const normalisedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalisedEmail)) {
    return { ok: false, reason: "invalid-email", message: "That is not a valid email address." };
  }
  if (!isAcceptablePassword(password)) {
    return {
      ok: false,
      reason: "weak-password",
      message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  try {
    await create(
      { email: normalisedEmail, passwordHash: hashPassword(password), role: "MANAGEMENT", status: "ACTIVE" },
      options.db,
    );
    return { ok: true, email: normalisedEmail };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "exists", message: "An account already exists for that email address." };
    }
    // The raw error can carry the connection string, so it is never surfaced.
    return {
      ok: false,
      reason: "error",
      message: "The account could not be created. Check DATABASE_URL and that the database is reachable.",
    };
  }
}
