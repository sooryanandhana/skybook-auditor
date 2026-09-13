/**
 * Whether a person may sign in, and how many times they may get it wrong.
 *
 * ONE ACCOUNT, SEEDED, AND NO USER TABLE. This is a sales tool used by one
 * salesperson, and the two things a real account system exists for -- letting
 * people sign themselves up, and letting them recover a forgotten password --
 * are both unwanted here. Recovery is worse than unwanted: it needs the
 * ability to send email, which is the exact feature this login is being built
 * in front of. Accounts nobody could recover would be a login that locks the
 * tool rather than protecting it.
 *
 * SO THE ACCOUNT LIVES IN THE ENVIRONMENT, as an address and a hash. Changing
 * the password means running the hashing command again and editing one line,
 * which is the right amount of ceremony for one user and no ceremony at all
 * compared with a database.
 *
 * THE PASSWORD IS NEVER STORED, LOGGED OR COMPARED DIRECTLY. What is stored is
 * a scrypt hash with its own salt, and comparison is constant-time. Both of
 * those are one line each and both are the difference between a shortcut and a
 * habit that follows this code into production.
 *
 * DESIGNED SO THAT REPLACING IT CHANGES NOTHING ELSE. Everything above this
 * function answers "who is signed in" by reading a session, and a session
 * carries an address. Whether that address was proved by a password today or
 * by Google Workspace later is this file's business and nobody else's.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Where the one account is read from. Neither is prefixed `NEXT_PUBLIC_`. */
export const EMAIL_VARIABLE = "SKYBOOK_EMAIL";
export const PASSWORD_HASH_VARIABLE = "SKYBOOK_PASSWORD_HASH";

/**
 * The scrypt cost. Deliberately slow, which is the entire point of it.
 *
 * A fast hash is a hash somebody can try billions of times against a stolen
 * file. These parameters take a few tenths of a second per attempt on an
 * ordinary machine, which nobody signing in once a day will notice and which
 * makes guessing at scale pointless.
 *
 * `maxmem` IS NOT DECORATION. scrypt needs roughly 128 * N * r bytes and Node
 * refuses by default above 32 MB, which this configuration sits exactly on. A
 * missing ceiling here is a throw at sign-in rather than a weak hash, but it
 * is a throw nobody would see until the day it mattered.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** How a stored hash is written, so its format can be recognised and changed later. */
const SCHEME = "scrypt";

/**
 * What separates the scheme, the salt and the key.
 *
 * A COLON, AND NOT THE DOLLAR SIGN EVERY UNIX CRYPT FORMAT USES. That was the
 * first choice and it was wrong, for a reason that only shows up in the one
 * place this value ever lives. A stored hash goes in `.env.local`, and the
 * framework's environment loader expands `$name` as a reference to another
 * variable. It read `scrypt$<salt>$<key>`, found no variables by those names,
 * substituted nothing for both, and handed the server the six characters
 * "scrypt". Every password was then wrong, with a message saying so.
 *
 * Escaping each separator with a backslash also survives the loader, and was
 * rejected: a format that only works when somebody remembers an invisible
 * escape is a trap set for whoever rotates the password next.
 *
 * THE SALT AND THE KEY ARE HEXADECIMAL, so a colon cannot occur inside either
 * and the parse stays unambiguous. A test asserts the stored form contains no
 * dollar sign at all, which is the property that actually matters.
 */
const SEPARATOR = ":";

/**
 * A storable hash of a password, salted with fresh randomness.
 *
 * THE SALT IS PER-PASSWORD AND TRAVELS WITH THE HASH. Without one, two people
 * choosing the same password would store the same bytes, and a precomputed
 * table would cover both at once. It is not a secret and does not need hiding;
 * it needs only to be different every time.
 *
 * Run by hand to produce the value that goes in the environment file. The
 * password itself is typed into a terminal and never written anywhere.
 */
export function hashPassword(password: string, salt: string = randomBytes(SALT_LENGTH).toString("hex")): string {
  const derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT).toString("hex");
  return [SCHEME, salt, derived].join(SEPARATOR);
}

/**
 * Whether a password matches a stored hash, in constant time.
 *
 * FALSE FOR A MALFORMED STORED VALUE, never a throw and never true. A hash
 * somebody mistyped into the environment file must lock the door, not open it.
 */
export function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split(SEPARATOR);
  if (scheme !== SCHEME || !salt || !expected) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  } catch {
    return false;
  }

  const target = Buffer.from(expected, "hex");
  return target.length === derived.length && timingSafeEqual(target, derived);
}

/* ---------------------------------------------------------------------------
   How many times somebody may be wrong
   --------------------------------------------------------------------------- */

/**
 * Failed attempts allowed in the window, per caller.
 *
 * ITS OWN COUNTER, NOT THE AUDIT LIMITER. That bucket exists to bound how many
 * audits a caller may start and how much metered Google quota they may spend,
 * and this project already decided once that exporting a report must not
 * consume it. The same reasoning applies twice over here: sharing it would let
 * somebody guessing passwords block the salesperson from running an audit, and
 * would let a busy morning of auditing lock the login.
 *
 * Ten is generous for a person who knows their own password and nowhere near
 * enough for anybody working through a list.
 */
export const MAX_FAILED_ATTEMPTS = 10;

/** How long a caller's failures are remembered. */
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** When each caller last got it wrong. Cleared on success, and never persisted. */
const failures = new Map<string, number[]>();

/** Forgets every recorded failure. For tests, so one cannot leak into the next. */
export function resetAttempts(): void {
  failures.clear();
}

function recent(caller: string, now: number): number[] {
  return (failures.get(caller) ?? []).filter((at) => at > now - ATTEMPT_WINDOW_MS);
}

/* ---------------------------------------------------------------------------
   Signing in
   --------------------------------------------------------------------------- */

export interface CredentialOptions {
  /** Overrides the environment. Supplied by tests, so none depends on the machine. */
  readonly email?: string;
  readonly passwordHash?: string;
}

/**
 * What an attempt produced.
 *
 * A DISCRIMINATED UNION, like every other "this may not have worked" answer in
 * this codebase. The failure reasons are for the server's own use; see the
 * message rule below for what a person is told.
 */
export type SignInResult =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: "rejected" | "rate-limited" | "not-configured"; readonly message: string };

/**
 * One sentence for a wrong address AND a wrong password, deliberately.
 *
 * Telling somebody the address was right and only the password wrong confirms
 * that the address exists, which is the first thing anybody guessing wants to
 * know. There is one account here, so the disclosure is small, but the habit
 * is the point.
 */
export const REJECTED = "That email address and password do not match.";

export const RATE_LIMITED =
  "Too many failed sign-in attempts. Wait a few minutes and try again.";

const NOT_CONFIGURED =
  "No sign-in account is configured on this server. The audit engine is unaffected.";

const configured = (options: CredentialOptions) => ({
  email: (options.email ?? process.env[EMAIL_VARIABLE] ?? "").trim().toLowerCase(),
  passwordHash: (options.passwordHash ?? process.env[PASSWORD_HASH_VARIABLE] ?? "").trim(),
});

/**
 * Whether an account exists to sign in to, in a form that is safe to log.
 *
 * Carries neither the address nor the hash -- only whether both are there.
 */
export function credentialsAvailable(options: CredentialOptions = {}): boolean {
  const { email, passwordHash } = configured(options);
  return email !== "" && passwordHash !== "";
}

/**
 * One attempt to sign in.
 *
 * THE RATE CHECK COMES FIRST, before the password is even hashed. Hashing is
 * deliberately slow, so checking afterwards would let somebody spend this
 * server's processor by guessing, which is a denial of service wearing a
 * password attempt's clothes.
 *
 * A SUCCESS CLEARS THE CALLER'S FAILURES. Somebody who mistyped four times and
 * then got it right is not four failures away from being locked out.
 *
 * THE ADDRESS IS COMPARED CASE-INSENSITIVELY and the password is not. Nobody
 * thinks of their email address as having a case; everybody knows a password
 * does.
 */
export function signIn(
  email: string,
  password: string,
  caller: string,
  options: CredentialOptions = {},
  now: number = Date.now(),
): SignInResult {
  if (!credentialsAvailable(options)) {
    return { ok: false, reason: "not-configured", message: NOT_CONFIGURED };
  }

  const recentFailures = recent(caller, now);
  if (recentFailures.length >= MAX_FAILED_ATTEMPTS) {
    // Not recorded: a refused attempt must not extend the caller's own lockout.
    failures.set(caller, recentFailures);
    return { ok: false, reason: "rate-limited", message: RATE_LIMITED };
  }

  const account = configured(options);
  const addressMatches = email.trim().toLowerCase() === account.email;

  /*
   * BOTH CHECKS RUN WHETHER OR NOT THE FIRST PASSED. Returning early on a
   * wrong address would answer in a millisecond while a right one takes a
   * tenth of a second, and that difference is itself an answer to the question
   * "does this address exist".
   */
  const passwordMatches = checkPassword(password, account.passwordHash);

  if (!addressMatches || !passwordMatches) {
    failures.set(caller, [...recentFailures, now]);
    return { ok: false, reason: "rejected", message: REJECTED };
  }

  failures.delete(caller);
  return { ok: true, email: account.email };
}
