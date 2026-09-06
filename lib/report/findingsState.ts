/**
 * What the findings section should say, given what the rules produced.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT: four states have to be told apart, and
 * getting one wrong means telling a client something untrue about their site.
 * That is worth a test, and testing it inside JSX would mean a React test
 * stack this project does not have and does not need. So the decision lives
 * here as a plain function and the component renders its answer.
 *
 * Phase 6's PDF will need exactly the same four states, and will use this too.
 *
 * THE STATE THAT CAUSED THIS FILE
 *
 * The section used to say "nothing has been graded yet" whenever there were no
 * findings. Once the security rules started running that became false: an
 * audit with no findings has usually been graded thoroughly and come back
 * clean. Worse, it collapsed three different situations into one sentence —
 * we have not built the rules, we ran them and found nothing, and we ran them
 * but could not check everything. Only the third of those needs the client to
 * do anything.
 */

export type FindingsState =
  /** Problems found, and every check ran. */
  | "findings"
  /** Problems found, and some checks could not run. */
  | "findings-with-skipped"
  /** Nothing found, and every check ran. The genuinely clean result. */
  | "clean"
  /** Nothing found, but some checks could not run — so "clean" would overstate it. */
  | "clean-with-skipped";

export function findingsState(findingCount: number, skippedCount: number): FindingsState {
  if (findingCount > 0) {
    return skippedCount > 0 ? "findings-with-skipped" : "findings";
  }
  return skippedCount > 0 ? "clean-with-skipped" : "clean";
}

/**
 * The sentence shown above the list.
 *
 * Empty for the two states where the findings speak for themselves — a list of
 * problems does not need a sentence introducing it.
 */
export function findingsSummary(state: FindingsState): string {
  switch (state) {
    case "clean":
      return "No issues found by the checks that were run.";
    case "clean-with-skipped":
      return "No issues were found by the checks that completed, but some checks could not be evaluated.";
    case "findings-with-skipped":
    case "findings":
      return "";
  }
}

/** Whether the skipped-checks panel should be shown at all. */
export function showsSkippedPanel(state: FindingsState): boolean {
  return state === "clean-with-skipped" || state === "findings-with-skipped";
}

/**
 * The heading for that panel.
 *
 * Deliberately flat. These are not warnings and not failures, and a heading
 * like "Problems checking" would make them read as both.
 */
export const SKIPPED_HEADING = "Checks not evaluated";

/** The one line of context above the skipped list. */
export const SKIPPED_INTRO =
  "These checks did not run, so nothing is claimed about them either way.";
