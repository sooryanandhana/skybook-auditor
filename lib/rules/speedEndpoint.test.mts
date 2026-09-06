/**
 * Tests for what the performance endpoint returns.
 *
 * The endpoint is the only place that holds the speed measurements, so it is
 * the only place that can grade them. These prove the grading happens there —
 * server-side, by the shared rules engine — and that the browser is handed
 * findings rather than the means to produce one.
 *
 * The route itself is a thin Next handler; what is exercised here is the
 * grading step it performs, with the same inputs and the same rule set.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { SPEED_RULES } from "./all.ts";
import { performanceRoute } from "../api/auditRoutes.ts";
import { resetRateLimits } from "../rateLimit.ts";
import type { Finding, PerformanceData, SkippedCheck } from "../types.ts";

/**
 * Drives THE ACTUAL ENDPOINT, with the measurement handed to it.
 *
 * This used to be a copy of the route's grading step, written alongside it.
 * A copy is worse than no test: it agrees with itself while the route it was
 * modelled on drifts away, and it reports success either way. Only the slow
 * external call is stubbed; everything the endpoint decides is its own.
 */
async function gradeAsEndpoint(performance: PerformanceData): Promise<{
  ok: true;
  data: PerformanceData;
  findings: Finding[];
  skippedChecks: SkippedCheck[];
}> {
  resetRateLimits();

  const result = await performanceRoute(
    new Request("https://audit.test/api/audit/performance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }),
    { measure: async () => performance },
  );

  assert.equal(result.status, 200);
  assert.ok(result.body.ok, "the endpoint answered with a result");
  return result.body as { ok: true; data: PerformanceData; findings: Finding[]; skippedChecks: SkippedCheck[] };
}

function performance(overrides: Partial<PerformanceData> = {}): PerformanceData {
  return {
    status: "checked",
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: null,
    field: {
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
    },
    lab: {
      status: "found",
      measuredUrl: "https://example.com/",
      score: 95,
      lcpMs: 800,
      fcpMs: 700,
      tbtMs: 0,
      speedIndexMs: 800,
      cls: 0.01,
      error: null,
    },
    notInspected: [],
    message: "Checked.",
    ...overrides,
  };
}

test("a successful measurement returns data, findings and skippedChecks", async () => {
  const response = await gradeAsEndpoint(performance());

  assert.equal(response.ok, true);
  assert.ok(response.data, "the measurements are still returned");
  assert.ok(Array.isArray(response.findings));
  assert.ok(Array.isArray(response.skippedChecks));
});

test("a slow field metric produces a finding in the response", async () => {
  const slow = performance({
    field: { ...performance().field, lcp: { percentileMs: 5200, category: "SLOW" } },
  });

  const response = await gradeAsEndpoint(slow);
  const finding = response.findings.find((f) => f.id === "speed.field.lcp.slow");

  assert.ok(finding, "the endpoint must return the graded finding");
  assert.equal(finding.severity, "high");
  assert.equal(finding.category, "speed");
  assert.ok(finding.evidence.length > 0);
  assert.ok(finding.remediation.length > 0);
});

test("fast field metrics produce no findings", async () => {
  const response = await gradeAsEndpoint(performance());

  assert.deepEqual(response.findings, []);
  // The measurements still come back — a clean result is not an empty one.
  assert.equal(response.data.field.status, "found");
  assert.equal(response.data.lab.score, 95);
});

test("a failed measurement yields skipped checks, never a slow verdict", async () => {
  const message = "Speed was not measured: Google's speed test did not finish in the time allowed.";
  const timedOut = performance({
    status: "error",
    failureReason: "timeout",
    message,
    field: { ...performance().field, status: "error", lcp: null, inp: null, cls: null, error: message },
    lab: { ...performance().lab, status: "error", score: null, error: message },
  });

  const response = await gradeAsEndpoint(timedOut);

  assert.deepEqual(response.findings, [], "a timeout is not a speed problem");
  assert.equal(response.skippedChecks.length, 7);
  for (const entry of response.skippedChecks) {
    assert.ok(!/slow/i.test(entry.reason));
  }
});

test("the lab fallback reaches the response only when field data is unavailable", async () => {
  const noField = performance({
    field: {
      ...performance().field,
      status: "absent",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
    },
    lab: { ...performance().lab, score: 28 },
  });

  const fallback = await gradeAsEndpoint(noField);
  assert.ok(fallback.findings.some((f) => f.id === "speed.lab.score"));

  // The same poor score, with real-visitor data present: no finding.
  const withField = await gradeAsEndpoint(performance({ lab: { ...performance().lab, score: 28 } }));
  assert.ok(!withField.findings.some((f) => f.id === "speed.lab.score"));
});

test("findings and skippedChecks never overlap in the response", async () => {
  const scenarios = [
    performance(),
    performance({ field: { ...performance().field, lcp: { percentileMs: 5200, category: "SLOW" } } }),
    performance({ status: "pending", message: "Running separately." }),
  ];

  for (const p of scenarios) {
    const response = await gradeAsEndpoint(p);
    const ids = new Set(response.findings.map((f) => f.id));
    assert.ok(!response.skippedChecks.some((s) => ids.has(s.ruleId)));
  }
});

test("every severity in the response came from a rule, not the route", async () => {
  // The route builds no severity of its own; it copies what runRules produced.
  const slow = performance({
    field: {
      ...performance().field,
      lcp: { percentileMs: 5200, category: "SLOW" },
      inp: { percentileMs: 400, category: "AVERAGE" },
    },
  });

  const response = await gradeAsEndpoint(slow);
  for (const finding of response.findings) {
    const rule = SPEED_RULES.find((r) => r.id === finding.id);
    assert.ok(rule, `${finding.id} must correspond to a declared rule`);
    assert.equal(finding.severity, rule.severity, "severity must be the rule's own constant");
  }
});

test("the route grades only the speed rules", async () => {
  // Its request holds the speed measurements and nothing else. Running the
  // audit rules here would need SEO and certificate facts it does not have.
  for (const rule of SPEED_RULES) {
    assert.ok(rule.id.startsWith("speed."));
  }
  assert.equal(SPEED_RULES.length, 7);
});
