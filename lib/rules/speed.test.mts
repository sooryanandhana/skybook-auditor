/**
 * Tests for the speed rules.
 *
 * Two things are being defended here, and the second is the one that came from
 * a real measurement rather than a thought experiment.
 *
 *   1. A failed, pending or unrequested speed check must never become "this
 *      site is slow". Not knowing is not a verdict.
 *
 *   2. A poor laboratory score must never override Google's own assessment of
 *      what real visitors experienced. During Step 5, bbc.co.uk scored 30/100
 *      in Google's simulation while Google rated its real visitors FAST.
 *      Grading that simulation would have told the client their site was slow
 *      on the same day Google said the opposite.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { assertUniqueRuleIds, runRules } from "./runner.ts";
import { SPEED_RULES } from "./speed.ts";
import { ALL_RULES, AUDIT_RULES } from "./all.ts";
import { hasUsableFieldVitals } from "./selectors.ts";
import type { PerformanceFacts } from "./types.ts";
import type {
  FieldPerformance,
  LabPerformance,
  PerformanceData,
  PerformanceRating,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function field(overrides: Partial<FieldPerformance> = {}): FieldPerformance {
  return {
    status: "found",
    measuredUrl: "https://example.com/",
    scope: "page",
    overall: "FAST",
    lcp: { percentileMs: 900, category: "FAST" },
    inp: { percentileMs: 80, category: "FAST" },
    cls: { percentile: 0.02, category: "FAST" },
    fcp: { percentileMs: 700, category: "FAST" },
    ttfb: { percentileMs: 300, category: "FAST" },
    error: null,
    ...overrides,
  };
}

function lab(overrides: Partial<LabPerformance> = {}): LabPerformance {
  return {
    status: "found",
    measuredUrl: "https://example.com/",
    score: 95,
    lcpMs: 800,
    fcpMs: 700,
    tbtMs: 0,
    speedIndexMs: 800,
    cls: 0.01,
    error: null,
    ...overrides,
  };
}

function performance(overrides: Partial<PerformanceData> = {}): PerformanceData {
  return {
    status: "checked",
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: null,
    field: field(),
    lab: lab(),
    notInspected: [],
    message: "Checked.",
    ...overrides,
  };
}

/** A speed check that did not produce data, in each of its states. */
function unavailable(
  status: PerformanceData["status"],
  failureReason: PerformanceData["failureReason"] = null,
  message = "Speed was not measured.",
): PerformanceData {
  return performance({
    status,
    failureReason,
    message,
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
  });
}

const facts = (p: PerformanceData): PerformanceFacts => ({ performance: p });

function run(p: PerformanceData) {
  return runRules(facts(p), SPEED_RULES);
}

function firedIds(p: PerformanceData): string[] {
  return run(p).findings.map((f) => f.id);
}

function findingFor(id: string, p: PerformanceData) {
  return run(p).findings.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// The rule set
// ---------------------------------------------------------------------------

const SEVERITY_POLICY: Record<string, "high" | "medium"> = {
  "speed.field.lcp.slow": "high",
  "speed.field.lcp.needs-improvement": "medium",
  "speed.field.inp.slow": "high",
  "speed.field.inp.needs-improvement": "medium",
  "speed.field.cls.slow": "high",
  "speed.field.cls.needs-improvement": "medium",
  "speed.lab.score": "medium",
};

test("exactly seven speed rules", () => {
  assert.equal(SPEED_RULES.length, 7);
});

test("every rule declares the approved severity", () => {
  for (const rule of SPEED_RULES) {
    const expected = SEVERITY_POLICY[rule.id];
    assert.ok(expected, `${rule.id} is not in the approved policy table`);
    assert.equal(rule.severity, expected);
  }
});

test("the policy table and the rule set describe the same seven rules", () => {
  assert.deepEqual(SPEED_RULES.map((r) => r.id).sort(), Object.keys(SEVERITY_POLICY).sort());
});

test("no critical, no low, no good, all in the speed category", () => {
  for (const rule of SPEED_RULES) {
    assert.notEqual(rule.severity as string, "critical");
    assert.notEqual(rule.severity as string, "low");
    assert.notEqual(rule.severity as string, "good");
    assert.equal(rule.category, "speed");
    assert.ok(rule.id.startsWith("speed."));
  }
});

test("no FCP or TTFB rules exist", () => {
  // They stay measured and reported as diagnostics, and ungraded.
  for (const rule of SPEED_RULES) {
    assert.ok(!/fcp|ttfb/i.test(rule.id), `${rule.id} grades a metric that was ruled out`);
  }
});

test("rule ids are unique across the whole audit, and the inventory is 30", () => {
  assert.doesNotThrow(() => assertUniqueRuleIds(ALL_RULES));
  assert.equal(AUDIT_RULES.length, 23);
  assert.equal(ALL_RULES.length, 30);
});

test("a fast site produces nothing", () => {
  assert.deepEqual(firedIds(performance()), []);
});

// ---------------------------------------------------------------------------
// 1-9. Each metric, each category
// ---------------------------------------------------------------------------

const METRICS: Array<[string, (rating: PerformanceRating) => Partial<FieldPerformance>]> = [
  ["lcp", (category) => ({ lcp: { percentileMs: 4800, category } })],
  ["inp", (category) => ({ inp: { percentileMs: 620, category } })],
  ["cls", (category) => ({ cls: { percentile: 0.31, category } })],
];

for (const [metric, make] of METRICS) {
  test(`${metric.toUpperCase()} SLOW: exactly one high finding`, () => {
    const fired = firedIds(performance({ field: field(make("SLOW")) }));

    assert.deepEqual(fired, [`speed.field.${metric}.slow`]);
    assert.equal(findingFor(`speed.field.${metric}.slow`, performance({ field: field(make("SLOW")) }))?.severity, "high");
  });

  test(`${metric.toUpperCase()} AVERAGE: exactly one medium finding`, () => {
    const fired = firedIds(performance({ field: field(make("AVERAGE")) }));

    assert.deepEqual(fired, [`speed.field.${metric}.needs-improvement`]);
    assert.equal(
      findingFor(`speed.field.${metric}.needs-improvement`, performance({ field: field(make("AVERAGE")) }))?.severity,
      "medium",
    );
  });

  test(`${metric.toUpperCase()} FAST: no finding`, () => {
    assert.deepEqual(firedIds(performance({ field: field(make("FAST")) })), []);
  });

  test(`${metric.toUpperCase()} never produces both SLOW and AVERAGE`, () => {
    for (const rating of ["SLOW", "AVERAGE", "FAST"] as const) {
      const fired = firedIds(performance({ field: field(make(rating)) }));
      assert.ok(fired.length <= 1, `${rating} produced ${fired.length} findings: ${fired}`);
    }
  });
}

test("the evidence quotes the measured value and Google's own rating", () => {
  const finding = findingFor(
    "speed.field.lcp.slow",
    performance({ field: field({ lcp: { percentileMs: 4800, category: "SLOW" } }) }),
  );

  assert.ok(finding);
  assert.match(finding.evidence, /4800 ms/);
  assert.match(finding.evidence, /Google rates LCP as SLOW/);
  assert.ok(finding.remediation.length > 0);
});

test("a metric Google did not report is skipped, not graded", () => {
  const p = performance({ field: field({ lcp: null }) });
  const { findings, skipped } = run(p);

  assert.ok(!findings.some((f) => f.id.startsWith("speed.field.lcp")));
  assert.ok(skipped.some((s) => s.ruleId === "speed.field.lcp.slow"));
  assert.match(skipped.find((s) => s.ruleId === "speed.field.lcp.slow")?.reason ?? "", /did not report LCP/);
});

// ---------------------------------------------------------------------------
// 10-11. The lab fallback
// ---------------------------------------------------------------------------

/** Google measured, and genuinely has too few visitors to report on. */
function noFieldData(score: number): PerformanceData {
  return performance({
    field: field({
      status: "absent",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
    }),
    lab: lab({ score }),
  });
}

test("lab score below 50 with no field data: one medium finding", () => {
  const fired = firedIds(noFieldData(34));

  assert.deepEqual(fired, ["speed.lab.score"]);
  assert.equal(findingFor("speed.lab.score", noFieldData(34))?.severity, "medium");
});

test("lab score of 50 or more with no field data: no finding", () => {
  assert.deepEqual(firedIds(noFieldData(50)), []);
  assert.deepEqual(firedIds(noFieldData(92)), []);
});

test("the lab finding says plainly that it is a simulation, not real visitors", () => {
  const finding = findingFor("speed.lab.score", noFieldData(34));

  assert.ok(finding);
  assert.match(finding.evidence, /simulated/i);
  assert.match(finding.evidence, /no real-visitor data/i);
  assert.match(finding.remediation, /laboratory simulation|simulation rather than/i);
});

// ===========================================================================
// 17-19 + BBC REGRESSION — the lab may never overrule real visitors
// ===========================================================================

test("field FAST with a lab score of 30: NO lab finding", () => {
  const p = performance({ field: field(), lab: lab({ score: 30 }) });

  assert.ok(!firedIds(p).includes("speed.lab.score"));
});

test("field AVERAGE with a lab score of 30: NO lab finding", () => {
  const p = performance({
    field: field({ lcp: { percentileMs: 3000, category: "AVERAGE" } }),
    lab: lab({ score: 30 }),
  });

  const fired = firedIds(p);
  assert.ok(!fired.includes("speed.lab.score"));
  // The field metric is still graded on its own merit.
  assert.ok(fired.includes("speed.field.lcp.needs-improvement"));
});

test("field SLOW with a lab score of 30: NO lab finding", () => {
  const p = performance({
    field: field({ lcp: { percentileMs: 5200, category: "SLOW" } }),
    lab: lab({ score: 30 }),
  });

  const fired = firedIds(p);
  assert.ok(!fired.includes("speed.lab.score"));
  assert.ok(fired.includes("speed.field.lcp.slow"));
});

test("BBC regression: real visitors FAST at 1139 ms, simulation 30/100", () => {
  // Measured during Step 5 against the live API. The simulation disagreed with
  // reality by a wide margin, and reality is what Google ranks on.
  const bbc = performance({
    requestedUrl: "https://www.bbc.co.uk/",
    field: field({
      measuredUrl: "https://www.bbc.com/",
      overall: "FAST",
      lcp: { percentileMs: 1139, category: "FAST" },
      inp: { percentileMs: 112, category: "FAST" },
      cls: { percentile: 0.03, category: "FAST" },
    }),
    lab: lab({ measuredUrl: "https://www.bbc.com/", score: 30, lcpMs: 16652 }),
  });

  assert.deepEqual(
    firedIds(bbc),
    [],
    "a site Google rates FAST for real visitors must produce no speed finding",
  );
});

test("the lab is skipped, with a reason, when real-visitor data exists", () => {
  const { skipped } = run(performance({ lab: lab({ score: 30 }) }));
  const entry = skipped.find((s) => s.ruleId === "speed.lab.score");

  assert.ok(entry);
  assert.match(entry.reason, /diagnostic here rather than a verdict/);
});

test("a field ERROR is not a fallback trigger — unread is not absent", () => {
  // We do not know what real visitors saw, so there is no basis for deciding
  // the simulation is the best evidence available.
  const p = performance({
    field: field({ status: "error", lcp: null, inp: null, cls: null, error: "unreadable" }),
    lab: lab({ score: 20 }),
  });

  const { findings, skipped } = run(p);
  assert.ok(!findings.some((f) => f.id === "speed.lab.score"));
  assert.match(skipped.find((s) => s.ruleId === "speed.lab.score")?.reason ?? "", /could not be read/);
});

test("a found field block carrying no vitals does allow the fallback", () => {
  // Found, but with nothing Google ranks on. No better evidence to prefer.
  const p = performance({
    field: field({ status: "found", lcp: null, inp: null, cls: null, overall: null }),
    lab: lab({ score: 22 }),
  });

  assert.ok(firedIds(p).includes("speed.lab.score"));
});

test("hasUsableFieldVitals reflects exactly that distinction", () => {
  assert.equal(hasUsableFieldVitals(field()), true);
  assert.equal(hasUsableFieldVitals(field({ inp: null, cls: null })), true, "one vital is enough");
  assert.equal(hasUsableFieldVitals(field({ lcp: null, inp: null, cls: null })), false);
  assert.equal(hasUsableFieldVitals(field({ status: "absent" })), false);
  assert.equal(hasUsableFieldVitals(field({ status: "error" })), false);
});

// ===========================================================================
// 12-16. Nothing unmeasured may become a speed finding
// ===========================================================================

test("every unavailable performance state produces zero findings", () => {
  const states: Array<[string, PerformanceData]> = [
    ["pending", unavailable("pending", null, "Performance analysis is running separately.")],
    ["not-requested", unavailable("not-requested", null, "Speed was not measured.")],
    ["no-api-key", unavailable("no-api-key", "no-api-key", "No PageSpeed API key is configured.")],
    ["timeout", unavailable("error", "timeout", "Google's speed test did not finish in the time allowed.")],
    ["api-error", unavailable("error", "api-error", "Google returned an error (500).")],
    ["network", unavailable("error", "network", "Google could not be reached.")],
    ["internal-error", unavailable("error", "internal-error", "The speed check failed unexpectedly.")],
  ];

  for (const [label, p] of states) {
    const { findings, skipped } = run(p);
    assert.deepEqual(findings, [], `${label} must produce no finding`);
    assert.equal(skipped.length, 7, `${label} should skip all seven rules`);
  }
});

test("a timeout never says the site is slow", () => {
  const p = unavailable("error", "timeout", "Google's speed test did not finish in the time allowed.");
  const { findings, skipped } = run(p);

  assert.deepEqual(findings, []);
  for (const entry of skipped) {
    assert.ok(!/slow/i.test(entry.reason), `a skip reason must not call the site slow: ${entry.reason}`);
  }
});

test("field absent produces no field finding at all", () => {
  const p = noFieldData(95); // good lab score, so the fallback stays quiet too
  const { findings, skipped } = run(p);

  assert.deepEqual(findings, []);
  for (const metric of ["lcp", "inp", "cls"]) {
    assert.ok(skipped.some((s) => s.ruleId === `speed.field.${metric}.slow`));
  }
  assert.match(
    skipped.find((s) => s.ruleId === "speed.field.lcp.slow")?.reason ?? "",
    /too few recent visits/,
  );
});

test("skipped speed checks never appear among the findings", () => {
  const scenarios = [
    performance(),
    noFieldData(30),
    unavailable("pending"),
    unavailable("error", "timeout"),
    performance({ field: field({ lcp: { percentileMs: 5000, category: "SLOW" } }) }),
  ];

  for (const p of scenarios) {
    const { findings, skipped } = run(p);
    const ids = new Set(findings.map((f) => f.id));
    assert.ok(!skipped.some((s) => ids.has(s.ruleId)));
  }
});

// ===========================================================================
// Determinism and completeness
// ===========================================================================

test("rule order does not change the result", () => {
  const p = performance({
    field: field({
      lcp: { percentileMs: 5200, category: "SLOW" },
      inp: { percentileMs: 400, category: "AVERAGE" },
    }),
  });

  const forward = runRules(facts(p), SPEED_RULES);
  const reversed = runRules(facts(p), [...SPEED_RULES].reverse());

  assert.deepEqual(forward.findings, reversed.findings);
  assert.equal(forward.findings[0].severity, "high", "worst first");
});

test("the same measurements always produce the same grades", () => {
  const p = performance({ field: field({ cls: { percentile: 0.4, category: "SLOW" } }) });

  assert.deepEqual(runRules(facts(p), SPEED_RULES), runRules(facts(p), SPEED_RULES));
});

test("every speed finding carries id, category, severity, evidence and remediation", () => {
  const p = performance({
    field: field({
      lcp: { percentileMs: 5200, category: "SLOW" },
      inp: { percentileMs: 400, category: "AVERAGE" },
      cls: { percentile: 0.4, category: "SLOW" },
    }),
  });

  const { findings } = run(p);
  assert.equal(findings.length, 3);
  for (const finding of findings) {
    assert.equal(finding.category, "speed");
    assert.ok(finding.id.length > 0);
    assert.ok(finding.title.length > 0);
    assert.ok(finding.evidence.length > 0);
    assert.ok(finding.remediation.length > 0);
  }
});

test("no rule compares against a numeric Core Web Vital threshold of ours", () => {
  // Google's thresholds move. The only number this file may branch on is the
  // lab score band, which is Google's own published 0-49 red band.
  const text = fs.readFileSync(new URL("./speed.ts", import.meta.url), "utf8");

  for (const googleThreshold of ["2500", "4000", "200", "500", "0.1", "0.25"]) {
    assert.ok(
      !text.includes(googleThreshold),
      `speed.ts must not hardcode Google's threshold ${googleThreshold}`,
    );
  }
});
