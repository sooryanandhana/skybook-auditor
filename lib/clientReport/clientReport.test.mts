/**
 * The client report must say exactly what the verified source of truth says.
 *
 * These tests pin the facts, not the layout: the counts, every finding ID and
 * severity, the measured values, the corrected wording, and the absence of
 * anything unsupported. A change to `verifiedReport.ts` that alters an audit
 * fact fails here before it can reach a client.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { clientReportHtml, SECTION_TITLES } from "./document.ts";
import { rich } from "./markup.ts";
import { renderClientReport } from "./render.ts";
import { extractText } from "../audit/pdf/pdfText.fixture.mts";
import * as R from "./verifiedReport.ts";

const ids = (from: number, to: number, prefix: string) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, "0")}`);

test("counts match the verified totals: 60 confirmed = 7 High + 23 Medium + 23 Low + 7 not assigned; 5 requiring validation", () => {
  assert.deepEqual(R.findingCounts(), {
    confirmed: 60,
    critical: 0,
    high: 7,
    medium: 23,
    low: 23,
    notAssigned: 7,
    requiresValidation: 5,
  });
});

test("every confirmed finding ID appears exactly once, with its verified severity", () => {
  const found = R.confirmedFindings();
  const seen = found.map((f) => f.id);
  assert.equal(new Set(seen).size, seen.length, "no ID is duplicated");

  const expected: Record<string, R.Severity> = {};
  for (const id of ["K1", "K2", "K3", "K4", "K5", "K6", "K7"]) expected[id] = "high";
  for (const id of [
    "SEO-01", "SEO-02", "SEO-03", "TECH-01", "TECH-02", "TECH-03", "TECH-05",
    "UX-03", "UX-04", "UX-05", "UX-07", "UX-08", "UX-09", "UX-11", "UX-12", "UX-13", "UX-14",
    "CQ-01", "CQ-02", "CQ-05", "CQ-06", "CQ-23", "CQ-25",
  ]) expected[id] = "medium";
  for (const id of ["SEC-02", "UX-01", "UX-02", "UX-06", "CQ-03", "CQ-04", ...ids(7, 22, "CQ"), "CQ-24"]) {
    expected[id] = "low";
  }
  for (const id of ["SEC-01", "TECH-04", ...ids(1, 5, "PERF")]) expected[id] = "not-assigned";

  assert.deepEqual(Object.fromEntries(found.map((f) => [f.id, f.severity])), expected);
});

test("the five requires-validation items are exactly RV-01, RV-02, RV-03, UX-10, SEO-04 and none is a confirmed finding", () => {
  const rv = R.REQUIRES_VALIDATION.map((r) => r.id);
  assert.deepEqual(rv, ["RV-01", "RV-02", "RV-03", "UX-10", "SEO-04"]);
  const confirmed = new Set(R.confirmedFindings().map((f) => f.id));
  for (const id of rv) assert.ok(!confirmed.has(id), `${id} is not counted as confirmed`);
});

test("performance measurements are the verified values, and LCP is flagged for validation", () => {
  assert.deepEqual(R.PSI_MOBILE_SCORES.map((m) => m.value), ["55", "90", "74", "82"]);
  assert.deepEqual(R.PSI_DESKTOP_SCORES.map((m) => m.value), ["59", "83", "74", "82"]);
  assert.deepEqual(R.PSI_MOBILE_METRICS.map((m) => m.value), ["5.5 s", "39.7 s", "80 ms", "0.007", "13.8 s"]);
  const lcp = R.PSI_MOBILE_METRICS.find((m) => m.label === "Largest Contentful Paint");
  assert.equal(lcp?.requiresValidation, true);
  assert.ok(R.LCP_VALIDATION_NOTE.startsWith("PageSpeed reported 39.7 s — requires validation by re-test."));
  assert.deepEqual(R.WPT_METRICS.map((m) => m.value), [
    "1.046 s", "0.143 s", "1.200 s", "1.453 s", "91", "12,556 KB", "1.148 s", "93", "12,559 KB",
  ]);
  assert.deepEqual(R.WPT_GRADES.map((g) => g.grade), ["A", "A", "F", "F", "F", "X"]);
});

test("the approved wording corrections are in place", () => {
  const html = clientReportHtml();
  assert.ok(!html.includes("the header check covered the whole site"));
  assert.ok(html.includes("A separate curl check of <code>https://www.ademstravel.com/</code> confirmed that HSTS, CSP and X-Frame-Options are absent"));
  assert.ok(html.includes("The other 22 tours are hard to find on mobile, with no visible way to browse them."));
  assert.ok(!html.includes("never seen on mobile"));
  assert.ok(html.includes("Images enlarged beyond their original resolution, and a very long scroll before the tours section."));
  assert.ok(!/blurred/i.test(html));
  assert.ok(html.includes("<strong>Services page tiles:</strong> a pointer cursor appears on hover, and a test click did nothing."));
  assert.ok(html.includes("<strong>Homepage service cards:</strong> they link to <code>javascript:void(0)</code>"));
  assert.ok(html.includes("Browser inspection and Chrome developer tools"));
});

test("the audit date is 17 September 2026 and no audit period is shown", () => {
  const html = clientReportHtml();
  assert.equal(R.CLIENT.auditDate, "17 September 2026");
  assert.ok(!html.includes("17–19 September 2026"), "no 17–19 September 2026 audit period");
  assert.ok(!/audit period/i.test(html), "no 'audit period' label");
  assert.ok(html.includes("Audit Date: 17 September 2026"), "footer carries the audit date");
});

test("health overview statuses match the verified categories", () => {
  assert.deepEqual(
    R.HEALTH.map((h) => [h.category, h.status]),
    [
      ["SEO", "needs-attention"],
      ["Technical SEO", "needs-attention"],
      ["Performance", "needs-attention"],
      ["Security", "needs-attention"],
      ["SSL", "healthy"],
      ["DNS", "healthy"],
      ["UX / Accessibility", "needs-attention"],
      ["Content", "needs-attention"],
    ],
  );
});

test("no numerical overall score, no internal tooling, no automated-audit output", () => {
  const html = clientReportHtml();
  for (const forbidden of [/overall score/i, /health score/i, /\/100\b/, /Gemini/i, /Claude/i, /collector/i, /security\.https/]) {
    assert.ok(!forbidden.test(html), `found ${forbidden}`);
  }
});

test("every section is present, in order", () => {
  const html = clientReportHtml();
  let at = html.indexOf("Website Audit Report");
  assert.ok(at > 0, "cover title");
  for (const title of SECTION_TITLES) {
    const next = html.indexOf(rich(title), at);
    assert.ok(next > at, `${title} follows the previous section`);
    at = next;
  }
});

test("text is escaped; only the two inline conventions become markup", () => {
  assert.equal(rich("<script>x</script> `a<b` **c&d**"), "&lt;script&gt;x&lt;/script&gt; <code>a&lt;b</code> <strong>c&amp;d</strong>");
});

test("the rendered PDF carries the key facts and every section", { timeout: 120_000 }, async () => {
  const pdf = await renderClientReport();
  // Whitespace removed on both sides: a heading that wraps loses its space at the line break.
  const squash = (value: string) => value.replace(/\s+/g, "");
  const text = squash(extractText(pdf));
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(pages >= 20, `a full report, not a stub (${pages} pages)`);
  for (const phrase of [
    // "PREPARED BY" is uppercased by the stylesheet, and the PDF holds what is drawn.
    "Website Audit Report", "Adems Travel", "ademstravel.com", "Audit Date: 17 September 2026", "PREPARED BY",
    "requires validation by re-test", "Grade A", "92.204.41.53", "Not assessed",
    ...SECTION_TITLES,
  ]) {
    assert.ok(text.includes(squash(phrase)), `PDF contains "${phrase}"`);
  }
});
