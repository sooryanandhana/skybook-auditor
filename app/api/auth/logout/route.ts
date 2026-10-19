import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { LOGIN_PATH, logoutRoute } from "@/lib/auth/loginRoute";

/**
 * POST /api/auth/logout
 *
 * An adapter. Signing out is replacing the cookie, because the cookie is the
 * session — there is no store to delete a row from.
 *
 * NO SESSION IS REQUIRED TO CALL THIS. Refusing to sign out somebody whose
 * session already expired would leave a stale cookie in their browser and tell
 * them they are not signed in enough to stop being signed in.
 *
 * A REFUSED REQUEST SETS NO COOKIE. `logoutRoute` refuses a request a browser
 * marks as coming from another site, and then the session is left exactly as
 * it was.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const outcome = logoutRoute(request);
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.status });
  }

  const response = NextResponse.json({ ok: true, next: LOGIN_PATH });
  response.cookies.set(SESSION_COOKIE, outcome.cookie, sessionCookieOptions(outcome.maxAgeSeconds * 1000));
  return response;
}
