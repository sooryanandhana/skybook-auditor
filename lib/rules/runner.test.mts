/**
 * Tests for the rules engine.
 *
 * These are adversarial on purpose. The engine's job is to make one specific
 * mistake impossible — reporting a problem the site does not have, because a
 * measurement failed — so the tests try to make it happen.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assertUniqueRuleIds, defineRule, runRules } from "./runner.ts";
import {
  fires,
  measured,
  passes,
  unmeasured,
  type AuditFacts,
  type Measurement,
} from "./types.ts";
import {
  fromEmailPolicy,
  fromFieldPerformance,
  fromNullable,
  fromPerformance,
  fromRecordSet,
  fromSsl,
  fromTechnical,
} from "./selectors.ts";
import type { DnsRecordSet, PerformanceData, SslData, TechnicalData } from "../types.ts";

// ---------------------------------------------------------------------------
// A minimal set of facts. Only the fields a given test cares about are real;
// the rest exist to satisfy the type.
// ---------------------------------------------------------------------------

function facts(overrides: Partial<AuditFacts> = {}): AuditFacts {
  return {
    website: { requestedUrl: "https://example.com/", checkedAt: "2026-09-03T00:00:00.000Z" },
    fetch: {
      finalUrl: "https://example.com/",
      redirectChain: ["https://example.com/"],
      wasRedirected: false,
      servedOverHttps: true,
      httpsUnavailable: false,
      certificateProblem: null,
      contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 120 },
    responseTime: null,
    seo: {
      titleText: "Example",
      titleLength: 7,
      metaDescriptionText: null,
      metaDescriptionLength: 0,
      bodyTextLength: 1200,
      h1Count: 1,
      h2Count: 2,
      h3Count: 0,
      h1Texts: ["Example"],
      headingSkips: [],
      imageCount: 3,
      imagesMissingAlt: 0,
      canonicalUrl: null,
      langAttribute: "en",
      hasViewportMeta: true,
    },
    technical: null,
    performance: notCheckedPerformance("not-requested"),
    security: {} as AuditFacts["security"],
    ssl: { status: "unreachable", hostname: "example.com", message: "no TLS" } as SslData,
    dns: {} as AuditFacts["dns"],
    hosting: null,
    timedOut: false,
    ...overrides,
  };
}

function notCheckedPerformance(
  status: PerformanceData["status"],
  message = "Speed was not measured.",
): PerformanceData {
  return {
    status,
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: status === "error" ? "timeout" : null,
    field: {
      status: "error",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: message,
    },
    lab: {
      status: "error",
      measuredUrl: null,
      score: null,
      lcpMs: null,
      fcpMs: null,
      tbtMs: null,
      speedIndexMs: null,
      cls: null,
      error: message,
    },
    notInspected: [],
    message,
  };
}

// ---------------------------------------------------------------------------
// 1. A real bad measurement produces a finding
// ---------------------------------------------------------------------------

const noMetaDescription = defineRule({
  id: "missing-meta-description",
  scope: "page",
  remediation: "Fix the underlying issue.",
  title: "Missing meta description",
  category: "seo",
  severity: "medium",
  select: (data) => measured(data.seo),
  evaluate: (seo) =>
    seo.metaDescriptionText === null
      ? fires("No meta description tag was found on the page.")
      : passes,
  pass: {
    title: "Meta description present",
    evidence: (seo) => `${seo.metaDescriptionLength} characters.`,
  },
});

test("a genuine problem produces a finding with its rule id and evidence", () => {
  const { findings } = runRules(facts(), [noMetaDescription]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "missing-meta-description");
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].category, "seo");
  assert.match(findings[0].evidence, /No meta description/);
});

// ---------------------------------------------------------------------------
// 2. A good measurement can produce a positive finding
// ---------------------------------------------------------------------------

test("a measurement that passes produces a good finding, carrying its evidence", () => {
  const good = facts({
    seo: { ...facts().seo, metaDescriptionText: "A description.", metaDescriptionLength: 14 },
  });

  const { findings } = runRules(good, [noMetaDescription]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "good");
  assert.equal(findings[0].title, "Meta description present");
  assert.match(findings[0].evidence, /14 characters/);
});

test("a rule with no pass report stays silent when it does not fire", () => {
  const quiet = defineRule({
    id: "quiet-rule",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Quiet",
    category: "seo",
    severity: "medium",
    select: (data) => measured(data.seo),
    evaluate: () => passes,
  });

  const { findings, skipped } = runRules(facts(), [quiet]);

  assert.equal(findings.length, 0);
  assert.equal(skipped.length, 0, "not firing is not the same as not running");
});

// ---------------------------------------------------------------------------
// 3 & 4. Unmeasured data can never produce a finding
// ---------------------------------------------------------------------------

/** A rule that fires on absolutely anything it is shown. */
function greedyRule(id: string, select: (data: AuditFacts) => Measurement<unknown>) {
  return defineRule({
    id,
    remediation: "Fix the underlying issue.",
    title: "Fires at anything",
    category: "technical",
    scope: "page",
    severity: "critical",
    select,
    evaluate: () => fires("This rule fires unconditionally."),
    pass: { title: "Passed", evidence: () => "passed" },
  });
}

test("null data produces no finding — the rule never runs at all", () => {
  // technical is null when the audit ran out of time.
  const rule = greedyRule("greedy-technical", (data) => fromTechnical(data.technical));
  const { findings, skipped } = runRules(facts({ technical: null }), [rule]);

  assert.equal(findings.length, 0, "a rule that fires at anything must still see nothing");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].ruleId, "greedy-technical");
  assert.match(skipped[0].reason, /ran out of time/);
});

test("technical: error must never become 'missing robots.txt'", () => {
  const robots = defineRule({
    id: "no-robots-txt",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "No robots.txt",
    category: "technical",
    severity: "medium",
    select: (data) => fromTechnical(data.technical),
    evaluate: (technical) =>
      technical.robotsTxtStatus === "absent"
        ? fires("No robots.txt was found.")
        : passes,
  });

  // Not measured: the audit never got there.
  const { findings } = runRules(facts({ technical: null }), [robots]);
  assert.equal(findings.length, 0, "we did not look, so we may not report");

  // Measured, and genuinely absent: this one IS a finding.
  const looked = facts({
    technical: { robotsTxtStatus: "absent", sitemapStatus: "absent" } as TechnicalData,
  });
  const result = runRules(looked, [robots]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, "medium");
});

test("spf: error must never become 'no SPF record'", () => {
  const spf = defineRule({
    id: "no-spf",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "No SPF record",
    category: "security",
    severity: "high",
    select: (data) => fromEmailPolicy(data.dns.spf),
    evaluate: (presence) =>
      presence.present ? passes : fires("The domain publishes no SPF record."),
  });

  const errored = facts({
    dns: { spf: { status: "error", record: null, error: "Query timed out" } } as AuditFacts["dns"],
  });
  const { findings, skipped } = runRules(errored, [spf]);

  assert.equal(findings.length, 0, "a failed lookup is not an absent record");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /timed out/);
});

test("but a genuine absence IS reportable — the two must stay distinct", () => {
  const spf = defineRule({
    id: "no-spf",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "No SPF record",
    category: "security",
    severity: "high",
    select: (data) => fromEmailPolicy(data.dns.spf),
    evaluate: (presence) =>
      presence.present ? passes : fires("The domain publishes no SPF record."),
  });

  const absent = facts({
    dns: { spf: { status: "absent", record: null, error: null } } as AuditFacts["dns"],
  });
  const { findings, skipped } = runRules(absent, [spf]);

  assert.equal(skipped.length, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
});

test("a DNS error is withheld while a genuine absence is not", () => {
  const errored: DnsRecordSet<string> = { status: "error", records: [], error: "ETIMEOUT" };
  const absent: DnsRecordSet<string> = { status: "absent", records: [], error: null };
  const found: DnsRecordSet<string> = { status: "found", records: ["ns1.test"], error: null };

  assert.equal(fromRecordSet(errored).measured, false);
  assert.equal(fromRecordSet(absent).measured, true);
  assert.equal(fromRecordSet(found).measured, true);

  const absentValue = fromRecordSet(absent);
  assert.ok(absentValue.measured && absentValue.value.present === false);
});

test("an unread certificate produces no certificate finding", () => {
  const rule = greedyRule("greedy-ssl", (data) => fromSsl(data.ssl));

  for (const status of ["not-applicable", "blocked", "unreachable"] as const) {
    const { findings, skipped } = runRules(
      facts({ ssl: { status, hostname: "x", message: `status ${status}` } as SslData }),
      [rule],
    );
    assert.equal(findings.length, 0, `${status} must not produce a finding`);
    assert.equal(skipped.length, 1);
  }
});

// ---------------------------------------------------------------------------
// 5. A failed speed check must never read as a slow website
// ---------------------------------------------------------------------------

test("performance timeout must never become a slow-website finding", () => {
  const rule = greedyRule("greedy-performance", (data) => fromPerformance(data.performance));

  const timedOut = notCheckedPerformance("error");
  timedOut.failureReason = "timeout";
  timedOut.message = "Speed was not measured: Google's speed test did not finish in time.";

  const { findings, skipped } = runRules(facts({ performance: timedOut }), [rule]);

  assert.equal(findings.length, 0, "Google being slow is not the website being slow");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /did not finish in time/);
});

test("every non-checked performance status is withheld from rules", () => {
  const rule = greedyRule("greedy-performance", (data) => fromPerformance(data.performance));

  for (const status of ["not-requested", "no-api-key", "pending", "error"] as const) {
    const { findings } = runRules(
      facts({ performance: notCheckedPerformance(status) }),
      [rule],
    );
    assert.equal(findings.length, 0, `status "${status}" must not reach a rule`);
  }
});

test("performance absent must never become a performance problem", () => {
  // Google has too few visitors to report on. That is not slowness — it is the
  // normal case for a small business site.
  const quiet: PerformanceData = {
    ...notCheckedPerformance("checked"),
    status: "checked",
    failureReason: null,
    field: {
      status: "absent",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: null,
    },
  };

  const rule = greedyRule("greedy-field", (data) => fromFieldPerformance(data.performance));
  const { findings, skipped } = runRules(facts({ performance: quiet }), [rule]);

  assert.equal(findings.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /says nothing about how fast/);
});

test("real field data does reach a rule", () => {
  const good: PerformanceData = {
    ...notCheckedPerformance("checked"),
    status: "checked",
    failureReason: null,
    field: {
      status: "found",
      measuredUrl: "https://example.com/",
      scope: "page",
      overall: "SLOW",
      lcp: { percentileMs: 5200, category: "SLOW" },
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: null,
    },
  };

  const rule = defineRule({
    id: "slow-lcp",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Slow Largest Contentful Paint",
    category: "speed",
    severity: "high",
    select: (data) => fromFieldPerformance(data.performance),
    evaluate: (field) =>
      // Google's own rating, not a threshold of ours.
      field.lcp?.category === "SLOW"
        ? fires(`Google rates LCP as SLOW at ${field.lcp.percentileMs} ms.`)
        : passes,
  });

  const { findings } = runRules(facts({ performance: good }), [rule]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].evidence, /5200 ms/);
});

// ---------------------------------------------------------------------------
// 6 & 7. Severity is fixed, and the runner cannot move it
// ---------------------------------------------------------------------------

test("the same input always produces the same severity", () => {
  const input = facts();
  const first = runRules(input, [noMetaDescription]);
  const second = runRules(input, [noMetaDescription]);
  const third = runRules(facts(), [noMetaDescription]);

  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.findings, third.findings);
});

test("the runner copies the rule's declared severity and never computes one", () => {
  for (const severity of ["critical", "high", "medium"] as const) {
    const rule = defineRule({
      id: `sev-${severity}`,
      remediation: "Fix the underlying issue.",
      title: "Severity carrier",
      category: "security",
      scope: "page",
      severity,
      select: (data) => measured(data.seo),
      evaluate: () => fires("fired"),
    });

    const { findings } = runRules(facts(), [rule]);
    assert.equal(findings[0].severity, severity);
  }
});

test("evaluate has no way to express a severity at all", () => {
  // The Verdict type carries `fires` and `evidence` — nothing else. If a rule
  // could return a severity, this object would type-check as a Verdict.
  const verdict = fires("evidence only");
  assert.deepEqual(Object.keys(verdict).sort(), ["evidence", "fires"]);
  assert.deepEqual(Object.keys(passes), ["fires"]);
});

test("a passing rule is always graded good, never anything else", () => {
  const good = facts({
    seo: { ...facts().seo, metaDescriptionText: "Here.", metaDescriptionLength: 5 },
  });
  const { findings } = runRules(good, [noMetaDescription]);

  assert.equal(findings[0].severity, "good");
});

test("findings are ordered worst first, regardless of rule order", () => {
  const make = (id: string, severity: "critical" | "high" | "medium") =>
    defineRule({
      id,
      remediation: "Fix the underlying issue.",
      title: id,
      category: "security",
      scope: "page",
      severity,
      select: (data) => measured(data.seo),
      evaluate: () => fires("fired"),
    });

  const rules = [make("m", "medium"), make("c", "critical"), make("h", "high")];
  const { findings } = runRules(facts(), rules);

  assert.deepEqual(
    findings.map((f) => f.severity),
    ["critical", "high", "medium"],
  );

  // And reversing the rule list changes nothing.
  const reversed = runRules(facts(), [...rules].reverse());
  assert.deepEqual(findings, reversed.findings);
});

// ---------------------------------------------------------------------------
// 8. Findings are traceable
// ---------------------------------------------------------------------------

test("every finding carries the rule id that produced it", () => {
  const { findings } = runRules(facts(), [noMetaDescription]);

  assert.equal(findings[0].id, "missing-meta-description");
  assert.ok(findings[0].evidence.length > 0, "a finding without evidence cannot be checked");
});

test("duplicate rule ids are refused", () => {
  const a = defineRule({
    id: "same",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "A",
    category: "seo",
    severity: "medium",
    select: (data) => measured(data.seo),
    evaluate: () => passes,
  });

  assert.throws(() => assertUniqueRuleIds([a, a]), /Duplicate rule id: same/);
  assert.doesNotThrow(() => assertUniqueRuleIds([a]));
});

test("skipped rules are recorded, not silently dropped", () => {
  // A gap that is not reported reads as a pass.
  const rule = greedyRule("greedy-technical", (data) => fromTechnical(data.technical));
  const { skipped } = runRules(facts({ technical: null }), [rule]);

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].ruleId, "greedy-technical");
  assert.ok(skipped[0].reason.length > 0);
});

// ---------------------------------------------------------------------------
// 9. No AI anywhere near this layer
// ---------------------------------------------------------------------------

test("the rules layer imports no AI SDK", () => {
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".mts"));

  assert.ok(files.length >= 3, "expected the rules layer to have files to check");

  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const forbidden of ["@anthropic-ai", "openai", "@ai-sdk"]) {
      assert.ok(
        !source.includes(`from "${forbidden}`) && !source.includes(`require("${forbidden}`),
        `${file} must not import ${forbidden} — severity is decided by code, never by AI`,
      );
    }
  }
});

test("rules read only measured facts, never another rule's output", () => {
  // AuditFacts omits `findings`, so a rule cannot grade on top of a grade —
  // which would make the result depend on the order rules happened to run in.
  const input = facts() as Record<string, unknown>;
  assert.ok(!("findings" in input), "findings must not be visible to a rule");
});

// ---------------------------------------------------------------------------
// The selectors themselves
// ---------------------------------------------------------------------------

test("fromNullable withholds null and passes everything else", () => {
  assert.equal(fromNullable(null, "not measured").measured, false);
  assert.equal(fromNullable(0, "x").measured, true, "zero is a value, not an absence");
  assert.equal(fromNullable("", "x").measured, true, "an empty string is a value too");
  assert.equal(fromNullable(false, "x").measured, true);
});

test("unmeasured carries a reason a report can print", () => {
  const result = unmeasured<string>("The DNS lookup did not complete.");
  assert.equal(result.measured, false);
  assert.ok(!result.measured && result.reason.length > 0);
});

// ===========================================================================
// EXCEPTION ISOLATION
//
// A rule that throws has not discovered anything about the website. It has
// failed to run. Before this was isolated, such a rule took the entire run
// with it: later rules never executed, and findings ALREADY PRODUCED were
// discarded. In the audit route, which has no outer guard around runRules,
// that turned one broken rule into a lost audit.
//
// console.warn is silenced in these tests only so a deliberate throw does not
// print a stack trace over the results. The call itself is asserted.
// ===========================================================================

/** Runs `body` with console.warn captured rather than printed. */
function withSilencedWarnings<T>(body: () => T): { result: T; warnings: unknown[][] } {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: body(), warnings };
  } finally {
    console.warn = original;
  }
}

/** A rule that always fires, so its presence in the output is unambiguous. */
function firingRule(id: string, severity: "critical" | "high" | "medium") {
  return defineRule({
    id,
    remediation: "Fix the underlying issue.",
    title: `Rule ${id}`,
    category: "seo",
    scope: "page",
    severity,
    select: (data) => measured(data.seo),
    evaluate: () => fires(`${id} fired`),
  });
}

/** A rule whose selector explodes before it can measure anything. */
function throwingSelector(id: string) {
  return defineRule({
    id,
    remediation: "Fix the underlying issue.",
    title: `Rule ${id}`,
    category: "seo",
    scope: "page",
    severity: "critical",
    select: () => {
      throw new TypeError("Cannot read properties of undefined (reading 'applicable')");
    },
    evaluate: () => fires("must never be reached"),
  });
}

/** A rule that measures fine, then explodes while judging. */
function throwingEvaluator(id: string) {
  return defineRule({
    id,
    remediation: "Fix the underlying issue.",
    title: `Rule ${id}`,
    category: "seo",
    scope: "page",
    severity: "critical",
    select: (data) => measured(data.seo),
    evaluate: () => {
      throw new RangeError("evaluator exploded");
    },
  });
}

// ---------------------------------------------------------------------------
// 1 & 2. Both halves of a rule are covered
// ---------------------------------------------------------------------------

test("a throwing selector becomes a skipped check, not a finding", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom.select")]),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].ruleId, "boom.select");
});

test("a throwing evaluator becomes a skipped check, not a finding", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingEvaluator("boom.evaluate")]),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].ruleId, "boom.evaluate");
});

test("runRules does not throw when a rule does", () => {
  assert.doesNotThrow(() =>
    withSilencedWarnings(() => runRules(facts(), [throwingSelector("boom")])),
  );
});

// ---------------------------------------------------------------------------
// 3-6. THE ADVERSARIAL CASE: earlier findings must survive
// ---------------------------------------------------------------------------

test("A fires, B throws, C fires: both findings survive and B is skipped", () => {
  // The exact failure mode this patch exists for. Before it, A's finding was
  // discarded along with the run and C never executed at all.
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [
      firingRule("rule.a", "high"),
      throwingSelector("rule.b"),
      firingRule("rule.c", "medium"),
    ]),
  );

  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((f) => f.id),
    ["rule.a", "rule.c"],
    "worst first, and neither lost",
  );
  assert.ok(!result.findings.some((f) => f.id === "rule.b"), "a thrown rule produces nothing");

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].ruleId, "rule.b");
});

test("a finding produced BEFORE the failure survives", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [firingRule("before", "high"), throwingSelector("boom")]),
  );

  assert.deepEqual(result.findings.map((f) => f.id), ["before"]);
});

test("a rule AFTER the failure still executes", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom"), firingRule("after", "medium")]),
  );

  assert.deepEqual(result.findings.map((f) => f.id), ["after"]);
});

test("the throwing rule contributes zero findings at any severity", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom.critical")]),
  );

  for (const severity of ["critical", "high", "medium", "good"] as const) {
    assert.ok(
      !result.findings.some((f) => f.severity === severity),
      `a thrown rule must not produce a ${severity} finding`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. A skipped check carries no grade
// ---------------------------------------------------------------------------

test("the skipped entry has no severity and no finding fields", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom")]),
  );
  const entry = result.skipped[0] as unknown as Record<string, unknown>;

  assert.deepEqual(Object.keys(entry).sort(), ["reason", "ruleId"]);
  assert.equal(entry.severity, undefined);
  assert.equal(entry.title, undefined);
  assert.equal(entry.evidence, undefined);
});

test("the reason blames the check, never the website", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom")]),
  );
  const { reason } = result.skipped[0];

  assert.match(reason, /could not be evaluated/);
  assert.match(reason, /not a problem with the website/);
});

// ---------------------------------------------------------------------------
// 8. Several failures
// ---------------------------------------------------------------------------

test("multiple throwing rules produce multiple skipped checks", () => {
  const { result } = withSilencedWarnings(() =>
    runRules(facts(), [
      throwingSelector("boom.one"),
      firingRule("survivor", "medium"),
      throwingEvaluator("boom.two"),
      throwingSelector("boom.three"),
    ]),
  );

  assert.deepEqual(result.findings.map((f) => f.id), ["survivor"]);
  assert.deepEqual(
    result.skipped.map((s) => s.ruleId).sort(),
    ["boom.one", "boom.three", "boom.two"],
  );
});

// ---------------------------------------------------------------------------
// 9 & 10. Nothing else changed
// ---------------------------------------------------------------------------

test("a run with no throwing rule is completely unchanged", () => {
  const rules = [firingRule("a", "high"), firingRule("b", "medium")];
  const { result, warnings } = withSilencedWarnings(() => runRules(facts(), rules));

  assert.deepEqual(result.findings.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(warnings.length, 0, "nothing to warn about");
});

test("unmeasured selectors still skip exactly as before, without warning", () => {
  // A selector that reports "not measured" is doing its job. It must not be
  // confused with one that crashed, and must not log.
  const rule = defineRule({
    id: "clean.skip",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Clean skip",
    category: "technical",
    severity: "medium",
    select: (data) => fromTechnical(data.technical),
    evaluate: () => fires("unreachable"),
  });

  const { result, warnings } = withSilencedWarnings(() =>
    runRules(facts({ technical: null }), [rule]),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /ran out of time/);
  assert.ok(!/failed to run/.test(result.skipped[0].reason));
  assert.equal(warnings.length, 0, "a deliberate skip is not an error");
});

test("ordering still holds around a failure", () => {
  const rules = [
    firingRule("z.medium", "medium"),
    throwingSelector("boom"),
    firingRule("a.critical", "critical"),
  ];

  const { result } = withSilencedWarnings(() => runRules(facts(), rules));
  assert.deepEqual(result.findings.map((f) => f.severity), ["critical", "medium"]);

  const { result: reversed } = withSilencedWarnings(() =>
    runRules(facts(), [...rules].reverse()),
  );
  assert.deepEqual(result.findings, reversed.findings, "rule order still irrelevant");
});

// ---------------------------------------------------------------------------
// Security: the client never sees the exception
// ---------------------------------------------------------------------------

test("the raw exception message never reaches the skipped reason", () => {
  const secretish = defineRule({
    id: "leaky",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Leaky",
    category: "seo",
    severity: "high",
    select: () => {
      throw new Error("failed calling https://api.example.com/v1?key=AIzaSyTOPSECRET at C:\\srv\\app");
    },
    evaluate: () => fires("x"),
  });

  const { result } = withSilencedWarnings(() => runRules(facts(), [secretish]));
  const { reason } = result.skipped[0];

  assert.ok(!reason.includes("AIzaSy"), "an API key must never travel in a reason");
  assert.ok(!reason.includes("api.example.com"));
  assert.ok(!reason.includes("C:\\srv"), "no filesystem paths");
  assert.ok(!/\n\s+at /.test(reason), "no stack frames");
});

test("the failure is still logged server-side for whoever must fix the rule", () => {
  const { warnings } = withSilencedWarnings(() =>
    runRules(facts(), [throwingSelector("boom.logged")]),
  );

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Rule "boom\.logged" threw while running and was skipped/);
});

test("a thrown non-Error value is handled without crashing", () => {
  const oddball = defineRule({
    id: "throws.string",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Oddball",
    category: "seo",
    severity: "medium",
    select: () => {
      throw "a bare string, not an Error";
    },
    evaluate: () => fires("x"),
  });

  const { result } = withSilencedWarnings(() => runRules(facts(), [oddball]));

  assert.deepEqual(result.findings, []);
  assert.equal(result.skipped[0].ruleId, "throws.string");
});

// ---------------------------------------------------------------------------
// The narrowed fact type is isolated too
// ---------------------------------------------------------------------------

test("isolation works for rules on the narrower performance fact type", () => {
  // The speed rules read PerformanceFacts, not AuditFacts. One runner, one
  // guard, both fact types.
  const boom = defineRule<never, { performance: unknown }>({
    id: "speed.boom",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Speed boom",
    category: "speed",
    severity: "high",
    select: () => {
      throw new TypeError("speed selector exploded");
    },
    evaluate: () => fires("unreachable"),
  });

  const survivor = defineRule<unknown, { performance: unknown }>({
    id: "speed.survivor",
    scope: "page",
    remediation: "Fix the underlying issue.",
    title: "Speed survivor",
    category: "speed",
    severity: "medium",
    select: (data) => measured(data.performance),
    evaluate: () => fires("still ran"),
  });

  const { result } = withSilencedWarnings(() =>
    runRules({ performance: {} }, [boom, survivor]),
  );

  assert.deepEqual(result.findings.map((f) => f.id), ["speed.survivor"]);
  assert.deepEqual(result.skipped.map((s) => s.ruleId), ["speed.boom"]);
});
