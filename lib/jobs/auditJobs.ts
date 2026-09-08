/**
 * The one audit job store this server uses, and how a job is run.
 *
 * Kept apart from the routes so the routes stay thin and so the runner can be
 * tested without an HTTP layer. Nothing here measures or grades: it starts the
 * pipeline, copies its progress into the job, and stores what came out.
 */
import { createJobStore, type JobStore } from "./jobStore.ts";
import { MAX_CONCURRENT_AUDITS } from "../budgets.ts";
import {
  EntryPageUnavailableError,
  runSiteAudit,
  type SiteAuditOptions,
} from "../audit/siteAudit.ts";
import type { SiteAuditResult, SpeedResult } from "../types";
import type { ExplainResult } from "../ai/gemini/explain.ts";

/**
 * One store for the whole server process.
 *
 * A module-level singleton because that is what "in memory for this process"
 * means. In development Next.js can re-evaluate a module on hot reload, which
 * would otherwise hand out a fresh empty store and lose running jobs, so it is
 * stashed on globalThis — the same trick the ecosystem uses for database
 * clients, and for the same reason.
 */
const GLOBAL_KEY = "__skybookAuditJobs";

/**
 * The audit job store, and the one kind of thing that may be attached to it.
 *
 * The speed check is measured in its own request, so its result arrives after
 * the audit has already finished. It is attached rather than merged into the
 * terminal write, which stays first-write-wins.
 *
 * The third slot holds the AI commentary, which is written later still --
 * from the audit and that measurement together. A TYPE-ONLY import, so the
 * provider it came from is erased at build time and nothing here loads an SDK.
 */
export type AuditJobStore = JobStore<SiteAuditResult, SpeedResult, ExplainResult>;

type GlobalWithJobs = typeof globalThis & {
  [GLOBAL_KEY]?: AuditJobStore;
};

export function auditJobs(): AuditJobStore {
  const holder = globalThis as GlobalWithJobs;
  holder[GLOBAL_KEY] ??= createJobStore<SiteAuditResult, SpeedResult, ExplainResult>();
  return holder[GLOBAL_KEY];
}

/**
 * The sentence a person sees when a job fails for a reason we did not expect.
 *
 * Fixed text, never the exception's own message: an error can carry a file
 * path, an internal address, or a URL with a key in it, and none of that
 * belongs in an HTTP response.
 */
export const UNEXPECTED_FAILURE =
  "The audit stopped unexpectedly. Nothing was measured, so there is nothing to report.";

export interface StartAuditOptions {
  store?: AuditJobStore;
  /** Overridden by tests so the limit can be exercised without waiting. */
  maxConcurrent?: number;
  /** Swapped by tests so no job here reaches the network. */
  runImpl?: typeof runSiteAudit;
  audit?: Omit<SiteAuditOptions, "requestedUrl" | "onProgress">;
}

/**
 * Decides which audits are allowed to be running, and when.
 *
 * A plain counter and a queue, held in this process. That is the whole thing —
 * a single-process prototype needs no lock, because JavaScript gives us the
 * only guarantee that matters for free: nothing else runs between two
 * statements. The reservation below takes advantage of that and nothing more.
 */
interface Scheduler {
  /** How many audits are running right now. Never above the limit. */
  running: number;
  /** Audits waiting for a slot, oldest first. */
  waiting: Array<{ jobId: string; begin: () => Promise<void>; done: () => void }>;
}

const SCHEDULER_KEY = "__skybookAuditScheduler";

type GlobalWithScheduler = typeof globalThis & { [SCHEDULER_KEY]?: Scheduler };

function scheduler(): Scheduler {
  const holder = globalThis as GlobalWithScheduler;
  holder[SCHEDULER_KEY] ??= { running: 0, waiting: [] };
  return holder[SCHEDULER_KEY];
}

/** How many audits are running. Exposed so a test can watch the invariant. */
export function runningAuditCount(): number {
  return scheduler().running;
}

/** How many are waiting for a slot. */
export function queuedAuditCount(): number {
  return scheduler().waiting.length;
}

/**
 * Starts as many waiting audits as there are free slots, oldest first.
 *
 * THE RESERVATION IS SYNCHRONOUS, AND THAT IS THE POINT. `running` is
 * incremented in the same uninterrupted run of statements that removes the job
 * from the queue, BEFORE anything is awaited. There is therefore no moment at
 * which two callers can both see a free slot and both take it — the classic
 * check-then-act race cannot occur, because nothing can run in between.
 *
 * Recursive only through the completion handler, so a queue of a hundred jobs
 * starts two, and starts the third when one of those two finishes.
 */
function pump(store: AuditJobStore, limit: number): void {
  const state = scheduler();

  while (state.running < limit && state.waiting.length > 0) {
    // shift() and the increment happen together, with no await between them.
    const next = state.waiting.shift();
    if (next === undefined) return;

    // A job that expired or was already finished while it waited must not take
    // a slot: there is nobody left to give the answer to.
    const job = store.get(next.jobId);
    if (job === null || job.status !== "queued") {
      // Expired, or already terminal. It takes no slot, but anything waiting
      // on it is told so rather than left hanging.
      next.done();
      continue;
    }

    state.running += 1;

    void next
      .begin()
      .catch(() => {
        /* begin() handles its own failures; this only guards the release. */
      })
      .finally(() => {
        /*
         * The slot comes back whatever happened — completed, partial, failed,
         * or an exception nobody predicted. A slot that leaked on failure
         * would let one broken audit block every audit after it, permanently.
         */
        state.running -= 1;
        next.done();
        pump(store, limit);
      });
  }
}

/**
 * Creates a job and queues it for a slot, returning as soon as the job exists.
 *
 * The work is deliberately NOT awaited — that is the whole point of a job — and
 * it may not begin at all until a running audit finishes. The returned promise
 * settles once the job is done AND its slot has been handed back, which is what
 * lets a test start the next audit and know the count is already correct.
 */
export function startAudit(
  requestedUrl: string,
  options: StartAuditOptions = {},
): { jobId: string; finished: Promise<void> } {
  const store = options.store ?? auditJobs();
  const run = options.runImpl ?? runSiteAudit;
  const limit = options.maxConcurrent ?? MAX_CONCURRENT_AUDITS;

  const job = store.create(requestedUrl);

  /*
   * The job exists and its id is returned immediately, whether or not a slot
   * is free. A full queue is not a reason to refuse a valid audit — the person
   * who asked for it gets their receipt now and the work happens when there is
   * room for it.
   */
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const begin = async (): Promise<void> => {
    store.markRunning(job.id);

    try {
      const result = await run({
        ...options.audit,
        requestedUrl,
        onProgress: (progress) => store.setProgress(job.id, progress),
      });

      /*
       * A crawl that stopped at a limit is NOT a completed audit.
       *
       * The findings it produced are real and are still returned — but the
       * status says "partial", because saying "completed" would tell someone
       * we had looked at a whole website when we had looked at part of one.
       */
      store.finish(job.id, result.crawl.complete ? "completed" : "partial", result);
    } catch (error) {
      /*
       * The entry page being unreadable is the one failure we can describe in
       * the collector's own words — it already said why. Anything else gets
       * the fixed sentence, because we do not know what an unexpected error
       * might have put in its message.
       */
      if (error instanceof EntryPageUnavailableError) {
        store.fail(job.id, error.reason);
      } else {
        // Logged for whoever has to fix it; never sent to the client.
        console.warn(
          `Audit job ${job.id} failed unexpectedly.`,
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        store.fail(job.id, UNEXPECTED_FAILURE);
      }
    }
  };

  scheduler().waiting.push({ jobId: job.id, begin, done: settle });
  pump(store, limit);

  /*
   * The promise is handled here and now.
   *
   * Without this, a caller that ignores it — which the route does, on purpose
   * — would leave a rejected promise with no handler, and Node kills the
   * process for that. Everything is already caught above, so this only exists
   * to make the guarantee unconditional.
   */
  void finished.catch(() => {});

  return { jobId: job.id, finished };
}
