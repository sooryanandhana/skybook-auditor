import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { loginRoute } from "@/lib/auth/loginRoute";

/**
 * POST /api/auth/login
 *
 * An adapter. Every decision lives in `loginRoute`, where it is tested.
 *
 * THE COOKIE IS SET HERE AND NOWHERE ELSE, because setting one needs the
 * framework's own response API. The value and the lifetime were decided by the
 * function above; this only puts them on the wire.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const outcome = await loginRoute(request);

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.status });
  }

  /*
   * The address comes back so the page can greet the person. The password does
   * not, the hash does not, and neither has been anywhere near this file.
   */
  const response = NextResponse.json({ ok: true, email: outcome.email });
  response.cookies.set(SESSION_COOKIE, outcome.cookie, sessionCookieOptions());
  return response;
}
