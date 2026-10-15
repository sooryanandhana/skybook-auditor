/**
 * Whether a person may sign in, and how many times they may get it wrong.
 *
 * ACCOUNTS LIVE IN THE DATABASE, one row each in the `users` table, read and
 * written only through `lib/users`. This file decides WHETHER an attempt signs
 * in — it finds the account, requires it to be ACTIVE, checks the password, and
 * counts the guesses — but it never writes SQL of its own and never sees a
 * plaintext password beyond the one it is handed to check.
 *
 * ONLY AN ACTIVE ACCOUNT MAY SIGN IN. A PENDING account is awaiting a manager's
 * approval, a REJECTED one was refused, and an INACTIVE one was switched off;
 * all three are refused in exactly the same words as a wrong password, so an
 * attempt learns nothing about which case it hit.
 *
 * THE PASSWORD IS NEVER STORED, LOGGED OR COMPARED DIRECTLY. What is stored is
 * a scrypt hash with its own salt, and comparison is constant-time. Both of
 * those are one line each and both are the difference between a shortcut and a
 * habit that follows this code into production. The hashing — `hashPassword`
 * and `checkPassword` below — is unchanged by the move to a database: a hash is
 * a hash wherever it is kept.
 *
 * DESIGNED SO THAT REPLACING IT CHANGES NOTHING ELSE. Everything above this
 * function answers "who is signed in" by reading a session, and a session
 * carries who the person is. Whether that was proved by a password today or by
 * Google Workspace later is this file's business and nobody else's.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { UNATTRIBUTED } from "../callerAddress.ts";
import { findByEmail, updateLastLogin, type Db, type Role, type User } from "../users/userRepository.ts";

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
 * scrypt, without holding up the server while it works.
 *
 * THE SAME FUNCTION, CALLED THE OTHER WAY. `scryptSync` and `scrypt` are one
 * algorithm with one set of inputs; the asynchronous form runs on Node's worker
 * pool instead of the main thread. The synchronous form stopped every other
 * request -- status polls, audits, downloads -- for the length of each sign-in
 * attempt, deliberately slow ones included. The password, salt, key length and
 * cost parameters passed here are exactly those passed before, so the bytes it
 * produces are exactly those it produced before, and every stored hash still
 * verifies.
 */
function deriveKey(password: string, salt: string, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

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
export async function hashPassword(password: string, salt: string = randomBytes(SALT_LENGTH).toString("hex")): Promise<string> {
  const derived = (await deriveKey(password, salt, SCRYPT)).toString("hex");
  return [SCHEME, salt, derived].join(SEPARATOR);
}

/**
 * Whether a password matches a stored hash, in constant time.
 *
 * FALSE FOR A MALFORMED STORED VALUE, never a throw and never true. A hash
 * somebody mistyped into the environment file must lock the door, not open it.
 */
export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split(SEPARATOR);
  if (scheme !== SCHEME || !salt || !expected) return false;

  let derived: Buffer;
  try {
    derived = await deriveKey(password, salt, SCRYPT);
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

/**
 * The caller key used when the request cannot be attributed to a real client.
 *
 * WITHOUT A TRUSTED PROXY THE APP CANNOT SEE A CLIENT ADDRESS, and the only
 * candidates are headers the client sets itself -- which somebody guessing
 * passwords simply changes on every request to look like a new caller. So an
 * unattributed request is not given a fresh bucket per header value, and the
 * per-caller HARD limit below does not apply to it: a single shared bucket that
 * returned 429 would let one attacker lock out the one salesperson who uses
 * this. The account-level slow-down carries the defence in that case instead.
 */
export { UNATTRIBUTED } from "../callerAddress.ts";

/** When each caller last got it wrong. Cleared on success, and never persisted. */
const failures = new Map<string, number[]>();

/**
 * The most callers whose failures are remembered at once.
 *
 * BOUNDED SO THE MAP CANNOT GROW WITHOUT END. Every distinct caller that gets a
 * password wrong adds an entry, and an entry used to leave only when that same
 * caller later signed in. Expired entries are now removed as new ones are
 * written, and past this many the callers whose last failure is oldest are
 * forgotten first. Ten thousand distinct callers failing inside one window is
 * far beyond any honest use; the per-caller limit itself (`MAX_FAILED_ATTEMPTS`)
 * is unchanged.
 */
export const MAX_TRACKED_CALLERS = 10_000;

/* ---------------------------------------------------------------------------
   Slowing a guessing campaign against an account

   The per-caller limit above is only as trustworthy as the caller key, and
   without a trusted proxy that key cannot be trusted at all. This second
   throttle needs no key: it counts failed attempts against EACH ACCOUNT --
   keyed by the address typed, normalised exactly as the lookup normalises it --
   whoever they came from, and answers each one more slowly than the last once
   a few have gone by.

   PER ACCOUNT, NOT SHARED. It used to be one counter for the whole server, left
   over from when there was one account: anybody's wrong guesses slowed
   everybody's sign-in, and anybody's success wiped the slate for all. Now one
   account's failures delay only attempts on that account, and a success clears
   only that account's own record.

   THE SAME FOR ADDRESSES THAT EXIST AND ADDRESSES THAT DO NOT. The key is the
   address as typed, not the account found, so an unknown address builds up its
   delay exactly as a real one does and the delay says nothing about which
   addresses are registered.

   It NEVER refuses and NEVER locks the account. A hard account lock would hand
   an attacker a denial of service -- flood the form, and the real user cannot
   get in either. Slowing does not: the right password always works, it just
   waits a moment during an active attack.
   --------------------------------------------------------------------------- */

/** Failed attempts answered at full speed before any slowing begins. */
export const ACCOUNT_FREE_ATTEMPTS = 5;

/** The first imposed delay, which then doubles with each further failure. */
export const ACCOUNT_BASE_DELAY_MS = 500;

/** The longest any one attempt is held. Reached after about twelve failures. */
export const ACCOUNT_MAX_DELAY_MS = 30_000;

/**
 * The most accounts whose failures are remembered at once.
 *
 * BOUNDED, because the key is whatever address somebody types and an attacker
 * can type endlessly many. Expired entries are removed as new ones are written,
 * and past this many the accounts whose last failure is oldest are forgotten
 * first. Flooding new addresses to push a targeted account's record out is
 * itself hundreds of failed attempts, which the spraying guard below slows.
 */
export const MAX_TRACKED_ACCOUNTS = 1_000;

/** The longest address kept as a key; longer ones are cut, matching the stored maximum. */
const MAX_ACCOUNT_KEY_LENGTH = 254;

/** Failed attempts against each account, whatever caller they came from. */
const accountFailures = new Map<string, number[]>();

/* ---------------------------------------------------------------------------
   Slowing password spraying

   The per-account slow-down has a gap of its own: a campaign that tries one or
   two passwords against MANY accounts never builds up a delay on any of them.
   This guard counts failed attempts across every account and, once there are
   more of them in a window than ordinary mistakes explain, slows FURTHER FAILED
   ATTEMPTS -- the delay is decided after the password is checked, so a correct
   password is never held up by other accounts' failures. A success does not
   clear it: one person signing in says nothing about a campaign against others.

   THE THRESHOLD: fifty failures across all accounts in fifteen minutes. That is
   five times the per-caller limit (`MAX_FAILED_ATTEMPTS`, ten) and well past the
   registration limit's own ceiling (twenty sign-ups in the same window), so a
   small team mistyping does not approach it, while a spraying campaign reaches
   it quickly. Above it the delay follows the same curve as the per-account one.
   --------------------------------------------------------------------------- */

/** Failures across all accounts answered at full speed before the guard starts slowing them. */
export const SPRAY_FREE_FAILURES = 50;

/**
 * The most failures the guard keeps. Past `SPRAY_FREE_FAILURES` plus enough to
 * reach the longest delay, more would change nothing, so older ones are dropped.
 */
const MAX_SPRAY_FAILURES = SPRAY_FREE_FAILURES + 100;

/** Failed attempts against any account, newest last. Never cleared by a success. */
let sprayFailures: number[] = [];

/** Forgets every recorded failure: per-caller, per-account and the spraying guard. For tests. */
export function resetAttempts(): void {
  failures.clear();
  accountFailures.clear();
  sprayFailures = [];
}

/** How many callers and accounts are being remembered. For tests of the bounds. */
export function trackedFailureCounts(): { readonly callers: number; readonly accounts: number; readonly spray: number } {
  return { callers: failures.size, accounts: accountFailures.size, spray: sprayFailures.length };
}

const withinWindow = (times: readonly number[], now: number) => times.filter((at) => at > now - ATTEMPT_WINDOW_MS);

function recent(caller: string, now: number): number[] {
  return withinWindow(failures.get(caller) ?? [], now);
}

/** The address as the lookup sees it, cut to the stored maximum. */
function accountKey(email: string): string {
  return email.trim().toLowerCase().slice(0, MAX_ACCOUNT_KEY_LENGTH);
}

function recentAccountFailures(key: string, now: number): number[] {
  return withinWindow(accountFailures.get(key) ?? [], now);
}

/**
 * Records one more failure under `key`, keeping the map within `limit`.
 *
 * The entry is re-inserted so the map's order is the order of each key's latest
 * failure: oldest first. Expired entries are dropped once the map is over its
 * limit, and if that is not enough the oldest go next. Exported so its bounds
 * can be tested directly, with a small limit.
 */
export function recordFailure(map: Map<string, number[]>, key: string, times: number[], limit: number, now: number): void {
  map.delete(key);
  map.set(key, times);
  if (map.size <= limit) return;

  for (const [other, otherTimes] of map) {
    if (withinWindow(otherTimes, now).length === 0) map.delete(other);
  }
  for (const other of map.keys()) {
    if (map.size <= limit) break;
    map.delete(other);
  }
}

/** How long a failed attempt is held because of failures across all accounts. */
export function sprayDelayMs(failuresInWindow: number): number {
  const beyondFree = failuresInWindow - SPRAY_FREE_FAILURES;
  if (beyondFree < 0) return 0;
  const steps = Math.min(beyondFree, 20);
  return Math.min(ACCOUNT_BASE_DELAY_MS * 2 ** steps, ACCOUNT_MAX_DELAY_MS);
}

/**
 * How long the answer to the next attempt on an account should be held, given
 * the failures already recorded against that account.
 *
 * The first `ACCOUNT_FREE_ATTEMPTS` are instant, so an honest person who
 * mistypes once or twice notices nothing. After that each failure doubles the
 * wait, from `ACCOUNT_BASE_DELAY_MS` up to `ACCOUNT_MAX_DELAY_MS`, which turns
 * an unbounded guessing rate into a few attempts a minute.
 */
export function accountDelayMs(failuresInWindow: number): number {
  // Free while fewer than `ACCOUNT_FREE_ATTEMPTS` failures are on record, so the
  // sixth failed attempt is the first one slowed when the free count is five.
  const beyondFree = failuresInWindow - ACCOUNT_FREE_ATTEMPTS;
  if (beyondFree < 0) return 0;

  // Doubling by exponent; the exponent is capped first so it cannot run away.
  const steps = Math.min(beyondFree, 20);
  return Math.min(ACCOUNT_BASE_DELAY_MS * 2 ** steps, ACCOUNT_MAX_DELAY_MS);
}

/* ---------------------------------------------------------------------------
   Signing in
   --------------------------------------------------------------------------- */

export interface CredentialOptions {
  /**
   * The database to read accounts from. Injected by tests so they can drive
   * sign-in with a fake and no live PostgreSQL; omitted in production, where the
   * shared pool is used.
   */
  readonly db?: Db;
}

/** Who signed in, carried back so the session can identify them. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
}

/**
 * What an attempt produced.
 *
 * A DISCRIMINATED UNION, like every other "this may not have worked" answer in
 * this codebase. The failure reasons are for the server's own use; see the
 * message rule below for what a person is told.
 */
export type SignInResult = (
  | { readonly ok: true; readonly user: AuthenticatedUser }
  | { readonly ok: false; readonly reason: "rejected" | "rate-limited" | "not-configured"; readonly message: string }
) & {
  /**
   * How long the caller should be made to wait before the answer is returned.
   *
   * DECIDED HERE, APPLIED BY THE ROUTE. The number is computed from failures
   * already recorded -- a test asserts it without waiting -- and the route
   * awaits an injectable sleep. Zero on every fast path, including a right
   * password and a per-caller 429; above zero only when the account is being
   * guessed at and the free attempts are spent.
   */
  readonly delayMs: number;
};

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
  "Sign-in is temporarily unavailable on this server. The audit engine is unaffected.";

/**
 * A valid scrypt hash of a throwaway password, computed once and kept.
 *
 * TIMING EQUALISATION. When no account matches the address there is no stored
 * hash to check, and returning straight away would refuse a wrong address in a
 * millisecond while a real one takes a tenth of a second -- and that difference
 * is itself an answer to "does this account exist". So an attempt against an
 * unknown address still runs one scrypt, against this placeholder, and still
 * fails. It is not a secret and matches no real password.
 */
let placeholderHash: Promise<string> | null = null;
function timingHash(): Promise<string> {
  placeholderHash ??= hashPassword("timing-equalisation-placeholder").catch((error: unknown) => {
    // Not kept if it failed, so the next attempt computes it afresh.
    placeholderHash = null;
    throw error;
  });
  return placeholderHash;
}

/**
 * One attempt to sign in, against the accounts in the database.
 *
 * THE RATE CHECK COMES FIRST, before the database is touched or the password is
 * hashed. Hashing is deliberately slow, so checking afterwards would let
 * somebody spend this server's processor — and now its database — by guessing,
 * which is a denial of service wearing a password attempt's clothes.
 *
 * THE STEPS, IN ORDER: trim and lower-case the address; look the account up;
 * require it to be ACTIVE; check the password; on success, stamp the login time
 * and return who signed in. A PENDING, REJECTED or INACTIVE account, an unknown
 * address and a wrong password are all refused in the same words.
 *
 * A SUCCESS CLEARS THE CALLER'S FAILURES. Somebody who mistyped four times and
 * then got it right is not four failures away from being locked out.
 *
 * THE ADDRESS IS COMPARED CASE-INSENSITIVELY (the column is `citext`) and the
 * password is not. Nobody thinks of their email address as having a case;
 * everybody knows a password does.
 */
export async function signIn(
  email: string,
  password: string,
  caller: string,
  options: CredentialOptions = {},
  now: number = Date.now(),
): Promise<SignInResult> {
  const recentFailures = recent(caller, now);

  /*
   * THE HARD PER-CALLER LIMIT APPLIES ONLY TO A CALLER WE CAN TRUST.
   *
   * An attributed caller is one a trusted proxy identified, so locking it out
   * for a window costs an attacker a real address. An unattributed caller is a
   * single shared bucket, and returning 429 for it would lock out the one
   * legitimate user along with everyone else -- so its guessing is slowed by
   * the account throttle below rather than stopped here.
   */
  if (caller !== UNATTRIBUTED && recentFailures.length >= MAX_FAILED_ATTEMPTS) {
    // Not recorded: a refused attempt must not extend the caller's own lockout.
    failures.set(caller, recentFailures);
    return { ok: false, reason: "rate-limited", message: RATE_LIMITED, delayMs: 0 };
  }

  /*
   * The account throttle is read BEFORE the password is hashed and applied to
   * whatever this attempt turns out to be. Its delay depends only on failures
   * already recorded, so it cannot leak whether this particular guess was
   * right -- a correct password waits exactly as long as a wrong one would
   * have during an active campaign, and then succeeds.
   */
  const key = accountKey(email);
  const accountHistory = recentAccountFailures(key, now);
  const delayMs = accountDelayMs(accountHistory.length);

  let user: User | null;
  try {
    user = await findByEmail(email.trim().toLowerCase(), options.db);
  } catch {
    /*
     * The database could not be reached. That is the server's problem, not the
     * person's, so it is not a rejection, records no failure, and the route
     * answers 503 rather than "wrong password".
     */
    return { ok: false, reason: "not-configured", message: NOT_CONFIGURED, delayMs: 0 };
  }

  /*
   * ONE SCRYPT ALWAYS RUNS. Against the account's hash when there is one, and
   * against a placeholder when there is not, so an unknown address and a wrong
   * password take the same time to refuse -- the timing cannot be read as an
   * answer to "does this account exist".
   */
  let stored: string;
  try {
    stored = user?.passwordHash ?? (await timingHash());
  } catch {
    // The placeholder could not be computed. Checking against an empty value
    // refuses, which is the only safe answer; no detail is passed on.
    stored = "";
  }
  const passwordMatches = await checkPassword(password, stored);

  /*
   * ONLY AN ACTIVE ACCOUNT WITH THE RIGHT PASSWORD SIGNS IN. A missing account,
   * a non-ACTIVE one and a wrong password are one outcome with one message, so
   * an attempt learns nothing about which it hit.
   */
  if (user === null || user.status !== "ACTIVE" || !passwordMatches) {
    /*
     * RE-READ HERE, NOT REUSED FROM THE START OF THIS ATTEMPT. Between that read
     * and this point the attempt waited for the database and for scrypt, and any
     * attempts running alongside it may have recorded failures meanwhile. Writing
     * the earlier snapshot back would overwrite theirs, so a burst of parallel
     * guesses would count as one. This read and the writes below run without
     * pausing, so nothing can slip in between them.
     *
     * It does NOT make admission atomic: attempts that all arrive before any of
     * them has failed still all pass the per-caller check at the top. What it
     * guarantees is that every failure is counted.
     */
    if (caller !== UNATTRIBUTED) recordFailure(failures, caller, [...recent(caller, now), now], MAX_TRACKED_CALLERS, now);
    recordFailure(accountFailures, key, [...recentAccountFailures(key, now), now], MAX_TRACKED_ACCOUNTS, now);

    /*
     * The spraying guard, read from the failures BEFORE this one and applied
     * only to this failed attempt -- so a correct password is never held up by
     * it -- and then this failure is added to it.
     */
    const recentSpray = withinWindow(sprayFailures, now);
    const failedDelayMs = Math.max(delayMs, sprayDelayMs(recentSpray.length));
    sprayFailures = [...recentSpray, now].slice(-MAX_SPRAY_FAILURES);

    return { ok: false, reason: "rejected", message: REJECTED, delayMs: failedDelayMs };
  }

  /*
   * The login time is stamped best-effort: a write that fails must not deny an
   * already-authenticated user access, so a rejected stamp is swallowed.
   */
  await updateLastLogin(user.id, options.db).catch(() => undefined);
  // Only this caller's and this account's own records are cleared. The spraying
  // guard is not: one person signing in says nothing about a campaign against others.
  failures.delete(caller);
  accountFailures.delete(key);
  return { ok: true, user: { id: user.id, email: user.email, role: user.role }, delayMs };
}
