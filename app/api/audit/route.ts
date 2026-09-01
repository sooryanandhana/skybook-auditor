import { NextResponse } from "next/server";
import { fetchPage } from "@/lib/collector/fetchPage";
import type { AuditData, AuditResponse, Finding } from "@/lib/types";

/**
 * POST /api/audit
 *
 * PHASE 3, STEP 1: really fetches the page and reports what came back.
 * The SEO, security, SSL/DNS and speed checks are still to come — the
 * findings list stays empty until then.
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
    return NextResponse.json({ ok: false, error: result.reason }, { status: 422 });
  }

  const { page } = result;

  // Findings arrive in steps 2-6. For now we report only what fetching told us,
  // so there is nothing here that wasn't actually measured.
  const findings: Finding[] = [];

  const data: AuditData = {
    url: page.finalUrl,
    checkedAt: new Date().toISOString(),
    uptime: page.uptime,
    findings,
  };

  return NextResponse.json({ ok: true, data });
}
