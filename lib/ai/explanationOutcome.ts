/**
 * Why asking a model for writing did not produce any.
 *
 * PROVIDER-NEUTRAL, AND HERE RATHER THAN IN THE ADAPTER FOR ONE REASON: this
 * list is read in two places that must never disagree. The adapter produces
 * it, and the HTTP layer hands it to a browser. A second copy written for the
 * wire would be a second taxonomy, and two taxonomies drift until the day a
 * timeout is displayed as a rate limit.
 *
 * NOTHING HERE NAMES A PROVIDER, imports an SDK, or knows what was asked. A
 * timeout is a timeout whoever was being waited on.
 *
 * NONE OF THESE SAYS ANYTHING ABOUT THE AUDITED WEBSITE. Every one is a fact
 * about this server, this network or this service. A report must never turn
 * one into a finding, and the sentences below are written so that a person
 * reading one cannot mistake it for a verdict on their site.
 */

export type ExplanationFailureReason =
  /** No key is configured. Nothing was attempted. */
  | "no-api-key"
  /** The request was sent and the budget ran out before an answer arrived. */
  | "timeout"
  /** The service could not be reached at all. */
  | "network"
  /** Quota or rate limit. The request was refused before any work was done. */
  | "rate-limited"
  /** The key was rejected, or it lacks permission. A configuration fault. */
  | "not-authorised"
  /** The service answered with a server error of its own. */
  | "provider-error"
  /** The service rejected the request as malformed. Our fault, not theirs. */
  | "bad-request"
  /** The request succeeded and carried no text to read. */
  | "empty-response"
  /** Text arrived and was not JSON, or was JSON of the wrong shape. */
  | "unreadable-response"
  /** JSON arrived and the validator refused the answer as a whole. */
  | "refused"
  /** A fault in this code. Kept apart so a bug here never reads as a bad reply. */
  | "internal-error";

/**
 * The sentence shown when no better one is supplied.
 *
 * FIXED TEXT, NEVER A PROVIDER'S OWN WORDS. An SDK error carries the response
 * body, the response headers and the request that produced them; any of that
 * in a report is provider internals in a document a client reads, and in the
 * case of headers it is the key itself.
 *
 * Two states borrow better wording from elsewhere -- the missing-key sentence
 * belongs to the client module, and a refusal has the validator's own reason
 * -- so those are passed in rather than taken from here.
 */
export const EXPLANATION_FAILURE_MESSAGES: Record<ExplanationFailureReason, string> = {
  "no-api-key": "No AI service is configured on this server, so nothing was written.",
  refused: "The AI service answered with something this application would not use.",
  timeout: "The AI service did not answer in time, so the report has no written commentary.",
  network: "The AI service could not be reached, so the report has no written commentary.",
  "rate-limited": "The AI service is over its usage limit right now, so nothing was written.",
  "not-authorised": "The AI service rejected this server's credentials, so nothing was written.",
  "provider-error": "The AI service reported a fault of its own, so nothing was written.",
  "bad-request": "The AI service rejected the request. This is a fault in this application.",
  "empty-response": "The AI service answered with no text, so there was nothing to read.",
  "unreadable-response": "The AI service answered with something that was not a usable report.",
  "internal-error": "Writing the commentary failed unexpectedly. The audit itself is unaffected.",
};
