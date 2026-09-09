/**
 * The one fact table every measurement in this document uses.
 *
 * 7A §17 names it as one of four visual devices, each with one job: a label
 * column and a value column, with an optional note. It is the layout the
 * results page already uses for measured facts, and having exactly one of them
 * is the point -- a second table style would invite a reader to look for a
 * difference in meaning that is not there.
 *
 * A REAL TABLE, NOT A GRID OF DIVS. 7A §24 asks for a document a screen reader
 * can follow, and a table of measurements is a table. It also means 7A §18's
 * rule about a spanning table repeating its header row has something to
 * repeat, which a stack of divs would not.
 *
 * IT FORMATS NOTHING. Every label, value and note arrives finished from 7B.
 */
import type { PdfFact } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/**
 * A table of facts, or nothing at all.
 *
 * An empty set produces no markup rather than an empty table with a header
 * and no rows, which 7A §19 requires: a section either says something true or
 * is omitted.
 */
export function factTable(facts: readonly PdfFact[]): string {
  if (facts.length === 0) return "";

  const rows = facts
    .map((fact) => {
      const value =
        fact.note === undefined
          ? html`<td>${fact.value}</td>`
          : html`<td>${fact.value}<span class="fact-note">${fact.note}</span></td>`;

      return html`<tr><th scope="row">${fact.label}</th>` + value + `</tr>`;
    })
    .join("");

  /*
   * The header row is what Chromium repeats after a page break, and it is
   * marked up rather than drawn so a reader who cannot see the table still
   * knows which column is which.
   */
  return (
    `<table class="facts">` +
    `<thead><tr><th scope="col">Measurement</th><th scope="col">Result</th></tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>`
  );
}
