/**
 * A single countdown shared by everything one audit does.
 *
 * WHY THIS EXISTS: before it, each part of the audit kept its own timer. The
 * page fetch allowed 20 seconds, and could run twice when it retried over
 * HTTP; the technical checks allowed another 10. Nothing tracked the total, so
 * one slow website could hold a request open for around fifty seconds while
 * the user saw nothing but "Checking…".
 *
 * Every request now asks the same deadline for its signal, so time spent early
 * is time the later checks no longer have.
 */
export interface Deadline {
  /** Whether the budget is already used up. */
  expired(): boolean;
  /** Milliseconds left, never below zero. */
  remainingMs(): number;
  /**
   * An abort signal that fires when the SHARED budget runs out, or after
   * `capMs` if that is sooner.
   *
   * The cap keeps a single request from consuming the whole budget: a request
   * hanging for the full remaining time would starve every check after it.
   */
  signal(capMs?: number): AbortSignal;
}

/**
 * A deadline that ends at whichever comes first: `capMs` from now, or the end
 * of `outer`.
 *
 * This is how one part of an audit keeps its own limit while still living
 * inside the whole audit's budget. Without it, handing a component the audit's
 * deadline lets that component use every second the earlier steps did not —
 * which is the opposite of a per-part limit.
 */
export function capDeadline(outer: Deadline, capMs: number): Deadline {
  const own = createDeadline(Math.min(capMs, outer.remainingMs()));
  return {
    remainingMs: () => Math.min(own.remainingMs(), outer.remainingMs()),
    expired: () => own.expired() || outer.expired(),
    signal: (perRequestCapMs?: number) => {
      const left = Math.min(own.remainingMs(), outer.remainingMs());
      const limit = perRequestCapMs === undefined ? left : Math.min(perRequestCapMs, left);
      return AbortSignal.timeout(Math.max(1, limit));
    },
  };
}

export function createDeadline(budgetMs: number): Deadline {
  const endsAt = Date.now() + budgetMs;

  const remainingMs = () => Math.max(0, endsAt - Date.now());

  return {
    remainingMs,
    expired: () => remainingMs() === 0,
    signal: (capMs?: number) => {
      const left = remainingMs();
      const limit = capMs === undefined ? left : Math.min(capMs, left);
      // Never zero: a zero-length timeout aborts before the request is sent,
      // which would look like a network failure rather than a timeout.
      return AbortSignal.timeout(Math.max(1, limit));
    },
  };
}
