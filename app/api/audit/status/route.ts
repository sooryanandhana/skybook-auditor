import { NextResponse } from "next/server";
import { auditStatusRoute } from "@/lib/api/auditRoutes";
import type { AuditStatusResponse } from "@/lib/types";

/**
 * GET /api/audit/status?jobId=...
 *
 * An adapter. Every decision lives in `auditStatusRoute`, where it is tested.
 */
export async function GET(request: Request): Promise<NextResponse<AuditStatusResponse>> {
  const { status, body } = auditStatusRoute(request);
  return NextResponse.json(body, { status });
}
