"use client";
// ^ This tells Next.js the file runs in the BROWSER, not on the server.
//   We need that because this page has a button, a text box, and remembers
//   things (state) — all of which are browser-side behaviour.

import { useState } from "react";
import type { AuditData, AuditResponse, Severity, UptimeCheck } from "@/lib/types";
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
        Steps 1–2 of 6 are live: the page is fetched and its SEO checked.
        Security, SSL/DNS, speed and the severity rules are still to come.
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
        <h2 className={styles.resultsUrl}>{data.url}</h2>
        <p className={styles.checkedAt}>
          Checked {new Date(data.checkedAt).toLocaleString()}
        </p>
        <dl className={styles.uptime}>
          <div>
            <dt>Status</dt>
            <dd>{data.uptime.isOnline ? "Online" : "Offline"}</dd>
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
  const { seo, technical } = data;

  return (
    <section className={styles.facts}>
      <h3 className={styles.findingsHeading}>Measured facts</h3>
      <dl className={styles.factList}>
        <Fact label="Served over HTTPS" value={data.servedOverHttps ? "Yes" : "No"} />
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
    </section>
  );
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
