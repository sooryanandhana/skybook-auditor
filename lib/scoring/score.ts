// The .ts extensions are required so Node can run the unit tests directly;
// Next.js resolves them the same way.
import { AUDIT_RULES, PAGE_RULES, SITE_RULES, SPEED_RULES } from "../rules/all.ts";
import type { AuditResult, Category, Finding, Severity, SkippedCheck } from "../types.ts";

/**
 * The audit's SCORE — code measures and scores, an AI only ever explains.
 *
 * WHAT THIS LAYER IS AND IS NOT. It reads a finished, verified audit result and
 * turns it into one deterministic number and grade. It measures nothing, fetches
 * nothing, and — this is the point — reads NOTHING a model wrote. Its only inputs
 * are the rules' own findings, the checks that could not run, and the ledger of
 * which rules ran, all of which our own code produced. Claude explains the score
 * afterwards; it can no more move it than it can move a severity.
 *
 * THREE OUTCOMES PER RULE, AND A SKIPPED CHECK IS NOT ONE OF THEM.
 *
 *   fired    the rule ran and found a problem     -> counts against the score
 *   passed   the rule ran and the site was fine   -> counts toward the score
 *   skipped  the rule could not run at all        -> EXCLUDED, neither way
 *
 * A skipped check is the audit's own gap, not the site's fault and not a pass.
 * It lowers COVERAGE — how much we could assess — and never the score.
 *
 * SCORED ONCE PER RULE, NEVER ONCE PER PAGE. A page-scoped rule that fired on a
 * hundred pages is one check that failed, weighted once. If it fired ANYWHERE it
 * is a failure, with no partial credit for the pages it passed — a real problem
 * on some pages is a real problem.
 *
 * HOW A RULE'S OUTCOME IS READ.
 *   - Fired: it produced a problem finding.
 *   - A crawl page rule: the aggregator's `ran` ledger says it ran on at least
 *     one page. Ran and did not fire ⇒ it passed there, even if it was also
 *     skipped on some other page — the ledger is what stops a mostly-passing
 *     rule reading as entirely skipped. (Where no ledger is present, the reading
 *     falls back to the conservative one: absent-and-skipped ⇒ skipped.)
 *   - A site rule runs once. When the ledger records site rules (a real audit
 *     always does), the ledger is authoritative: present ⇒ it ran and, not having
 *     fired, passed; ABSENT ⇒ it never ran and reads as skipped, NEVER as a
 *     silent pass. A rule the scorer expects but that no part of the pipeline
 *     accounted for can no longer slip through as a pass. Only where the ledger
 *     does not cover site rules (a legacy result, or one with no ledger at all)
 *     does the older reading apply: a "good" finding or a quiet run means passed,
 *     the skipped list means skipped.
 *   - A speed rule runs once via a separate request and carries no ledger, so it
 *     keeps that same reading: a "good" finding or a quiet run means passed, the
 *     skipped list means skipped.
 *
 * TWO WEIGHTINGS, DELIBERATELY SEPARATE.
 *   - WITHIN a category, rules are weighted by the stakes they carry: a passing
 *     critical check is worth ten passing mediums.
 *   - ACROSS categories, the overall is a weighted mean of the category grades
 *     using fixed PRODUCT weights — what the four pillars are worth to a client —
 *     not the accident of how many rules each happens to hold. Security has
 *     twelve rules and Technical one; raw rule counts would let that decide the
 *     headline, which is why it does not.
 */

/** A letter grade. Nothing finer: a false-precision decimal helps no one. */
export type Grade = "A" | "B" | "C" | "D" | "F";

/**
 * How much each severity of failure is worth to the weighted pass rate WITHIN a
 * category. A rule carries the stakes of the problem it looks for.
 */
export const SEVERITY_WEIGHT: Record<"critical" | "high" | "medium", number> = {
  critical: 10,
  high: 5,
  medium: 2,
};

/**
 * What each of the four pillars is worth to the overall grade.
 *
 * A PRODUCT DECISION, not a rule count. When a category was not assessed its
 * weight is dropped and the rest are renormalised, so a missing speed check
 * neither penalises the site nor lets the other three quietly change balance
 * against each other.
 */
export const CATEGORY_WEIGHT: Record<Category, number> = {
  security: 0.4,
  seo: 0.25,
  speed: 0.25,
  technical: 0.1,
};

/** Grade bands over the weighted pass rate. */
export const GRADE_BANDS: ReadonlyArray<{ min: number; grade: Grade }> = [
  { min: 90, grade: "A" },
  { min: 75, grade: "B" },
  { min: 60, grade: "C" },
  { min: 40, grade: "D" },
  { min: 0, grade: "F" },
];

/**
 * The fewest rules that must have run before a headline grade is honest — unless
 * a serious finding already fired, which is itself an honest verdict whatever
 * the coverage. Below both, an audit assessed too little to grade, and a high
 * number off two checks would mislead: the grade is withheld, the breakdown is
 * still reported.
 */
export const MIN_RULES_TO_GRADE = 5;

const GRADE_ORDER: Grade[] = ["F", "D", "C", "B", "A"];

/** One category's score, or a plain statement that it was not assessed. */
export type CategoryScore =
  | {
      status: "not-assessed";
      /** No rule in this category ran, so there is nothing to grade. */
      ranCount: 0;
      skippedCount: number;
    }
  | {
      status: "assessed";
      grade: Grade;
      /** Weighted percentage of assessed checks that passed, 0–100. */
      passRate: number;
      /** Fraction of this category's rules that could be assessed, 0–1. */
      coverage: number;
      ranCount: number;
      passedCount: number;
      firedCount: number;
      skippedCount: number;
      /** How many rules fired at each gating severity, for transparency. */
      firedCritical: number;
      firedHigh: number;
    };

/** The whole audit's score. */
export interface ScoreResult {
  /**
   * Whether a headline grade could honestly be given.
   *
   *   graded          enough ran to grade, or a serious finding fired
   *   insufficient    something ran, but too little to grade honestly
   *   not-assessable  nothing could be assessed at all
   */
  status: "graded" | "insufficient" | "not-assessable";
  /** The overall grade, or null when it is withheld. */
  grade: Grade | null;
  /** The overall weighted pass rate 0–100, or null when the grade is withheld. */
  passRate: number | null;
  /** Fraction of all applicable rules that could be assessed, 0–1. */
  coverage: number;
  /**
   * True when the audit did not see the whole site — a crawl stopped at a limit,
   * or a page that could not be read at all. The grade is over what was seen.
   */
  partial: boolean;
  /**
   * The rule ids of the findings that capped the grade, when the severity gate
   * applied. Empty when nothing gated it.
   */
  gatedBy: string[];
  ranCount: number;
  passedCount: number;
  firedCount: number;
  skippedCount: number;
  categories: Record<Category, CategoryScore>;
}

// ---------------------------------------------------------------------------
// The classification of one rule's outcome
// ---------------------------------------------------------------------------

type RuleOutcomeKind = "fired" | "passed" | "skipped";

interface Classified {
  category: Category;
  severity: "critical" | "high" | "medium";
  kind: RuleOutcomeKind;
}

/** The facts about a result the classifier reads, gathered once. */
interface Ledger {
  firedIds: ReadonlySet<string>;
  passedIds: ReadonlySet<string>;
  skippedIds: ReadonlySet<string>;
  /**
   * Every rule id known to have RUN — page rules that ran on at least one page,
   * and the site rules that ran once — or null when no ledger was recorded.
   */
  ranIds: ReadonlySet<string> | null;
  pageRuleIds: ReadonlySet<string>;
  siteRuleIds: ReadonlySet<string>;
  /**
   * True when the ledger demonstrably covers site rules — at least one site rule
   * appears in it. Only then is a site rule's ABSENCE from the ledger meaningful
   * ("it did not run"); a page-only or legacy ledger never mentioned site rules,
   * so their absence there says nothing and the older reading must stand.
   */
  hasSiteLedger: boolean;
}

function classify(rule: { id: string; severity: "critical" | "high" | "medium"; category: Category }, l: Ledger): Classified {
  const base = { category: rule.category, severity: rule.severity };

  if (l.firedIds.has(rule.id)) return { ...base, kind: "fired" };

  if (l.pageRuleIds.has(rule.id) && l.ranIds !== null) {
    // A crawl page rule, with the ledger to read it precisely. Running on any
    // page without firing is a pass there — even if it was skipped elsewhere.
    if (l.ranIds.has(rule.id)) return { ...base, kind: "passed" };
    return { ...base, kind: "skipped" };
  }

  if (l.siteRuleIds.has(rule.id) && l.hasSiteLedger) {
    // A site rule, with a ledger that covers site rules — so the ledger decides.
    // It ran once: present ⇒ it ran and, not having fired above, passed. ABSENT
    // ⇒ it never ran, which reads as SKIPPED and never as a silent pass. This is
    // the defensive guarantee: a site rule the scorer expects but that nothing in
    // the pipeline actually accounted for cannot slip through as a pass.
    if (l.ranIds!.has(rule.id)) return { ...base, kind: "passed" };
    return { ...base, kind: "skipped" };
  }

  // A site rule with no site-covering ledger (legacy/absent), a speed rule (its
  // request carries no ledger), or a page rule with no ledger to consult. Read
  // from what the rule actually said.
  if (l.passedIds.has(rule.id)) return { ...base, kind: "passed" };
  if (l.skippedIds.has(rule.id)) return { ...base, kind: "skipped" };
  // Neither a finding nor a skipped check: it ran and passed with nothing to say.
  return { ...base, kind: "passed" };
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/**
 * Scores a finished audit. Pure and deterministic: the same result scores the
 * same way every time, and nothing outside the measured findings, the checks
 * that could not run, and which rules ran is ever read.
 */
export function scoreAudit(result: AuditResult): ScoreResult {
  const findings = result.site.findings;
  const skipped = result.site.skippedChecks;

  const speedRuleIds = new Set(SPEED_RULES.map((r) => r.id));
  const speedAssessed =
    findings.some((f) => f.category === "speed") ||
    skipped.some((s) => speedRuleIds.has(s.ruleId));

  const ranIds = result.site.ranRules ? new Set(result.site.ranRules) : null;
  const ledger: Ledger = {
    firedIds: new Set(findings.filter((f: Finding) => f.severity !== "good").map((f) => f.id)),
    passedIds: new Set(findings.filter((f: Finding) => f.severity === "good").map((f) => f.id)),
    skippedIds: new Set(skipped.map((s: SkippedCheck) => s.ruleId)),
    ranIds,
    pageRuleIds: new Set(PAGE_RULES.map((r) => r.id)),
    siteRuleIds: new Set(SITE_RULES.map((r) => r.id)),
    // A page-only or legacy ledger never lists a site rule; the presence of even
    // one proves this ledger accounts for site rules, so their absence is real.
    hasSiteLedger: ranIds !== null && SITE_RULES.some((r) => ranIds.has(r.id)),
  };

  const expected = [...AUDIT_RULES, ...(speedAssessed ? SPEED_RULES : [])];
  const classified = expected.map((rule) => classify(rule, ledger));

  const categories = {
    security: tallyCategory(classified, "security"),
    seo: tallyCategory(classified, "seo"),
    speed: tallyCategory(classified, "speed"),
    technical: tallyCategory(classified, "technical"),
  } satisfies Record<Category, CategoryScore>;

  const ran = classified.filter((c) => c.kind !== "skipped");
  const passed = ran.filter((c) => c.kind === "passed");
  const fired = ran.filter((c) => c.kind === "fired");

  // The overall is a weighted mean of the assessed category grades, using the
  // product weights, renormalised over what was assessed.
  const assessed = (Object.entries(categories) as [Category, CategoryScore][]).filter(
    ([, cat]) => cat.status === "assessed",
  );
  const weightSum = assessed.reduce((total, [name]) => total + CATEGORY_WEIGHT[name], 0);
  const overallPassRate =
    weightSum > 0
      ? Math.round(
          assessed.reduce(
            (total, [name, cat]) =>
              cat.status === "assessed"
                ? total + (CATEGORY_WEIGHT[name] / weightSum) * cat.passRate
                : total,
            0,
          ),
        )
      : 0;

  const firedCritical = fired.filter((c) => c.severity === "critical").length;
  const firedHigh = fired.filter((c) => c.severity === "high").length;
  const gatedBy = gateWhat(findings, firedCritical, firedHigh);

  const base = {
    coverage: expected.length > 0 ? ran.length / expected.length : 0,
    partial: isPartial(result),
    ranCount: ran.length,
    passedCount: passed.length,
    firedCount: fired.length,
    skippedCount: classified.length - ran.length,
    categories,
  };

  if (ran.length === 0) {
    return { status: "not-assessable", grade: null, passRate: null, gatedBy: [], ...base };
  }
  // A grade is honest when enough ran, OR when a serious finding fired — which is
  // itself a verdict whatever the coverage. Otherwise too little was seen.
  const hasGatingFinding = firedCritical > 0 || firedHigh > 0;
  if (ran.length < MIN_RULES_TO_GRADE && !hasGatingFinding) {
    return { status: "insufficient", grade: null, passRate: null, gatedBy: [], ...base };
  }

  return {
    status: "graded",
    grade: cap(bandOf(overallPassRate), firedCritical, firedHigh),
    passRate: overallPassRate,
    gatedBy,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tallyCategory(classified: Classified[], category: Category): CategoryScore {
  const inCategory = classified.filter((c) => c.category === category);
  const ran = inCategory.filter((c) => c.kind !== "skipped");
  const passed = ran.filter((c) => c.kind === "passed");
  const fired = ran.filter((c) => c.kind === "fired");
  const skippedCount = inCategory.length - ran.length;

  if (ran.length === 0) {
    return { status: "not-assessed", ranCount: 0, skippedCount };
  }

  const ranWeight = sumWeight(ran);
  const passRate = ranWeight > 0 ? Math.round((sumWeight(passed) / ranWeight) * 100) : 0;
  const firedCritical = fired.filter((c) => c.severity === "critical").length;
  const firedHigh = fired.filter((c) => c.severity === "high").length;

  return {
    status: "assessed",
    grade: cap(bandOf(passRate), firedCritical, firedHigh),
    passRate,
    coverage: inCategory.length > 0 ? ran.length / inCategory.length : 0,
    ranCount: ran.length,
    passedCount: passed.length,
    firedCount: fired.length,
    skippedCount,
    firedCritical,
    firedHigh,
  };
}

function sumWeight(rules: Classified[]): number {
  return rules.reduce((total, r) => total + SEVERITY_WEIGHT[r.severity], 0);
}

function bandOf(passRate: number): Grade {
  for (const band of GRADE_BANDS) {
    if (passRate >= band.min) return band.grade;
  }
  return "F";
}

/**
 * Caps a grade by the failures present.
 *
 * A critical means the site is visibly broken or actively unsafe, so it forces
 * the bottom grade whatever the pass rate — a padlock warning is not offset by
 * twenty passing checks. A single high, a real exposure with no warning shown,
 * caps the grade at B: one fixable exposure should not make a strong site read
 * as mediocre. Two or more highs cap it at C. A medium alone does not cap; the
 * pass rate already carries it.
 */
function cap(grade: Grade, firedCritical: number, firedHigh: number): Grade {
  if (firedCritical > 0) return "F";
  if (firedHigh >= 2) return lowerOf(grade, "C");
  if (firedHigh === 1) return lowerOf(grade, "B");
  return grade;
}

function lowerOf(a: Grade, b: Grade): Grade {
  return GRADE_ORDER.indexOf(a) <= GRADE_ORDER.indexOf(b) ? a : b;
}

/** The ids of the findings that actually capped the grade, or none. */
function gateWhat(findings: readonly Finding[], firedCritical: number, firedHigh: number): string[] {
  if (firedCritical > 0) return firedFindingIdsAt(findings, "critical");
  if (firedHigh > 0) return firedFindingIdsAt(findings, "high");
  return [];
}

function firedFindingIdsAt(findings: readonly Finding[], severity: Severity): string[] {
  return findings
    .filter((f) => f.severity === severity)
    .map((f) => f.id)
    .sort();
}

/**
 * Whether the audit saw less than the whole site.
 *
 * A certificate-failure audit read no page at all, so it is always partial; any
 * other audit is partial when the crawl did not finish covering the site.
 */
function isPartial(result: AuditResult): boolean {
  if ("kind" in result && result.kind === "certificate-failure") return true;
  return !result.crawl.complete;
}
