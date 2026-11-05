/**
 * The overall summary's markup: escaped, complete, and in its place.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { overallSummaryHtml, OVERALL_SUMMARY_HEADING } from "./overallSummary.ts";
import { documentHtml } from "./shell.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import type { OverallSummary } from "../pdfDocument.ts";

const SUMMARY: OverallSummary = {
  overview: ["OVERVIEW-ONE", "OVERVIEW-TWO"],
  areas: [
    { key: "speed", heading: "Website speed and performance", status: "improve", statusLabel: "Room for improvement", paragraphs: ["SPEED-TEXT"] },
    { key: "domain", heading: "Domain and email records", status: "incomplete", statusLabel: "Partly checked", paragraphs: [`NS ${HOSTILE}`] },
  ],
  securityStatus: "incomplete",
  strengths: ["STRENGTH-ONE"],
  priorities: [
    { title: "PRIORITY-TITLE", severityLabel: "Critical", reach: "Site-wide", whyItMatters: "WHY-TEXT", whoFixes: "Hosting or server administrator" },
    { title: "NO-WHO", severityLabel: "Medium priority", reach: "3 of 12 evaluated pages", whyItMatters: "WHY-TWO", whoFixes: null },
  ],
  limitations: ["LIMIT-ONE"],
  notChecked: ["DKIM email signing"],
  help: { intro: "HELP-INTRO", items: ["HELP-ITEM"], closing: "HELP-CLOSING" },
};

test("no summary, no markup", () => {
  assert.equal(overallSummaryHtml(null), "");
});

test("every part of the summary is drawn, in order", () => {
  const out = overallSummaryHtml(SUMMARY);
  const order = [
    OVERALL_SUMMARY_HEADING,
    "OVERVIEW-ONE",
    "Website speed and performance",
    "Room for improvement",
    "SPEED-TEXT",
    "Domain and email records",
    "Partly checked",
    "What is working well",
    "STRENGTH-ONE",
    "Most important issues to address first",
    "PRIORITY-TITLE",
    "Critical · Site-wide",
    "WHY-TEXT",
    "Who should fix it: Hosting or server administrator",
    "Limitations of this audit",
    "LIMIT-ONE",
    "Not checked by this audit",
    "DKIM email signing",
    "How Skybook can help",
    "HELP-INTRO",
    "HELP-ITEM",
    "HELP-CLOSING",
  ];
  let at = -1;
  for (const marker of order) {
    const next = out.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" follows the part before it`);
    at = next;
  }
  assert.equal((out.match(/Who should fix it/g) ?? []).length, 1, "no who-line when none is known");
});

test("values from the audited site are escaped", () => {
  const out = overallSummaryHtml(SUMMARY);
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("empty lists draw no heading", () => {
  const out = overallSummaryHtml({ ...SUMMARY, strengths: [], priorities: [] });
  assert.ok(!out.includes("What is working well"));
  assert.ok(!out.includes("Most important issues"));
  assert.ok(out.includes("How Skybook can help"), "help is always offered");
});

test("the standalone overall summary is no longer printed in the document (CP3 step 4b, F1)", () => {
  // The module is kept and still renders on its own; the redesigned document does not call it.
  assert.ok(overallSummaryHtml(SUMMARY).includes(`<h2>${OVERALL_SUMMARY_HEADING}</h2>`));
  const page = documentHtml(testDocument({ overallSummary: SUMMARY }));
  assert.ok(!page.includes(`<h2>${OVERALL_SUMMARY_HEADING}</h2>`));
  assert.ok(!page.includes("HELP-INTRO"), "none of its parts either");
  assert.ok(!page.includes("<h2>AI summary</h2>"), "nor the standalone AI summary");
});

test("a document without an overall summary is unchanged by it", () => {
  const page = documentHtml(testDocument());
  assert.ok(!page.includes(`<h2>${OVERALL_SUMMARY_HEADING}</h2>`));
});
