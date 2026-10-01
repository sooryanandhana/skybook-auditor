import { NextResponse } from "next/server";
import { registerRoute } from "@/lib/auth/registerRoute";

/**
 * POST /api/auth/register
 *
 * An adapter. Every decision lives in `registerRoute`, where it is tested.
 *
 * NOT GUARDED, on purpose and for the same reason sign-in is not: requiring a
 * session to ask for one is a locked door with the key inside. A salesperson
 * registering does not have an account yet. Abuse is held off by the
 * registration rate limit inside `registerRoute`, not by a session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const outcome = await registerRoute(request);

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json({ ok: true, message: outcome.message }, { status: outcome.status });
}
