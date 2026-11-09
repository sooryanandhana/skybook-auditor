/**
 * Limitations and About This Audit: the last section of the redesigned report
 * (CP1 F8, CP3 step 3c-ii).
 *
 * NOT YET PRINTED. `limitationsSectionHtml` is complete and tested, but nothing
 * in the document calls it until the shell is rewired in CP3 step 4. Until
 * then the report prints exactly what it printed before.
 *
 * IT MEASURES NOTHING AND DECIDES NOTHING. Every skipped check and its reason,
 * every count, the stop reason and the configured limits come from the
 * document model, already worded by the report layer. This file chooses only
 * the approved headings, the order (C4) and what to leave out:
 *
 *   - counts only from reconciled coverage, and only the ones that are not zero (C1);
 *   - a crawl stop reason only for a whole-site crawl that stopped short --
 *     never for a certificate failure, whose "reason" is a page-fetch error (C3, K4);
 *   - the figure-free robots.txt sentence only when the counts did not reconcile (X1).
 *
 * THE WORDING IS COPIED HERE, NOT IMPORTED, for the same reason as in the other
 * section renderers: renderer files may import only from this folder and the
 * document model. limitations.test.mts holds each copy equal to its
 * report-layer original. The real-visitor reference was added in CP4 (part 2a).
 */
import type { PdfDocument, PdfFact } from "../pdfDocument.ts";
import { aboutClausesHtml } from "./about.ts";
import { CRAWL_TABLE_LABELS, ROBOTS_EXCLUSION_WITHOUT_COUNT } from "./categorySections.ts";
import { html } from "./escape.ts";
import { factTable } from "./facts.ts";
import { skippedGroupsHtml } from "./skipped.ts";
import { explainsRealVisitorData } from "./speed.ts";

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * Equal to `REAL_VISITOR_REFERENCE` in lib/report/reportSections.ts (CP4; CP1 v6
 * wording §9.4). The short reference only: the full explanation is printed in
 * the Speed section and nowhere else.
 */
export const REAL_VISITOR_REFERENCE =
  "Google's real-visitor speed data was not available for this site; see Speed & Performance for what this means.";

/** The section's printed heading (CP1 §4, item 9). */
export const LIMITATIONS_HEADING = "Limitations and About This Audit";

/** Equal to `SECTION_INTROS.limitations` in lib/report/reportSections.ts. */
export const LIMITATIONS_INTRO =
  "This section explains what the audit could and could not check, so the results above can be read accurately.";

/** The five sub-headings (CP3 revision 9 §4.2; CP1 §9.4; C2). */
export const LIMITATIONS_SUBHEADINGS = {
  checks: "Checks that could not be completed",
  pages: "Pages that could not be checked",
  notPart: "Not part of this audit",
  about: "About this audit",
  limits: "Audit limits",
} as const;

/** Equal to `NOT_CHECKED_BY_THIS_AUDIT` in lib/report/overallSummary.ts. */
export const NOT_PART_OF_THIS_AUDIT: readonly string[] = [
  "DKIM email signing (it is configured with the email provider and needs details this audit does not have)",
  "Broken links between pages",
  "Structured data (schema markup)",
  "Search-engine indexing instructions such as \"noindex\"",
  "Whether http:// addresses redirect to https://",
  "Visual layout and how pages look on different screen sizes",
  "Current search rankings, visitor numbers or sales",
];

// ---------------------------------------------------------------------------
// The parts, in the approved order (C4)
// ---------------------------------------------------------------------------

/** 2. The checks that did not run, grouped by reason; nothing when none were skipped. */
function checksNotCompletedHtml(doc: PdfDocument): string {
  const skipped = doc.skipped;
  if (skipped === null || skipped.groups.length === 0) return "";
  return (
    html`<h3>${LIMITATIONS_SUBHEADINGS.checks}</h3>` +
    html`<p>${skipped.intro}</p>` +
    skippedGroupsHtml(skipped.groups)
  );
}

/**
 * 2a. The short real-visitor reference (CP4, decisions P-7, P-10, U-5 option A),
 * in the place CP1 v6 wording §9.4 lists it: after the checks that could not be
 * completed, before the pages that could not be checked. A plain paragraph with
 * no heading of its own, like the other short Limitations notes (A2).
 *
 * Printed only when the Speed section prints the full explanation it points to
 * (the P-4 rule, from speed.ts, on the MOBILE result) and that result has no
 * real-visitor data. Within that rule, "no real-visitor data" is read as
 * `!fieldAvailable`: a real-visitor read error never reaches a measured result,
 * which lib/collector/performanceChecks.test.mts pins (U-5). Desktop is never read.
 */
function realVisitorReferenceHtml(doc: PdfDocument): string {
  const mobile = doc.speed;
  if (!mobile.measured || !explainsRealVisitorData(mobile) || mobile.fieldAvailable) return "";
  return html`<p>${REAL_VISITOR_REFERENCE}</p>`;
}

/**
 * 3. The pages that could not be checked: only from reconciled counts, and only
 * the counts that are not zero (C1). Nothing at all, heading included, when
 * the counts did not reconcile or all three are zero.
 */
function pagesNotCheckedHtml(doc: PdfDocument): string {
  const counts = doc.coverageCounts;
  if (counts === null) return "";
  const rows: PdfFact[] = [
    { label: CRAWL_TABLE_LABELS.unavailable, value: String(counts.unavailable) },
    { label: CRAWL_TABLE_LABELS.notWebPages, value: String(counts.notWebPages) },
    { label: CRAWL_TABLE_LABELS.robotsExcluded, value: String(counts.robotsExcluded) },
  ].filter((row) => row.value !== "0");
  if (rows.length === 0) return "";
  return html`<h3>${LIMITATIONS_SUBHEADINGS.pages}</h3>` + factTable(rows);
}

/**
 * 4. The crawl's stop reason and the figure-free exclusion sentence, as plain
 * paragraphs with no heading of their own (A2).
 *
 * The stop reason is printed only for a whole-site crawl that stopped short; a
 * certificate failure read no page, and its "reason" is the page fetch's error,
 * not a crawl's (C3, K4). The X1 sentence is printed only when the counts did
 * not reconcile; when they did, the counted exclusion is already in part 3.
 */
function stopReasonAndExclusionsHtml(doc: PdfDocument): string {
  const paragraphs: string[] = [];
  const reason = doc.coverage.stopReason;
  if (doc.certificateFailureAreas === null && doc.coverage.partial && reason !== null && reason !== "") {
    paragraphs.push(reason);
  }
  if (doc.coverageCounts === null && doc.coverageFlags.hasExclusions) {
    paragraphs.push(ROBOTS_EXCLUSION_WITHOUT_COUNT);
  }
  return paragraphs.map((paragraph) => html`<p>${paragraph}</p>`).join("");
}

/** 5. What this audit does not examine at all. */
function notPartOfThisAuditHtml(): string {
  return (
    html`<h3>${LIMITATIONS_SUBHEADINGS.notPart}</h3>` +
    `<ul>${NOT_PART_OF_THIS_AUDIT.map((item) => html`<li>${item}</li>`).join("")}</ul>`
  );
}

/** 6. Every About clause, always (S3-D9), its four groups one level below "About this audit" (A1). */
function aboutThisAuditHtml(): string {
  return html`<h3>${LIMITATIONS_SUBHEADINGS.about}</h3>` + aboutClausesHtml(4);
}

/** 7. The configured limits, as the report layer worded them (S3-D8). Settings, not measurements. */
function auditLimitsHtml(doc: PdfDocument): string {
  return html`<h3>${LIMITATIONS_SUBHEADINGS.limits}</h3>` + html`<p>${doc.configuredLimitsSentence}</p>`;
}

/**
 * The redesigned Limitations and About This Audit section (CP1 F8), as one
 * numbered section.
 *
 * NOT WIRED: `shell.ts` still prints the skipped and About sections it always
 * has. CP3 step 4 swaps them.
 */
export function limitationsSectionHtml(doc: PdfDocument): string {
  return (
    `<section class="limitations">` +
    html`<h2>${LIMITATIONS_HEADING}</h2>` +
    html`<p class="lead">${LIMITATIONS_INTRO}</p>` +
    checksNotCompletedHtml(doc) +
    realVisitorReferenceHtml(doc) +
    pagesNotCheckedHtml(doc) +
    stopReasonAndExclusionsHtml(doc) +
    notPartOfThisAuditHtml() +
    aboutThisAuditHtml() +
    auditLimitsHtml(doc) +
    `</section>`
  );
}
