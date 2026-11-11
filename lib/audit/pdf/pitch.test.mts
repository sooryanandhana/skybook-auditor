/**
 * The Skybook section (CP1 F11, U1, CP3 step 3c-ii): the approved copy, word
 * for word, and still unwired.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import { PITCH_SECTION_HEADING, PITCH_SECTION_PARAGRAPHS, pitchSectionHtml } from "./pitch.ts";
import { escapeHtml } from "./escape.ts";
import { documentHtml } from "./shell.ts";
import { testDocument } from "./testDocument.fixture.mts";
import { PITCH_HEADING, PITCH_PARAGRAPHS } from "../../report/reportSections.ts";

test("the copy equals the report layer's approved text", () => {
  assert.equal(PITCH_SECTION_HEADING, PITCH_HEADING);
  assert.deepEqual(PITCH_SECTION_PARAGRAPHS, PITCH_PARAGRAPHS);
});

test("the exact heading (U1)", () => {
  assert.equal(PITCH_SECTION_HEADING, "Let's Make Your Website Work Better for Your Business");
  assert.ok(pitchSectionHtml().startsWith(
    `<section class="pitch"><h2>${escapeHtml("Let's Make Your Website Work Better for Your Business")}</h2>`,
  ));
});

test("one h2 and exactly the four approved paragraphs, in order, and nothing else", () => {
  const out = pitchSectionHtml();
  assert.equal(out.split("<h2").length - 1, 1);
  const paragraphs = [...out.matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]);
  assert.deepEqual(paragraphs, PITCH_PARAGRAPHS.map(escapeHtml));
  assert.equal(paragraphs.length, 4);
  assert.equal(
    out,
    `<section class="pitch"><h2>${escapeHtml(PITCH_HEADING)}</h2>` +
      PITCH_PARAGRAPHS.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("") +
      `</section>`,
  );
});

test("the source records the [COMPANY] confirmation as given", () => {
  /*
   * The three CP1 R2 confirmations (the marketing claims, the contact wording
   * and contact-field approach, and the exact brand name) were given by
   * Skybook and recorded in pitch.ts in 5060532. This keeps that record in the
   * source, and keeps the superseded "required" note from coming back beside it.
   */
  const source = fs.readFileSync(new URL("./pitch.ts", import.meta.url), "utf8");
  assert.ok(source.includes("[COMPANY] CONFIRMED (CP1 R2)"));
  assert.ok(source.includes("Skybook has approved the section's marketing"));
  assert.ok(source.includes("the report contact wording and contact-field approach"));
  assert.ok(source.includes("brand name: Skybook"));
  assert.ok(!source.includes("CONFIRMATION REQUIRED BEFORE CLIENT USE"));
});

test("wired (CP3 step 4b): the document carries this section once, immediately before Limitations", () => {
  const shell = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(shell.includes("pitchSectionHtml()"));
  const page = documentHtml(testDocument());
  assert.equal(page.split(`<section class="pitch">`).length - 1, 1);
  assert.ok(page.includes(`${pitchSectionHtml()}<section class="limitations">`), "straight before Limitations (CP1 §10)");
  assert.equal(page.split(escapeHtml(PITCH_HEADING)).length - 1, 1);
});
