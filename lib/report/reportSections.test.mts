/**
 * The redesigned report's fixed wording is exactly the approved wording, says
 * nothing it cannot support, and keeps figures out of the forms meant for
 * unverified counts.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sections from "./reportSections.ts";
import {
  ADDRESSES_FOUND_LABEL,
  AFFECTED_LIST_TRUNCATED,
  AI_SUMMARY_LABEL,
  NO_SITEMAP_SENTENCE,
  PITCH_HEADING,
  REAL_VISITOR_REFERENCE,
  ROBOTS_EXCLUSION_UNCOUNTED,
  SAFETY_LIMIT_STOP,
  SECTION_INTROS,
  SPEED_GLOSSARY,
  checkIssueFound,
  checkNotApplicable,
  configuredLimitsSentence,
  realVisitorExplanation,
  robotsExclusionSentence,
} from "./reportSections.ts";
import { certaintyPhrasesIn } from "./wordingGuard.fixture.mts";

/** Every string the module exports, with the templates filled in. */
function allTexts(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  for (const [name, value] of Object.entries(sections)) {
    if (typeof value !== "function") walk(value);
    else if (name === "realVisitorExplanation") walk(realVisitorExplanation("https://example.com/"));
  }
  out.push(
    checkIssueFound("Missing title"),
    checkNotApplicable("the site sets no cookies"),
    robotsExclusionSentence(1),
    robotsExclusionSentence(3),
    configuredLimitsSentence("100", "5 minutes"),
  );
  return out;
}

test("no fixed report text states a consequence as fact or promises a result", () => {
  for (const text of allTexts()) {
    assert.deepEqual(certaintyPhrasesIn(text), [], `must not say: ${text}`);
  }
});

test("the AI label and the Skybook heading are the approved wording", () => {
  assert.equal(
    AI_SUMMARY_LABEL,
    "Written by AI from the verified findings in this report. Every finding, severity and figure was measured by the audit itself.",
  );
  assert.equal(PITCH_HEADING, "Let's Make Your Website Work Better for Your Business");
});

test("the glossary carries the approved INP and TTFB definitions", () => {
  assert.equal(
    SPEED_GLOSSARY.inp,
    "INP (Interaction to Next Paint): how quickly the page responds visually after a visitor interacts with it, such as clicking a button or tapping a menu.",
  );
  assert.equal(
    SPEED_GLOSSARY.ttfb,
    "TTFB (Time to First Byte): how long it takes for the server to begin sending a response after a visitor requests a page.",
  );
  assert.deepEqual(Object.keys(SPEED_GLOSSARY).sort(), ["cls", "fcp", "inp", "lcp", "speedIndex", "tbt", "ttfb"]);
});

test("the first crawl-table label depends on whether the starting address is counted", () => {
  assert.equal(ADDRESSES_FOUND_LABEL.includingStartingAddress, "Addresses found (including the starting address)");
  assert.equal(ADDRESSES_FOUND_LABEL.plain, "Addresses found");
});

test("robots.txt exclusions: a counted form, and an uncounted form with no figure", () => {
  assert.equal(
    robotsExclusionSentence(1),
    "A further 1 address was not visited because the site's robots.txt asks automated tools not to.",
  );
  assert.equal(
    robotsExclusionSentence(4),
    "A further 4 addresses were not visited because the site's robots.txt asks automated tools not to.",
  );
  assert.equal(
    ROBOTS_EXCLUSION_UNCOUNTED,
    "Some addresses were not visited because the site's robots.txt asks automated tools not to.",
  );
});

test("the forms meant for unverified counts carry no figures at all", () => {
  for (const text of [ROBOTS_EXCLUSION_UNCOUNTED, SAFETY_LIMIT_STOP, AFFECTED_LIST_TRUNCATED, REAL_VISITOR_REFERENCE]) {
    assert.doesNotMatch(text, /\d/, text);
  }
});

test("the stop reason, the configured limits and the truncation note are the approved wording", () => {
  assert.equal(SAFETY_LIMIT_STOP, "The audit stopped after reaching its configured safety limit.");
  assert.equal(
    configuredLimitsSentence("100", "5 minutes"),
    "Configured limits for this audit: up to 100 pages and 5 minutes.",
  );
  assert.equal(AFFECTED_LIST_TRUNCATED, "Further affected pages are not listed.");
  assert.equal(NO_SITEMAP_SENTENCE, "No sitemap was found, so none was read.");
});

test("the real-visitor explanation names the measured address, and the reference points to it", () => {
  const paragraphs = realVisitorExplanation("https://example.com/");
  assert.equal(paragraphs.length, 3);
  assert.equal(
    paragraphs[2],
    "Speed is measured on https://example.com/. Desktop results are shown for information and do not affect the grade.",
  );
  assert.match(REAL_VISITOR_REFERENCE, /see Speed & Performance/);
});

test("section intros are present and the Limitations intro is the approved one", () => {
  for (const intro of Object.values(SECTION_INTROS)) assert.ok(intro.length > 40);
  assert.equal(
    SECTION_INTROS.limitations,
    "This section explains what the audit could and could not check, so the results above can be read accurately.",
  );
});
