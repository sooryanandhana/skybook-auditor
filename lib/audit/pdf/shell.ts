/**
 * The document shell: the page the report sections will be poured into.
 *
 * WHAT IT ASSEMBLES TODAY. The cover, the coverage section, the summary with
 * its severity split and AI panel, and both findings sections, in the order 7A
 * §6 sets out. Each is built by its own module; this file decides only what
 * goes on the page and in what order.
 *
 * WHAT IS STILL A PLACEHOLDER. Speed, the measured-facts tables, the coverage
 * detail and the skipped checks each render a heading and a line saying they
 * are not yet built. They belong to 7C-4, and a first draft of any of them
 * here would be rewritten there.
 *
 * IT READS `PdfDocument` AND NOTHING ELSE. Every heading below is a string 7B
 * already prepared. The shell chooses no wording, formats no number, reads no
 * measurement state and decides nothing about the audit -- if a section is
 * absent from the document it is absent from the page, and that is the whole
 * of its logic.
 *
 * EVERY DOCUMENT VALUE GOES THROUGH `html` OR `escapeHtml`. The strings here
 * came from an audited website and from a language model, and 7A §22 requires
 * both to be rendered as text. There is no path in this file that puts a
 * document value into markup unescaped.
 */
import type { PdfDocument, PdfFactSection } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { coverHtml } from "./cover.ts";
import { coverageHtml } from "./coverage.ts";
import { findingsHtml } from "./findings.ts";
import { summaryHtml } from "./summary.ts";
import { STYLESHEET } from "./styles.ts";


/** A section that exists, and the heading 7B gave it. */
interface Placeholder {
  readonly heading: string;
  readonly detail: string;
}

/**
 * Which sections this document carries, in the order 7A §6 lists them.
 *
 * A section absent from the document produces no block, which is 7A §19's rule
 * that an empty section is omitted rather than left blank. Here that rule
 * costs nothing to honour, so it is honoured from the start rather than
 * retrofitted.
 */
function placeholders(document: PdfDocument): Placeholder[] {
  const factHeadings = (sections: readonly PdfFactSection[]) =>
    sections.map((section) => ({
      heading: section.heading,
      detail: `${section.facts.length} measured facts, not yet rendered.`,
    }));

  return [
    ...(document.skipped === null
      ? []
      : [
          {
            heading: document.skipped.heading,
            detail: `${document.skipped.count} checks, not yet rendered.`,
          },
        ]),
    { heading: "Speed", detail: "Speed result, not yet rendered." },
    ...factHeadings(document.measured),
    ...factHeadings(document.coverageDetail),
  ];
}

/**
 * The whole page, as one HTML string.
 *
 * A string rather than a file, because 7A §25 forbids the renderer reaching
 * the filesystem beyond its own bundled assets, and because writing a temporary
 * file would leave one behind on a crash.
 *
 * The `lang` attribute is 7A §24's declared language, and the `<title>` is its
 * document title. Both are accessibility requirements rather than decoration,
 * and both cost one attribute each, so neither waits for a later step.
 */
export function documentHtml(document: PdfDocument): string {
  const cover = document.cover;

  const blocks = placeholders(document)
    .map((block) => html`<section><h2>${block.heading}</h2><p class="note">${block.detail}</p></section>`)
    .join("");

  /*
   * THE ORDER IS 7A §6's, and it is not arbitrary. Coverage comes before any
   * finding because a reader has to know how much of the site was looked at
   * before a list of problems means anything. Site-wide findings come before
   * page-level ones because one broken certificate outranks a missing meta
   * description on nine pages, whatever the counts say.
   */
  const labels = document.labels;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    html`<title>Website audit — ${cover.auditedUrl}</title>` +
    `<style>${STYLESHEET}</style></head><body>` +
    coverHtml(cover) +
    `<main>` +
    coverageHtml(document.coverage) +
    summaryHtml(document.summary, labels) +
    findingsHtml(document.siteFindings, labels) +
    findingsHtml(document.pageFindings, labels) +
    `</main>` +
    blocks +
    `</body></html>`
  );
}

/** The audited address, for the running head. */
export function headOf(document: PdfDocument): { auditedUrl: string; partial: boolean } {
  return { auditedUrl: document.cover.auditedUrl, partial: document.cover.partial };
}

/** The audit date, for the running foot. Already a sentence when it exists. */
export function footOf(document: PdfDocument): { auditDate: string | null } {
  return { auditDate: document.cover.checkedAt };
}
