import { NextResponse } from "next/server";
import { fetchPage } from "@/lib/collector/fetchPage";
import { runSeoChecks } from "@/lib/collector/seoChecks";
import { runSecurityChecks } from "@/lib/collector/securityChecks";
import { runTechnicalChecks } from "@/lib/collector/technicalChecks";
import { normalizeUrl } from "@/lib/collector/url";
import type { AuditData, AuditResponse, Finding } from "@/lib/types";

/**
 * POST /api/audit
 *
 * Runs the deterministic audit checks that have been built so far and returns
 * the measurements. Sections whose modules do not exist yet are returned as
 * null — meaning "not measured", never "measured and fine".
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

  const seo = runSeoChecks(page.html, page.finalUrl);
  const security = runSecurityChecks(
    page.headers,
    page.html,
    page.servedOverHttps,
    page.setCookieHeaders,
  );
  const technical = await runTechnicalChecks(page.finalUrl);

  // The address as we requested it, before any redirects. normalizeUrl already
  // succeeded inside fetchPage, so this cannot fail here; the fallback keeps
  // the types honest rather than guarding against a real case.
  const normalized = normalizeUrl(url);
  const requestedUrl = normalized.ok ? normalized.url.toString() : url;

  const data: AuditData = {
    website: {
      requestedUrl,
      checkedAt: new Date().toISOString(),
    },
    fetch: {
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
      wasRedirected: page.redirectChain.length > 1,
      servedOverHttps: page.servedOverHttps,
      httpsUnavailable: page.httpsUnavailable,
      certificateProblem: page.certificateProblem ?? null,
      contentType: page.contentType,
    },
    uptime: page.uptime,
    seo,
    security,
    technical,

    // Modules not built yet. null means "not measured".
    performance: null,
    ssl: null,
    dns: null,
    hosting: null,

    // Populated once the severity-rules module exists.
    findings: [] as Finding[],
  };

  return NextResponse.json({ ok: true, data });
}
