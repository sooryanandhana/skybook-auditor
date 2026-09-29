/**
 * Turning the deterministic score into words and rows a person can read.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT. Every function here READS a
 * `ScoreResult` that `scoreAudit` already produced and formats it for the
 * screen. It computes no grade, averages no category, and re-derives no number:
 * `result.score` is the single source of truth, and this layer only chooses the
 * words to show it in. The one arithmetic it does is turning a 0–1 fraction into
 * a percentage for display — the same formatting the score itself already did to
 * its pass rate — and never a judgement.
 *
 * WHY IT LIVES HERE RATHER THAN IN THE COMPONENT. Same reason as
 * `measurementsView` and `siteFindingsView`: each sentence is a statement a
 * client reads, so each is worth a test, and this project has no React testing
 * stack. The dashboard component stays a thin renderer over these decisions.
 *
 * NOTHING HERE IS A MEASUREMENT OR A GRADE. A model cannot reach this file, and
 * this file cannot reach a model. It sits between the score and the screen.
 */
import type { Grade, ScoreResult } from "../scoring/score.ts";
import type { Category, Finding } from "../types.ts";

/**
 * The four pillars in the order the dashboard shows them.
 *
 * A PRODUCT ORDER, not a rule count and not the score's internal one: what a
 * client reads first. It mirrors the weight each carries to the overall grade,
 * so the tile that matters most sits first. `scoreAudit` keys its categories by
 * the same names, so this only decides left-to-right.
 */
export const SCORE_CATEGORY_ORDER: readonly Category[] = [
  "security",
  "seo",
  "speed",
  "technical",
];

/**
 * A letter grade in one plain word.
 *
 * PRESENTATION ONLY. The letter is the score's; this is the word a reader hears
 * it as. Kept as a total map over the five grades so a missing case is a compile
 * error rather than a blank chip.
 */
const GRADE_BAND_LABELS: Record<Grade, string> = {
  A: "Strong",
  B: "Good",
  C: "Fair",
  D: "Weak",
  F: "At Risk",
};

export function gradeBandLabel(grade: Grade): string {
  return GRADE_BAND_LABELS[grade];
}

/**
 * A 0–1 coverage fraction as a whole percentage, for display.
 *
 * FORMATTING, NOT SCORING. The score already decided the fraction; turning it
 * into "80%" is the same step the score itself took to word its pass rate as a
 * number out of a hundred. Rounded so a tile never reads "79.9999%".
 */
export function coveragePercent(coverage: number): number {
  return Math.round(coverage * 100);
}

// ---------------------------------------------------------------------------
// The overall verdict, in a sentence
// ---------------------------------------------------------------------------

/** Shown when something ran, but too little to grade honestly. */
export const SCORE_INSUFFICIENT_MESSAGE =
  "Too few checks could run to give an overall grade. The category breakdown below reports what was assessed.";

/** Shown when nothing at all could be assessed. */
export const SCORE_NOT_ASSESSABLE_MESSAGE =
  "This audit could not assess enough of the site to grade it.";

/**
 * A caveat carried beside a grade that was taken over less than the whole site.
 *
 * Said in words rather than left to the reader to infer from a partial-crawl
 * banner elsewhere: the grade is real, and it is a grade of what was seen.
 */
export const SCORE_PARTIAL_NOTE =
  "This grade covers the pages that were assessed. Some of the site was not seen.";

/**
 * The one sentence that explains a withheld grade, or null when one was given.
 *
 * READS THE STATUS THE SCORE SET. It never decides whether to grade — that
 * decision is the score's, made from coverage and the findings, and this only
 * says which sentence goes with the answer it already reached.
 */
export function scoreStatusMessage(score: ScoreResult): string | null {
  switch (score.status) {
    case "graded":
      return null;
    case "insufficient":
      return SCORE_INSUFFICIENT_MESSAGE;
    case "not-assessable":
      return SCORE_NOT_ASSESSABLE_MESSAGE;
  }
}

// ---------------------------------------------------------------------------
// What capped the grade
// ---------------------------------------------------------------------------

/** Above the list of findings that held the grade down. */
export const GATE_HEADING = "What's holding the grade back";

/**
 * The sentence that keeps the pass rate and the grade honest when they differ.
 *
 * A site can pass ninety per cent of its checks and still grade F, because one
 * unresolved critical is not offset by twenty things done right. When that
 * happens the reader sees both numbers and this line, so the gap reads as a
 * deliberate verdict rather than a contradiction.
 */
export const GATE_NOTE =
  "These issues cap the overall grade regardless of how many other checks passed. Fixing them is what lifts it.";

/** One finding that capped the grade: the score's rule id, and its own title. */
export interface GateReason {
  id: string;
  title: string;
}

/**
 * The findings that capped the grade, named for a reader.
 *
 * `score.gatedBy` carries the rule ids the score itself chose — the criticals
 * if any fired, otherwise the highs. This only looks each id's title up in the
 * findings already on the page; it reads no severity and picks no id of its own.
 * An id with no matching finding falls back to the id, which is ugly but true.
 */
export function gateReasons(
  score: ScoreResult,
  findings: readonly Finding[],
): GateReason[] {
  const titleById = new Map(findings.map((finding) => [finding.id, finding.title]));
  return score.gatedBy.map((id) => ({ id, title: titleById.get(id) ?? id }));
}

/** Whether a gate held the overall grade below its pass rate. */
export function isGradeCapped(score: ScoreResult): boolean {
  return score.gatedBy.length > 0;
}
