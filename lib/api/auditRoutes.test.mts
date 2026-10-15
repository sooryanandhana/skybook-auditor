/**
 * Tests for the audit endpoints — the real ones.
 *
 * These call the same functions the route files call. There is no copy of the
 * route logic here and there must never be one: a copy agrees with itself
 * while the route drifts away from it, and reports success the whole time.
 *
 * THE RATE LIMITER IS THE REAL ONE. It is deliberately not injectable, because
 * a test that could swap it out would prove nothing about whether the endpoint
 * is protected. Each test resets it and then uses it.
 *
 * Nothing here reaches the network: the crawl and the PageSpeed call are the
 * only injected pieces, and their production defaults are the real ones.
 */
import { strict as assert } from "node:assert";
import test, { beforeEach } from "node:test";
import {
  startAuditRoute,
  auditStatusRoute,
  auditResultRoute,
  performanceRoute,
  explainRoute,
  EXPLAIN_IN_PROGRESS,
  EXPLAIN_NOT_FINISHED,
  EXPLAIN_NO_PAGE_MEASUREMENTS,
} from "./auditRoutes.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { AI_CONTRACT_VERSION } from "../ai/contract.ts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import type { Finding } from "../types.ts";
import { JOB_TTL_MS } from "../jobs/jobStore.ts";
import { resetRateLimits, DEFAULT_LIMIT, GLOBAL_LIMIT } from "../rateLimit.ts";
import { runSeoChecks } from "../collector/seoChecks.ts";
import { runSecurityChecks } from "../collector/securityChecks.ts";
import type { AuditResult, PerformanceData, SiteAuditResult, SpeedResult } from "../types.ts";
import { withSpeed } from "../audit/withSpeed.ts";
import { buildAIReportInput } from "../ai/buildReportInput.ts";

beforeEach(() => {
  resetRateLimits();
});

// ---------------------------------------------------------------------------
// Requests, as the browser makes them
// ---------------------------------------------------------------------------

const postJson = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://audit.test/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const getWith = (query: string) =>
  new Request(`https://audit.test/api/audit/status?${query}`);

/** A stand-in audit, so no test crawls anything. */
const auditReturning = (complete: boolean): (() => Promise<SiteAuditResult>) =>
  async () =>
    ({
      data: { seo: runSeoChecks("<html><head></head><body><p>x</p></body></html>") },
      site: { findings: [], skippedChecks: [], evaluatedPages: 1 },
      pages: [],
      crawl: { complete, stoppedBecause: complete ? "completed" : "max-pages" },
    }) as unknown as SiteAuditResult;

// ---------------------------------------------------------------------------
// POST /api/audit
// ---------------------------------------------------------------------------

test("a valid request is accepted with 202 and a job id", async () => {
  const store = createJobStore<SiteAuditResult>();

  const result = await startAuditRoute(postJson({ url: "https://example.com" }), {
    store,
    runImpl: auditReturning(true),
  });

  // 202, not 200: accepted, not done. Nothing has been measured yet.
  assert.equal(result.status, 202);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.ok && typeof result.body.jobId === "string");
  assert.ok(result.body.ok && result.body.jobId.length > 0);

  // The job really exists, rather than an id being invented.
  assert.ok(result.body.ok && store.get(result.body.jobId) !== null);
});

test("the address is normalised before the job is created", async () => {
  const store = createJobStore<SiteAuditResult>();

  const result = await startAuditRoute(postJson({ url: "  EXAMPLE.com/Path  " }), {
    store,
    runImpl: auditReturning(true),
  });

  assert.equal(result.status, 202);
  const job = result.body.ok ? store.get(result.body.jobId) : null;
  assert.ok(job);
  // Trimmed, given a scheme, and lower-cased in the host — but the path's case
  // is left alone, because a server is entitled to care about it.
  assert.equal(job.requestedUrl, "https://example.com/Path");
});

test("a body that is not JSON is refused, not crashed on", async () => {
  const result = await startAuditRoute(postJson("{not json"), {
    store: createJobStore<SiteAuditResult>(),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.ok === false ? result.body.error : "", /Could not read the request/);
});

test("a missing or unusable url is refused", async () => {
  const store = createJobStore<SiteAuditResult>();

  for (const body of [{}, { url: "" }, { url: "   " }, { url: 12345 }, { url: null }]) {
    const result = await startAuditRoute(postJson(body), { store });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.ok, false);
    assert.match(
      result.body.ok === false ? result.body.error : "",
      /Please enter a website address/,
      JSON.stringify(body),
    );
  }
});

test("an address the audit would refuse is refused here first", async () => {
  /*
   * The same parser the audit uses, so this endpoint accepts exactly what the
   * audit accepts and no more. A scheme like javascript: or file: never gets
   * as far as a job.
   */
  const store = createJobStore<SiteAuditResult>();

  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url", "http://"]) {
    const result = await startAuditRoute(postJson({ url }), { store });
    assert.equal(result.status, 400, url);
    assert.equal(result.body.ok, false, url);
  }
});

test("a refused address creates no job at all", async () => {
  const store = createJobStore<SiteAuditResult>();
  await startAuditRoute(postJson({ url: "javascript:alert(1)" }), { store });

  // Nothing to poll, nothing occupying a slot, nothing to expire.
  assert.equal(store.get("any"), null);
});

// ---------------------------------------------------------------------------
// The real rate limiter, reached through the real route
// ---------------------------------------------------------------------------

test("the route refuses a caller who is over their own limit", async () => {
  const store = createJobStore<SiteAuditResult>();
  const send = () =>
    startAuditRoute(postJson({ url: "https://example.com" }, { "x-forwarded-for": "198.51.100.5" }), {
      store,
      runImpl: auditReturning(true),
    });

  for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
    assert.equal((await send()).status, 202, `request ${i + 1}`);
  }

  const refused = await send();
  assert.equal(refused.status, 429);
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.ok === false ? refused.body.error : "", /Too many audits/);
});

test("a 429 carries the headers a client needs to back off", async () => {
  const store = createJobStore<SiteAuditResult>();
  const send = () =>
    startAuditRoute(postJson({ url: "https://example.com" }, { "x-forwarded-for": "198.51.100.6" }), {
      store,
      runImpl: auditReturning(true),
    });

  for (let i = 0; i < DEFAULT_LIMIT; i += 1) await send();
  const refused = await send();

  const retryAfter = Number(refused.headers?.["Retry-After"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${retryAfter}`);
  assert.equal(refused.headers?.["X-RateLimit-Limit"], String(DEFAULT_LIMIT));
  assert.equal(refused.headers?.["X-RateLimit-Remaining"], "0");
});

test("the route cannot be freed by changing X-Forwarded-For", async () => {
  /*
   * The header is client-controlled, so each of these looks like a new caller
   * and never reaches a per-caller limit. The global ceiling is what stops it,
   * and this proves the endpoint is behind that ceiling rather than merely
   * that the limiter has one.
   */
  const store = createJobStore<SiteAuditResult>();
  let accepted = 0;

  for (let i = 0; i < 60; i += 1) {
    const result = await startAuditRoute(
      postJson({ url: "https://example.com" }, { "x-forwarded-for": `203.0.113.${i}` }),
      { store, runImpl: auditReturning(true) },
    );
    if (result.status === 202) accepted += 1;
  }

  // Default posture: the header is not trusted, so every rotated request is the
  // one shared bucket and the per-caller limit stops it well short.
  assert.equal(accepted, DEFAULT_LIMIT);
});

test("behind a trusted proxy, distinct callers are bounded by the global ceiling", async () => {
  // The ceiling still exists and still bites; it just now takes genuinely
  // distinct trusted addresses to reach, not a header a client rewrites.
  const store = createJobStore<SiteAuditResult>();
  let accepted = 0;

  for (let i = 0; i < 60; i += 1) {
    const result = await startAuditRoute(
      postJson({ url: "https://example.com" }, { "cf-connecting-ip": `203.0.113.${i}` }),
      { store, runImpl: auditReturning(true), trustProxy: true },
    );
    if (result.status === 202) accepted += 1;
  }

  assert.equal(accepted, GLOBAL_LIMIT);
});

test("behind a trusted proxy, a forged X-Forwarded-For under one CF-Connecting-IP is one caller", async () => {
  // Cloudflare appends to a client's X-Forwarded-For, so rotating its first
  // entry costs nothing. The route keys on CF-Connecting-IP, so it buys nothing.
  const store = createJobStore<SiteAuditResult>();
  let accepted = 0;
  let last: Awaited<ReturnType<typeof startAuditRoute>> | undefined;

  for (let i = 0; i < 60; i += 1) {
    last = await startAuditRoute(
      postJson({ url: "https://example.com" }, { "cf-connecting-ip": "198.51.100.40", "x-forwarded-for": `203.0.113.${i}` }),
      { store, runImpl: auditReturning(true), trustProxy: true },
    );
    if (last.status === 202) accepted += 1;
  }

  assert.equal(accepted, DEFAULT_LIMIT);
  assert.equal(last?.headers?.["X-RateLimit-Limit"], String(DEFAULT_LIMIT), "the caller's own limit, not the ceiling");
});

test("the limit is checked before the body is read", async () => {
  // A caller over the limit costs us nothing — not even parsing their request.
  const store = createJobStore<SiteAuditResult>();
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
    await startAuditRoute(postJson({ url: "https://example.com" }, { "x-forwarded-for": "198.51.100.7" }), {
      store,
      runImpl: auditReturning(true),
    });
  }

  const refused = await startAuditRoute(postJson("{not json", { "x-forwarded-for": "198.51.100.7" }), { store });

  // 429, not the 400 the broken body would otherwise have earned.
  assert.equal(refused.status, 429);
});

// ---------------------------------------------------------------------------
// GET /api/audit/status
// ---------------------------------------------------------------------------

test("status: no job id is a bad request", () => {
  const store = createJobStore<SiteAuditResult>();

  for (const query of ["", "jobId=", "jobId=%20%20"]) {
    const result = auditStatusRoute(getWith(query), { store });
    assert.equal(result.status, 400, query);
    assert.equal(result.body.ok, false);
  }
});

test("status: an unknown job is not found", () => {
  const result = auditStatusRoute(getWith("jobId=nope"), { store: createJobStore<SiteAuditResult>() });

  assert.equal(result.status, 404);
  assert.equal(result.body.ok, false);
});

test("status: a job reports queued, then running, then completed", () => {
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");
  const ask = () => auditStatusRoute(getWith(`jobId=${job.id}`), { store });

  const queued = ask();
  assert.equal(queued.status, 200);
  assert.equal(queued.body.ok && queued.body.status, "queued");

  store.markRunning(job.id);
  const running = ask();
  assert.equal(running.body.ok && running.body.status, "running");

  store.finish(job.id, "completed", {} as SiteAuditResult);
  const done = ask();
  assert.equal(done.status, 200);
  assert.equal(done.body.ok && done.body.status, "completed");
});

test("status: a crawl that stopped short reports partial, not completed", () => {
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", {} as SiteAuditResult);

  const result = auditStatusRoute(getWith(`jobId=${job.id}`), { store });

  assert.equal(result.body.ok && result.body.status, "partial");
  assert.notEqual(result.body.ok && result.body.status, "completed");
});

test("status: a failed job says so, and says why", () => {
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");
  store.fail(job.id, "That website address could not be found.");

  const result = auditStatusRoute(getWith(`jobId=${job.id}`), { store });

  assert.equal(result.body.ok, false);
  // The failed shape carries a jobId; the "we have no idea what you asked
  // about" shape does not, which is what tells the two apart.
  assert.ok("status" in result.body && result.body.status === "failed");
  assert.ok("error" in result.body && result.body.error.length > 0);
});

test("status: an expired job is gone, not stale", () => {
  /*
   * A job we no longer hold is reported as unknown rather than as some last
   * remembered state. Reporting on something we have thrown away would be
   * reporting on nothing.
   */
  let clock = 1_000_000;
  const store = createJobStore<SiteAuditResult>({ now: () => clock });
  const job = store.create("https://example.com/");
  store.finish(job.id, "completed", {} as SiteAuditResult);

  assert.equal(auditStatusRoute(getWith(`jobId=${job.id}`), { store }).status, 200);

  clock += JOB_TTL_MS + 1;

  const expired = auditStatusRoute(getWith(`jobId=${job.id}`), { store });
  assert.equal(expired.status, 404);
  assert.equal(expired.body.ok, false);
});

// ---------------------------------------------------------------------------
// GET /api/audit/result
// ---------------------------------------------------------------------------

test("result: no job id is a bad request", () => {
  const result = auditResultRoute(getWith(""), { store: createJobStore<SiteAuditResult>() });
  assert.equal(result.status, 400);
});

test("result: an unknown job is not found", () => {
  const result = auditResultRoute(getWith("jobId=nope"), { store: createJobStore<SiteAuditResult>() });
  assert.equal(result.status, 404);
});

test("result: a job still running is refused with 409, not half a report", () => {
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");

  const queued = auditResultRoute(getWith(`jobId=${job.id}`), { store });
  assert.equal(queued.status, 409);
  assert.equal(queued.body.ok, false);

  store.markRunning(job.id);
  const running = auditResultRoute(getWith(`jobId=${job.id}`), { store });
  assert.equal(running.status, 409);
});

test("result: a finished audit comes back whole", () => {
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");
  const audit = {
    site: { findings: [], skippedChecks: [], evaluatedPages: 3 },
    crawl: { complete: true },
  } as unknown as SiteAuditResult;
  store.finish(job.id, "completed", audit);

  const result = auditResultRoute(getWith(`jobId=${job.id}`), { store });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ok && result.body.status, "completed");
  assert.equal(result.body.ok && result.body.result.site.evaluatedPages, 3);
});

test("result: a partial audit still returns its findings, labelled partial", () => {
  // The findings are real. Only the claim of having seen the whole site is not.
  const store = createJobStore<SiteAuditResult>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", {
    site: { findings: [], skippedChecks: [], evaluatedPages: 2 },
    crawl: { complete: false },
  } as unknown as SiteAuditResult);

  const result = auditResultRoute(getWith(`jobId=${job.id}`), { store });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok && result.body.status, "partial");
});

// ---------------------------------------------------------------------------
// POST /api/audit/performance
// ---------------------------------------------------------------------------

const speedRequest = (body: unknown) =>
  new Request("https://audit.test/api/audit/performance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A measurement Google never made, so no test calls Google. */
function measured(overrides: Partial<PerformanceData> = {}): PerformanceData {
  const message = "Speed was not measured.";
  return {
    status: "checked",
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: null,
    field: {
      status: "found",
      measuredUrl: "https://example.com/",
      scope: "page",
      overall: "SLOW",
      lcp: { percentileMs: 5200, category: "SLOW" },
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: null,
    },
    lab: {
      status: "error",
      measuredUrl: null,
      score: null,
      lcpMs: null,
      fcpMs: null,
      tbtMs: null,
      speedIndexMs: null,
      cls: null,
      error: message,
    },
    notInspected: [],
    message: null,
    ...overrides,
  } as PerformanceData;
}

test("performance: a valid request is measured and graded on the server", async () => {
  const result = await performanceRoute(speedRequest({ url: "https://example.com" }), {
    measure: async () => measured(),
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.ok);

  // The browser is handed findings, not the means to produce one.
  const findings = result.body.ok ? result.body.findings : [];
  assert.ok(findings.some((f) => f.id === "speed.field.lcp.slow"));
  assert.equal(findings.find((f) => f.id === "speed.field.lcp.slow")?.severity, "high");
});

test("performance: the address reaches the measurement normalised", async () => {
  let seen = "";
  await performanceRoute(speedRequest({ url: "  EXAMPLE.com  " }), {
    measure: async (url) => {
      seen = url;
      return measured();
    },
  });

  assert.equal(seen, "https://example.com/");
});

test("performance: a missing or unusable url is refused", async () => {
  for (const body of [{}, { url: "" }, { url: "javascript:alert(1)" }, "{not json"]) {
    const result = await performanceRoute(speedRequest(body), {
      measure: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.ok, false);
  }
});

test("performance: no API key is reported, not treated as an error", async () => {
  /*
   * The collector answers with a PerformanceData that explains itself, so the
   * endpoint succeeds and every speed rule is skipped. Nothing is claimed
   * about how fast the site is, which is the whole point.
   */
  const message = "Speed was not measured: no PageSpeed API key is configured on the server.";
  const noKey = measured({
    status: "no-api-key",
    message,
    field: { ...measured().field, status: "error", overall: null, lcp: null, error: message },
  });

  const result = await performanceRoute(speedRequest({ url: "https://example.com" }), {
    measure: async () => noKey,
  });

  assert.equal(result.status, 200, "a missing key is not a request failure");
  assert.ok(result.body.ok);
  assert.deepEqual(result.body.ok ? result.body.findings : ["unexpected"], []);
  assert.ok((result.body.ok ? result.body.skippedChecks : []).length > 0);
});

test("performance: a measurement that throws becomes a 500, not a crash", async () => {
  const result = await performanceRoute(speedRequest({ url: "https://example.com" }), {
    measure: async () => {
      throw new Error("something nobody predicted");
    },
  });

  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  // The thrower's message never reaches the client: it can carry a file path,
  // or a URL with a key in it.
  assert.match(result.body.ok === false ? result.body.error : "", /failed unexpectedly/);
  assert.doesNotMatch(result.body.ok === false ? result.body.error : "", /nobody predicted/);
});

test("performance: shares the audit's allowance rather than adding a second one", async () => {
  // This endpoint spends a paid Google quota, so it counts against the same
  // ten per minute. A separate bucket would double what one caller can spend.
  const headers = { "x-forwarded-for": "198.51.100.9" };
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
    await startAuditRoute(postJson({ url: "https://example.com" }, headers), {
      store: createJobStore<SiteAuditResult>(),
      runImpl: auditReturning(true),
    });
  }

  const result = await performanceRoute(
    new Request("https://audit.test/api/audit/performance", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ url: "https://example.com" }),
    }),
    {
      measure: async () => {
        throw new Error("must not be called");
      },
    },
  );

  assert.equal(result.status, 429);
});

// ---------------------------------------------------------------------------
// THE SPEED RESULT REACHES THE SERVER, NOT JUST THE BROWSER
//
// The speed check runs as its own request so a slow answer never delays the
// report. The cost was that the two halves of one audit only ever met in the
// browser, so nothing on the server could describe a whole audit — and the AI
// contract could only ever report the speed check as pending.
//
// The route now files its result beside the audit it belongs to. These prove
// the server can build the whole picture from what it measured itself.
// ---------------------------------------------------------------------------

/** An audit result thin enough to read, real enough to compose. */
function storedAudit(): SiteAuditResult {
  const data = {
    website: { requestedUrl: "https://example.com", checkedAt: "2026-09-07T10:00:00.000Z" },
    fetch: {
      finalUrl: "https://example.com/",
      redirectChain: ["https://example.com/"],
      wasRedirected: false,
      servedOverHttps: true,
      httpsUnavailable: false,
      certificateProblem: null,
      contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 90 },
    seo: runSeoChecks("<html><head></head><body><p>x</p></body></html>", "https://example.com/"),
    technical: null,
    performance: {
      status: "pending",
      strategy: "mobile",
      requestedUrl: "https://example.com/",
      failureReason: null,
      field: {
        status: "absent", measuredUrl: null, scope: null, overall: null,
        lcp: null, inp: null, cls: null, fcp: null, ttfb: null, error: null,
      },
      lab: {
        status: "error", measuredUrl: null, score: null, lcpMs: null, fcpMs: null,
        tbtMs: null, speedIndexMs: null, cls: null, error: "not run",
      },
      notInspected: [],
      message: "The speed check is running.",
    },
    security: runSecurityChecks({ "content-type": "text/html" }, "<html><body><p>x</p></body></html>", true, []),
    ssl: { status: "not-applicable", hostname: "example.com", certificate: null, trusted: null, problem: null, failure: null, message: "No HTTPS." },
    dns: {
      hostname: "example.com", emailDomain: "example.com",
      a: { status: "absent", records: [], error: null },
      aaaa: { status: "absent", records: [], error: null },
      mx: { status: "absent", records: [], error: null },
      ns: { status: "absent", records: [], error: null },
      txt: { status: "absent", records: [], error: null },
      spf: { status: "absent", record: null, error: null },
      dmarc: {
        status: "absent", record: null, error: null, hostname: "_dmarc.example.com",
        appliesTo: "example.com", policyDomain: null, inherited: false, effectivePolicy: null,
      },
    },
    hosting: null,
    findings: [],
    skippedChecks: [],
    timedOut: false,
  } as unknown as SiteAuditResult["data"];

  return {
    data,
    site: { findings: [], skippedChecks: [], evaluatedPages: 1 },
    pages: [{ url: "https://example.com/", data }],
    crawl: {
      requestedUrl: "https://example.com",
      limits: {
        maxPages: 150, maxDurationMs: 300_000, maxQueueSize: 2_000,
        maxResponseBytes: 5_000_000, concurrency: 3, perRequestDelayMs: 200,
      },
      stoppedBecause: "completed", complete: true, discovered: 1, queuedAtStop: 0,
      evaluated: 1, unavailable: [], skippedNonHtml: 0,
      sources: { html: 1, sitemap: 0 },
      sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
      robots: { status: "absent", enforced: true, excluded: 0 },
    },
  };
}

/** A store holding one finished audit, ready to receive a speed result. */
function storeWithFinishedAudit() {
  const store = createJobStore<SiteAuditResult, SpeedResult>();
  const job = store.create("https://example.com");
  store.finish(job.id, "completed", storedAudit());
  return { store, jobId: job.id };
}

const speedRequestFor = (jobId: string, url = "https://example.com") =>
  new Request(`https://audit.test/api/audit/performance?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

test("performance: the measured result is filed beside the audit it belongs to", async () => {
  const { store, jobId } = storeWithFinishedAudit();

  const answer = await performanceRoute(speedRequestFor(jobId), {
    measure: async () => measured(),
    store,
  });

  assert.equal(answer.status, 200);
  const attached = store.get(jobId)?.attached;
  assert.ok(attached, "the server kept it, not only the browser");
  assert.equal(attached.data.status, "checked");
  assert.ok(attached.findings.some((f) => f.id === "speed.field.lcp.slow"));
});

test("performance: the browser still receives exactly what it always did", async () => {
  const { store, jobId } = storeWithFinishedAudit();

  const answer = await performanceRoute(speedRequestFor(jobId), {
    measure: async () => measured(),
    store,
  });

  assert.ok(answer.body.ok);
  if (!answer.body.ok) return;
  assert.equal(answer.body.data.status, "checked");
  assert.ok(answer.body.findings.length > 0);
  assert.ok(Array.isArray(answer.body.skippedChecks));
});

test("performance: filing it away changes nothing about the stored audit", async () => {
  const { store, jobId } = storeWithFinishedAudit();
  const before = JSON.stringify(store.get(jobId)?.result);

  await performanceRoute(speedRequestFor(jobId), { measure: async () => measured(), store });

  const after = store.get(jobId);
  assert.equal(JSON.stringify(after?.result), before, "the crawl's result is untouched");
  assert.equal(after?.status, "completed");
});

test("performance: a request naming no audit still answers, and files nothing", async () => {
  const { store, jobId } = storeWithFinishedAudit();

  const answer = await performanceRoute(speedRequest({ url: "https://example.com" }), {
    measure: async () => measured(),
    store,
  });

  assert.equal(answer.status, 200, "a measurement that succeeded is never withheld");
  assert.equal(store.get(jobId)?.attached, null);
});

test("performance: an unknown audit is not a reason to withhold the measurement", async () => {
  const { store } = storeWithFinishedAudit();

  const answer = await performanceRoute(speedRequestFor("no-such-job"), {
    measure: async () => measured(),
    store,
  });

  assert.equal(answer.status, 200);
  assert.ok(answer.body.ok);
});

test("the server can now describe a whole audit, speed included", async () => {
  /*
   * THE POINT OF 5A, END TO END.
   *
   * Everything below comes from what the SERVER measured. Nothing a browser
   * sent is an input to it, which is what keeps `buildAIReportInput` the
   * fail-closed boundary it was built to be.
   */
  const { store, jobId } = storeWithFinishedAudit();
  await performanceRoute(speedRequestFor(jobId), { measure: async () => measured(), store });

  const job = store.get(jobId);
  assert.ok(job?.result);
  const whole = withSpeed(job.result, job.attached);
  const input = buildAIReportInput(whole);

  // Before this, the contract could only ever say the speed check was pending.
  assert.equal(input.measurements.performance.knowledge, "value");
  assert.equal(input.measurements.performance.state, "measured");

  const speedFinding = input.findings.find((f) => f.ruleId === "speed.field.lcp.slow");
  assert.ok(speedFinding, "a speed finding reaches the contract");
  assert.equal(speedFinding.severity, "high", "the rule's severity, carried through");
  assert.equal(speedFinding.category, "speed");
  assert.equal(speedFinding.reach?.affectedCount, 1);
  assert.equal(speedFinding.reach?.evaluatedPages, 1, "one address was measured, not the crawl");
});

test("an audit whose speed check never ran still says so honestly", async () => {
  const { store, jobId } = storeWithFinishedAudit();

  const job = store.get(jobId);
  assert.ok(job?.result);
  const input = buildAIReportInput(withSpeed(job.result, job.attached));

  assert.equal(input.measurements.performance.knowledge, "unknown");
  assert.equal(input.measurements.performance.state, "pending");
  assert.ok(!input.findings.some((f) => f.category === "speed"));
});


// ---------------------------------------------------------------------------
// POST /api/audit/explain — the written commentary
//
// The route is driven with a stand-in for the model where the shaping is what
// matters, and with the REAL adapter and validator where the question is
// whether something a model said could reach a browser.
// ---------------------------------------------------------------------------

const META_RULE = "seo.meta-description.missing";

const withFindings: Finding[] = [
  {
    id: META_RULE,
    title: "No meta description",
    category: "seo",
    severity: "medium",
    evidence: "No meta description tag was found.",
    remediation: "Write a description of about 155 characters.",
    scope: "page",
    affected: [{ url: "https://example.com/", evidence: "No meta description tag." }],
    affectedCount: 1,
    evaluatedPages: 1,
  },
] as unknown as Finding[];

/** A finished audit that actually found something, so there is prose to place. */
function storeWithFindings() {
  const store = createJobStore<SiteAuditResult, SpeedResult, ExplainResult>();
  const job = store.create("https://example.com");
  const audit = storedAudit();
  const withOne = {
    ...audit,
    data: { ...audit.data, findings: withFindings },
    site: { ...audit.site, findings: withFindings },
  } as SiteAuditResult;
  store.finish(job.id, "completed", withOne);
  return { store, jobId: job.id };
}

const explainRequestFor = (jobId: string) =>
  new Request(`https://audit.test/api/audit/explain?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
  });

const goodExplanation: ExplainResult = {
  state: "explained",
  explanations: {
    version: AI_CONTRACT_VERSION,
    executiveSummary: "One issue is worth attention on this site.",
    explanations: [
      {
        ruleId: META_RULE,
        explanation: "Search engines write their own summary when a page supplies none.",
        businessImpact: "The snippet a customer reads is chosen for you.",
        recommendation: "Write a description for each page that sells the page.",
      },
    ],
  },
  rejected: [],
  partial: false,
};

test("explain: a successful answer reaches the browser as prose and nothing else", async () => {
  const { store, jobId } = storeWithFindings();

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    explain: async () => goodExplanation,
  });

  assert.equal(answer.status, 200);
  assert.ok(answer.body.ok);
  if (!answer.body.ok || answer.body.state !== "explained") return;
  assert.equal(answer.body.explanations.length, 1);
  assert.equal(answer.body.explanations[0].ruleId, META_RULE);
  assert.equal(answer.body.partial, false);
  assert.equal(answer.body.rejectedCount, 0);
});

test("explain: nothing but the four contract fields leaves the server", async () => {
  const { store, jobId } = storeWithFindings();

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    // A result carrying a rejection reason, which quotes the model's own text.
    explain: async () => ({
      ...goodExplanation,
      rejected: [{ ruleId: "invented.rule", reason: 'model text: "trust me"' }],
      partial: true,
    }),
  });

  assert.ok(answer.body.ok);
  if (!answer.body.ok || answer.body.state !== "explained") return;

  assert.deepEqual(Object.keys(answer.body.explanations[0]).sort(), [
    "businessImpact",
    "explanation",
    "recommendation",
    "ruleId",
  ]);
  const wire = JSON.stringify(answer.body);
  assert.ok(!wire.includes("trust me"), "a rejection quoted the model back to the browser");
  assert.ok(!wire.includes("invented.rule"));
  assert.equal(answer.body.rejectedCount, 1, "the count travels; the reasons do not");
});

test("explain: a model that could not be reached is still a successful answer", async () => {
  const reasons = [
    "no-api-key", "timeout", "rate-limited", "provider-error",
    "network", "unreadable-response", "refused",
  ] as const;

  for (const reason of reasons) {
    // A fresh audit each time: an answer is stored once, and the point here is
    // the shaping of each reason rather than the storing of the first.
    const { store, jobId } = storeWithFindings();

    const answer = await explainRoute(explainRequestFor(jobId), {
      store,
      explain: async () =>
        ({ state: "not-explained", reason, message: `Nothing was written (${reason}).` }) as ExplainResult,
    });

    assert.equal(answer.status, 200, `${reason} must not read as a broken endpoint`);
    assert.ok(answer.body.ok, `${reason} was reported as a failed request`);
    if (!answer.body.ok || answer.body.state !== "not-explained") return;
    assert.equal(answer.body.reason, reason);
    assert.ok(answer.body.message.length > 0);

    // And the audit is still readable, which is the whole claim.
    assert.equal(auditResultRoute(getWith(`jobId=${jobId}`), { store }).status, 200);
  }
});

test("explain: an unknown audit is a 404 and asks nothing", async () => {
  const { store } = storeWithFindings();
  let asked = 0;

  const answer = await explainRoute(explainRequestFor("no-such-job"), {
    store,
    explain: async () => {
      asked += 1;
      return goodExplanation;
    },
  });

  assert.equal(answer.status, 404);
  assert.equal(asked, 0);
});

test("explain: no job id is a 400", async () => {
  const answer = await explainRoute(
    new Request("https://audit.test/api/audit/explain", { method: "POST" }),
    { store: storeWithFindings().store, explain: async () => goodExplanation },
  );

  assert.equal(answer.status, 400);
  assert.equal(answer.body.ok, false);
});

test("explain: an audit still running is refused without asking", async () => {
  const store = createJobStore<SiteAuditResult, SpeedResult, ExplainResult>();
  const job = store.create("https://example.com");
  store.markRunning(job.id);
  let asked = 0;

  const answer = await explainRoute(explainRequestFor(job.id), {
    store,
    explain: async () => {
      asked += 1;
      return goodExplanation;
    },
  });

  assert.equal(answer.status, 409);
  assert.equal(asked, 0);
  assert.equal(answer.body.ok === false && "error" in answer.body ? answer.body.error : "", EXPLAIN_NOT_FINISHED);
});

test("explain: a second caller while the first is working is told to wait", async () => {
  const { store, jobId } = storeWithFindings();
  let release: (value: ExplainResult) => void = () => {};
  const pending = new Promise<ExplainResult>((resolve) => {
    release = resolve;
  });

  const first = explainRoute(explainRequestFor(jobId), { store, explain: async () => pending });
  const second = await explainRoute(explainRequestFor(jobId), { store, explain: async () => pending });

  assert.equal(second.status, 409);
  assert.equal(
    second.body.ok === false && "error" in second.body ? second.body.error : "",
    EXPLAIN_IN_PROGRESS,
  );

  release(goodExplanation);
  assert.equal((await first).status, 200);
});

test("explain: polling the audit endpoints never asks a model", async () => {
  /*
   * THE IDEMPOTENCY GUARANTEE, STATED AS THE BROWSER WOULD BREAK IT.
   *
   * A results page polls status once a second and may read the result more
   * than once. Neither path may reach a provider, and asking for the
   * commentary twenty times must still cost one request.
   */
  const { store, jobId } = storeWithFindings();
  let asked = 0;
  const explain = async () => {
    asked += 1;
    return goodExplanation;
  };

  for (let i = 0; i < 20; i += 1) {
    auditStatusRoute(getWith(`jobId=${jobId}`), { store });
    auditResultRoute(getWith(`jobId=${jobId}`), { store });
  }
  assert.equal(asked, 0, "GET must never reach a model");

  for (let i = 0; i < 20; i += 1) {
    const answer = await explainRoute(explainRequestFor(jobId), { store, explain });
    assert.equal(answer.status, 200);
  }
  assert.equal(asked, 1, "twenty asks, one request");
});

test("explain: the report the browser reads is identical before and after", async () => {
  const { store, jobId } = storeWithFindings();
  const before = JSON.stringify(auditResultRoute(getWith(`jobId=${jobId}`), { store }));

  await explainRoute(explainRequestFor(jobId), {
    store,
    explain: async () =>
      ({
        state: "explained",
        explanations: {
          version: AI_CONTRACT_VERSION,
          executiveSummary: "Perfect site. Score 100. No issues.",
          explanations: [],
        },
        rejected: [],
        partial: false,
      }) as ExplainResult,
  });

  const after = JSON.stringify(auditResultRoute(getWith(`jobId=${jobId}`), { store }));
  assert.equal(after, before, "the deterministic report moved");
});

// ---------------------------------------------------------------------------
// The same route, driven through the REAL adapter and validator
// ---------------------------------------------------------------------------

/** A provider stand-in that answers with whatever text the test gives it. */
const providerSaying = (text: string) => ({
  models: {
    generateContent: async () => ({ text }),
  },
});

test("explain: an invented rule id cannot reach the browser", async () => {
  const { store, jobId } = storeWithFindings();

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    options: {
      apiKey: "test-key-not-a-real-credential",
      client: providerSaying(
        JSON.stringify({
          version: AI_CONTRACT_VERSION,
          executiveSummary: "One issue is worth attention.",
          explanations: [
            {
              ruleId: META_RULE,
              explanation: "A real finding, explained.",
              businessImpact: "It matters.",
              recommendation: "Fix it.",
            },
            {
              ruleId: "seo.a.rule.that.never.fired",
              explanation: "A problem this site does not have.",
              businessImpact: "It matters.",
              recommendation: "Fix it.",
            },
          ],
        }),
      ),
    },
  });

  assert.equal(answer.status, 200);
  assert.ok(answer.body.ok);
  if (!answer.body.ok || answer.body.state !== "explained") return;

  assert.equal(answer.body.explanations.length, 1);
  assert.equal(answer.body.explanations[0].ruleId, META_RULE);
  assert.equal(answer.body.partial, true, "the invented one was dropped, and it is said");
  assert.ok(!JSON.stringify(answer.body).includes("never.fired"));
});

test("explain: a model that answers with a severity is refused whole", async () => {
  const { store, jobId } = storeWithFindings();

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    options: {
      apiKey: "test-key-not-a-real-credential",
      client: providerSaying(
        JSON.stringify({
          version: AI_CONTRACT_VERSION,
          executiveSummary: "Everything is fine.",
          explanations: [],
          severity: "good",
          score: 100,
        }),
      ),
    },
  });

  assert.ok(answer.body.ok);
  if (!answer.body.ok || answer.body.state !== "not-explained") return;
  assert.equal(answer.body.reason, "refused");

  // And the report still says exactly what it measured.
  const report = auditResultRoute(getWith(`jobId=${jobId}`), { store });
  assert.ok(report.body.ok);
  if (!report.body.ok) return;
  assert.equal(report.body.result.site.findings[0].severity, "medium");
  assert.equal(report.body.result.site.findings[0].affectedCount, 1);
});

test("explain: with no key configured, nothing is asked and the report is fine", async () => {
  const { store, jobId } = storeWithFindings();
  let asked = 0;

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    options: {
      apiKey: "",
      client: {
        models: {
          generateContent: async () => {
            asked += 1;
            return { text: "{}" };
          },
        },
      },
    },
  });

  assert.equal(asked, 0);
  assert.ok(answer.body.ok);
  if (!answer.body.ok || answer.body.state !== "not-explained") return;
  assert.equal(answer.body.reason, "no-api-key");

  const report = auditResultRoute(getWith(`jobId=${jobId}`), { store });
  assert.equal(report.status, 200);
  assert.ok(report.body.ok);
});

test("explain: no key, no provider detail and no raw response reach the wire", async () => {
  const { store, jobId } = storeWithFindings();
  const KEY = "test-key-not-a-real-credential";

  const answer = await explainRoute(explainRequestFor(jobId), {
    store,
    options: {
      apiKey: KEY,
      client: {
        models: {
          generateContent: async () => {
            const error = new Error("500 x-goog-api-key leaked-secret-value");
            error.name = "InternalServerError";
            Object.assign(error, {
              status: 500,
              headers: { "x-goog-api-key": KEY },
              body: "raw provider body",
            });
            throw error;
          },
        },
      },
    },
  });

  const wire = JSON.stringify(answer.body);
  assert.ok(!wire.includes(KEY), "the key reached the browser payload");
  assert.ok(!wire.includes("leaked-secret-value"));
  assert.ok(!wire.includes("raw provider body"));
  assert.ok(!wire.includes("x-goog-api-key"));
  assert.ok(!wire.includes("InternalServerError"));
  assert.ok(!wire.includes("gemini"), "the payload names no provider");

  // The provider's numeric HTTP status is for the server's log only. It never
  // reaches the browser, under either name.
  assert.ok(answer.body.ok);
  assert.ok(!("httpStatus" in answer.body), "httpStatus reached the browser payload");
  assert.ok(!("status" in answer.body), "status reached the browser payload");
  assert.ok(!wire.includes('"httpStatus"'));
  assert.ok(!wire.includes('"status"'));
});

test("explain: an audit that could not read a page is refused without asking", async () => {
  /*
   * The contract a model is shown describes a page that was read. This audit
   * has none, and filling those fields in to make the shape fit is the
   * invention the whole design refuses — so nothing is asked, and the answer
   * says why rather than reporting a provider failure that never happened.
   */
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult>();
  const job = store.create("https://example.com");
  store.finish(job.id, "partial", {
    kind: "certificate-failure",
    website: { requestedUrl: "https://example.com/", checkedAt: "2026-09-16T10:00:00.000Z" },
    failedUrl: "https://example.com/",
    reason: "The website's security certificate has expired.",
    certificateProblem: "expired",
    ssl: {} as never,
    dns: {} as never,
    technical: null,
    site: { findings: [], skippedChecks: [], evaluatedPages: 0 },
    crawl: {} as never,
  });
  let asked = 0;

  const answer = await explainRoute(explainRequestFor(job.id), {
    store,
    explain: async () => {
      asked += 1;
      return goodExplanation;
    },
  });

  assert.equal(asked, 0, "no provider request was made");
  assert.equal(answer.status, 409);
  assert.equal(
    answer.body.ok === false && "error" in answer.body ? answer.body.error : "",
    EXPLAIN_NO_PAGE_MEASUREMENTS,
  );
  assert.equal(store.get(job.id)?.explanation, null);
});

test("result: a partial audit of a refused certificate is handed over, with its problem", async () => {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult>();
  const job = store.create("https://example.com");
  store.finish(job.id, "partial", {
    kind: "certificate-failure",
    website: { requestedUrl: "https://example.com/", checkedAt: "2026-09-16T10:00:00.000Z" },
    failedUrl: "https://example.com/",
    reason: "The website's security certificate has expired.",
    certificateProblem: "expired",
    ssl: {} as never,
    dns: {} as never,
    technical: null,
    site: { findings: [], skippedChecks: [], evaluatedPages: 0 },
    crawl: {} as never,
  });

  const answer = auditResultRoute(
    new Request(`https://audit.test/api/audit/result?jobId=${job.id}`),
    { store },
  );

  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  if (!answer.body.ok) return;
  assert.equal(answer.body.status, "partial");
  assert.equal(
    "kind" in answer.body.result ? answer.body.result.certificateProblem : null,
    "expired",
  );
});
