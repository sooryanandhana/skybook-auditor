/**
 * Tests for the labels that mark AI-written text.
 *
 * WHY THESE ARE TESTED AT ALL, given they are constants. They moved here from
 * inside the results page so the PDF could use the same words, and 7A §5's
 * reason for that move is that two copies drift. A test that pins the wording
 * is what makes the move worth making: it is the thing that fails if somebody
 * edits one of these to suit a layout and quietly changes what the document
 * claims about its own AI text.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  AI_EXPLANATION_LABEL,
  AI_IMPACT_LABEL,
  AI_PROVENANCE,
  AI_RECOMMENDATION_LABEL,
  AI_SUMMARY_HEADING,
  rejectedNote,
} from "./commentaryView.ts";

test("the provenance sentence says who wrote the prose and who measured the numbers", () => {
  // 7A §9 requires exactly this claim beside the executive summary.
  assert.match(AI_PROVENANCE, /Written by AI/);
  assert.match(AI_PROVENANCE, /measured by this tool/);
  assert.match(AI_PROVENANCE, /findings, their severities/);
});

test("every label names AI in words, not by styling", () => {
  // The distinction has to survive a greyscale printer and a reader who cannot
  // see the colour it is set in.
  assert.match(AI_SUMMARY_HEADING, /AI/);
  assert.match(AI_EXPLANATION_LABEL, /AI/);
});

test("the sub-labels say what they are for in plain words", () => {
  assert.equal(AI_IMPACT_LABEL, "Why it matters");
  assert.equal(AI_RECOMMENDATION_LABEL, "Suggested next step");
});

test("one dropped explanation reads as one, not as a plural", () => {
  assert.equal(rejectedNote(1), "1 explanation was not usable and was left out.");
});

test("several dropped explanations read as several", () => {
  assert.equal(rejectedNote(4), "4 explanations were not usable and were left out.");
});

test("nothing dropped says nothing at all, rather than saying zero", () => {
  assert.equal(rejectedNote(0), null);
  assert.equal(rejectedNote(-1), null);
});

test("the note never blames the audited site", () => {
  // A dropped explanation is our validator refusing our provider's answer. It
  // says nothing about the website, and must not read as though it did.
  for (const count of [1, 5]) {
    const note = rejectedNote(count) ?? "";
    assert.ok(!/site|website|domain|page/i.test(note));
  }
});

test("the results page uses these constants rather than its own copies", () => {
  /*
   * THE POINT OF THE MOVE, asserted. The page and the PDF have to say the same
   * thing, and the only way to guarantee that is for neither to carry its own
   * copy. The needles are assembled here so this test cannot match itself.
   */
  const page = fs.readFileSync(
    new URL("../../app/page.tsx", import.meta.url),
    "utf8",
  );

  for (const literal of [
    ["Written by AI from", "the findings below"].join(" "),
    ["AI", "explanation"].join(" "),
    ["Why it", "matters"].join(" "),
    ["Suggested next", "step"].join(" "),
  ]) {
    assert.ok(
      !page.includes(`>${literal}<`),
      `the page must not carry its own copy of "${literal}"`,
    );
  }

  assert.ok(page.includes("commentaryView"), "it imports them instead");
});
