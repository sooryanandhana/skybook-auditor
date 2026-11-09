/**
 * Limitations and About This Audit (CP1 F8, CP3 step 3c-ii).
 *
 * The wording copied from the report layer is held equal to it; the section's
 * structure and order are pinned; and real audits -- complete, stopped short,
 * with counts that do not reconcile (I1–I6) and a certificate failure -- are
 * put through the production projection to show that nothing is printed that
 * the audit did not establish.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import {
  LIMITATIONS_HEADING,
  LIMITATIONS_INTRO,
  LIMITATIONS_SUBHEADINGS,
  NOT_PART_OF_THIS_AUDIT,
  limitationsSectionHtml,
} from "./limitations.ts";
import { aboutClausesHtml } from "./about.ts";
import { CRAWL_TABLE_LABELS, ROBOTS_EXCLUSION_WITHOUT_COUNT } from "./categorySections.ts";
import { escapeHtml } from "./escape.ts";
import { skippedGroupsHtml } from "./skipped.ts";
import { documentHtml } from "./shell.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import { runRealAudit, runRealCertificateFailure, type FakeSite } from "./realAudit.fixture.mts";
import { SECTION_INTROS } from "../../report/reportSections.ts";
import { NOT_CHECKED_BY_THIS_AUDIT } from "../../report/overallSummary.ts";
import { buildPdfDocument, type PdfDocument } from "../pdfDocument.ts";
import { createJobStore } from "../../jobs/jobStore.ts";
import type { ExplainResult } from "../../ai/gemini/explain.ts";
import type { AuditResult, SiteAuditResult, SpeedResult } from "../../types.ts";
// CP4 stage 4c.
import { REAL_VISITOR_REFERENCE } from "./limitations.ts";
import { explainsRealVisitorData } from "./speed.ts";
import {
  REAL_VISITOR_HEADING,
  REAL_VISITOR_REFERENCE as APPROVED_REAL_VISITOR_REFERENCE,
  realVisitorExplanation,
} from "../../report/reportSections.ts";
import type { PdfSpeed } from "../pdfDocument.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const render = (over: Partial<PdfDocument> = {}) => limitationsSectionHtml(testDocument(over));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const h3 = (text: string) => `<h3>${escapeHtml(text)}</h3>`;

const COUNTS = testDocument().coverageCounts!;
const SKIPPED = {
  heading: "Checks not evaluated",
  intro: "These checks did not run, so nothing is claimed about them either way.",
  count: 2,
  groups: [{ reason: "The page carried too little readable text.", checks: ["Main heading", "Image descriptions"] }],
};

/** The section's text between one marker and the next, for checking a part on its own. */
function between(out: string, from: string, to: string): string {
  const start = out.indexOf(from);
  assert.ok(start >= 0, `"${from}" is present`);
  const end = out.indexOf(to, start + from.length);
  return out.slice(start, end < 0 ? undefined : end);
}

/** The document for any finished real audit, through the production projection. */
function documentOf(audit: AuditResult): PdfDocument {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult, SpeedResult["data"]>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", audit);
  const outcome = buildPdfDocument(job.id, store);
  if (!outcome.ok) assert.fail(outcome.reason);
  return outcome.document;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

/**
 * The coverage fixtures, built as pdfDocument.test.mts builds them: a real
 * crawl of 60 linked pages and one unreadable page, stopped at its page limit,
 * then one consistent adjustment and one copy breaking each invariant group.
 */
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

  const small: FakeSite = {
    "https://example.com/": { html: page("Example Company", `<h1>Welcome</h1><p>We sell widgets to businesses across the country.</p><a href="/a">A</a>`) },
    "https://example.com/a": { html: page("Page A", `<h1>Page A</h1><p>Widgets supplied and installed for businesses.</p><a href="/">Home</a>`) },
  };
  const complete = await runRealAudit({ site: small });

  const certificate = await runRealCertificateFailure({
    site: { "https://example.com/": { html: "", unreadable: "The website's security certificate has expired.", certificateProblem: "expired" } },
    checks: { certificateExpired: true },
  });
  return { partial, complete, certificate, failing: { I1: i1, I23: i23, I45: i45, I6: i6 } as Record<string, SiteAuditResult> };
})();

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test("the copied wording equals the report layer's", () => {
  assert.equal(LIMITATIONS_INTRO, SECTION_INTROS.limitations);
  assert.deepEqual(NOT_PART_OF_THIS_AUDIT, NOT_CHECKED_BY_THIS_AUDIT);
  assert.equal(NOT_PART_OF_THIS_AUDIT.length, 7);
});

test("the section and sub-headings, exactly (CP1 §4, §9.4; revision 9 §4.2; C2)", () => {
  assert.equal(LIMITATIONS_HEADING, "Limitations and About This Audit");
  assert.deepEqual(LIMITATIONS_SUBHEADINGS, {
    checks: "Checks that could not be completed",
    pages: "Pages that could not be checked",
    notPart: "Not part of this audit",
    about: "About this audit",
    limits: "Audit limits",
  });
});

// ---------------------------------------------------------------------------
// Structure and order (C4, C2, A1, A2)
// ---------------------------------------------------------------------------

test("one section, one h2, every part in the approved order", () => {
  const out = render({
    skipped: SKIPPED,
    coverage: { ...testDocument().coverage, partial: true, stopReason: "STOP-REASON" },
    coverageCounts: { ...COUNTS, unavailable: 2 },
  });
  assert.equal(count(out, "<section"), 1);
  assert.equal(count(out, "<h2"), 1);
  assert.ok(out.startsWith(`<section class="limitations"><h2>Limitations and About This Audit</h2>`));
  const order = [
    `<p class="lead">${LIMITATIONS_INTRO}</p>`,
    h3(LIMITATIONS_SUBHEADINGS.checks),
    h3(LIMITATIONS_SUBHEADINGS.pages),
    "<p>STOP-REASON</p>",
    h3(LIMITATIONS_SUBHEADINGS.notPart),
    h3(LIMITATIONS_SUBHEADINGS.about),
    h3(LIMITATIONS_SUBHEADINGS.limits),
  ];
  let at = -1;
  for (const marker of order) {
    const next = out.indexOf(marker);
    assert.ok(next > at, `"${marker}" follows the part before it`);
    at = next;
  }
  assert.ok(out.endsWith("</section>"));
});

test("A2: the stop reason and X1 have no heading of their own", () => {
  const out = render({
    coverage: { ...testDocument().coverage, partial: true, stopReason: "STOP-REASON" },
    coverageCounts: null,
    coverageFlags: { partial: true, hasExclusions: true },
  });
  const part = between(out, "<p>STOP-REASON</p>", h3(LIMITATIONS_SUBHEADINGS.notPart));
  assert.equal(part, `<p>STOP-REASON</p><p>${escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)}</p>`);
  assert.ok(!out.includes(h3(LIMITATIONS_SUBHEADINGS.pages)), "no pages heading without counts");
});

// ---------------------------------------------------------------------------
// Checks that could not be completed (C5)
// ---------------------------------------------------------------------------

test("skipped checks: the heading, the intro word for word, and the shared grouping", () => {
  const out = render({ skipped: SKIPPED });
  assert.ok(out.includes(
    h3(LIMITATIONS_SUBHEADINGS.checks) + `<p>${SKIPPED.intro}</p>` + skippedGroupsHtml(SKIPPED.groups),
  ));
  assert.ok(!out.includes("Checks not evaluated"), "the dashboard's heading is not the PDF's");
});

test("no skipped checks: no subsection at all", () => {
  const out = render({ skipped: null });
  assert.ok(!out.includes(LIMITATIONS_SUBHEADINGS.checks));
  assert.ok(!out.includes("skipped-group"));
});

// ---------------------------------------------------------------------------
// Pages that could not be checked (C1)
// ---------------------------------------------------------------------------

/** The rows printed under "Pages that could not be checked", as [label, value]. */
function pageRows(out: string): string[][] {
  if (!out.includes(h3(LIMITATIONS_SUBHEADINGS.pages))) return [];
  const part = between(out, h3(LIMITATIONS_SUBHEADINGS.pages), "</table>");
  return [...part.matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
}

test("only the counts that are not zero are shown, with the crawl table's labels", () => {
  const out = render({ coverageCounts: { ...COUNTS, unavailable: 3, notWebPages: 0, robotsExcluded: 2 } });
  assert.deepEqual(pageRows(out), [
    [CRAWL_TABLE_LABELS.unavailable, "3"],
    [escapeHtml(CRAWL_TABLE_LABELS.robotsExcluded), "2"],
  ]);
  const all = render({ coverageCounts: { ...COUNTS, unavailable: 1, notWebPages: 4, robotsExcluded: 5 } });
  assert.deepEqual(pageRows(all), [
    [CRAWL_TABLE_LABELS.unavailable, "1"],
    [CRAWL_TABLE_LABELS.notWebPages, "4"],
    [escapeHtml(CRAWL_TABLE_LABELS.robotsExcluded), "5"],
  ]);
});

test("all three counts zero: the subsection is left out, heading included", () => {
  const out = render({ coverageCounts: { ...COUNTS, unavailable: 0, notWebPages: 0, robotsExcluded: 0 } });
  assert.ok(!out.includes(LIMITATIONS_SUBHEADINGS.pages));
  assert.ok(!out.includes("<table"));
});

test("a valid exclusion count is a row, and X1 is not repeated beside it", () => {
  const out = render({ coverageCounts: { ...COUNTS, robotsExcluded: 4 }, coverageFlags: { partial: false, hasExclusions: true } });
  assert.deepEqual(pageRows(out), [[escapeHtml(CRAWL_TABLE_LABELS.robotsExcluded), "4"]]);
  assert.ok(!out.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)));
});

test("counts unavailable: no subsection, no figure, and X1 only when there were exclusions", () => {
  const withExclusions = render({ coverageCounts: null, coverageFlags: { partial: true, hasExclusions: true } });
  assert.ok(!withExclusions.includes(LIMITATIONS_SUBHEADINGS.pages));
  assert.ok(withExclusions.includes(`<p>${escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)}</p>`));
  const without = render({ coverageCounts: null, coverageFlags: { partial: true, hasExclusions: false } });
  assert.ok(!without.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)));
});

// ---------------------------------------------------------------------------
// The stop reason (B6, C3, K4)
// ---------------------------------------------------------------------------

test("a whole-site crawl that stopped short shows its stop reason", () => {
  const out = render({ coverage: { ...testDocument().coverage, partial: true, stopReason: "Stopped at the 150-page safety limit." } });
  assert.ok(out.includes("<p>Stopped at the 150-page safety limit.</p>"));
});

test("no stop reason for a complete crawl, an empty reason, or a null one", () => {
  for (const coverage of [
    { ...testDocument().coverage, partial: false, stopReason: "SHOULD-NOT-PRINT" },
    { ...testDocument().coverage, partial: true, stopReason: "" },
    { ...testDocument().coverage, partial: true, stopReason: null },
  ]) {
    const out = render({ coverage });
    assert.ok(!out.includes("SHOULD-NOT-PRINT"));
    assert.ok(!out.includes("<p></p>"), "no empty paragraph");
  }
});

test("a certificate failure never shows a crawl stop reason (C3, K4)", () => {
  const out = render({
    certificateFailureAreas: { seo: "not-measured", security: "attention", speed: "not-measured", technical: "incomplete" },
    overallSummary: null,
    coverage: { ...testDocument().coverage, partial: true, stopReason: "FETCH-FAILURE-REASON" },
    coverageCounts: null,
    coverageFlags: { partial: true, hasExclusions: false },
  });
  assert.ok(!out.includes("FETCH-FAILURE-REASON"));
});

// ---------------------------------------------------------------------------
// Not part of this audit; About; limits
// ---------------------------------------------------------------------------

test("the seven 'not part of this audit' items, in order, word for word", () => {
  const out = render();
  const part = between(out, h3(LIMITATIONS_SUBHEADINGS.notPart), h3(LIMITATIONS_SUBHEADINGS.about));
  assert.deepEqual([...part.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]), NOT_CHECKED_BY_THIS_AUDIT.map(escapeHtml));
});

test("About this audit: every clause, with the four group headings at h4 (S3-D9, A1)", () => {
  const out = render();
  const part = between(out, h3(LIMITATIONS_SUBHEADINGS.about), h3(LIMITATIONS_SUBHEADINGS.limits));
  assert.equal(part, h3(LIMITATIONS_SUBHEADINGS.about) + aboutClausesHtml(4));
  assert.equal(count(part, "<h4>"), 4);
  assert.equal(count(part, "<li>"), 14);
  assert.ok(part.includes("the report describes the pages it could check"), "Q4");
  assert.ok(part.includes("were left alone and counted"), "O2");
  assert.ok(part.includes("It explains them; it does not decide them"), "Q8");
});

test("Audit limits: the configured-limits sentence as the model worded it (S3-D8)", () => {
  const out = render();
  assert.ok(out.endsWith(
    h3(LIMITATIONS_SUBHEADINGS.limits) + "<p>Configured limits for this audit: up to 150 pages and 5 minutes.</p></section>",
  ));
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test("text from the audit is escaped: check names, reasons, the intro and the stop reason", () => {
  const out = render({
    skipped: { ...SKIPPED, intro: HOSTILE, groups: [{ reason: HOSTILE, checks: [HOSTILE] }] },
    coverage: { ...testDocument().coverage, partial: true, stopReason: HOSTILE },
    configuredLimitsSentence: HOSTILE,
  });
  assert.ok(!out.includes("<script>"));
  assert.equal(count(out, escapeHtml(HOSTILE)), 5, "intro, check, reason, stop reason and limits");
});

// ---------------------------------------------------------------------------
// Real audits, through the production projection
// ---------------------------------------------------------------------------

test("a real complete audit: no stop reason, no X1, the fixed parts and the limits", async () => {
  const { complete } = await fixtures;
  const doc = documentOf(complete);
  assert.equal(doc.coverage.partial, false);
  const out = limitationsSectionHtml(doc);
  assert.ok(!out.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)));
  assert.ok(out.includes(h3(LIMITATIONS_SUBHEADINGS.notPart)));
  assert.ok(out.includes(aboutClausesHtml(4)));
  assert.ok(out.includes(escapeHtml(doc.configuredLimitsSentence)));
});

test("a real whole-site crawl that stopped short: its stop reason and its non-zero counts", async () => {
  const { partial } = await fixtures;
  const doc = documentOf(partial);
  assert.ok(doc.coverageCounts !== null && doc.coverage.partial && doc.coverage.stopReason !== null);
  const out = limitationsSectionHtml(doc);
  assert.ok(out.includes(`<p>${escapeHtml(doc.coverage.stopReason)}</p>`));
  const expected = [
    [CRAWL_TABLE_LABELS.unavailable, doc.coverageCounts.unavailable],
    [CRAWL_TABLE_LABELS.notWebPages, doc.coverageCounts.notWebPages],
    [escapeHtml(CRAWL_TABLE_LABELS.robotsExcluded), doc.coverageCounts.robotsExcluded],
  ].filter(([, value]) => value !== 0).map(([label, value]) => [label, String(value)]);
  assert.ok(expected.length > 0, "the fixture has counts to show");
  assert.deepEqual(pageRows(out), expected);
});

test("real audits whose counts do not reconcile (I1–I6): no figure from the crawl, X1, the stop reason only if partial", async () => {
  const { failing } = await fixtures;
  for (const [name, audit] of Object.entries(failing)) {
    const doc = documentOf(audit);
    assert.equal(doc.coverageCounts, null, name);
    const out = limitationsSectionHtml(doc);
    assert.ok(!out.includes(LIMITATIONS_SUBHEADINGS.pages), `${name}: no pages subsection`);
    assert.ok(out.includes(escapeHtml(ROBOTS_EXCLUSION_WITHOUT_COUNT)), `${name}: X1`);
    const crawl = audit.crawl;
    const figures = new Set([crawl.discovered, crawl.evaluated, crawl.unavailable.length, crawl.skippedNonHtml, crawl.robots.excluded]);
    const visible = out.replace(escapeHtml(doc.configuredLimitsSentence), "").replace(/<[^>]+>/g, " ");
    for (const figure of figures) {
      assert.ok(!new RegExp(`\\b${figure}\\b`).test(visible), `${name}: no coverage figure ${figure}`);
    }
    assert.equal(out.includes(`<p>${escapeHtml(doc.coverage.stopReason ?? "NONE")}</p>`), doc.coverage.partial, `${name}: stop reason only when partial`);
  }
});

test("a real certificate failure: the reasons that stopped every check, no counts, no stop reason, the limits", async () => {
  const { certificate } = await fixtures;
  const doc = documentOf(certificate);
  assert.ok(doc.certificateFailureAreas !== null && doc.skipped !== null);
  const out = limitationsSectionHtml(doc);
  assert.ok(out.includes(skippedGroupsHtml(doc.skipped.groups)), "the reasons, grouped, word for word");
  assert.ok(!out.includes(LIMITATIONS_SUBHEADINGS.pages));
  assert.ok(doc.coverage.stopReason !== null && doc.coverage.stopReason !== "");
  assert.ok(!out.includes(escapeHtml(doc.coverage.stopReason)), "the fetch error is not presented as a stop reason");
  assert.ok(out.includes(escapeHtml(doc.configuredLimitsSentence)));
  assert.ok(out.includes(aboutClausesHtml(4)));
});

// ---------------------------------------------------------------------------
// Not wired
// ---------------------------------------------------------------------------

test("wired (CP3 step 4b): the document closes with this section, once, and the old About and skipped sections are gone", () => {
  const shell = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(shell.includes("limitationsSectionHtml(document)"));
  const doc = testDocument();
  const pageHtml = documentHtml(doc);
  assert.equal(pageHtml.split(`<section class="limitations">`).length - 1, 1);
  assert.ok(pageHtml.includes(`${limitationsSectionHtml(doc)}</main>`), "last inside main, unchanged");
  assert.ok(!pageHtml.includes("<h2>About this report</h2>"), "no standalone About section");
  assert.ok(!pageHtml.includes(`<section class="skipped">`), "no standalone skipped section");
});

// ---------------------------------------------------------------------------
// CP4 stage 4c: the short real-visitor reference (decision record rev. 3: P-7, P-8, P-10, U-5)
// ---------------------------------------------------------------------------

const REFERENCE = `<p>${escapeHtml(APPROVED_REAL_VISITOR_REFERENCE)}</p>`;

/** A measured speed result with the parts that decide the reference; the rest is fixed. */
const speedOf = (over: { fieldAvailable: boolean; labAvailable: boolean; labScore: number | null }): PdfSpeed => ({
  measured: true, status: "checked", device: "Mobile simulation", overall: null,
  fieldAvailable: over.fieldAvailable, field: [], labAvailable: over.labAvailable, labScore: over.labScore, lab: [],
  notInspected: [], measuredAddress: "https://example.com/",
});
const NOT_MEASURED: PdfSpeed = { measured: false, status: "not-requested", message: "Speed was not measured." };

test("CP4 4c: the reference is the approved wording, word for word", () => {
  assert.equal(REAL_VISITOR_REFERENCE, APPROVED_REAL_VISITOR_REFERENCE);
  assert.equal(
    REAL_VISITOR_REFERENCE,
    "Google's real-visitor speed data was not available for this site; see Speed & Performance for what this means.",
  );
});

test("CP4 4c: the reference prints if and only if the explanation prints and mobile has no real-visitor data", () => {
  const cases: Array<[string, PdfSpeed, PdfSpeed | null, boolean]> = [
    ["mobile not measured", NOT_MEASURED, null, false],
    ["real-visitor data and a score", speedOf({ fieldAvailable: true, labAvailable: true, labScore: 74 }), null, false],
    ["real-visitor data, no score", speedOf({ fieldAvailable: true, labAvailable: false, labScore: null }), null, false],
    ["no real-visitor data, a score", speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }), null, true],
    ["no real-visitor data, simulated rows without a score", speedOf({ fieldAvailable: false, labAvailable: true, labScore: null }), null, false],
    ["no real-visitor data, failed simulation", speedOf({ fieldAvailable: false, labAvailable: false, labScore: null }), null, false],
    // Desktop is never read (P-10).
    ["desktop alone has no real-visitor data", NOT_MEASURED, speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }), false],
    ["mobile decides even when desktop has data", speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }), speedOf({ fieldAvailable: true, labAvailable: true, labScore: 74 }), true],
    ["mobile has data, desktop has none", speedOf({ fieldAvailable: true, labAvailable: true, labScore: 74 }), speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }), false],
  ];
  for (const [name, speed, desktopSpeed, expected] of cases) {
    const out = render({ speed, desktopSpeed });
    assert.equal(count(out, REFERENCE), expected ? 1 : 0, name);
    // Never without the explanation it points to (U-1 option i).
    if (expected) assert.ok(explainsRealVisitorData(speed), `${name}: the explanation prints too`);
  }
});

test("CP4 4c: the reference is a plain paragraph after the skipped checks and before the pages that could not be checked", () => {
  const out = render({
    skipped: SKIPPED,
    coverageCounts: { ...COUNTS, unavailable: 2 },
    speed: speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }),
  });
  assert.equal(count(out, REFERENCE), 1);
  assert.ok(out.indexOf(skippedGroupsHtml(SKIPPED.groups)) < out.indexOf(REFERENCE), "after the skipped checks");
  assert.ok(out.indexOf(REFERENCE) < out.indexOf(h3(LIMITATIONS_SUBHEADINGS.pages)), "before the pages that could not be checked");
  assert.ok(out.includes(skippedGroupsHtml(SKIPPED.groups) + REFERENCE + h3(LIMITATIONS_SUBHEADINGS.pages)), "nothing between, and no heading of its own");
});

test("CP4 4c: apart from the reference, the section is exactly what it was", () => {
  for (const over of [
    {},
    { skipped: SKIPPED, coverageCounts: { ...COUNTS, unavailable: 2 } },
    { coverage: { ...testDocument().coverage, partial: true, stopReason: "STOP-REASON" }, coverageCounts: null },
  ] as Array<Partial<PdfDocument>>) {
    const before = render({ ...over, speed: NOT_MEASURED });
    const after = render({ ...over, speed: speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }) });
    assert.notEqual(after, before, "the reference was added");
    assert.equal(after.replace(REFERENCE, ""), before);
  }
});

test("CP4 4c: the full explanation is never repeated in Limitations", () => {
  const out = render({ speed: speedOf({ fieldAvailable: false, labAvailable: true, labScore: 74 }) });
  assert.ok(!out.includes(escapeHtml(REAL_VISITOR_HEADING)));
  for (const paragraph of realVisitorExplanation("https://example.com/")) {
    assert.ok(!out.includes(escapeHtml(paragraph)), paragraph.slice(0, 40));
  }
});

test("CP4 4c: a real certificate failure has no reference", async () => {
  const { certificate } = await fixtures;
  const doc = documentOf(certificate);
  assert.equal(doc.speed.measured, false);
  assert.ok(!limitationsSectionHtml(doc).includes(REFERENCE));
});
