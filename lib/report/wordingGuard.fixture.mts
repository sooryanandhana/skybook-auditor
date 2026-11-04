/**
 * The wording guard shared by the report-text tests.
 *
 * Wording that turns a possibility into a verdict about the client's site, or
 * promises a result. Each was chosen because a report must never say it.
 */
export const CERTAINTY_PHRASES: readonly RegExp[] = [
  /\bguarantee/i,
  /\bhas been (hacked|compromised|attacked|breached)/i,
  /\bpenali[sz]/i,
  /\blost (rankings|traffic|customers|sales)/i,
  /\bwill (lose|rank|be hacked|be penali[sz]ed|increase|improve|fail)/i,
  /\b(definitely|certainly|always will|proves?)\b/i,
];

/**
 * Approved sentences that DENY one of the phrases above, and so must not be
 * mistaken for asserting it. Matched exactly: a new sentence that happens to
 * use the same words still goes through the guard.
 */
const APPROVED_DENIALS: readonly string[] = [
  "A missing safeguard does not mean a site has been attacked",
];

/** The phrases from the list that this text uses, after removing approved denials. */
export function certaintyPhrasesIn(text: string): RegExp[] {
  let checked = text;
  for (const denial of APPROVED_DENIALS) checked = checked.split(denial).join(" ");
  return CERTAINTY_PHRASES.filter((phrase) => phrase.test(checked));
}
