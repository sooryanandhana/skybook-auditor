"use client";

import { useEffect, useState } from "react";
import type { FieldPerformance, LabPerformance, PerformanceData } from "@/lib/types";
import {
  METRIC_NOT_REPORTED,
  SPEED_FIELD_HEADING,
  SPEED_LAB_HEADING,
  SPEED_NOT_INSPECTED_HEADING,
  fieldOverallText,
  fieldShiftText,
  labShiftText,
  metricDurationText,
  ratingLabel,
  strategyLabel,
} from "@/lib/report/measurementsView";
import styles from "./page.module.css";

/**
 * The speed section of a finished audit.
 *
 * TWO THINGS THIS MUST NEVER DO:
 *
 * 1. Make a failed speed check look like a failed audit. The other checks are
 *    unaffected by Google having a bad minute, and a report that reads as
 *    broken loses a sale over a problem the client does not have.
 *
 * 2. Let a missing measurement read as a bad one. "No real-visitor data" means
 *    too few visitors for Google to report on — it is the normal case for a
 *    small business, and it says nothing at all about speed.
 *
 * Everything shown here comes from the audit response. No wording is chosen by
 * this component beyond labelling; the reasons come from the server.
 */
export function PerformancePanel({
  performance,
  running,
}: {
  performance: PerformanceData;
  running: boolean;
}) {
  /*
   * The speed check is its own request now, so this is a real waiting state
   * sitting under a finished, readable audit. Nothing above it is blocked.
   *
   * "pending" is checked too: that is what the audit itself reports when speed
   * was requested, and it covers the instant before the second request starts.
   */
  if (running || performance.status === "pending") {
    return <PerformanceRunning />;
  }

  if (performance.status === "not-requested") {
    return (
      <section className={styles.perfPanel}>
        <h3 className={styles.findingsHeading}>Performance</h3>
        <p className={styles.perfMuted}>{performance.message}</p>
      </section>
    );
  }

  if (performance.status !== "checked") {
    return (
      <section className={`${styles.perfPanel} ${styles.perfUnavailable}`}>
        <h3 className={styles.findingsHeading}>Performance analysis unavailable</h3>
        {/*
          The server's own explanation, verbatim. It already distinguishes a
          timeout from a refused key from an error at Google's end, and
          rewording it here could only make it less accurate.
        */}
        <p className={styles.perfReason}>{performance.message}</p>
        <p className={styles.perfMuted}>
          The rest of your audit completed normally and is shown above. This does
          not mean the website is slow — the speed test simply did not return a
          result.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.perfPanel}>
      <h3 className={styles.findingsHeading}>Performance</h3>
      <p className={styles.perfSummary}>{performance.message}</p>

      <div className={styles.perfSplit}>
        <FieldBlock field={performance.field} />
        <LabBlock lab={performance.lab} strategy={performance.strategy} />
      </div>

      {performance.notInspected.length > 0 && (
        <details className={styles.perfNotes}>
          <summary>{SPEED_NOT_INSPECTED_HEADING} ({performance.notInspected.length})</summary>
          <ul>
            {performance.notInspected.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** What real visitors experienced. This is what Google ranks on. */
function FieldBlock({ field }: { field: FieldPerformance }) {
  const overall = fieldOverallText(field);

  return (
    <div className={styles.perfBlock}>
      <h4 className={styles.perfBlockTitle}>{SPEED_FIELD_HEADING}</h4>

      {field.status === "absent" && (
        <p className={styles.perfMuted}>
          Google has too few recent visits to this address to report on. That is
          normal for a smaller site and says nothing about how fast it is.
        </p>
      )}

      {field.status === "error" && (
        <p className={styles.perfMuted}>{field.error}</p>
      )}

      {field.status === "found" && (
        <>
          {/* Origin data covers a whole site. Saying so here is the difference
              between a true statement and a claim about one page. */}
          <p className={styles.perfScope}>
            {field.scope === "origin"
              ? "Site-wide figures — not specific to this page"
              : "Figures for this page"}
            {field.measuredUrl && <> · {field.measuredUrl}</>}
          </p>
          {/*
            GOOGLE'S OWN VERDICT, repeated rather than worked out.

            It is not derived from the metrics below it and never from the
            simulated score in the next block — those answer different
            questions, and a site can be rated fast by its real visitors while
            a throttled simulation scores it badly.

            Absent when Google gave no overall category, which happens even
            alongside individual metrics. Nothing is shown rather than a
            category being inferred from the parts.
          */}
          {overall !== null && (
            <p className={styles.perfOverall}>
              Overall experience: <strong>{overall}</strong>
            </p>
          )}
          <dl className={styles.perfMetrics}>
            {/*
              missing={METRIC_NOT_REPORTED} rather than a bare dash: a reader cannot
              tell an unreported metric from a good one, and "Not reported"
              says which it is without implying the site failed anything.
            */}
            <Metric
              label="LCP"
              value={metricDurationText(field.lcp?.percentileMs)}
              rating={field.lcp?.category}
              missing={METRIC_NOT_REPORTED}
            />
            <Metric
              label="INP"
              value={metricDurationText(field.inp?.percentileMs)}
              rating={field.inp?.category}
              missing={METRIC_NOT_REPORTED}
            />
            <Metric
              label="CLS"
              value={fieldShiftText(field.cls)}
              rating={field.cls?.category}
              missing={METRIC_NOT_REPORTED}
            />
            <Metric
              label="FCP"
              value={metricDurationText(field.fcp?.percentileMs)}
              rating={field.fcp?.category}
              missing={METRIC_NOT_REPORTED}
            />
            <Metric
              label="TTFB"
              value={metricDurationText(field.ttfb?.percentileMs)}
              rating={field.ttfb?.category}
              missing={METRIC_NOT_REPORTED}
            />
          </dl>
        </>
      )}
    </div>
  );
}

/** One simulated load. Useful for diagnosis; nobody experienced it. */
function LabBlock({ lab, strategy }: { lab: LabPerformance; strategy: PerformanceData["strategy"] }) {
  /*
   * WHICH DEVICE WAS SIMULATED, read from the data rather than assumed.
   *
   * This line used to end with the word "mobile", typed in. A score shown
   * without it is one a client reasonably reads as describing their desktop
   * site, and a hardcoded label would go on saying mobile if the collector
   * ever ran another way.
   */
  const device = strategyLabel(strategy);

  return (
    <div className={styles.perfBlock}>
      <h4 className={styles.perfBlockTitle}>{SPEED_LAB_HEADING}</h4>

      {lab.status === "error" ? (
        <p className={styles.perfMuted}>{lab.error}</p>
      ) : (
        <>
          <p className={styles.perfScope}>
            Google&rsquo;s test browser
            {device && <> · {device}</>}
            {lab.measuredUrl && <> · {lab.measuredUrl}</>}
          </p>
          {lab.score !== null && (
            <p className={styles.perfScore}>
              {lab.score}
              <span className={styles.perfScoreOutOf}> / 100</span>
            </p>
          )}
          <dl className={styles.perfMetrics}>
            <Metric label="LCP" value={metricDurationText(lab.lcpMs)} />
            <Metric label="FCP" value={metricDurationText(lab.fcpMs)} />
            <Metric label="TBT" value={metricDurationText(lab.tbtMs)} />
            <Metric label="Speed Index" value={metricDurationText(lab.speedIndexMs)} />
            <Metric label="CLS" value={labShiftText(lab.cls)} />
          </dl>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  rating,
  missing = "—",
}: {
  label: string;
  value: string | null;
  rating?: "FAST" | "AVERAGE" | "SLOW";
  /** Shown instead of the value when there is none. Never a zero. */
  missing?: string;
}) {
  const absent = value === null;
  return (
    <div className={styles.perfMetric}>
      <dt>{label}</dt>
      <dd>
        {/* Never a zero: a metric we did not receive is not a metric that
            measured nothing. */}
        <span className={absent ? styles.perfNotReported : undefined}>
          {value ?? missing}
        </span>
        {rating && <span className={styles.perfRating}> {ratingLabel(rating)}</span>}
      </dd>
    </div>
  );
}

/**
 * Shown while Google is being asked, under a finished audit.
 *
 * The messages below are built only from elapsed time, which the browser
 * genuinely knows. None of them claims anything about what Google is doing:
 * from here a slow reply and a lost one look identical.
 */
function PerformanceRunning() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor(elapsedMs / 1000);

  return (
    <section className={styles.perfPanel} aria-label="Performance analysis">
      <div className={styles.phaseHead}>
        <span className={styles.spinner} aria-hidden="true" />
        <div>
          <h3 className={styles.perfRunningTitle}>Performance analysis in progress</h3>
          <p className={styles.phaseText}>
            Google PageSpeed Insights is analysing your website. This can take up to
            90 seconds — you can carry on reading your audit while it finishes.
          </p>
        </div>
      </div>

      <p className={styles.progressStatus} role="status" aria-live="polite">
        {performanceWaitingMessage(elapsedMs)}{" "}
        <span className={styles.elapsed}>
          {seconds} second{seconds === 1 ? "" : "s"} elapsed
        </span>
      </p>
    </section>
  );
}

/** Reassurance that stays true however long the wait runs. */
export function performanceWaitingMessage(elapsedMs: number): string {
  if (elapsedMs >= 30_000) {
    return "Performance analysis is taking longer than usual. The result has not come back yet.";
  }
  if (elapsedMs >= 10_000) {
    return "Performance analysis is taking a little longer than the other checks.";
  }
  return "Waiting for the performance result.";
}
