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
import test from "node:test";
import { escapeHtml } from "./escape.ts";
import { executiveSummaryHtml, type ExecutiveSummaryInput } from "./executiveSummary.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import type { PdfFinding, PdfFindingSection } from "../pdfDocument.ts";

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
