/**
 * The measured facts, and the coverage detail.
 *
 * TWO SECTIONS, ONE SHAPE. 7A §6 lists "What we measured" and "Coverage
 * detail" separately because they answer different questions -- what the audit
 * found, and how much of the site it looked at -- but both arrive as a list of
 * titled fact groups, so both are laid out by this file rather than by two
 * near-identical ones that would drift.
 *
 * REFERENCE MATERIAL, PLACED LATE. These are the tables a reader turns to
 * after the findings, when they want to check a number rather than be told
 * what is wrong. 7A §6 puts them after the speed section for that reason, and
 * the results page reached the same conclusion the hard way: this content once
 * sat at the top and pushed the first finding most of a screen down the page.
 *
 * IT MEASURES NOTHING AND PHRASES NOTHING. Every label, value and note was
 * finished by the report layer. A row that says "Could not be checked" says it
 * because the audit could not check it, not because this file decided how to
 * describe an absence.
 */
import type { PdfFactSection } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { factTable } from "./facts.ts";

/**
 * A titled run of fact groups, or nothing at all.
 *
 * 7A §19: an empty section is omitted rather than left blank. A group with no
 * rows produces no table and no sub-heading, and a section whose groups are
 * all empty produces nothing, so the document never carries a heading with
 * white space under it.
 */
export function factSectionsHtml(
  heading: string,
  sections: readonly PdfFactSection[],
  className: string,
): string {
  const groups = sections
    .filter((section) => section.facts.length > 0)
    .map((section) => html`<div class="fact-group"><h3>${section.heading}</h3>` + factTable(section.facts) + `</div>`)
    .join("");

  if (groups === "") return "";

  return html`<section class="${className}">` + html`<h2>${heading}</h2>` + groups + `</section>`;
}

/** 7A §6, section eight. The entry page's own measurements. */
export const MEASURED_HEADING = "What we measured";

/** 7A §6, section nine. How much of the site the crawl reached. */
export const COVERAGE_DETAIL_HEADING = "Coverage detail";
