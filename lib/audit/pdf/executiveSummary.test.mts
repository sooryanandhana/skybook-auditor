/**
 * Tests for the executive summary.
 *
 * ONE PROPERTY CARRIES THIS FILE: everything on the report's first page is a
 * value the audit produced, set out and never worked out. The page a reader
 * trusts most is the one where an invented figure would do the most harm, so
 * each card is checked for the value it was given, and for its absence when
 * there was no value to give.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import { escapeHtml } from "./escape.ts";
import {
  AI_PARAGRAPH_HEADING,
  AI_PARAGRAPH_LABEL,
  AREA_FIXED_TEXTS,
  AREA_HEADINGS,
  AREA_SUB_LABELS,
  AREAS_HEADING_NEW,
  CATEGORY_NAMES,
  CHECKS_COUNTED_SENTENCE,
  DESTINATION_NAMES,
  EXEC_SUMMARY_HEADING,
  IMPROVEMENTS_HEADING,
  NO_ISSUES_VERDICT,
  ROBOTS_EXCLUDED_UNCOUNTED,
  SECURITY_ISSUES_TAIL,
  SECURITY_NO_ISSUES,
  SEO_ISSUES_TAIL,
  SEO_NO_ISSUES,
  SPEED_FIELD_NO_RATING,
  SPEED_LAB_AVAILABLE,
  SPEED_NOT_GRADED_TILE,
  SPEED_NOT_MEASURED,
  STRENGTHS_HEADING,
  executiveSummaryHtml,
  executiveSummarySectionHtml,
  issuesFoundSentence,
  robotsExcludedSentence,
  speedRatedSentence,
  speedSimulatedSentence,
  technicalFindingLine,
  type ExecutiveSummaryInput,
} from "./executiveSummary.ts";
import { AREA_STATUS_LABEL_TEXT } from "./categorySections.ts";
import { documentHtml } from "./shell.ts";
import { HOSTILE, SENTINEL, testDocument } from "./testDocument.fixture.mts";
import { runRealAudit, runRealCertificateFailure, type FakeSite } from "./realAudit.fixture.mts";
import {
  AI_SUMMARY_LABEL,
  AREA_TEXTS,
  ROBOTS_EXCLUSION_UNCOUNTED,
  robotsExclusionSentence,
} from "../../report/reportSections.ts";
import { AREA_STATUS_LABELS } from "../../report/overallSummary.ts";
import { createJobStore } from "../../jobs/jobStore.ts";
import {
  buildPdfDocument,
  type AreaStatus,
  type OverallSummary,
  type PdfDocument,
  type PdfFinding,
  type PdfFindingSection,
  type PdfImprovement,
} from "../pdfDocument.ts";
import type { ExplainResult } from "../../ai/gemini/explain.ts";
import type { AuditResult, SpeedResult } from "../../types.ts";

function input(over: Partial<ExecutiveSummaryInput> = {}): ExecutiveSummaryInput {
  const document = testDocument();
  return {
    score: document.score,
    summary: document.summary,
    coverage: document.coverage,
    nextSteps: document.clientSummary.nextSteps,
    siteFindings: document.siteFindings,
    pageFindings: document.pageFindings,
    ...over,
  };
}

const score = (over: Partial<ExecutiveSummaryInput["score"]> = {}) => ({ ...testDocument().score, ...over });
const countOf = (out: string, needle: string) => out.split(needle).length - 1;
const positionOf = (out: string, needle: string) => out.indexOf(needle);

/** A findings section holding the given titles under one category label. */
function sectionOf(label: string, titles: readonly string[]): PdfFindingSection {
  const base: PdfFinding = testDocument().siteFindings.groups[0].findings[0];
  return {
    heading: "H",
    intro: "I",
    count: titles.length,
    groups: [{ category: "security", label, findings: titles.map((title) => ({ ...base, title })) }],
  };
}

const NO_FINDINGS: PdfFindingSection = { heading: "H", intro: "I", count: 0, groups: [] };

// ---------------------------------------------------------------------------
// It is one section, and it opens the report
// ---------------------------------------------------------------------------

test("the executive summary is one section under one second-level heading", () => {
  const out = executiveSummaryHtml(input());

  assert.ok(out.startsWith('<section class="exec">'));
  assert.equal(countOf(out, "<h2>"), 1);
  assert.ok(out.includes("<h2>Executive summary</h2>"));
  assert.ok(!/<h[1456]\b/.test(out), "and nothing inside it skips a level");
});

test("the page runs in the order a reader's questions arrive", () => {
  const out = executiveSummaryHtml(input());

  assert.ok(positionOf(out, 'class="metrics"') < positionOf(out, 'class="tiles"'), "the grade, then how serious");
  assert.ok(positionOf(out, 'class="tiles"') < positionOf(out, 'class="score-cats"'), "then where");
  assert.ok(positionOf(out, 'class="score-cats"') < positionOf(out, "Overall condition"), "then what it means");
  assert.ok(positionOf(out, "Overall condition") < positionOf(out, "Highest-priority improvements"), "then what first");
  assert.ok(
    positionOf(out, "Highest-priority improvements") < positionOf(out, "Main areas for improvement"),
    "then everything else",
  );
});

// ---------------------------------------------------------------------------
// The grade and the figures it rests on
// ---------------------------------------------------------------------------

test("the grade leads, as a letter and a word", () => {
  const out = executiveSummaryHtml(input({ score: score({ grade: "C", bandLabel: "BANDWORD", passRate: 61 }) }));

  assert.ok(out.includes('<div class="metric metric-lead"><span class="metric-num">C</span>'), "the score's letter");
  assert.ok(out.includes("Overall grade · BANDWORD"), "and the score's own word for it");
  assert.equal(countOf(out, "metric-lead"), 1, "there is one dark card on the page");
});

test("the pass rate and the share of checks assessed are the score's own", () => {
  const out = executiveSummaryHtml(input({ score: score({ passRate: 61, coveragePercent: 47 }) }));

  assert.ok(out.includes('<span class="metric-num">61<span class="metric-of">/ 100</span></span>'));
  assert.ok(out.includes("Weighted checks passed"));
  assert.ok(out.includes('<span class="metric-num">47%</span>'));
  assert.ok(out.includes("Applicable checks assessed"));
});

test("an ungraded audit shows no letter and no pass rate", () => {
  // A letter here would be a verdict the audit did not reach.
  const out = executiveSummaryHtml(
    input({ score: score({ graded: false, grade: null, bandLabel: null, passRate: null, coveragePercent: 12 }) }),
  );

  assert.ok(out.includes("Not graded"));
  assert.ok(!out.includes("/ 100"), "no pass rate is invented");
  assert.ok(!out.includes("Weighted checks passed"), "and no card stands empty for one");
  assert.ok(!out.includes("null"));
  assert.ok(out.includes('<span class="metric-num">12%</span>'), "what was assessed is still stated");
});

test("a grade with no band word is still a grade", () => {
  const out = executiveSummaryHtml(input({ score: score({ grade: "B", bandLabel: null }) }));

  assert.ok(out.includes('<span class="metric-num">B</span>'));
  assert.ok(out.includes(">Overall grade<"));
  assert.ok(!out.includes("null"));
});

// ---------------------------------------------------------------------------
// The severity split and the four areas
// ---------------------------------------------------------------------------

test("every severity count is on the page as a number and a word", () => {
  const out = executiveSummaryHtml(input());

  for (const count of testDocument().summary.severityCounts) {
    assert.ok(out.includes(`<div class="tile tile-${count.severity}">`), `${count.label} has a tile`);
    assert.ok(out.includes(`<span class="tile-count">${count.count}</span>`));
    assert.ok(out.includes(`<span class="tile-label">${count.label}</span>`));
  }
});

test("each category of the score has a card, in the score's order", () => {
  const out = executiveSummaryHtml(input());
  const labels = testDocument().score.categories.map((category) => category.label);

  assert.equal(countOf(out, 'class="score-cat"'), labels.length);
  const positions = labels.map((label) => positionOf(out, `<span class="score-cat-label">${label}</span>`));
  assert.ok(positions.every((position) => position > -1));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("a category nothing could be checked for says so, and is never a zero", () => {
  const out = executiveSummaryHtml(input());

  assert.ok(testDocument().score.categories.some((category) => !category.assessed), "the fixture has one");
  assert.ok(out.includes('<span class="score-cat-na">Not assessed</span>'));
});

// ---------------------------------------------------------------------------
// What it means
// ---------------------------------------------------------------------------

test("the overall condition is the report layer's own sentences", () => {
  const out = executiveSummaryHtml(
    input({ score: score({ statusMessage: "STATUS SENTENCE.", partialNote: "PARTIAL SENTENCE.", capNote: "CAP SENTENCE." }) }),
  );

  assert.ok(out.includes(`<p>${escapeHtml(testDocument().coverage.headline)}</p>`), "how much was read");
  for (const sentence of ["STATUS SENTENCE.", "PARTIAL SENTENCE.", "CAP SENTENCE."]) {
    assert.ok(out.includes(`<p>${sentence}</p>`), `${sentence} is printed as given`);
  }
});

test("a partial audit says so on the first page", () => {
  // 7A §13: a partial crawl is never presented as a whole-site audit.
  const out = executiveSummaryHtml(input({ score: score({ partialNote: "Only part of the site was read." }) }));

  assert.ok(out.includes("Only part of the site was read."));
});

test("a sentence the score did not write leaves no empty paragraph", () => {
  const out = executiveSummaryHtml(input({ score: score({ statusMessage: null, partialNote: null, capNote: null }) }));

  assert.ok(!out.includes("<p></p>"));
  assert.ok(!out.includes("null"));
});

test("what holds the grade back is listed when something does, and absent when nothing does", () => {
  const held = executiveSummaryHtml(input({ score: score({ gateReasons: ["GATE ONE", "GATE TWO"], gateNote: "GATE NOTE." }) }));
  assert.ok(held.includes("<li>GATE ONE</li><li>GATE TWO</li>"));
  assert.ok(held.includes("GATE NOTE."));

  const free = executiveSummaryHtml(input({ score: score({ gateReasons: [], gateNote: null }) }));
  assert.ok(!free.includes('class="score-gate"'));
});

// ---------------------------------------------------------------------------
// What to do first
// ---------------------------------------------------------------------------

test("the highest-priority improvements are the report layer's steps, in its order", () => {
  const out = executiveSummaryHtml(input({ nextSteps: ["FIRST STEP.", "SECOND STEP.", "THIRD STEP."] }));

  assert.ok(out.includes('<div class="panel"><h3 class="panel-label">Highest-priority improvements</h3>'));
  assert.ok(out.includes("<ol><li>FIRST STEP.</li><li>SECOND STEP.</li><li>THIRD STEP.</li></ol>"));
});

test("with no steps there is no panel", () => {
  const out = executiveSummaryHtml(input({ nextSteps: [] }));

  assert.ok(!out.includes('class="panel"'));
  assert.ok(!out.includes("Highest-priority improvements"));
});

// ---------------------------------------------------------------------------
// Every area with something to fix
// ---------------------------------------------------------------------------

test("each area lists its findings' own titles, site-wide first", () => {
  const out = executiveSummaryHtml(
    input({
      siteFindings: sectionOf("Security", ["SITE TITLE A", "SITE TITLE B"]),
      pageFindings: sectionOf("Security", ["PAGE TITLE C"]),
    }),
  );

  assert.ok(
    out.includes("<li><strong>Security.</strong> SITE TITLE A; SITE TITLE B; PAGE TITLE C.</li>"),
    "one entry for the area, the titles verbatim and in order",
  );
  assert.equal(countOf(out, "<strong>Security.</strong>"), 1, "an area in both sections is listed once");
});

test("areas keep the order the findings arrive in", () => {
  const out = executiveSummaryHtml(
    input({ siteFindings: sectionOf("ZEBRA AREA", ["Z"]), pageFindings: sectionOf("ALPHA AREA", ["A"]) }),
  );

  assert.ok(positionOf(out, "ZEBRA AREA") < positionOf(out, "ALPHA AREA"), "never re-sorted");
});

test("an audit with no findings has no list of areas", () => {
  const out = executiveSummaryHtml(input({ siteFindings: NO_FINDINGS, pageFindings: NO_FINDINGS }));

  assert.ok(!out.includes("Main areas for improvement"));
  assert.ok(!out.includes('class="exec-areas"'));
});

test("the clean-state sentence is printed when the report layer chose one", () => {
  const sentence = "No issues found by the checks that were run.";
  const out = executiveSummaryHtml(
    input({ summary: { ...testDocument().summary, state: "clean", stateSentence: sentence } }),
  );

  assert.ok(out.includes(`<p class="lead">${sentence}</p>`));
});

// ---------------------------------------------------------------------------
// Measured, not written; text, not markup
// ---------------------------------------------------------------------------

test("nothing a model wrote is on this page", () => {
  const out = executiveSummaryHtml(input());

  assert.ok(!out.includes('class="ai"'));
  assert.ok(!out.includes("client-ai"));
  const written = testDocument().summary.ai?.executiveSummary;
  if (written !== undefined) assert.ok(!out.includes(written), "the model's summary has its own section");
});

test("no value becomes markup", () => {
  const out = executiveSummaryHtml(
    input({
      score: score({ bandLabel: HOSTILE, statusMessage: HOSTILE, gateReasons: [HOSTILE], gateNote: HOSTILE }),
      nextSteps: [HOSTILE],
      siteFindings: sectionOf(HOSTILE, [HOSTILE]),
      pageFindings: NO_FINDINGS,
    }),
  );

  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

// ===========================================================================
// CP3 step 3b-ii: the redesigned Executive Summary (CP1 F2)
// ===========================================================================

const doc = (over: Partial<PdfDocument> = {}) => testDocument(over);
const render = (over: Partial<PdfDocument> = {}) => executiveSummarySectionHtml(doc(over));

/** Markup to the text a reader sees. */
const textOf = (markup: string) =>
  markup
    .replace(/<br>/g, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The markup of one area block, by its heading. */
function areaBlock(out: string, heading: string): string {
  const start = out.indexOf(`<div class="exec-area"><h3>${escapeHtml(heading)}</h3>`);
  assert.ok(start >= 0, `the ${heading} block is drawn`);
  return out.slice(start, out.indexOf("</div>", start));
}
const foundIn = (block: string) => {
  const marker = `<span class="exec-area-label">${AREA_SUB_LABELS.whatWeFound}</span><br>`;
  const at = block.indexOf(marker);
  return at < 0 ? null : textOf(block.slice(at + marker.length, block.indexOf("</p>", at))).trim();
};
const statusIn = (block: string) => /<p class="section-status">([^<]*)<\/p>/.exec(block)?.[1] ?? null;
const coverageIn = (out: string) => {
  const at = out.indexOf(`<div class="exec-coverage">`);
  return at < 0 ? "" : out.slice(at, out.indexOf("</div>", at));
};

/** A hand-built overall summary with the given area statuses. */
function summaryWith(statuses: { seo: AreaStatus; speed: AreaStatus; site: AreaStatus; security: AreaStatus }, strengths: string[] = []): OverallSummary {
  const area = (key: "seo" | "speed" | "site", status: AreaStatus) =>
    ({ key, heading: key, status, statusLabel: AREA_STATUS_LABELS[status], paragraphs: [] });
  return {
    overview: [],
    areas: [area("speed", statuses.speed), area("seo", statuses.seo), area("site", statuses.site)],
    securityStatus: statuses.security,
    strengths,
    priorities: [],
    limitations: [],
    notChecked: [],
    help: { intro: "", items: [], closing: "" },
  };
}
const ALL_GOOD = { seo: "good", speed: "good", site: "good", security: "good" } as const;

/** A measured speed result with the given parts. */
function measuredSpeed(over: { fieldAvailable: boolean; overall: string | null; labScore: number | null }): PdfDocument["speed"] {
  return {
    measured: true, status: "checked", device: "Mobile",
    overall: over.overall, fieldAvailable: over.fieldAvailable, field: [],
    labAvailable: over.labScore !== null, labScore: over.labScore, lab: [], notInspected: [],
  };
}

function improvement(ruleId: string, title: string, category: PdfImprovement["category"], destination: PdfImprovement["destination"], severityLabel = "High"): PdfImprovement {
  return { ruleId, title, severityLabel, category, categoryLabel: category, destination };
}

/** The document for any finished real audit, through the production projection. */
function realDocument(audit: AuditResult): PdfDocument {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult, SpeedResult["data"]>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", audit);
  const outcome = buildPdfDocument(job.id, store);
  if (!outcome.ok) assert.fail(outcome.reason);
  return outcome.document;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
const WORDS = "We sell widgets to businesses across the country and have supplied, installed and maintained them since 1994.";
const SITE: FakeSite = {
  "https://example.com/": { html: page("Example Company", `<h1>Welcome</h1><p>${WORDS}</p><a href="/a">A</a> <a href="/b">B</a>`) },
  "https://example.com/a": { html: page("Page A", `<h1>Page A</h1><p>${WORDS}</p><a href="/">Home</a>`) },
  "https://example.com/b": { html: page("Page B", `<h1>Page B</h1><p>${WORDS}</p><a href="/">Home</a>`) },
};
const realAudits = (async () => {
  const valid = await runRealAudit({ site: SITE, checks: { spfMissing: true } });
  const failing = structuredClone(valid);
  failing.crawl.sources.html += 3; // breaks invariant I1
  failing.crawl.robots.excluded = 2;
  const certificate = await runRealCertificateFailure({
    site: { "https://example.com/": { html: "", unreadable: "The website's security certificate has expired.", certificateProblem: "expired" } },
    checks: { certificateExpired: true },
  });
  return { valid, failing, certificate };
})();

// ---------------------------------------------------------------------------
// Wording: copies equal to the report layer, the rest pinned literally
// ---------------------------------------------------------------------------

test("3b-ii wording copied from the report layer is equal to it", () => {
  assert.deepEqual(AREA_FIXED_TEXTS, AREA_TEXTS);
  assert.equal(AI_PARAGRAPH_LABEL, AI_SUMMARY_LABEL);
  for (const n of [1, 2, 37]) assert.equal(robotsExcludedSentence(n), robotsExclusionSentence(n));
  assert.equal(ROBOTS_EXCLUDED_UNCOUNTED, ROBOTS_EXCLUSION_UNCOUNTED);
  assert.deepEqual(AREA_STATUS_LABEL_TEXT, AREA_STATUS_LABELS);
});

test("3b-ii wording defined by CP1, revision 9 and B/K/W decisions, exactly", () => {
  assert.equal(EXEC_SUMMARY_HEADING, "Executive Summary");
  assert.deepEqual(CATEGORY_NAMES, { security: "Security", seo: "SEO", speed: "Speed", technical: "Technical" });
  assert.deepEqual(DESTINATION_NAMES, {
    "page-level": "Page-Level Issues",
    "security-audit": "Security Audit",
    "technical-audit": "Technical Audit",
    speed: "Speed & Performance",
  });
  assert.equal(SPEED_NOT_GRADED_TILE, "Speed: Not graded — no Speed-check results were available for this report.");
  assert.equal(CHECKS_COUNTED_SENTENCE, "The checks counted as run include both checks that passed and checks that found issues.");
  assert.equal(NO_ISSUES_VERDICT, "The audit found no issues in the checks that could be run.");
  assert.equal(AREAS_HEADING_NEW, "What we checked and why it matters");
  assert.deepEqual(AREA_SUB_LABELS, { whatItIs: "What it is", whyItMatters: "Why it matters", whatWeChecked: "What we checked", whatWeFound: "What we found" });
  assert.deepEqual(AREA_HEADINGS, { seo: "Search visibility (SEO)", security: "Security", speed: "Speed and performance", technical: "Technical setup" });
  assert.equal(SEO_NO_ISSUES, "No search-visibility issues were found on the pages where these checks could run.");
  assert.equal(SECURITY_NO_ISSUES, "No Security issues were found in the checks that could be completed.");
  assert.equal(issuesFoundSentence(["A"], SEO_ISSUES_TAIL), "1 issue found: A. Each is explained under Page-Level Issues.");
  assert.equal(
    issuesFoundSentence(["A", "B"], SECURITY_ISSUES_TAIL),
    "2 issues found: A; B. Each is explained under Page-Level Issues and Security Audit.",
  );
  assert.equal(technicalFindingLine("robots.txt blocks all search engines"), "robots.txt blocks all search engines. It is explained under Technical Audit.");
  assert.equal(speedRatedSentence("Fast"), "Based on Google's records of real visits, Google rates this page's speed as Fast. Details are in Speed & Performance.");
  assert.equal(SPEED_FIELD_NO_RATING, "Google real-visitor data is available, but an overall rating is not provided.");
  assert.equal(SPEED_LAB_AVAILABLE, "A simulated lab score is available.");
  assert.equal(
    speedSimulatedSentence(74),
    "Google has no real-visitor data for this page, so speed was judged from one simulated test, which scored 74 out of 100. Details are in Speed & Performance.",
  );
  assert.equal(SPEED_NOT_MEASURED, "Speed could not be measured for this report.");
  assert.equal(AI_PARAGRAPH_HEADING, "What these findings mean for your website and business");
  assert.equal(IMPROVEMENTS_HEADING, "Improvements that deserve attention");
  assert.equal(STRENGTHS_HEADING, "What is working well");
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("3b-ii one numbered section, its parts in the approved order", () => {
  const out = render({ overallSummary: summaryWith(ALL_GOOD, ["STRENGTH-ONE"]) });
  assert.equal(countOf(out, "<section"), 1);
  assert.equal(countOf(out, "<h2"), 1);
  assert.ok(out.startsWith(`<section class="exec-summary"><h2>Executive Summary</h2>`));
  const order = [
    "Overall grade: B (Good)",
    "82% of checks passed, but unresolved serious issues cap the grade at B.",
    "What's holding the grade back",
    "Weighted checks passed: 82/100",
    "Checks that could be run: 21 of 23",
    "Security: B, based on 10 of 12 checks.",
    CHECKS_COUNTED_SENTENCE,
    AREAS_HEADING_NEW,
    AREA_HEADINGS.seo,
    AREA_HEADINGS.security,
    AREA_HEADINGS.speed,
    AREA_HEADINGS.technical,
    AI_PARAGRAPH_HEADING,
    IMPROVEMENTS_HEADING,
    STRENGTHS_HEADING,
    "We found 128 addresses",
  ];
  const plain = textOf(out);
  let at = -1;
  for (const marker of order) {
    const next = plain.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" follows the part before it`);
    at = next;
  }
});

test("3b-ii every value from the audited site is escaped", () => {
  const out = render({
    improvements: [improvement("seo.title.missing", HOSTILE, "seo", "page-level")],
    clientSummary: { ...testDocument().clientSummary, overallSummary: HOSTILE },
    overallSummary: summaryWith(ALL_GOOD, [HOSTILE]),
    coverage: { ...testDocument().coverage, partial: true, stopReason: HOSTILE },
    coverageCounts: null,
  });
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

// ---------------------------------------------------------------------------
// The verdict (CP1 §5.2, B3, B5, B14)
// ---------------------------------------------------------------------------

test("3b-ii verdict: graded, several issues, counts by severity in model order without zeros", () => {
  const out = textOf(render());
  assert.ok(out.includes(
    "Overall grade: B (Good), based on 21 of 23 checks that could be run. The audit found 2 issues that need attention: 1 High, 1 Medium.",
  ));
  assert.ok(!out.includes("0 Critical"));
});

test("3b-ii verdict: exactly one issue needs attention", () => {
  const out = textOf(render({
    summary: { ...testDocument().summary, severityCounts: [{ severity: "critical", label: "Critical", count: 1 }] },
  }));
  assert.ok(out.includes("The audit found 1 issue that needs attention: 1 Critical."));
});

test("3b-ii verdict: no issues", () => {
  const out = textOf(render({ summary: { ...testDocument().summary, severityCounts: [] } }));
  assert.ok(out.includes(`checks that could be run. ${NO_ISSUES_VERDICT}`));
});

test("3b-ii verdict: an ungraded audit replaces only the grade sentence with the score's own message", () => {
  for (const message of [
    "Too few checks could run to give an overall grade. The category breakdown below reports what was assessed.",
    "This audit could not assess enough of the site to grade it.",
  ]) {
    const out = textOf(render({
      score: { ...testDocument().score, graded: false, grade: null, bandLabel: null, passRate: null, capNote: null, statusMessage: message },
    }));
    assert.ok(out.includes(`${message} The audit found 2 issues that need attention: 1 High, 1 Medium.`), message);
    assert.ok(!out.includes("Overall grade:"));
  }
});

test("3b-ii verdict: the cap note, partial note and gate list are kept, and absent when the score has none (B5)", () => {
  const withNotes = render({ score: { ...testDocument().score, partialNote: "PARTIAL-NOTE" } });
  for (const marker of ["cap the grade at B", "PARTIAL-NOTE", "What&#39;s holding the grade back", "No SPF record"]) {
    assert.ok(withNotes.includes(marker), marker);
  }
  const without = render({ score: { ...testDocument().score, capNote: null, gateReasons: [], gateNote: null } });
  assert.ok(!without.includes("cap the grade"));
  assert.ok(!without.includes("score-gate"));
});

// ---------------------------------------------------------------------------
// Overall figures and tiles (D1, U3, Q23–Q26, W2)
// ---------------------------------------------------------------------------

test("3b-ii overall figures, and no pass-rate line when there is no pass rate", () => {
  const out = textOf(render());
  assert.ok(out.includes("Weighted checks passed: 82/100"));
  assert.ok(out.includes("Checks that could be run: 21 of 23"));
  const none = textOf(render({ score: { ...testDocument().score, passRate: null } }));
  assert.ok(!none.includes("Weighted checks passed"));
});

test("3b-ii tiles: graded plural and singular, pass rate kept, Q23 Speed, B4 names, no '% assessed'", () => {
  const out = render();
  const plain = textOf(out);
  assert.ok(plain.includes("Security: B, based on 10 of 12 checks. 80%"));
  assert.ok(plain.includes("SEO: C, based on 10 of 10 checks. 62%"), "SEO, not 'Search visibility' (B4)");
  assert.ok(plain.includes("Technical: A, based on 1 of 1 check. 100%"), "U3 singular");
  assert.ok(plain.includes(SPEED_NOT_GRADED_TILE), "Q23");
  assert.ok(!plain.includes("assessed"), "Q24: no '% assessed'");
  assert.ok(!plain.includes("Search visibility:"));
});

test("3b-ii tiles: not graded with checks expected, and W2 for a non-Speed category with none", () => {
  const categories = testDocument().score.categories.map((category) =>
    category.category === "seo"
      ? { assessed: false as const, label: category.label, category: "seo" as const, ranCount: 0 as const, skippedCount: 10 }
      : category.category === "speed"
        ? { assessed: false as const, label: "Speed", category: "speed" as const, ranCount: 0 as const, skippedCount: 3 }
        : category.category === "technical"
          ? { assessed: false as const, label: "Technical", category: "technical" as const, ranCount: 0 as const, skippedCount: 0 }
          : category,
  );
  const plain = textOf(render({ score: { ...testDocument().score, categories } }));
  assert.ok(plain.includes("SEO: Not graded, no checks could run."));
  assert.ok(plain.includes("Speed: Not graded, no checks could run."), "Speed with skipped checks is not Q23");
  assert.ok(plain.includes("Technical: Not graded, no checks could run."), "W2");
});

test("3b-ii Q25: once below the tiles when any tile is graded, and absent when none is", () => {
  const out = render();
  assert.equal(countOf(out, CHECKS_COUNTED_SENTENCE), 1);
  assert.ok(out.indexOf(CHECKS_COUNTED_SENTENCE) > out.indexOf("exec-tiles"));
  assert.ok(out.indexOf(CHECKS_COUNTED_SENTENCE) < out.indexOf(AREAS_HEADING_NEW));
  const ungraded = testDocument().score.categories.map((category) =>
    ({ assessed: false as const, label: category.label, category: category.category, ranCount: 0 as const, skippedCount: 0 }));
  assert.ok(!render({ score: { ...testDocument().score, categories: ungraded } }).includes(CHECKS_COUNTED_SENTENCE));
});

// ---------------------------------------------------------------------------
// Area blocks (CP1 §5.2, Q2a/b/c, S3-D5, B8, B9, K2, W1, W3)
// ---------------------------------------------------------------------------

test("3b-ii areas (W3): heading, the three introductory texts, then the status alone, then what was found", () => {
  const out = render({ overallSummary: summaryWith({ seo: "attention", speed: "improve", site: "incomplete", security: "good" }) });
  const expected: ReadonlyArray<[keyof typeof AREA_HEADINGS, string]> = [
    ["seo", "Needs attention"],
    ["security", "In good shape"],
    ["speed", "Room for improvement"],
    ["technical", "Partly checked"],
  ];
  const part = (label: string, text: string) =>
    `<p><span class="exec-area-label">${label}</span><br>${escapeHtml(text)}</p>`;
  for (const [key, label] of expected) {
    const heading = AREA_HEADINGS[key];
    const block = areaBlock(out, heading);
    const fixed = AREA_TEXTS[key];
    assert.equal(statusIn(block), label, heading);
    // The exact sequence: heading, What it is, Why it matters, What we checked, the status with no prefix.
    assert.ok(
      block.startsWith(
        `<div class="exec-area"><h3>${escapeHtml(heading)}</h3>` +
          part(AREA_SUB_LABELS.whatItIs, fixed.whatItIs) +
          part(AREA_SUB_LABELS.whyItMatters, fixed.whyItMatters) +
          part(AREA_SUB_LABELS.whatWeChecked, fixed.whatWeChecked) +
          `<p class="section-status">${label}</p>`,
      ),
      `${heading}: the status follows the introductory texts`,
    );
    // Not under the heading: the heading is not the introductory text.
    assert.ok(!block.includes(`</h3><p class="section-status">`), `${heading}: not straight after the heading`);
    // What we found, where there is one, comes after the status.
    const found = block.indexOf(`<span class="exec-area-label">${AREA_SUB_LABELS.whatWeFound}</span>`);
    if (found >= 0) assert.ok(found > block.indexOf(`<p class="section-status">`), `${heading}: found after the status`);
  }
});

test("3b-ii areas (W3): a block with no status keeps the same order without a status line", () => {
  const out = render({ overallSummary: null, certificateFailureAreas: null, improvements: [] });
  const block = areaBlock(out, AREA_HEADINGS.seo);
  assert.equal(statusIn(block), null);
  const checked = block.indexOf(AREA_SUB_LABELS.whatWeChecked);
  const found = block.indexOf(AREA_SUB_LABELS.whatWeFound);
  assert.ok(checked > 0 && found > checked, "What we checked, then What we found");
});

test("3b-ii areas: no status source, no status line", () => {
  const out = render({ overallSummary: null, certificateFailureAreas: null });
  assert.ok(!out.includes("section-status"));
});

test("3b-ii SEO and Security: issues listed with '; ' (W1), or the no-issues sentences", () => {
  const issues = render({
    overallSummary: summaryWith(ALL_GOOD),
    improvements: [
      improvement("seo.title.missing", "No page title", "seo", "page-level"),
      improvement("security.dns.spf", "No SPF record", "security", "security-audit"),
      improvement("seo.lang.missing", "No language declared", "seo", "page-level"),
      improvement("security.headers.hsts", "No HSTS", "security", "page-level"),
    ],
  });
  assert.equal(foundIn(areaBlock(issues, AREA_HEADINGS.seo)), "2 issues found: No page title; No language declared. Each is explained under Page-Level Issues.");
  assert.equal(
    foundIn(areaBlock(issues, AREA_HEADINGS.security)),
    "2 issues found: No SPF record; No HSTS. Each is explained under Page-Level Issues and Security Audit.",
  );
  const clean = render({ overallSummary: summaryWith(ALL_GOOD), improvements: [] });
  assert.equal(foundIn(areaBlock(clean, AREA_HEADINGS.seo)), SEO_NO_ISSUES);
  assert.equal(foundIn(areaBlock(clean, AREA_HEADINGS.security)), SECURITY_NO_ISSUES);
});

test("3b-ii B8 (K2): an SEO, Security or Technical area that was not measured has no 'What we found'", () => {
  const out = render({ overallSummary: summaryWith({ seo: "not-measured", speed: "good", site: "good", security: "not-measured" }) });
  assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.seo)), null);
  assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.security)), null);
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.seo)), "Not measured");
  assert.ok(textOf(areaBlock(out, AREA_HEADINGS.seo)).includes(AREA_TEXTS.seo.whatWeChecked), "the fixed texts stay");
});

test("3b-ii Technical: the absence sentences and finding lines; nothing when there are neither (Q2c, B9)", () => {
  const withBoth = render({
    overallSummary: summaryWith(ALL_GOOD),
    technicalFiles: { robots: "absent", sitemap: "absent" },
    improvements: [improvement("technical.robots.blocks-all", "robots.txt blocks all search engines", "technical", "technical-audit")],
  });
  assert.equal(
    foundIn(areaBlock(withBoth, AREA_HEADINGS.technical)),
    "No robots.txt file was found. Without one, search engines may visit every page. " +
      "No sitemap was found. A sitemap lists the site's pages for search engines. " +
      "robots.txt blocks all search engines. It is explained under Technical Audit.",
  );
  for (const files of [{ robots: "found", sitemap: "found" }, { robots: "unavailable", sitemap: "unavailable" }, null] as const) {
    const out = render({ overallSummary: summaryWith(ALL_GOOD), technicalFiles: files, improvements: [] });
    assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.technical)), null, JSON.stringify(files));
  }
});

test("3b-ii Speed: every variant, chosen from the speed fields, never omitted (B1, B2, K2, Q22)", () => {
  const cases: ReadonlyArray<[string, PdfDocument["speed"], string]> = [
    ["rated", measuredSpeed({ fieldAvailable: true, overall: "Average", labScore: 74 }), speedRatedSentence("Average")],
    ["field, no rating, lab", measuredSpeed({ fieldAvailable: true, overall: null, labScore: 74 }), `${SPEED_FIELD_NO_RATING} ${SPEED_LAB_AVAILABLE}`],
    ["field, no rating, no lab", measuredSpeed({ fieldAvailable: true, overall: null, labScore: null }), SPEED_FIELD_NO_RATING],
    ["lab only", measuredSpeed({ fieldAvailable: false, overall: null, labScore: 41 }), speedSimulatedSentence(41)],
    ["measured but nothing usable", measuredSpeed({ fieldAvailable: false, overall: null, labScore: null }), SPEED_NOT_MEASURED],
    ["not requested", { measured: false, status: "not-requested", message: "Not requested." }, SPEED_NOT_MEASURED],
    ["failed", { measured: false, status: "error", message: "Failed." }, SPEED_NOT_MEASURED],
  ];
  for (const [name, speed, expected] of cases) {
    // A "Not measured" Speed status still prints its sentence: B8 does not apply to Speed (K2).
    const out = render({ speed, overallSummary: summaryWith({ ...ALL_GOOD, speed: "not-measured" }) });
    assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.speed)), expected, name);
  }
});

// ---------------------------------------------------------------------------
// The AI paragraph (D5, Q8, B15)
// ---------------------------------------------------------------------------

test("3b-ii AI paragraph: the D5 label and the validated text unchanged; nothing without it", () => {
  const out = render();
  const ai = out.slice(out.indexOf(`<div class="exec-ai">`), out.indexOf("</div>", out.indexOf(`<div class="exec-ai">`)));
  assert.ok(ai.includes(AI_SUMMARY_LABEL));
  assert.ok(ai.includes(`<p>This site has two issues worth attention. ${SENTINEL}</p>`));
  assert.ok(!ai.includes("rejected") && !ai.includes("explained in detail"), "no AI-coverage or rejected-count text");
  const none = render({ clientSummary: { ...testDocument().clientSummary, overallSummary: null } });
  assert.ok(!none.includes(AI_PARAGRAPH_HEADING));
  assert.ok(!none.includes(AI_SUMMARY_LABEL));
});

// ---------------------------------------------------------------------------
// Improvements (CP1 §5.2, U6, M7, K1, K3)
// ---------------------------------------------------------------------------

test("3b-ii improvements: model order kept, area from category, destination from key", () => {
  const items = [
    improvement("security.ssl.expired", "TLS certificate has expired", "security", "security-audit", "Critical"),
    improvement("seo.title.missing", "No page title", "seo", "page-level", "High"),
    improvement("speed.field.lcp.slow", "Slow largest content", "speed", "speed", "High"),
    improvement("security.headers.hsts", "No HSTS", "security", "page-level", "Medium"),
    improvement("technical.robots.blocks-all", "robots.txt blocks all search engines", "technical", "technical-audit", "Medium"),
  ];
  const out = render({ improvements: items });
  const list = out.slice(out.indexOf(`<div class="exec-improvements">`), out.indexOf("</ol>"));
  assert.deepEqual([...list.matchAll(/<li>(.*?)<\/li>/g)].map((m) => textOf(m[1]).trim()), [
    "TLS certificate has expired : Critical · Security. See Security Audit.",
    "No page title : High · SEO. See Page-Level Issues.",
    "Slow largest content : High · Speed. See Speed & Performance.",
    "No HSTS : Medium · Security. See Page-Level Issues.",
    "robots.txt blocks all search engines : Medium · Technical. See Technical Audit.",
  ]);
  assert.ok(list.includes("<li><strong>TLS certificate has expired</strong>: Critical · Security. See Security Audit.</li>"));
});

test("3b-ii improvements: the area comes from the category key, not the label text", () => {
  const out = render({ improvements: [{ ...improvement("seo.title.missing", "No page title", "seo", "page-level"), categoryLabel: "MISLEADING" }] });
  assert.ok(out.includes("High · SEO."));
  assert.ok(!out.includes("MISLEADING"));
});

test("3b-ii improvements: absent when there are none", () => {
  assert.ok(!render({ improvements: [] }).includes(IMPROVEMENTS_HEADING));
});

// ---------------------------------------------------------------------------
// Strengths
// ---------------------------------------------------------------------------

test("3b-ii strengths: listed from the overall summary; absent when empty or when there is no summary", () => {
  const out = render({ overallSummary: summaryWith(ALL_GOOD, ["STRENGTH-ONE", "STRENGTH-TWO"]) });
  assert.ok(out.includes("<li>STRENGTH-ONE</li><li>STRENGTH-TWO</li>"));
  assert.ok(!render({ overallSummary: summaryWith(ALL_GOOD, []) }).includes(STRENGTHS_HEADING));
  assert.ok(!render({ overallSummary: null }).includes(STRENGTHS_HEADING));
});

// ---------------------------------------------------------------------------
// Coverage (R3, B6, B7, X1, S1, K4)
// ---------------------------------------------------------------------------

const COUNTS = testDocument().coverageCounts!;

test("3b-ii coverage: R3 with every part, singular and plural", () => {
  const many = textOf(coverageIn(render({
    coverageCounts: { ...COUNTS, discovered: 63, evaluated: 55, unavailable: 1, notWebPages: 2, notVisited: 5, robotsExcluded: 0, includesStartingAddress: true },
  })));
  assert.equal(many.trim(), "We found 63 addresses on this website, including the starting address: 55 pages were read and checked, 1 could not be read, 2 were not web pages, 5 were not visited before the audit stopped.");
  const one = textOf(coverageIn(render({
    coverageCounts: { ...COUNTS, discovered: 1, evaluated: 1, unavailable: 0, notWebPages: 0, notVisited: 0, robotsExcluded: 0, includesStartingAddress: true },
  })));
  assert.equal(one.trim(), "We found 1 address on this website, including the starting address: 1 page was read and checked.", "B7");
  const singles = textOf(coverageIn(render({
    coverageCounts: { ...COUNTS, discovered: 4, evaluated: 1, unavailable: 1, notWebPages: 1, notVisited: 1, robotsExcluded: 1, includesStartingAddress: false },
  })));
  assert.ok(singles.includes("We found 4 addresses on this website: 1 page was read and checked, 1 could not be read, 1 was not a web page, 1 was not visited before the audit stopped."));
  assert.ok(singles.includes(robotsExclusionSentence(1)));
});

test("3b-ii coverage: the robots sentence with its count only when there were exclusions", () => {
  assert.ok(textOf(coverageIn(render())).includes(robotsExclusionSentence(4)));
  assert.ok(!textOf(coverageIn(render({ coverageCounts: { ...COUNTS, robotsExcluded: 0 } }))).includes("robots.txt"));
});

test("3b-ii coverage: counts that do not reconcile give no figure, only X1 when there were exclusions", () => {
  const out = textOf(coverageIn(render({ coverageCounts: null, coverageFlags: { partial: false, hasExclusions: true } })));
  assert.equal(out.trim(), ROBOTS_EXCLUSION_UNCOUNTED);
  assert.equal(coverageIn(render({ coverageCounts: null, coverageFlags: { partial: false, hasExclusions: false } })), "", "nothing to say");
});

test("3b-ii coverage (B6, K4): a whole-site partial crawl adds its stop reason; a complete crawl does not", () => {
  const partial = textOf(coverageIn(render({ coverage: { ...testDocument().coverage, partial: true, stopReason: "Stopped at the 150-page safety limit." } })));
  assert.ok(partial.includes("Stopped at the 150-page safety limit."));
  const complete = textOf(coverageIn(render()));
  assert.ok(!complete.includes("Stopped"));
});

test("3b-ii coverage (K4): a certificate failure shows no crawl stop reason", () => {
  const out = coverageIn(render({
    certificateFailureAreas: { seo: "not-measured", security: "attention", speed: "not-measured", technical: "incomplete" },
    overallSummary: null,
    coverage: { ...testDocument().coverage, partial: true, stopReason: "FETCH-FAILURE-REASON" },
    coverageCounts: null,
    coverageFlags: { partial: true, hasExclusions: false },
  }));
  assert.equal(out, "");
});

// ---------------------------------------------------------------------------
// Real audits, through the production projection
// ---------------------------------------------------------------------------

test("3b-ii a real audit: statuses from the overall summary, every improvement once, R3", async () => {
  const { valid } = await realAudits;
  const real = realDocument(valid);
  const out = executiveSummarySectionHtml(real);
  for (const item of real.improvements) {
    assert.equal(countOf(out, `<strong>${escapeHtml(item.title)}</strong>`), 1, item.ruleId);
  }
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.security)), AREA_STATUS_LABELS[real.overallSummary!.securityStatus]);
  assert.equal(
    statusIn(areaBlock(out, AREA_HEADINGS.technical)),
    real.overallSummary!.areas.find((area) => area.key === "site")!.statusLabel,
  );
  assert.ok(textOf(coverageIn(out)).startsWith(" We found"));
});

test("3b-ii a real audit whose counts do not reconcile: no coverage figure, X1, no R3", async () => {
  const { failing } = await realAudits;
  const real = realDocument(failing);
  assert.equal(real.coverageCounts, null);
  const coverage = textOf(coverageIn(executiveSummarySectionHtml(real)));
  assert.ok(!coverage.includes("We found"));
  assert.ok(coverage.includes(ROBOTS_EXCLUSION_UNCOUNTED));
  const crawl = failing.crawl;
  for (const figure of new Set([crawl.discovered, crawl.evaluated, crawl.sources.html, crawl.robots.excluded])) {
    assert.ok(!new RegExp(`\\b${figure}\\b`).test(coverage), `no coverage figure ${figure}`);
  }
});

test("3b-ii a real certificate failure: M6 statuses, Q22, no AI, no R3 and no stop reason", async () => {
  const { certificate } = await realAudits;
  const real = realDocument(certificate);
  const out = executiveSummarySectionHtml(real);
  const areas = real.certificateFailureAreas!;
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.seo)), "Not measured");
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.speed)), "Not measured");
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.security)), AREA_STATUS_LABELS[areas.security]);
  assert.equal(statusIn(areaBlock(out, AREA_HEADINGS.technical)), AREA_STATUS_LABELS[areas.technical]);
  assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.seo)), null, "B8");
  assert.equal(foundIn(areaBlock(out, AREA_HEADINGS.speed)), SPEED_NOT_MEASURED, "Q22");
  assert.ok(!out.includes(AI_PARAGRAPH_HEADING), "no AI paragraph");
  assert.ok(!textOf(out).includes("We found"), "no R3");
  assert.ok(!out.includes(escapeHtml(real.coverage.stopReason ?? "NEVER")), "K4: no fetch failure presented as a stop reason");
  assert.ok(out.includes(SPEED_NOT_GRADED_TILE) || textOf(out).includes("Speed: Not graded, no checks could run."));
  for (const item of real.improvements) assert.equal(countOf(out, `<strong>${escapeHtml(item.title)}</strong>`), 1);
});

// ---------------------------------------------------------------------------
// Not wired, and nothing new is asked or calculated
// ---------------------------------------------------------------------------

test("wired (CP3 step 4b): the document opens with the new section, once, and the old one is not printed", () => {
  const shell = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(shell.includes("executiveSummarySectionHtml(document)"));
  assert.ok(!shell.includes("executiveSummaryHtml("), "the old section is no longer called");
  const doc = testDocument();
  const page = documentHtml(doc);
  assert.equal(page.split(`<section class="exec-summary">`).length - 1, 1);
  assert.ok(page.includes(`<main>${executiveSummarySectionHtml(doc)}`), "first inside main, unchanged");
  assert.ok(!page.includes("<h2>Executive summary</h2>"), "no old executive summary");
});

test("3b-ii the new section asks no AI and computes no score", () => {
  const source = fs.readFileSync(new URL("./executiveSummary.ts", import.meta.url), "utf8");
  for (const needle of ["gemini", "explain(", "scoreAudit", "coverageCheck(", "fetch(", "../ai", "../scoring"]) {
    assert.ok(!source.includes(needle), needle);
  }
});
