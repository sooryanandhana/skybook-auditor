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

/** How long those are remembered. */
export const SEND_WINDOW_MS = 10 * 60 * 1000;

export const SEND_RATE_LIMITED =
  "Too many reports have been sent from here recently. Wait a few minutes and try again.";

/** When each caller last sent. Never persisted, and never keyed on a recipient. */
const sends = new Map<string, number[]>();

/** Forgets everything recorded. For tests, so one cannot leak into the next. */
export function resetSendLimit(): void {
  sends.clear();
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
 */
export function sendAllowance(caller: string, now: number = Date.now()): SendAllowance {
  const within = recent(caller, now);

  if (within.length >= MAX_SENDS) {
    const oldest = within[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + SEND_WINDOW_MS - now) / 1000)),
    };
  }

  return { allowed: true, remaining: MAX_SENDS - within.length, retryAfterSeconds: 0 };
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
}

/** The caller's sends still inside the window. Pure: it writes nothing. */
function recent(caller: string, now: number): number[] {
  return (sends.get(caller) ?? []).filter((at) => at > now - SEND_WINDOW_MS);
}
