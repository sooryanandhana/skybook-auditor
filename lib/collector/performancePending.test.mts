/**
 * Tests for the "pending" state and the split between the two requests.
 *
 * The audit no longer waits for Google. That makes a new state possible —
 * "requested, not answered yet" — and the danger of any such state is that a
 * reader takes an absent measurement for a good one. These tests exist to make
 * that impossible.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createDeadline } from "./deadline.ts";
import {
  performanceNotRequested,
  performancePending,
  runPerformanceChecks,
} from "./performanceChecks.ts";

test("pending: says the check is running elsewhere, and measures nothing", () => {
  const result = performancePending("https://example.com/");

  assert.equal(result.status, "pending");
  assert.equal(result.requestedUrl, "https://example.com/");
  assert.equal(result.strategy, "mobile");

  // Nothing has been measured, so nothing may be reported.
  assert.equal(result.field.status, "error");
  assert.equal(result.lab.status, "error");
  assert.equal(result.lab.score, null);
  assert.equal(result.field.overall, null);
  assert.equal(result.field.measuredUrl, null);
  assert.equal(result.lab.measuredUrl, null);
});

test("pending is not a failure", () => {
  const result = performancePending("https://example.com/");

  assert.equal(
    result.failureReason,
    null,
    "nothing has gone wrong — the answer simply has not arrived",
  );
});

test("pending never reads as absent field data", () => {
  const result = performancePending("https://example.com/");

  // "absent" is a finding: Google has too few visitors to report on. Saying
  // that before asking would be a measurement we never took.
  assert.notEqual(result.field.status, "absent");
});

test("pending and not-requested are different situations", () => {
  const pending = performancePending("https://example.com/");
  const notRequested = performanceNotRequested("https://example.com/");

  assert.notEqual(pending.status, notRequested.status);
  assert.notEqual(pending.message, notRequested.message);
  assert.match(pending.message, /running separately/);
  assert.match(notRequested.message, /not measured/);
});

test("pending discloses that the figures are missing, not fine", () => {
  const result = performancePending("https://example.com/");

  assert.ok(
    result.notInspected.some((note) => note.includes("has not returned yet")),
    "the gap must be listed like every other gap in this audit",
  );
});

test("the collector still works when called on its own clock", async () => {
  // The separate endpoint gives the check its own deadline rather than a slice
  // of the audit's. Nothing about the collector changes because of that.
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        lighthouseResult: {
          finalUrl: "https://example.com/",
          categories: { performance: { score: 0.9 } },
          audits: { "largest-contentful-paint": { numericValue: 1200 } },
        },
        loadingExperience: {
          id: "https://example.com/",
          overall_category: "FAST",
          metrics: {
            LARGEST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks(
    "https://example.com/",
    createDeadline(65_000),
    { apiKey: "k", fetchImpl: impl, endpoint: "https://ps.test/run" },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.status, "checked");
  assert.equal(result.lab.score, 90);
  assert.equal(result.field.measuredUrl, "https://example.com/");
  assert.equal(result.lab.measuredUrl, "https://example.com/");
});

test("the one retry still applies on its own clock", async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Something went wrong." } }), {
      status: 500,
    });
  }) as unknown as typeof fetch;

  const result = await runPerformanceChecks(
    "https://example.com/",
    createDeadline(65_000),
    { apiKey: "k", fetchImpl: impl, endpoint: "https://ps.test/run", retryDelayMs: 0 },
  );

  assert.equal(calls, 2, "still exactly two attempts, never more");
  assert.equal(result.failureReason, "api-error");
});
