/**
 * Tests for the summary and the coverage section.
 *
 * THE ONE THING BOTH SECTIONS EXIST TO PREVENT is a reader taking a number for
 * more than it is. Coverage says how much of the site was seen, so a list of
 * problems can be read as meaning something. The summary separates what was
 * counted from what a model wrote about the counts.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { summaryHtml } from "./summary.ts";
import { coverageHtml } from "./coverage.ts";
import { factTable } from "./facts.ts";
import { testDocument } from "./testDocument.fixture.mts";
import type { PdfSummary } from "../pdfDocument.ts";

const summary = (over: Partial<PdfSummary> = {}) => ({ ...testDocument().summary, ...over });

// ---------------------------------------------------------------------------
// The severity split
// ---------------------------------------------------------------------------

test("every severity is shown as a number and a word", () => {
  const out = summaryHtml(summary());

  for (const count of testDocument().summary.severityCounts) {
    assert.ok(out.includes(`>${count.count}<`), `${count.label} shows its number`);
    assert.ok(out.includes(`>${count.label}<`), `${count.label} shows its word`);
  }
});

test("the split keeps the order the report layer gave it", () => {
  const out = summaryHtml(summary());

  assert.ok(out.indexOf("Critical") < out.indexOf("High"));
  assert.ok(out.indexOf("High") < out.indexOf("Medium"));
});

test("a zero is shown rather than hidden", () => {
  // Nought critical problems is a result, and a reader who cannot see it
  // cannot tell whether the check ran.
  const out = summaryHtml(summary());
  assert.match(out, /tile-critical[^]*?>0</);
});

test("no counts at all produces no tiles rather than an empty row", () => {
  const out = summaryHtml(summary({ severityCounts: [] }));
  assert.ok(!out.includes("tiles"));
});

// ---------------------------------------------------------------------------
// The clean-state sentence
// ---------------------------------------------------------------------------

test("a clean audit shows the sentence the report layer chose", () => {
  const out = summaryHtml(
    summary({ state: "clean", stateSentence: "No issues found by the checks that were run." }),
  );

  assert.ok(out.includes("No issues found by the checks that were run."));
});

test("a clean audit with skipped checks says the longer thing", () => {
  // 7A §14: "clean" and "clean, but some checks could not run" are different
  // sentences and only one of them is good news. The renderer prints whichever
  // it was given and never shortens it.
  const longer =
    "No issues were found by the checks that completed, but some checks could not be evaluated.";
  const out = summaryHtml(summary({ state: "clean-with-skipped", stateSentence: longer }));

  assert.ok(out.includes(longer));
});

test("an audit with findings shows no clean-state sentence", () => {
  assert.ok(!summaryHtml(summary({ stateSentence: "" })).includes('class="lead"'));
});

test("with no commentary the measured split still stands alone", () => {
  // The AI narrative is now its own section (see clientSummary.test.mts). The
  // measured split must never carry an AI panel, whatever the AI produced.
  const split = summaryHtml(summary({ ai: null }));
  assert.ok(!split.includes('class="ai"'), "no AI panel leaks into the split");
  assert.ok(split.includes("High"), "the measured split is still there");
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("coverage states what was read, in counts", () => {
  const out = coverageHtml(testDocument().coverage);

  assert.ok(out.includes("What we checked"));
  assert.ok(out.includes("128 pages read of 128 found"));
  assert.ok(out.includes("Excluded by robots.txt"));
});

test("coverage never shows a percentage", () => {
  // 7A §13: a crawl discovers more as it reads, so there is no honest
  // denominator while it runs and a percentage would be an invented one.
  assert.ok(!coverageHtml(testDocument().coverage).includes("%"));
});

test("a partial crawl is marked in the coverage section too", () => {
  const out = coverageHtml({ ...testDocument().coverage, partial: true });
  assert.ok(out.includes("Partial audit"));
});

test("a complete crawl is not marked", () => {
  assert.ok(!coverageHtml(testDocument().coverage).includes("Partial audit"));
});

test("the stop reason is shown when there is one, and omitted when there is not", () => {
  const stopped = coverageHtml({
    ...testDocument().coverage,
    stopReason: "Stopped at the 150-page safety limit.",
  });

  assert.ok(stopped.includes("Stopped at the 150-page safety limit."));
  assert.ok(!coverageHtml(testDocument().coverage).includes("Stopped at"));
});

// ---------------------------------------------------------------------------
// The shared fact table
// ---------------------------------------------------------------------------

test("facts are a real table with a header row that can repeat", () => {
  // 7A §18 requires a spanning table to repeat its header, which needs a
  // header to repeat, and 7A §24 wants the columns named for a screen reader.
  const out = factTable([{ label: "Pages read", value: "128" }]);

  assert.match(out, /<thead><tr><th scope="col">/);
  assert.match(out, /<th scope="row">Pages read<\/th>/);
});

test("a note sits under its value rather than becoming a third column", () => {
  const out = factTable([{ label: "A", value: "B", note: "C" }]);
  assert.match(out, /<td>B<span class="fact-note">C<\/span><\/td>/);
});

test("no facts produces no table at all", () => {
  assert.equal(factTable([]), "");
});

test("a fact carrying markup is rendered as text", () => {
  const out = factTable([{ label: "<b>l</b>", value: "<i>v</i>", note: "<u>n</u>" }]);

  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes("<i>"));
  assert.ok(!out.includes("<u>"));
  assert.ok(out.includes("&lt;b&gt;"));
});
