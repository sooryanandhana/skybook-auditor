import { NextResponse } from "next/server";
import { fetchPage } from "@/lib/collector/fetchPage";
import { runSeoChecks } from "@/lib/collector/seoChecks";
import { runTechnicalChecks } from "@/lib/collector/technicalChecks";
import type { AuditData, AuditResponse, Finding } from "@/lib/types";

/**
 * POST /api/audit
 *
 * PHASE 3, STEP 1: really fetches the page and reports what came back.
 * The SEO, security, SSL/DNS and speed checks are still to come — the
 * findings list stays empty until then.
 *
 * Note the deliberate difference between two kinds of failure:
 *   - the site answered with an error   -> we know its status code
 *   - we never reached it at all        -> we report nothing about it
 * Never claim a measurement we didn't take.
 */
export async function POST(request: Request): Promise<NextResponse<AuditResponse>> {
  let url: string;

  try {
    const body = await request.json();
    url = typeof body?.url === "string" ? body.url.trim() : "";
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not read the request." },
      { status: 400 },
    );
  }

  if (!url) {
    return NextResponse.json(
      { ok: false, error: "Please enter a website address." },
      { status: 400 },
    );
  }

  const result = await fetchPage(url);

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.reason,
        // Present only when the site actually answered. Keeping it means a
        // 404 or 500 still reports the server as reachable, with its timing.
        ...(result.uptime ? { uptime: result.uptime } : {}),
      },
      { status: 422 },
    );
  }

  const { page } = result;

  const seo = runSeoChecks(page.html);
  const technical = await runTechnicalChecks(page.finalUrl);

  // Findings arrive in step 6, where fixed rules turn these measurements into
  // graded issues. Until then we show the raw facts only.
  const findings: Finding[] = [];

  const data: AuditData = {
    url: page.finalUrl,
    checkedAt: new Date().toISOString(),
    uptime: page.uptime,
    servedOverHttps: page.servedOverHttps,
    seo,
    technical,
    findings,
  };

  return NextResponse.json({ ok: true, data });
}
