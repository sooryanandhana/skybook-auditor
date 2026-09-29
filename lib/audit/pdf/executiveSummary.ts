/**
 * The executive summary: the measured verdict, at a glance, on the opening page.
 *
 * MEASURED, NOT WRITTEN. Every value here is read from the deterministic score
 * and the coverage the crawl counted -- the grade, the pass rate, how much of
 * the site was assessed, how much was read. Nothing is calculated, graded or
 * phrased here; the model's account of the audit is a separate section further
 * down, labelled as its own. This is the "measure with code" half of the report
 * opening the document, before the "explain with AI" half.
 *
 * SCOPE IS STATED UP FRONT. The coverage headline sits in this panel so a reader
 * meets how much of the site was seen before any verdict, and the partial and
 * cap notes are said out loud rather than hidden, exactly as the score section
 * says them. A partial crawl is never presented here as a whole-site audit.
 *
 * WORD BEFORE COLOUR. The grade is a letter and a band word; on the dark panel
 * it is set in white rather than tinted, because the severity greens and reds
 * are chosen for white paper and the meaning is already carried in words.
 */
import type { PdfScore } from "../pdfDocument.ts";
import { html } from "./escape.ts";

const EXEC_HEADING = "Executive summary";

/** One labelled statistic in the panel. */
function stat(label: string, value: string): string {
  return (
    `<div class="exec-stat">` +
    html`<span class="exec-stat-label">${label}</span>` +
    html`<span class="exec-stat-value">${value}</span>` +
    `</div>`
  );
}

/**
 * The whole section.
 *
 * The grade leads: a letter with its band word, or a plain "Not graded" with the
 * score's own reason when the audit assessed too little to grade honestly. The
 * pass rate and the two coverage figures sit beside it. The caveats follow on
 * the light ground below the panel, never inside it.
 */
export function executiveSummaryHtml(score: PdfScore, coverageHeadline: string): string {
  const grade =
    score.grade !== null
      ? html`<span class="exec-grade">${score.grade}</span>` +
        (score.bandLabel === null ? "" : html`<span class="exec-band">${score.bandLabel}</span>`)
      : `<span class="exec-grade exec-grade-none">Not graded</span>`;

  const passed =
    score.passRate === null
      ? ""
      : stat("Weighted checks passed", `${score.passRate} / 100`);

  const stats =
    passed +
    stat("Applicable checks assessed", `${score.coveragePercent}%`) +
    stat("Site coverage", coverageHeadline);

  const status =
    score.statusMessage === null ? "" : html`<p class="exec-note">${score.statusMessage}</p>`;
  const partial =
    score.partialNote === null ? "" : html`<p class="exec-note">${score.partialNote}</p>`;
  const cap = score.capNote === null ? "" : html`<p class="exec-note">${score.capNote}</p>`;

  return (
    `<section class="exec">` +
    `<h2>${EXEC_HEADING}</h2>` +
    `<div class="exec-panel">` +
    `<div class="exec-grade-col">${grade}</div>` +
    `<div class="exec-stats">${stats}</div>` +
    `</div>` +
    status +
    partial +
    cap +
    `</section>`
  );
}
