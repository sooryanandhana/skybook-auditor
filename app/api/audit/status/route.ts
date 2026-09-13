import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { auditStatusRoute } from "@/lib/api/auditRoutes";
import type { AuditStatusResponse } from "@/lib/types";

/**
 * GET /api/audit/status?jobId=...
 *
 * An adapter. Every decision lives in `auditStatusRoute`, where it is tested.
 */
export async function GET(request: Request): Promise<NextResponse<AuditStatusResponse>> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if (requireSession(request) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const { status, body } = auditStatusRoute(request);
  return NextResponse.json(body, { status });
}
