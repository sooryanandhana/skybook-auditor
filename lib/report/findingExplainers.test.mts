/**
 * The plain-language explanation library is complete, well formed, and makes
 * no claim it cannot support.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_RULES } from "../rules/all.ts";
import {
  EVIDENCE_HEADINGS,
  EVIDENCE_PANEL_HEADINGS,
  FINDING_EXPLAINERS,
  FIX_ROLE_LABELS,
  evidenceHeadingWithReach,
  explainerFor,
  whoFixesLabel,
} from "./findingExplainers.ts";
import { CERTAINTY_PHRASES } from "./wordingGuard.fixture.mts";

const ruleIds = ALL_RULES.map((rule) => rule.id);

test("every rule has exactly one explanation, and no explanation is left without a rule", () => {
  const explained = Object.keys(FINDING_EXPLAINERS).sort();
  assert.deepEqual(explained, [...ruleIds].sort());
  assert.equal(ruleIds.length, 30, "the rule set this library was written for has 30 rules");
});

test("every explanation has all six parts, filled in", () => {
  for (const id of ruleIds) {
    const entry = explainerFor(id);
    assert.ok(entry !== null, `${id} has an explanation`);
    for (const field of ["whatItMeans", "whyItMatters", "possibleImpact", "whatFixingAchieves"] as const) {
      assert.ok(entry[field].trim().length >= 20, `${id}.${field} is written`);
    }
    assert.ok(entry.steps.length >= 2 && entry.steps.length <= 5, `${id} has two to five steps`);
    for (const step of entry.steps) assert.ok(step.trim().length > 0, `${id} has no empty step`);
    assert.ok(entry.whoFixes.length >= 1, `${id} names who fixes it`);
    for (const role of entry.whoFixes) assert.ok(role in FIX_ROLE_LABELS, `${id} uses a known role`);
  }
});

test("no explanation states a consequence as fact or promises a result", () => {
  for (const id of ruleIds) {
    const entry = FINDING_EXPLAINERS[id];
    const text = [
      entry.whatItMeans,
      entry.whyItMatters,
      entry.possibleImpact,
      ...entry.steps,
      entry.whatFixingAchieves,
    ].join(" ");
    for (const phrase of CERTAINTY_PHRASES) {
      assert.doesNotMatch(text, phrase, `${id} must not say ${phrase}`);
    }
  }
});

test("what a fix achieves is stated as an intention, never a promise", () => {
  for (const id of ruleIds) {
    assert.match(
      FINDING_EXPLAINERS[id].whatFixingAchieves,
      /\b(is|are) intended to\b/,
      `${id} says what the fix is intended to do`,
    );
  }
});

test("the approved wording is the wording in the library", () => {
  // Spot checks of approved texts, so an accidental edit is caught rather than printed.
  assert.equal(
    FINDING_EXPLAINERS["security.dns.dmarc"].whatFixingAchieves,
    "A DMARC policy is intended to give receiving email systems clear instructions for messages that fail your domain's checks, and to give you regular reports on who is sending email using your domain's name.",
  );
  assert.equal(
    FINDING_EXPLAINERS["speed.field.lcp.slow"].whatFixingAchieves,
    FINDING_EXPLAINERS["speed.field.lcp.needs-improvement"].whatFixingAchieves,
    "the LCP pair shares one sentence",
  );
  assert.equal(
    FINDING_EXPLAINERS["security.headers.hsts"].steps[3],
    "Only add the \"includeSubDomains\" option after confirming that every subdomain (such as shop. or mail. versions of the address) also works over https://.",
  );
  assert.equal(
    FINDING_EXPLAINERS["seo.canonical.missing"].steps[1],
    "Add a canonical link to each page's head section pointing to that address; most website platforms and SEO plugins can do this automatically.",
  );
  assert.equal(
    FINDING_EXPLAINERS["seo.h1.missing"].whatItMeans,
    "The page does not have a main heading (coded as h1). A main heading is the top-level heading that states what the page is about.",
  );
  assert.equal(
    FINDING_EXPLAINERS["seo.h1.empty"].possibleImpact,
    "The page loses the benefit of a clearly stated main topic, so its purpose may be less clear to search engines and to people using screen readers.",
  );
  assert.equal(
    FINDING_EXPLAINERS["seo.headings.order"].whatItMeans,
    "The page's heading levels skip a step, for example a second-level heading (h2) followed directly by a fourth-level heading (h4). The exact skips found are listed under \"What we found\".",
  );
});

test("the redesigned evidence headings: one with figures, one without", () => {
  assert.equal(EVIDENCE_HEADINGS.site, "Measured for the whole domain");
  assert.equal(EVIDENCE_HEADINGS.onePage, "Measured on the page checked");
  assert.equal(EVIDENCE_HEADINGS.examplePage, "Example measured on the main page checked");
  assert.equal(
    evidenceHeadingWithReach(19, 128),
    "Example measured on the main page checked (found on 19 of 128 pages)",
  );
  assert.doesNotMatch(EVIDENCE_HEADINGS.examplePage, /\d/, "the unverified form carries no figure");
});

test("the headings the report prints today are unchanged until the cards move over", () => {
  assert.deepEqual(EVIDENCE_PANEL_HEADINGS, {
    site: "Measured for the whole site",
    mainPage: "Measured on the main page checked",
  });
});

test("an unknown rule has no explanation rather than a borrowed one", () => {
  assert.equal(explainerFor("not.a.rule"), null);
  assert.equal(explainerFor("toString"), null, "inherited object keys are not rules");
});

test("who-fixes wording is the fixed report wording, in order", () => {
  assert.equal(
    whoFixesLabel(FINDING_EXPLAINERS["security.ssl.hostname"]),
    "Hosting or server administrator, Domain or DNS administrator",
  );
});
