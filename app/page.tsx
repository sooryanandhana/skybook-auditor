"use client";
// ^ This tells Next.js the file runs in the BROWSER, not on the server.
//   We need that because this page has a button, a text box, and remembers
//   things (state) — all of which are browser-side behaviour.

import { useState } from "react";
import type { AuditData, AuditResponse, Severity } from "@/lib/types";
import styles from "./page.module.css";

export default function HomePage() {
  // Three pieces of "state" — values the page remembers and re-renders when changed.
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AuditData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault(); // stop the browser reloading the page

    setIsLoading(true);
    setError(null);
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
        Step 1 of 6: the page is really fetched. SEO, security, SSL/DNS and speed
        checks are still to come.
      </p>

      {error && <p className={styles.error}>{error}</p>}

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
            <dt>Response time</dt>
            <dd>
              {data.uptime.responseTimeMs === null
                ? "—"
                : `${data.uptime.responseTimeMs} ms`}
            </dd>
          </div>
        </dl>
      </div>

      <h3 className={styles.findingsHeading}>
        Findings ({data.findings.length})
      </h3>
      {data.findings.length === 0 && (
        <p className={styles.emptyFindings}>
          No checks have run yet — they arrive in steps 2 to 6.
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
