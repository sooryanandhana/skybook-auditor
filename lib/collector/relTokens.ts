/**
 * Reading a `rel` attribute the way HTML defines it.
 *
 * `rel` is a SPACE-SEPARATED LIST OF TOKENS, not a string to compare against.
 * All of these declare a canonical relation, and every one of them is legal:
 *
 *   rel="canonical"
 *   rel="Canonical"
 *   rel="canonical alternate"
 *   rel="alternate canonical"
 *   rel=" canonical "
 *
 * WHY THIS EXISTS AS A SHARED FUNCTION. The mixed-content checker already read
 * `rel` correctly, splitting it into tokens so that the legacy
 * `rel="shortcut icon"` is recognised as an icon. The SEO reader did not: it
 * used an exact attribute match, so a page whose canonical tag carried a
 * second token was reported as declaring no canonical URL at all — a false
 * statement about a page that declares one perfectly well.
 *
 * One function, used by both, so the two cannot drift apart again.
 *
 * Substrings are NOT matches, and that is the other half of the job:
 * "xcanonical" and "canonicalfoo" are their own tokens and mean nothing here.
 * Splitting on whitespace gives that for free, where a `includes("canonical")`
 * test would not.
 */

/**
 * The tokens in a `rel` attribute, lower-cased, with empties dropped.
 *
 * Returns an empty list for a missing, empty or whitespace-only attribute,
 * which is what "this element declares no relation" looks like.
 */
export function relTokens(rel: string | null | undefined): string[] {
  if (!rel) return [];
  return rel.toLowerCase().trim().split(/\s+/).filter((token) => token.length > 0);
}

/** Whether a `rel` attribute declares the given relation. */
export function hasRel(rel: string | null | undefined, relation: string): boolean {
  return relTokens(rel).includes(relation);
}
