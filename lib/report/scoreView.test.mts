/**
 * Tests for the score's presentation layer.
 *
 * These prove the wording, the ordering and the lookups — never a grade. Every
 * fixture is a `ScoreResult` handed in whole, exactly as `scoreAudit` would have
 * produced it, so nothing here can be caught inventing a number the score did
 * not already carry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCORE_CATEGORY_ORDER,
  SCORE_INSUFFICIENT_MESSAGE,
  SCORE_NOT_ASSESSABLE_MESSAGE,
  coveragePercent,
  gateReasons,
  gradeBandLabel,
  isGradeCapped,
  scoreStatusMessage,
} from "./scoreView.ts";
import type { ScoreResult } from "../scoring/score.ts";
import type { Finding } from "../types.ts";

function finding(id: string, severity: Finding["severity"]): Finding {
  return { id, title: `Title for ${id}`, category: "security", severity, evidence: "e", remediation: "r" };
}

function score(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    status: "graded",
    grade: "A",
    passRate: 95,
    coverage: 1,
    partial: false,
    gatedBy: [],
    ranCount: 20,
    passedCount: 20,
    firedCount: 0,
    skippedCount: 0,
    categories: {
      security: { status: "not-assessed", ranCount: 0, skippedCount: 0 },
      seo: { status: "not-assessed", ranCount: 0, skippedCount: 0 },
      speed: { status: "not-assessed", ranCount: 0, skippedCount: 0 },
      technical: { status: "not-assessed", ranCount: 0, skippedCount: 0 },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Grade band labels
// ---------------------------------------------------------------------------

test("each grade reads as the agreed word", () => {
  assert.equal(gradeBandLabel("A"), "Strong");
  assert.equal(gradeBandLabel("B"), "Good");
  assert.equal(gradeBandLabel("C"), "Fair");
  assert.equal(gradeBandLabel("D"), "Weak");
  assert.equal(gradeBandLabel("F"), "At Risk");
});

// ---------------------------------------------------------------------------
// Coverage formatting
// ---------------------------------------------------------------------------

test("coverage is shown as a whole percentage", () => {
  assert.equal(coveragePercent(1), 100);
  assert.equal(coveragePercent(0), 0);
  assert.equal(coveragePercent(0.8), 80);
  // Rounded, never a trailing-decimal tile.
  assert.equal(coveragePercent(0.666), 67);
  assert.equal(coveragePercent(0.833), 83);
});

// ---------------------------------------------------------------------------
// Category order
// ---------------------------------------------------------------------------

test("the four pillars are ordered security, seo, speed, technical", () => {
  assert.deepEqual([...SCORE_CATEGORY_ORDER], ["security", "seo", "speed", "technical"]);
});

// ---------------------------------------------------------------------------
// Status messages
// ---------------------------------------------------------------------------

test("a graded audit has no withheld-grade message", () => {
  assert.equal(scoreStatusMessage(score({ status: "graded" })), null);
});

test("an insufficient audit says the grade was withheld, not that the site is bad", () => {
  const message = scoreStatusMessage(score({ status: "insufficient", grade: null, passRate: null }));
  assert.equal(message, SCORE_INSUFFICIENT_MESSAGE);
});

test("a not-assessable audit says nothing could be assessed", () => {
  const message = scoreStatusMessage(
    score({ status: "not-assessable", grade: null, passRate: null }),
  );
  assert.equal(message, SCORE_NOT_ASSESSABLE_MESSAGE);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("gateReasons names each capping finding by its own title", () => {
  const findings = [
    finding("security.https", "critical"),
    finding("security.headers.hsts", "medium"),
  ];
  const reasons = gateReasons(score({ gatedBy: ["security.https"] }), findings);
  assert.deepEqual(reasons, [{ id: "security.https", title: "Title for security.https" }]);
});

test("a gate id with no matching finding falls back to the id, never a blank", () => {
  const reasons = gateReasons(score({ gatedBy: ["security.gone"] }), []);
  assert.deepEqual(reasons, [{ id: "security.gone", title: "security.gone" }]);
});

test("no gate means no reasons and an uncapped grade", () => {
  assert.deepEqual(gateReasons(score({ gatedBy: [] }), []), []);
  assert.equal(isGradeCapped(score({ gatedBy: [] })), false);
});

test("a populated gate reads as capped", () => {
  assert.equal(isGradeCapped(score({ gatedBy: ["security.https"] })), true);
});

// ---------------------------------------------------------------------------
// It never recomputes the score
// ---------------------------------------------------------------------------

test("the helpers read the score's own numbers and change none of them", () => {
  // A deliberately self-contradictory score: a 10% pass rate carrying grade A.
  // A layer that recomputed anything would 'correct' one of these; a layer that
  // only formats shows exactly what it was handed.
  const s = score({ grade: "A", passRate: 10, coverage: 0.5 });
  assert.equal(gradeBandLabel(s.grade!), "Strong");
  assert.equal(coveragePercent(s.coverage), 50);
  assert.equal(s.passRate, 10);
});
