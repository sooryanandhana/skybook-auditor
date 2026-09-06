"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

/**
 * What the page shows while an audit is running.
 *
 * WHAT THIS COMPONENT MAY AND MAY NOT SAY
 *
 * The audit is one HTTP request. The browser sends it, waits, and receives
 * everything at once — so it does NOT know when the SEO checks finished, or
 * whether the certificate has been read yet. Ticking those stages off one by
 * one while waiting would look convincing and be invented.
 *
 * So the list below describes what the audit COVERS, and stays neutral until
 * real results arrive. Only two things here are actually known:
 *
 *   1. how long we have been waiting     (measured)
 *   2. that the request has not returned (self-evident)
 *
 * The speed check is no longer part of this. It is its own request now, and
 * its waiting state lives in PerformancePanel underneath the finished audit.
 */

/** When the reassurance changes. Real elapsed time, not a guess at progress. */
const TAKING_LONGER_MS = 30_000;

/** What the audit looks at. Order matches the way the report is laid out. */
const CORE_STAGES = [
  { id: "fetch", label: "Reading the page" },
  { id: "seo", label: "SEO and content" },
  { id: "security", label: "Security headers" },
  { id: "technical", label: "Robots.txt and sitemap" },
  { id: "site", label: "Certificate and DNS" },
] as const;

export function AuditProgress() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor(elapsedMs / 1000);

  return (
    <section className={styles.progress} aria-label="Audit in progress">
      <div className={styles.progressPhase}>
        <div className={styles.phaseHead}>
          <Spinner />
          <div>
            <h2 className={styles.phaseTitle}>Running website audit</h2>
            <p className={styles.phaseText}>Checking your website…</p>
          </div>
        </div>

        {/*
          A plain list of what is covered. Every item reads "Waiting" in text as
          well as icon, so the state does not depend on colour or animation.
        */}
        <ol className={styles.stageList}>
          {CORE_STAGES.map((stage) => (
            <li key={stage.id} className={styles.stage}>
              <span className={styles.stageIcon} aria-hidden="true">
                ○
              </span>
              <span className={styles.stageLabel}>{stage.label}</span>
              <span className={styles.stageState}>Waiting</span>
            </li>
          ))}
        </ol>
      </div>

      {/*
        One live region, announced politely. It carries the elapsed time so the
        wait is legible without watching a spinner.
      */}
      <p className={styles.progressStatus} role="status" aria-live="polite">
        {waitingMessage(elapsedMs)}{" "}
        <span className={styles.elapsed}>
          {seconds} second{seconds === 1 ? "" : "s"} elapsed
        </span>
      </p>
    </section>
  );
}

/**
 * Reassurance that stays true however long the wait runs.
 *
 * Note what is NOT here: any claim about what Google is doing right now. From
 * the browser's side a slow reply and a lost one look identical, so these say
 * only that we are still waiting and why that can be normal.
 */
export function waitingMessage(elapsedMs: number): string {
  return elapsedMs >= TAKING_LONGER_MS
    ? "This is taking longer than usual. The audit is still running."
    : "Running the checks.";
}

/**
 * The one moving thing on the page.
 *
 * Marked aria-hidden because it carries no information a screen reader needs —
 * the live region above says the same in words. Its animation is switched off
 * entirely under prefers-reduced-motion; the CSS keeps a static ring so the
 * active stage is still marked out.
 */
function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}
