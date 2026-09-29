/**
 * Recommended actions: the report's findings, distilled to what to do about them.
 *
 * A CONSOLIDATED VIEW OF WHAT THE DOCUMENT ALREADY SAYS. Every action here is a
 * finding's own remediation -- the measured, rule-authored action that also sits
 * on the finding above -- gathered into one checklist so a reader who has read
 * the detail can act from a single list. Where a validated model answer carried
 * a recommendation, it follows, labelled as the model's. Nothing new is decided:
 * this section adds, compares and invents nothing, and renders the findings in
 * the exact order the aggregator gave them, worst first.
 *
 * MEASURED ACTION FIRST, AI SECOND. The rule's remediation leads because it is
 * ours and it is exact; the model's suggested next step follows and is labelled,
 * so the order on the page matches the order of authority -- what we advise, then
 * what a model added to it.
 *
 * ABSENT WHEN THERE IS NOTHING TO DO. An audit that found nothing has no actions,
 * so the section is omitted entirely rather than left saying so.
 */
import type { PdfFinding, PdfFindingSection, PdfLabels } from "../pdfDocument.ts";
import { html } from "./escape.ts";

const RECOMMEND_HEADING = "Recommended actions";

/** Every finding across the section's groups, in the order they were given. */
function findingsOf(section: PdfFindingSection): readonly PdfFinding[] {
  return section.groups.flatMap((group) => group.findings);
}

/** One action: the severity, the finding it addresses, the measured step, then the model's. */
function action(finding: PdfFinding, labels: PdfLabels): string {
  const ai =
    finding.commentary === null
      ? ""
      : html`<p class="recommend-ai"><span class="recommend-ai-label">${labels.aiRecommendation}</span> ${finding.commentary.recommendation}</p>`;

  return (
    `<li class="recommend-item">` +
    `<div class="recommend-head">` +
    html`<span class="chip chip-${finding.severity}">${finding.severityLabel}</span>` +
    html`<span class="recommend-title">${finding.title}</span>` +
    `</div>` +
    html`<p class="recommend-action">${finding.remediation}</p>` +
    ai +
    `</li>`
  );
}

/**
 * The whole section, or nothing at all.
 *
 * Site-wide actions come before page-level ones, the same precedence the
 * findings use: one broken certificate outranks a missing description on nine
 * pages, whatever the counts say.
 */
export function recommendationsHtml(
  site: PdfFindingSection,
  page: PdfFindingSection,
  labels: PdfLabels,
): string {
  const findings = [...findingsOf(site), ...findingsOf(page)];
  if (findings.length === 0) return "";

  return (
    `<section class="recommend">` +
    `<h2>${RECOMMEND_HEADING}</h2>` +
    `<ol class="recommend-list">` +
    findings.map((finding) => action(finding, labels)).join("") +
    `</ol>` +
    `</section>`
  );
}
