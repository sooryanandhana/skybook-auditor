import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
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
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if ((await requireSession(request)) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const { status, body, headers } = await performanceRoute(request);
  return NextResponse.json(body, { status, headers });
}
