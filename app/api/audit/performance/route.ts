import { NextResponse } from "next/server";
import { performanceRoute } from "@/lib/api/auditRoutes";
import type { PerformanceResponse } from "@/lib/types";

/**
 * POST /api/audit/performance
 *
 * An adapter. Every decision — the rate limit, the address, the grading, the
 * status codes — lives in `performanceRoute`, where it is tested. The API key
 * stays on the server and is never sent to the browser; there is no
 * NEXT_PUBLIC_ copy of it.
 */
export async function POST(request: Request): Promise<NextResponse<PerformanceResponse>> {
  const { status, body, headers } = await performanceRoute(request);
  return NextResponse.json(body, { status, headers });
}
