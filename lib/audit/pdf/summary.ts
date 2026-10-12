/**
 * The severity split: how many problems, and how serious.
 *
 * MEASURED, AND KEPT APART FROM WHAT IS WRITTEN. These are numbers our own rules
 * produced. Prose about them, where a model wrote any, is a separate section
 * with its own label; 7A §9 requires the two never to be confused.
 *
 * PART OF THE EXECUTIVE SUMMARY, NOT A SECTION OF ITS OWN. The sentence and the
 * tiles are drawn there, on the report's first page, beside the grade they
 * explain. This file still decides what one of them looks like.
 *
 * FOUR NUMBERS, NOT A CHART. 7A §17 settled this: a severity split reads better
 * as four numbers than as a pie, and there are no charts in the first version.
 *
 * THE SPLIT IS COUNTED BY 7B AND PRINTED HERE. Nothing in this file adds,
 * compares or orders a severity. The counts arrive in the order the report
 * layer put them in, which is the order the screen uses.
 */
import type { PdfSeverityCount, PdfSummary } from "../pdfDocument.ts";
import { html } from "./escape.ts";

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
 * The whole section: the severity split, counted by 7B and printed here.
 *
 * THE AI ACCOUNT IS NO LONGER HERE. It has its own section, `aiSummaryHtml`
 * below, so the measured split and the written narrative are separated in the
 * document as well as in authority -- the split a reader can check against the
 * findings, the narrative labelled as the model's. That keeps this section
 * purely measured: four numbers our own rules produced.
 *
 * The clean-state sentence appears only when there is one. 7B leaves it empty
 * when findings exist, and it carries the distinction 7A §14 insists on: "no
 * issues found" and "no issues found, but some checks could not run" are
 * different sentences, and only one of them is good news.
 */
export function summaryHtml(summary: PdfSummary): string {
  return summaryLeadHtml(summary) + severityTilesHtml(summary);
}

/** The state sentence the report layer chose, or nothing when it chose none. */
export function summaryLeadHtml(summary: PdfSummary): string {
  return summary.stateSentence === "" ? "" : html`<p class="lead">${summary.stateSentence}</p>`;
}

/** The severity tiles in a row, or nothing at all when there are no counts. */
export function severityTilesHtml(summary: PdfSummary): string {
  return summary.severityCounts.length === 0
    ? ""
    : `<div class="tiles">` + summary.severityCounts.map(severityTile).join("") + `</div>`;
}
