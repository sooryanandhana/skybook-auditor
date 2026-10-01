import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { auditResultRoute } from "@/lib/api/auditRoutes";
import type { AuditResultResponse } from "@/lib/types";

/**
 * GET /api/audit/result?jobId=...
 *
 * An adapter. Every decision lives in `auditResultRoute`, where it is tested.
 */
export async function GET(request: Request): Promise<NextResponse<AuditResultResponse>> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if ((await requireSession(request)) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const { status, body } = auditResultRoute(request);
  return NextResponse.json(body, { status });
}
