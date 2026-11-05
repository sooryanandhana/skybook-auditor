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
import type {
  AreaStatus,
  ClientAiSummary,
  PdfCoverage,
  PdfDocument,
  PdfFindingSection,
  PdfImprovement,
  PdfImprovementDestination,
  PdfScore,
  PdfScoreCategory,
  PdfSummary,
} from "../pdfDocument.ts";
import { AREA_STATUS_LABEL_TEXT, CATEGORY_SECTION_HEADINGS, FILE_ABSENT_SENTENCES } from "./categorySections.ts";
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

// ===========================================================================
// The redesigned Executive Summary (CP1 F2, CP3 step 3b-ii)
//
// NOT YET PRINTED. `executiveSummarySectionHtml` is complete and tested, but
// nothing in the document calls it until the shell is rewired in CP3 step 4.
// Until then the report prints `executiveSummaryHtml` above, unchanged.
//
// IT MEASURES NOTHING AND DECIDES NOTHING. Every grade, count, status, title,
// destination and sentence of the audit's own comes from the document model;
// this code chooses only the approved wording (CP1 §5.2, CP3 revision 9 §3,
// decisions B1–B17, K1–K4, W1–W3) and the order. No AI is asked anything here.
//
// THE WORDING IS COPIED HERE, NOT IMPORTED, for the same reason as in
// categorySections.ts: renderer files may import only from this folder and the
// document model. executiveSummary.test.mts holds each copy equal to its
// report-layer original, and pins the rest literally.
// ===========================================================================

type Category = PdfImprovement["category"];
type MeasuredSpeed = Extract<PdfDocument["speed"], { measured: true }>;

/** The section's printed heading (CP1 §4). */
export const EXEC_SUMMARY_HEADING = "Executive Summary";

/** Each category's short name, in the tiles and the improvements list (B4, K3). */
export const CATEGORY_NAMES: Readonly<Record<Category, string>> = {
  security: "Security",
  seo: "SEO",
  speed: "Speed",
  technical: "Technical",
};

/** Where each improvement is explained, by the model's destination key (U6, K1, K3). */
export const DESTINATION_NAMES: Readonly<Record<PdfImprovementDestination, string>> = {
  "page-level": "Page-Level Issues",
  "security-audit": CATEGORY_SECTION_HEADINGS.security,
  "technical-audit": CATEGORY_SECTION_HEADINGS.technical,
  // R1 Option A: the Speed section keeps its printed heading "Speed"; the
  // approved pointer text is kept, and the mismatch is accepted (K1).
  speed: "Speed & Performance",
};

/** The Speed tile when no Speed check was expected at all (CP3-Q23). */
export const SPEED_NOT_GRADED_TILE = "Speed: Not graded — no Speed-check results were available for this report.";

/** Below the category tiles, once, when at least one tile shows a run count (Q25, N2, C4). */
export const CHECKS_COUNTED_SENTENCE =
  "The checks counted as run include both checks that passed and checks that found issues.";

export const NO_ISSUES_VERDICT = "The audit found no issues in the checks that could be run.";

export const AREAS_HEADING_NEW = "What we checked and why it matters";
export const AREA_SUB_LABELS = {
  whatItIs: "What it is",
  whyItMatters: "Why it matters",
  whatWeChecked: "What we checked",
  whatWeFound: "What we found",
} as const;

/** The four area blocks' headings (CP1 §5.2). */
export const AREA_HEADINGS = {
  seo: "Search visibility (SEO)",
  security: "Security",
  speed: "Speed and performance",
  technical: "Technical setup",
} as const;

type AreaKey = keyof typeof AREA_HEADINGS;

/** Equal to `AREA_TEXTS` in lib/report/reportSections.ts. */
export const AREA_FIXED_TEXTS: Readonly<Record<AreaKey, { whatItIs: string; whyItMatters: string; whatWeChecked: string }>> = {
  seo: {
    whatItIs:
      "Search visibility, often called SEO, is how clearly your pages describe themselves to search engines such as Google and to the people who find them there.",
    whyItMatters:
      "When pages have clear titles, descriptions, headings and a stated preferred address, search engines can understand and present them more accurately, and visitors can see quickly that a page is relevant to them.",
    whatWeChecked:
      "Page titles, the descriptions shown in search results, main headings and heading order, the preferred-address (canonical) setting, the declared language, the mobile display setting, and image descriptions, on every page we could read.",
  },
  security: {
    whatItIs:
      "Website security covers how safely your site is delivered to visitors and how well your domain is protected from being misused, including in email.",
    whyItMatters:
      "Visitors and browsers look for signs that a site is genuine and that information sent to it is protected. A missing safeguard does not mean a site has been attacked, but it leaves fewer layers of protection in place.",
    whatWeChecked:
      "The secure (HTTPS) connection and its certificate, the protective instructions the site sends to browsers, how forms and files are loaded, cookie protection where cookies are used, and the domain's email-authentication records.",
  },
  speed: {
    whatItIs:
      "Speed and performance describe how quickly your pages appear and respond for visitors on a mobile phone.",
    whyItMatters:
      "Visitors judge a site partly by how quickly it loads. Slow pages can lead some visitors to leave before they see what you offer.",
    whatWeChecked:
      "Google's records of real visits to the page where available, and a simulated test of the page on a mobile phone. A desktop measurement is shown for information and does not affect the grade.",
  },
  technical: {
    whatItIs:
      "Technical setup covers the instructions your site gives to search engines and how easily its pages can be found and read.",
    whyItMatters:
      "If search engines are told not to visit a site, or cannot find its pages, those pages may be missing from search results.",
    whatWeChecked:
      "The robots.txt file (the site's instructions to search engines), whether a sitemap (a list of the site's pages for search engines) is published, and how many of the pages we found could be read.",
  },
};

export const SEO_NO_ISSUES = "No search-visibility issues were found on the pages where these checks could run.";
/** CP3-Q2b. */
export const SECURITY_NO_ISSUES = "No Security issues were found in the checks that could be completed.";

/** "{n} {issue/issues} found: {titles}. {tail}" (CP1 §5.2, S3-D5); titles joined with "; " (W1). */
export function issuesFoundSentence(titles: readonly string[], tail: string): string {
  const noun = titles.length === 1 ? "issue" : "issues";
  return `${titles.length} ${noun} found: ${titles.join("; ")}. ${tail}`;
}
export const SEO_ISSUES_TAIL = "Each is explained under Page-Level Issues.";
export const SECURITY_ISSUES_TAIL = "Each is explained under Page-Level Issues and Security Audit.";

/** A Technical finding in the Technical "What we found" (B9). */
export function technicalFindingLine(title: string): string {
  return `${title}. It is explained under Technical Audit.`;
}

/** Speed with Google's overall real-visitor rating (B1, K1). */
export function speedRatedSentence(overall: string): string {
  return `Based on Google's records of real visits, Google rates this page's speed as ${overall}. Details are in Speed & Performance.`;
}
/** Real-visitor data without an overall rating (B2, word for word). */
export const SPEED_FIELD_NO_RATING = "Google real-visitor data is available, but an overall rating is not provided.";
export const SPEED_LAB_AVAILABLE = "A simulated lab score is available.";
/** A simulated test only (CP1 §5.2). */
export function speedSimulatedSentence(score: number): string {
  return `Google has no real-visitor data for this page, so speed was judged from one simulated test, which scored ${score} out of 100. Details are in Speed & Performance.`;
}
/** Speed not measured, for any reason (CP1 §5.2; CP3-Q22). */
export const SPEED_NOT_MEASURED = "Speed could not be measured for this report.";

/** Equal to `AI_SUMMARY_LABEL` in lib/report/reportSections.ts (D5). */
export const AI_PARAGRAPH_LABEL =
  "Written by AI from the verified findings in this report. Every finding, severity and figure was measured by the audit itself.";
export const AI_PARAGRAPH_HEADING = "What these findings mean for your website and business";
export const IMPROVEMENTS_HEADING = "Improvements that deserve attention";
export const STRENGTHS_HEADING = "What is working well";

/** Equal to `robotsExclusionSentence` in lib/report/reportSections.ts (X1, counts reconciled). */
export function robotsExcludedSentence(excluded: number): string {
  return excluded === 1
    ? "A further 1 address was not visited because the site's robots.txt asks automated tools not to."
    : `A further ${excluded} addresses were not visited because the site's robots.txt asks automated tools not to.`;
}
/** Equal to `ROBOTS_EXCLUSION_UNCOUNTED` in lib/report/reportSections.ts (X1, counts not reconciled). */
export const ROBOTS_EXCLUDED_UNCOUNTED =
  "Some addresses were not visited because the site's robots.txt asks automated tools not to.";

// ---------------------------------------------------------------------------
// The parts, in order
// ---------------------------------------------------------------------------

/** The verdict (CP1 §5.2, B3, B14), then the score's own notes and gate list (B5). */
function verdictHtml(doc: PdfDocument): string {
  const { score } = doc;
  const first =
    score.graded && score.grade !== null
      ? `Overall grade: ${score.grade}${score.bandLabel === null ? "" : ` (${score.bandLabel})`}, ` +
        `based on ${score.ranCount} of ${score.expectedCount} checks that could be run.`
      : (score.statusMessage ?? "");

  const counts = doc.summary.severityCounts.filter((entry) => entry.count > 0);
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const second =
    total === 0
      ? NO_ISSUES_VERDICT
      : `The audit found ${total} ${total === 1 ? "issue that needs" : "issues that need"} attention: ` +
        `${counts.map((entry) => `${entry.count} ${entry.label}`).join(", ")}.`;

  const notes = [score.capNote, score.partialNote]
    .filter((note): note is string => note !== null && note !== "")
    .map((note) => html`<p class="exec-note">${note}</p>`)
    .join("");

  return html`<p class="exec-verdict">${first === "" ? second : `${first} ${second}`}</p>` + notes + gateHtml(score);
}

/** The two overall figures (CP3 revision 9, §3.1). */
function overallFiguresHtml(score: PdfScore): string {
  const passed = score.passRate === null ? "" : html`<li>Weighted checks passed: ${score.passRate}/100</li>`;
  return (
    `<ul class="exec-figures">` +
    passed +
    html`<li>Checks that could be run: ${score.ranCount} of ${score.expectedCount}</li>` +
    `</ul>`
  );
}

/** One category tile (D1, U3, Q23, Q24, Q26, W2). */
function tileHtml(category: PdfScoreCategory): string {
  const name = CATEGORY_NAMES[category.category];
  if (category.assessed) {
    const total = category.ranCount + category.skippedCount;
    const sentence = `${name}: ${category.grade}, based on ${category.ranCount} of ${total} ${total === 1 ? "check" : "checks"}.`;
    return (
      `<li class="exec-tile">` +
      html`<span class="exec-tile-text">${sentence}</span>` +
      html`<span class="exec-tile-rate">${category.passRate}%</span>` +
      `</li>`
    );
  }
  const sentence =
    category.category === "speed" && category.skippedCount === 0
      ? SPEED_NOT_GRADED_TILE
      : `${name}: Not graded, no checks could run.`;
  return html`<li class="exec-tile exec-tile-ungraded">${sentence}</li>`;
}

/** The category tiles, then the Q25 sentence once when any tile shows a run count. */
function tilesHtml(score: PdfScore): string {
  if (score.categories.length === 0) return "";
  const counted = score.categories.some((category) => category.assessed)
    ? html`<p class="exec-note">${CHECKS_COUNTED_SENTENCE}</p>`
    : "";
  return `<ul class="exec-tiles">` + score.categories.map(tileHtml).join("") + `</ul>` + counted;
}

/**
 * Each area's status: from the overall summary, or from the certificate-failure
 * statuses when there is none. Read, never worked out.
 */
function statusesOf(doc: PdfDocument): Readonly<Record<AreaKey, AreaStatus | null>> {
  const summary = doc.overallSummary;
  if (summary !== null) {
    const of = (key: "seo" | "speed" | "site") => summary.areas.find((area) => area.key === key)?.status ?? null;
    return { seo: of("seo"), security: summary.securityStatus, speed: of("speed"), technical: of("site") };
  }
  const failure = doc.certificateFailureAreas;
  if (failure !== null) return { ...failure };
  return { seo: null, security: null, speed: null, technical: null };
}

/** The improvements of one category, in model order. */
function titlesIn(doc: PdfDocument, category: Category): string[] {
  return doc.improvements.filter((item) => item.category === category).map((item) => item.title);
}

/** The Speed sentence(s), chosen only from the measured speed fields (B1, B2, Q22, K2). */
function speedFound(speed: PdfDocument["speed"]): string[] {
  if (!speed.measured) return [SPEED_NOT_MEASURED];
  const measured: MeasuredSpeed = speed;
  if (measured.fieldAvailable && measured.overall !== null) return [speedRatedSentence(measured.overall)];
  if (measured.fieldAvailable) {
    return measured.labScore === null ? [SPEED_FIELD_NO_RATING] : [SPEED_FIELD_NO_RATING, SPEED_LAB_AVAILABLE];
  }
  if (measured.labScore !== null) return [speedSimulatedSentence(measured.labScore)];
  return [SPEED_NOT_MEASURED];
}

/**
 * "What we found" for one area, or nothing.
 *
 * B8, AS LIMITED BY K2: an SEO, Security or Technical area that was not measured
 * has no "What we found" at all. Speed always says what happened, including
 * that it could not be measured.
 */
function foundSentences(doc: PdfDocument, key: AreaKey, status: AreaStatus | null): string[] {
  if (key === "speed") return speedFound(doc.speed);
  if (status === "not-measured") return [];

  if (key === "seo") {
    const titles = titlesIn(doc, "seo");
    return [titles.length > 0 ? issuesFoundSentence(titles, SEO_ISSUES_TAIL) : SEO_NO_ISSUES];
  }
  if (key === "security") {
    const titles = titlesIn(doc, "security");
    return [titles.length > 0 ? issuesFoundSentence(titles, SECURITY_ISSUES_TAIL) : SECURITY_NO_ISSUES];
  }
  // Technical (Q2c): the absence sentences and the findings; no generic sentence.
  const files = doc.technicalFiles;
  return [
    ...(files?.robots === "absent" ? [FILE_ABSENT_SENTENCES.robots] : []),
    ...(files?.sitemap === "absent" ? [FILE_ABSENT_SENTENCES.sitemap] : []),
    ...titlesIn(doc, "technical").map(technicalFindingLine),
  ];
}

/**
 * One area block: the heading; the introductory texts (what it is, why it
 * matters, what we checked); then the status alone on its own line, with no
 * prefix (W3, after the 3a-Q10 pattern); then what was found, where there is
 * anything to say.
 */
function areaBlockHtml(doc: PdfDocument, key: AreaKey, status: AreaStatus | null): string {
  const fixed = AREA_FIXED_TEXTS[key];
  const found = foundSentences(doc, key, status);
  const part = (label: string, text: string) =>
    html`<p><span class="exec-area-label">${label}</span><br>${text}</p>`;

  return (
    `<div class="exec-area">` +
    html`<h3>${AREA_HEADINGS[key]}</h3>` +
    part(AREA_SUB_LABELS.whatItIs, fixed.whatItIs) +
    part(AREA_SUB_LABELS.whyItMatters, fixed.whyItMatters) +
    part(AREA_SUB_LABELS.whatWeChecked, fixed.whatWeChecked) +
    (status === null ? "" : html`<p class="section-status">${AREA_STATUS_LABEL_TEXT[status]}</p>`) +
    (found.length === 0 ? "" : part(AREA_SUB_LABELS.whatWeFound, found.join(" "))) +
    `</div>`
  );
}

function areasHtml(doc: PdfDocument): string {
  const statuses = statusesOf(doc);
  const keys: readonly AreaKey[] = ["seo", "security", "speed", "technical"];
  return (
    `<div class="exec-areas-new">` +
    html`<h3 class="sub">${AREAS_HEADING_NEW}</h3>` +
    keys.map((key) => areaBlockHtml(doc, key, statuses[key])).join("") +
    `</div>`
  );
}

/** The validated AI paragraph under its label (D5, Q8, B15); nothing when there is none. */
function aiParagraphHtml(doc: PdfDocument): string {
  const text = doc.clientSummary.overallSummary;
  if (text === null) return "";
  return (
    `<div class="exec-ai">` +
    html`<h3 class="sub">${AI_PARAGRAPH_HEADING}</h3>` +
    html`<p class="ai-label">${AI_PARAGRAPH_LABEL}</p>` +
    html`<p>${text}</p>` +
    `</div>`
  );
}

/** Every problem finding, in the model's order, with its area and destination (CP1 §5.2, K3). */
function improvementsHtml(doc: PdfDocument): string {
  if (doc.improvements.length === 0) return "";
  const items = doc.improvements
    .map(
      (item) =>
        html`<li><strong>${item.title}</strong>: ${item.severityLabel} · ${CATEGORY_NAMES[item.category]}. ` +
        html`See ${DESTINATION_NAMES[item.destination]}.</li>`,
    )
    .join("");
  return `<div class="exec-improvements">` + html`<h3 class="sub">${IMPROVEMENTS_HEADING}</h3>` + `<ol>${items}</ol></div>`;
}

/** The count-safe strengths from the overall summary; nothing when there are none. */
function strengthsHtml(doc: PdfDocument): string {
  const strengths = doc.overallSummary?.strengths ?? [];
  if (strengths.length === 0) return "";
  return (
    `<div class="exec-strengths">` +
    html`<h3 class="sub">${STRENGTHS_HEADING}</h3>` +
    `<ul>${strengths.map((strength) => html`<li>${strength}</li>`).join("")}</ul>` +
    `</div>`
  );
}

/** The R3 coverage sentence, from reconciled counts only (R3, B7). */
function coverageSentence(counts: NonNullable<PdfDocument["coverageCounts"]>): string {
  const parts = [`${counts.evaluated} ${counts.evaluated === 1 ? "page was" : "pages were"} read and checked`];
  if (counts.unavailable > 0) parts.push(`${counts.unavailable} could not be read`);
  if (counts.notWebPages > 0) {
    parts.push(`${counts.notWebPages} ${counts.notWebPages === 1 ? "was not a web page" : "were not web pages"}`);
  }
  if (counts.notVisited > 0) {
    parts.push(`${counts.notVisited} ${counts.notVisited === 1 ? "was" : "were"} not visited before the audit stopped`);
  }
  const found = `${counts.discovered} ${counts.discovered === 1 ? "address" : "addresses"}`;
  const start = counts.includesStartingAddress ? ", including the starting address" : "";
  return `We found ${found} on this website${start}: ${parts.join(", ")}.`;
}

/**
 * How much of the site was covered (R3, X1, S1, B6, K4).
 *
 * Figures only from counts that reconciled. A whole-site crawl that stopped
 * short adds its own stop reason; a certificate failure read no page and has
 * no crawl stop reason to give, so none is shown for it.
 */
function coverageHtml(doc: PdfDocument): string {
  const sentences: string[] = [];
  const counts = doc.coverageCounts;
  if (counts !== null) {
    sentences.push(coverageSentence(counts));
    if (counts.robotsExcluded > 0) sentences.push(robotsExcludedSentence(counts.robotsExcluded));
  } else if (doc.coverageFlags.hasExclusions) {
    sentences.push(ROBOTS_EXCLUDED_UNCOUNTED);
  }
  const wholeSite = doc.certificateFailureAreas === null;
  if (wholeSite && doc.coverage.partial && doc.coverage.stopReason !== null && doc.coverage.stopReason !== "") {
    sentences.push(doc.coverage.stopReason);
  }
  if (sentences.length === 0) return "";
  return `<div class="exec-coverage">` + sentences.map((sentence) => html`<p>${sentence}</p>`).join("") + `</div>`;
}

/**
 * The redesigned Executive Summary (CP1 F2), as one numbered section.
 *
 * NOT WIRED: `shell.ts` still prints `executiveSummaryHtml`. CP3 step 4 swaps
 * them.
 */
export function executiveSummarySectionHtml(doc: PdfDocument): string {
  return (
    `<section class="exec-summary">` +
    html`<h2>${EXEC_SUMMARY_HEADING}</h2>` +
    verdictHtml(doc) +
    overallFiguresHtml(doc.score) +
    tilesHtml(doc.score) +
    areasHtml(doc) +
    aiParagraphHtml(doc) +
    improvementsHtml(doc) +
    strengthsHtml(doc) +
    coverageHtml(doc) +
    `</section>`
  );
}
