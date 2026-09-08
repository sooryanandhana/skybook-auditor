/**
 * The one place in this project that actually asks Gemini anything.
 *
 * Everything before it builds a request without sending one, and everything
 * after it reads a result that has already been checked. This file is the join
 * between them, and it is deliberately the smallest thing that can be:
 *
 *   AIReportInput -> 5D client -> 5E request -> ONE request -> JSON -> 5C
 *
 * IT ADDS NO JUDGEMENT OF ITS OWN. It does not measure, grade, count, filter,
 * repair or reword. It hands over what 5E built, reads what came back, and
 * gives it to the validator. Everything it returns as a success is something
 * the validator approved.
 *
 * A FAILURE HERE IS NEVER A FAILURE OF THE AUDIT. Every way this can go wrong
 * returns a state with a sentence attached, and the deterministic report is
 * delivered complete and unchanged in all of them. That is the property worth
 * protecting: the report is the product, and the writing beside it is an
 * addition.
 *
 * NOTHING A PROVIDER SAYS IS QUOTED BACK. The messages below are ours. The
 * SDK's errors carry the response body, the response headers and the request
 * that produced them, and putting any of that in a report would leak provider
 * internals into a document a client reads -- and, in the case of headers, the
 * key itself.
 */
import type { Interactions } from "@google/genai";
import { AI_EXPLANATION_BUDGET_MS } from "../../budgets.ts";
import type { AIReportInput } from "../contract.ts";
import type { AIExplanationSet } from "../explanation.ts";
import { type RejectedExplanation, validateExplanations } from "../validateExplanations.ts";
import { type GeminiOptions, geminiAvailability, geminiClient } from "./client.ts";
import { buildExplanationRequest } from "./prompt.ts";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * The provider's request method, narrowed to the one call this project makes.
 *
 * WHY IT IS NAMED AS A TYPE. Tests need to count requests, and counting them
 * anywhere other than here would count something else -- a helper that was
 * called, a promise that was created. This is the method that puts a packet on
 * the wire, so a fake standing in for it counts the thing that matters.
 */
export interface GeminiInteractions {
  create(
    params: Interactions.CreateModelInteractionParamsNonStreaming,
    options?: GeminiRequestOptions,
  ): Promise<unknown>;
}

/** As much of the SDK client as this file touches. */
export interface GeminiRequestClient {
  readonly interactions: GeminiInteractions;
}

/**
 * The per-request settings handed to the SDK.
 *
 * BOTH OF THESE ARE LOAD-BEARING and neither is a default. See the call site.
 */
export interface GeminiRequestOptions {
  readonly timeout_ms?: number;
  readonly retries?: { readonly strategy: "none" };
}

export interface ExplainOptions extends GeminiOptions {
  /** The client to ask. Supplied by tests; production uses the 5D client. */
  readonly client?: GeminiRequestClient;
  /** Overrides the budget. Supplied by tests so none of them wait 45 seconds. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// What can come back
// ---------------------------------------------------------------------------

/**
 * Why no explanation was produced.
 *
 * MACHINE-READABLE, AND SEPARATE FROM THE ENGLISH, for the same reason the
 * speed check keeps the two apart: nothing downstream should have to read a
 * sentence to find out whether the provider timed out or refused the key.
 *
 * NONE OF THESE SAYS ANYTHING ABOUT THE AUDITED WEBSITE. Every one of them is
 * a fact about this server, this network or this provider. A report must never
 * turn one into a finding.
 */
export type ExplanationFailureReason =
  /** No key is configured. Nothing was attempted. */
  | "no-api-key"
  /** The request was sent and the budget ran out before an answer arrived. */
  | "timeout"
  /** The provider could not be reached at all. */
  | "network"
  /** Quota or rate limit. The request was refused before any work was done. */
  | "rate-limited"
  /** The key was rejected, or it lacks permission. A configuration fault. */
  | "not-authorised"
  /** The provider answered with a server error of its own. */
  | "provider-error"
  /** The provider rejected the request as malformed. Our fault, not theirs. */
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
 * What asking produced.
 *
 * A DISCRIMINATED UNION, like every other "this may not have worked" answer in
 * this codebase. `not-explained` carries no half-built set and no invented
 * summary. `explained` carries only what the validator approved.
 */
export type ExplainResult =
  | {
      readonly state: "explained";
      /** Validator-approved prose. Never the provider's own object. */
      readonly explanations: AIExplanationSet;
      /**
       * Entries the validator dropped, kept so a gap can be explained rather
       * than hidden. Present and empty when nothing was dropped.
       */
      readonly rejected: readonly RejectedExplanation[];
      /**
       * True when the validator dropped at least one entry.
       *
       * A partial answer is still an answer: a finding with no writing beside
       * it is a complete finding, because the evidence and the remediation
       * were ours all along. Every entry being dropped is still `explained` --
       * the summary survived its own checks, and an empty list of explanations
       * is an honest thing to return.
       */
      readonly partial: boolean;
    }
  | {
      readonly state: "not-explained";
      readonly reason: ExplanationFailureReason;
      /** A sentence a person can act on. Ours, never the provider's. */
      readonly message: string;
    };


const MESSAGES: Record<ExplanationFailureReason, string> = {
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

/**
 * A failure state.
 *
 * Every reason has a sentence of its own, so a caller that forgets to pass one
 * still gets English rather than `undefined` in a report. The two states that
 * borrow somebody else's wording -- the 5D key message and the validator's own
 * refusal -- pass it in, and neither has to be repeated here to be correct.
 */
function notExplained(reason: ExplanationFailureReason, message?: string): ExplainResult {
  return { state: "not-explained", reason, message: message ?? MESSAGES[reason] };
}

// ---------------------------------------------------------------------------
// Reading what came back
// ---------------------------------------------------------------------------

/**
 * Turns whatever the SDK threw into one of our states.
 *
 * DUCK-TYPED ON PURPOSE. The SDK exports one error class and throws about ten,
 * so `instanceof` would cover a tenth of the cases and quietly miss the rest.
 * The status code and the error's own name are stable, observable and were
 * read off real errors produced by the installed version rather than guessed.
 *
 * The error object itself is never read for text. It carries the response
 * body, the response headers and the originating request.
 */
function classify(error: unknown): ExplanationFailureReason {
  const name = typeof (error as { name?: unknown })?.name === "string"
    ? (error as { name: string }).name
    : "";
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : null;

  // Timeouts and aborts arrive by name; neither carries a status.
  if (name.includes("Timeout") || name === "AbortError" || name === "TimeoutError") return "timeout";
  if (name.includes("Connection")) return "network";

  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "not-authorised";
  if (status !== null && status >= 500) return "provider-error";
  /*
   * A 200 that reaches here is the SDK refusing a body it could not read as
   * the documented content type -- an error page from a proxy, typically. It
   * is a bad reply rather than a bad request, and its message quotes the body,
   * which is another reason nothing here quotes the message.
   */
  if (status === 200) return "unreadable-response";
  if (status !== null && status >= 400) return "bad-request";

  /*
   * UNRECOGNISED IS NOT "NETWORK", AND THIS WAS A BUG BEFORE IT WAS A COMMENT.
   *
   * The fallback used to be "network", which meant any error this function did
   * not recognise -- including a fault thrown by our own code while making the
   * call -- was reported as "the AI service could not be reached". That is a
   * confident false statement about somebody else's infrastructure, made on no
   * evidence, which is the exact kind of sentence this project exists not to
   * write. A test that threw a plain Error is what found it.
   *
   * Unrecognised now means unrecognised. A real network failure arrives as a
   * connection error and is caught above, on evidence.
   */
  return "internal-error";
}

/**
 * The answer's text, or null when there was none.
 *
 * UNTRUSTED, LIKE EVERYTHING ELSE FROM OVER THERE. The documented accessor is
 * `output_text`, and this checks that what sits there really is a non-empty
 * string rather than assuming the documentation describes every reply.
 */
function outputText(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  const text = (response as { output_text?: unknown }).output_text;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Asks Gemini to write about one finished audit.
 *
 * EXACTLY ONE REQUEST, OR NONE. There is a single call to the provider in this
 * function, it is not in a loop, nothing calls this function again on failure,
 * and the SDK's own retry policy is switched off at the call site. A failure of
 * any kind returns a state; it never produces a second request.
 *
 * READS ITS ARGUMENT AND WRITES TO NOTHING. The input is serialised by the 5E
 * builder and otherwise untouched: no finding, severity, count, measurement,
 * coverage figure or skipped check is read for a decision, let alone changed.
 */
export async function explainAudit(
  input: AIReportInput,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  try {
    /*
     * NO KEY MEANS NO REQUEST, and it is answered before anything is built.
     * The 5D module already owns this question and already has the sentence
     * for it, so this repeats neither.
     */
    const availability = geminiAvailability(options);
    const client = options.client ?? geminiClient(options);
    if (!availability.configured || client === null) {
      /*
       * Both answers come from the same resolved key, so they say the same
       * thing; the second half of the test is here because the client type
       * says null is possible, not because the two can disagree. The sentence
       * is 5D's, so there is one wording for a missing key rather than two.
       */
      return notExplained("no-api-key", availability.configured ? undefined : availability.reason);
    }

    const request = buildExplanationRequest(input);

    let response: unknown;
    try {
      /*
       * THE ONE REQUEST. Both options are load-bearing and were established by
       * exercising the installed SDK rather than by reading its types:
       *
       * `retries` -- the default policy is four retries with backoff on 408,
       * 409, 429 and every 5xx, so one call here would be five requests on a
       * rate limit. This project makes one request per audit and means it.
       *
       * `timeout_ms` -- the provider's timeout is applied PER ATTEMPT. With
       * retries on, a 45-second bound would have been a 45-second bound four
       * times over. With retries off, one attempt is the whole call, so this
       * number is the whole wait.
       */
      response = await client.interactions.create(request, {
        timeout_ms: options.timeoutMs ?? AI_EXPLANATION_BUDGET_MS,
        retries: { strategy: "none" },
      });
    } catch (error) {
      return notExplained(classify(error));
    }

    const text = outputText(response);
    if (text === null) return notExplained("empty-response");

    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch {
      /*
       * NOT REPAIRED, AND NOT ASKED AGAIN. Trimming a stray fence or slicing
       * to the first brace would be this file inventing a reply, and asking
       * again would be a second request. Neither is worth an explanation
       * paragraph the report does perfectly well without.
       */
      return notExplained("unreadable-response");
    }

    /*
     * THE VALIDATOR IS NOT OPTIONAL AND IS NOT CONDITIONAL.
     *
     * The provider claims to enforce the 5E schema, and this runs anyway. That
     * claim is about somebody else's server on a code path this project cannot
     * test, and the whole architecture rests on nothing from over there being
     * believed until our own code has agreed with it.
     */
    const checked = validateExplanations(input, candidate);
    if (!checked.ok) return notExplained("refused", checked.reason);

    return {
      state: "explained",
      explanations: checked.accepted,
      rejected: checked.rejected,
      partial: checked.rejected.length > 0,
    };
  } catch {
    /*
     * A BUG HERE IS A STATE, NOT AN EXCEPTION.
     *
     * The caller is a report that is already complete. Throwing into it would
     * turn a fault in the writing into a fault in the audit, which is the one
     * thing this file exists to prevent. The cost, stated plainly: a mistake
     * in the code above becomes a missing paragraph rather than a stack trace,
     * so this reason is kept separate from every provider failure and is
     * always worth investigating.
     */
    return notExplained("internal-error");
  }
}
