/**
 * The document shell: the page the report sections will be poured into.
 *
 * ALL TEN SECTIONS, in the order 7A §6 sets out. Each is built by its own
 * module, and this file decides only what goes on the page and in what order.
 * There are no placeholders left.
 *
 * IT ADDS NOTHING OF ITS OWN. Every section either returns markup or returns
 * an empty string, and a section that returns nothing leaves no heading, no
 * gap and no trace. That is 7A §19's rule about empty sections, honoured by
 * each module for itself rather than by a list of conditions kept here.
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
import type { PdfDocument } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { coverHtml } from "./cover.ts";
import { aboutHtml } from "./about.ts";
import { coverageHtml } from "./coverage.ts";
import { COVERAGE_DETAIL_HEADING, MEASURED_HEADING, factSectionsHtml } from "./factSections.ts";
import { findingsHtml } from "./findings.ts";
import { skippedHtml } from "./skipped.ts";
import { speedHtml } from "./speed.ts";
import { summaryHtml } from "./summary.ts";
import { STYLESHEET } from "./styles.ts";


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
    html`<title>${documentTitle(document)}</title>` +
    `<style>${STYLESHEET}</style></head><body>` +
    coverHtml(cover) +
    `<main>` +
    coverageHtml(document.coverage) +
    summaryHtml(document.summary, labels) +
    findingsHtml(document.siteFindings, labels) +
    findingsHtml(document.pageFindings, labels) +
    skippedHtml(document.skipped) +
    speedHtml(document.speed, labels) +
    factSectionsHtml(MEASURED_HEADING, document.measured, "measured") +
    factSectionsHtml(COVERAGE_DETAIL_HEADING, document.coverageDetail, "coverage-detail") +
    aboutHtml() +
    `</main>` +
    `</body></html>`
  );
}

/**
 * What the document is called.
 *
 * ONE SOURCE FOR TWO PLACES. It is the HTML title, which is what Chromium
 * shows a page as, and it is the PDF title, which is what a reader announces.
 * They were never going to be allowed to differ, and the way to guarantee that
 * is for there to be one of them.
 */
export function documentTitle(document: PdfDocument): string {
  return `Website audit — ${document.cover.auditedUrl}`;
}

/** The audited address, for the running head. */
export function headOf(document: PdfDocument): { auditedUrl: string; partial: boolean } {
  return { auditedUrl: document.cover.auditedUrl, partial: document.cover.partial };
}

/** The audit date, for the running foot. Already a sentence when it exists. */
export function footOf(document: PdfDocument): { auditDate: string | null } {
  return { auditDate: document.cover.checkedAt };
}
