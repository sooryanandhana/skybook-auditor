/**
 * The score's parts: the four category scores, and what holds the grade back.
 *
 * EVERY VALUE HERE WAS READ FROM `result.score`, the deterministic score our
 * own code computed from the verified findings; nothing here grades or
 * recalculates. It is the same verdict the dashboard shows, worded by the same
 * report layer, so the screen and the document cannot disagree.
 *
 * PART OF THE EXECUTIVE SUMMARY, NOT A SECTION OF ITS OWN. The grade itself is
 * drawn there, once, at the head of the report; these are the two pieces that
 * sit beneath it.
 *
 * WORD BEFORE COLOUR, like every other verdict in this document. A grade is a
 * letter first; the tint is an accent on a meaning that is already in words, so
 * a greyscale print or a reader who cannot use the hue loses nothing. A Not
 * Assessed category reads "Not assessed" rather than a zero.
 */
import type { PdfScore, PdfScoreCategory } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** One pillar's line: a grade and pass rate, or a plain "not assessed". */
function categoryRow(category: PdfScoreCategory): string {
  const value = category.assessed
    ? html`<span class="score-cat-grade ${category.gradeClass}">${category.grade}</span>` +
      html`<span class="score-cat-rate">${category.passRate}%</span>` +
      html`<span class="score-cat-cover">${category.coveragePercent}% assessed</span>`
    : // Never a zero: a category no rule could run for is stated, not scored.
      `<span class="score-cat-na">Not assessed</span>`;

  return (
    `<div class="score-cat">` +
    html`<span class="score-cat-label">${category.label}</span>` +
    `<span class="score-cat-value">${value}</span>` +
    `</div>`
  );
}

/** The findings that held the grade down, when a gate applied. */
export function gateHtml(score: PdfScore): string {
  if (score.gateReasons.length === 0) return "";

  const items = score.gateReasons.map((title) => html`<li>${title}</li>`).join("");
  const note = score.gateNote === null ? "" : html`<p class="score-gate-note">${score.gateNote}</p>`;

  return (
    `<div class="score-gate">` +
    html`<p class="score-gate-heading">${score.gateHeading}</p>` +
    `<ul class="score-gate-list">${items}</ul>` +
    note +
    `</div>`
  );
}

/** The four category scores, one card each, in the order the score gave them. */
export function scoreCategoriesHtml(score: PdfScore): string {
  if (score.categories.length === 0) return "";

  return `<div class="score-cats">` + score.categories.map(categoryRow).join("") + `</div>`;
}
