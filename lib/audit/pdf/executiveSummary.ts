/**
 * The executive summary: the measured verdict, on the first page after the cover.
 *
 * MEASURED, NOT WRITTEN. Every value here is read from the deterministic score,
 * the severity split, the coverage the crawl counted and the findings
 * themselves. Nothing is calculated, graded or phrased here; the model's account
 * of the audit is a separate section further down, labelled as its own. This is
 * the "measure with code" half of the report opening the document, before the
 * "explain with AI" half.
 *
 * ONE PAGE, READ TOP TO BOTTOM, in the order a reader's questions arrive:
 *
 *   how did it do      the grade, in the one dark card, with the figures it
 *                      rests on beside it
 *   how bad            the severity split, one card each
 *   where              the four areas, one card each
 *   what does it mean  the score's own sentences and how much was read
 *   what first         the highest-priority improvements, set apart in a panel
 *   what else          every area that has something to fix, and what
 *
 * SCOPE IS STATED UP FRONT. How much of the site was read sits on this page, and
 * the partial and cap notes are said out loud rather than hidden. A partial
 * crawl is never presented here as a whole-site audit.
 *
 * WORD BEFORE COLOUR. The grade is a letter and a band word; a severity is a
 * number and its name. On the dark card the grade is set in white rather than
 * tinted, because the severity colours are chosen for white paper and the
 * meaning is already carried in words.
 *
 * NOTHING IS INVENTED TO FILL A CARD. A figure the audit did not produce has no
 * card: an ungraded audit shows "Not graded" and its reason, never a letter, and
 * a pass rate that does not exist is left out rather than shown as zero.
 */
import type { ClientAiSummary, PdfCoverage, PdfFindingSection, PdfScore, PdfSummary } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { gateHtml, scoreCategoriesHtml } from "./score.ts";
import { severityTilesHtml } from "./summary.ts";

const EXEC_HEADING = "Executive summary";
const CONDITION_HEADING = "Overall condition";
const PRIORITIES_HEADING = "Highest-priority improvements";
const AREAS_HEADING = "Main areas for improvement";

/** What the executive summary reads. All of it measured; none of it a model's. */
export interface ExecutiveSummaryInput {
  readonly score: PdfScore;
  readonly summary: PdfSummary;
  readonly coverage: PdfCoverage;
  /** The prioritised steps the report layer derived from severity. */
  readonly nextSteps: ClientAiSummary["nextSteps"];
  readonly siteFindings: PdfFindingSection;
  readonly pageFindings: PdfFindingSection;
}

/** One figure in a card: the number, an optional unit after it, and its label. */
function metric(value: string, unit: string, label: string, lead = false): string {
  return (
    `<div class="metric${lead ? " metric-lead" : ""}">` +
    html`<span class="metric-num">${value}` +
    (unit === "" ? "" : html`<span class="metric-of">${unit}</span>`) +
    `</span>` +
    html`<span class="metric-label">${label}</span>` +
    `</div>`
  );
}

/**
 * The first row: the grade, then the figures it rests on.
 *
 * The grade leads: a letter with its band word, or a plain "Not graded" when
 * the audit assessed too little to grade honestly. The pass rate has a card only
 * when there is one.
 */
function metricsRow(score: PdfScore): string {
  const grade =
    score.grade !== null
      ? metric(score.grade, "", score.bandLabel === null ? "Overall grade" : `Overall grade · ${score.bandLabel}`, true)
      : `<div class="metric metric-lead">` +
        `<span class="metric-num metric-text">Not graded</span>` +
        `<span class="metric-label">Overall grade</span>` +
        `</div>`;

  const passed = score.passRate === null ? "" : metric(String(score.passRate), "/ 100", "Weighted checks passed");
  const assessed = metric(`${score.coveragePercent}%`, "", "Applicable checks assessed");

  return `<div class="metrics">` + grade + passed + assessed + `</div>`;
}

/**
 * What the figures mean: the score's own sentences, and how much was read.
 *
 * Each sentence was phrased by the report layer. They are set out here one to a
 * paragraph, with the findings that cap the grade listed beneath when there are
 * any.
 */
function condition(input: ExecutiveSummaryInput): string {
  const { score } = input;
  const sentences = [input.coverage.headline, score.statusMessage, score.partialNote, score.capNote]
    .filter((sentence): sentence is string => sentence !== null && sentence !== "")
    .map((sentence) => html`<p>${sentence}</p>`)
    .join("");

  return `<div class="exec-condition">` + `<h3 class="sub">${CONDITION_HEADING}</h3>` + sentences + gateHtml(score) + `</div>`;
}

/**
 * What to do first, set apart in a panel.
 *
 * The steps come from the report layer, which orders the findings worst first.
 * There is always at least one: with nothing to fix, it says so.
 */
function priorities(nextSteps: readonly string[]): string {
  if (nextSteps.length === 0) return "";

  return (
    `<div class="panel">` +
    `<h3 class="panel-label">${PRIORITIES_HEADING}</h3>` +
    `<ol>` +
    nextSteps.map((step) => html`<li>${step}</li>`).join("") +
    `</ol>` +
    `</div>`
  );
}

/**
 * Every area with something to fix, and what: the area in bold, then the titles
 * of its findings.
 *
 * THE FINDINGS' OWN TITLES, IN THE FINDINGS' OWN ORDER. A category that appears
 * both site-wide and page-level is listed once, with the site-wide findings
 * first, exactly as the sections further down run. Nothing is counted, ranked or
 * reworded here. With no findings there is no list; the summary's own sentence
 * has already said the audit was clean.
 */
function areas(site: PdfFindingSection, page: PdfFindingSection): string {
  const byArea = new Map<string, string[]>();
  for (const group of [...site.groups, ...page.groups]) {
    const titles = byArea.get(group.label) ?? [];
    for (const finding of group.findings) titles.push(finding.title);
    byArea.set(group.label, titles);
  }

  const items = [...byArea.entries()]
    .filter(([, titles]) => titles.length > 0)
    .map(([label, titles]) => html`<li><strong>${label}.</strong> ${titles.join("; ")}.</li>`)
    .join("");

  if (items === "") return "";

  return `<div class="exec-areas">` + `<h3 class="sub">${AREAS_HEADING}</h3>` + `<ol>${items}</ol>` + `</div>`;
}

/** The whole section. */
export function executiveSummaryHtml(input: ExecutiveSummaryInput): string {
  const lede =
    input.summary.stateSentence === "" ? "" : html`<p class="lead">${input.summary.stateSentence}</p>`;

  return (
    `<section class="exec">` +
    `<h2>${EXEC_HEADING}</h2>` +
    lede +
    metricsRow(input.score) +
    severityTilesHtml(input.summary) +
    scoreCategoriesHtml(input.score) +
    `<div class="exec-grid">` +
    condition(input) +
    priorities(input.nextSteps) +
    `</div>` +
    areas(input.siteFindings, input.pageFindings) +
    `</section>`
  );
}
