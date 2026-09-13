import { NextResponse } from "next/server";
import { requireSession, unauthorised } from "@/lib/auth/guard";
import { startAuditRoute } from "@/lib/api/auditRoutes";
import type { AuditStartResponse } from "@/lib/types";

/**
 * POST /api/audit
 *
 * Starts an audit and answers with a job id straight away. A full-site crawl
 * takes minutes, and an HTTP request held open for minutes is one that
 * proxies, load balancers and browsers all feel entitled to cut.
 *
 * AN ADAPTER, NOTHING MORE. Every decision — the rate limit, the body, the
 * address, the status code — lives in `startAuditRoute`, where a test can
 * reach it. A Next.js route cannot be imported outside the framework, so logic
 * kept here is logic nobody can test.
 */
export async function POST(request: Request): Promise<NextResponse<AuditStartResponse>> {
  /*
   * THE SECURITY BOUNDARY, not the page redirect. A request that never
   * rendered a page never passed the sign-in, so every route asks for
   * itself. The decision is in lib/auth/guard.ts and is tested there.
   */
  if (requireSession(request) === null) {
    const refused = unauthorised();
    return NextResponse.json(refused.body, { status: refused.status });
  }
  const { status, body, headers } = await startAuditRoute(request);
  return NextResponse.json(body, { status, headers });
}
