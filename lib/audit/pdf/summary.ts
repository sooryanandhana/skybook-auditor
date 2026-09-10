/**
 * The summary: how many problems, how serious, and the AI's account of them.
 *
 * TWO THINGS THAT MUST NOT BE CONFUSED, on one page. The severity split is
 * measured: four numbers our own rules produced. The executive summary is
 * written: prose about those numbers. 7A §9 requires the second to be labelled
 * as AI-written and to sit visually subordinate to the first, so a reader can
 * always tell which is which.
 *
 * FOUR NUMBERS, NOT A CHART. 7A §17 settled this: a severity split reads better
 * as four numbers than as a pie, and there are no charts in the first version.
 *
 * THE SPLIT IS COUNTED BY 7B AND PRINTED HERE. Nothing in this file adds,
 * compares or orders a severity. The counts arrive in the order the report
 * layer put them in, which is the order the screen uses.
 */
import type { PdfLabels, PdfSeverityCount, PdfSummary } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** The section's title. See the note in `coverage.ts` on why it lives here. */
const SUMMARY_HEADING = "Summary";

/**
 * One severity, as a number and a word.
 *
 * THE WORD IS NOT OPTIONAL. 7A §8 and §24 both require it: colour alone never
 * carries severity, because the document has to survive being printed in
 * greyscale and read by somebody who does not distinguish these hues. The
 * colour is an accent on a tile whose meaning is already in words.
 */
function severityTile(count: PdfSeverityCount): string {
  return (
    html`<div class="tile tile-${count.severity}">` +
    html`<span class="tile-count">${count.count}</span>` +
    html`<span class="tile-label">${count.label}</span>` +
    `</div>`
  );
}

/**
 * The AI panel, or nothing at all.
 *
 * ABSENT IS NORMAL AND IS NEVER A FAILURE. 7A §9 and §19: with no commentary
 * the summary shows the severity split alone. There is no apology, no empty
 * panel and no note about the model, because a report without commentary is a
 * complete report, and saying otherwise would invite a reader to think
 * something went wrong with their audit.
 */
function aiPanel(summary: PdfSummary, labels: PdfLabels): string {
  const ai = summary.ai;
  if (ai === null) return "";

  /*
   * The dropped-entry sentence, when the validator refused part of the answer.
   * Said out loud rather than hidden: a reader who counts the findings and
   * counts the explanations should find the difference already accounted for.
   * Nothing is invented to fill the gap.
   */
  const note = [labels.aiProvenance, ai.rejectedNote, ai.coverageNote]
    .filter((sentence) => sentence !== null && sentence !== "")
    .join(" ");

  return (
    `<div class="ai">` +
    html`<p class="ai-label">${labels.aiSummaryHeading}</p>` +
    html`<p class="ai-summary">${ai.executiveSummary}</p>` +
    html`<p class="ai-note">${note}</p>` +
    `</div>`
  );
}

/**
 * The whole section.
 *
 * The clean-state sentence appears only when there is one. 7B leaves it empty
 * when findings exist, and it carries the distinction 7A §14 insists on: "no
 * issues found" and "no issues found, but some checks could not run" are
 * different sentences, and only one of them is good news.
 */
export function summaryHtml(summary: PdfSummary, labels: PdfLabels): string {
  const state =
    summary.stateSentence === "" ? "" : html`<p class="lead">${summary.stateSentence}</p>`;

  const tiles =
    summary.severityCounts.length === 0
      ? ""
      : `<div class="tiles">` + summary.severityCounts.map(severityTile).join("") + `</div>`;

  return (
    `<section class="summary">` +
    `<h2>${SUMMARY_HEADING}</h2>` +
    state +
    tiles +
    aiPanel(summary, labels) +
    `</section>`
  );
}
