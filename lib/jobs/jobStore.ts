/**
 * Where a running audit lives while the browser waits for it.
 *
 * A full-site crawl takes minutes. An HTTP request that stays open for minutes
 * is a request that proxies, load balancers and browsers all feel entitled to
 * cut — so the audit runs as a job and the browser asks how it is getting on.
 *
 * IN MEMORY, ON PURPOSE, AND ONLY FOR THIS PROTOTYPE.
 *
 * A plain Map inside the Node process. That carries real limitations, and they
 * are stated here rather than discovered later:
 *
 *   - EVERY JOB IS LOST WHEN THE PROCESS RESTARTS. A `next dev` reload during
 *     a crawl loses that crawl. The browser polling it will be told the job is
 *     unknown, which is true.
 *   - It does not survive more than one server process. Two Node processes
 *     behind a load balancer would each hold their own jobs, and a poll could
 *     reach the wrong one.
 *   - Memory is the only bound, which is why jobs expire.
 *
 * All three are acceptable for a tool one salesperson runs on one machine, and
 * all three are why this is a Map rather than Redis or a database. Neither
 * belongs in a local internship prototype, and adding one would be building
 * infrastructure to solve a problem nobody has yet.
 */
import { randomUUID } from "node:crypto";

/**
 * How long a finished job stays readable.
 *
 * Long enough that a person can lose the tab, find it again and still see
 * their report; short enough that a day of audits cannot fill memory.
 */
export const JOB_TTL_MS = 30 * 60 * 1000;

/**
 * Where a job has got to.
 *
 * Five values, no more. In particular there is no "cancelled" and no
 * "expired" — an expired job is simply gone, and reporting a state for
 * something we no longer hold would be reporting on nothing.
 */
export type JobStatus =
  /** Created, not yet started. */
  | "queued"
  /** The crawl is running. */
  | "running"
  /** Finished, and the whole site was covered. */
  | "completed"
  /**
   * Finished, but the crawl did NOT cover the whole site.
   *
   * A separate terminal state rather than a flag on "completed", because the
   * difference matters to the person reading the report and a flag is easy to
   * forget to check. The findings are still real and still returned.
   */
  | "partial"
  /** The job itself failed. Not the same as a website having problems. */
  | "failed";

/** True once a job will never change again. */
export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

/** What a caller may see about a job that is still going. */
export interface JobProgress {
  discovered: number;
  queued: number;
  evaluated: number;
  unavailable: number;
  skippedNonHtml: number;
  robotsExcluded: number;
  complete: boolean;
}

export const EMPTY_PROGRESS: JobProgress = {
  discovered: 0,
  queued: 0,
  evaluated: 0,
  unavailable: 0,
  skippedNonHtml: 0,
  robotsExcluded: 0,
  complete: false,
};

export interface Job<TResult, TAttached = never, TExplanation = never> {
  id: string;
  /** The address the audit was asked about, as submitted. */
  requestedUrl: string;
  /**
   * The signed-in account that started the audit, or null when none was named.
   *
   * Set once, at creation, and never changed by anything after. A route that
   * acts on the job for somebody -- sending its report by email -- requires the
   * requester to be this account, and a null owner matches no account at all.
   */
  ownerId: string | null;
  status: JobStatus;
  progress: JobProgress;
  /** Present only once the job reached "completed" or "partial". */
  result: TResult | null;
  /**
   * A sentence safe to show a person, present only when status is "failed".
   *
   * Never an exception message: those carry file paths, URLs with keys in
   * them, and whatever else the thrower happened to include.
   */
  error: string | null;
  /**
   * Deterministic material measured SEPARATELY and attached after the fact.
   *
   * Null until something attaches, and null forever for a store that declares
   * no attachment type. It exists because one part of an audit is measured on
   * its own budget, in its own request — the speed check — and the server
   * needs somewhere to keep it that lives and expires with the job it belongs
   * to.
   *
   * DELIBERATELY NOT PART OF `result`. A second `finish` is refused, and
   * rightly: that rule is what stops a late error overwriting a good result.
   * This is a separate slot with its own first-write-wins rule, so attaching
   * can never disturb the terminal outcome.
   */
  attached: TAttached | null;
  /**
   * Writing produced ABOUT the finished audit, rather than measured for it.
   *
   * A second slot rather than a second use of `attached`, because both are
   * first-write-wins and they are produced by different things at different
   * times: the speed check is measured on its own endpoint, and the commentary
   * is written afterwards from the audit AND that measurement together.
   * Sharing one slot would mean whichever arrived first locked the other out.
   *
   * NEVER PART OF `result`. Nothing here may alter what the audit found; it
   * sits beside the report and is read separately.
   */
  explanation: TExplanation | null;
  /**
   * True once somebody has taken responsibility for producing the explanation.
   *
   * THIS IS WHAT MAKES ONE AUDIT COST ONE REQUEST. Asking a model is slow and
   * costs money, and the browser may ask more than once -- a double-click, a
   * remount, a second tab. The claim is taken synchronously, before anything
   * is awaited, so of two callers arriving together exactly one proceeds.
   *
   * There is deliberately no way to give a claim back. The adapter answers
   * every failure with a state rather than an exception, so a claim is always
   * resolved by a write; a release would exist only to allow a second request,
   * which is the thing being prevented.
   */
  explanationClaimed: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface JobStore<TResult, TAttached = never, TExplanation = never> {
  /** A new queued job, owned by `ownerId` when one is named. */
  create(requestedUrl: string, ownerId?: string | null): Job<TResult, TAttached, TExplanation>;
  /** The job, or null if it never existed or has expired. */
  get(id: string): Job<TResult, TAttached, TExplanation> | null;
  /** Records progress. Ignored once the job is terminal. */
  setProgress(id: string, progress: JobProgress): void;
  /** Moves a job to "running". Ignored if it is already terminal. */
  markRunning(id: string): void;
  /**
   * Stores the outcome. THE FIRST TERMINAL WRITE WINS.
   *
   * A job that has already finished cannot be finished again — that is what
   * stops a late error overwriting a good result, or a result overwriting a
   * failure that already happened.
   */
  finish(id: string, status: "completed" | "partial", result: TResult): void;
  fail(id: string, error: string): void;
  /**
   * Attaches separately measured material to a FINISHED job.
   *
   * Refused before the job is terminal, because there is no completed audit
   * for it to belong to yet, and refused a second time, because the first
   * answer is the one that was measured. Never touches `status`, `result` or
   * `error`: attaching cannot change what the audit found.
   */
  attach(id: string, value: TAttached): void;
  /**
   * Takes the sole right to produce this job's explanation.
   *
   * Returns true to exactly one caller and false to every caller after it,
   * including callers that arrive while the first is still working. Refused
   * outright before the job is terminal, and refused for a job that failed:
   * there is no finished audit for commentary to be about.
   *
   * SYNCHRONOUS ON PURPOSE. The check and the flag are set in one
   * uninterrupted run of statements, so the classic check-then-act race cannot
   * happen -- nothing else runs in between.
   */
  claimExplanation(id: string): boolean;
  /**
   * Files the explanation against a finished job. THE FIRST WRITE WINS.
   *
   * Never touches `status`, `result`, `error` or `attached`: writing about an
   * audit cannot change what the audit found.
   */
  setExplanation(id: string, value: TExplanation): void;
  /** Drops expired jobs. Called on every access; exposed for tests. */
  sweep(): void;
  readonly size: number;
}

/**
 * The job, if it belongs to `userId`; otherwise null.
 *
 * ONE ANSWER FOR MISSING, OWNERLESS AND SOMEBODY ELSE'S. The status, result,
 * explanation, speed-check and PDF routes pass their lookups through this (the
 * email route makes the same comparison inline), so a job that belongs to
 * another account is indistinguishable from one that never existed, and a job
 * with no owner belongs to nobody. Managers are not exempt.
 */
export function ownedBy<J extends { readonly ownerId: string | null }>(job: J | null, userId: string): J | null {
  return job !== null && job.ownerId === userId ? job : null;
}

export interface JobStoreOptions {
  ttlMs?: number;
  /** Injectable clock, so expiry is tested exactly rather than waited for. */
  now?: () => number;
  /** Injectable id source, so tests can make jobs predictable. */
  newId?: () => string;
}

export function createJobStore<TResult, TAttached = never, TExplanation = never>(
  options: JobStoreOptions = {},
): JobStore<TResult, TAttached, TExplanation> {
  const ttlMs = options.ttlMs ?? JOB_TTL_MS;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;

  const jobs = new Map<string, Job<TResult, TAttached, TExplanation>>();

  /*
   * Expiry is swept on access rather than on a timer.
   *
   * A setInterval would keep the Node process alive for as long as the server
   * runs, purely to delete things nobody is asking for. Sweeping when someone
   * looks costs nothing and cannot leak a timer.
   */
  const sweep = (): void => {
    const at = now();
    for (const [id, job] of jobs) {
      if (job.expiresAt <= at) jobs.delete(id);
    }
  };

  const live = (id: string): Job<TResult, TAttached, TExplanation> | null => {
    const job = jobs.get(id);
    if (job === undefined) return null;
    if (job.expiresAt <= now()) {
      jobs.delete(id);
      return null;
    }
    return job;
  };

  /*
   * Callers get a snapshot, never the store's own object.
   *
   * Handing out the live record would let anything holding it rewrite a job's
   * status or result by accident — and a route holding one across an await
   * would then be reading state that had changed underneath it. Copying is
   * cheap and the guarantee is absolute.
   */
  const snapshot = (
    job: Job<TResult, TAttached, TExplanation>,
  ): Job<TResult, TAttached, TExplanation> => ({
    ...job,
    progress: { ...job.progress },
  });

  const touch = (job: Job<TResult, TAttached, TExplanation>): void => {
    job.updatedAt = now();
    // A job being worked on should not expire out from under its own crawl.
    job.expiresAt = job.updatedAt + ttlMs;
  };

  return {
    create(requestedUrl, ownerId = null) {
      sweep();
      const at = now();
      const job: Job<TResult, TAttached, TExplanation> = {
        id: newId(),
        requestedUrl,
        ownerId,
        status: "queued",
        progress: { ...EMPTY_PROGRESS },
        result: null,
        error: null,
        attached: null,
        explanation: null,
        explanationClaimed: false,
        createdAt: at,
        updatedAt: at,
        expiresAt: at + ttlMs,
      };
      jobs.set(job.id, job);
      return snapshot(job);
    },

    get(id) {
      sweep();
      const job = live(id);
      return job === null ? null : snapshot(job);
    },

    setProgress(id, progress) {
      const job = live(id);
      if (job === null || isTerminal(job.status)) return;
      job.progress = { ...progress };
      touch(job);
    },

    markRunning(id) {
      const job = live(id);
      if (job === null || isTerminal(job.status)) return;
      job.status = "running";
      touch(job);
    },

    finish(id, status, result) {
      const job = live(id);
      if (job === null || isTerminal(job.status)) return;
      job.status = status;
      job.result = result;
      job.error = null;
      job.progress = { ...job.progress, complete: status === "completed" };
      touch(job);
    },

    fail(id, error) {
      const job = live(id);
      if (job === null || isTerminal(job.status)) return;
      job.status = "failed";
      job.error = error;
      job.result = null;
      touch(job);
    },

    attach(id, value) {
      const job = live(id);
      if (job === null) return;
      // Nothing to attach to until the audit finished, and nothing to attach
      // to at all if it failed: there is no result for this to belong beside.
      if (!isTerminal(job.status) || job.result === null) return;
      // First attach wins, for the same reason the first terminal write does.
      if (job.attached !== null) return;
      job.attached = value;
      touch(job);
    },

    claimExplanation(id) {
      const job = live(id);
      if (job === null) return false;
      // Nothing to write about until the audit finished, and nothing at all if
      // it failed -- there is no report for commentary to sit beside.
      if (!isTerminal(job.status) || job.result === null) return false;
      if (job.explanationClaimed) return false;
      job.explanationClaimed = true;
      touch(job);
      return true;
    },

    setExplanation(id, value) {
      const job = live(id);
      if (job === null) return;
      if (!isTerminal(job.status) || job.result === null) return;
      if (job.explanation !== null) return;
      job.explanation = value;
      touch(job);
    },

    sweep,

    get size() {
      return jobs.size;
    },
  };
}
