/**
 * Final assessment: the grade, and what would move it, as a closing recap.
 *
 * DERIVED, NOT DECIDED. Every line is read from the deterministic score the rest
 * of the report already shows -- the grade and its band, the weighted pass rate,
 * the findings the gate named as holding the grade back, and the score's own
 * sentence about why. Nothing is recalculated and no closing verdict is written;
 * this restates measured conclusions the reader has already met, gathered as the
 * last thing before the notes on the audit itself.
 *
 * THE PRIORITIES ARE THE GATE'S OWN. When serious findings cap the grade, they
 * are the next steps, and the score's gate note -- "fixing them is what lifts
 * it" -- is the existing sentence that says so. When nothing gates the grade the
 * priorities block is simply absent; there is no invented "well done".
 */
import type { PdfScore } from "../pdfDocument.ts";
import { html } from "./escape.ts";

const FINAL_HEADING = "Final assessment";

/** The findings the gate named, as the next steps, with the score's own note. */
function priorities(score: PdfScore): string {
  if (score.gateReasons.length === 0) return "";

  const items = score.gateReasons.map((title) => html`<li>${title}</li>`).join("");
  const note = score.gateNote === null ? "" : html`<p class="final-note">${score.gateNote}</p>`;

  return (
    `<div class="final-priorities">` +
    `<p class="eyebrow cover-eyebrow">Priorities</p>` +
    `<ul class="final-list">${items}</ul>` +
    note +
    `</div>`
  );
}

/**
 * The whole section.
 *
 * The grade leads, as it does in the executive summary and the score section: a
 * letter with its band word and the weighted pass rate, or a plain "Not graded"
 * with the score's own reason. The status message, when the score carried one,
 * says in words what the grade could and could not cover.
 */
export function finalAssessmentHtml(score: PdfScore): string {
  const grade =
    score.grade !== null
      ? html`<span class="final-grade">${score.grade}</span>` +
        `<div class="final-lines">` +
        (score.bandLabel === null ? "" : html`<p class="final-band">${score.bandLabel}</p>`) +
        (score.passRate === null
          ? ""
          : html`<p class="final-health">${score.passRate} / 100 · weighted checks passed</p>`) +
        `</div>`
      : `<span class="final-grade final-grade-none">Not graded</span>`;

  const status =
    score.statusMessage === null ? "" : html`<p class="final-note">${score.statusMessage}</p>`;

  return (
    `<section class="final">` +
    `<h2>${FINAL_HEADING}</h2>` +
    `<div class="final-head">${grade}</div>` +
    status +
    priorities(score) +
    `</section>`
  );
}
