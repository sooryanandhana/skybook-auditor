/**
 * Tests for the PageSpeed check.
 *
 * Every one uses a fixture rather than the real API. Google's answers change
 * with real traffic, so a test hitting the network would pass and fail for
 * reasons that have nothing to do with our code — and would spend quota.
 *
 * What these are really guarding is the difference between three things that
 * look the same in a report if we are careless:
 *   - Google says this site is slow
 *   - Google has no data because too few people visit
 *   - we never got an answer
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createDeadline } from "./deadline.ts";
import {
  MAX_PAGESPEED_BYTES,
  RETRY_DELAY_MS,
  describeApiError,
  describeRequestError,
  isRetryableStatus,
  isTimeoutError,
  PAGESPEED_TIMEOUT_MS,
  looksLikePagespeedResult,
  missingFieldMetrics,
  performanceNotRequested,
  performanceUnavailable,
  readFieldData,
  readFieldUrl,
  readLabData,
  readLabUrl,
  readRating,
  readShiftMetric,
  readTimeMetric,
  runPerformanceChecks,
  sameAddress,
} from "./performanceChecks.ts";
import type { PerformanceData } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — trimmed copies of real PageSpeed response shapes
// ---------------------------------------------------------------------------

function labResult(overrides: Record<string, unknown> = {}) {
  return {
    lighthouseResult: {
      categories: { performance: { score: 0.62 } },
      audits: {
        "largest-contentful-paint": { numericValue: 4210.5 },
        "first-contentful-paint": { numericValue: 1820 },
        "total-blocking-time": { numericValue: 640 },
        "speed-index": { numericValue: 3100 },
        "cumulative-layout-shift": { numericValue: 0.08 },
      },
      ...overrides,
    },
  };
}

/** CLS arrives as a whole number 100x the real score: 12 means 0.12. */
function fieldMetrics() {
  return {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: "AVERAGE" },
    INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
    FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: "AVERAGE" },
    EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 700, category: "AVERAGE" },
  };
}

const QUOTA_ERROR = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com'.",
    status: "RESOURCE_EXHAUSTED",
  },
};

/**
 * A fetch that answers with one canned response and records the URL asked for.
 *
 * Builds a REAL Response rather than an object shaped like one, so the body is
 * a real stream. The size cap and the body-read timeout both live in the
 * streaming path, and a hand-rolled stub would step straight over them.
 */
function stubFetch(body: unknown, init: { status?: number; raw?: string } = {}) {
  const calls: string[] = [];
  const status = init.status ?? 200;
  const text = init.raw ?? JSON.stringify(body);
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * A fetch whose body arrives in pieces, and may fail part-way through.
 *
 * This is how a timeout during the body read is reproduced: the headers and
 * some bytes arrive, then the stream errors.
 */
function streamingFetch(chunks: string[], failWith?: Error) {
  return (async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        if (failWith) controller.error(failWith);
        else controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function run(
  body: unknown,
  options: {
    status?: number;
    apiKey?: string;
    budgetMs?: number;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    requestedUrl?: string;
  } = {},
): Promise<PerformanceData> {
  const stub = stubFetch(body, { status: options.status });
  return runPerformanceChecks(
    options.requestedUrl ?? "https://example.com/",
    createDeadline(options.budgetMs ?? 30_000),
    {
      apiKey: options.apiKey ?? "test-key",
      fetchImpl: options.fetchImpl ?? stub.impl,
      endpoint: "https://pagespeed.test/run",
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    },
  );
}

// ---------------------------------------------------------------------------
// 1. Field data available
// ---------------------------------------------------------------------------

test("field data available: reports real-visitor metrics as page-level", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: { overall_category: "AVERAGE", metrics: fieldMetrics() },
  });

  assert.equal(result.status, "checked");
  assert.equal(result.strategy, "mobile");
  assert.equal(result.field.status, "found");
  assert.equal(result.field.scope, "page");
  assert.equal(result.field.overall, "AVERAGE");
  assert.equal(result.field.error, null);

  assert.deepEqual(result.field.lcp, { percentileMs: 2900, category: "AVERAGE" });
  assert.deepEqual(result.field.inp, { percentileMs: 180, category: "FAST" });
  assert.deepEqual(result.field.fcp, { percentileMs: 1500, category: "AVERAGE" });
  assert.deepEqual(result.field.ttfb, { percentileMs: 700, category: "AVERAGE" });
});

test("field CLS is divided by 100, so 12 becomes 0.12 not a broken-looking page", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: { overall_category: "AVERAGE", metrics: fieldMetrics() },
  });

  assert.deepEqual(result.field.cls, { percentile: 0.12, category: "AVERAGE" });
});

test("field and lab stay separate: lab numbers never leak into the field section", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: { overall_category: "AVERAGE", metrics: fieldMetrics() },
  });

  // Field LCP comes from real visitors (2900), lab LCP from the simulation
  // (4210.5). If these two were ever merged, this is what would catch it.
  assert.equal(result.field.lcp?.percentileMs, 2900);
  assert.equal(result.lab.lcpMs, 4210.5);
});

// ---------------------------------------------------------------------------
// 2. No field data — must never read as "slow"
// ---------------------------------------------------------------------------

test("no field data: reports absent, with no metrics and no error", async () => {
  const result = await run(labResult());

  assert.equal(result.status, "checked");
  assert.equal(result.field.status, "absent");
  assert.equal(result.field.scope, null);
  assert.equal(result.field.overall, null);
  assert.equal(result.field.lcp, null);
  assert.equal(result.field.error, null);
});

test("no field data does not make the audit look like a speed problem", async () => {
  const result = await run(labResult());

  // The overall status is still "checked" and the lab half is intact — a quiet
  // site is not a failed check.
  assert.equal(result.status, "checked");
  assert.equal(result.lab.status, "found");
  assert.match(result.message, /too few recent visits/);
  assert.ok(
    result.notInspected.some((note) => note.includes("says nothing about how fast")),
    "the gap must be spelled out, not left for a reader to interpret",
  );
});

// ---------------------------------------------------------------------------
// 3. Origin-level field data
// ---------------------------------------------------------------------------

test("origin fallback flag: page-level block marked origin_fallback is scoped to origin", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: {
      overall_category: "SLOW",
      origin_fallback: true,
      metrics: fieldMetrics(),
    },
  });

  assert.equal(result.field.status, "found");
  assert.equal(result.field.scope, "origin");
  assert.match(result.message, /wider site/);
  assert.match(result.message, /not the requested page/);
});

test("origin-only data: falls back to originLoadingExperience and says so", async () => {
  const result = await run({
    ...labResult(),
    originLoadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  });

  assert.equal(result.field.status, "found");
  assert.equal(result.field.scope, "origin");
  assert.equal(result.field.overall, "FAST");
  assert.ok(
    result.notInspected.some((note) => note.includes("whole site")),
    "a site-wide figure must not be presented as this page's own",
  );
});

test("page data wins over origin data when both are present", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: {
      overall_category: "SLOW",
      metrics: {
        ...fieldMetrics(),
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 5000, category: "SLOW" },
      },
    },
    originLoadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  });

  assert.equal(result.field.scope, "page");
  assert.equal(result.field.overall, "SLOW");
  assert.equal(result.field.lcp?.percentileMs, 5000);
});

// ---------------------------------------------------------------------------
// 4. Malformed responses
// ---------------------------------------------------------------------------

test("malformed response: an empty object is an error, never absent field data", async () => {
  const result = await run({});

  assert.equal(result.status, "error");
  assert.equal(result.field.status, "error");
  assert.notEqual(
    result.field.status,
    "absent",
    "an unreadable reply must not be reported as a site with too few visitors",
  );
  assert.equal(result.lab.status, "error");
});

test("malformed response: null body is an error", async () => {
  const result = await run(null);

  assert.equal(result.status, "error");
  assert.equal(result.field.status, "error");
});

test("malformed response: unparseable JSON is an error", async () => {
  const stub = stubFetch(null, { raw: "<html>502 Bad Gateway</html>" });
  const result = await run(null, { fetchImpl: stub.impl });

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "unreadable-response");
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
});

test("malformed metrics: a metric missing its category is dropped, not guessed", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: {
      overall_category: "AVERAGE",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900 },
        INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      },
    },
  });

  assert.equal(result.field.status, "found");
  assert.equal(result.field.lcp, null, "half a metric is not a metric");
  assert.deepEqual(result.field.inp, { percentileMs: 180, category: "FAST" });
});

test("unknown rating values are refused rather than passed through", () => {
  assert.equal(readRating("FAST"), "FAST");
  assert.equal(readRating("VERY_FAST"), null);
  assert.equal(readRating(""), null);
  assert.equal(readRating(3), null);
  assert.equal(readRating(null), null);
});

// ---------------------------------------------------------------------------
// 5. API / quota errors
// ---------------------------------------------------------------------------

test("quota error: a 429 becomes an error that quotes Google's explanation", async () => {
  const result = await run(QUOTA_ERROR, { status: 429 });

  assert.equal(result.status, "error");
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
  assert.match(result.message, /usage limit was reached/);
  assert.match(result.message, /Quota exceeded/);
});

test("rejected key: a 403 says the key was refused", async () => {
  const result = await run({ error: { message: "API key not valid." } }, { status: 403 });

  assert.equal(result.status, "error");
  assert.match(result.message, /refused the API key/);
});

test("rejected address: a 400 says the address was rejected, not that the site is slow", async () => {
  const result = await run(
    { error: { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST." } },
    { status: 400 },
  );

  assert.equal(result.status, "error");
  assert.match(result.message, /rejected this address/);
  assert.match(result.message, /Speed was not measured/);
});

/**
 * Google's reply to an invalid key: a 400 INVALID_ARGUMENT whose structured
 * details name the reason. The same status a bad address gets.
 */
const INVALID_KEY_ERROR = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "API_KEY_INVALID",
        domain: "googleapis.com",
        metadata: { service: "pagespeedonline.googleapis.com" },
      },
    ],
  },
};

test("invalid key: a 400 Google marks API_KEY_INVALID blames the server's key, not the address", async () => {
  const result = await run(INVALID_KEY_ERROR, { status: 400 });

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "api-error");
  assert.match(result.message, /Speed was not measured/);
  assert.match(result.message, /refused this server's API key/);
  assert.doesNotMatch(result.message, /rejected this address/);
});

test("invalid key: the message never carries the key itself", async () => {
  const key = "offline-test-key-not-a-real-credential";
  const result = await run(INVALID_KEY_ERROR, { status: 400, apiKey: key });

  assert.ok(!JSON.stringify(result).includes(key));
});

test("a 400 with some other reason still says the address was rejected", () => {
  const otherReason = {
    error: {
      code: 400,
      message: "Invalid value for url.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "FIELD_INVALID" }],
    },
  };

  assert.match(describeApiError(400, otherReason), /rejected this address/);
  assert.match(describeApiError(400, { error: { code: 400, details: "API_KEY_INVALID" } }), /rejected this address/);
  assert.match(describeApiError(400, null), /rejected this address/);
});

test("the key reason does not override a usage limit", () => {
  const quotaWithKeyReason = { error: { code: 429, details: [{ reason: "API_KEY_INVALID" }] } };
  assert.match(describeApiError(429, quotaWithKeyReason), /usage limit was reached/);
});

test("an error status with no readable body still explains itself", () => {
  assert.match(describeApiError(500, null), /returned an error \(500\)/);
  assert.match(describeApiError(500, null), /Speed was not measured/);
});

// ---------------------------------------------------------------------------
// 6. Missing API key
// ---------------------------------------------------------------------------

test("missing API key: reported plainly, and no request is attempted", async () => {
  const stub = stubFetch(labResult());
  const result = await runPerformanceChecks("https://example.com/", createDeadline(30_000), {
    apiKey: "",
    fetchImpl: stub.impl,
  });

  assert.equal(result.status, "no-api-key");
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
  assert.match(result.message, /no PageSpeed API key is configured/);
  assert.equal(stub.calls.length, 0, "no key means no pointless network call");
});

test("a key of only whitespace counts as missing", async () => {
  const stub = stubFetch(labResult());
  const result = await runPerformanceChecks("https://example.com/", createDeadline(30_000), {
    apiKey: "   ",
    fetchImpl: stub.impl,
  });

  assert.equal(result.status, "no-api-key");
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Timeouts
// ---------------------------------------------------------------------------

test("timeout: an aborted request is reported as a timeout, not as a slow site", async () => {
  const impl = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await run(null, { fetchImpl: impl });

  assert.equal(result.status, "error");
  assert.equal(result.field.status, "error");
  assert.match(result.message, /did not finish in the time allowed/);
});

test("an already-expired deadline skips the request entirely", async () => {
  const stub = stubFetch(labResult());
  const result = await runPerformanceChecks("https://example.com/", createDeadline(0), {
    apiKey: "test-key",
    fetchImpl: stub.impl,
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /ran out of time/);
  assert.equal(stub.calls.length, 0);
});

test("a network failure reads differently from a timeout", () => {
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  assert.match(describeRequestError(aborted), /did not finish in the time allowed/);
  assert.match(describeRequestError(new TypeError("fetch failed")), /could not be reached/);
});

// ---------------------------------------------------------------------------
// 8. Lab data
// ---------------------------------------------------------------------------

test("lab data: score is scaled to 0-100 and each timing is read", async () => {
  const result = await run(labResult());

  assert.equal(result.lab.status, "found");
  assert.equal(result.lab.score, 62, "0.62 must be shown as 62, not 0.62");
  assert.equal(result.lab.lcpMs, 4210.5);
  assert.equal(result.lab.fcpMs, 1820);
  assert.equal(result.lab.tbtMs, 640);
  assert.equal(result.lab.speedIndexMs, 3100);
  assert.equal(result.lab.cls, 0.08);
  assert.equal(result.lab.error, null);
});

test("lab CLS is NOT scaled — only the field value is", async () => {
  const result = await run(labResult());

  // Lighthouse already reports a real CLS score. Dividing this one too would
  // turn 0.08 into 0.0008.
  assert.equal(result.lab.cls, 0.08);
});

// ---------------------------------------------------------------------------
// 9. Missing lab data
// ---------------------------------------------------------------------------

test("missing lab data: field data alone still produces a checked audit", async () => {
  const result = await run({
    loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  });

  assert.equal(result.status, "checked");
  assert.equal(result.field.status, "found");
  assert.equal(result.lab.status, "error");
  assert.equal(result.lab.score, null);
  assert.match(result.lab.error ?? "", /did not return a lab result/);
  assert.ok(result.notInspected.some((note) => note.includes("simulated page load")));
});

test("a Lighthouse runtime error is an error, not a score of zero", async () => {
  const result = await run({
    loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
    lighthouseResult: {
      runtimeError: {
        code: "ERRORED_DOCUMENT_REQUEST",
        message: "Lighthouse could not reliably load the page you requested.",
      },
      categories: { performance: { score: 0 } },
    },
  });

  assert.equal(result.lab.status, "error");
  assert.equal(result.lab.score, null, "a failed run must not be reported as a score of 0");
  assert.match(result.lab.error ?? "", /could not reliably load/);
});

test("a lighthouseResult with nothing readable in it is an error, not zeroes", () => {
  const lab = readLabData({ lighthouseResult: { categories: {}, audits: {} } });

  assert.equal(lab.status, "error");
  assert.equal(lab.score, null);
});

// ---------------------------------------------------------------------------
// The opt-in state, and the request we actually send
// ---------------------------------------------------------------------------

test("not requested: says so, and does not claim the site has no field data", () => {
  const result = performanceNotRequested("https://example.com/");

  assert.equal(result.status, "not-requested");
  assert.equal(
    result.field.status,
    "error",
    "we never looked, so this is not 'absent' either",
  );
  assert.equal(result.lab.status, "error");
  assert.match(result.message, /not measured/);
});

test("the request asks for mobile only, and escapes the address", async () => {
  const stub = stubFetch(labResult());
  await runPerformanceChecks("https://example.com/?a=1&b=2", createDeadline(30_000), {
    apiKey: "secret-key",
    fetchImpl: stub.impl,
    endpoint: "https://pagespeed.test/run",
  });

  assert.equal(stub.calls.length, 1);
  const sent = new URL(stub.calls[0]);
  assert.equal(sent.origin + sent.pathname, "https://pagespeed.test/run");
  assert.equal(sent.searchParams.get("strategy"), "mobile");
  assert.equal(sent.searchParams.get("category"), "performance");
  assert.equal(sent.searchParams.get("key"), "secret-key");
  // The whole address, "&b=2" included, must arrive as one parameter rather
  // than splitting into a second query parameter of our own request.
  assert.equal(sent.searchParams.get("url"), "https://example.com/?a=1&b=2");
});

test("the tested address is recorded in every outcome", async () => {
  const checked = await run(labResult());
  assert.equal(checked.requestedUrl, "https://example.com/");

  const failed = await run(QUOTA_ERROR, { status: 429 });
  assert.equal(failed.requestedUrl, "https://example.com/");

  assert.equal(performanceNotRequested("https://x.test/").requestedUrl, "https://x.test/");
});

// ---------------------------------------------------------------------------
// The readers, directly
// ---------------------------------------------------------------------------

test("looksLikePagespeedResult tells a real reply from a mangled one", () => {
  assert.equal(looksLikePagespeedResult({ lighthouseResult: {} }), true);
  assert.equal(looksLikePagespeedResult({ loadingExperience: {} }), true);
  assert.equal(looksLikePagespeedResult({ originLoadingExperience: {} }), true);
  assert.equal(looksLikePagespeedResult({}), false);
  assert.equal(looksLikePagespeedResult(null), false);
  assert.equal(looksLikePagespeedResult([]), false);
  assert.equal(looksLikePagespeedResult("ok"), false);
});

test("numbers arriving as strings are still read", () => {
  const metrics = {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: "2500", category: "AVERAGE" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: "25", category: "SLOW" },
  };

  assert.deepEqual(readTimeMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS"), {
    percentileMs: 2500,
    category: "AVERAGE",
  });
  assert.deepEqual(readShiftMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE"), {
    percentile: 0.25,
    category: "SLOW",
  });
});

test("a metric that is not an object is skipped", () => {
  assert.equal(readTimeMetric({ LARGEST_CONTENTFUL_PAINT_MS: 2500 }, "LARGEST_CONTENTFUL_PAINT_MS"), null);
  assert.equal(readTimeMetric(null, "LARGEST_CONTENTFUL_PAINT_MS"), null);
  assert.equal(readTimeMetric({}, "MISSING"), null);
});

test("an empty metrics object is absent field data, not found-with-nothing", () => {
  const field = readFieldData({
    lighthouseResult: {},
    loadingExperience: { overall_category: "FAST" },
  });

  assert.equal(field.status, "absent");
  assert.equal(field.overall, null, "no metrics means no verdict to report");
});

// ---------------------------------------------------------------------------
// Anchored to a real Google response
//
// The values below were observed from a live PageSpeed call for bbc.com on
// 3 September 2026, not invented. They exist because the CLS scaling was the
// one thing that could not be proved from the API reference alone, and getting
// it wrong would print a catastrophic-looking number for a healthy page.
// ---------------------------------------------------------------------------

test("real response: field CLS of 3 and lab CLS of 0.0307 agree once scaled", async () => {
  // Trimmed from the real reply. The full body is 1.4MB of Lighthouse audits.
  const real = {
    id: "https://www.bbc.com/",
    loadingExperience: {
      overall_category: "FAST",
      metrics: {
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 3, category: "FAST" },
        EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 339, category: "FAST" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 651, category: "FAST" },
        INTERACTION_TO_NEXT_PAINT: { percentile: 112, category: "FAST" },
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1139, category: "FAST" },
      },
    },
    lighthouseResult: {
      categories: { performance: { score: 0.3 } },
      audits: {
        "largest-contentful-paint": { numericValue: 16652.082835188387 },
        "cumulative-layout-shift": { numericValue: 0.030694094007491193 },
      },
    },
  };

  const field = readFieldData(real);
  const lab = readLabData(real);

  // The proof: Google reports the same measurement twice, in two scales.
  assert.equal(field.cls?.percentile, 0.03);
  assert.ok(
    Math.abs((field.cls?.percentile ?? 0) - (lab.cls ?? 0)) < 0.01,
    "scaled field CLS must land on the lab CLS; if it does not, the scale is wrong",
  );

  assert.equal(field.scope, "page");
  assert.equal(field.overall, "FAST");
  assert.equal(lab.score, 30);
});

test("real response: a FAST field rating can sit beside a poor lab score", async () => {
  // This is why the two are never merged. Real BBC visitors saw an LCP of
  // 1139ms; the throttled simulation saw 16652ms. Both numbers are true, and
  // a single blended "LCP" would have been true of nobody.
  const result = await run({
    loadingExperience: {
      overall_category: "FAST",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1139, category: "FAST" },
      },
    },
    lighthouseResult: {
      categories: { performance: { score: 0.3 } },
      audits: { "largest-contentful-paint": { numericValue: 16652.08 } },
    },
  });

  assert.equal(result.status, "checked");
  assert.equal(result.field.overall, "FAST");
  assert.equal(result.field.lcp?.percentileMs, 1139);
  assert.equal(result.lab.score, 30);
  assert.equal(result.lab.lcpMs, 16652.08);
});

// ===========================================================================
// FIX 1 — Google may measure a different URL than the one requested
//
// Confirmed against a live call: we asked for https://www.bbc.co.uk/ and
// Google reported on https://www.bbc.com/, a different domain. Attaching one
// site's Core Web Vitals to another site's name is a false claim, so the two
// addresses are now recorded separately and any difference is stated.
// ===========================================================================

test("no redirect: requested and measured addresses match", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://example.com/",
        categories: { performance: { score: 0.9 } },
        audits: { "largest-contentful-paint": { numericValue: 1200 } },
      },
      loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
    },
    { requestedUrl: "https://example.com/" },
  );

  assert.equal(result.status, "checked");
  assert.equal(result.requestedUrl, "https://example.com/");
  assert.equal(result.lab.measuredUrl, "https://example.com/");
  // Nothing redirected, so nothing should claim it did.
  assert.ok(!/redirect/.test(result.message));
  assert.ok(!result.notInspected.some((n) => n.includes("instead")));
});

test("redirect: the requested address is kept and Google's final URL recorded", async () => {
  const result = await run(
    {
      lighthouseResult: {
        requestedUrl: "https://www.bbc.co.uk/",
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.3 } },
        audits: { "largest-contentful-paint": { numericValue: 16652.08 } },
      },
      loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  // The original must survive — the rest of the audit is about this address.
  assert.equal(result.requestedUrl, "https://www.bbc.co.uk/");
  assert.equal(result.lab.measuredUrl, "https://www.bbc.com/");
});

test("redirect: the difference is stated in plain English, not just in a field", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.3 } },
        audits: { "largest-contentful-paint": { numericValue: 16652.08 } },
      },
      loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  // A human reading only the summary must still learn which site these
  // numbers belong to.
  assert.match(result.message, /https:\/\/www\.bbc\.com\//);
  assert.match(result.message, /redirects/);
  assert.ok(
    result.notInspected.some(
      (n) => n.includes("https://www.bbc.co.uk/") && n.includes("https://www.bbc.com/"),
    ),
    "notInspected must name both addresses",
  );
});

test("no usable final URL: measuredUrl is null rather than invented", async () => {
  // Field data only — Google returned no lighthouseResult, so it never said
  // what it loaded.
  const result = await run(
    { loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() } },
    { requestedUrl: "https://example.com/" },
  );

  assert.equal(result.status, "checked");
  assert.equal(result.requestedUrl, "https://example.com/");
  assert.equal(
    result.lab.measuredUrl,
    null,
    "silence from Google must not be read as confirmation",
  );
  assert.ok(
    result.notInspected.some((n) => n.includes("did not say")),
    "an unconfirmed address must be disclosed, not passed over",
  );
});

test("an empty or blank finalUrl counts as no answer", () => {
  assert.equal(readLabUrl({ lighthouseResult: { finalUrl: "" } }), null);
  assert.equal(readLabUrl({ lighthouseResult: { finalUrl: "   " } }), null);
  assert.equal(readLabUrl({ lighthouseResult: {} }), null);
  assert.equal(readLabUrl({}), null);
  assert.equal(readLabUrl(null), null);
  assert.equal(
    readLabUrl({ lighthouseResult: { finalUrl: "https://x.test/" } }),
    "https://x.test/",
  );
});

test("a trailing slash alone is not a redirect", () => {
  assert.equal(sameAddress("https://example.com", "https://example.com/"), true);
  assert.equal(sameAddress("https://example.com/", "https://example.com/"), true);
  assert.equal(sameAddress("https://www.bbc.co.uk/", "https://www.bbc.com/"), false);
  // Unparseable input falls back to plain comparison rather than throwing.
  assert.equal(sameAddress("not a url", "not a url"), true);
  assert.equal(sameAddress("not a url", "other"), false);
});

test("redirect: field and lab figures belong to the measured address", async () => {
  // The real BBC shape. Both halves describe bbc.com; only requestedUrl
  // mentions bbc.co.uk, and the notes say so.
  const result = await run(
    {
      lighthouseResult: {
        requestedUrl: "https://www.bbc.co.uk/",
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.3 } },
        audits: {
          "largest-contentful-paint": { numericValue: 16652.082835188387 },
          "cumulative-layout-shift": { numericValue: 0.030694094007491193 },
        },
      },
      loadingExperience: {
        overall_category: "FAST",
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1139, category: "FAST" },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 3, category: "FAST" },
        },
      },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  assert.equal(result.requestedUrl, "https://www.bbc.co.uk/");
  assert.equal(result.lab.measuredUrl, "https://www.bbc.com/");
  assert.equal(result.field.lcp?.percentileMs, 1139);
  assert.equal(result.field.cls?.percentile, 0.03);
  assert.equal(result.lab.score, 30);
  assert.equal(result.lab.lcpMs, 16652.082835188387);
});

test("a failed check names no measured address at all", async () => {
  const result = await run(QUOTA_ERROR, { status: 429, requestedUrl: "https://x.test/" });

  assert.equal(result.requestedUrl, "https://x.test/");
  assert.equal(
    result.lab.measuredUrl,
    null,
    "with no trustworthy answer we cannot say what Google looked at",
  );
});

// ===========================================================================
// FIX 2 — a timeout is not a malformed response
// ===========================================================================

test("timeout while reading the body is reported as a timeout", async () => {
  // Headers and part of the body arrive, then our clock runs out.
  const result = await run(null, {
    fetchImpl: streamingFetch(['{"lighthouseResult":{"finalUrl":"htt'], timeoutError()),
  });

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "timeout");
  assert.match(result.message, /did not finish in the time allowed/);
  assert.ok(
    !/could not be read/.test(result.message),
    "a timeout must not be described as an unreadable reply",
  );
});

test("a complete but unparseable body is reported as unreadable, not a timeout", async () => {
  const result = await run(null, {
    fetchImpl: streamingFetch(["<html>502 Bad Gateway</html>"]),
  });

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "unreadable-response");
  assert.ok(
    !/time/.test(result.message),
    "a garbled reply must not be described as a timeout",
  );
});

test("timeout and malformed response produce different results", async () => {
  const timedOut = await run(null, {
    fetchImpl: streamingFetch(['{"lighthouse'], timeoutError()),
  });
  const malformed = await run(null, {
    fetchImpl: streamingFetch(["not json at all"]),
  });

  assert.notEqual(timedOut.failureReason, malformed.failureReason);
  assert.notEqual(timedOut.message, malformed.message);
  assert.equal(timedOut.failureReason, "timeout");
  assert.equal(malformed.failureReason, "unreadable-response");
});

test("connection timeout and body-read timeout classify identically", async () => {
  // Thrown by fetch itself, before any body exists.
  const onConnect = await run(null, {
    fetchImpl: (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch,
  });

  // Thrown mid-stream, after headers arrived.
  const onRead = await run(null, {
    fetchImpl: streamingFetch(['{"lighthouseResult"'], timeoutError()),
  });

  assert.equal(onConnect.failureReason, "timeout");
  assert.equal(onRead.failureReason, "timeout");
  assert.equal(
    onConnect.message,
    onRead.message,
    "the same clock running out must read the same wherever it happens",
  );
});

test("an AbortError mid-read is a timeout too, not an unreadable reply", async () => {
  const aborted = new Error("aborted");
  aborted.name = "AbortError";

  const result = await run(null, {
    fetchImpl: streamingFetch(['{"lighthouse'], aborted),
  });

  assert.equal(result.failureReason, "timeout");
});

test("a non-timeout stream failure is unreadable, not a timeout", async () => {
  const result = await run(null, {
    fetchImpl: streamingFetch(['{"lighthouse'], new TypeError("network fell over")),
  });

  assert.equal(result.failureReason, "unreadable-response");
});

test("isTimeoutError only accepts the two abort names", () => {
  const timeout = new Error("x");
  timeout.name = "TimeoutError";
  const abort = new Error("x");
  abort.name = "AbortError";

  assert.equal(isTimeoutError(timeout), true);
  assert.equal(isTimeoutError(abort), true);
  assert.equal(isTimeoutError(new TypeError("fetch failed")), false);
  assert.equal(isTimeoutError("TimeoutError"), false);
  assert.equal(isTimeoutError(null), false);
});

// ===========================================================================
// FIX 3 — the reply is read under a size cap
// ===========================================================================

/** A valid, successful PageSpeed reply padded to a chosen size. */
function paddedResponse(padBytes: number) {
  return {
    lighthouseResult: {
      finalUrl: "https://example.com/",
      categories: { performance: { score: 0.9 } },
      audits: {
        "largest-contentful-paint": { numericValue: 1200 },
        // Stands in for the hundreds of audits a real reply carries.
        "screenshot-thumbnails": { details: "x".repeat(Math.max(0, padBytes)) },
      },
    },
    loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  };
}

test("a reply below the limit is read normally", async () => {
  const body = paddedResponse(1_000);
  const size = Buffer.byteLength(JSON.stringify(body));

  const result = await run(body, { maxBytes: size + 1_000 });

  assert.equal(result.status, "checked");
  assert.equal(result.failureReason, null);
  assert.equal(result.lab.score, 90);
});

test("a reply exactly at the limit is still read", async () => {
  const body = paddedResponse(1_000);
  const size = Buffer.byteLength(JSON.stringify(body));

  // The boundary is inclusive: the cap rejects what exceeds it, not what
  // reaches it. An off-by-one here would fail a legitimate audit.
  const result = await run(body, { maxBytes: size });

  assert.equal(result.status, "checked");
  assert.equal(result.lab.score, 90);
});

test("a reply one byte over the limit is refused", async () => {
  const body = paddedResponse(1_000);
  const size = Buffer.byteLength(JSON.stringify(body));

  const result = await run(body, { maxBytes: size - 1 });

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "response-too-large");
  assert.match(result.message, /larger than this tool will read/);
});

test("an oversized reply is never parsed, even though it is valid data", async () => {
  // This body WOULD produce a complete, successful result if it were parsed.
  // Getting the size error back instead is the proof that it was abandoned
  // mid-stream rather than read and then rejected.
  const body = paddedResponse(50_000);
  const size = Buffer.byteLength(JSON.stringify(body));

  const result = await run(body, { maxBytes: Math.floor(size / 2) });

  assert.equal(result.failureReason, "response-too-large");
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
  assert.equal(result.lab.score, null, "no measurement may survive an abandoned read");
  assert.equal(result.lab.measuredUrl, null);
});

test("too-large is its own cause, distinct from timeout and malformed", async () => {
  const body = paddedResponse(5_000);
  const size = Buffer.byteLength(JSON.stringify(body));

  const tooLarge = await run(body, { maxBytes: size - 1 });
  const timedOut = await run(null, {
    fetchImpl: streamingFetch(['{"a'], timeoutError()),
  });
  const malformed = await run(null, { fetchImpl: streamingFetch(["nonsense"]) });

  const reasons = [tooLarge, timedOut, malformed].map((r) => r.failureReason);
  assert.deepEqual(reasons, ["response-too-large", "timeout", "unreadable-response"]);
  assert.equal(new Set(reasons).size, 3, "three causes must stay three causes");
});

test("the default cap is generous enough for a real reply", () => {
  // A real bbc.co.uk reply measured 1.42 MB.
  assert.ok(
    MAX_PAGESPEED_BYTES > 1_420_000 * 2,
    "the cap must leave room above the largest reply actually observed",
  );
});

// ===========================================================================
// Failure states carry a machine-readable cause
// ===========================================================================

test("every failure state names its cause without anyone reading English", async () => {
  const noKey = await runPerformanceChecks("https://x.test/", createDeadline(30_000), {
    apiKey: "",
    fetchImpl: stubFetch(labResult()).impl,
  });
  assert.equal(noKey.failureReason, "no-api-key");

  const outOfTime = await runPerformanceChecks("https://x.test/", createDeadline(0), {
    apiKey: "k",
    fetchImpl: stubFetch(labResult()).impl,
  });
  assert.equal(outOfTime.failureReason, "out-of-time");

  const apiError = await run(QUOTA_ERROR, { status: 429 });
  assert.equal(apiError.failureReason, "api-error");

  const network = await run(null, {
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch,
  });
  assert.equal(network.failureReason, "network");
});

test("a successful check has no failure reason", async () => {
  const result = await run({
    ...labResult(),
    loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  });

  assert.equal(result.status, "checked");
  assert.equal(result.failureReason, null);
});

test("not-requested is not a failure", () => {
  const result = performanceNotRequested("https://x.test/");

  assert.equal(result.status, "not-requested");
  assert.equal(result.failureReason, null, "never asking is not the same as failing");
  assert.equal(result.lab.measuredUrl, null);
});

// ===========================================================================
// One automatic retry for transient Google failures
//
// Google's speed service returns 500 for reasons that have nothing to do with
// the site being audited — "Lighthouse returned error: Something went wrong"
// and Chrome protocol errors were both seen repeatedly in one session, on
// sites that succeeded moments later. One retry turns that into a working
// check instead of a report saying speed could not be measured.
//
// What these tests really guard is the boundary: exactly one retry, and only
// for faults where trying again could plausibly help.
// ===========================================================================

const SERVER_ERROR = {
  error: {
    code: 500,
    message: "Lighthouse returned error: Something went wrong.",
    status: "INTERNAL",
  },
};

function goodResponse() {
  return {
    lighthouseResult: {
      finalUrl: "https://example.com/",
      categories: { performance: { score: 0.9 } },
      audits: { "largest-contentful-paint": { numericValue: 1200 } },
    },
    loadingExperience: { overall_category: "FAST", metrics: fieldMetrics() },
  };
}

/**
 * A fetch that answers with a different response each call.
 *
 * When the list runs out the last entry repeats, so "always fails" can be
 * written without guessing how many attempts the code might make — which is
 * the point of the "never a third request" test.
 */
function sequenceFetch(steps: Array<{ status?: number; body?: unknown; raw?: string }>) {
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  let index = 0;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    calls.push({
      url: String(input),
      signal: (init?.signal as AbortSignal | undefined) ?? null,
    });
    const text = step.raw ?? JSON.stringify(step.body ?? null);
    return new Response(text, {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function runSeq(
  steps: Array<{ status?: number; body?: unknown; raw?: string }>,
  options: { budgetMs?: number; apiKey?: string; retryDelayMs?: number } = {},
) {
  const seq = sequenceFetch(steps);
  const deadline = createDeadline(options.budgetMs ?? 30_000);
  const promise = runPerformanceChecks("https://example.com/", deadline, {
    apiKey: options.apiKey ?? "test-key",
    fetchImpl: seq.impl,
    endpoint: "https://pagespeed.test/run",
    // Zero unless a test is specifically about the pause, so the suite does
    // not spend real time waiting.
    retryDelayMs: options.retryDelayMs ?? 0,
  });
  return { promise, calls: seq.calls, deadline };
}

// ---------------------------------------------------------------------------
// 1. A transient failure followed by success
// ---------------------------------------------------------------------------

test("500 then success: the retry succeeds and the result is a normal check", async () => {
  const { promise, calls } = runSeq([
    { status: 500, body: SERVER_ERROR },
    { status: 200, body: goodResponse() },
  ]);
  const result = await promise;

  assert.equal(calls.length, 2, "one failure and one retry");
  assert.equal(result.status, "checked");
  assert.equal(result.failureReason, null);
  assert.equal(result.lab.score, 90);
  assert.equal(result.field.status, "found");
  assert.equal(result.lab.measuredUrl, "https://example.com/");
});

test("a successful retry leaves no trace of the failure in the result", async () => {
  const { promise } = runSeq([
    { status: 500, body: SERVER_ERROR },
    { status: 200, body: goodResponse() },
  ]);
  const direct = runSeq([{ status: 200, body: goodResponse() }]);

  const retried = await promise;
  const firstTime = await direct.promise;

  // A measurement that took two attempts is still just a measurement. Nothing
  // in the report should imply otherwise, and nothing should be invented.
  assert.deepEqual(retried, firstTime);
  assert.ok(!/retr|500|error/i.test(retried.message));
});

// ---------------------------------------------------------------------------
// 2 & 3. The retry is bounded
// ---------------------------------------------------------------------------

test("500 then 500: the error stands and nothing is fabricated", async () => {
  const { promise, calls } = runSeq([
    { status: 500, body: SERVER_ERROR },
    { status: 500, body: SERVER_ERROR },
  ]);
  const result = await promise;

  assert.equal(calls.length, 2);
  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "api-error");
  assert.match(result.message, /Something went wrong/);
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
  assert.equal(result.lab.score, null);
  assert.equal(result.lab.measuredUrl, null);
});

test("a service failing every time is asked exactly twice, never a third time", async () => {
  // The stub repeats its last entry forever, so a loop would run away here.
  const { promise, calls } = runSeq([{ status: 500, body: SERVER_ERROR }]);
  await promise;

  assert.equal(calls.length, 2, "one retry means two requests in total");
});

test("every 5xx is retried once, and only once", async () => {
  for (const status of [500, 502, 503, 504]) {
    const { promise, calls } = runSeq([{ status, body: SERVER_ERROR }]);
    await promise;
    assert.equal(calls.length, 2, `status ${status} should be retried exactly once`);
  }
});

// ---------------------------------------------------------------------------
// 4-7. What must never be retried
// ---------------------------------------------------------------------------

test("403 is not retried — a rejected key is rejected twice", async () => {
  const { promise, calls } = runSeq([
    { status: 403, body: { error: { message: "API key not valid." } } },
  ]);
  const result = await promise;

  assert.equal(calls.length, 1);
  assert.equal(result.failureReason, "api-error");
  assert.match(result.message, /refused the API key/);
});

test("429 is not retried — asking again while over quota makes it worse", async () => {
  const { promise, calls } = runSeq([{ status: 429, body: QUOTA_ERROR }]);
  const result = await promise;

  assert.equal(calls.length, 1, "a quota error must not cost a second paid call");
  assert.match(result.message, /usage limit was reached/);
});

test("400 and 404 are not retried", async () => {
  for (const status of [400, 401, 404]) {
    const { promise, calls } = runSeq([{ status, body: { error: { message: "no" } } }]);
    await promise;
    assert.equal(calls.length, 1, `status ${status} must not be retried`);
  }
});

test("a missing API key is not retried, and costs no request at all", async () => {
  const { promise, calls } = runSeq([{ status: 200, body: goodResponse() }], {
    apiKey: "",
  });
  const result = await promise;

  assert.equal(calls.length, 0);
  assert.equal(result.failureReason, "no-api-key");
});

test("a timeout is not retried", async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts += 1;
    const error = new Error("aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks("https://example.com/", createDeadline(30_000), {
    apiKey: "k",
    fetchImpl: impl,
    endpoint: "https://pagespeed.test/run",
    retryDelayMs: 0,
  });

  assert.equal(attempts, 1, "our clock running out will not be fixed by asking again");
  assert.equal(result.failureReason, "timeout");
});

test("a malformed reply is not retried", async () => {
  const { promise, calls } = runSeq([{ status: 200, raw: "<html>not json</html>" }]);
  const result = await promise;

  assert.equal(calls.length, 1);
  assert.equal(result.failureReason, "unreadable-response");
});

test("an oversized reply is not retried", async () => {
  const seq = sequenceFetch([{ status: 200, body: goodResponse() }]);
  const size = Buffer.byteLength(JSON.stringify(goodResponse()));

  const result = await runPerformanceChecks("https://example.com/", createDeadline(30_000), {
    apiKey: "k",
    fetchImpl: seq.impl,
    endpoint: "https://pagespeed.test/run",
    maxBytes: size - 1,
    retryDelayMs: 0,
  });

  assert.equal(seq.calls.length, 1, "a reply too large once will be too large again");
  assert.equal(result.failureReason, "response-too-large");
});

test("an unreachable service is not retried", async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks("https://example.com/", createDeadline(30_000), {
    apiKey: "k",
    fetchImpl: impl,
    endpoint: "https://pagespeed.test/run",
    retryDelayMs: 0,
  });

  assert.equal(attempts, 1);
  assert.equal(result.failureReason, "network");
});

test("isRetryableStatus covers 5xx and nothing else", () => {
  for (const status of [500, 501, 502, 503, 504, 599]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
  }
  for (const status of [200, 400, 401, 403, 404, 429, 499, 600]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not be retryable`);
  }
});

// ---------------------------------------------------------------------------
// 8. The retry lives inside the existing deadline
// ---------------------------------------------------------------------------

test("no retry when too little of the audit is left", async () => {
  // Under the minimum the retry needs. A second attempt here would fail on
  // the clock and relabel a server error as a timeout — a worse answer than
  // the honest one already in hand.
  const { promise, calls } = runSeq([{ status: 500, body: SERVER_ERROR }], {
    budgetMs: 1_000,
  });
  const result = await promise;

  assert.equal(calls.length, 1, "the retry must not be attempted without time for it");
  assert.equal(result.failureReason, "api-error");
  assert.match(result.message, /Something went wrong/);
});

test("the retry spends the shared deadline rather than resetting it", async () => {
  const { promise, deadline } = runSeq(
    [
      { status: 500, body: SERVER_ERROR },
      { status: 200, body: goodResponse() },
    ],
    { budgetMs: 30_000, retryDelayMs: 50 },
  );

  await promise;

  const left = deadline.remainingMs();
  assert.ok(left < 30_000, "time must have been consumed, not restored");
  assert.ok(left > 0, "a short retry must not exhaust the audit");
});

test("both attempts get a signal derived from the same deadline", async () => {
  const { promise, calls } = runSeq([
    { status: 500, body: SERVER_ERROR },
    { status: 200, body: goodResponse() },
  ]);
  await promise;

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.signal instanceof AbortSignal, "every attempt must be cancellable");
  }
  assert.notEqual(
    calls[0].signal,
    calls[1].signal,
    "each attempt takes a fresh signal off the shared clock",
  );
});

test("the retry delay is short enough not to matter against the audit budget", () => {
  assert.ok(RETRY_DELAY_MS >= 250 && RETRY_DELAY_MS <= 500);
});

// ---------------------------------------------------------------------------
// 9. Nothing changes when the first attempt works
// ---------------------------------------------------------------------------

test("a successful first attempt makes exactly one request", async () => {
  const { promise, calls } = runSeq([{ status: 200, body: goodResponse() }]);
  const result = await promise;

  assert.equal(calls.length, 1, "a working check must never cost a second call");
  assert.equal(result.status, "checked");
  assert.equal(result.failureReason, null);
});

test("a check with no field data still makes only one request", async () => {
  // "absent" is a real answer, not a failure, so there is nothing to retry.
  const { promise, calls } = runSeq([
    {
      status: 200,
      body: {
        lighthouseResult: {
          finalUrl: "https://example.com/",
          categories: { performance: { score: 0.5 } },
          audits: { "largest-contentful-paint": { numericValue: 3000 } },
        },
      },
    },
  ]);
  const result = await promise;

  assert.equal(calls.length, 1);
  assert.equal(result.status, "checked");
  assert.equal(result.field.status, "absent");
});

// ===========================================================================
// Field and Lab addresses are read separately and never borrowed
//
// Google labels the two measurements separately: the lab run reports
// `lighthouseResult.finalUrl`, and the real-visitor block reports its own
// `id`. They normally agree, which is exactly why using one to label the other
// is dangerous — it would look right until the day it was not.
// ===========================================================================

const fieldMetric = {
  LARGEST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
};

test("lab: a redirect is reported from the lab run's own final URL", async () => {
  const result = await run(
    {
      lighthouseResult: {
        requestedUrl: "https://www.bbc.co.uk/",
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.3 } },
        audits: { "largest-contentful-paint": { numericValue: 16652.08 } },
      },
      loadingExperience: {
        id: "https://www.bbc.com/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  assert.equal(result.requestedUrl, "https://www.bbc.co.uk/");
  assert.equal(result.lab.measuredUrl, "https://www.bbc.com/");
  assert.equal(result.field.measuredUrl, "https://www.bbc.com/");
});

test("field: uses its own id and does NOT inherit the lab's final URL", async () => {
  // Forced apart on purpose. Whichever address is wrong, at least it is
  // Google's own wrong address rather than one we copied across.
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://lab-landed-here.test/",
        categories: { performance: { score: 0.7 } },
        audits: { "largest-contentful-paint": { numericValue: 2000 } },
      },
      loadingExperience: {
        id: "https://field-is-about-here.test/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://asked-for.test/" },
  );

  assert.equal(result.lab.measuredUrl, "https://lab-landed-here.test/");
  assert.equal(
    result.field.measuredUrl,
    "https://field-is-about-here.test/",
    "the field section must report the address Google filed it under",
  );
  assert.notEqual(result.field.measuredUrl, result.lab.measuredUrl);
});

test("origin field data takes its address from originLoadingExperience.id", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://www.shop.test/about",
        categories: { performance: { score: 0.7 } },
        audits: { "largest-contentful-paint": { numericValue: 2000 } },
      },
      originLoadingExperience: {
        id: "https://www.shop.test",
        overall_category: "AVERAGE",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://www.shop.test/about" },
  );

  assert.equal(result.field.scope, "origin");
  assert.equal(result.field.measuredUrl, "https://www.shop.test");
  assert.equal(result.lab.measuredUrl, "https://www.shop.test/about");
});

test("an origin_fallback block still uses its own id, not the lab URL", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://www.shop.test/deep/page",
        categories: { performance: { score: 0.4 } },
        audits: { "largest-contentful-paint": { numericValue: 5000 } },
      },
      loadingExperience: {
        id: "https://www.shop.test",
        origin_fallback: true,
        overall_category: "SLOW",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://www.shop.test/deep/page" },
  );

  assert.equal(result.field.scope, "origin");
  assert.equal(result.field.measuredUrl, "https://www.shop.test");
  assert.equal(result.lab.measuredUrl, "https://www.shop.test/deep/page");
});

test("a missing field id is null, never copied from the lab run", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://lab-knows.test/",
        categories: { performance: { score: 0.8 } },
        audits: { "largest-contentful-paint": { numericValue: 1500 } },
      },
      // No id on the field block.
      loadingExperience: { overall_category: "FAST", metrics: fieldMetric },
    },
    { requestedUrl: "https://asked-for.test/" },
  );

  assert.equal(result.field.status, "found");
  assert.equal(result.field.measuredUrl, null, "silence must stay silence");
  assert.equal(result.lab.measuredUrl, "https://lab-knows.test/");
  assert.ok(
    result.notInspected.some((n) => n.includes("real-visitor figures belong to")),
    "an unlabelled field section must disclose that it is unlabelled",
  );
});

test("a missing lab finalUrl is null, never copied from the field block", async () => {
  const result = await run(
    {
      lighthouseResult: {
        // No finalUrl.
        categories: { performance: { score: 0.8 } },
        audits: { "largest-contentful-paint": { numericValue: 1500 } },
      },
      loadingExperience: {
        id: "https://field-knows.test/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://asked-for.test/" },
  );

  assert.equal(result.lab.status, "found");
  assert.equal(result.lab.measuredUrl, null);
  assert.equal(result.field.measuredUrl, "https://field-knows.test/");
});

test("a failed lab run claims no address at all", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://tried-here.test/",
        runtimeError: { code: "ERRORED", message: "could not load the page" },
      },
      loadingExperience: {
        id: "https://field-knows.test/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://asked-for.test/" },
  );

  assert.equal(result.lab.status, "error");
  assert.equal(
    result.lab.measuredUrl,
    null,
    "a run that measured nothing measured no address",
  );
  assert.equal(result.field.measuredUrl, "https://field-knows.test/");
});

test("readLabUrl and readFieldUrl read different parts of the reply", () => {
  const body = {
    lighthouseResult: { finalUrl: "https://lab.test/" },
    loadingExperience: { id: "https://field.test/" },
  };

  assert.equal(readLabUrl(body), "https://lab.test/");
  assert.equal(readFieldUrl(body.loadingExperience), "https://field.test/");

  // Neither invents an address when its own source is silent.
  assert.equal(readLabUrl({ lighthouseResult: {} }), null);
  assert.equal(readLabUrl({ loadingExperience: { id: "https://field.test/" } }), null);
  assert.equal(readFieldUrl({}), null);
  assert.equal(readFieldUrl({ id: "  " }), null);
  assert.equal(readFieldUrl(null), null);
});

test("neither section's address leaks into a failed check", async () => {
  const result = await run(QUOTA_ERROR, { status: 429 });

  assert.equal(result.field.measuredUrl, null);
  assert.equal(result.lab.measuredUrl, null);
});

// ===========================================================================
// Origin-scoped real-visitor data cannot be mistaken for page data
// ===========================================================================

test("page-scoped field data is described as a page", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://shop.test/kettles",
        categories: { performance: { score: 0.8 } },
        audits: { "largest-contentful-paint": { numericValue: 1500 } },
      },
      loadingExperience: {
        id: "https://shop.test/kettles",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://shop.test/kettles" },
  );

  assert.equal(result.field.scope, "page");
  assert.match(result.message, /the page at https:\/\/shop\.test\/kettles/);
  assert.ok(
    !/wider site/.test(result.message),
    "page data must not be hedged as site data",
  );
});

test("origin-scoped field data says plainly that it is not the requested page", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://shop.test/kettles",
        categories: { performance: { score: 0.4 } },
        audits: { "largest-contentful-paint": { numericValue: 5000 } },
      },
      originLoadingExperience: {
        id: "https://shop.test",
        overall_category: "AVERAGE",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://shop.test/kettles" },
  );

  assert.equal(result.field.scope, "origin");
  assert.match(result.message, /wider site/);
  assert.match(result.message, /not the requested page/);
  // The wording must never imply the figures are about the page asked for.
  assert.ok(
    !/the page at https:\/\/shop\.test\/kettles.*AVERAGE/.test(result.message),
    "site-wide figures must not be attached to the requested page",
  );
  assert.ok(
    result.notInspected.some((n) => n.includes("not a measurement of the requested page")),
    "the gap must also be listed, not only worded around",
  );
});

test("redirect plus origin scope does not produce contradictory wording", async () => {
  // The real shape of the risk: bbc.co.uk redirects, and the field data is
  // site-wide. The message must not end up claiming site-wide figures describe
  // the redirected page.
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.35 } },
        audits: { "largest-contentful-paint": { numericValue: 16000 } },
      },
      originLoadingExperience: {
        id: "https://www.bbc.com",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  assert.equal(result.field.scope, "origin");
  assert.match(result.message, /wider site/);
  assert.match(result.message, /not the requested page/);
  // The redirect is still disclosed...
  assert.match(result.message, /redirects to https:\/\/www\.bbc\.com\//);
  // ...but nothing says the real-visitor figures describe that page.
  assert.ok(
    !/real-visitor experience of the page/.test(result.message),
    "origin data must never be worded as page data, redirect or not",
  );
});

test("the lab score is attributed to the address the simulation loaded", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://www.bbc.com/",
        categories: { performance: { score: 0.35 } },
        audits: { "largest-contentful-paint": { numericValue: 16000 } },
      },
      loadingExperience: {
        id: "https://www.bbc.com/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://www.bbc.co.uk/" },
  );

  assert.match(result.message, /simulated mobile load of https:\/\/www\.bbc\.com\/ scored 35/);
});

test("when the two halves land on different addresses, each is named separately", async () => {
  const result = await run(
    {
      lighthouseResult: {
        finalUrl: "https://lab.test/",
        categories: { performance: { score: 0.5 } },
        audits: { "largest-contentful-paint": { numericValue: 3000 } },
      },
      loadingExperience: {
        id: "https://field.test/",
        overall_category: "FAST",
        metrics: fieldMetric,
      },
    },
    { requestedUrl: "https://asked.test/" },
  );

  const notes = result.notInspected.join(" | ");
  assert.ok(notes.includes("https://lab.test/"), "the lab address must be named");
  assert.ok(notes.includes("https://field.test/"), "the field address must be named");
  assert.ok(
    !/Google measured https:\/\/lab\.test\/ instead\. Every figure/.test(notes),
    "no single address may be claimed for both halves when they disagree",
  );
});

// ===========================================================================
// An internal failure is our fault, and says so
// ===========================================================================

test("an unexpected internal failure reports internal-error, not unreadable-response", () => {
  const result = performanceUnavailable(
    "https://example.com/",
    "Speed was not measured: the speed check failed unexpectedly.",
  );

  assert.equal(result.status, "error");
  assert.equal(result.failureReason, "internal-error");
  assert.notEqual(
    result.failureReason,
    "unreadable-response",
    "our own bug must never be filed as bad data from Google",
  );
  assert.equal(result.field.measuredUrl, null);
  assert.equal(result.lab.measuredUrl, null);
});

test("a genuinely unreadable Google reply still reports unreadable-response", async () => {
  const result = await run(null, { fetchImpl: streamingFetch(["<html>nope</html>"]) });

  assert.equal(result.failureReason, "unreadable-response");
});

test("internal-error and unreadable-response stay distinct causes", async () => {
  const internal = performanceUnavailable("https://example.com/", "it broke");
  const unreadable = await run(null, { fetchImpl: streamingFetch(["not json"]) });

  assert.notEqual(internal.failureReason, unreadable.failureReason);
  assert.equal(internal.failureReason, "internal-error");
  assert.equal(unreadable.failureReason, "unreadable-response");
});

test("the human message and the machine reason agree about whose fault it was", () => {
  const result = performanceUnavailable(
    "https://example.com/",
    "Speed was not measured: the speed check failed unexpectedly.",
  );

  // The English blames the check; the code must blame the check too.
  assert.match(result.message, /failed unexpectedly/);
  assert.equal(result.failureReason, "internal-error");
});

// ===========================================================================
// The 90-second cap, and the retry that must not be affected by it
// ===========================================================================

test("the cap is 90 seconds, and a longer cap does not mean a longer retry", async () => {
  assert.equal(PAGESPEED_TIMEOUT_MS, 90_000);

  // Two attempts against a shared clock. The second takes what the first left
  // rather than a fresh 90 seconds — the cap is a ceiling, not an allowance
  // handed out per attempt.
  const deadline = createDeadline(95_000);
  const before = deadline.remainingMs();

  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Something went wrong." } }), {
      status: 500,
    });
  }) as unknown as typeof fetch;

  await runPerformanceChecks("https://example.com/", deadline, {
    apiKey: "k",
    fetchImpl: impl,
    endpoint: "https://ps.test/run",
    retryDelayMs: 0,
  });

  assert.equal(calls, 2, "still exactly two attempts");
  assert.ok(deadline.remainingMs() <= before, "the clock is shared, never reset");
});

test("a timeout is still a timeout under the longer cap, and is not retried", async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    const error = new Error("aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks(
    "https://example.com/",
    createDeadline(95_000),
    { apiKey: "k", fetchImpl: impl, endpoint: "https://ps.test/run", retryDelayMs: 0 },
  );

  assert.equal(calls, 1, "our clock running out will not be fixed by asking again");
  assert.equal(result.failureReason, "timeout");
  assert.equal(result.status, "error");
  // The point of the whole classification: a slow Google is not a slow site.
  assert.ok(!/slow/i.test(result.message));
});

test("a body-read timeout is still a timeout, not a malformed reply", async () => {
  const impl = (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"lighthouseResult"'));
        const error = new Error("aborted");
        error.name = "TimeoutError";
        controller.error(error);
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks(
    "https://example.com/",
    createDeadline(95_000),
    { apiKey: "k", fetchImpl: impl, endpoint: "https://ps.test/run" },
  );

  assert.equal(result.failureReason, "timeout");
});

test("the opt-in message no longer claims the check delays the audit", () => {
  const result = performanceNotRequested("https://example.com/");

  assert.match(result.message, /90 seconds/);
  assert.ok(
    !/add a minute to an audit/.test(result.message),
    "the speed check runs separately now and no longer delays anything",
  );
});

// ===========================================================================
// Missing field metrics are named, never left as a blank
// ===========================================================================

/** A field block carrying only the metrics named. */
function fieldWith(present: Record<string, { percentile: number; category: string }>) {
  return {
    lighthouseResult: {
      finalUrl: "https://example.com/",
      categories: { performance: { score: 0.9 } },
      audits: { "largest-contentful-paint": { numericValue: 1200 } },
    },
    loadingExperience: {
      id: "https://example.com/",
      overall_category: "FAST",
      metrics: present,
    },
  };
}

const ALL_FIVE = {
  LARGEST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
  INTERACTION_TO_NEXT_PAINT: { percentile: 80, category: "FAST" },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 4, category: "FAST" },
  FIRST_CONTENTFUL_PAINT_MS: { percentile: 700, category: "FAST" },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 300, category: "FAST" },
};

test("a complete field section gains no missing-metric notes", async () => {
  const result = await run(fieldWith(ALL_FIVE));

  assert.equal(result.status, "checked");
  assert.equal(result.field.status, "found");
  assert.equal(
    result.notInspected.filter((n) => n.includes("did not report this metric")).length,
    0,
    "nothing is missing, so nothing may be listed as missing",
  );
});

test("a complete field section is unchanged by this fix", async () => {
  const result = await run(fieldWith(ALL_FIVE));

  // The existing successful shape, metric for metric.
  assert.deepEqual(result.field.lcp, { percentileMs: 900, category: "FAST" });
  assert.deepEqual(result.field.inp, { percentileMs: 80, category: "FAST" });
  assert.deepEqual(result.field.cls, { percentile: 0.04, category: "FAST" });
  assert.deepEqual(result.field.fcp, { percentileMs: 700, category: "FAST" });
  assert.deepEqual(result.field.ttfb, { percentileMs: 300, category: "FAST" });
  assert.equal(result.field.status, "found");
});

/** Each metric, dropped one at a time. */
const ONE_MISSING: Array<[string, keyof typeof ALL_FIVE, string, string]> = [
  ["LCP", "LARGEST_CONTENTFUL_PAINT_MS", "lcp", "Largest Contentful Paint"],
  ["INP", "INTERACTION_TO_NEXT_PAINT", "inp", "Interaction to Next Paint"],
  ["CLS", "CUMULATIVE_LAYOUT_SHIFT_SCORE", "cls", "Cumulative Layout Shift"],
  ["FCP", "FIRST_CONTENTFUL_PAINT_MS", "fcp", "First Contentful Paint"],
  ["TTFB", "EXPERIMENTAL_TIME_TO_FIRST_BYTE", "ttfb", "Time to First Byte"],
];

for (const [short, apiKey, field, longName] of ONE_MISSING) {
  test(`missing ${short}: null in the data, and named in notInspected`, async () => {
    const metrics = { ...ALL_FIVE };
    delete (metrics as Record<string, unknown>)[apiKey];

    const result = await run(fieldWith(metrics as typeof ALL_FIVE));

    // Still a good field section — one absent metric is not a broken one.
    assert.equal(result.status, "checked");
    assert.equal(result.field.status, "found");
    assert.equal(result.field.overall, "FAST");

    const value = (result.field as unknown as Record<string, unknown>)[field];
    assert.equal(value, null, `${short} must stay null`);
    assert.notEqual(value, 0, `${short} must never become zero`);

    assert.ok(
      result.notInspected.some((n) => n.includes(longName)),
      `${short} must be named in notInspected`,
    );
    assert.ok(
      result.notInspected.some(
        (n) => n.includes(longName) && n.includes("missing figure, not a poor one"),
      ),
      "the note must not imply the site failed the metric",
    );
  });
}

test("several missing metrics are each listed separately", async () => {
  const result = await run(
    fieldWith({
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 700, category: "FAST" },
    } as typeof ALL_FIVE),
  );

  assert.equal(result.field.status, "found");
  assert.equal(result.field.inp, null);
  assert.equal(result.field.cls, null);
  assert.equal(result.field.ttfb, null);

  const named = result.notInspected.filter((n) => n.includes("did not report this metric"));
  assert.equal(named.length, 3, "one note per missing metric, not one for all of them");
  assert.ok(named.some((n) => n.includes("Interaction to Next Paint")));
  assert.ok(named.some((n) => n.includes("Cumulative Layout Shift")));
  assert.ok(named.some((n) => n.includes("Time to First Byte")));
});

test("missing metrics never turn a valid field section into an error", async () => {
  // Only one metric survives. That is thin data, not bad data.
  const result = await run(
    fieldWith({
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
    } as typeof ALL_FIVE),
  );

  assert.equal(result.field.status, "found");
  assert.notEqual(result.field.status, "error");
  assert.notEqual(result.field.status, "absent");
  assert.equal(result.status, "checked");
});

test("missingFieldMetrics stays quiet when there is no field data to describe", () => {
  const absent = {
    status: "absent" as const,
    measuredUrl: null,
    scope: null,
    overall: null,
    lcp: null,
    inp: null,
    cls: null,
    fcp: null,
    ttfb: null,
    error: null,
  };

  // "No data at all" is already said once. Listing five missing metrics
  // underneath would be noise, and would read as five separate faults.
  assert.deepEqual(missingFieldMetrics(absent), []);
  assert.deepEqual(missingFieldMetrics({ ...absent, status: "error" }), []);
});

test("missingFieldMetrics names every gap when the section is sound", () => {
  const found = {
    status: "found" as const,
    measuredUrl: "https://example.com/",
    scope: "page" as const,
    overall: "FAST" as const,
    lcp: { percentileMs: 900, category: "FAST" as const },
    inp: null,
    cls: null,
    fcp: null,
    ttfb: null,
    error: null,
  };

  const notes = missingFieldMetrics(found);
  assert.equal(notes.length, 4);
  assert.ok(!notes.some((n) => n.includes("Largest Contentful Paint")));
});
