/**
 * The whole document, as the redesigned report assembles it (CP1 F1, CP3 step 4b).
 *
 * The section renderers have their own tests. These check only what can be
 * seen once they are put together: the order, that each section and each
 * finding appears once and in its place, that the old standalone sections are
 * gone, that the Speed section is untouched with its cards straight after it,
 * and that a certificate failure and a crawl whose counts do not reconcile
 * still say no more than the audit established.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import { documentHtml } from "./shell.ts";
import { coverHtml } from "./cover.ts";
import { escapeHtml, html } from "./escape.ts";
import { AFFECTED_LIST_TRUNCATED, findingCardsHtml, NO_PAGE_READ_SENTENCE } from "./findings.ts";
import { speedHtml } from "./speed.ts";
import { pageIssueLine, ROBOTS_EXCLUSION_WITHOUT_COUNT } from "./categorySections.ts";
import { CHECKS_COUNTED_SENTENCE, ROBOTS_EXCLUDED_UNCOUNTED } from "./executiveSummary.ts";
import { LIMITATIONS_HEADING, LIMITATIONS_INTRO, LIMITATIONS_SUBHEADINGS, NOT_PART_OF_THIS_AUDIT } from "./limitations.ts";
import { aboutClausesHtml } from "./about.ts";
import { skippedGroupsHtml } from "./skipped.ts";
import { STYLESHEET } from "./styles.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import { runRealAudit, runRealCertificateFailure, type FakeSite } from "./realAudit.fixture.mts";
import { AI_SUMMARY_LABEL, SAFETY_LIMIT_STOP } from "../../report/reportSections.ts";
import { buildAIReportInput } from "../../ai/buildReportInput.ts";
import { validateExplanations } from "../../ai/validateExplanations.ts";
import { AI_CONTRACT_VERSION } from "../../ai/contract.ts";
import { SPEED_RULES } from "../../rules/all.ts";
import { buildPdfDocument, type PdfDocument, type PdfFinding } from "../pdfDocument.ts";
import { createJobStore } from "../../jobs/jobStore.ts";
import type { ExplainResult } from "../../ai/gemini/explain.ts";
import type { AuditResult, SiteAuditResult, SpeedResult } from "../../types.ts";
// CP3 step 6, T-2, T-4 and T-6 (added after D3; kept separate so the D3 lines are unchanged).
import { CHECK_LABELS, CHECK_STATUS_LINES, SITE_NO_ISSUE_LINE, siteIssueLine } from "./categorySections.ts";
import { ruleTitle } from "../../report/measurementsView.ts";
import { AUDIT_RULES } from "../../rules/all.ts";
// CP4 stage 4b (kept separate so the earlier lines are unchanged).
import { SPEED_NOT_MEASURED } from "./executiveSummary.ts";
import { REAL_VISITOR_HEADING, SPEED_GLOSSARY_HEADING, realVisitorExplanation } from "../../report/reportSections.ts";
// CP4 stage 4c (kept separate so the earlier lines are unchanged).
import { REAL_VISITOR_REFERENCE as APPROVED_REFERENCE } from "../../report/reportSections.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PITCH_H2 = escapeHtml("Let's Make Your Website Work Better for Your Business");

/** The order every whole-site document follows (CP1 §4). */
const SECTIONS = [
  "Executive Summary",
  "Page-Level Issues",
  "SEO Audit",
  "Security Audit",
  "Speed",
  "Technical Audit",
  PITCH_H2,
  "Limitations and About This Audit",
];

/** Every section heading inside <main>, in order. */
const headingsOf = (html: string) => {
  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  return [...main.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]);
};

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The markup of one section, by its class. */
function sectionOf(html: string, className: string): string {
  const start = html.indexOf(`<section class="${className}`);
  assert.ok(start >= 0, `${className} is present`);
  const next = html.indexOf("<section", start + 1);
  const end = html.indexOf("</main>");
  return html.slice(start, next < 0 || next > end ? end : next);
}

/** Everything after the Speed section and before Technical Audit: where the speed cards go. */
const afterSpeed = (html: string) =>
  html.slice(html.indexOf("</section>", html.indexOf(`<section class="speed">`)) + "</section>".length, html.indexOf(`<section class="technical-audit">`));

/** The document for a finished audit, through the production projection, optionally with a speed result. */
function documentOf(audit: AuditResult, speed?: SpeedResult): PdfDocument {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult, SpeedResult["data"]>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", audit);
  if (speed !== undefined) store.attach(job.id, speed);
  const outcome = buildPdfDocument(job.id, store);
  if (!outcome.ok) assert.fail(outcome.reason);
  return outcome.document;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

/** The real audits these tests look at, built once. */
const fixtures = (async () => {
  const site: Record<string, { html: string; unreadable?: string }> = {};
  const links = Array.from({ length: 60 }, (_, i) => `<a href="/p${i + 1}">Page ${i + 1}</a>`).join(" ");
  site["https://example.com/"] = {
    html: page("Example Company", `<h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p><a href="/broken">Broken</a> ${links}`),
  };
  site["https://example.com/broken"] = { html: "", unreadable: "The server returned an error." };
  for (let i = 1; i <= 60; i++) {
    site[`https://example.com/p${i}`] = {
      html: page(`Page ${i}`, `<h1>Page ${i}</h1><p>Widgets supplied, installed and maintained for businesses of every size, number ${i}.</p><a href="/">Home</a>`),
    };
  }
  const partial = await runRealAudit({ site: site as FakeSite, checks: { spfMissing: true }, maxPages: 56 });
  partial.crawl.skippedNonHtml += 1;
  partial.crawl.discovered += 1;
  partial.crawl.sources.html += 1;
  partial.crawl.robots.excluded = 2;

  const unreached = partial.crawl.discovered - partial.crawl.evaluated - partial.crawl.unavailable.length - partial.crawl.skippedNonHtml;
  const i1 = structuredClone(partial); i1.crawl.sources.html += 3;
  const i23 = structuredClone(partial); i23.crawl.evaluated += unreached + 1;
  const i45 = structuredClone(partial); i45.crawl.complete = true; i45.crawl.stoppedBecause = "completed";
  const i6 = structuredClone(partial); i6.crawl.unavailable.push({ ...i6.crawl.unavailable[0] });

  // One page, no description: a page finding on the only page read.
  const single = await runRealAudit({
    site: { "https://example.com/": { html: page("Example Company", `<h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p>`) } },
  });

  const certificate = await runRealCertificateFailure({
    site: { "https://example.com/": { html: "", unreadable: "The website's security certificate has expired.", certificateProblem: "expired" } },
    checks: { certificateExpired: true },
  });

  return { partial, single, certificate, failing: { I1: i1, I23: i23, I45: i45, I6: i6 } as Record<string, SiteAuditResult> };
})();

/** A speed result carrying one real speed rule's finding, attached the way the speed check attaches it. */
function speedResultWithFinding(audit: SiteAuditResult): SpeedResult {
  return {
    data: { ...audit.data.performance, status: "checked" },
    findings: [{
      id: SPEED_RULES[0].id, title: "SPEED-FINDING-TITLE", category: "speed", severity: "high",
      evidence: "Measured.", remediation: "Fix it.",
    }],
    skippedChecks: [],
  } as unknown as SpeedResult;
}

/** Every problem finding's card title appears exactly once, in the section it belongs to. */
function assertEachFindingOnce(doc: PdfDocument, name: string): void {
  const html = documentHtml(doc);
  const placed: Array<[PdfFinding, string]> = [
    ...doc.siteFindings.groups.flatMap((group) =>
      group.findings.map((finding): [PdfFinding, string] => [
        finding,
        group.category === "technical" ? sectionOf(html, "technical-audit") : sectionOf(html, "security-audit"),
      ])),
    ...doc.pageFindings.groups
      .filter((group) => group.category !== "speed")
      .flatMap((group) => group.findings.map((finding): [PdfFinding, string] => [finding, sectionOf(html, "findings page-level-issues")])),
    ...doc.speedFindings.map((finding): [PdfFinding, string] => [finding, afterSpeed(html)]),
  ];
  assert.ok(placed.length > 0, `${name}: the fixture has findings`);
  for (const [finding, where] of placed) {
    const card = `<h4 class="finding-title">${escapeHtml(finding.title)}</h4>`;
    assert.equal(count(html, card), 1, `${name}: "${finding.title}" once in the document`);
    assert.equal(count(where, card), 1, `${name}: "${finding.title}" in its own section`);
  }
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("the sections come in the approved order, each once", () => {
  const html = documentHtml(testDocument());
  assert.deepEqual(headingsOf(html), SECTIONS);
});

test("none of the retired standalone sections is printed", () => {
  const html = documentHtml(testDocument({ skipped: { heading: "Checks not evaluated", intro: "I", count: 1, groups: [{ reason: "R", checks: ["C"] }] } }));
  for (const retired of [
    "Executive summary", "Overall summary", "AI summary", "Final assessment", "What we measured",
    "Coverage detail", "About this report", "Checks not evaluated", "Site-wide issues", "Page-level issues",
  ]) {
    assert.ok(!html.includes(`<h2>${retired}</h2>`), retired);
  }
  for (const className of ["exec", "overall-summary", "client-ai", "coverage", "skipped", "final", "measured", "coverage-detail", "about"]) {
    assert.ok(!html.includes(`<section class="${className}">`), className);
  }
});

test("D1: a whole-site audit with no page finding has no Page-Level Issues, and the rest keep their order", () => {
  const doc = testDocument({ pageFindings: { ...testDocument().pageFindings, count: 0, groups: [] } });
  assert.deepEqual(headingsOf(documentHtml(doc)), SECTIONS.filter((heading) => heading !== "Page-Level Issues"));
});

test("the cover stays outside <main>, and the numbering rules are unchanged", () => {
  const doc = testDocument();
  const html = documentHtml(doc);
  assert.equal(count(html, "<main>"), 1);
  assert.ok(html.indexOf(coverHtml(doc.cover)) < html.indexOf("<main>"), "the cover comes before main, unchanged");
  assert.ok(STYLESHEET.includes("main { counter-reset: section; }"));
  assert.ok(STYLESHEET.includes("section > h2 { counter-increment: section; }"));
});

// ---------------------------------------------------------------------------
// Speed (CP3 revision 9 §1.18, §5.7)
// ---------------------------------------------------------------------------

test("the Speed section is printed exactly as its renderer draws it, followed straight away by its cards", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial, speedResultWithFinding(partial));
  assert.equal(doc.speedFindings.length, 1, "the fixture carries a speed finding");
  const html = documentHtml(doc);
  const speed = speedHtml(doc.speed, doc.labels, doc.desktopSpeed);
  assert.equal(count(html, speed), 1, "the Speed section, byte for byte");
  assert.ok(html.includes(speed + findingCardsHtml(doc.speedFindings, doc.labels) + `<section class="technical-audit">`));
  assert.ok(!sectionOf(html, "findings page-level-issues").includes("SPEED-FINDING-TITLE"), "never in Page-Level Issues");
  assert.equal(count(html, "<h2>Speed</h2>"), 1, "the printed heading stays Speed");
});

// ---------------------------------------------------------------------------
// Every finding once, in its place
// ---------------------------------------------------------------------------

test("each finding appears exactly once, in its own section, across real audits", async () => {
  const { partial, single, certificate, failing } = await fixtures;
  assertEachFindingOnce(documentOf(partial, speedResultWithFinding(partial)), "partial with speed");
  assertEachFindingOnce(documentOf(single), "single page");
  assertEachFindingOnce(documentOf(certificate), "certificate failure");
  for (const [name, audit] of Object.entries(failing)) assertEachFindingOnce(documentOf(audit), name);
});

// ---------------------------------------------------------------------------
// Certificate failure, partial crawls, counts that do not reconcile
// ---------------------------------------------------------------------------

test("a certificate failure: Page-Level Issues says no page was read, with no card and no crawl stop reason anywhere", async () => {
  const { certificate } = await fixtures;
  const doc = documentOf(certificate);
  const html = documentHtml(doc);
  assert.deepEqual(headingsOf(html), SECTIONS);
  const pageLevel = sectionOf(html, "findings page-level-issues");
  assert.ok(pageLevel.includes(`<p>${NO_PAGE_READ_SENTENCE}</p>`));
  assert.ok(!pageLevel.includes(`<article class="finding`));
  assert.ok(doc.coverage.stopReason !== null && doc.coverage.stopReason !== "");
  assert.ok(!html.includes(escapeHtml(doc.coverage.stopReason)), "the fetch error is never shown as a stop reason (K4)");
  assert.ok(!html.includes("The entry page could not be fetched securely, so no page on this site was read."), "R1");
});

test("a whole-site crawl that stopped short shows its stop reason and the partial marker", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial);
  assert.ok(doc.coverage.partial && doc.coverage.stopReason !== null && doc.coverageCounts !== null);
  const html = documentHtml(doc);
  assert.ok(html.includes(`<p class="partial">Partial audit</p>`), "the cover marker");
  assert.ok(html.includes(escapeHtml(doc.coverage.stopReason)), "the stop reason");
  assert.ok(!html.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)), "no uncounted sentence when the counts reconciled");
});

test("counts that do not reconcile (I1–I6): X1 instead of figures, and the stop reason only when the crawl stopped short", async () => {
  const { failing } = await fixtures;
  for (const [name, audit] of Object.entries(failing)) {
    const doc = documentOf(audit);
    assert.equal(doc.coverageCounts, null, name);
    const html = documentHtml(doc);
    assert.ok(html.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)), `${name}: X1`);
    assert.ok(!html.includes(`<div class="crawl-table">`), `${name}: no crawl table`);
    assert.ok(!html.includes("We found "), `${name}: no coverage sentence with figures`);
    assert.equal(html.includes(escapeHtml(doc.coverage.stopReason ?? "NONE")), doc.coverage.partial, `${name}: stop reason only when partial`);
  }
});

test("a single-page audit uses the single-page scope wording", async () => {
  const { single } = await fixtures;
  const doc = documentOf(single);
  assert.equal(doc.singlePageAudit, true);
  assert.ok(documentHtml(doc).includes("Found on the page checked."));
});

// ---------------------------------------------------------------------------
// AI, escaping, and nothing new asked or worked out
// ---------------------------------------------------------------------------

test("the AI paragraph is printed once, in the Executive Summary, under the D5 label", () => {
  const doc = testDocument();
  const html = documentHtml(doc);
  const text = doc.clientSummary.overallSummary!;
  assert.equal(count(html, escapeHtml(text)), 1, "once in the whole document");
  const exec = sectionOf(html, "exec-summary");
  assert.ok(exec.includes(`<p class="ai-label">${escapeHtml(AI_SUMMARY_LABEL)}</p><p>${escapeHtml(text)}</p>`));
});

test("hostile text is escaped wherever the document prints it", () => {
  const base = testDocument();
  const hostileCard = { ...base.pageFindings.groups[0].findings[0], title: HOSTILE };
  const doc = testDocument({
    pageFindings: { ...base.pageFindings, groups: [{ ...base.pageFindings.groups[0], findings: [hostileCard] }] },
    skipped: { heading: "H", intro: "I", count: 1, groups: [{ reason: HOSTILE, checks: ["C"] }] },
    coverage: { ...base.coverage, partial: true, stopReason: HOSTILE },
    clientSummary: { ...base.clientSummary, overallSummary: HOSTILE },
    measured: [{ key: "security", heading: "Security", facts: [{ label: "Row", value: HOSTILE }] }],
  });
  const html = documentHtml(doc);
  const main = html.slice(html.indexOf("<main>"));
  assert.ok(!main.includes("<script>"));
  for (const where of ["findings page-level-issues", "limitations", "exec-summary", "security-audit"]) {
    assert.ok(sectionOf(html, where).includes(escapeHtml(HOSTILE)), `${where}: escaped`);
  }
});

test("the shell asks no AI and works out no score", () => {
  const source = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  for (const needle of ["../ai", "gemini", "scoring", "scoreAudit", "explainJob", "coverageCheck("]) {
    assert.ok(!source.includes(needle), needle);
  }
});

// ===========================================================================
// CP3 step 6: document-level checks (CP1 v6 §9.4 groups C and D, §10 items 2
// and 9; CP3 revision 9 §5.1 T-1 and §5.4 Q25). Approved as D3 (a).
//
// TESTS ONLY. Each reads the whole printed document, not a single renderer,
// because what these prove is what a reader of the finished PDF would see.
// ===========================================================================

/** The markup of the first element opened by `open`, nested same-name elements included; "" when absent. */
function blockOf(markup: string, open: string, tag: string): string {
  const start = markup.indexOf(open);
  if (start < 0) return "";
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    depth += m[0] === `</${tag}>` ? -1 : 1;
    if (depth === 0) return markup.slice(start, m.index + m[0].length);
  }
  return assert.fail(`unterminated ${open}`);
}

/** Every finding card in the document, keyed by its printed (escaped) title. */
function cardsOf(markup: string): Map<string, string> {
  const cards = new Map<string, string>();
  const opening = `<article class="finding`;
  for (let at = markup.indexOf(opening); at >= 0; at = markup.indexOf(opening, at + 1)) {
    const card = blockOf(markup.slice(at), opening, "article");
    const title = /<h4 class="finding-title">(.*?)<\/h4>/.exec(card)?.[1] ?? assert.fail("a card without a title");
    assert.ok(!cards.has(title), `${title} printed once`);
    cards.set(title, card);
  }
  return cards;
}

/**
 * The code-rendered part of <main>: without the AI paragraph (generated text is
 * outside these checks while AI1 is unverified, CP1 §9.4) and without the
 * affected-page lists (addresses taken from the audited site).
 */
function codeRenderedMain(markup: string): string {
  const main = markup.slice(markup.indexOf("<main>"), markup.indexOf("</main>"));
  const ai = blockOf(main, `<div class="exec-ai">`, "div");
  return (ai === "" ? main : main.replace(ai, "")).replace(/<ul class="affected-list">[\s\S]*?<\/ul>/g, "");
}

/** Whether the printed text of some markup carries a digit: tags and character references (such as &#39;) are not text. */
const hasDigit = (markup: string) => /\d/.test(markup.replace(/<[^>]*>/g, " ").replace(/&#\d+;/g, "'"));

/** The scope figures S2 suppresses, exactly as the card renderer prints them (the scope line and the evidence heading). */
const withoutScopeFigures = (markup: string) =>
  markup
    .replace(/<p class="finding-meta">Found on \d+ of \d+ pages checked\.<\/p>/g, "")
    .replace(/ \(found on \d+ of \d+ pages\)/g, "");

/** A document for the audit, with validator-approved AI commentary attached the way the explain job attaches it. */
function documentWithCommentary(audit: SiteAuditResult): PdfDocument {
  const input = buildAIReportInput(audit);
  const checked = validateExplanations(input, {
    version: AI_CONTRACT_VERSION,
    executiveSummary: "COMMENTARY-SUMMARY sentence about the site as a whole.",
    explanations: input.findings.slice(0, 3).map((finding) => ({
      ruleId: finding.ruleId,
      explanation: "COMMENTARY-EXPLANATION for this finding.",
      businessImpact: "COMMENTARY-IMPACT for this finding.",
      recommendation: "COMMENTARY-RECOMMENDATION for this finding.",
    })),
  });
  if (!checked.ok) return assert.fail(checked.reason);
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult, SpeedResult["data"]>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", audit);
  store.setExplanation(job.id, { state: "explained", explanations: checked.accepted, rejected: checked.rejected, partial: checked.rejected.length > 0 });
  const outcome = buildPdfDocument(job.id, store);
  if (!outcome.ok) assert.fail(outcome.reason);
  return outcome.document;
}

/**
 * T-1 (CP3 revision 9 §5.1), the fixture the step 0 characterisation ran: page
 * A has an image without alt text; page B is served almost empty, so the
 * image rule is skipped there.
 */
const t1Fixture = (async () => {
  const SPA_HTML = `<html lang="en"><head>
<title>Shop</title>
<meta name="description" content="Our shop.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://shop.test/">
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
  return runRealAudit({
    site: {
      "https://example.com/": {
        html: page("Example Company", `<h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p><img src="/hero.png"><a href="/app">Shop</a>`),
      },
      "https://example.com/app": { html: SPA_HTML },
    },
  });
})();

/** Every real-audit document these checks read, by name. */
async function allDocuments(): Promise<Array<[string, PdfDocument]>> {
  const { partial, single, certificate, failing } = await fixtures;
  const t1 = await t1Fixture;
  return [
    ["V with AI commentary", documentWithCommentary(partial)],
    ["V with a speed finding", documentOf(partial, speedResultWithFinding(partial))],
    ["single page", documentOf(single)],
    ["certificate failure", documentOf(certificate)],
    ["T1", documentOf(t1)],
    ...Object.entries(failing).map(([name, audit]): [string, PdfDocument] => [name, documentOf(audit)]),
  ];
}

// ---------------------------------------------------------------------------
// §10 item 2: repetition
// ---------------------------------------------------------------------------

test("§10-2: the coverage sentence appears at most once, only in the Executive Summary, and only with reconciled counts", async () => {
  for (const [name, doc] of await allDocuments()) {
    const out = documentHtml(doc);
    const n = count(out, "We found ");
    assert.ok(n <= 1, `${name}: at most once`);
    if (n === 1) assert.ok(blockOf(out, `<div class="exec-coverage">`, "div").includes("We found "), `${name}: in the Executive Summary`);
    if (doc.coverageCounts === null) assert.equal(n, 0, `${name}: never without reconciled counts`);
  }
});

test("§10-2: the grade and the category tiles appear only in the Executive Summary", async () => {
  for (const [name, doc] of await allDocuments()) {
    const out = documentHtml(doc);
    const exec = sectionOf(out, "exec-summary");
    const outside = out.replace(exec, "");
    for (const pattern of [/Overall grade: /, /\b(Security|SEO|Speed|Technical): [A-F], based on /, /class="exec-tile/, /class="score-/]) {
      assert.ok(!pattern.test(outside), `${name}: ${pattern} outside the Executive Summary`);
    }
    assert.equal(count(exec, `<ul class="exec-tiles">`), 1, `${name}: the tiles once`);
  }
});

test("§10-2: no \"Resolve the … issue\" wording anywhere in the document", async () => {
  for (const [name, doc] of [...(await allDocuments()), ["test document", testDocument()] as [string, PdfDocument]]) {
    assert.ok(!documentHtml(doc).includes("Resolve the"), name);
  }
});

test("§10-2: no AI block on any finding card, even when AI commentary was produced for those findings", async () => {
  const { partial } = await fixtures;
  const doc = documentWithCommentary(partial);
  const out = documentHtml(doc);
  // The commentary really was attached: the summary paragraph is printed once, in the Executive Summary.
  assert.equal(count(out, "COMMENTARY-SUMMARY"), 1);
  assert.ok(sectionOf(out, "exec-summary").includes("COMMENTARY-SUMMARY"));
  const cards = cardsOf(out);
  assert.ok(cards.size > 0);
  for (const [title, card] of cards) {
    for (const needle of ["COMMENTARY-", "ai-label", "client-ai", escapeHtml(AI_SUMMARY_LABEL)]) {
      assert.ok(!card.includes(needle), `${title}: ${needle}`);
    }
  }
  for (const needle of ["COMMENTARY-EXPLANATION", "COMMENTARY-IMPACT", "COMMENTARY-RECOMMENDATION"]) {
    assert.ok(!out.includes(needle), `${needle} is printed nowhere`);
  }
});

test("§10-2 (D1 reading a): Limitations content appears only in the final section", async () => {
  for (const [name, doc] of await allDocuments()) {
    const out = documentHtml(doc);
    const limitationsAt = out.indexOf(`<section class="limitations">`);
    assert.ok(limitationsAt > 0, name);
    assert.equal(headingsOf(out).at(-1), LIMITATIONS_HEADING, `${name}: the final section`);
    const onlyInLimitations = [
      html`<h2>${LIMITATIONS_HEADING}</h2>`,
      html`<p class="lead">${LIMITATIONS_INTRO}</p>`,
      ...Object.values(LIMITATIONS_SUBHEADINGS).map((heading) => html`<h3>${heading}</h3>`),
      ...NOT_PART_OF_THIS_AUDIT.map((item) => html`<li>${item}</li>`),
      aboutClausesHtml(4),
      ...(doc.skipped !== null && doc.skipped.groups.length > 0 ? [skippedGroupsHtml(doc.skipped.groups)] : []),
    ];
    for (const markup of onlyInLimitations) {
      const at = out.indexOf(markup);
      if (at < 0) continue;
      assert.ok(at > limitationsAt, `${name}: ${markup.slice(0, 60)} printed before Limitations`);
      assert.equal(count(out, markup), 1, `${name}: ${markup.slice(0, 60)} once`);
    }
    assert.ok(out.includes(aboutClausesHtml(4)), `${name}: the About clauses`);
    assert.ok(!out.includes(aboutClausesHtml(3)), `${name}: no About clauses at the old level`);
  }
});

// ---------------------------------------------------------------------------
// §9.4 group C: per-location suppression on I1–I6
// ---------------------------------------------------------------------------

test("group C, S3-w1: a limit stop whose counts do not reconcile gives the approved sentence, and no limit figure", async () => {
  const { partial, failing } = await fixtures;
  assert.equal(SAFETY_LIMIT_STOP, "The audit stopped after reaching its configured safety limit.", "CP1 v6 §9.3, item 5");
  assert.equal(partial.crawl.stoppedBecause, "max-pages", "the fixture is a limit stop");
  const limitStops: string[] = [];
  for (const [name, audit] of Object.entries(failing)) {
    const doc = documentOf(audit);
    if (!doc.coverage.partial) continue; // I45 is marked complete, so it has no stop reason at all.
    limitStops.push(name);
    assert.equal(audit.crawl.stoppedBecause, "max-pages", name);
    assert.equal(doc.coverage.stopReason, SAFETY_LIMIT_STOP, name);
    const out = documentHtml(doc);
    assert.ok(blockOf(out, `<div class="exec-coverage">`, "div").includes(html`<p>${SAFETY_LIMIT_STOP}</p>`), `${name}: Executive Summary`);
    assert.ok(sectionOf(out, "limitations").includes(html`<p>${SAFETY_LIMIT_STOP}</p>`), `${name}: Limitations`);
    assert.ok(!out.includes("-page safety limit"), `${name}: never the form with the figure`);
  }
  assert.deepEqual(limitStops, ["I1", "I23", "I6"]);
});

test("group C: on I1–I6 no coverage or scope figure is printed at any code-rendered location", async () => {
  const { partial, failing } = await fixtures;
  const valid = documentOf(partial);
  assert.ok(valid.coverageCounts !== null, "the valid fixture carries figures that could leak");
  const validCoverage = blockOf(documentHtml(valid), `<div class="exec-coverage">`, "div");
  const leaks = [...validCoverage.matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]).filter((text) => hasDigit(text));
  assert.equal(leaks.length, 3, "the valid coverage sentence, exclusion count and stop reason");

  for (const [name, audit] of Object.entries(failing)) {
    const doc = documentOf(audit);
    const out = documentHtml(doc);
    const limitsNote = html`<p class="note">${doc.configuredLimitsSentence}</p>`;

    // Executive Summary: no coverage sentence and no exclusion count; X1 instead.
    const coverage = blockOf(out, `<div class="exec-coverage">`, "div");
    assert.ok(!hasDigit(coverage), `${name}: the coverage paragraphs carry no figure`);
    assert.ok(coverage.includes(html`<p>${ROBOTS_EXCLUDED_UNCOUNTED}</p>`), `${name}: X1 in the Executive Summary`);

    // Area text and the improvements list: no finding-scope figures.
    const areas = blockOf(out, `<div class="exec-areas-new">`, "div");
    assert.ok(areas !== "" && !/\d+ of \d+/.test(areas) && !/\d+ (pages?|addresses)\b/.test(areas), `${name}: area text`);
    const improvements = blockOf(out, `<div class="exec-improvements">`, "div");
    assert.ok(improvements !== "" && !hasDigit(improvements), `${name}: improvements list`);

    // Technical: no crawl table, and the configured limits are its only figure.
    const technical = sectionOf(out, "technical-audit");
    assert.ok(!technical.includes(`<div class="crawl-table">`), `${name}: no crawl table`);
    assert.equal(count(technical, limitsNote), 1, `${name}: configured limits in Technical`);
    assert.ok(!hasDigit(technical.replace(limitsNote, "")), `${name}: Technical carries no other figure`);

    // Limitations: no coverage figures. Set aside: the configured limits and the engine's own skip reasons, printed verbatim.
    const limitations = sectionOf(out, "limitations");
    assert.ok(!limitations.includes(html`<h3>${LIMITATIONS_SUBHEADINGS.pages}</h3>`), `${name}: no pages table`);
    const skippedBlock = doc.skipped === null ? "" : skippedGroupsHtml(doc.skipped.groups);
    const limitationsRest = limitations.replace(html`<p>${doc.configuredLimitsSentence}</p>`, "").replace(skippedBlock, "");
    assert.ok(!hasDigit(limitationsRest), `${name}: Limitations carries no coverage figure`);

    // Cards: no scope line with figures (S2-a), the evidence heading without figures, addresses and evidence kept.
    const cards = cardsOf(out);
    assert.ok(cards.size > 0, name);
    for (const [title, card] of cards) {
      assert.ok(!/finding-meta">Found on \d/.test(card), `${name}: ${title}: no scope figures`);
      assert.ok(!card.includes("(found on"), `${name}: ${title}: evidence heading without figures`);
      assert.ok(card.includes(`<ul class="affected-list"><li>`), `${name}: ${title}: addresses kept`);
      assert.ok(card.includes(`<p class="evidence">`), `${name}: ${title}: evidence kept`);
    }

    // S3-x: none of the valid fixture's crawl sentences, and no crawl figure outside the configured-limits sentence.
    const rest = codeRenderedMain(out).split(doc.configuredLimitsSentence).join("");
    for (const text of leaks) assert.ok(!rest.includes(text), `${name}: "${text}"`);
    assert.ok(!/\b\d+-page\b/.test(rest) && !rest.includes("addresses on this website"), `${name}: no crawl figure`);
  }
});

test("group C, TR1: the truncation note follows the list being cut short, in the valid and the invalid state", async () => {
  const { partial, failing } = await fixtures;
  for (const [name, doc] of [["V", documentOf(partial)], ["I1", documentOf(failing.I1)]] as Array<[string, PdfDocument]>) {
    const findings = [...doc.siteFindings.groups, ...doc.pageFindings.groups].flatMap((group) => group.findings);
    assert.ok(findings.some((f) => f.truncated), `${name}: a list that was cut short`);
    assert.ok(findings.some((f) => !f.truncated && f.affected.length > 0), `${name}: a list that was not`);
    const cards = cardsOf(documentHtml(doc));
    for (const finding of findings) {
      const card = cards.get(escapeHtml(finding.title)) ?? assert.fail(finding.title);
      assert.equal(card.includes(html`<p class="note">${AFFECTED_LIST_TRUNCATED}</p>`), finding.truncated, `${name}: ${finding.title}`);
    }
  }
});

test("group C, S3-w2: the configured limits are printed, labelled and with the unit, in the valid and the invalid states", async () => {
  const { partial, failing } = await fixtures;
  for (const [name, audit] of [["V", partial], ...Object.entries(failing)] as Array<[string, SiteAuditResult]>) {
    const doc = documentOf(audit);
    assert.equal(doc.configuredLimitsSentence, "Configured limits for this audit: up to 56 pages and 5 minutes.", name);
    const out = documentHtml(doc);
    assert.ok(sectionOf(out, "technical-audit").includes(doc.configuredLimitsSentence), `${name}: Technical`);
    assert.ok(sectionOf(out, "limitations").includes(doc.configuredLimitsSentence), `${name}: Limitations`);
  }
});

// ---------------------------------------------------------------------------
// §9.4 group D: figures the invariants do not cover stay the same
// ---------------------------------------------------------------------------

test("group D: dates, speed, scores, tiles, certificate and DNS values and rule evidence are unchanged on I1–I6", async () => {
  const { partial, failing } = await fixtures;
  const valid = documentOf(partial);
  const validOut = documentHtml(valid);
  const validCards = cardsOf(validOut);
  const blocks: Array<[string, string]> = [
    [`<p class="cover-date">`, "p"],
    [`<p class="exec-verdict">`, "p"],
    [`<ul class="exec-figures">`, "ul"],
    [`<ul class="exec-tiles">`, "ul"],
    [`<div class="score-gate">`, "div"],
    [`<section class="speed">`, "section"],
  ];

  for (const [name, audit] of Object.entries(failing)) {
    const doc = documentOf(audit);
    const out = documentHtml(doc);

    // The model's own values.
    assert.deepEqual(doc.cover.checkedAt, valid.cover.checkedAt, `${name}: date`);
    /*
     * The one permitted difference: I45 is the fixture whose crawl is marked
     * complete, so the score's partial-crawl note follows that flag (CP1 v6
     * §9.3 item 6, "the partial-crawl mention"). It is driven by `complete`,
     * never by the counts, and carries no figure.
     */
    assert.ok(valid.score !== null && doc.score !== null);
    assert.equal(doc.score.partialNote, doc.coverage.partial ? valid.score.partialNote : null, `${name}: the partial-crawl note follows the flag`);
    assert.deepEqual({ ...doc.score, partialNote: null }, { ...valid.score, partialNote: null }, `${name}: scores, grade and tiles`);
    assert.deepEqual(doc.speed, valid.speed, `${name}: speed`);
    assert.deepEqual(doc.desktopSpeed, valid.desktopSpeed, `${name}: desktop speed`);
    assert.deepEqual(doc.measured, valid.measured, `${name}: certificate, DNS and other measured values`);

    // As printed.
    for (const [open, tag] of blocks) {
      const printed = blockOf(validOut, open, tag);
      assert.ok(printed !== "", `${open} is printed`);
      assert.equal(blockOf(out, open, tag), printed, `${name}: ${open}`);
    }
    // SEO and Security, measurement tables and site cards included: identical once the S2 scope figures are set aside.
    for (const where of ["seo-audit", "security-audit"]) {
      assert.equal(withoutScopeFigures(sectionOf(out, where)), withoutScopeFigures(sectionOf(validOut, where)), `${name}: ${where}`);
    }
    // Every card, block by block, apart from the S2 scope figures: evidence, evidence tables and addresses.
    const cards = cardsOf(out);
    assert.deepEqual([...cards.keys()], [...validCards.keys()], `${name}: the same cards`);
    for (const [title, card] of cards) {
      assert.equal(withoutScopeFigures(card), withoutScopeFigures(validCards.get(title)!), `${name}: ${title}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Q25 (revision 9 §5.4)
// ---------------------------------------------------------------------------

test("Q25: a certificate failure with Security or Technical graded prints the sentence once, straight after the tiles", async () => {
  const { certificate } = await fixtures;
  const out = documentHtml(documentOf(certificate));
  const tiles = blockOf(out, `<ul class="exec-tiles">`, "ul");
  assert.ok(/<span class="exec-tile-text">(Security|Technical): [A-F], based on /.test(tiles), "Security or Technical is graded");
  assert.equal(count(out, CHECKS_COUNTED_SENTENCE), 1);
  assert.ok(out.includes(tiles + html`<p class="exec-note">${CHECKS_COUNTED_SENTENCE}</p>`));
});

test("Q25: wherever it is printed, the sentence appears once, straight after the tiles, and nowhere else", async () => {
  for (const [name, doc] of await allDocuments()) {
    const out = documentHtml(doc);
    const n = count(out, CHECKS_COUNTED_SENTENCE);
    assert.ok(n <= 1, name);
    if (n === 1) {
      assert.ok(out.includes(blockOf(out, `<ul class="exec-tiles">`, "ul") + html`<p class="exec-note">${CHECKS_COUNTED_SENTENCE}</p>`), name);
    }
  }
});

// ---------------------------------------------------------------------------
// T-1 (revision 9 §5.1)
// ---------------------------------------------------------------------------

test("T-1: one rule found on page A and skipped on page B is shown as found, scoped 1 of 1, with the reason in Limitations", async () => {
  const audit = await t1Fixture;
  // The engine results the step 0 characterisation recorded against the trace (results 1 and 2).
  const finding = audit.site.findings.find((f) => f.id === "seo.images.alt") ?? assert.fail("result 1: the finding");
  assert.equal(finding.affectedCount, 1);
  assert.equal(finding.evaluatedPages, 1);
  assert.deepEqual(finding.affected?.map((a) => a.url), ["https://example.com/"]);
  const skipped = audit.site.skippedChecks.filter((s) => s.ruleId === "seo.images.alt");
  assert.equal(skipped.length, 1, "result 2: one skipped entry");
  assert.equal(audit.crawl.evaluated, 2, "two pages read, so not a single-page audit (Q20)");

  const out = documentHtml(documentOf(audit));
  const title = "Images without alt text";

  // The checklist line: a finding plus a skipped entry is shown as the issue (revision 9 §1.9, row 3).
  assert.ok(sectionOf(out, "seo-audit").includes(
    html`<li class="check"><span class="check-label">Image descriptions (alt text)</span><br><span class="check-status">${pageIssueLine(title)}</span></li>`,
  ));
  // The card, once, in Page-Level Issues, with the O1 scope line.
  const card = cardsOf(out).get(title) ?? assert.fail("the card");
  assert.equal(count(out, `<h4 class="finding-title">${title}</h4>`), 1);
  assert.ok(sectionOf(out, "findings page-level-issues").includes(card));
  assert.ok(card.includes(`<p class="finding-meta">Found on 1 of 1 pages checked.</p>`));
  // The skipped reason, verbatim, in Limitations.
  assert.ok(sectionOf(out, "limitations").includes(escapeHtml(skipped[0].reason)));
});

// ---------------------------------------------------------------------------
// §10 item 9: wording guard
// ---------------------------------------------------------------------------

test("§10-9: no retired or ruled-out wording in any code-rendered part of the document", async () => {
  /*
   * Each phrase is one the approved plan rules out, with its source:
   *   "Resolve the"               CP1 v6 §10, item 2
   *   "% assessed"                CP3 revision 9 §5.4
   *   "Showing {n} of {n}"        CP3 revision 9 §1.4 (TR1 replaces it)
   *   "Not applicable:"           CP3 revision 9 §1.9
   *   "No Technical issues found" CP3 revision 9 §1.10
   *   " — " in a checklist line   CP3 revision 9 §1.17
   * Only code-rendered text is read: not the AI paragraph and not the addresses
   * taken from the audited site.
   */
  for (const [name, doc] of [...(await allDocuments()), ["test document", testDocument()] as [string, PdfDocument]]) {
    const text = codeRenderedMain(documentHtml(doc));
    for (const phrase of ["Resolve the", "% assessed", "Not applicable:", "No Technical issues found"]) {
      assert.ok(!text.includes(phrase), `${name}: ${phrase}`);
    }
    assert.ok(!/Showing \d+ of \d+/.test(text), `${name}: Showing n of n`);
    const lines = text.match(/<li class="check">[\s\S]*?<\/li>/g) ?? [];
    // The synthetic test document carries no checklist; every real audit does.
    if (name !== "test document") assert.ok(lines.length > 0, `${name}: checklist lines`);
    for (const line of lines) assert.ok(!line.includes(" — "), `${name}: ${line}`);
  }
});

// ===========================================================================
// CP3 step 6: T-2, T-4 and T-6 (CP3 revision 5 §1.9, carried unchanged into
// revisions 7 and 8; site-rule lines per Q18a and Q18b).
// ===========================================================================

/** Every card the document carries, page, site and speed, by rule id. */
const cardsForRule = (doc: PdfDocument, ruleId: string): PdfFinding[] =>
  [...doc.pageFindings.groups, ...doc.siteFindings.groups]
    .flatMap((group) => group.findings)
    .concat(doc.speedFindings)
    .filter((card) => card.ruleId === ruleId);

/** One check-list line exactly as the category sections print it. */
const checkLine = (ruleId: string, status: string) =>
  html`<li class="check"><span class="check-label">${CHECK_LABELS[ruleId]}</span><br><span class="check-status">${status}</span></li>`;

/**
 * The scope each T-2 and T-4 case is chosen for. Asserted against the rule
 * registry (`AUDIT_RULES`), which is the authority; nothing here defines a
 * scope, it only states which kind of rule the case is meant to exercise.
 */
const CASE_SCOPE: Readonly<Record<string, "page" | "site">> = {
  "seo.viewport.missing": "page",
  "security.dns.spf": "site",
  "seo.lang.missing": "page",
  "technical.robots.blocks-all": "site",
};
const assertRegistryScope = (ruleId: string) => {
  const rule = AUDIT_RULES.find((r) => r.id === ruleId);
  assert.ok(rule !== undefined, `${ruleId} is in the rule registry`);
  assert.equal(rule.scope, CASE_SCOPE[ruleId], `${ruleId} is a ${CASE_SCOPE[ruleId]} rule`);
};

/**
 * Nothing in Limitations for the rule: its registry title is in no skipped
 * group of the model, and none of its registry title, finding title or check
 * label is printed in the extracted Limitations section. The section and its
 * skipped groups are first shown to exist, so this cannot pass on an empty or
 * missing section.
 */
function assertNothingInLimitations(doc: PdfDocument, out: string, ruleId: string, findingTitle: string | null): void {
  const limitations = sectionOf(out, "limitations");
  assert.ok(limitations.includes(html`<h2>${LIMITATIONS_HEADING}</h2>`), "the Limitations section is present");
  assert.ok(doc.skipped !== null && doc.skipped.groups.length > 0, "the fixture has skipped checks, so Limitations lists some");
  assert.ok(limitations.includes(skippedGroupsHtml(doc.skipped.groups)), "and prints them");
  const registryTitle = ruleTitle(ruleId);
  assert.notEqual(registryTitle, ruleId, `${ruleId} has a registry title`);
  for (const group of doc.skipped.groups) assert.ok(!group.checks.includes(registryTitle), `${ruleId}: no skipped group names it`);
  for (const name of [registryTitle, CHECK_LABELS[ruleId], ...(findingTitle === null ? [] : [findingTitle])]) {
    assert.ok(!limitations.includes(escapeHtml(name)), `${ruleId}: "${name}" is not in Limitations`);
  }
}

test("T-2: a rule with a finding only shows the issue line and its card once, and nothing in Limitations (page rule and site rule)", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial);
  const out = documentHtml(doc);

  for (const [ruleId, section, cardSection, lineFor] of [
    ["seo.viewport.missing", "seo-audit", "findings page-level-issues", pageIssueLine],
    ["security.dns.spf", "security-audit", "security-audit", siteIssueLine],
  ] as const) {
    // Preconditions, from the audit data: ran, found, never skipped.
    assertRegistryScope(ruleId);
    assert.ok(partial.site.ranRules?.includes(ruleId), `${ruleId} is in ranRules`);
    const finding = partial.site.findings.find((f) => f.id === ruleId && f.severity !== "good");
    assert.ok(finding !== undefined, `${ruleId} has a finding`);
    assert.ok(!partial.site.skippedChecks.some((s) => s.ruleId === ruleId), `${ruleId} has no skipped entry`);

    // The approved line (row 2; Q18a for the site rule), in its own category section.
    assert.ok(sectionOf(out, section).includes(checkLine(ruleId, lineFor(finding.title))), `${ruleId}: the issue line in ${section}`);

    // The card, by rule identity: one in the model, printed once, in its section.
    const cards = cardsForRule(doc, ruleId);
    assert.equal(cards.length, 1, `${ruleId}: one card in the model`);
    const heading = `<h4 class="finding-title">${escapeHtml(cards[0].title)}</h4>`;
    assert.equal(count(out, heading), 1, `${ruleId}: printed once`);
    assert.equal(count(sectionOf(out, cardSection), heading), 1, `${ruleId}: in ${cardSection}`);

    assertNothingInLimitations(doc, out, ruleId, finding.title);
  }
});

test("T-4: a rule that ran clean shows the no-issue line, no card and nothing in Limitations (page rule; site rule per Q18b)", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial);
  const out = documentHtml(doc);

  for (const [ruleId, section, expected] of [
    ["seo.lang.missing", "seo-audit", CHECK_STATUS_LINES.noIssue],
    ["technical.robots.blocks-all", "technical-audit", SITE_NO_ISSUE_LINE],
  ] as const) {
    // Preconditions, from the audit data: ran, found nothing, never skipped.
    assertRegistryScope(ruleId);
    assert.ok(partial.site.ranRules?.includes(ruleId), `${ruleId} is in ranRules`);
    assert.ok(!partial.site.findings.some((f) => f.id === ruleId), `${ruleId} has no finding`);
    assert.ok(!partial.site.skippedChecks.some((s) => s.ruleId === ruleId), `${ruleId} has no skipped entry`);

    // The approved line, in its own category section; the site rule never takes the page wording.
    const sectionMarkup = sectionOf(out, section);
    assert.ok(sectionMarkup.includes(checkLine(ruleId, expected)), `${ruleId}: "${expected}" in ${section}`);
    if (expected === SITE_NO_ISSUE_LINE) {
      assert.ok(!sectionMarkup.includes(checkLine(ruleId, CHECK_STATUS_LINES.noIssue)), `${ruleId}: not the page-rule wording`);
    }

    // No card, by rule identity in the model and by the rule's title in print.
    assert.equal(cardsForRule(doc, ruleId).length, 0, `${ruleId}: no card in the model`);
    assert.ok(!out.includes(`<h4 class="finding-title">${escapeHtml(ruleTitle(ruleId))}</h4>`), `${ruleId}: no card printed`);

    assertNothingInLimitations(doc, out, ruleId, null);
  }
});

test("T-6: the check lists do not change when every skipped check's reason is reworded", async () => {
  const { partial } = await fixtures;
  const pristine = structuredClone(partial);
  const original = documentOf(partial);

  // The same audit, with only the reason text changed: every distinct reason gets a different, unrelated sentence.
  const reworded = structuredClone(partial);
  const replacement = new Map<string, string>();
  const reword = (reason: string) => {
    if (!replacement.has(reason)) replacement.set(reason, `Reworded reason ${replacement.size + 1}: an unrelated sentence with none of the original words.`);
    return replacement.get(reason)!;
  };
  // The same entry object can sit in more than one list (data.skippedChecks shares the entry page's
  // entries), and the copy keeps that sharing: each object is reworded once, from its original reason.
  const reworded_ = new WeakSet<object>();
  const rewordAll = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(rewordAll);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "skippedChecks" && Array.isArray(value)) {
        for (const entry of value) {
          if (reworded_.has(entry)) continue;
          reworded_.add(entry);
          (entry as { reason: string }).reason = reword((entry as { reason: string }).reason);
        }
      } else {
        rewordAll(value);
      }
    }
  };
  rewordAll(reworded);

  // Preconditions: there were skipped checks; only their reasons changed; the fixture itself is untouched.
  const before = partial.site.skippedChecks;
  const after = reworded.site.skippedChecks;
  assert.ok(before.length > 0, "the fixture has skipped checks");
  assert.deepEqual(after.map((s) => s.ruleId), before.map((s) => s.ruleId), "same rule ids, same order");
  assert.ok(after.every((s, i) => s.reason !== before[i].reason), "every reason was reworded");
  assert.deepEqual(after.map((s) => ({ ...s, reason: "" })), before.map((s) => ({ ...s, reason: "" })), "nothing else in an entry changed");
  assert.ok(!before.some((s) => s.reason.startsWith("Reworded reason")), "the shared fixture was not mutated");

  const changed = documentOf(reworded);
  // The reworded text really reached the production path...
  assert.notDeepEqual(changed.skipped, original.skipped, "the reworded reasons reached the document");
  // ...and the check lists cover the skipped rules with a status that depends on them, so equality is not vacuous.
  const skippedIds = new Set(before.map((s) => s.ruleId));
  const affected = original.checklists.flatMap((list) => list.items).filter((item) => skippedIds.has(item.ruleId));
  assert.ok(affected.length > 0 && affected.every((item) => item.status !== "no-issue"), "skipped rules are on the check lists and not passed");

  assert.deepEqual(changed.checklists, original.checklists, "the check lists are identical");

  // The whole audit input, not only the site-level list: only reason strings differ, and the fixture is untouched.
  assertOnlySkippedReasonsDiffer(partial, reworded);
  assert.deepEqual(partial, pristine, "the shared fixture is exactly as it was");
});

/** Every entry of every skipped-check list anywhere in the value, in a fixed walk order. */
function skippedEntriesIn(node: unknown, found: Array<{ ruleId: string; reason: string }> = []): Array<{ ruleId: string; reason: string }> {
  if (Array.isArray(node)) {
    for (const item of node) skippedEntriesIn(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "skippedChecks" && Array.isArray(value)) found.push(...(value as Array<{ ruleId: string; reason: string }>));
      else skippedEntriesIn(value, found);
    }
  }
  return found;
}

/** A deep copy with every skipped-check reason set to "", and nothing else touched. */
function withoutSkippedReasons<T>(value: T): T {
  const copy = structuredClone(value);
  for (const entry of skippedEntriesIn(copy)) entry.reason = "";
  return copy;
}

/**
 * A deep copy in which each distinct skipped-check reason is replaced by its own different sentence.
 *
 * The same entry object can appear in more than one list (data.skippedChecks shares the entry page's
 * entries), and the copy keeps that sharing, so each object is reworded exactly once, from its
 * original reason.
 */
function rewordSkippedReasons<T>(value: T): T {
  const copy = structuredClone(value);
  const replacement = new Map<string, string>();
  const done = new WeakSet<object>();
  for (const entry of skippedEntriesIn(copy)) {
    if (done.has(entry)) continue;
    done.add(entry);
    if (!replacement.has(entry.reason)) replacement.set(entry.reason, `Changed wording ${replacement.size + 1}: a sentence that replaces the original reason.`);
    entry.reason = replacement.get(entry.reason)!;
  }
  return copy;
}

/**
 * The two audit inputs differ only in skipped-check reason strings: every
 * skipped-check list, at every level, has the same length, order and rule ids,
 * every reason changed, and the inputs are deeply equal once reasons are blanked.
 */
function assertOnlySkippedReasonsDiffer(before: unknown, after: unknown): void {
  const was = skippedEntriesIn(before);
  const now = skippedEntriesIn(after);
  assert.ok(was.length > 0, "the input has skipped checks");
  assert.equal(now.length, was.length, "every skipped-check list keeps its length");
  assert.deepEqual(now.map((e) => e.ruleId), was.map((e) => e.ruleId), "same rule ids, same order, at every level");
  assert.ok(now.every((e, i) => e.reason !== was[i].reason), "every reason, at every level, was changed");
  assert.deepEqual(withoutSkippedReasons(after), withoutSkippedReasons(before), "nothing but reason strings differs");
}

test("T-6: a partly checked rule keeps its status, and the check lists stay identical, when every reason is reworded", async () => {
  // T1 is the existing two-page fixture: page B is too thin to judge headings, so the heading rules
  // ran on page A and were skipped on page B. It also has rules skipped everywhere (cookies, TLS).
  const t1 = await t1Fixture;
  const pristine = structuredClone(t1);
  const ruleId = "seo.h1.missing";

  // Preconditions, from the audit data: a page rule that ran, was also skipped, and found nothing.
  assert.equal(AUDIT_RULES.find((r) => r.id === ruleId)?.scope, "page", `${ruleId} is a page rule`);
  assert.ok(t1.site.ranRules?.includes(ruleId), `${ruleId} is in ranRules`);
  assert.ok(t1.site.skippedChecks.some((s) => s.ruleId === ruleId), `${ruleId} has a skipped entry`);
  assert.ok(!t1.site.findings.some((f) => f.id === ruleId), `${ruleId} has no finding`);

  const reworded = rewordSkippedReasons(t1);
  assertOnlySkippedReasonsDiffer(t1, reworded);

  const original = documentOf(t1);
  const changed = documentOf(reworded);
  const statusIn = (doc: PdfDocument, id: string) => doc.checklists.flatMap((list) => list.items).find((item) => item.ruleId === id)?.status;

  // The selected rule is genuinely "partly" in both documents, through the production path.
  assert.equal(statusIn(original, ruleId), "partly", "original: partly checked");
  assert.equal(statusIn(changed, ruleId), "partly", "reworded: partly checked");
  // Both skipped-rule paths are exercised: partly checked and not checked.
  const skippedIds = [...new Set(t1.site.skippedChecks.map((s) => s.ruleId))];
  const statuses = new Set(skippedIds.map((id) => statusIn(original, id)));
  assert.ok(statuses.has("partly") && statuses.has("not-checked"), `both paths: ${[...statuses].join(", ")}`);

  // The reworded text reached the document's Limitations data, and only the new wording is there.
  assert.ok(changed.skipped !== null && original.skipped !== null);
  assert.notDeepEqual(changed.skipped, original.skipped);
  assert.ok(changed.skipped.groups.every((group) => group.reason.startsWith("Changed wording ")), "every Limitations reason is the new wording");
  assert.deepEqual(changed.skipped.groups.map((g) => g.checks), original.skipped.groups.map((g) => g.checks), "the same checks, grouped the same way");

  assert.deepEqual(changed.checklists, original.checklists, "the check lists are identical");
  assert.deepEqual(t1, pristine, "the shared fixture is exactly as it was");
});

// ===========================================================================
// CP4 stage 4b: the Speed glossary and real-visitor explanation, in the whole
// document (decision record rev. 3: P-1, P-4, P-5, P-11).
// ===========================================================================

/**
 * A checked mobile speed result attached the way the speed check attaches it,
 * with the real-visitor half found or absent and the simulated half scored,
 * found without a score, or failed.
 */
function checkedMobileSpeed(over: {
  field: boolean;
  lab: "score" | "no-score" | "error";
  requestedUrl?: string;
  withFinding?: boolean;
}): SpeedResult {
  const field = over.field
    ? {
        status: "found", measuredUrl: "https://example.com/", scope: "page", overall: "AVERAGE",
        lcp: { percentileMs: 2400, category: "AVERAGE" }, inp: { percentileMs: 180, category: "FAST" },
        cls: { percentile: 0.12, category: "AVERAGE" }, fcp: { percentileMs: 1800, category: "AVERAGE" },
        ttfb: { percentileMs: 700, category: "AVERAGE" }, error: null,
      }
    : { status: "absent", measuredUrl: null, scope: null, overall: null, lcp: null, inp: null, cls: null, fcp: null, ttfb: null, error: null };
  const lab =
    over.lab === "error"
      ? { status: "error", measuredUrl: null, score: null, lcpMs: null, fcpMs: null, tbtMs: null, speedIndexMs: null, cls: null, error: "No lab result." }
      : { status: "found", measuredUrl: "https://example.com/", score: over.lab === "score" ? 74 : null, lcpMs: 3100, fcpMs: 1200, tbtMs: 240, speedIndexMs: 2600, cls: 0.045, error: null };
  return {
    data: {
      status: "checked", strategy: "mobile", requestedUrl: over.requestedUrl ?? "https://example.com/", failureReason: null,
      field, lab, notInspected: [], message: "Measured.",
    },
    findings: over.withFinding
      ? [{ id: SPEED_RULES[0].id, title: "SPEED-FINDING-TITLE", category: "speed", severity: "high", evidence: "Measured.", remediation: "Fix it." }]
      : [],
    skippedChecks: [],
  } as unknown as SpeedResult;
}

const REAL_VISITOR_H3 = `<h3>${escapeHtml(REAL_VISITOR_HEADING)}</h3>`;

test("CP4 4b: the explanation is printed exactly when the Executive Summary does not say speed could not be measured", async () => {
  const { partial } = await fixtures;
  const cases: Array<[string, SpeedResult | undefined, boolean]> = [
    ["not requested", undefined, false],
    ["real-visitor data and a score", checkedMobileSpeed({ field: true, lab: "score" }), true],
    ["real-visitor data, failed simulation", checkedMobileSpeed({ field: true, lab: "error" }), true],
    ["no real-visitor data, a score", checkedMobileSpeed({ field: false, lab: "score" }), true],
    ["no real-visitor data, simulation without a score", checkedMobileSpeed({ field: false, lab: "no-score" }), false],
    ["checked, but nothing usable", checkedMobileSpeed({ field: false, lab: "error" }), false],
  ];
  for (const [name, speed, expected] of cases) {
    const doc = documentOf(partial, speed);
    const out = documentHtml(doc);
    const saysNotMeasured = sectionOf(out, "exec-summary").includes(escapeHtml(SPEED_NOT_MEASURED));
    const explains = sectionOf(out, "speed").includes(REAL_VISITOR_H3);
    assert.equal(explains, expected, `${name}: explanation`);
    assert.equal(saysNotMeasured, !expected, `${name}: the Executive Summary agrees`);
    assert.ok(!(explains && saysNotMeasured), `${name}: never both`);
  }
});

test("CP4 4b: the explanation names the requested address with credentials removed and the query kept", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial, checkedMobileSpeed({ field: true, lab: "score", requestedUrl: "https://user:secret@example.com/shop?item=7&ref=mail" }));
  const speed = sectionOf(documentHtml(doc), "speed");
  const third = realVisitorExplanation("https://example.com/shop?item=7&ref=mail")[2];
  assert.ok(speed.includes(`<p>${escapeHtml(third)}</p>`));
  assert.ok(!documentHtml(doc).includes("secret"), "the password is printed nowhere");
});

test("CP4 4b: the full real-visitor text appears once, only inside the Speed section", async () => {
  const { partial } = await fixtures;
  const out = documentHtml(documentOf(partial, checkedMobileSpeed({ field: false, lab: "score" })));
  const first = escapeHtml(realVisitorExplanation("https://example.com/")[0]);
  assert.equal(count(out, first), 1);
  assert.equal(count(sectionOf(out, "speed"), first), 1);
  assert.equal(count(out, REAL_VISITOR_H3), 1);
  assert.equal(count(out, `<h3>${escapeHtml(SPEED_GLOSSARY_HEADING)}</h3>`), 1);
});

test("CP4 4b: the block closes the Speed section, and the CP3 Speed cards still follow it straight away", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial, checkedMobileSpeed({ field: true, lab: "score", withFinding: true }));
  assert.equal(doc.speedFindings.length, 1, "the fixture carries a speed finding");
  const out = documentHtml(doc);
  const speed = speedHtml(doc.speed, doc.labels, doc.desktopSpeed);
  assert.ok(speed.includes(REAL_VISITOR_H3) && speed.includes("speed-glossary"), "the block is printed");
  assert.ok(/<div class="speed-real-visitor">[\s\S]*<\/div><\/section>$/.test(speed), "the block is the last thing in the section");
  assert.equal(count(out, speed), 1, "the Speed section, byte for byte");
  assert.ok(out.includes(speed + findingCardsHtml(doc.speedFindings, doc.labels) + `<section class="technical-audit">`), "cards straight after, then Technical");
  assert.ok(!sectionOf(out, "findings page-level-issues").includes("SPEED-FINDING-TITLE"), "never in Page-Level Issues");
});

test("CP4 4b: a certificate failure's Speed section gains nothing", async () => {
  const { certificate } = await fixtures;
  const doc = documentOf(certificate);
  const speed = sectionOf(documentHtml(doc), "speed");
  assert.ok(!speed.includes("speed-glossary") && !speed.includes("speed-real-visitor"));
});

// ===========================================================================
// CP4 stage 4c: the short real-visitor reference in Limitations, in the whole
// document (decision record rev. 3: P-7, P-8, P-10, U-5; CP1 §10 item 2).
// ===========================================================================

const REAL_VISITOR_REFERENCE_P = `<p>${escapeHtml(APPROVED_REFERENCE)}</p>`;

test("CP4 4c: the reference is printed exactly when the explanation is and mobile has no real-visitor data", async () => {
  const { partial } = await fixtures;
  const cases: Array<[string, SpeedResult | undefined, boolean, boolean]> = [
    // name, speed, explanation expected, reference expected
    ["not requested", undefined, false, false],
    ["real-visitor data and a score", checkedMobileSpeed({ field: true, lab: "score" }), true, false],
    ["real-visitor data, failed simulation", checkedMobileSpeed({ field: true, lab: "error" }), true, false],
    ["no real-visitor data, a score", checkedMobileSpeed({ field: false, lab: "score" }), true, true],
    ["no real-visitor data, simulation without a score", checkedMobileSpeed({ field: false, lab: "no-score" }), false, false],
    ["checked, but nothing usable", checkedMobileSpeed({ field: false, lab: "error" }), false, false],
  ];
  for (const [name, speed, explanation, reference] of cases) {
    const out = documentHtml(documentOf(partial, speed));
    assert.equal(sectionOf(out, "speed").includes(REAL_VISITOR_H3), explanation, `${name}: explanation`);
    assert.equal(count(out, REAL_VISITOR_REFERENCE_P), reference ? 1 : 0, `${name}: reference, once`);
    if (reference) {
      assert.equal(count(sectionOf(out, "limitations"), REAL_VISITOR_REFERENCE_P), 1, `${name}: in Limitations`);
      assert.ok(explanation, `${name}: never without the explanation it points to`);
    }
  }
});

test("CP4 4c: the full real-visitor text only in Speed, just the reference in Limitations (CP1 §10 item 2)", async () => {
  const { partial } = await fixtures;
  const out = documentHtml(documentOf(partial, checkedMobileSpeed({ field: false, lab: "score" })));
  const limitations = sectionOf(out, "limitations");
  assert.equal(count(limitations, REAL_VISITOR_REFERENCE_P), 1);
  assert.ok(!limitations.includes(REAL_VISITOR_H3));
  for (const paragraph of realVisitorExplanation("https://example.com/")) {
    const printed = escapeHtml(paragraph);
    assert.equal(count(out, printed), 1, `once: ${paragraph.slice(0, 40)}`);
    assert.equal(count(sectionOf(out, "speed"), printed), 1, `in Speed: ${paragraph.slice(0, 40)}`);
  }
});

test("CP4 4c: apart from the reference, the Limitations section is what the same audit printed without speed", async () => {
  const { partial } = await fixtures;
  const without = sectionOf(documentHtml(documentOf(partial)), "limitations");
  const withRef = sectionOf(documentHtml(documentOf(partial, checkedMobileSpeed({ field: false, lab: "score" }))), "limitations");
  assert.notEqual(withRef, without);
  assert.equal(withRef.replace(REAL_VISITOR_REFERENCE_P, ""), without);
});

test("CP4 4c: certificate failures and counts that do not reconcile print no reference", async () => {
  const { certificate, failing } = await fixtures;
  for (const [name, audit] of [["certificate failure", certificate], ...Object.entries(failing)] as Array<[string, AuditResult]>) {
    assert.ok(!documentHtml(documentOf(audit)).includes(REAL_VISITOR_REFERENCE_P), name);
  }
});
