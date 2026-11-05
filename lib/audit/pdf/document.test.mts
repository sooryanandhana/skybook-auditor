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
import { escapeHtml } from "./escape.ts";
import { findingCardsHtml, NO_PAGE_READ_SENTENCE } from "./findings.ts";
import { speedHtml } from "./speed.ts";
import { ROBOTS_EXCLUSION_WITHOUT_COUNT } from "./categorySections.ts";
import { STYLESHEET } from "./styles.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import { runRealAudit, runRealCertificateFailure, type FakeSite } from "./realAudit.fixture.mts";
import { AI_SUMMARY_LABEL } from "../../report/reportSections.ts";
import { SPEED_RULES } from "../../rules/all.ts";
import { buildPdfDocument, type PdfDocument, type PdfFinding } from "../pdfDocument.ts";
import { createJobStore } from "../../jobs/jobStore.ts";
import type { ExplainResult } from "../../ai/gemini/explain.ts";
import type { AuditResult, SiteAuditResult, SpeedResult } from "../../types.ts";

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
