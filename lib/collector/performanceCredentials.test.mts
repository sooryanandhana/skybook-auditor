/**
 * U-3: a username and password typed into the audited address never reach the
 * speed check's notes or summary.
 *
 * Those sentences are shown on the dashboard, printed in the PDF (downloaded or
 * emailed) and passed to the AI, so they are built from the address with any
 * credentials removed. Since the follow-up fix (Option B), the same
 * credential-free address is also the one sent to Google and the `requestedUrl`
 * recorded with the result: credentials are never forwarded or stored.
 *
 * Every reply is a canned response through a stubbed fetch; nothing here
 * touches the network. The helpers follow performanceChecks.test.mts, whose own
 * are not exported.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createDeadline } from "./deadline.ts";
import { runPerformanceChecks } from "./performanceChecks.ts";
import type { PerformanceData } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A PageSpeed reply whose simulated run ended at `labUrl` and whose real-visitor data is held under `fieldUrl`. */
function reply(labUrl: string, fieldUrl: string) {
  return {
    lighthouseResult: {
      finalUrl: labUrl,
      categories: { performance: { score: 0.62 } },
      audits: {
        "largest-contentful-paint": { numericValue: 4210.5 },
        "first-contentful-paint": { numericValue: 1820 },
        "total-blocking-time": { numericValue: 640 },
        "speed-index": { numericValue: 3100 },
        "cumulative-layout-shift": { numericValue: 0.08 },
      },
    },
    loadingExperience: {
      id: fieldUrl,
      overall_category: "AVERAGE",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: "AVERAGE" },
        INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: "AVERAGE" },
        EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 700, category: "AVERAGE" },
      },
    },
  };
}

/** Runs the real check against a canned reply, recording the request it made. */
async function check(requestedUrl: string, body: unknown): Promise<{ result: PerformanceData; requests: string[] }> {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const result = await runPerformanceChecks(requestedUrl, createDeadline(30_000), {
    apiKey: "test-key",
    fetchImpl,
    endpoint: "https://pagespeed.test/run",
  });
  return { result, requests };
}

/** Every sentence a reader can see: the summary and each note. */
const printed = (result: PerformanceData) => [result.message, ...result.notInspected].join("\n");

/** The redirect sentences, as the collector words them (performanceChecks.ts). */
const redirectNotes = (result: PerformanceData) => result.notInspected.filter((note) => note.includes("redirects"));

// ---------------------------------------------------------------------------
// No redirect: a credential alone is never mistaken for one
// ---------------------------------------------------------------------------

test("U-3: Google reports the same address without credentials: no false redirect, no credentials printed", async () => {
  const requested = "https://username:password@example.com/path?ref=mail";
  const { result } = await check(requested, reply("https://example.com/path?ref=mail", "https://example.com/path?ref=mail"));

  assert.equal(result.status, "checked");
  assert.deepEqual(redirectNotes(result), [], "no redirect note: only the credentials differed");
  assert.ok(!result.message.includes("redirects"), "no redirect sentence in the summary");
  assert.ok(!/username|password|@/.test(printed(result)), printed(result));
});

// ---------------------------------------------------------------------------
// A genuine redirect: still reported, with clean addresses
// ---------------------------------------------------------------------------

test("U-3: a genuine redirect is still reported, naming the clean requested address and the measured one", async () => {
  const requested = "https://username:password@example.com:8443/path?ref=mail";
  const { result } = await check(requested, reply("https://www.example.org/landing?x=1", "https://www.example.org/landing?x=1"));

  assert.deepEqual(redirectNotes(result), [
    "https://example.com:8443/path?ref=mail itself — it redirects, and Google measured https://www.example.org/landing?x=1 instead. Every figure above describes that address, not the one requested.",
  ]);
  assert.ok(result.message.endsWith("https://example.com:8443/path?ref=mail redirects to https://www.example.org/landing?x=1."));
  assert.ok(!/username|password/.test(printed(result)), "no credentials anywhere");
  assert.ok(printed(result).includes(":8443") && printed(result).includes("?ref=mail"), "port and query kept");
});

test("U-3: when the two halves land on different addresses, each note names the clean requested address", async () => {
  const requested = "https://username:password@example.com/path?ref=mail";
  const { result } = await check(requested, reply("https://example.com/moved", "https://example.com/other"));

  assert.deepEqual(redirectNotes(result), [
    "https://example.com/path?ref=mail as the simulation loaded it — it redirects, so the simulated figures describe https://example.com/moved.",
  ]);
  assert.ok(result.notInspected.includes(
    "https://example.com/path?ref=mail as Google records it — the real-visitor figures are held under https://example.com/other.",
  ));
  assert.ok(!/username|password/.test(printed(result)));
});

// ---------------------------------------------------------------------------
// A username alone, or a password alone
// ---------------------------------------------------------------------------

test("U-3: a username alone, or a password alone, is never printed", async () => {
  for (const [requested, secret] of [
    ["https://username@example.com/path?ref=mail", "username"],
    ["https://:password@example.com/path?ref=mail", "password"],
  ] as const) {
    assert.equal(new URL(requested).username + new URL(requested).password, secret, "the parser reads the credential");
    const { result } = await check(requested, reply("https://www.example.org/landing", "https://www.example.org/landing"));
    assert.equal(redirectNotes(result).length, 1, `${secret}: the genuine redirect is reported`);
    assert.ok(redirectNotes(result)[0].startsWith("https://example.com/path?ref=mail itself"), secret);
    assert.ok(!printed(result).includes(secret), `${secret} is printed nowhere`);
  }
});

// ---------------------------------------------------------------------------
// Addresses without credentials: exactly as before
// ---------------------------------------------------------------------------

test("U-3: an address without credentials keeps its exact wording, redirect or not", async () => {
  const requested = "https://example.com/shop?item=7&ref=mail";

  const same = await check(requested, reply(requested, requested));
  assert.deepEqual(redirectNotes(same.result), []);

  const moved = await check(requested, reply("https://www.example.com/shop?item=7&ref=mail", "https://www.example.com/shop?item=7&ref=mail"));
  assert.deepEqual(redirectNotes(moved.result), [
    "https://example.com/shop?item=7&ref=mail itself — it redirects, and Google measured https://www.example.com/shop?item=7&ref=mail instead. Every figure above describes that address, not the one requested.",
  ]);
  assert.ok(moved.result.message.endsWith("https://example.com/shop?item=7&ref=mail redirects to https://www.example.com/shop?item=7&ref=mail."));
});

// ---------------------------------------------------------------------------
// The measurement is untouched
// ---------------------------------------------------------------------------

// Supersedes the earlier U-3 assertion that the request and the record kept the credentials.
test("Option B: credentials are removed from the address sent to Google and from the recorded requestedUrl", async () => {
  for (const [submitted, clean] of [
    ["https://username:password@example.com:8443/path?ref=mail&b=2#section", "https://example.com:8443/path?ref=mail&b=2#section"],
    ["https://username@example.com/path?ref=mail", "https://example.com/path?ref=mail"],
    ["https://:password@example.com/path?ref=mail", "https://example.com/path?ref=mail"],
  ] as const) {
    const { result, requests } = await check(submitted, reply("https://example.com/path?ref=mail", "https://example.com/path?ref=mail"));
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]).searchParams.get("url"), clean, `${submitted}: Google is asked about the clean address`);
    assert.ok(!/username|password/.test(requests[0]), `${submitted}: nothing secret in the request`);
    assert.equal(result.requestedUrl, clean, `${submitted}: the record holds the clean address`);
    assert.ok(!/username|password/.test(JSON.stringify(result)), `${submitted}: nothing secret in the result`);
    // The figures themselves are the reply's, unaffected.
    assert.equal(result.lab.score, 62);
    assert.equal(result.field.status, "found");
  }
});

test("Option B: an address without credentials is sent and recorded exactly as given", async () => {
  const given = "https://example.com/shop?item=7&ref=mail";
  const { result, requests } = await check(given, reply(given, given));
  assert.equal(new URL(requests[0]).searchParams.get("url"), given);
  assert.equal(result.requestedUrl, given);
});

test("Option B: a failed check records the clean address too", async () => {
  const result = await runPerformanceChecks("https://username:password@example.com/", createDeadline(30_000), { apiKey: "" });
  assert.equal(result.status, "no-api-key");
  assert.equal(result.requestedUrl, "https://example.com/");
});
