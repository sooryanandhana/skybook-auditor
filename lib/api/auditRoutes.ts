/**
 * What the audit endpoints actually do, with no framework around it.
 *
 * WHY THIS FILE EXISTS. The route handlers under app/api used to hold their
 * own logic — the rate-limit check, the body parsing, the URL validation, the
 * status codes. None of it could be tested: a Next.js route imports
 * `next/server`, which will not load outside the framework, so every attempt
 * to drive a handler from a test failed at the import. The result was 247
 * lines of production code with no test touching it, and one test that
 * reproduced a route's logic alongside it — which is worse than no test,
 * because the copy can agree with itself while the route drifts away.
 *
 * So the decisions live here, in plain functions over a plain `Request`, and
 * each route file is now a two-line adapter that calls one of them and wraps
 * the answer in a NextResponse. There is exactly one implementation, the
 * routes use it, and the tests use the same one.
 *
 * WHAT IS DELIBERATELY NOT INJECTABLE: the rate limiter, `normalizeUrl`, and
 * every safety boundary underneath them. A test that could swap the limiter
 * out would prove nothing about whether the endpoint is protected, so the
 * tests reset the real limiter and then use it. Only the slow, external things
 * are injectable — the crawl and the PageSpeed call — and their production
 * defaults are the real ones.
 */
import { runPerformanceChecks } from "../collector/performanceChecks.ts";
import { normalizeUrl } from "../collector/url.ts";
import { createDeadline } from "../collector/deadline.ts";
import { callerKey, checkRateLimit, type RateLimitResult } from "../rateLimit.ts";
import { runRules } from "../rules/runner.ts";
import { SPEED_RULES } from "../rules/all.ts";
import { PERFORMANCE_BUDGET_MS } from "../budgets.ts";
import { auditJobs, startAudit, type AuditJobStore, type StartAuditOptions } from "../jobs/auditJobs.ts";
import { statusAnswer, resultAnswer } from "../jobs/jobResponses.ts";
import type {
  SpeedResult,
  AuditResultResponse,
  AuditStartResponse,
  AuditStatusResponse,
  PerformanceResponse,
} from "../types";

/**
 * One HTTP answer, before a framework turns it into a Response.
 *
 * Status and headers are part of the answer rather than something the adapter
 * decides, so the 429's Retry-After and the 202 on a created job are testable
 * facts about the handler and not about Next.js.
 */
export interface ApiResult<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

/** The refusal every rate-limited endpoint gives, worded and shaped once. */
function tooManyRequests<T>(limit: RateLimitResult): ApiResult<T> {
  return {
    status: 429,
    body: {
      ok: false,
      error: `Too many audits in a short time. Please wait ${limit.retryAfterSeconds} seconds and try again.`,
    } as T,
    headers: {
      "Retry-After": String(limit.retryAfterSeconds),
      "X-RateLimit-Limit": String(limit.limit),
      "X-RateLimit-Remaining": "0",
    },
  };
}

/**
 * The address out of a JSON body, or the refusal to send back instead.
 *
 * Shared by the two endpoints that take a URL, because they accept exactly the
 * same thing and any difference between them would be a bug rather than a
 * feature. Validation is `normalizeUrl` — the audit's own parser — so these
 * endpoints accept what the audit accepts and nothing more. It is what refuses
 * a "javascript:" or "file:" address before anything else sees it.
 */
async function readUrl<T>(
  request: Request,
): Promise<{ ok: true; url: string } | { ok: false; refusal: ApiResult<T> }> {
  let raw: string;
  try {
    const body = await request.json();
    raw = typeof body?.url === "string" ? body.url.trim() : "";
  } catch {
    return {
      ok: false,
      refusal: { status: 400, body: { ok: false, error: "Could not read the request." } as T },
    };
  }

  if (!raw) {
    return {
      ok: false,
      refusal: { status: 400, body: { ok: false, error: "Please enter a website address." } as T },
    };
  }

  const normalized = normalizeUrl(raw);
  if (!normalized.ok) {
    return {
      ok: false,
      refusal: { status: 400, body: { ok: false, error: normalized.reason } as T },
    };
  }

  return { ok: true, url: normalized.url.toString() };
}

/** The `jobId` query parameter, trimmed. Empty when absent. */
function jobIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
}

/**
 * POST /api/audit — start an audit and hand back a receipt.
 *
 * The rate limit is checked before a job exists, so a caller over the limit
 * costs us nothing. The answer is 202 rather than 200: accepted, not done.
 */
export async function startAuditRoute(
  request: Request,
  deps: Pick<StartAuditOptions, "store" | "runImpl"> = {},
): Promise<ApiResult<AuditStartResponse>> {
  const limit = checkRateLimit(callerKey(request));
  if (!limit.allowed) return tooManyRequests<AuditStartResponse>(limit);

  const url = await readUrl<AuditStartResponse>(request);
  if (!url.ok) return url.refusal;

  const { jobId } = startAudit(url.url, deps);

  return { status: 202, body: { ok: true, jobId } };
}

/**
 * GET /api/audit/status — how a running audit is getting on.
 *
 * Counts only. There is no percentage because there is no honest denominator:
 * a crawl discovers more of a site as it reads it.
 */
export function auditStatusRoute(
  request: Request,
  deps: { store?: StartAuditOptions["store"] } = {},
): ApiResult<AuditStatusResponse> {
  const store = deps.store ?? auditJobs();
  const jobId = jobIdFrom(request);
  const answer = statusAnswer(jobId, store.get(jobId));

  return { status: answer.status, body: answer.body };
}

/**
 * GET /api/audit/result — the finished audit, and only ever a finished one.
 *
 * A job still running is refused rather than answered with a half-built
 * report.
 */
export function auditResultRoute(
  request: Request,
  deps: { store?: StartAuditOptions["store"] } = {},
): ApiResult<AuditResultResponse> {
  const store = deps.store ?? auditJobs();
  const jobId = jobIdFrom(request);
  const answer = resultAnswer(jobId, store.get(jobId));

  return { status: answer.status, body: answer.body };
}

/**
 * POST /api/audit/performance — Google PageSpeed for one address.
 *
 * SEPARATE FROM /api/audit because Google routinely takes 30-90 seconds, and
 * the rest of the audit should not wait behind it.
 *
 * SHARES ONE ALLOWANCE with /api/audit, deliberately: this endpoint spends a
 * paid Google quota, and a second bucket would double what one caller can
 * spend.
 *
 * NO NEW SSRF SURFACE. The address is never fetched here. It travels as a
 * parameter to Google's fixed endpoint, and Google does the loading.
 */
export async function performanceRoute(
  request: Request,
  deps: { measure?: typeof runPerformanceChecks; store?: AuditJobStore } = {},
): Promise<ApiResult<PerformanceResponse>> {
  const limit = checkRateLimit(callerKey(request));
  if (!limit.allowed) return tooManyRequests<PerformanceResponse>(limit);

  const url = await readUrl<PerformanceResponse>(request);
  if (!url.ok) return url.refusal;

  const measure = deps.measure ?? runPerformanceChecks;

  /*
   * The collector returns its failures rather than throwing, so a bad minute
   * at Google becomes a PerformanceData that explains itself — including the
   * case where no API key is configured, which is reported and not an error.
   * The catch guards against a future change breaking that promise.
   */
  try {
    const performance = await measure(url.url, createDeadline(PERFORMANCE_BUDGET_MS));

    /*
     * Graded here, on the server, by the same engine the audit uses. The speed
     * measurements exist only in this request, so this is the only place that
     * can grade them; the browser receives findings and no means of making one.
     *
     * Only the speed rules run. The other measurements are not in this request,
     * and inventing empty ones to satisfy a wider rule set would be fabricating
     * facts to make a signature fit.
     */
    const graded = runRules({ performance }, SPEED_RULES);

    const speed: SpeedResult = {
      data: performance,
      findings: graded.findings,
      skippedChecks: graded.skipped,
    };

    /*
     * Kept beside the audit it belongs to, when the caller named one.
     *
     * The browser already receives this and always has. Storing it too is what
     * lets the SERVER describe a whole audit — speed included — without ever
     * being handed one back by a client. Anything built from a client's copy
     * could be built from a client's invention.
     *
     * Best-effort on purpose: an unknown, expired or unfinished job simply
     * takes no attachment, and the speed answer is returned either way. A
     * failure to file something away is not a reason to withhold a
     * measurement that succeeded.
     */
    const jobId = jobIdFrom(request);
    if (jobId !== "") (deps.store ?? auditJobs()).attach(jobId, speed);

    return { status: 200, body: { ok: true, ...speed } };
  } catch {
    return {
      status: 500,
      body: { ok: false, error: "The speed check failed unexpectedly." },
    };
  }
}
