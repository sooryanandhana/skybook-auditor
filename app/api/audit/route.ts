import { NextResponse } from "next/server";
import type { AuditData, AuditResponse } from "@/lib/types";

/**
 * POST /api/audit
 *
 * PHASE 2: returns placeholder data so we can build and test the interface
 * before any real website checking exists.
 *
 * PHASE 3 will replace makePlaceholderAudit() with the real Collector.
 * The response shape will not change — that's the point of defining it now.
 */
export async function POST(request: Request): Promise<NextResponse<AuditResponse>> {
  let url: string;

  // Read the URL the browser sent us. If the request body is malformed, say so
  // rather than crashing.
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

  // Pretend the audit takes a moment, so we can see the loading state working.
  await new Promise((resolve) => setTimeout(resolve, 800));

  return NextResponse.json({ ok: true, data: makePlaceholderAudit(url) });
}

/**
 * Fake audit results. Nothing here is measured — it exists only to prove the
 * browser/server round trip works. Phase 3 deletes this entirely.
 */
function makePlaceholderAudit(url: string): AuditData {
  return {
    url,
    checkedAt: new Date().toISOString(),
    uptime: {
      isOnline: true,
      statusCode: 200,
      responseTimeMs: 412,
    },
    findings: [
      {
        id: "no-https",
        title: "Site is not served over HTTPS",
        category: "security",
        severity: "critical",
        evidence: "PLACEHOLDER — not a real measurement.",
      },
      {
        id: "slow-lcp",
        title: "Main content loads slowly",
        category: "speed",
        severity: "high",
        evidence: "PLACEHOLDER — not a real measurement.",
      },
      {
        id: "missing-meta-description",
        title: "Missing meta description",
        category: "seo",
        severity: "medium",
        evidence: "PLACEHOLDER — not a real measurement.",
      },
      {
        id: "images-missing-alt",
        title: "Some images have no alt text",
        category: "seo",
        severity: "medium",
        evidence: "PLACEHOLDER — not a real measurement.",
      },
      {
        id: "ssl-valid",
        title: "SSL certificate is valid",
        category: "security",
        severity: "good",
        evidence: "PLACEHOLDER — not a real measurement.",
      },
    ],
  };
}
