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
  FINDING_EXPLAINERS,
  FIX_ROLE_LABELS,
  explainerFor,
  whoFixesLabel,
} from "./findingExplainers.ts";

/**
 * Wording that turns a possibility into a verdict about the client's site, or
 * promises a result. Each was chosen because a report must never say it.
 */
const CERTAINTY_PHRASES: readonly RegExp[] = [
  /\bguarantee/i,
  /\bhas been (hacked|compromised|attacked|breached)/i,
  /\bpenali[sz]/i,
  /\blost (rankings|traffic|customers|sales)/i,
  /\bwill (lose|rank|be hacked|be penali[sz]ed|increase|improve|fail)/i,
  /\b(definitely|certainly|always will|proves?)\b/i,
];

const ruleIds = ALL_RULES.map((rule) => rule.id);

test("every rule has exactly one explanation, and no explanation is left without a rule", () => {
  const explained = Object.keys(FINDING_EXPLAINERS).sort();
  assert.deepEqual(explained, [...ruleIds].sort());
  assert.equal(ruleIds.length, 30, "the rule set this library was written for has 30 rules");
});

test("every explanation has all five parts, filled in", () => {
  for (const id of ruleIds) {
    const entry = explainerFor(id);
    assert.ok(entry !== null, `${id} has an explanation`);
    for (const field of ["whatItMeans", "whyItMatters", "possibleImpact"] as const) {
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
    const text = [entry.whatItMeans, entry.whyItMatters, entry.possibleImpact, ...entry.steps].join(" ");
    for (const phrase of CERTAINTY_PHRASES) {
      assert.doesNotMatch(text, phrase, `${id} must not say ${phrase}`);
    }
  }
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
