/**
 * The client-facing AI summary, in the PDF, as five plain-English parts.
 *
 * ONE VALIDATED ANSWER, RESHAPED -- NEVER A SECOND MODEL CALL. Everything here
 * comes from `buildClientAiSummary`, which the report layer built once from the
 * validated explanations and the measured findings (7A §9). The renderer decides
 * nothing: it lays out the sections it is handed and escapes every string.
 *
 * ABSENT AI IS NORMAL AND IS NOT A FAILURE. When the model produced no usable
 * answer, this section is omitted entirely -- the measured coverage and findings
 * sections carry the report on their own -- so a reader never meets an empty
 * panel or an apology for a missing paragraph.
 *
 * WHAT IS AI-WRITTEN AND WHAT IS DERIVED is settled upstream: the overall
 * summary, key findings and recommendations are the model's validated prose; the
 * "What we checked" and "Next steps" lists are derived from the measured
 * findings. The provenance label rides with the panel so a reader is never in
 * doubt which is which.
 */
import type { ClientAiSummary, PdfLabels } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** The section's client-facing title. A structural label, so it lives here. */
const CLIENT_SUMMARY_HEADING = "AI summary";
const WHAT_WE_CHECKED_HEADING = "What we checked";
const KEY_FINDINGS_HEADING = "Key findings";
const RECOMMENDED_HEADING = "Recommended improvements";
const NEXT_STEPS_HEADING = "Next steps";

/**
 * The whole section, or an empty string when the model produced nothing usable.
 *
 * `note` is the provenance sentence and any honesty notes (dropped entries,
 * coverage), built by the caller from the same validated answer; it is shown
 * only when the section is.
 */
export function clientSummaryHtml(summary: ClientAiSummary, labels: PdfLabels, note: string): string {
  // With no model narrative, the measured sections stand alone. Nothing drawn.
  if (summary.overallSummary === null && summary.keyFindings.length === 0) return "";

  const overall =
    summary.overallSummary === null ? "" : html`<p class="client-ai-summary">${summary.overallSummary}</p>`;

  const checked =
    summary.whatWeChecked.length === 0
      ? ""
      : `<p class="client-ai-subhead">${WHAT_WE_CHECKED_HEADING}</p>` +
        `<ul class="client-ai-list">` +
        summary.whatWeChecked.map((line) => html`<li>${line}</li>`).join("") +
        `</ul>`;

  const found =
    summary.keyFindings.length === 0
      ? ""
      : `<p class="client-ai-subhead">${KEY_FINDINGS_HEADING}</p>` +
        summary.keyFindings
          .map(
            (item) =>
              `<div class="client-ai-item">` +
              html`<p class="client-ai-item-title">${item.finding}</p>` +
              html`<p class="client-ai-item-text">${item.explanation}</p>` +
              html`<p class="client-ai-item-impact">${item.impact}</p>` +
              `</div>`,
          )
          .join("");

  const improve =
    summary.recommendations.length === 0
      ? ""
      : `<p class="client-ai-subhead">${RECOMMENDED_HEADING}</p>` +
        summary.recommendations
          .map(
            (item) =>
              `<div class="client-ai-item">` +
              html`<p class="client-ai-item-title">${item.action}</p>` +
              html`<p class="client-ai-item-text">${item.reason}</p>` +
              `</div>`,
          )
          .join("");

  const steps =
    summary.nextSteps.length === 0
      ? ""
      : `<p class="client-ai-subhead">${NEXT_STEPS_HEADING}</p>` +
        `<ol class="client-ai-steps">` +
        summary.nextSteps.map((step) => html`<li>${step}</li>`).join("") +
        `</ol>`;

  const noteHtml = note === "" ? "" : html`<p class="ai-note">${note}</p>`;

  return (
    `<section class="ai-section">` +
    `<h2>${CLIENT_SUMMARY_HEADING}</h2>` +
    `<div class="client-ai">` +
    html`<p class="ai-label">${labels.aiSummaryHeading}</p>` +
    overall +
    checked +
    found +
    improve +
    steps +
    noteHtml +
    `</div>` +
    `</section>`
  );
}
