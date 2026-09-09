/**
 * The words that label AI-written text, wherever it is shown.
 *
 * WHY THIS MODULE EXISTS. These labels lived inside the results page, which is
 * a client component and unreachable from server code. The PDF needs the same
 * words, and 7A §5 settled what to do about that: shared wording moves into
 * the report layer rather than being copied, because two copies of a sentence
 * about a client's website drift, and the browser report and the PDF would
 * then disagree about the same audit. This is that move; the wording is
 * unchanged.
 *
 * WHAT THE LABELS ARE FOR, and it is not decoration. 7A §9 requires AI text to
 * be labelled as AI-written and to sit visually subordinate to the measured
 * content. The reader has to be able to tell, without being told twice, which
 * parts of the document were measured and which were written about the
 * measurements. Every label here exists to carry that distinction in words, so
 * it does not rest on styling that a greyscale printer might flatten.
 */

/** The heading above the whole-audit summary. */
export const AI_SUMMARY_HEADING = "AI summary";

/**
 * What the summary is, and what it is not.
 *
 * 7A §9 requires this sentence beside the executive summary. It is the one
 * place the document states the boundary outright: the model wrote the prose,
 * and every finding, severity and number came from the tool.
 */
export const AI_PROVENANCE =
  "Written by AI from the findings below. The findings, their severities " +
  "and every number in this report were measured by this tool.";

/** The label above a single finding's commentary. */
export const AI_EXPLANATION_LABEL = "AI explanation";

/** The two sub-labels under it, in the order the contract lists them. */
export const AI_IMPACT_LABEL = "Why it matters";
export const AI_RECOMMENDATION_LABEL = "Suggested next step";

/**
 * What to say when the validator dropped some of the model's answer.
 *
 * A PARTIAL ANSWER IS SAID OUT LOUD. 7A §9 requires it stated honestly rather
 * than hidden: a reader who counts the findings and counts the explanations
 * should find the difference already accounted for. Nothing is invented to
 * fill the gap, and a finding without commentary is still a complete finding,
 * because its evidence and remediation were ours all along.
 *
 * Null when nothing was dropped, so a caller shows no sentence rather than one
 * saying zero.
 */
export function rejectedNote(count: number): string | null {
  if (count <= 0) return null;

  return count === 1
    ? "1 explanation was not usable and was left out."
    : `${count} explanations were not usable and were left out.`;
}
