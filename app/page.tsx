"use client";
// ^ This tells Next.js the file runs in the BROWSER, not on the server.
//   We need that because this page has a button, a text box, and remembers
//   things (state) — all of which are browser-side behaviour.

import { useState } from "react";
import type {
  AuditData,
  AuditResponse,
  CertificateProblem,
  Severity,
  UptimeCheck,
} from "@/lib/types";
import styles from "./page.module.css";

export default function HomePage() {
  // Pieces of "state" — values the page remembers and re-renders when changed.
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AuditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed audit can still have measured something — see AuditResponse.
  const [errorUptime, setErrorUptime] = useState<UptimeCheck | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault(); // stop the browser reloading the page

    setIsLoading(true);
    setError(null);
    setErrorUptime(null);
    setResult(null);

    try {
      // Send the URL to our own backend at /api/audit and wait for its answer.
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const payload: AuditResponse = await response.json();

      if (payload.ok) {
        setResult(payload.data);
      } else {
        setError(payload.error);
        setErrorUptime(payload.uptime ?? null);
      }
    } catch {
      setError("Could not reach the audit service. Is the server running?");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          {/*
            The logo file has ~77% empty padding around it, and stacks the icon
            above the wordmark and tagline. We show only the icon here by
            scaling the image up inside a fixed-size box that hides the overflow.
            The crop values come from measuring the file's actual content bounds.
          */}
          <span className={styles.logoMark} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/skybook-digital-logo-white.png" alt="" className={styles.logoImg} />
          </span>
          <p className={styles.brand}>Skybook</p>
        </div>
        <h1 className={styles.title}>Website Audit</h1>
        <p className={styles.subtitle}>
          Enter a website address to check its speed, SEO, security, and technical health.
        </p>
      </header>

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="example.com"
          aria-label="Website address"
          disabled={isLoading}
        />
        <button className={styles.button} type="submit" disabled={isLoading || !url.trim()}>
          {isLoading ? "Checking…" : "Run Audit"}
        </button>
      </form>

      {/* Removed once all six Phase 3 checks are in place. */}
      <p className={styles.placeholderNotice}>
        Steps 1–3 of 6 are live: the page is fetched, its SEO checked and its
        security settings read. SSL/DNS, speed and the severity rules are still
        to come.
      </p>

      {error && (
        <div className={styles.error}>
          <p>{error}</p>
          {/* We couldn't audit the page, but we did reach the server —
              show what was genuinely measured rather than discarding it. */}
          {errorUptime && (
            <p className={styles.errorDetail}>
              The server did respond ({errorUptime.statusCode}) in{" "}
              {errorUptime.serverResponseTimeMs} ms, so the site itself is reachable.
            </p>
          )}
        </div>
      )}

      {result && <Results data={result} />}
    </main>
  );
}

/** Displays one completed audit. */
function Results({ data }: { data: AuditData }) {
  return (
    <section className={styles.results}>
      <div className={styles.summary}>
        <h2 className={styles.resultsUrl}>{data.fetch.finalUrl}</h2>
        <p className={styles.checkedAt}>
          Checked {new Date(data.website.checkedAt).toLocaleString()}
        </p>
        {data.fetch.wasRedirected && (
          <p className={styles.checkedAt}>
            Redirected from {data.website.requestedUrl}
          </p>
        )}
        <dl className={styles.uptime}>
          <div>
            {/* "Responded" rather than "Online": the server answering is the
                fact we measured. A 404 site is answering, so it is not down. */}
            <dt>Server</dt>
            <dd>{data.uptime.isOnline ? "Responded" : "No response"}</dd>
          </div>
          <div>
            <dt>Status code</dt>
            <dd>{data.uptime.statusCode ?? "—"}</dd>
          </div>
          <div>
            {/* Deliberately not "response time" or "load time" — this measures
                only how quickly the server began replying, not how long the
                page took to load. */}
            <dt>Server response</dt>
            <dd>
              {data.uptime.serverResponseTimeMs === null
                ? "—"
                : `${data.uptime.serverResponseTimeMs} ms`}
            </dd>
          </div>
        </dl>
      </div>

      <MeasuredFacts data={data} />

      <h3 className={styles.findingsHeading}>
        Findings ({data.findings.length})
      </h3>
      {data.findings.length === 0 && (
        <p className={styles.emptyFindings}>
          The facts above are measured, but nothing has been graded yet. Step 6
          adds the rules that turn them into Critical / High / Medium findings.
        </p>
      )}
      <ul className={styles.findings}>
        {data.findings.map((finding) => (
          <li key={finding.id} className={styles.finding}>
            <span className={`${styles.badge} ${styles[finding.severity]}`}>
              {severityLabel(finding.severity)}
            </span>
            <div>
              <p className={styles.findingTitle}>{finding.title}</p>
              <p className={styles.evidence}>{finding.evidence}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The raw measured facts, shown as a plain table.
 *
 * This panel stays in the finished app on purpose. Once Claude writes the
 * report in Phase 5, a person needs to be able to check any sentence it wrote
 * against the measurement it came from — this is where they do that.
 *
 * All values here are rendered as plain text. Some (page title, description)
 * are copied from the audited website, and React escaping is what stops that
 * third-party content being treated as markup.
 */
function MeasuredFacts({ data }: { data: AuditData }) {
  const { seo, technical, fetch } = data;

  return (
    <section className={styles.facts}>
      <h3 className={styles.findingsHeading}>Measured facts</h3>
      <dl className={styles.factList}>
        <Fact
          label="Served over HTTPS"
          value={fetch.servedOverHttps ? "Yes" : "No"}
          note={
            fetch.httpsUnavailable
              ? "HTTPS could not be reached; the page was read over plain HTTP"
              : undefined
          }
        />
        {fetch.certificateProblem && (
          <Fact
            label="Certificate problem"
            value={certificateProblemLabel(fetch.certificateProblem)}
            note="Observed while connecting. A full certificate check is not implemented yet."
          />
        )}
        {fetch.wasRedirected && (
          <Fact
            label="Redirects"
            value={`${fetch.redirectChain.length - 1} followed`}
            note={fetch.redirectChain.join(" → ")}
          />
        )}
        <Fact
          label="Page title"
          value={seo.titleText ?? "— none —"}
          note={seo.titleText ? `${seo.titleLength} characters` : undefined}
        />
        <Fact
          label="Meta description"
          value={seo.metaDescriptionText ?? "— none —"}
          note={
            seo.metaDescriptionText ? `${seo.metaDescriptionLength} characters` : undefined
          }
        />
        <Fact
          label="Main heading (h1)"
          value={seo.h1Count === 0 ? "— none —" : seo.h1Texts.join(" · ")}
          note={`${seo.h1Count} found`}
        />
        <Fact
          label="Subheadings"
          value={`${seo.h2Count} h2 · ${seo.h3Count} h3`}
        />
        <Fact
          label="Heading order"
          value={seo.headingSkips.length === 0 ? "No skipped levels" : seo.headingSkips.join("; ")}
        />
        <Fact
          label="Images"
          value={`${seo.imageCount} total`}
          note={
            seo.imageCount === 0
              ? undefined
              : `${seo.imagesMissingAlt} missing alt text`
          }
        />
        <Fact label="Language" value={seo.langAttribute ?? "— not set —"} />
        <Fact label="Canonical URL" value={seo.canonicalUrl ?? "— not set —"} />
        <Fact label="Mobile viewport tag" value={seo.hasViewportMeta ? "Present" : "Missing"} />
        <Fact
          label="robots.txt"
          value={technical.robotsTxtFound ? "Found" : "Not found"}
          note={technical.robotsBlocksEverything ? "Blocks all crawlers" : undefined}
        />
        <Fact label="Sitemap" value={technical.sitemapUrl ?? "— not found —"} />
      </dl>

      <h3 className={styles.findingsHeading}>Security</h3>
      <dl className={styles.factList}>
        <Fact
          label="HTTPS protection (HSTS)"
          value={hstsSummary(data.security.hsts, data.security.strictTransportSecurity.present)}
          note={data.security.strictTransportSecurity.value ?? undefined}
        />
        <Fact
          label="Content-Security-Policy"
          value={cspSummary(data.security)}
          note={
            data.security.contentSecurityPolicy.value ??
            data.security.contentSecurityPolicyReportOnly.value ??
            undefined
          }
        />
        <Fact
          label="X-Frame-Options"
          value={data.security.xFrameOptions.value ?? "Missing"}
        />
        <Fact
          label="X-Content-Type-Options"
          value={data.security.xContentTypeOptions.value ?? "Missing"}
        />
        <Fact
          label="Referrer-Policy"
          value={data.security.referrerPolicy.value ?? "Missing"}
        />
        <Fact
          label="Permissions-Policy"
          value={data.security.permissionsPolicy.present ? "Present" : "Missing"}
          note={data.security.permissionsPolicy.value ?? undefined}
        />
        <Fact
          label="Cookies set by this page"
          value={cookieSummary(data.security.cookies)}
          note={
            data.security.cookies.cookies.length > 0
              ? data.security.cookies.cookies
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `${c.name}: ${c.secure ? "Secure" : "no Secure"}, ${
                        c.httpOnly ? "HttpOnly" : "no HttpOnly"
                      }, SameSite=${c.sameSite ?? "not set"}`,
                  )
                  .join("  ·  ")
              : undefined
          }
        />
        <Fact
          label="Insecure resources"
          value={mixedContentSummary(data.security.mixedContent)}
          note={
            data.security.mixedContent.items.length > 0
              ? data.security.mixedContent.items
                  .slice(0, 5)
                  .map((item) => `${item.element} (${item.via}): ${item.url}`)
                  .join("  ·  ")
              : undefined
          }
        />
        {/* Shown next to the count so it is never read as a whole-site
            all-clear. This scan reads the served markup and nothing more. */}
        {data.security.mixedContent.applicable && (
          <Fact
            label="Not checked by this scan"
            value={data.security.mixedContent.notInspected.join("  ·  ")}
          />
        )}
        <Fact
          label="Insecure form submission"
          value={
            data.security.insecureFormActions.length === 0
              ? "None found"
              : `${data.security.insecureFormActions.length} form${data.security.insecureFormActions.length === 1 ? "" : "s"} sends data over plain HTTP`
          }
          note={
            data.security.insecureFormActions.length > 0
              ? data.security.insecureFormActions.slice(0, 3).join("  ·  ")
              : undefined
          }
        />
        <Fact
          label="Server software announced"
          value={
            [data.security.serverHeader.value, data.security.poweredByHeader.value]
              .filter(Boolean)
              .join(" · ") || "— not announced —"
          }
        />
      </dl>
    </section>
  );
}

/** Turns the HSTS measurements into one readable line. */
function hstsSummary(hsts: AuditData["security"]["hsts"], headerPresent: boolean): string {
  if (!hsts.applicable) return "Not applicable — the page is not served over HTTPS";
  if (!headerPresent) return "No HSTS header sent";
  if (hsts.disabledByZeroMaxAge) return "Header present but switched off (max-age=0)";
  if (hsts.maxAgeSeconds === null) return "Header present, but its max-age could not be read";

  const days = Math.round(hsts.maxAgeSeconds / 86400);
  const extras = [
    hsts.includesSubdomains ? "includes subdomains" : null,
    hsts.preload ? "preload" : null,
  ].filter(Boolean);

  return `${days} day${days === 1 ? "" : "s"}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

/**
 * Describes the Content-Security-Policy situation in one line.
 *
 * A report-only policy is monitored but not enforced, so saying "Present"
 * for one would imply protection the site does not actually have.
 */
function cspSummary(security: AuditData["security"]): string {
  if (security.contentSecurityPolicy.present) return "Present";
  if (security.contentSecurityPolicyReportOnly.present) {
    return "Report-only — monitored but not enforced";
  }
  return "Missing";
}

/** Summarises the cookies, saying how many lack each protective flag. */
function cookieSummary(cookies: AuditData["security"]["cookies"]): string {
  if (cookies.total === 0) return "None set by this page";

  const missingSecure = cookies.cookies.filter((c) => !c.secure).length;
  const missingHttpOnly = cookies.cookies.filter((c) => !c.httpOnly).length;
  const missingSameSite = cookies.cookies.filter((c) => c.sameSite === null).length;

  const gaps = [
    missingSecure > 0 ? `${missingSecure} without Secure` : null,
    missingHttpOnly > 0 ? `${missingHttpOnly} without HttpOnly` : null,
    missingSameSite > 0 ? `${missingSameSite} without SameSite` : null,
  ].filter(Boolean);

  const plural = cookies.total === 1 ? "" : "s";
  return gaps.length === 0
    ? `${cookies.total} cookie${plural}, all flags set`
    : `${cookies.total} cookie${plural} — ${gaps.join(", ")}`;
}

/**
 * Turns the mixed-content measurements into one readable line.
 *
 * The wording says "in the page HTML" deliberately. We read the markup the
 * server sent; we do not run the page or download its stylesheets. A bare
 * "None found" would claim more than we checked.
 */
function mixedContentSummary(mixed: AuditData["security"]["mixedContent"]): string {
  if (!mixed.applicable) return "Not applicable — the page is not served over HTTPS";
  if (mixed.total === 0) return "None found in the page HTML";

  const blocking = mixed.activeCount > 0 ? `, ${mixed.activeCount} likely blocked by browsers` : "";
  return `${mixed.total} found in the page HTML, loaded over plain HTTP${blocking}`;
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className={styles.factNote}>{note}</span>}
      </dd>
    </div>
  );
}

function certificateProblemLabel(problem: CertificateProblem): string {
  switch (problem) {
    case "expired":
      return "The certificate has expired";
    case "self-signed":
      return "The certificate is self-signed, so browsers will not trust it";
    case "wrong-hostname":
      return "The certificate was issued for a different address";
    case "untrusted":
      return "The certificate could not be verified";
  }
}

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "good":
      return "Good";
  }
}
