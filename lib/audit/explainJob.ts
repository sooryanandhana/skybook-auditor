/**
 * The one place a finished audit becomes a request for writing.
 *
 * WHAT IT JOINS
 *
 *   the stored audit + the stored speed check   (both measured by this server)
 *        -> withSpeed          one result describing the whole audit
 *        -> buildAIReportInput the fail-closed projection a model may see
 *        -> explainAudit       one provider request, validated on the way back
 *        -> the job's own explanation slot
 *
 * NOTHING A BROWSER SENDS IS AN INPUT TO ANY OF THAT. The caller supplies a
 * job id and nothing else. Everything the model is shown was measured here,
 * which is what stops a modified client handing a model whatever findings and
 * severities it liked.
 *
 * ONE AUDIT, ONE REQUEST, AND THE STORE IS WHAT ENFORCES IT. The claim is
 * taken synchronously before anything is awaited, so of two callers arriving
 * together exactly one proceeds and the other is told to read the stored
 * answer. A browser that polls, double-clicks, remounts or opens a second tab
 * therefore costs one request, not one per ask.
 *
 * THE AUDIT IS NEVER TOUCHED. Nothing here writes to the job's result, status
 * or error, and the composition returns a new object rather than editing the
 * stored one. Whatever happens below, the report is the report the crawl
 * produced.
 */
import { withSpeed } from "./withSpeed.ts";
import { buildAIReportInput } from "../ai/buildReportInput.ts";
import { explainAudit, type ExplainOptions, type ExplainResult } from "../ai/gemini/explain.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

/**
 * What asking on behalf of a job produced.
 *
 * `stored` says where the answer came from, not what it says. It exists so a
 * caller -- and a test -- can tell "this is the answer we already had" from
 * "this is the answer we just got", which is the difference that proves a
 * second ask cost nothing.
 */
export type ExplainJobOutcome =
  | { readonly ok: true; readonly stored: boolean; readonly result: ExplainResult }
  | { readonly ok: false; readonly reason: ExplainJobRefusal };

/**
 * Why a job could not be written about at all.
 *
 * SEPARATE FROM THE ADAPTER'S OWN FAILURE STATES, because these are not
 * failures of asking. Nothing was asked: there was no audit to ask about, or
 * somebody else is already asking.
 */
export type ExplainJobRefusal =
  /** No such job. Unknown and expired cannot be told apart, and are not. */
  | "unknown-job"
  /** The audit is still running, or it failed. There is no report to describe. */
  | "not-finished"
  /** Someone else holds the claim and has not finished. Ask again shortly. */
  | "in-progress";

export interface ExplainJobDeps {
  /** Swapped by tests. Production uses the real adapter and asks Gemini. */
  readonly explain?: (
    ...args: Parameters<typeof explainAudit>
  ) => ReturnType<typeof explainAudit>;
  /** Passed through to the adapter, so tests need no key and no network. */
  readonly options?: ExplainOptions;
}

/**
 * Produces, or returns, the commentary for one finished audit.
 *
 * Never throws for an expected outcome. The adapter answers every provider
 * failure with a state, and the three refusals above cover everything else, so
 * a caller has no exception to handle and no reason to retry.
 */
export async function explainJob(
  jobId: string,
  store: AuditJobStore,
  deps: ExplainJobDeps = {},
): Promise<ExplainJobOutcome> {
  const job = store.get(jobId);
  if (job === null) return { ok: false, reason: "unknown-job" };

  /*
   * ALREADY ANSWERED IS THE FIRST THING CHECKED, before the claim and before
   * anything is composed. This is the path a polling browser takes, and it
   * must cost a map lookup rather than a provider request.
   */
  if (job.explanation !== null) {
    return { ok: true, stored: true, result: job.explanation };
  }

  /*
   * ONE QUESTION, ASKED ONCE: is there a finished report to write about?
   *
   * Both halves are needed and neither is redundant cover for the other. The
   * status excludes a job that FAILED, which is terminal and will never have a
   * report; the null check is what lets the composition below read
   * `job.result` at all, since a queued job has none.
   *
   * They do overlap -- a failed job has no result either -- so mutating either
   * half alone leaves the behaviour identical. That is a property of the
   * store, where `fail` clears the result, rather than a gap in the testing.
   */
  const finished = job.status === "completed" || job.status === "partial";
  if (!finished || job.result === null) {
    return { ok: false, reason: "not-finished" };
  }

  /*
   * The claim, taken before any await. Losing it means somebody else is
   * already asking; the answer will be in the slot when they are done, and a
   * second request to find that out sooner is exactly what is not wanted.
   */
  if (!store.claimExplanation(jobId)) {
    return { ok: false, reason: "in-progress" };
  }

  /*
   * COMPOSED FROM WHAT THE SERVER MEASURED, on every call.
   *
   * `withSpeed` returns a new result and leaves the stored one alone, so the
   * job still holds the audit exactly as the crawl produced it. A null
   * attachment means the speed check was never asked for, and the audit's own
   * performance measurement already says so in its own words -- which is a
   * complete audit, not a gap to be filled in.
   */
  const whole = withSpeed(job.result, job.attached);
  const input = buildAIReportInput(whole);

  const ask = deps.explain ?? explainAudit;
  const result = await ask(input, deps.options ?? {});

  /*
   * Stored whatever it says. A failure state is an answer, and storing it is
   * what stops the next ask from trying again -- the claim has already been
   * spent, and a request that failed once for lack of a key will fail the same
   * way a second time.
   */
  store.setExplanation(jobId, result);

  return { ok: true, stored: false, result };
}
