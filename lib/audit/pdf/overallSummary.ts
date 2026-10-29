/**
 * The overall summary, as markup.
 *
 * EVERY VALUE IS ESCAPED. The summary quotes measured values -- an address, a
 * name server, a certificate name -- that came from the audited website, so all
 * of it goes through `html`, exactly like every other document value.
 *
 * IT DECIDES NOTHING. The wording, the statuses and the order were settled by
 * `lib/report/overallSummary.ts`; this lays them out. An empty list draws no
 * heading, so a section never appears with nothing under it.
 */
import type { OverallSummary, SummaryArea } from "../pdfDocument.ts";
import { html } from "./escape.ts";

export const OVERALL_SUMMARY_HEADING = "Overall summary";

function paragraphs(lines: readonly string[]): string {
  return lines.map((line) => html`<p>${line}</p>`).join("");
}

function list(heading: string, items: readonly string[], className: string): string {
  if (items.length === 0) return "";
  return (
    `<div class="summary-block ${className}">` +
    html`<h3>${heading}</h3>` +
    `<ul>` +
    items.map((item) => html`<li>${item}</li>`).join("") +
    `</ul>` +
    `</div>`
  );
}

function areaHtml(area: SummaryArea): string {
  return (
    html`<div class="summary-area summary-area-${area.status}">` +
    `<div class="summary-area-head">` +
    html`<h3>${area.heading}</h3>` +
    html`<span class="area-status area-status-${area.status}">${area.statusLabel}</span>` +
    `</div>` +
    paragraphs(area.paragraphs) +
    `</div>`
  );
}

function prioritiesHtml(summary: OverallSummary): string {
  if (summary.priorities.length === 0) return "";
  return (
    `<div class="summary-block summary-priorities">` +
    `<h3>Most important issues to address first</h3>` +
    `<ol>` +
    summary.priorities
      .map(
        (item) =>
          `<li>` +
          html`<p class="priority-title">${item.title}</p>` +
          html`<p class="priority-meta">${item.severityLabel} · ${item.reach}</p>` +
          html`<p>${item.whyItMatters}</p>` +
          (item.whoFixes === null ? "" : html`<p class="priority-who">Who should fix it: ${item.whoFixes}</p>`) +
          `</li>`,
      )
      .join("") +
    `</ol>` +
    `</div>`
  );
}

function helpHtml(summary: OverallSummary): string {
  const help = summary.help;
  return (
    `<div class="summary-block summary-help">` +
    `<h3>How Skybook can help</h3>` +
    html`<p>${help.intro}</p>` +
    `<ul>` +
    help.items.map((item) => html`<li>${item}</li>`).join("") +
    `</ul>` +
    html`<p>${help.closing}</p>` +
    `</div>`
  );
}

export function overallSummaryHtml(summary: OverallSummary | null): string {
  if (summary === null) return "";
  return (
    `<section class="overall-summary">` +
    `<h2>${OVERALL_SUMMARY_HEADING}</h2>` +
    `<div class="summary-overview">` +
    paragraphs(summary.overview) +
    `</div>` +
    summary.areas.map(areaHtml).join("") +
    list("What is working well", summary.strengths, "summary-strengths") +
    prioritiesHtml(summary) +
    list("Limitations of this audit", summary.limitations, "summary-limitations") +
    list("Not checked by this audit", summary.notChecked, "summary-not-checked") +
    helpHtml(summary) +
    `</section>`
  );
}
