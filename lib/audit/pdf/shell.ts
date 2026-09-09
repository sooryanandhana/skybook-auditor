/**
 * The document shell: the smallest page that is worth rendering.
 *
 * WHAT THIS IS NOT. There is no cover, no logo, no findings, no security or
 * speed section, no commentary, no affected-page list and no finished
 * typography. Those are later 7C steps and putting a first draft of any of
 * them here would mean rewriting it there. What exists is the frame they will
 * be poured into: a titled document, a readable body, a main region, and one
 * placeholder block per section the document actually carries.
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

/**
 * TEMPORARY typography, and no more of it than a page needs to be legible.
 *
 * 7A §16 sets body text at 10 to 11 point with generous leading and a measure
 * near 65 to 75 characters, and the 7C evaluation recommended a full scale and
 * three embedded faces. None of that is settled here: embedding fonts is its
 * own step, and a half-applied scale is harder to finish than an absent one.
 * These rules exist so the foundation renders as a document rather than as
 * unstyled markup.
 *
 * The sections are broken onto separate pages for the same temporary reason:
 * it makes the running head, the running foot and "page n of m" observable on
 * a real multi-page document. 7A §18 decides the real page breaks, at 7C-6.
 */
const STYLE = `
  @page { margin: 0; }
  html { -webkit-print-color-adjust: exact; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #16213a;
  }
  main { max-width: 68ch; }
  h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 8pt; }
  h2 { font-size: 13pt; line-height: 1.25; margin: 0 0 6pt; }
  p { margin: 0 0 8pt; }
  .url { font-family: ui-monospace, "Courier New", monospace; overflow-wrap: anywhere; }
  .note { color: #4a5872; font-size: 9pt; }
  section + section { break-before: page; }
`;

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
    { heading: document.coverage.headline, detail: "Crawl coverage, not yet rendered." },
    {
      heading: document.siteFindings.heading,
      detail: `${document.siteFindings.count} findings, not yet rendered.`,
    },
    {
      heading: document.pageFindings.heading,
      detail: `${document.pageFindings.count} findings, not yet rendered.`,
    },
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

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    html`<title>Website audit — ${cover.auditedUrl}</title>` +
    `<style>${STYLE}</style></head><body><main>` +
    html`<h1>${cover.statusLine}</h1>` +
    html`<p class="url">${cover.auditedUrl}</p>` +
    /*
     * PRINTED, NOT PHRASED. The projection turns the stored timestamp into a
     * sentence; this puts that sentence on the page. Null means the stored
     * value could not be read, and the line is omitted rather than filled --
     * a document that says "Measured" and then nothing is worse than one that
     * does not raise the question.
     */
    (cover.checkedAt === null ? "" : html`<p class="note">Measured ${cover.checkedAt}</p>`) +
    `<p class="note">Foundation document. The report sections below are not yet rendered.</p>` +
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
