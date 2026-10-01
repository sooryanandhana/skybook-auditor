/**
 * What the sign-up endpoint decides.
 *
 * THE DECISIONS, NOT THE PLUMBING, exactly like `loginRoute`. The adapter in
 * `app/api/auth/register` reads a body, calls this, and turns the answer into a
 * response; everything worth arguing about is here, where a test drives it with
 * a plain `Request` and no server.
 *
 * A SALESPERSON ASKS; A MANAGER DECIDES. This creates one kind of account and
 * one only: role SALES, status PENDING. The role and the status are written in
 * THIS file, never read from the request, so nothing a client sends can make an
 * account that is a manager, or one that is already active. Approval is Step 6.
 *
 * IT NEVER SAYS WHETHER AN ADDRESS IS ALREADY REGISTERED. A new sign-up and a
 * repeat of an existing address get the same answer, because telling them apart
 * would turn this form into a way to find out who has an account. The duplicate
 * is caught by the database's own UNIQUE constraint, not by a read-first check
 * that two simultaneous sign-ups could both pass.
 *
 * THE PASSWORD IS HASHED HERE AND STORED AS A HASH, with the same scrypt code
 * sign-in checks against. The plaintext is read once, hashed, and never stored,
 * logged or returned.
 */
import { hashPassword } from "./credentials.ts";
import { create, isUniqueViolation, type Db } from "../users/userRepository.ts";
import { checkRegisterLimit, registerCaller } from "./registerLimit.ts";
import { trustsProxy as trustsProxyFlag } from "../callerAddress.ts";

/** The fewest characters a chosen password may have. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The most a password may have.
 *
 * A ceiling, not a rule about strength: scrypt reads the whole password, so an
 * unbounded one is a way to make the server do unbounded work. Long enough that
 * no real passphrase meets it.
 */
export const MAX_PASSWORD_LENGTH = 200;

/** The most an email address may have, per the relevant RFC. */
export const MAX_EMAIL_LENGTH = 254;

/* ---------------------------------------------------------------------------
   What a person is told
   --------------------------------------------------------------------------- */

/**
 * Said on a successful request AND on a repeat of an existing address, word for
 * word, so the answer reveals nothing about who already has an account.
 */
export const REGISTERED =
  "Thanks — your request has been received. You'll be able to sign in once a manager approves your account.";

export const INVALID_EMAIL = "Enter a valid email address.";
export const WEAK_PASSWORD = `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
export const RATE_LIMITED = "Too many sign-up attempts. Wait a few minutes and try again.";
export const UNAVAILABLE = "Sign-up is temporarily unavailable. Please try again shortly.";

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

/**
 * Whether a string is plausibly an email address.
 *
 * Deliberately pragmatic, not RFC-exhaustive (no validator is): one `@`, a
 * non-empty local part, a domain with a dot, no spaces, no doubled dots, and a
 * length within the RFC's ceiling. The real test of an address is whether mail
 * reaches it; this only turns away what is obviously not one. Expects the
 * already-normalised (trimmed, lower-cased) form.
 */
export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (email.includes("..")) return false;

  const domain = email.slice(email.indexOf("@") + 1);
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.startsWith("-") || domain.endsWith("-")) return false;
  return true;
}

/**
 * Whether a password may be set.
 *
 * Length only, and not trimmed: a password is checked exactly as typed, so its
 * spaces are its own. What is refused is one too short to matter, one so long it
 * is a way to spend the server's processor, and one that is nothing but spaces.
 */
export function isAcceptablePassword(password: string): boolean {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return false;
  if (password.trim().length === 0) return false;
  return true;
}

/* ---------------------------------------------------------------------------
   The route
   --------------------------------------------------------------------------- */

export interface RegisterOptions {
  /** Injected database, so tests drive registration with a fake and no live DB. */
  readonly db?: Db;
  /** Whether a trusted proxy set the forwarded address. Off by default. */
  readonly trustProxy?: boolean;
  readonly now?: number;
}

export type RegisterOutcome =
  | { readonly ok: true; readonly status: number; readonly message: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** Only the two fields a sign-up form may send. Anything else is ignored. */
function submitted(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null) return { email: "", password: "" };
  const { email, password } = body as { email?: unknown; password?: unknown };
  return {
    email: typeof email === "string" ? email : "",
    password: typeof password === "string" ? password : "",
  };
}

/**
 * One request to register a new salesperson.
 *
 * THE RATE CHECK COMES FIRST, before the body is read or a password is hashed,
 * so a flood of sign-ups cannot spend this server's processor or fill its table.
 */
export async function registerRoute(request: Request, options: RegisterOptions = {}): Promise<RegisterOutcome> {
  const now = options.now ?? Date.now();

  const caller = registerCaller(request, trustsProxyFlag(options.trustProxy));
  if (!checkRegisterLimit(caller, now).allowed) {
    return { ok: false, status: 429, error: RATE_LIMITED };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const { email, password } = submitted(body);

  // Normalised the same way sign-in normalises it, so the address stored is the
  // address someone will later type.
  const normalisedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalisedEmail)) return { ok: false, status: 400, error: INVALID_EMAIL };
  if (!isAcceptablePassword(password)) return { ok: false, status: 400, error: WEAK_PASSWORD };

  const passwordHash = hashPassword(password);

  try {
    // Role and status are fixed here, NOT read from the body: a client cannot
    // ask to be a manager, or to skip approval.
    await create({ email: normalisedEmail, passwordHash, role: "SALES", status: "PENDING" }, options.db);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The address already has an account. Answer exactly as a new sign-up
      // would, so the form reveals nothing about who is registered.
      return { ok: true, status: 202, message: REGISTERED };
    }
    // Any other failure is the server's, not the person's.
    return { ok: false, status: 503, error: UNAVAILABLE };
  }

  return { ok: true, status: 202, message: REGISTERED };
}
