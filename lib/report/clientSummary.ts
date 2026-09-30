/**
 * The client-facing AI summary, as five plain-English sections.
 *
 * WHY THIS MODULE EXISTS. The dashboard and the PDF both need to present the
 * same summary in the same five parts -- Overall Summary, What We Checked, Key
 * Findings, Recommended Improvements and Next Steps -- and 7A §5 settled that
 * shared shape belongs in the report layer rather than being built twice, once
 * per surface, where the two would drift.
 *
 * WHAT IS AI-WRITTEN AND WHAT IS DERIVED, and the line matters. The overall
 * summary, the key findings and the recommendations are the model's own prose,
 * already validated and anchored to real findings by rule id -- this module only
 * reshapes them, it invents nothing. "What we checked" and "Next steps" are
 * DERIVED here from the measured findings: the categories that were actually
 * assessed, and the problems ordered by the severity the rules set. Those two
 * lists therefore cannot hallucinate, because no model writes them -- the
 * deterministic audit remains the single source of truth for both.
 *
 * NOTHING IS MEASURED, GRADED OR COUNTED HERE. Severity, category and title are
 * read from findings the rules produced; this file orders and labels them and
 * decides nothing about the audit.
 */
import type { Category, Finding, Severity } from "../types.ts";
import { categoryLabel } from "./measurementsView.ts";

/** One finding, put into plain words. Every field is AI prose about a real finding. */
export interface ClientKeyFinding {
  /** The finding's own measured title. */
  readonly finding: string;
  /** What it means, from the validated AI explanation. */
  readonly explanation: string;
  /** Why it matters, from the validated AI explanation. */
  readonly impact: string;
}

/** One recommendation, drawn from a real finding's validated AI commentary. */
export interface ClientRecommendation {
  /** What to do, from the AI's suggested next step. */
  readonly action: string;
  /** Why, from the AI's account of why the finding matters. */
  readonly reason: string;
}

/** The five sections a reader sees, on either surface. */
export interface ClientAiSummary {
  /** The AI's opening paragraph, or null when no usable AI answer was produced. */
  readonly overallSummary: string | null;
  /** Plain-language description of each area assessed. Derived, never AI. */
  readonly whatWeChecked: readonly string[];
  /** The important findings in plain words. AI prose, anchored to real findings. */
  readonly keyFindings: readonly ClientKeyFinding[];
  /** Practical improvements, each tied to a real finding. AI prose. */
  readonly recommendations: readonly ClientRecommendation[];
  /** A prioritised plan, ordered by severity. Derived, never AI. */
  readonly nextSteps: readonly string[];
}

/**
 * The validated AI commentary for one finding, keyed elsewhere by rule id.
 *
 * PROVIDER-NEUTRAL AND ALREADY CHECKED. This is the slice of a validated
 * `AIExplanation` this module reads; it never sees, and cannot introduce, a
 * severity, a count or a number the audit did not measure.
 */
export interface FindingCommentary {
  readonly explanation: string;
  readonly businessImpact: string;
  readonly recommendation: string;
}

/**
 * The plain-English description of each area, keyed by the rule category.
 *
 * FIXED TEXT, WRITTEN BY THIS PROJECT. It says what an area covers in a
 * sentence a non-technical reader can follow; it makes no claim about a
 * particular website and reads the same for every audit.
 */
const CATEGORY_BLURB: Record<Category, string> = {
  security:
    "Security — certificates, DNS records and the protections that keep the site and its visitors safe.",
  seo: "Search visibility — the titles, descriptions and page structure that decide how the site appears in search results.",
  technical:
    "Technical setup — sitemaps, robots rules, redirects and the plumbing that lets search engines and browsers use the site.",
  speed: "Performance — how quickly pages load and respond for real visitors.",
};

/** The order areas are listed in, stable across audits. */
const CATEGORY_ORDER: readonly Category[] = ["security", "seo", "technical", "speed"];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, good: 3 };

/** The severity word used in a derived next step. "good" is a pass, never a step. */
const SEVERITY_WORD: Record<Exclude<Severity, "good">, string> = {
  critical: "critical",
  high: "high-priority",
  medium: "medium-priority",
};

/** How many prioritised steps a client is given at once. Enough to act on, not a backlog. */
const MAX_NEXT_STEPS = 5;

/** A problem is any finding the rules did not grade "good". Passes are not problems. */
function isProblem(finding: Finding): boolean {
  return finding.severity !== "good";
}

/** Findings the rules graded as problems, worst first, ties broken by id for stability. */
function problemsWorstFirst(findings: readonly Finding[]): Finding[] {
  return findings
    .filter(isProblem)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));
}

/**
 * The five-section client summary for one audit.
 *
 * READS FINDINGS AND VALIDATED COMMENTARY, WRITES NEITHER. `findings` are the
 * rules' own output; `commentary` is the validated AI answer keyed by rule id
 * (a finding's rule id is its `id`); `overallSummary` is the AI's opening
 * paragraph, or null when no usable answer was produced.
 *
 * WHEN THE AI FAILED, the summary is not empty: `overallSummary` is null and the
 * AI-written lists are empty, but "What we checked" and "Next steps" are still
 * derived from the measured findings, so the section stays useful.
 */
export function buildClientAiSummary(
  findings: readonly Finding[],
  commentary: ReadonlyMap<string, FindingCommentary>,
  overallSummary: string | null,
): ClientAiSummary {
  // What we checked: the areas actually represented in this audit, in a fixed
  // order, each described in plain words. Derived from measured categories.
  const present = new Set(findings.map((finding) => finding.category));
  const whatWeChecked = CATEGORY_ORDER.filter((category) => present.has(category)).map(
    (category) => CATEGORY_BLURB[category],
  );

  const ordered = problemsWorstFirst(findings);

  // Key findings and recommendations: the model's validated prose about real
  // problems, in severity order. A problem with no commentary (the AI failed or
  // dropped it) simply contributes nothing here; its evidence still stands in
  // the findings section.
  const keyFindings: ClientKeyFinding[] = [];
  const recommendations: ClientRecommendation[] = [];
  for (const finding of ordered) {
    const note = commentary.get(finding.id);
    if (note === undefined) continue;
    keyFindings.push({ finding: finding.title, explanation: note.explanation, impact: note.businessImpact });
    recommendations.push({ action: note.recommendation, reason: note.businessImpact });
  }

  // Next steps: a prioritised plan derived straight from severity. Always
  // available, because it needs no model.
  const nextSteps =
    ordered.length === 0
      ? ["No priority issues were found. Keep the site monitored and re-run the audit periodically."]
      : ordered
          .slice(0, MAX_NEXT_STEPS)
          .map(
            (finding) =>
              `Resolve the ${SEVERITY_WORD[finding.severity as Exclude<Severity, "good">]} issue: ${finding.title}.`,
          );

  return {
    overallSummary: overallSummary === null || overallSummary.trim() === "" ? null : overallSummary,
    whatWeChecked,
    keyFindings,
    recommendations,
    nextSteps,
  };
}
