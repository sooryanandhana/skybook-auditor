/**
 * A small rate limit for account registration, in a bucket of its very own.
 *
 * A SEPARATE BUCKET, DELIBERATELY. This project keeps its rate limits apart on
 * purpose: the audit allowance bounds metered work, the sign-in limiter slows
 * password guessing, and neither must be spendable by the other. Registration
 * is a third thing — the abuse to stop is somebody filling the pending-accounts
 * list with junk — so it counts on its own. Sharing a bucket would let a flood
 * of fake sign-ups lock a salesperson out of auditing, or the reverse.
 *
 * IN MEMORY, like the others, which resets on restart and is per-instance. That
 * is the right trade for a single-instance tool; a shared store would be a
 * dependency registration does not otherwise need.
 */
import { trustedCaller, trustsProxy } from "../callerAddress.ts";

/** How many accounts one caller may request in the window. */
export const REGISTER_PER_CALLER = 5;

/**
 * How many accounts may be requested across every caller together.
 *
 * The same reasoning as the audit ceiling: without a trusted proxy a caller
 * rotating its address is a new caller each time, so a limit keyed on the
 * caller alone could be walked past. This one is keyed on nobody and holds
 * regardless. It is comfortably above one person's allowance so honest onboarding
 * is never the thing it catches.
 */
export const REGISTER_GLOBAL = 20;

/** How long a request is remembered. Long, because sign-up is occasional. */
const WINDOW_MS = 15 * 60 * 1000;

const perCaller = new Map<string, number[]>();
let globalTimes: number[] = [];

export interface RegisterLimitResult {
  readonly allowed: boolean;
  /** Seconds until the caller may try again. Only meaningful when blocked. */
  readonly retryAfterSeconds: number;
  /** Which limit answered — the caller's own, or the server-wide ceiling. */
  readonly scope: "caller" | "global";
}

/**
 * Records a registration attempt from `caller` and says whether it is allowed.
 *
 * A sliding window, like the audit limiter: timestamps are kept and the old
 * ones dropped, so a fixed reset on the quarter-hour cannot be straddled to get
 * twice the allowance. A BLOCKED attempt is not recorded, against the caller or
 * the global count, so a refusal neither extends a lockout nor spends the
 * shared budget. Everything here is synchronous, so two attempts at once cannot
 * interleave between the count and the record.
 */
export function checkRegisterLimit(caller: string, now: number = Date.now()): RegisterLimitResult {
  const windowStart = now - WINDOW_MS;
  const mine = (perCaller.get(caller) ?? []).filter((at) => at > windowStart);
  const all = globalTimes.filter((at) => at > windowStart);

  if (mine.length >= REGISTER_PER_CALLER) {
    perCaller.set(caller, mine);
    globalTimes = all;
    return { allowed: false, retryAfterSeconds: retryAfter(mine[0], now), scope: "caller" };
  }

  if (all.length >= REGISTER_GLOBAL) {
    perCaller.set(caller, mine);
    globalTimes = all;
    return { allowed: false, retryAfterSeconds: retryAfter(all[0], now), scope: "global" };
  }

  mine.push(now);
  perCaller.set(caller, mine);
  all.push(now);
  globalTimes = all;

  if (perCaller.size > 1000) {
    for (const [key, times] of perCaller) {
      if (times.every((at) => at <= windowStart)) perCaller.delete(key);
    }
  }

  return { allowed: true, retryAfterSeconds: 0, scope: "caller" };
}

function retryAfter(oldest: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

/**
 * Who is asking, read exactly as the other limits read it: a forwarded address
 * is believed only behind a configured proxy, so without one every request is
 * the single shared bucket and rotating the header escapes nothing.
 */
export function registerCaller(request: Request, trustProxy: boolean = trustsProxy()): string {
  return trustedCaller(request, trustProxy);
}

/** Test helper: forget every recorded registration attempt. */
export function resetRegisterLimits(): void {
  perCaller.clear();
  globalTimes = [];
}
