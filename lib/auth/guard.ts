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
import { SESSION_COOKIE, readSession, type Session, type SessionOptions } from "./session.ts";

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
 * The session behind a request, or null.
 *
 * Null is the whole answer. A caller that wants to know WHY has asked a
 * question this function will not answer, for the reason above.
 */
export function requireSession(
  request: Request,
  options: SessionOptions = {},
  now: number = Date.now(),
): Session | null {
  return readSession(sessionCookie(request), options, now);
}

/** The body and status a route returns when nobody is signed in. */
export const unauthorised = () => ({
  status: UNAUTHORISED_STATUS,
  body: { ok: false as const, error: UNAUTHORISED },
});
