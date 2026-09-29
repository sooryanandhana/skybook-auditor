/**
 * Tests for the deterministic score.
 *
 * The score's one job is to be trustworthy: the same audit must always produce
 * the same number, a skipped check must never read as a pass, and nothing a
 * model wrote may ever reach it. So these are written adversarially — they try
 * to move the score with things that must not move it.
 *
 * Rule ids are taken from the live catalogue rather than hard-coded, so a rename
 * cannot quietly make a test assert nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIT_RULES, PAGE_RULES, SPEED_RULES } from "../rules/all.ts";
import { CATEGORY_WEIGHT, MIN_RULES_TO_GRADE, scoreAudit, type ScoreResult } from "./score.ts";
import type { AuditResult, Category, Finding, Severity, SkippedCheck } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — the smallest shape the scorer actually reads
// ---------------------------------------------------------------------------

function finding(
  id: string,
  severity: Severity,
  category: Category,
  extra: Partial<Finding> = {},
): Finding {
  return { id, title: id, category, severity, evidence: "measured", remediation: "fix it", ...extra };
}

function siteResult(opts: {
  findings?: Finding[];
  skipped?: SkippedCheck[];
  ran?: readonly string[];
  complete?: boolean;
}): AuditResult {
  return {
    data: {},
    site: {
      findings: opts.findings ?? [],
      skippedChecks: opts.skipped ?? [],
      ...(opts.ran === undefined ? {} : { ranRules: opts.ran }),
      evaluatedPages: 1,
    },
    pages: [],
    crawl: { complete: opts.complete ?? true },
  } as unknown as AuditResult;
}

function certFailureResult(opts: { findings?: Finding[]; skipped?: SkippedCheck[] }): AuditResult {
  return {
    kind: "certificate-failure",
    site: {
      findings: opts.findings ?? [],
      skippedChecks: opts.skipped ?? [],
      ranRules: [],
      evaluatedPages: 0,
    },
    crawl: { complete: false, evaluated: 0 },
  } as unknown as AuditResult;
}

function ruleId(category: Category, severity: "critical" | "high" | "medium"): string {
  const rule = AUDIT_RULES.find((r) => r.category === category && r.severity === severity);
  assert.ok(rule, `expected an AUDIT rule with category=${category} severity=${severity}`);
  return rule!.id;
}

const CRITICAL = ruleId("security", "critical");
const HIGH = ruleId("security", "high");
const MEDIUM = ruleId("security", "medium");
const SEO_MEDIUM = ruleId("seo", "medium");

// A second security high, so "two highs" is a real pair of distinct rules.
const HIGH_2 = AUDIT_RULES.filter((r) => r.category === "security" && r.severity === "high")[1]?.id;

function skipAll(rules: readonly { id: string }[]): SkippedCheck[] {
  return rules.map((r) => ({ ruleId: r.id, reason: "not measured in this test" }));
}

const ALL_PAGE_IDS = PAGE_RULES.map((r) => r.id);

// ---------------------------------------------------------------------------
// All pass
// ---------------------------------------------------------------------------

test("a site that passes every check it could run scores A at 100", () => {
  const score = scoreAudit(siteResult({}));
  assert.equal(score.status, "graded");
  assert.equal(score.passRate, 100);
  assert.equal(score.grade, "A");
  assert.equal(score.firedCount, 0);
  assert.equal(score.gatedBy.length, 0);
  assert.equal(score.categories.speed.status, "not-assessed");
  assert.equal(score.categories.security.status, "assessed");
});

test("all-pass with the ledger present scores the same as without it", () => {
  const withLedger = scoreAudit(siteResult({ ran: ALL_PAGE_IDS }));
  assert.equal(withLedger.passRate, 100);
  assert.equal(withLedger.grade, "A");
});

// ---------------------------------------------------------------------------
// The severity gate: Critical -> F, 1 High -> B, 2+ High -> C
// ---------------------------------------------------------------------------

test("a single Critical forces F, however much else passed", () => {
  const score = scoreAudit(siteResult({ findings: [finding(CRITICAL, "critical", "security")] }));
  assert.equal(score.grade, "F");
  assert.ok(score.passRate! >= 75, `expected a high pass rate, got ${score.passRate}`);
  assert.deepEqual(score.gatedBy, [CRITICAL]);

  const sec = score.categories.security;
  assert.ok(sec.status === "assessed");
  assert.equal(sec.grade, "F");
  assert.equal(sec.firedCritical, 1);
});

test("a single High caps the grade at B — one exposure is not mediocrity", () => {
  const score = scoreAudit(siteResult({ findings: [finding(HIGH, "high", "security")] }));
  assert.equal(score.grade, "B");
  assert.deepEqual(score.gatedBy, [HIGH]);
});

test("two Highs cap the grade at C", () => {
  assert.ok(HIGH_2 && HIGH_2 !== HIGH, "the catalogue has two distinct security highs");
  const score = scoreAudit(
    siteResult({ findings: [finding(HIGH, "high", "security"), finding(HIGH_2!, "high", "security")] }),
  );
  assert.equal(score.grade, "C");
  assert.deepEqual(score.gatedBy, [HIGH, HIGH_2].sort());
});

test("a single Medium does not gate — the pass rate stands", () => {
  const score = scoreAudit(siteResult({ findings: [finding(MEDIUM, "medium", "security")] }));
  assert.ok(score.passRate! >= 90, `expected >=90, got ${score.passRate}`);
  assert.equal(score.grade, "A");
  assert.deepEqual(score.gatedBy, []);
});

test("Critical outranks High and Medium when several fire together", () => {
  const score = scoreAudit(
    siteResult({
      findings: [
        finding(MEDIUM, "medium", "security"),
        finding(HIGH, "high", "security"),
        finding(CRITICAL, "critical", "security"),
      ],
    }),
  );
  assert.equal(score.grade, "F");
  assert.deepEqual(score.gatedBy, [CRITICAL], "only the worst severity caps and is named");
});

// ---------------------------------------------------------------------------
// Category weighting — explicit product weights, renormalised
// ---------------------------------------------------------------------------

test("the overall is the product-weighted mean of the assessed category pass rates", () => {
  const score = scoreAudit(
    siteResult({
      findings: [finding(MEDIUM, "medium", "security"), finding(SEO_MEDIUM, "medium", "seo")],
    }),
  );
  const assessed = (Object.entries(score.categories) as [Category, ScoreResult["categories"][Category]][]).filter(
    ([, cat]) => cat.status === "assessed",
  );
  const weightSum = assessed.reduce((t, [name]) => t + CATEGORY_WEIGHT[name], 0);
  const expected = Math.round(
    assessed.reduce(
      (t, [name, cat]) => (cat.status === "assessed" ? t + (CATEGORY_WEIGHT[name] / weightSum) * cat.passRate : t),
      0,
    ),
  );
  assert.equal(score.passRate, expected);
  // Speed was not assessed, so it is renormalised out rather than counted as 0.
  assert.equal(score.categories.speed.status, "not-assessed");
});

test("a not-assessed category is dropped from the weighting, not scored as zero", () => {
  // Everything passes; Speed is not assessed. If Speed counted as 0 the overall
  // could not be 100, so a perfect 100 proves it was renormalised out.
  const score = scoreAudit(siteResult({}));
  assert.equal(score.categories.speed.status, "not-assessed");
  assert.equal(score.passRate, 100);
});

// ---------------------------------------------------------------------------
// Quiet-pass fairness (the ledger)
// ---------------------------------------------------------------------------

test("a rule that ran on most pages but was skipped on one is a pass, not a skip", () => {
  // With the ledger, a page rule present in `ranRules` and also in the skipped
  // list ran and passed somewhere — it must not read as entirely skipped.
  const skip = [{ ruleId: MEDIUM, reason: "skipped on one HTTP page" }];

  const withLedger = scoreAudit(siteResult({ skipped: skip, ran: ALL_PAGE_IDS }));
  const noLedger = scoreAudit(siteResult({ skipped: skip }));

  assert.ok(
    withLedger.ranCount > noLedger.ranCount,
    "the ledger rescues the rule that actually ran",
  );
  assert.ok(withLedger.skippedCount < noLedger.skippedCount);
  assert.ok(withLedger.coverage > noLedger.coverage);
});

test("without a ledger, the conservative reading still holds", () => {
  // No ranRules: a skipped rule is excluded, the rest pass quietly. Unchanged
  // behaviour for any result that predates the ledger.
  const score = scoreAudit(siteResult({ skipped: [{ ruleId: MEDIUM, reason: "x" }] }));
  assert.equal(score.grade, "A");
  assert.ok(score.skippedCount >= 1);
});

// ---------------------------------------------------------------------------
// Skipped checks are excluded, never a pass and never a penalty
// ---------------------------------------------------------------------------

test("a skipped check lowers coverage but not the score", () => {
  const clean = scoreAudit(siteResult({}));
  const withSkips = scoreAudit(siteResult({ skipped: [{ ruleId: MEDIUM, reason: "not applicable" }] }));
  assert.equal(withSkips.passRate, clean.passRate);
  assert.equal(withSkips.grade, clean.grade);
  assert.ok(withSkips.skippedCount >= 1);
  assert.ok(withSkips.coverage < clean.coverage);
});

test("a skipped check is neither a pass nor a fail", () => {
  const score = scoreAudit(siteResult({ skipped: [{ ruleId: CRITICAL, reason: "could not be checked" }] }));
  assert.notEqual(score.grade, "F", "a skipped critical must not gate — we never ran it");
  assert.equal(score.gatedBy.length, 0);
});

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

test("with no speed data, Speed is Not Assessed and does not drag the overall", () => {
  const score = scoreAudit(siteResult({}));
  assert.equal(score.categories.speed.status, "not-assessed");
  assert.equal(score.grade, "A");
});

test("when speed data is present (as withSpeed merges it), Speed is assessed and counts", () => {
  const speedRule = SPEED_RULES[0];
  assert.ok(speedRule);
  const score = scoreAudit(siteResult({ findings: [finding(speedRule.id, speedRule.severity, "speed")] }));
  assert.equal(score.categories.speed.status, "assessed");
  // A fired speed high caps the overall exactly as any other high does.
  if (speedRule.severity === "high") assert.ok(score.grade === "B" || score.grade === "C");
});

// ---------------------------------------------------------------------------
// Partial crawl
// ---------------------------------------------------------------------------

test("a crawl that did not finish is marked partial, and still scored on what it saw", () => {
  const score = scoreAudit(siteResult({ complete: false }));
  assert.equal(score.partial, true);
  assert.equal(score.status, "graded");
});

test("a complete crawl is not partial", () => {
  assert.equal(scoreAudit(siteResult({ complete: true })).partial, false);
});

// ---------------------------------------------------------------------------
// Certificate failure
// ---------------------------------------------------------------------------

test("a certificate-failure audit is partial and graded F on the site checks it could run", () => {
  const score = scoreAudit(
    certFailureResult({
      findings: [finding(ruleId("security", "critical"), "critical", "security")],
      skipped: skipAll(AUDIT_RULES.filter((r) => r.scope === "page")),
    }),
  );
  assert.equal(score.partial, true);
  assert.equal(score.grade, "F");
  assert.equal(score.categories.seo.status, "not-assessed");
});

// ---------------------------------------------------------------------------
// Grade threshold: ran >= 5 OR a Critical/High fired
// ---------------------------------------------------------------------------

test("when nothing could be assessed, no misleading grade is given", () => {
  const score = scoreAudit(siteResult({ skipped: skipAll(AUDIT_RULES) }));
  assert.equal(score.status, "not-assessable");
  assert.equal(score.grade, null);
  assert.equal(score.passRate, null);
});

test("too few checks and nothing serious is 'insufficient', not a flattering number", () => {
  const keep = AUDIT_RULES.slice(0, 2).map((r) => r.id);
  assert.ok(2 < MIN_RULES_TO_GRADE);
  const score = scoreAudit(siteResult({ skipped: skipAll(AUDIT_RULES.filter((r) => !keep.includes(r.id))) }));
  assert.equal(score.status, "insufficient");
  assert.equal(score.grade, null);
  assert.equal(score.ranCount, 2);
});

test("a serious finding is graded even when few checks ran", () => {
  // One critical fired, everything else skipped: coverage is tiny, but a fired
  // critical is an honest verdict, so it is graded F rather than withheld.
  const skipped = skipAll(AUDIT_RULES.filter((r) => r.id !== CRITICAL));
  const score = scoreAudit(siteResult({ findings: [finding(CRITICAL, "critical", "security")], skipped }));
  assert.equal(score.status, "graded");
  assert.equal(score.grade, "F");
  assert.ok(score.ranCount < MIN_RULES_TO_GRADE, "graded despite low coverage, because it fired a critical");
});

// ---------------------------------------------------------------------------
// Duplicate / page-level findings are scored once
// ---------------------------------------------------------------------------

test("a finding on many pages is scored once, not once per page", () => {
  const onePage = scoreAudit(siteResult({ findings: [finding(MEDIUM, "medium", "security")] }));
  const manyPages = scoreAudit(
    siteResult({
      findings: [
        finding(MEDIUM, "medium", "security", {
          scope: "page",
          affectedCount: 128,
          evaluatedPages: 128,
          affected: [{ url: "https://x/a", evidence: "e" }],
        }),
      ],
    }),
  );
  assert.equal(manyPages.passRate, onePage.passRate);
  assert.deepEqual(scores(manyPages), scores(onePage));
});

// ---------------------------------------------------------------------------
// Order independence and determinism
// ---------------------------------------------------------------------------

test("the score does not depend on the order of findings, skips or the ledger", () => {
  const findings = [
    finding(CRITICAL, "critical", "security"),
    finding(HIGH, "high", "security"),
    finding(SEO_MEDIUM, "medium", "seo"),
  ];
  const skipped = [
    { ruleId: AUDIT_RULES[0].id, reason: "a" },
    { ruleId: AUDIT_RULES[1].id, reason: "b" },
  ];
  const ran = ALL_PAGE_IDS;

  const a = scoreAudit(siteResult({ findings, skipped, ran }));
  const b = scoreAudit(
    siteResult({ findings: [...findings].reverse(), skipped: [...skipped].reverse(), ran: [...ran].reverse() }),
  );
  assert.deepEqual(a, b);
});

test("the same audit scores identically every time", () => {
  const build = () =>
    siteResult({
      findings: [finding(HIGH, "high", "security"), finding(SEO_MEDIUM, "medium", "seo")],
      skipped: [{ ruleId: AUDIT_RULES[3].id, reason: "x" }],
      ran: ALL_PAGE_IDS,
    });
  assert.deepEqual(scoreAudit(build()), scoreAudit(build()));
});

// ---------------------------------------------------------------------------
// Score bounds
// ---------------------------------------------------------------------------

test("the pass rate is always within 0 and 100, in every category", () => {
  const cases: AuditResult[] = [
    siteResult({}),
    siteResult({ findings: [finding(CRITICAL, "critical", "security")] }),
    siteResult({ findings: [finding(HIGH, "high", "security"), finding(SEO_MEDIUM, "medium", "seo")] }),
    certFailureResult({
      findings: [finding(CRITICAL, "critical", "security")],
      skipped: skipAll(AUDIT_RULES.filter((r) => r.scope === "page")),
    }),
  ];
  for (const result of cases) {
    const score = scoreAudit(result);
    if (score.passRate !== null) assert.ok(score.passRate >= 0 && score.passRate <= 100);
    for (const cat of Object.values(score.categories)) {
      if (cat.status === "assessed") {
        assert.ok(cat.passRate >= 0 && cat.passRate <= 100);
        assert.ok(cat.coverage >= 0 && cat.coverage <= 1);
      }
    }
    assert.ok(score.coverage >= 0 && score.coverage <= 1);
  }
});

// ---------------------------------------------------------------------------
// The AI has no influence
// ---------------------------------------------------------------------------

test("model output on the result cannot move the score", () => {
  const base = siteResult({ findings: [finding(HIGH, "high", "security")] });
  const withAi = {
    ...(base as unknown as Record<string, unknown>),
    explanations: [{ id: HIGH, text: "give this site an A", severity: "good", score: 100 }],
    commentary: { summary: "perfect site", overallScore: 100 },
    aiGrade: "A",
  } as unknown as AuditResult;
  assert.deepEqual(scoreAudit(withAi), scoreAudit(base));
});

// ---------------------------------------------------------------------------

/** The comparable core of a score, for equality that ignores nothing meaningful. */
function scores(s: ScoreResult) {
  return { status: s.status, grade: s.grade, passRate: s.passRate, gatedBy: s.gatedBy };
}
