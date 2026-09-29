/**
 * The overall score: the audit's headline verdict, on the page.
 *
 * ONE GRADE, FOUR CATEGORY SCORES, AND THE HONESTY AROUND THEM. Every value
 * here was read from `result.score`, the deterministic score our own code
 * computed from the verified findings; this section grades nothing and
 * recalculates nothing. It is the same verdict the dashboard shows, worded by
 * the same report layer, so the screen and the document cannot disagree.
 *
 * WORD BEFORE COLOUR, like every other verdict in this document. A grade is a
 * letter and a band word first; the tint is an accent on a meaning that is
 * already in words, so a greyscale print or a reader who cannot use the hue
 * loses nothing. A withheld grade says so in words and shows no number, and a
 * Not Assessed category reads "Not assessed" rather than a zero.
 */
import type { PdfScore, PdfScoreCategory } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** The section's title. Kept here with the section, as the others are. */
const SCORE_HEADING = "Overall score";

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
function gatePanel(score: PdfScore): string {
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

/**
 * The whole section.
 *
 * The grade block leads: either a letter with its band word and the pass rate
 * behind it, or a plain "Not graded" with the score's own reason when the audit
 * assessed too little to grade honestly. The caveats — a partial grade, a gate
 * holding the grade below its pass rate — are said out loud, never hidden.
 */
export function scoreHtml(score: PdfScore): string {
  const gradeBlock = score.grade !== null
    ? html`<span class="score-letter ${score.gradeClass}">${score.grade}</span>` +
      `<div class="score-lines">` +
      (score.bandLabel === null ? "" : html`<p class="score-band">${score.bandLabel}</p>`) +
      (score.passRate === null
        ? ""
        : html`<p class="score-health">${score.passRate} / 100 · weighted checks passed</p>`) +
      html`<p class="score-coverage">${score.coveragePercent}% of applicable checks assessed</p>` +
      `</div>`
    : `<span class="score-letter score-letter-none">Not graded</span>` +
      `<div class="score-lines">` +
      html`<p class="score-coverage">${score.coveragePercent}% of applicable checks assessed</p>` +
      `</div>`;

  const status = score.statusMessage === null ? "" : html`<p class="score-status">${score.statusMessage}</p>`;
  const partial = score.partialNote === null ? "" : html`<p class="score-caveat">${score.partialNote}</p>`;
  const cap = score.capNote === null ? "" : html`<p class="score-caveat">${score.capNote}</p>`;

  return (
    `<section class="score">` +
    `<h2>${SCORE_HEADING}</h2>` +
    `<div class="score-grade">${gradeBlock}</div>` +
    status +
    partial +
    cap +
    `<div class="score-cats">` +
    score.categories.map(categoryRow).join("") +
    `</div>` +
    gatePanel(score) +
    `</section>`
  );
}
