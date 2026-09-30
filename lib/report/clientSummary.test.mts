/**
 * The five-section client summary: what is AI-written, what is derived, and the
 * guarantee that a failed model still leaves a useful section behind.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { Finding } from "../types.ts";
import { buildClientAiSummary, type FindingCommentary } from "./clientSummary.ts";

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "severity" | "category">): Finding => ({
  title: `Title for ${over.id}`,
  evidence: "measured evidence",
  remediation: "measured remediation",
  ...over,
});

const note = (over: Partial<FindingCommentary> = {}): FindingCommentary => ({
  explanation: "What it means, in plain words.",
  businessImpact: "Why it matters to the business.",
  recommendation: "The suggested next step.",
  ...over,
});

test("a full answer becomes five sections drawn from the right sources", () => {
  const findings: Finding[] = [
    finding({ id: "security.spf.missing", severity: "high", category: "security", title: "No SPF record" }),
    finding({ id: "seo.meta.missing", severity: "medium", category: "seo", title: "No meta description" }),
    finding({ id: "seo.title.ok", severity: "good", category: "seo", title: "Title present" }),
  ];
  const commentary = new Map<string, FindingCommentary>([
    ["security.spf.missing", note({ recommendation: "Publish an SPF record." })],
    ["seo.meta.missing", note({ recommendation: "Write a description." })],
  ]);

  const s = buildClientAiSummary(findings, commentary, "This site has two issues worth attention.");

  assert.equal(s.overallSummary, "This site has two issues worth attention.");

  // What we checked: derived from categories present (security, seo), in order,
  // and NOT from the AI.
  assert.equal(s.whatWeChecked.length, 2);
  assert.match(s.whatWeChecked[0], /^Security/);
  assert.match(s.whatWeChecked[1], /^Search visibility/);

  // Key findings: AI prose, only problems, worst first (high before medium).
  assert.equal(s.keyFindings.length, 2);
  assert.equal(s.keyFindings[0].finding, "No SPF record");
  assert.equal(s.keyFindings[0].explanation, "What it means, in plain words.");
  assert.equal(s.keyFindings[0].impact, "Why it matters to the business.");
  assert.equal(s.keyFindings[1].finding, "No meta description");

  // Recommendations: action from the AI's suggested step, reason from impact.
  assert.equal(s.recommendations[0].action, "Publish an SPF record.");
  assert.equal(s.recommendations[0].reason, "Why it matters to the business.");

  // Next steps: derived, severity-ordered, and the good finding is not a step.
  assert.equal(s.nextSteps.length, 2);
  assert.match(s.nextSteps[0], /critical|high-priority/);
  assert.ok(s.nextSteps[0].includes("No SPF record"));
  assert.ok(s.nextSteps.every((step) => !step.includes("Title present")));
});

test("severity decides the order, not the input order", () => {
  const findings: Finding[] = [
    finding({ id: "b.medium", severity: "medium", category: "technical" }),
    finding({ id: "a.critical", severity: "critical", category: "security" }),
    finding({ id: "c.high", severity: "high", category: "seo" }),
  ];
  const commentary = new Map<string, FindingCommentary>([
    ["b.medium", note()],
    ["a.critical", note()],
    ["c.high", note()],
  ]);

  const s = buildClientAiSummary(findings, commentary, "Summary.");

  assert.deepEqual(
    s.keyFindings.map((k) => k.finding),
    ["Title for a.critical", "Title for c.high", "Title for b.medium"],
  );
  assert.match(s.nextSteps[0], /critical/);
});

test("when the AI failed, derived sections still stand", () => {
  const findings: Finding[] = [
    finding({ id: "security.spf.missing", severity: "high", category: "security", title: "No SPF record" }),
    finding({ id: "seo.meta.missing", severity: "medium", category: "seo", title: "No meta description" }),
  ];

  // No commentary, no overall summary — the fallback path.
  const s = buildClientAiSummary(findings, new Map(), null);

  assert.equal(s.overallSummary, null);
  assert.equal(s.keyFindings.length, 0);
  assert.equal(s.recommendations.length, 0);
  // But the deterministic sections are still there and useful.
  assert.equal(s.whatWeChecked.length, 2);
  assert.equal(s.nextSteps.length, 2);
  assert.ok(s.nextSteps[0].includes("No SPF record"));
});

test("a blank overall summary is treated as none", () => {
  const s = buildClientAiSummary([], new Map(), "   ");
  assert.equal(s.overallSummary, null);
});

test("commentary for a rule that is not a finding is ignored", () => {
  const findings: Finding[] = [finding({ id: "seo.meta.missing", severity: "medium", category: "seo" })];
  const commentary = new Map<string, FindingCommentary>([
    ["seo.meta.missing", note()],
    ["a.rule.that.never.fired", note({ explanation: "should never appear" })],
  ]);

  const s = buildClientAiSummary(findings, commentary, "Summary.");

  assert.equal(s.keyFindings.length, 1);
  assert.ok(!JSON.stringify(s).includes("should never appear"));
});

test("an all-good audit still checks areas and gives a calm next step", () => {
  const findings: Finding[] = [
    finding({ id: "security.ok", severity: "good", category: "security" }),
    finding({ id: "technical.ok", severity: "good", category: "technical" }),
  ];

  const s = buildClientAiSummary(findings, new Map(), "Everything looks healthy.");

  assert.equal(s.keyFindings.length, 0);
  assert.equal(s.recommendations.length, 0);
  assert.equal(s.whatWeChecked.length, 2);
  assert.equal(s.nextSteps.length, 1);
  assert.match(s.nextSteps[0], /No priority issues/);
});

test("no more than five next steps are handed over at once", () => {
  const findings: Finding[] = Array.from({ length: 8 }, (_v, i) =>
    finding({ id: `seo.rule.${i}`, severity: "medium", category: "seo" }),
  );
  const s = buildClientAiSummary(findings, new Map(), null);
  assert.equal(s.nextSteps.length, 5);
});
