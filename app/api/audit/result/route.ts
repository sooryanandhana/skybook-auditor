import { NextResponse } from "next/server";
import { auditResultRoute } from "@/lib/api/auditRoutes";
import type { AuditResultResponse } from "@/lib/types";

/**
 * GET /api/audit/result?jobId=...
 *
 * An adapter. Every decision lives in `auditResultRoute`, where it is tested.
 */
export async function GET(request: Request): Promise<NextResponse<AuditResultResponse>> {
  const { status, body } = auditResultRoute(request);
  return NextResponse.json(body, { status });
}
