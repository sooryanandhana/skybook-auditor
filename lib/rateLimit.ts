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
const DEFAULT_LIMIT = 10;
const WINDOW_MS = 60_000;

/**
 * The limit can be raised for local development, where a person testing by
 * hand may legitimately run more than ten audits in a minute.
 */
function configuredLimit(): number {
  const fromEnv = Number(process.env.AUDIT_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LIMIT;
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

/** Test helper: forget all recorded requests. */
export function resetRateLimits(): void {
  recentRequests.clear();
}
