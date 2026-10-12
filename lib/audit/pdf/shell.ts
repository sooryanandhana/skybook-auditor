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
import { executiveSummaryHtml } from "./executiveSummary.ts";
import { clientSummaryHtml } from "./clientSummary.ts";
import { finalAssessmentHtml } from "./finalAssessment.ts";
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
   * A CLIENT-READY FLOW, and one rule in it is not negotiable. The measured
   * coverage — "What we checked" — comes before any finding, because a reader has
   * to know how much of the site was looked at before a list of problems means
   * anything, and a partial crawl presented as a whole-site audit is the single
   * most damaging thing this document could do (7A §6, §13).
   *
   * THE OVERVIEW LEADS: the executive summary opens the document with the grade,
   * the severity split and the four category scores on one page, and the AI
   * summary follows it so a reader meets the plain-English account of the audit
   * before the detailed measured sections. The AI summary is clearly labelled as
   * the model's, and it invents
   * nothing — its overall summary, key findings and recommendations are the
   * validated explanations, and its "what we checked" and "next steps" are
   * derived from the measured findings.
   *
   * MEASURED DETAIL FOLLOWS: the coverage, the findings, the speed check and the
   * measured facts come after it, each measured by this tool.
   * The final assessment restates the measured grade, and the notes on the audit
   * itself close the document on their own page.
   *
   * Site-wide findings come before page-level ones because one broken certificate
   * outranks a missing meta description on nine pages, whatever the counts say.
   */
  const labels = document.labels;

  /*
   * The provenance sentence and the honesty notes that ride with the AI section,
   * built from the same validated answer the client summary was. Empty when no
   * model answer was produced, in which case the section draws nothing anyway.
   */
  const ai = document.summary.ai;
  const aiNote =
    ai === null
      ? ""
      : [labels.aiProvenance, ai.rejectedNote, ai.coverageNote]
          .filter((sentence) => sentence !== null && sentence !== "")
          .join(" ");

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
    executiveSummaryHtml({
      score: document.score,
      summary: document.summary,
      coverage: document.coverage,
      nextSteps: document.clientSummary.nextSteps,
      siteFindings: document.siteFindings,
      pageFindings: document.pageFindings,
    }) +
    clientSummaryHtml(document.clientSummary, labels, aiNote) +
    coverageHtml(document.coverage) +
    findingsHtml(document.siteFindings, labels) +
    findingsHtml(document.pageFindings, labels) +
    skippedHtml(document.skipped) +
    speedHtml(document.speed, labels) +
    finalAssessmentHtml(document.score) +
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
