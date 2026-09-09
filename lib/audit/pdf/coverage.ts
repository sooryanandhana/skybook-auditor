/**
 * What the crawl covered, and what it did not.
 *
 * SECOND IN THE DOCUMENT, BEFORE ANY FINDING. 7A §6 puts it there deliberately.
 * A reader has to know how much of the site was looked at before they can read
 * a list of problems as meaning anything, and a partial crawl presented as a
 * whole-site audit is the single most damaging thing this document could do.
 *
 * COUNTS, NEVER A PERCENTAGE. 7A §13 is explicit: a crawl discovers more pages
 * as it reads, so there is no honest denominator while it runs, and a
 * percentage would be an invented one. Everything here arrives as a finished
 * string or a finished number from 7B.
 *
 * COMPLETENESS IS READ, NEVER INFERRED. `partial` came from the crawl's own
 * flag, which requires both the page queue and sitemap discovery to have
 * finished. Nothing here compares counts to decide whether a crawl finished --
 * a crawl can read every page it found and still be incomplete, because there
 * were sections it never heard of.
 */
import type { PdfCoverage } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { factTable } from "./facts.ts";

/**
 * The section's title, from 7A §6's structure table.
 *
 * DECLARED HERE BECAUSE 7B DOES NOT SUPPLY ONE. The findings and skipped
 * sections carry their headings through the projection, because those strings
 * are also on screen and 7A §5 requires one copy of anything a reader compares
 * between the two. This section's title exists only in the PDF, so there is
 * nothing to keep it in step with. It is a structural label, not a statement
 * about the audited site: nothing here phrases a measurement.
 */
const COVERAGE_HEADING = "What we checked";

/** The coverage section, which is always present. */
export function coverageHtml(coverage: PdfCoverage): string {
  /*
   * The marker repeats here even though the cover carries one and every
   * running head carries another. 7A §13 asks for it on the cover and in
   * coverage, and the redundancy is the point: this is the section a reader
   * turns to when they want to know what "partial" meant.
   */
  const marker = coverage.partial ? `<p class="partial">Partial audit</p>` : "";

  const reason =
    coverage.stopReason === null ? "" : html`<p class="note">${coverage.stopReason}</p>`;

  return (
    `<section class="coverage">` +
    `<h2>${COVERAGE_HEADING}</h2>` +
    marker +
    // The headline is a sentence the report layer wrote, not a title.
    html`<p class="lead">${coverage.headline}</p>` +
    reason +
    factTable(coverage.facts) +
    `</section>`
  );
}
