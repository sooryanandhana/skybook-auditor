import { NextResponse } from "next/server";
import { fetchPage } from "@/lib/collector/fetchPage";
import { runSeoChecks } from "@/lib/collector/seoChecks";
import { runSecurityChecks } from "@/lib/collector/securityChecks";
import { runTechnicalChecks } from "@/lib/collector/technicalChecks";
import { runSslChecks } from "@/lib/collector/sslChecks";
import { runDnsChecks } from "@/lib/collector/dnsChecks";
import { normalizeUrl } from "@/lib/collector/url";
import { capDeadline, createDeadline } from "@/lib/collector/deadline";
import { callerKey, checkRateLimit } from "@/lib/rateLimit";
import type { AuditData, AuditResponse, Finding, TechnicalData } from "@/lib/types";

/**
 * The longest one audit may take, covering every request it makes.
 *
 * Each part used to keep its own timer — the page fetch allowed 20 seconds and
 * could run twice, the technical checks another 10 — so nothing capped the
 * total and a slow site could hold a request open for around fifty seconds.
 */
const AUDIT_BUDGET_MS = 30_000;

/**
 * The share of the audit's time the site-level checks may take together.
 *
 * SSL and DNS describe the site rather than the page, so Phase 4 will run them
 * once and reuse the result across every page it crawls. They are capped as a
 * group for the same reason the technical checks are: a component handed the
 * audit's whole clock would use every second the earlier steps did not.
 */
const SITE_CHECKS_BUDGET_MS = 10_000;

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
  // Checked before any work is done, so a caller over the limit costs us
  // nothing — not a page fetch, and from the next step on, not a paid API call.
  const limit = checkRateLimit(callerKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many audits in a short time. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(limit.retryAfterSeconds),
          "X-RateLimit-Limit": String(limit.limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

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

  // One clock for the whole audit. Every check below shares it, so time spent
  // fetching the page is time the later checks no longer have.
  const deadline = createDeadline(AUDIT_BUDGET_MS);

  const result = await fetchPage(url, deadline);

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.reason,
        // Present only when the site actually answered. Keeping it means a
        // 404 or 500 still reports the server as reachable, with its timing.
        ...(result.uptime ? { uptime: result.uptime } : {}),
        // The message says this in English too, but nothing later should have
        // to read English to find out the certificate expired.
        ...(result.certificateProblem
          ? { certificateProblem: result.certificateProblem }
          : {}),
      },
      { status: 422 },
    );
  }

  const { page } = result;

  // These two read data we already hold, so they cost no time and always run.
  const seo = runSeoChecks(page.html, page.finalUrl);
  const security = runSecurityChecks(
    page.headers,
    page.html,
    page.servedOverHttps,
    page.setCookieHeaders,
  );

  /*
   * The technical checks make their own requests, so they are the part that
   * can be cut short. When the budget is gone we report null rather than
   * running them with no time — null means "not checked", and is very
   * different from "this site has no robots.txt".
   */
  let technical: TechnicalData | null = null;
  if (!deadline.expired()) {
    technical = await runTechnicalChecks(page.finalUrl, deadline);
  }

  /*
   * Site-level checks: the certificate and the DNS records describe the whole
   * site, not this one page. They share a capped slice of the audit's clock,
   * and they run together because neither waits on the other.
   *
   * Both report their own "we could not find out" states rather than throwing,
   * so a refused or unreachable domain still produces an audit.
   */
  const siteHostname = new URL(page.finalUrl).hostname;
  const siteDeadline = capDeadline(deadline, SITE_CHECKS_BUDGET_MS);
  const [ssl, dns] = await Promise.all([
    runSslChecks(siteHostname, page.servedOverHttps, siteDeadline),
    runDnsChecks(siteHostname, siteDeadline),
  ]);

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
    ssl,
    dns,

    // Modules not built yet. null means "not measured".
    performance: null,
    hosting: null,

    // Populated once the severity-rules module exists.
    findings: [] as Finding[],

    // So a partial audit is never mistaken for a complete one.
    timedOut: technical === null,
  };

  return NextResponse.json({ ok: true, data });
}
