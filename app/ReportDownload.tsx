"use client";

import { useState } from "react";
import {
  CLIENT_DETAILS_HINT,
  CLIENT_DETAILS_LABEL,
  CLIENT_FIELDS,
  EXPORT_READY,
  REPORT_HEADING,
  REPORT_INTRO,
  downloadButton,
  downloadedNote,
  runExport,
  type ExportState,
  type PdfClientFields,
} from "@/lib/report/pdfExport";
import { ReportSend } from "./ReportSend";
import styles from "./page.module.css";

/**
 * The button that turns a finished audit into a document.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. It holds two pieces of state and
 * renders them. Which sentence a refusal produces, what the file is called,
 * whether a second click may start a second request — all of that is in
 * lib/report/pdfExport.ts, where a test can reach it without a browser. This
 * file is the markup and the boxes.
 *
 * IT IS ONLY RENDERED WHEN THERE IS SOMETHING TO EXPORT. An audit that is
 * still running or that failed has no result on screen, so this is absent
 * rather than disabled — see `exportableJobId`. That is the reason there is no
 * "the audit is not finished yet" state in here: it would be unreachable.
 *
 * IT STARTS NOTHING BUT THIS. One request, to one endpoint, carrying a job id
 * that already exists. It does not touch the polling loop, ask for a speed
 * check, or go anywhere near a model — and it cannot, because the only thing
 * it imports is the one function that sends that one request.
 */
export function ReportDownload({ jobId, auditedUrl }: { jobId: string; auditedUrl: string }) {
  /** What the salesperson has typed. Empty until they open the details. */
  const [fields, setFields] = useState<PdfClientFields>({});
  const [state, setState] = useState<ExportState>(EXPORT_READY);

  const button = downloadButton(state);

  return (
    <section className={styles.export} aria-labelledby="report-download-heading">
      {/* A section eyebrow, matching the dashboard's card labels. Presentation
          only — it names the section, it is not data or a claim. */}
      <p className={styles.exportEyebrow}>Report &amp; delivery</p>
      {/*
        An h3, like every other section inside the results. The single h2 there
        is the audited address — the results' own title — and a second one at
        that level would read to a screen reader as a second report.
      */}
      <h3 id="report-download-heading" className={styles.exportHeading}>
        {REPORT_HEADING}
      </h3>
      <p className={styles.exportIntro}>{REPORT_INTRO}</p>

      {/*
        Folded away, because the report is correct without any of it and the
        common case is a salesperson who wants the file. Opening it is one
        click; typing into a form nobody needed would be three empty boxes on
        every audit.
      */}
      <details className={styles.exportDetails}>
        <summary className={styles.exportSummary}>{CLIENT_DETAILS_LABEL}</summary>
        <p className={styles.exportHint}>{CLIENT_DETAILS_HINT}</p>
        <div className={styles.exportFields}>
          {CLIENT_FIELDS.map(({ key, label }) => (
            <label key={key} className={styles.exportField}>
              <span className={styles.exportLabel}>{label}</span>
              <input
                className={styles.exportInput}
                type="text"
                value={fields[key] ?? ""}
                onChange={(event) =>
                  setFields((current) => ({ ...current, [key]: event.target.value }))
                }
                disabled={button.disabled}
              />
            </label>
          ))}
        </div>
      </details>

      <div className={styles.pdfRow}>
        <span className={styles.pdfLabel}>PDF report</span>
        <div className={styles.exportAction}>
          <button
            className={styles.button}
            type="button"
            onClick={() => void runExport(state, jobId, fields, setState)}
            disabled={button.disabled}
            aria-busy={button.disabled}
          >
            {button.label}
          </button>
        </div>
      </div>

      {/*
        Announced, not merely shown. A file arriving is the one thing on this
        page that can happen entirely off screen — in a browser that saves
        without asking, the only evidence is this line.
      */}
      {state.kind === "done" && (
        <p className={styles.exportDone} role="status">
          {downloadedNote(state.filename)}
        </p>
      )}

      {/*
        The server's own sentence, unchanged. It was written for a person and
        it already guarantees that nothing internal is in it.
      */}
      {state.kind === "failed" && (
        <p className={styles.exportProblem} role="alert">
          {state.message}
        </p>
      )}

      {/*
        Under the download, because that is the order the work happens in: the
        report is produced, a person reads it, and only then is there anything
        to agree to. It is handed the same client details the report carries so
        the preview cannot describe a different document.
      */}
      <ReportSend
        jobId={jobId}
        auditedUrl={auditedUrl}
        companyName={fields.companyName}
        contactName={fields.contactName}
        preparedBy={fields.preparedBy}
      />
    </section>
  );
}
