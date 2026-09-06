/**
 * How the robots.txt rule behaves in each of the three measurement states.
 *
 * The subtle half of this is the PASS, not the fire. `robotsBlocksEverything`
 * is false both when the file blocks nobody and when the file could not be
 * read at all — so a rule handed the raw boolean would report "your site is
 * not blocked from search" on the strength of a request that timed out.
 *
 * Firing on an unread file would be alarming. Passing on one is quietly wrong,
 * which is worse: nobody checks a clean result.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { runRules } from "./runner.ts";
import { TECHNICAL_RULES } from "./technical.ts";
import { fromRobotsRules } from "./selectors.ts";
import type { AuditFacts } from "./types.ts";
import type { SiteFileStatus, TechnicalData } from "../types";

const RULE_ID = "technical.robots.blocks-all";

const technical = (
  robotsTxtStatus: SiteFileStatus,
  robotsBlocksEverything = false,
): TechnicalData => ({
  robotsTxtStatus,
  robotsBlocksEverything,
  sitemapStatus: "absent",
  sitemapUrl: null,
});

const run = (value: TechnicalData | null) =>
  runRules({ technical: value } as unknown as AuditFacts, TECHNICAL_RULES);

test("a readable robots.txt that blocks everyone FIRES", () => {
  const { findings, skipped } = run(technical("found", true));

  assert.equal(skipped.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, RULE_ID);
  assert.equal(findings[0].severity, "critical");
});

test("a readable robots.txt that blocks nobody passes", () => {
  const { findings, skipped } = run(technical("found", false));

  assert.equal(skipped.length, 0);
  assert.equal(findings.filter((f) => f.severity !== "good").length, 0);
});

test("a genuinely ABSENT robots.txt passes — a site with none blocks nothing", () => {
  // The server told us. That is a measurement, and it honestly passes.
  const { findings, skipped } = run(technical("absent"));

  assert.equal(skipped.length, 0);
  assert.equal(findings.filter((f) => f.severity !== "good").length, 0);
});

test("an UNAVAILABLE robots.txt neither fires NOR passes — it is skipped", () => {
  const { findings, skipped } = run(technical("unavailable"));

  assert.equal(findings.length, 0, "we may not report a problem we did not measure");
  assert.equal(skipped.length, 1, "and we may not report a clean result either");
  assert.equal(skipped[0].ruleId, RULE_ID);
  assert.match(skipped[0].reason, /could not be read/);
});

test("an unavailable robots.txt never becomes a finding, whatever the flag says", () => {
  // Defensive: even if the flag were somehow true, an unread file cannot
  // support a claim about the site.
  const { findings, skipped } = run(technical("unavailable", true));

  assert.equal(findings.length, 0);
  assert.equal(skipped.length, 1);
});

test("technical checks that never ran are still skipped", () => {
  const { findings, skipped } = run(null);

  assert.equal(findings.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /ran out of time/);
});

test("the selector withholds only the unavailable state", () => {
  assert.equal(fromRobotsRules(technical("found")).measured, true);
  assert.equal(fromRobotsRules(technical("absent")).measured, true);
  assert.equal(fromRobotsRules(technical("unavailable")).measured, false);
  assert.equal(fromRobotsRules(null).measured, false);
});

test("a skipped robots check carries a reason a person can read", () => {
  const measurement = fromRobotsRules(technical("unavailable"));

  assert.equal(measurement.measured, false);
  if (!measurement.measured) {
    // Never the raw state name, and never phrased as a fault of the website.
    assert.ok(!measurement.reason.includes("unavailable"));
    assert.match(measurement.reason, /unknown|could not/i);
  }
});
