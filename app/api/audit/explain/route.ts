import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { explainRoute } from "@/lib/api/auditRoutes";
import type { AuditExplanationResponse } from "@/lib/types";

/**
 * POST /api/audit/explain?jobId=...
 *
 * An adapter. Every decision — the claim, the composition, the status codes —
 * lives in `explainRoute`, where it is tested.
 *
 * SERVER ONLY, AND THAT IS THE POINT OF IT EXISTING. The key, the provider
 * client and the request all stay in this process; the browser sends a job id
 * and receives validated prose. There is no NEXT_PUBLIC_ copy of the key and
 * no path by which a page could reach a model directly.
 */
export async function POST(request: Request): Promise<NextResponse<AuditExplanationResponse>> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if ((await requireSession(request)) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const { status, body } = await explainRoute(request);
  return NextResponse.json(body, { status });
}
