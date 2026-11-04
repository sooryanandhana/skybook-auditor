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
 * WHAT ONE FINDING SHOWS, in this order: the title, a severity chip carrying
 * the word as well as the colour, the scope spelled out, the reach for page
 * findings only, what we found, what this means, why it matters, how it may
 * affect the website or business, what to do (labelled and set apart), the
 * steps, who usually fixes it, the evidence panel and the affected pages.
 *
 * NO AI WRITING ON A CARD. Every word here is either measured or fixed,
 * reviewed report text. The model's per-finding commentary is not printed in
 * the PDF, even when the audit carries some: a card explains its finding once,
 * completely, in words a person approved.
 */
import type {
  PdfAffectedPage,
  PdfFinding,
  PdfFindingGroup,
  PdfFindingSection,
  PdfLabels,
} from "../pdfDocument.ts";
import { html } from "./escape.ts";

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
 * Scope, and reach for the findings that have one.
 *
 * A SITE FINDING IS NEVER GIVEN A DENOMINATOR. 7A §8 forbids it outright: one
 * certificate, one SPF record and one robots.txt are facts about a domain, and
 * "128 of 128 pages affected" about a single DNS record is a false statement
 * rather than a display quirk. 7B leaves `reach` null for those, and a null
 * reach renders no line rather than an invented one.
 */
function meta(finding: PdfFinding): string {
  const reach = finding.reach === null ? "" : html`<span class="reach">${finding.reach}</span>`;

  return (
    `<p class="finding-meta">` +
    html`<span class="scope">${finding.scopeLabel}</span>` +
    reach +
    `</p>`
  );
}

/**
 * The affected pages, when the finding names any.
 *
 * A SAMPLE THAT SAYS SO. The aggregator caps the list at fifty, and 7A §8
 * requires the document to say so whenever the list is shorter than the true
 * total. `affectedNote` carries that sentence; without it the reader would
 * take fifty as the answer to "how many pages".
 *
 * SET AS RUNNING TEXT, NOT A STACKED LIST. Fifty addresses one per line, on
 * twenty-four page findings, is most of a report. Run together they are a few
 * paragraphs. The list is still a real list in the markup, because it is one,
 * and 7A §24 asks for a document a screen reader can follow.
 */
function affected(finding: PdfFinding, pages: readonly PdfAffectedPage[]): string {
  if (pages.length === 0) return "";

  const items = pages.map((page) => html`<li>${page.url}</li>`).join("");
  const note =
    finding.affectedNote === null ? "" : html`<p class="note">${finding.affectedNote}</p>`;

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

/** The practical steps and who usually does the work, after what to do. */
function howToFix(finding: PdfFinding): string {
  const written = finding.explainer;
  if (written === null) return "";
  return (
    `<div class="explainer explainer-steps">` +
    `<p class="explainer-label">Steps</p>` +
    `<ol>` +
    written.steps.map((step) => html`<li>${step}</li>`).join("") +
    `</ol>` +
    html`<p class="who-fixes"><span class="explainer-label">Who usually fixes it:</span> ${written.whoFixes}</p>` +
    `</div>`
  );
}

/**
 * The measured rows behind the finding, as a small table. The same rows, from
 * the same builders, as the measured-facts tables, so the two cannot disagree.
 */
function evidencePanel(finding: PdfFinding): string {
  const panel = finding.evidencePanel;
  if (panel === null || panel.facts.length === 0) return "";
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
    html`<p class="explainer-label">Evidence · ${panel.heading}</p>` +
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
