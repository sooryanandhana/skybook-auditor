/**
 * Tests for attaching the score to a delivered audit.
 *
 * The score must be part of the official result, computed from the crawl and
 * the speed check together, deterministically, and from measured facts alone.
 * These tests prove the wiring holds all of that: they never call the scorer's
 * internals, only assert that the result a caller receives already carries the
 * grade the scorer would give the whole audit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { withScore } from "./withScore.ts";
import { withSpeed } from "./withSpeed.ts";
import { scoreAudit } from "../scoring/score.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { resultAnswer } from "../jobs/jobResponses.ts";
import { PAGE_RULES, SPEED_RULES } from "../rules/all.ts";
import type {
  AuditResult,
  CertificateFailureAudit,
  Finding,
  PerformanceData,
  SiteAuditResult,
  SpeedResult,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — real enough for withSpeed and scoreAudit to read
// ---------------------------------------------------------------------------

function finding(id: string, severity: Finding["severity"], category: Finding["category"]): Finding {
  return { id, title: id, category, severity, evidence: "measured", remediation: "fix it" };
}

function siteAudit(over: {
  findings?: Finding[];
  ran?: readonly string[];
  complete?: boolean;
} = {}): SiteAuditResult {
  return {
    data: { findings: [], skippedChecks: [] },
    site: {
      findings: over.findings ?? [],
      skippedChecks: [],
      ranRules: over.ran ?? PAGE_RULES.map((r) => r.id),
      evaluatedPages: 1,
    },
    pages: [],
    crawl: { complete: over.complete ?? true },
  } as unknown as SiteAuditResult;
}

function certFailure(findings: Finding[]): CertificateFailureAudit {
  return {
    kind: "certificate-failure",
    site: { findings, skippedChecks: [], ranRules: [], evaluatedPages: 0 },
    crawl: { complete: false, evaluated: 0 },
  } as unknown as CertificateFailureAudit;
}

function speedResult(findings: Finding[]): SpeedResult {
  return {
    data: { requestedUrl: "https://example.com/" } as unknown as PerformanceData,
    findings,
    skippedChecks: [],
  };
}

// ---------------------------------------------------------------------------
// withScore composes withSpeed + scoreAudit and attaches the result
// ---------------------------------------------------------------------------

test("withScore attaches the score the whole-audit scorer would give", () => {
  const result = siteAudit({ findings: [finding("security.https", "critical", "security")] });
  const speed = null;

  const scored = withScore(result, speed);
  assert.ok(scored.score, "the score is attached");
  assert.deepEqual(scored.score, scoreAudit(withSpeed(result, speed)));
  assert.equal(scored.score!.grade, "F", "an unresolved critical grades F");
});

test("the speed check is folded into the score when it was measured", () => {
  const speedRule = SPEED_RULES[0];
  const result = siteAudit({});
  const withoutSpeed = withScore(result, null);
  const withSpeedMeasured = withScore(result, speedResult([finding(speedRule.id, speedRule.severity, "speed")]));

  assert.equal(withoutSpeed.score!.categories.speed.status, "not-assessed");
  assert.equal(withSpeedMeasured.score!.categories.speed.status, "assessed");
});

test("a null speed check leaves Speed Not Assessed and does not penalise", () => {
  const scored = withScore(siteAudit({}), null);
  assert.equal(scored.score!.categories.speed.status, "not-assessed");
  assert.equal(scored.score!.grade, "A");
});

test("a certificate-failure audit is scored on the checks it could run, not merged with speed", () => {
  const result = certFailure([finding("security.ssl.expired", "critical", "security")]);
  const scored = withScore(result, speedResult([]));

  assert.ok(scored.score);
  assert.deepEqual(scored.score, scoreAudit(result), "cert failure is scored directly, no withSpeed");
  assert.equal(scored.score!.grade, "F");
  assert.equal(scored.score!.partial, true);
});

// ---------------------------------------------------------------------------
// It never damages the result it scores
// ---------------------------------------------------------------------------

test("the delivered findings are left exactly as the crawl produced them", () => {
  const result = siteAudit({ findings: [finding("security.headers.hsts", "medium", "security")] });
  const speed = speedResult([finding(SPEED_RULES[0].id, SPEED_RULES[0].severity, "speed")]);

  const scored = withScore(result, speed) as SiteAuditResult;
  // The score saw the speed check, but the delivered list is unchanged: the
  // speed findings were not merged into it.
  assert.deepEqual(scored.site.findings, result.site.findings);
  assert.equal(scored.site.findings.length, 1);
});

test("withScore does not mutate the result it is given", () => {
  const result = siteAudit({ findings: [finding("security.https", "critical", "security")] });
  const before = JSON.stringify(result);
  withScore(result, null);
  assert.equal(JSON.stringify(result), before, "the stored result is untouched");
  assert.equal("score" in result, false);
});

test("the score is deterministic — same result and speed, same score", () => {
  const build = () => withScore(siteAudit({ findings: [finding("security.https", "critical", "security")] }), null);
  assert.deepEqual(build().score, build().score);
});

// ---------------------------------------------------------------------------
// The score reaches the delivered result through the result endpoint
// ---------------------------------------------------------------------------

test("the finished result, as the result endpoint answers it, carries the score", () => {
  const store = createJobStore<AuditResult, SpeedResult>();
  const job = store.create("https://example.com/");
  const result = siteAudit({ findings: [finding("security.mixed-content", "high", "security")] });
  store.finish(job.id, "completed", result);

  const answer = resultAnswer(job.id, store.get(job.id));
  assert.equal(answer.body.ok, true);
  if (!answer.body.ok) return;

  assert.ok(answer.body.result.score, "the official result carries a score");
  // Exactly the score for the whole audit that was in the store at answer time.
  assert.deepEqual(answer.body.result.score, scoreAudit(withSpeed(result, null)));
  assert.equal(answer.body.result.score!.grade, "B", "one High caps at B");
});

test("once the speed check is attached, the delivered score includes it", () => {
  const store = createJobStore<AuditResult, SpeedResult>();
  const job = store.create("https://example.com/");
  const result = siteAudit({});
  store.finish(job.id, "completed", result);

  const before = resultAnswer(job.id, store.get(job.id));
  assert.ok(before.body.ok && before.body.result.score!.categories.speed.status === "not-assessed");

  store.attach(job.id, speedResult([finding(SPEED_RULES[0].id, SPEED_RULES[0].severity, "speed")]));

  const after = resultAnswer(job.id, store.get(job.id));
  assert.ok(after.body.ok && after.body.result.score!.categories.speed.status === "assessed");
});

test("the AI commentary is not an input to the score", () => {
  const store = createJobStore<AuditResult, SpeedResult, { grade: string }>();
  const job = store.create("https://example.com/");
  const result = siteAudit({ findings: [finding("security.https", "critical", "security")] });
  store.finish(job.id, "completed", result);

  const withoutExplanation = resultAnswer(job.id, store.get(job.id));
  // A commentary slot exists on the job and can be written; the score must not
  // change when it is. (The explanation slot is the third store slot.)
  store.setExplanation(job.id, { grade: "A" });
  const withExplanation = resultAnswer(job.id, store.get(job.id));

  assert.ok(withoutExplanation.body.ok && withExplanation.body.ok);
  if (!withoutExplanation.body.ok || !withExplanation.body.ok) return;
  assert.deepEqual(withExplanation.body.result.score, withoutExplanation.body.result.score);
  assert.equal(withExplanation.body.result.score!.grade, "F", "the AI 'grade: A' changed nothing");
});
