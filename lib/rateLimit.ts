/**
 * A small per-caller request limit for the audit endpoint.
 *
 * WHY: every audit makes several outbound requests, and from the next step
 * onward each will also cost money — a metered Google API call, and later a
 * paid Claude call. Without a limit, one script could run those up without
 * anyone noticing, and the tool becomes a way to generate outbound traffic
 * attributable to Skybook.
 *
 * DELIBERATELY SIMPLE: counts are held in memory, so they reset when the
 * server restarts and are not shared between server instances. That is the
 * right trade for a tool running on one machine — a shared store would be a
 * database dependency this project does not otherwise need. Revisit if the
 * tool is ever hosted with more than one instance.
 */

/** How many audits one caller may run per minute. */
export const DEFAULT_LIMIT = 10;

/**
 * The highest the limit may ever be set to.
 *
 * A ceiling exists so the override cannot be used to switch protection off.
 * Sixty a minute is one a second — far above anything a person does by hand,
 * and still low enough that a runaway script is caught.
 */
export const MAX_LIMIT = 60;

const WINDOW_MS = 60_000;

/** So a misconfiguration is mentioned once, not on every request. */
let warnedAboutValue: string | null = null;

function warnOnce(value: string, reason: string): void {
  if (warnedAboutValue === value) return;
  warnedAboutValue = value;
  console.warn(
    `AUDIT_RATE_LIMIT_PER_MINUTE="${value}" ignored (${reason}). ` +
      `Using the default of ${DEFAULT_LIMIT} audits per minute.`,
  );
}

/**
 * How many audits one caller may run per minute.
 *
 * The limit can be raised for local development, where someone testing by hand
 * may legitimately run more than ten in a minute. Three rules keep that
 * convenience from becoming a way to switch the protection off:
 *
 *   1. IN PRODUCTION THE VARIABLE IS IGNORED ENTIRELY. A developer's .env file
 *      copied to a server, or a value left over from debugging, cannot quietly
 *      remove the limit where it matters most.
 *   2. A value above MAX_LIMIT is treated as invalid and falls back to the
 *      default, rather than being honoured in part. Setting 9999999 clearly
 *      means "no limit", and the safe answer to that is the default one.
 *   3. Anything not a whole number of at least 1 — negative, zero, fractional,
 *      NaN, Infinity, empty, or text — falls back to the default too.
 *
 * Every rejected value is reported once on the console, so a developer whose
 * setting was ignored finds out rather than wondering why they are still
 * being limited.
 */
function configuredLimit(): number {
  const raw = process.env.AUDIT_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;

  if (process.env.NODE_ENV === "production") {
    warnOnce(raw, "the override is not available in production");
    return DEFAULT_LIMIT;
  }

  /*
   * Plain decimal digits only.
   *
   * Number() is more accepting than a configuration value should be: it reads
   * "0x10" as 16 and "1e9" as a billion. Neither is what someone typing a
   * request limit means, so the format is checked before the value.
   */
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    warnOnce(raw, "not a whole number written in plain digits");
    return DEFAULT_LIMIT;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    warnOnce(raw, "not a whole number of at least 1");
    return DEFAULT_LIMIT;
  }

  if (parsed > MAX_LIMIT) {
    warnOnce(raw, `above the maximum of ${MAX_LIMIT}`);
    return DEFAULT_LIMIT;
  }

  return parsed;
}

/** When each caller's recent requests happened. */
const recentRequests = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  /** How many requests remain in the current window. */
  remaining: number;
  /** Seconds until the caller may try again. Only meaningful when blocked. */
  retryAfterSeconds: number;
  limit: number;
}

/**
 * Records a request from `caller` and says whether it is allowed.
 *
 * Uses a sliding window: we keep the timestamps of recent requests and drop
 * ones older than the window, rather than resetting a counter on the minute.
 * A fixed reset would let someone send twice the limit across a boundary.
 */
export function checkRateLimit(caller: string, now: number = Date.now()): RateLimitResult {
  const limit = configuredLimit();
  const windowStart = now - WINDOW_MS;

  const previous = recentRequests.get(caller) ?? [];
  const withinWindow = previous.filter((at) => at > windowStart);

  if (withinWindow.length >= limit) {
    // Keep the trimmed list so memory does not grow, but do not record this
    // attempt — a blocked caller should not extend their own lockout.
    recentRequests.set(caller, withinWindow);
    const oldest = withinWindow[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
      limit,
    };
  }

  withinWindow.push(now);
  recentRequests.set(caller, withinWindow);

  // Occasionally clear out callers who have gone quiet, so the map does not
  // grow without bound on a long-running server.
  if (recentRequests.size > 1000) pruneIdleCallers(windowStart);

  return {
    allowed: true,
    remaining: limit - withinWindow.length,
    retryAfterSeconds: 0,
    limit,
  };
}

function pruneIdleCallers(windowStart: number): void {
  for (const [caller, times] of recentRequests) {
    if (times.every((at) => at <= windowStart)) recentRequests.delete(caller);
  }
}

/**
 * Works out who is calling.
 *
 * NOTE ON TRUST: `x-forwarded-for` is set by proxies and can be forged by a
 * caller when the app is reached directly. That is acceptable here because
 * this limit exists to stop accidental runaway usage and casual abuse, not a
 * determined attacker. If this is ever placed behind a real proxy, only that
 * proxy's value should be trusted.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // The first entry is the original client; the rest are proxies.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test helper: forget all recorded requests and any warning already given. */
export function resetRateLimits(): void {
  recentRequests.clear();
  warnedAboutValue = null;
}
