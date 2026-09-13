/**
 * Who is signed in, carried in a cookie the browser cannot forge.
 *
 * WHY THERE IS NO LIBRARY HERE, and this was decided by inspection rather than
 * by preference. The dangerous part of authentication is the OAuth dance:
 * redirects, state, code exchange, verifying somebody else's token. This
 * project is not doing any of that. What is left is a signed cookie, which is
 * a message and a keyed hash of that message, and Node ships both primitives.
 * Adding a dependency to call `createHmac` would be a dependency that does not
 * reduce the amount of thinking required.
 *
 * SIGNED, NOT ENCRYPTED, and the distinction matters. Anyone holding the
 * cookie can read the address inside it; nobody without the secret can change
 * it. That is the right trade here because the address is not a secret -- the
 * person it belongs to typed it -- and the property worth having is that a
 * browser cannot promote itself by editing a value.
 *
 * IT CARRIES AN ADDRESS RATHER THAN A YES. A cookie saying "signed in" would
 * be the same size and would tell a later version of this application nothing
 * about who is asking. Roles and a move to Google Workspace both need a person
 * to point at, and this is the cheapest possible moment to start carrying one.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The cookie's name. One place, because the route and the proxy both need it. */
export const SESSION_COOKIE = "skybook_session";

/** Where the signing key is read from. Never prefixed `NEXT_PUBLIC_`. */
export const SESSION_SECRET_VARIABLE = "SESSION_SECRET";

/**
 * How long a sign-in lasts.
 *
 * A WORKING DAY, not a month. This is a sales tool used from a laptop that
 * goes to client sites; a session that outlived the week would be one more
 * thing left behind on a machine. Someone signing in each morning is not a
 * hardship, and it is the cheapest revocation this application has -- there is
 * no session store to delete from, so expiry is the only way a session ends
 * other than signing out.
 */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * How the cookie is set, as one object both routes read.
 *
 * EVERY ONE OF THESE IS LOAD-BEARING and the Next.js guide names all four.
 * `httpOnly` keeps it away from any script on the page, which is what stops a
 * cross-site scripting bug from also being a stolen session. `secure` keeps it
 * off plain HTTP. `sameSite` is what stops another site making a request that
 * carries it. `path` scopes it to the whole application, which is what we want
 * when the whole application is behind the login.
 *
 * `secure` IS RELAXED ON A DEVELOPMENT MACHINE ONLY. A secure cookie is never
 * sent over http, and local development is http, so in development the cookie
 * would be set and never seen again. The check is on `NODE_ENV`, which a
 * request cannot influence.
 */
export const sessionCookieOptions = (maxAgeMs = SESSION_MAX_AGE_MS) =>
  ({
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  }) as const;

export interface SessionOptions {
  /**
   * Overrides the environment. Supplied by tests so none of them depend on a
   * secret being present, or absent, on the machine running them.
   */
  readonly secret?: string;
}

/**
 * Whether sessions can be signed at all, in a form that is safe to log.
 *
 * SHAPED LIKE `geminiAvailability`, on purpose. This project already has a
 * word for "configured or not, and if not, a sentence a person can act on",
 * and a second shape for the same idea would be a second thing to learn.
 */
export type SessionAvailability =
  | { readonly configured: true }
  | { readonly configured: false; readonly reason: string };

const NOT_CONFIGURED =
  `No ${SESSION_SECRET_VARIABLE} is configured on this server, so nobody can sign in. ` +
  "The audit engine is unaffected.";

/**
 * The shortest key this will accept.
 *
 * Thirty-two bytes is what `openssl rand -base64 32` produces and what the
 * Next.js guide suggests generating. The check exists because a secret of
 * "changeme" signs cookies perfectly well and forges just as easily, and the
 * failure would be silent.
 */
const MINIMUM_SECRET_LENGTH = 32;

function resolveSecret(options: SessionOptions): string {
  return (options.secret ?? process.env[SESSION_SECRET_VARIABLE] ?? "").trim();
}

/** Safe to log, print or return. Carries no key. */
export function sessionAvailability(options: SessionOptions = {}): SessionAvailability {
  const secret = resolveSecret(options);

  if (secret.length < MINIMUM_SECRET_LENGTH) return { configured: false, reason: NOT_CONFIGURED };
  return { configured: true };
}

/** What a signed cookie says once it has been believed. */
export interface Session {
  readonly email: string;
  /** When it stops being valid, as milliseconds since the epoch. */
  readonly expiresAt: number;
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * A cookie value for this person, or null when no secret is configured.
 *
 * NULL RATHER THAN A THROW, and rather than an unsigned fallback. A server
 * with no secret cannot sign anything, and the honest outcome is that nobody
 * signs in -- not that everybody does.
 */
export function signSession(
  email: string,
  options: SessionOptions = {},
  now: number = Date.now(),
): string | null {
  const secret = resolveSecret(options);
  if (!sessionAvailability(options).configured) return null;

  const payload = encode(JSON.stringify({ email, expiresAt: now + SESSION_MAX_AGE_MS }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Whether two signatures match, without leaking which byte differed.
 *
 * `timingSafeEqual` THROWS ON A LENGTH MISMATCH, which is why the lengths are
 * compared first. That comparison leaks only the length of a hash whose length
 * is fixed and public, so it gives an attacker nothing.
 */
function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The session a cookie carries, or null.
 *
 * NULL FOR EVERY FAILURE, deliberately and without saying which. A missing
 * cookie, a tampered one, a correctly signed one that has expired and a server
 * with no secret all produce the same answer, because the only thing a caller
 * may do with any of them is refuse.
 *
 * THE SIGNATURE IS CHECKED BEFORE THE PAYLOAD IS PARSED. Reading an attacker's
 * JSON and then deciding whether to believe it is how a parser becomes an
 * attack surface.
 */
export function readSession(
  cookie: string | undefined | null,
  options: SessionOptions = {},
  now: number = Date.now(),
): Session | null {
  const secret = resolveSecret(options);
  if (!sessionAvailability(options).configured) return null;
  if (typeof cookie !== "string" || cookie === "") return null;

  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  if (!sameSignature(sign(payload, secret), signature)) return null;

  let claimed: unknown;
  try {
    claimed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claimed !== "object" || claimed === null) return null;
  const { email, expiresAt } = claimed as { email?: unknown; expiresAt?: unknown };

  if (typeof email !== "string" || email === "") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return null;

  return { email, expiresAt };
}
