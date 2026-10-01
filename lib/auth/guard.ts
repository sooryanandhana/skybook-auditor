/**
 * The one place that decides whether a request is allowed through.
 *
 * ONE FUNCTION, CALLED SIX TIMES, RATHER THAN SIX COPIES OF A DECISION. Every
 * route adapter in this project is thirteen to twenty lines of glue over a
 * function in `lib` that does the deciding, and the adapters decide nothing on
 * purpose. Writing the session check into each of them would put the same
 * judgement in six files and make the failure mode "somebody forgot the
 * seventh one", which is the kind of mistake nothing catches until it matters.
 *
 * IT FAILS CLOSED, AND EVERY FAILURE LOOKS THE SAME. A missing cookie, a
 * forged one, an expired one and a server with no signing secret all produce
 * the same refusal, because the only thing a caller may do with any of them is
 * sign in. Telling them apart would tell somebody probing the application
 * which of their guesses was closer.
 *
 * IT IS NOT THE PAGE REDIRECT. The application's pages redirect somebody who
 * is not signed in, which is a courtesy to a person using a browser. This is
 * the security boundary, and it runs even when nothing rendered.
 */
import { SESSION_COOKIE, readSession, type SessionOptions } from "./session.ts";
import { findById, type Db, type Role, type User } from "../users/userRepository.ts";

/** What the guard needs: the signing secret, and the database to resolve by. */
export interface GuardOptions extends SessionOptions {
  /**
   * The database to resolve the signed-in account from. Injected by tests so
   * they can drive the guard with a fake and no live PostgreSQL; omitted in
   * production, where the shared pool is used.
   */
  readonly db?: Db;
}

/**
 * What an unauthorised caller is told.
 *
 * 401 BECAUSE THE PROBLEM IS WHO IS ASKING, not what they asked for. A 404
 * would hide that the route exists, which is tempting and wrong here: the
 * routes are named in the application's own JavaScript, so pretending they are
 * absent fools nobody and confuses the browser that just called one.
 *
 * The sentence says what to do and nothing else. No cookie name, no reason, no
 * hint about which part of the check refused.
 */
export const UNAUTHORISED = "Sign in to use this.";
export const UNAUTHORISED_STATUS = 401;

/**
 * The cookie's value, read from a request's own header.
 *
 * PARSED HERE RATHER THAN TAKEN FROM THE FRAMEWORK, because this runs against
 * a plain `Request` in tests as well as inside a route. The parsing is
 * deliberately dull: split on semicolons, match the name exactly, take the
 * rest of the pair as the value. A cookie value that itself contains an equals
 * sign survives, which base64url padding can produce.
 */
export function sessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      return pair.slice(separator + 1).trim();
    }
  }

  return null;
}

/**
 * The ACTIVE account behind a request, or null.
 *
 * TWO CHECKS, IN ORDER. First the cookie must be a session this server signed
 * and has not expired — that is cheap and needs no database. Only then is the
 * account it names resolved, and it is let through ONLY while its status is
 * ACTIVE. Reading the status every request is what makes deactivation immediate:
 * a manager switching an account off ends its access on the account's very next
 * call, whatever an older cookie still carries.
 *
 * NULL IS THE WHOLE ANSWER, for every failure alike — no cookie, a forged or
 * expired one, no account, a non-ACTIVE account, or a database that could not be
 * reached. A caller that wants to know WHICH has asked a question this will not
 * answer, because telling them apart tells somebody probing which guess was
 * closer. A database that is down therefore fails closed, like everything else.
 */
export async function requireSession(
  request: Request,
  options: GuardOptions = {},
  now: number = Date.now(),
): Promise<User | null> {
  const session = readSession(sessionCookie(request), options, now);
  if (session === null) return null;

  let user: User | null;
  try {
    user = await findById(session.userId, options.db);
  } catch {
    return null;
  }

  if (user === null || user.status !== "ACTIVE") return null;
  return user;
}

/**
 * The ACTIVE account behind a request WHEN it holds the required role, or null.
 *
 * Built on `requireSession`, so every refusal above is a refusal here too, and
 * the role is read from the account in the database rather than from the cookie
 * — a role changed by a manager takes effect at once, and a cookie cannot claim
 * a role its account does not currently hold. Management-only routes call this;
 * the ordinary routes call `requireSession`.
 */
export async function requireRole(
  request: Request,
  role: Role,
  options: GuardOptions = {},
  now: number = Date.now(),
): Promise<User | null> {
  const user = await requireSession(request, options, now);
  if (user === null || user.role !== role) return null;
  return user;
}

/** The body and status a route returns when nobody is signed in. */
export const unauthorised = () => ({
  status: UNAUTHORISED_STATUS,
  body: { ok: false as const, error: UNAUTHORISED },
});
