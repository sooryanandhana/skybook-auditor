import { NextResponse } from "next/server";
import { listUsersRoute, manageUserRoute } from "@/lib/auth/manageUsersRoute";

/**
 * /api/users — the management console's API.
 *
 * An adapter. Every decision — including that the caller is a MANAGEMENT account
 * — lives in `manageUsersRoute`, where a test can reach it. Both handlers refuse
 * anyone the role guard refuses, with a 403 and a generic sentence.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const result = await listUsersRoute(request);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, users: result.users }, { status: result.status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await manageUserRoute(request);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, user: result.user }, { status: result.status });
}
