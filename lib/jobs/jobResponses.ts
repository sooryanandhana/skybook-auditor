/**
 * What the status and result endpoints answer, decided as plain functions.
 *
 * Separated from the route files for one reason: these are the decisions worth
 * testing — which status code, which sentence, whether a result may be handed
 * over yet — and a Next.js route handler cannot be imported by the unit tests
 * without a bundler. The routes become three lines each, and every judgement
 * they make is exercised here.
 *
 * NOTHING INTERNAL LEAVES THROUGH THESE. Every message below is either a fixed
 * sentence written here or one a collector already wrote for a person to read.
 * An exception's own message never reaches a caller: it can carry a file path,
 * an internal address, or a URL with a key in it.
 */
import type { AuditResult, AuditResultResponse, AuditStatusResponse, SpeedResult } from "../types";
import { withScore } from "../audit/withScore.ts";
import type { Job } from "./jobStore.ts";

/** Sent when a job id names nothing we hold. */
export const JOB_NOT_FOUND =
  "That audit could not be found. It may have finished more than half an hour ago, or the server may have restarted.";

/** Sent when the caller gave no job id at all. */
export const NO_JOB_ID = "Which audit? No job id was given.";

/** Sent when a result is asked for before there is one. */
export const NOT_READY = "This audit is still running. Ask again in a moment.";

/** The fallback when a job failed without a stored reason. */
export const UNKNOWN_FAILURE = "The audit stopped unexpectedly.";

export interface Answer<TBody> {
  status: number;
  body: TBody;
}

/**
 * How a job is getting on.
 *
 * A failed job answers `ok: false` with 200: the audit produced no report, but
 * the question "how is job X doing?" was answered perfectly well. Conflating
 * those would make a failed audit look like a broken endpoint.
 *
 * Unknown and expired give the SAME answer, because they genuinely cannot be
 * told apart — an expired job is deleted. Guessing would mean telling someone
 * their audit expired when they had simply mistyped an id.
 */
export function statusAnswer<TAttached, TExplanation>(
  jobId: string,
  job: Job<AuditResult, TAttached, TExplanation> | null,
): Answer<AuditStatusResponse> {
  if (jobId === "") return { status: 400, body: { ok: false, error: NO_JOB_ID } };
  if (job === null) return { status: 404, body: { ok: false, error: JOB_NOT_FOUND } };

  if (job.status === "failed") {
    return {
      status: 200,
      body: {
        ok: false,
        jobId: job.id,
        status: "failed",
        error: job.error ?? UNKNOWN_FAILURE,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      jobId: job.id,
      status: job.status,
      // Copied, so a caller cannot reach back into the store's own object.
      progress: { ...job.progress },
    },
  };
}

/**
 * The finished audit, and only ever a finished one.
 *
 * A running job is refused rather than answered with what has been measured so
 * far. A half-built report handed over as though it were finished is the exact
 * false claim this project exists to avoid, and "not yet" is easy to handle.
 *
 * A PARTIAL crawl is different and IS returned: its findings are real. What
 * must not happen is calling it a whole-site audit, and `crawl.complete` and
 * `crawl.stoppedBecause` inside the result are what stop that.
 *
 * An audit whose entry page could not be fetched securely is returned the same
 * way, and says what it is in its own `kind`. Withholding it would throw away
 * a certificate that was read and graded.
 */
export function resultAnswer<TExplanation>(
  jobId: string,
  job: Job<AuditResult, SpeedResult, TExplanation> | null,
): Answer<AuditResultResponse> {
  if (jobId === "") return { status: 400, body: { ok: false, error: NO_JOB_ID } };
  if (job === null) return { status: 404, body: { ok: false, error: JOB_NOT_FOUND } };

  if (job.status === "failed") {
    return {
      status: 200,
      body: {
        ok: false,
        jobId: job.id,
        status: "failed",
        error: job.error ?? UNKNOWN_FAILURE,
      },
    };
  }

  if (job.status === "queued" || job.status === "running") {
    return {
      // 409: the request is fine, the resource is not in a state to answer it.
      status: 409,
      body: { ok: false, jobId: job.id, status: job.status, error: NOT_READY },
    };
  }

  /*
   * Terminal and successful, so a result exists — the store writes it in the
   * same step that sets the status. The guard is here so that a future change
   * to the store cannot turn that into a silent null inside a client's report.
   */
  if (job.result === null) {
    return {
      status: 200,
      body: {
        ok: false,
        jobId: job.id,
        status: "failed",
        error: "The audit finished but its result could not be read.",
      },
    };
  }

  /*
   * The finished audit, with its deterministic score attached.
   *
   * This is the one seam where the whole audit is in hand — the crawl result and
   * the speed check that was attached to it — so it is where the score is taken,
   * from both together. `withScore` reads only measured findings, never the AI
   * commentary, and leaves the stored result untouched.
   */
  return {
    status: 200,
    body: {
      ok: true,
      jobId: job.id,
      status: job.status,
      result: withScore(job.result, job.attached),
    },
  };
}
