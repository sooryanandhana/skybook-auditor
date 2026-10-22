/**
 * The dashboard's at-a-glance panels: shortcuts into the report, the audit's
 * progress, the highest-priority fixes, the AI commentary status and the latest audit's key
 * facts.
 *
 * PRESENTATION ONLY. Every value shown here is read from state the audit page
 * already holds -- the server's score, the server's graded findings, the job's
 * own status and the explanation the server returned. Nothing here grades,
 * counts toward a score, re-orders by anything but the severity the rules set,
 * or makes a request. Before an audit has run, each panel says so plainly
 * rather than showing placeholder figures.
 */
import type { MouseEvent } from "react";
import { categoryLabel, severityLabel } from "@/lib/report/measurementsView";
import type { Grade } from "@/lib/scoring/score";
import type { AuditExplanationResponse, Finding } from "@/lib/types";
import styles from "./page.module.css";

/** Where the current audit is, as the page already knows it. */
export type AuditPhase = "idle" | "queued" | "running" | "done" | "failed";

/** Worst first, ties broken on id -- the same order the findings section uses. */
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, good: 3 } as const;

/** How many fixes the priority panel lists before pointing to the full list. */
const PRIORITY_LIMIT = 5;

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const SUMMARY_ICON = (
  <svg {...ICON_PROPS}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 3 3 5-6" />
  </svg>
);

const FINDINGS_ICON = (
  <svg {...ICON_PROPS}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
  </svg>
);

const REPORT_ICON = (
  <svg {...ICON_PROPS}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6M8 13h8M8 17h5" />
  </svg>
);

const DOC_ICON = (
  <svg {...ICON_PROPS} width={16} height={16}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

/* ---------------------------------------------------------------------------
   Quick links
   --------------------------------------------------------------------------- */

/**
 * Where each shortcut goes. Every id is one the report already renders:
 * `overview` is the score dashboard (ScoreDashboard), `findings` opens the
 * findings section (FindingsSection), and `report-download-heading` heads the
 * client report card (ReportDownload).
 */
export const SHORTCUT_TARGETS = {
  summary: "overview",
  findings: "findings",
  report: "report-download-heading",
} as const;

/**
 * Follows a shortcut only if its section is really on the page. The cards are
 * links only when the page says the section exists; this is the belt to that
 * pair of braces, so a click can never land on nothing.
 */
function followIfPresent(event: MouseEvent<HTMLAnchorElement>, id: string) {
  if (document.getElementById(id) === null) event.preventDefault();
}

/**
 * Three shortcuts into the report, each describing what is there right now.
 *
 * A shortcut is a link only when the section it points at exists. Before an
 * audit -- or when that section was not produced -- it is a muted card saying
 * so, never a dead anchor.
 */
export function QuickLinks({
  grade,
  passRate,
  issueCount,
  hasResults,
  summaryReady,
  reportReady,
}: {
  grade: Grade | null;
  passRate: number | null;
  issueCount: number;
  hasResults: boolean;
  /** Whether the score dashboard rendered: results with a score attached. */
  summaryReady: boolean;
  /** Whether the client report card rendered. */
  reportReady: boolean;
}) {
  const cards = [
    {
      key: "summary",
      icon: SUMMARY_ICON,
      title: "Audit summary",
      target: SHORTCUT_TARGETS.summary,
      enabled: summaryReady,
      detail: !hasResults
        ? "Grade appears after an audit"
        : grade !== null && passRate !== null
          ? `Grade ${grade} · ${passRate}/100`
          : "Not graded",
    },
    {
      key: "findings",
      icon: FINDINGS_ICON,
      title: "Findings",
      target: SHORTCUT_TARGETS.findings,
      enabled: hasResults,
      detail: !hasResults
        ? "Issues appear after an audit"
        : issueCount === 0
          ? "No issues found"
          : `${issueCount} ${issueCount === 1 ? "issue" : "issues"} to review`,
    },
    {
      key: "report",
      icon: REPORT_ICON,
      title: "Client report",
      target: SHORTCUT_TARGETS.report,
      enabled: reportReady,
      detail: reportReady ? "PDF ready to download" : "Available after an audit",
    },
  ];

  return (
    <nav className={styles.quickLinks} aria-label="Report shortcuts">
      {cards.map((card) =>
        card.enabled ? (
          <a
            key={card.key}
            className={styles.quickCard}
            href={`#${card.target}`}
            onClick={(event) => followIfPresent(event, card.target)}
          >
            <span className={styles.quickIcon}>{card.icon}</span>
            <span className={styles.quickTitle}>{card.title}</span>
            <span className={styles.quickDetail}>{card.detail}</span>
          </a>
        ) : (
          <div key={card.key} className={`${styles.quickCard} ${styles.quickCardMuted}`} aria-disabled="true">
            <span className={styles.quickIcon}>{card.icon}</span>
            <span className={styles.quickTitle}>{card.title}</span>
            <span className={styles.quickDetail}>{card.detail}</span>
          </div>
        ),
      )}
    </nav>
  );
}

/* ---------------------------------------------------------------------------
   Audit progress
   --------------------------------------------------------------------------- */

type StepState = "done" | "active" | "failed" | "pending";

/**
 * The three stages of one audit, read from the job's own status.
 *
 * It describes where the page already is -- started, reading, finished or
 * stopped -- and invents no percentage: the live page counts stay in the
 * progress panel below it, exactly as before.
 */
export function AuditStepper({ phase, auditedUrl }: { phase: AuditPhase; auditedUrl: string | null }) {
  const steps: { label: string; state: StepState }[] = [
    { label: "Address entered", state: phase === "idle" ? "pending" : "done" },
    {
      label: phase === "queued" ? "Waiting for a slot" : "Reading the site",
      state:
        phase === "idle"
          ? "pending"
          : phase === "queued" || phase === "running"
            ? "active"
            : phase === "failed"
              ? "failed"
              : "done",
    },
    { label: "Report ready", state: phase === "done" ? "done" : "pending" },
  ];

  const doneCount = steps.filter((step) => step.state === "done").length;
  const caption =
    phase === "idle"
      ? "No audit has run in this session yet."
      : phase === "failed"
        ? "The audit stopped before a report could be made."
        : auditedUrl ?? "Audit in progress";

  return (
    <section className={styles.panelCard} aria-labelledby="audit-progress-heading">
      <h2 id="audit-progress-heading" className={styles.panelTitle}>
        Audit progress
      </h2>
      <p className={styles.panelCaption}>{caption}</p>
      <ol className={styles.stepper} style={{ ["--stepper-fill" as string]: `${(Math.max(doneCount - 1, 0) / 2) * 100}%` }}>
        {steps.map((step, index) => (
          <li key={step.label} className={`${styles.step} ${styles[`step_${step.state}`]}`}>
            <span className={styles.stepDot} aria-hidden="true">
              {step.state === "done" ? "✓" : step.state === "failed" ? "!" : index + 1}
            </span>
            <span className={styles.stepLabel}>{step.label}</span>
            <span className={styles.visuallyHidden}>
              {step.state === "done"
                ? " (done)"
                : step.state === "active"
                  ? " (in progress)"
                  : step.state === "failed"
                    ? " (stopped)"
                    : " (not started)"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------------------
   Priority fixes
   --------------------------------------------------------------------------- */

/**
 * The worst few findings, as the rules graded them, with a link to the rest.
 */
export function PriorityFixes({ findings, hasResults }: { findings: readonly Finding[]; hasResults: boolean }) {
  const problems = findings
    .filter((finding) => finding.severity !== "good")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));
  const shown = problems.slice(0, PRIORITY_LIMIT);

  return (
    <section className={styles.panelCard} aria-labelledby="priority-fixes-heading">
      <div className={styles.panelHead}>
        <h2 id="priority-fixes-heading" className={styles.panelTitle}>
          Priority fixes
        </h2>
        {problems.length > PRIORITY_LIMIT && (
          <a className={styles.panelLink} href="#results">
            View all {problems.length}
          </a>
        )}
      </div>

      {!hasResults ? (
        <p className={styles.panelEmpty}>Run an audit to see what to fix first.</p>
      ) : shown.length === 0 ? (
        <p className={styles.panelEmpty}>No issues were found on the pages that were read.</p>
      ) : (
        <ul className={styles.fixList}>
          {shown.map((finding) => (
            <li key={finding.id} className={styles.fixItem}>
              <span className={styles.fixBullet} aria-hidden="true" />
              <span className={styles.fixTitle}>{finding.title}</span>
              <span className={styles.fixTags}>
                <span className={styles.fixTag}>{categoryLabel(finding.category)}</span>
                <span className={`${styles.fixTag} ${styles[finding.severity]}`}>
                  {severityLabel(finding.severity)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   AI commentary
   --------------------------------------------------------------------------- */

/**
 * Where the AI-written commentary stands, with its overall summary once it is
 * written. The full commentary stays in the report below; this only shows
 * whether it is there.
 */
export function AiCommentaryCard({
  answer,
  running,
  hasResults,
}: {
  answer: AuditExplanationResponse | null;
  running: boolean;
  hasResults: boolean;
}) {
  const explained = answer !== null && answer.ok && answer.state === "explained";
  const summary = explained ? answer.executiveSummary.trim() : "";

  const status = !hasResults
    ? "Commentary is written once an audit finishes."
    : running
      ? "Writing commentary on the findings…"
      : explained && summary !== ""
        ? null
        : explained
          ? "Commentary was written for the findings below."
          : "No commentary is available for this audit. The report is complete without it.";

  return (
    <section className={styles.panelCard} aria-labelledby="ai-card-heading" aria-live="polite">
      <div className={styles.panelHead}>
        <h2 id="ai-card-heading" className={styles.panelTitle}>
          AI commentary
        </h2>
        {explained && hasResults && (
          <a className={styles.panelLink} href="#results">
            Read
          </a>
        )}
      </div>
      {status !== null ? (
        <p className={styles.panelEmpty}>{status}</p>
      ) : (
        <blockquote className={styles.aiBubble}>{summary}</blockquote>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   Latest audit
   --------------------------------------------------------------------------- */

/**
 * The current audit's identity and the server's own measurements of it, as
 * short rows. Values the audit did not produce are not shown.
 */
export function LatestAuditCard({
  url,
  checkedAt,
  statusCode,
  serverResponseMs,
  pagesRead,
}: {
  url: string | null;
  checkedAt: string | null;
  statusCode: number | null;
  serverResponseMs: number | null;
  pagesRead: number | null;
}) {
  const rows: { label: string; value: string }[] = [];
  if (checkedAt !== null) rows.push({ label: "Checked", value: new Date(checkedAt).toLocaleString() });
  if (statusCode !== null) rows.push({ label: "Status code", value: String(statusCode) });
  if (serverResponseMs !== null) rows.push({ label: "Server response", value: `${serverResponseMs} ms` });
  if (pagesRead !== null) rows.push({ label: "Pages read", value: String(pagesRead) });

  return (
    <section className={styles.panelCard} aria-labelledby="latest-audit-heading">
      <h2 id="latest-audit-heading" className={styles.panelTitle}>
        Latest audit
      </h2>
      {url === null ? (
        <p className={styles.panelEmpty}>Results from this session appear here.</p>
      ) : (
        <>
          <p className={styles.docRow}>
            <span className={styles.docIcon}>{DOC_ICON}</span>
            <span className={styles.docName}>{url}</span>
          </p>
          {rows.length > 0 && (
            <dl className={styles.factRows}>
              {rows.map((row) => (
                <div key={row.label} className={styles.factRow}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
