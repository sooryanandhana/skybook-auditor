/**
 * How many client emails this server will send, and to whom it says no.
 *
 * ITS OWN BUCKET, AND THIS IS THE THIRD TIME THIS PROJECT HAS DECIDED THAT.
 * The audit limiter bounds how many crawls a caller may start and how much
 * metered Google quota they may spend. Exporting a report was kept out of it,
 * then signing in was kept out of it, and sending is kept out for the same
 * reason plus a sharper one: an audit that is refused can be run again, and an
 * email that is sent cannot be unsent. The two things are not interchangeable
 * and a shared allowance would let either starve the other.
 *
 * TIGHTER THAN ANYTHING ELSE IN THE PROJECT, deliberately. A salesperson sends
 * a handful of reports in a day and will never meet this. A loop, a stuck
 * retry or a doubled click will, and it will meet it after a few messages
 * rather than after a few hundred.
 *
 * IN MEMORY, LIKE EVERY OTHER LIMIT HERE. It resets when the server restarts,
 * which is the same trade the audit limiter and the sign-in counter already
 * make, and it is the reason this is not the only thing standing between a
 * mistake and a client's inbox -- a person has to confirm each report first.
 */

/** How many messages one caller may send inside the window. */
export const MAX_SENDS = 5;

/**
 * The most reports the whole server will send in the window, across every
 * caller.
 *
 * KEYED ON NOBODY, so a rotated forwarded header cannot slip past it the way it
 * slips past a per-caller count. It sits above `MAX_SENDS` -- one caller may
 * send five, the server as a whole fifteen -- so it bounds an abuser without
 * getting in the way of ordinary use. Sending is the one thing this tool does
 * that leaves the building and costs money, so it carries a ceiling as well as
 * a per-caller limit.
 */
export const GLOBAL_SENDS = 15;

/** How long those are remembered. */
export const SEND_WINDOW_MS = 10 * 60 * 1000;

export const SEND_RATE_LIMITED =
  "Too many reports have been sent from here recently. Wait a few minutes and try again.";

/** When each caller last sent. Never persisted, and never keyed on a recipient. */
const sends = new Map<string, number[]>();

/** Every send, across all callers, for the un-keyed global ceiling. */
let globalSends: number[] = [];

/**
 * Sends that have been let through and have not finished yet, per caller and
 * in total.
 *
 * WHY THESE EXIST. A send is only recorded once a provider has accepted it,
 * which is several awaits after the allowance was asked -- a render and a
 * network call. Without these, twenty requests arriving together all saw the
 * same empty history and all went out. Each one now holds a place from the
 * moment it is let through until it finishes, so the ones behind it see it.
 */
const inFlight = new Map<string, number>();
let globalInFlight = 0;

/** Forgets everything recorded. For tests, so one cannot leak into the next. */
export function resetSendLimit(): void {
  sends.clear();
  globalSends = [];
  inFlight.clear();
  globalInFlight = 0;
}

export interface SendAllowance {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the caller may try again. Only meaningful when refused. */
  readonly retryAfterSeconds: number;
}

/**
 * Whether `caller` has room to send, WITHOUT using any of it.
 *
 * ASKING AND SPENDING ARE TWO OPERATIONS, and they were one until a review
 * measured what that cost. A send request is refused for eight reasons other
 * than this limit -- an unconfirmed report, an expired job, a render that
 * timed out -- and every one of those used to consume an allowance despite
 * sending nothing. Five failed renders left a salesperson locked out for ten
 * minutes, told they had sent too much, having sent nothing at all.
 *
 * So this reads. `recordSend` writes, and only after a provider has actually
 * accepted a message. The name of this limit is then true: it counts sends.
 *
 * READS ONLY, INCLUDING THE PRUNING. Expired entries are filtered out of the
 * answer and not written back, because a function called on every attempt must
 * not be a function that changes anything. `recordSend` prunes when it writes,
 * which is the only moment the list can grow.
 *
 * A SLIDING WINDOW, like the audit limiter, and for the same reason: a counter
 * that reset on the minute would let twice the limit through across a boundary.
 *
 * SENDS STILL IN FLIGHT COUNT TOO, against the caller and the server alike,
 * so a request already let through holds its place until it finishes.
 */
export function sendAllowance(caller: string, now: number = Date.now()): SendAllowance {
  const within = recent(caller, now);
  const mine = within.length + (inFlight.get(caller) ?? 0);

  if (mine >= MAX_SENDS) {
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(within, now) };
  }

  // The server-wide ceiling. A caller with allowance left is still refused once
  // the whole server has sent its fill -- which is what a rotated header runs
  // into as soon as it can no longer look like a fresh caller.
  const globalWithin = recentGlobal(now);
  if (globalWithin.length + globalInFlight >= GLOBAL_SENDS) {
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(globalWithin, now) };
  }

  return { allowed: true, remaining: MAX_SENDS - mine, retryAfterSeconds: 0 };
}

/** A place held for one send that has been let through, until it finishes. */
export interface SendReservation {
  readonly allowed: boolean;
  /** Seconds until the caller may try again. Only meaningful when refused. */
  readonly retryAfterSeconds: number;
  /**
   * Gives the place back. Call it in a `finally`, whatever happened. Safe to
   * call more than once, and does nothing for a refused reservation.
   */
  release(): void;
}

/**
 * Asks for room to send AND holds it, in one synchronous step.
 *
 * RACE SAFETY: there is no await between the check and the hold, so of
 * requests arriving together each one sees every place taken before it. The
 * hold is not a send: it is given back by `release`, and only `recordSend`
 * spends the allowance, so a send that fails or throws still costs nothing.
 */
export function reserveSend(caller: string, now: number = Date.now()): SendReservation {
  const allowance = sendAllowance(caller, now);
  if (!allowance.allowed) {
    return { allowed: false, retryAfterSeconds: allowance.retryAfterSeconds, release: () => {} };
  }

  inFlight.set(caller, (inFlight.get(caller) ?? 0) + 1);
  globalInFlight += 1;

  let released = false;
  return {
    allowed: true,
    retryAfterSeconds: 0,
    release() {
      if (released) return;
      released = true;
      const left = (inFlight.get(caller) ?? 0) - 1;
      if (left > 0) inFlight.set(caller, left);
      else inFlight.delete(caller);
      globalInFlight = Math.max(0, globalInFlight - 1);
    },
  };
}

/** Sends being held right now, per caller and in total. For tests. */
export function sendsInFlight(caller?: string): number {
  return caller === undefined ? globalInFlight : (inFlight.get(caller) ?? 0);
}

/** Seconds until the oldest of `times` leaves the window; one when none is recorded yet. */
function retryAfter(times: readonly number[], now: number): number {
  const oldest = times[0];
  return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + SEND_WINDOW_MS - now) / 1000));
}

/**
 * Spends one of the allowance, because a message actually went.
 *
 * CALLED ONCE, AFTER THE PROVIDER HAS ACCEPTED, and never anywhere else. A
 * caller that recorded before sending would be counting intentions, which is
 * the bug this split exists to fix.
 *
 * RACE SAFETY: synchronous, like the audit limiter's own reasoning. There is
 * no await between reading the list and writing it back, so two sends landing
 * together cannot both be written against the same view.
 */
export function recordSend(caller: string, now: number = Date.now()): void {
  sends.set(caller, [...recent(caller, now), now]);
  globalSends = [...recentGlobal(now), now];
}

/** The caller's sends still inside the window. Pure: it writes nothing. */
function recent(caller: string, now: number): number[] {
  return (sends.get(caller) ?? []).filter((at) => at > now - SEND_WINDOW_MS);
}

function recentGlobal(now: number): number[] {
  return globalSends.filter((at) => at > now - SEND_WINDOW_MS);
}
