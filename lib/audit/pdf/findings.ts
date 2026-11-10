/**
 * The findings: the part of the document a client actually acts on.
 *
 * THE ORDER IS THE AGGREGATOR'S AND IS NEVER TOUCHED. 7A §8: severity first,
 * then rule identifier for ties, and affected pages sorted by address, so the
 * same audit always produces the same document. Nothing in this file sorts,
 * compares or reorders anything -- the arrays arrive correct and are rendered
 * in the order they arrive. That is not laziness; a renderer that re-sorted
 * could disagree with the screen about which problem matters most.
 *
 * NOTHING HERE IS DECIDED. Severity, scope, reach, evidence, remediation and
 * the category label were all settled before this ran. This file chooses type
 * sizes and boxes.
 *
 * WHAT ONE FINDING SHOWS, in this order (CP1 v6 §6): the title, a severity chip
 * carrying the word as well as the colour, the scope line, what we found, what
 * this means, why it matters, how it may affect the website or business, what
 * to do (labelled and set apart), the steps, what fixing it is intended to
 * achieve, who usually fixes it, the evidence panel and the affected pages.
 *
 * NO AI WRITING ON A CARD. Every word here is either measured or fixed,
 * reviewed report text. The model's per-finding commentary is not printed in
 * the PDF, even when the audit carries some: a card explains its finding once,
 * completely, in words a person approved.
 */
import type {
  PdfAffectedPage,
  PdfDocument,
  PdfFinding,
  PdfFindingGroup,
  PdfFindingSection,
  PdfLabels,
} from "../pdfDocument.ts";
import { html } from "./escape.ts";

// ---------------------------------------------------------------------------
// Card wording (CP1 v6 §6)
// ---------------------------------------------------------------------------

/*
 * KEPT HERE BECAUSE THIS FOLDER MAY IMPORT ONLY THE PROJECTION. The report layer
 * holds the same approved texts (`EVIDENCE_HEADINGS` in findingExplainers.ts,
 * `AFFECTED_LIST_TRUNCATED` in reportSections.ts); the card tests hold each copy
 * equal to the other, so the two cannot drift apart (CP3-O1).
 */

/** The evidence heading for each kind of evidence. */
export const EVIDENCE_HEADING = {
  site: "Measured for the whole domain",
  onePage: "Measured on the page checked",
  examplePage: "Example measured on the main page checked",
} as const;

/** Printed under an affected-page list only when the list was actually cut short (TR1). */
export const AFFECTED_LIST_TRUNCATED = "Further affected pages are not listed.";

/** The heading of card block 8. */
export const WHAT_FIXING_ACHIEVES_LABEL = "What fixing it is intended to achieve";

/**
 * The severity chip.
 *
 * WORD AND COLOUR, NEVER COLOUR ALONE. 7A §8 and §24 both require it. The
 * chip's border and text take the severity's colour and the label sits inside
 * it, so a greyscale print and a colour-blind reader both still get the
 * severity. The class carries the value the rule declared; the renderer reads
 * it and picks a colour, and never compares one severity with another.
 */
function chip(finding: PdfFinding): string {
  return html`<span class="chip chip-${finding.severity}">${finding.severityLabel}</span>`;
}

/**
 * The scope line (CP1 v6 §6), or null when there is nothing true to say.
 *
 * EVERY VALUE IS THE PROJECTION'S. A speed card names the address that was
 * measured; a site card names the domain the projection read for it; a page
 * card states the counts the projection carried. Where the projection carried
 * nothing -- counts that did not reconcile, a domain that was missing or not a
 * domain at all -- no line is printed, rather than one built from something
 * else. A site finding is never given a page denominator.
 */
function scopeLine(finding: PdfFinding): string | null {
  if (finding.category === "speed") {
    const measured = finding.affected[0]?.url;
    return measured === undefined ? null : `Measured on ${measured} (mobile).`;
  }
  if (finding.scope === "site") {
    return finding.scopeDomain === null ? null : `Applies to the whole domain: ${finding.scopeDomain}.`;
  }
  if (finding.scopeCounts === null) return null;
  return finding.evidenceKind === "onePage"
    ? "Found on the page checked."
    : `Found on ${finding.scopeCounts.affected} of ${finding.scopeCounts.evaluated} pages checked.`;
}

function meta(finding: PdfFinding): string {
  const line = scopeLine(finding);
  return line === null ? "" : html`<p class="finding-meta">${line}</p>`;
}

/**
 * The affected pages, when the finding names any.
 *
 * A SAMPLE THAT SAYS SO. The aggregator caps the list at fifty, and the
 * document says so whenever the list is shorter than the true total (TR1). The
 * note carries no figure: `truncated` is a yes or no, so a count that could not
 * be verified is never printed here.
 *
 * SET AS RUNNING TEXT, NOT A STACKED LIST. Fifty addresses one per line, on
 * twenty-four page findings, is most of a report. Run together they are a few
 * paragraphs. The list is still a real list in the markup, because it is one,
 * and 7A §24 asks for a document a screen reader can follow.
 */
function affected(finding: PdfFinding, pages: readonly PdfAffectedPage[]): string {
  if (pages.length === 0) return "";

  const items = pages.map((page) => html`<li>${page.url}</li>`).join("");
  const note = finding.truncated ? html`<p class="note">${AFFECTED_LIST_TRUNCATED}</p>` : "";

  return `<div class="affected">` + `<ul class="affected-list">${items}</ul>` + note + `</div>`;
}

/**
 * What the finding means, why it matters and how it may affect the website or
 * business, in plain words. Placed after what we found, so the reader meets
 * the fact first.
 */
function meaning(finding: PdfFinding): string {
  const written = finding.explainer;
  if (written === null) return "";
  return (
    `<div class="explainer">` +
    `<p class="explainer-label">What this means</p>` +
    html`<p>${written.whatItMeans}</p>` +
    `<p class="explainer-label">Why it matters</p>` +
    html`<p>${written.whyItMatters}</p>` +
    `<p class="explainer-label">How it may affect your website or business</p>` +
    html`<p>${written.possibleImpact}</p>` +
    `</div>`
  );
}

/**
 * The practical steps, what fixing it is intended to achieve, and who usually
 * does the work, after what to do (CP1 v6 §6 blocks 7, 8 and 9).
 *
 * BLOCK 8 IS PRINTED EXACTLY AS WRITTEN. The sentence is the reviewed
 * explainer's own, phrased as an intention rather than a promise; nothing is
 * added to it here. With no sentence, there is no block.
 */
function howToFix(finding: PdfFinding): string {
  const written = finding.explainer;
  if (written === null) return "";
  const achieves = written.whatFixingAchieves;
  const achievesBlock =
    typeof achieves === "string" && achieves.trim() !== ""
      ? html`<p class="explainer-label">${WHAT_FIXING_ACHIEVES_LABEL}</p>` + html`<p>${achieves}</p>`
      : "";
  return (
    `<div class="explainer explainer-steps">` +
    `<p class="explainer-label">Steps</p>` +
    `<ol>` +
    written.steps.map((step) => html`<li>${step}</li>`).join("") +
    `</ol>` +
    achievesBlock +
    html`<p class="who-fixes"><span class="explainer-label">Who usually fixes it:</span> ${written.whoFixes}</p>` +
    `</div>`
  );
}

/**
 * The evidence heading, from the kind of evidence the projection named.
 *
 * The several-pages form carries the reach only when the projection carried
 * counts that reconciled; otherwise it is the same words with no figure.
 */
function evidenceHeading(finding: PdfFinding): string {
  switch (finding.evidenceKind) {
    case "site":
      return EVIDENCE_HEADING.site;
    case "onePage":
      return EVIDENCE_HEADING.onePage;
    case "examplePage":
      return finding.scopeCounts === null
        ? EVIDENCE_HEADING.examplePage
        : `${EVIDENCE_HEADING.examplePage} (found on ${finding.scopeCounts.affected} of ${finding.scopeCounts.evaluated} pages)`;
  }
}

/**
 * The measured rows behind the finding, as a small table. The same rows, from
 * the same builders, as the measured-facts tables, so the two cannot disagree.
 *
 * HEADED ONLY WHERE THERE IS A PANEL (CP3-O9), and never on a speed card, whose
 * scope line already says what was measured and where.
 */
function evidencePanel(finding: PdfFinding): string {
  const panel = finding.evidencePanel;
  if (panel === null || panel.facts.length === 0) return "";
  const heading =
    finding.category === "speed" ? "" : html`<p class="explainer-label">Evidence · ${evidenceHeading(finding)}</p>`;
  const rows = panel.facts
    .map(
      (fact) =>
        html`<tr><th scope="row">${fact.label}</th><td>${fact.value}` +
        (fact.note === undefined || fact.note === "" ? "" : html`<span class="evidence-note">${fact.note}</span>`) +
        `</td></tr>`,
    )
    .join("");
  return (
    `<div class="evidence-panel">` +
    heading +
    `<table class="facts evidence-facts"><tbody>${rows}</tbody></table>` +
    `</div>`
  );
}

/** One finding, as a card. 7A §17 keeps cards for exactly this. */
function findingCard(finding: PdfFinding, labels: PdfLabels): string {
  return (
    /*
     * The severity travels onto the card as a class, exactly as it does onto
     * the chip below, so the stylesheet can tint a restrained left accent. It
     * decides nothing: the word in the chip still carries the severity, and the
     * renderer never compares one severity with another.
     */
    html`<article class="finding finding-${finding.severity}">` +
    `<div class="finding-head">` +
    chip(finding) +
    html`<h4 class="finding-title">${finding.title}</h4>` +
    `</div>` +
    meta(finding) +
    /*
     * The rule's measured evidence, labelled as what we found. The label is a
     * fixed structural word, like the scope above it, not a document value: it
     * says nothing about the site.
     */
    `<p class="finding-eyebrow">What we found</p>` +
    html`<p class="evidence">${finding.evidence}</p>` +
    meaning(finding) +
    /*
     * The rule's own action, not a model's. Labelled and set apart because on
     * screen the evidence and the action were once two grey paragraphs of the
     * same size, and a reader could not tell what was measured from what to do
     * about it.
     */
    `<div class="remediation">` +
    html`<p class="remediation-label">${labels.remediation}</p>` +
    html`<p>${finding.remediation}</p>` +
    `</div>` +
    howToFix(finding) +
    evidencePanel(finding) +
    affected(finding, finding.affected) +
    `</article>`
  );
}

/**
 * One category's findings.
 *
 * GROUPING NEVER CROSSES A SCOPE BOUNDARY. 7A §8: the site-wide and page-level
 * sections are grouped separately, so "Security" appears once in each rather
 * than once overall. That split was made by 7B; this renders whatever groups
 * it was given.
 */
function group(group: PdfFindingGroup, labels: PdfLabels): string {
  return (
    `<div class="group">` +
    html`<h3>${group.label}</h3>` +
    group.findings.map((finding) => findingCard(finding, labels)).join("") +
    `</div>`
  );
}

/**
 * A findings section, or nothing at all.
 *
 * AN EMPTY SECTION IS OMITTED, NOT LEFT BLANK. 7A §19: with no site-wide
 * findings that section disappears and the page-level one still appears. The
 * clean-state sentence, for an audit that found nothing anywhere, belongs to
 * the summary and is not repeated here.
 */
export function findingsHtml(section: PdfFindingSection, labels: PdfLabels): string {
  if (section.count === 0 || section.groups.length === 0) return "";

  return (
    `<section class="findings">` +
    html`<h2>${section.heading}</h2>` +
    html`<p class="lead">${section.intro}</p>` +
    section.groups.map((one) => group(one, labels)).join("") +
    `</section>`
  );
}

/**
 * Finding cards on their own: no section, no heading and no category group.
 *
 * FOR APPENDING AFTER A SECTION THAT ALREADY EXISTS, such as the speed cards
 * that follow the Speed section. With no section and no heading of its own it
 * cannot add a numbered section to the report. Each card is drawn exactly as
 * it is everywhere else. Nothing at all for an empty list.
 */
export function findingCardsHtml(findings: readonly PdfFinding[], labels: PdfLabels): string {
  if (findings.length === 0) return "";
  return `<div class="finding-cards">` + findings.map((finding) => findingCard(finding, labels)).join("") + `</div>`;
}

// ---------------------------------------------------------------------------
// Page-Level Issues (CP1 F1, CP3 step 4a)
// ---------------------------------------------------------------------------

/** The section's printed heading (CP1 §4, item 3). */
export const PAGE_LEVEL_ISSUES_HEADING = "Page-Level Issues";

/** Equal to `SECTION_INTROS.pageLevelIssues` in lib/report/reportSections.ts. */
export const PAGE_LEVEL_ISSUES_INTRO =
  "These issues were found on individual pages. Each one explains what was found, where, why it matters and what to do about it. The count beside each issue shows how many of the pages we checked it was found on.";

/** Printed instead of cards when no page could be read (CP3-Q9). */
export const NO_PAGE_READ_SENTENCE = "No page could be read, so no page-level checks were made.";

/**
 * The redesigned Page-Level Issues section (CP1 F1, CP3 step 4a).
 *
 * PRINTED. Since CP3 step 4b, `shell.ts` prints this section in place of
 * `findingsHtml` above.
 *
 * THE SAME GROUPS AND THE SAME CARDS, drawn by the same `group` helper as
 * every other findings section, in the order the model gave them.
 *
 * NO SPEED GROUP. Speed findings are printed straight after the Speed section
 * (CP3 revision 9 §1.18), so they are never shown here as well.
 *
 * A CERTIFICATE FAILURE READ NO PAGE. Its section says so in the approved
 * words (Q9) and carries no card -- and no introduction, which speaks of
 * issues found on pages. That case is told apart by the model's own
 * certificate-failure statuses, never by any printed text.
 *
 * NOTHING AT ALL FOR A WHOLE-SITE AUDIT WITH NO PAGE FINDING (D1). An empty
 * section is omitted, and no "no issues" sentence is made up for it.
 */
export function pageLevelIssuesHtml(doc: PdfDocument): string {
  if (doc.certificateFailureAreas !== null) {
    return (
      `<section class="findings page-level-issues">` +
      html`<h2>${PAGE_LEVEL_ISSUES_HEADING}</h2>` +
      html`<p>${NO_PAGE_READ_SENTENCE}</p>` +
      `</section>`
    );
  }

  const groups = doc.pageFindings.groups.filter(
    (one) => one.category !== "speed" && one.findings.length > 0,
  );
  if (groups.length === 0) return "";

  return (
    `<section class="findings page-level-issues">` +
    html`<h2>${PAGE_LEVEL_ISSUES_HEADING}</h2>` +
    html`<p class="lead">${PAGE_LEVEL_ISSUES_INTRO}</p>` +
    groups.map((one) => group(one, doc.labels)).join("") +
    `</section>`
  );
}
