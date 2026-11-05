/**
 * The document shell: the page the report sections will be poured into.
 *
 * THE NINE SECTIONS OF THE REDESIGNED REPORT, in the order CP1 v6 §4 sets out
 * (CP3 step 4b, F1): the cover, then -- numbered by the stylesheet, from the
 * first section inside <main> -- the Executive Summary, Page-Level Issues, SEO
 * Audit, Security Audit, Speed (with its finding cards straight after it),
 * Technical Audit, the Skybook section, and Limitations and About This Audit.
 * Each is built by its own module, and this file decides only what goes on
 * the page and in what order.
 *
 * THE OLD STANDALONE SECTIONS ARE NO LONGER PRINTED. The overall summary, the
 * AI summary, the coverage section, the separate site- and page-findings
 * sections, the skipped checks, the final assessment, the measured-facts and
 * coverage-detail tables and the About section have each been replaced by a
 * part of the sections above. Their modules stay in the code base unchanged.
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
import { executiveSummarySectionHtml } from "./executiveSummary.ts";
import { findingCardsHtml, pageLevelIssuesHtml } from "./findings.ts";
import { securitySectionHtml, seoSectionHtml, technicalSectionHtml } from "./categorySections.ts";
import { speedHtml } from "./speed.ts";
import { pitchSectionHtml } from "./pitch.ts";
import { limitationsSectionHtml } from "./limitations.ts";
import { STYLESHEET } from "./styles.ts";
import { runningHeadFootCss } from "./runningHeadFoot.ts";


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
   * A CLIENT-READY FLOW (CP1 v6 §4). The Executive Summary leads: the grade,
   * how much of the site was covered, each area's condition, the one labelled
   * paragraph a model wrote from the verified findings, and every improvement
   * worst first. The detail follows, each finding explained once, in the
   * section it belongs to:
   *
   *   Page-Level Issues   the page findings; for a certificate failure, the
   *                       approved sentence that no page could be read
   *   SEO, Security,      each area's check list, then its site-level cards
   *   Technical           and its measured tables
   *   Speed               unchanged, with its finding cards straight after it
   *                       and no heading of their own
   *
   * The Skybook section and the limitations close the document.
   */
  const labels = document.labels;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    html`<title>${documentTitle(document)}</title>` +
    /*
     * The running head and foot are page rules, and they are this document's
     * own: the address and the date in them are its values, which is why they
     * are written here and are not part of the fixed stylesheet.
     */
    `<style>${STYLESHEET}${runningHeadFootCss(headOf(document), footOf(document))}</style></head><body>` +
    coverHtml(cover) +
    `<main>` +
    executiveSummarySectionHtml(document) +
    pageLevelIssuesHtml(document) +
    seoSectionHtml(document) +
    securitySectionHtml(document) +
    speedHtml(document.speed, labels, document.desktopSpeed) +
    // The speed cards follow the unchanged Speed section, with no heading of their own (CP3 rev 9 §1.18).
    findingCardsHtml(document.speedFindings, labels) +
    technicalSectionHtml(document) +
    pitchSectionHtml() +
    limitationsSectionHtml(document) +
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
