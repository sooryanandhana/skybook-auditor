/**
 * Tests for fetching behaviour.
 *
 * These replace the real `fetch` with a stand-in, so no website is contacted
 * and the answers are the same every run. The host used is a public IP
 * address literal, which the safety check can classify without a DNS query —
 * so these tests need no network at all.
 *
 * Run with:  npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchPage, classifyConnectionError, decodeHtml } from "./fetchPage.ts";

/** A public IP, so the safety check passes without contacting a DNS server. */
const HOST = "93.184.216.34";

const realFetch = globalThis.fetch;

/** Queue of responses the stand-in `fetch` will return, in order. */
let queued: Array<Response | Error> = [];
/** Every URL the code under test asked for, in order. */
let requested: string[] = [];

beforeEach(() => {
  queued = [];
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(input.toString());
    const next = queued.shift();
    if (!next) throw new Error("test asked for more requests than were queued");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Builds a fake HTML response. */
function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

/** Builds a fake redirect response. */
function redirectResponse(location: string, status = 301) {
  // Response.redirect() rejects relative URLs, so construct it directly.
  return new Response(null, { status, headers: { location } });
}

/** Builds the error Node throws for a given network failure code. */
function networkError(code: string) {
  const error = new TypeError("fetch failed");
  (error as unknown as { cause: unknown }).cause = { code };
  return error;
}

// ---------------------------------------------------------------------------
// Status codes: a server that answers is online, whatever it says
// ---------------------------------------------------------------------------

test("a 200 page is fetched successfully", async () => {
  queued = [htmlResponse("<html><head><title>Hi</title></head><body></body></html>")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.uptime.isOnline, true);
  assert.equal(result.page.uptime.statusCode, 200);
  assert.match(result.page.html, /<title>Hi<\/title>/);
});

test("a 404 reports the site as ONLINE with its status code", async () => {
  // The whole point: the server answered. It is not down; the page is missing.
  queued = [htmlResponse("Not found", 404)];
  const result = await fetchPage(`https://${HOST}/missing`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.notEqual(result.uptime, null, "a 404 must still carry a measurement");
  assert.equal(result.uptime?.isOnline, true, "a 404 server is online");
  assert.equal(result.uptime?.statusCode, 404);
  assert.match(result.reason, /404/);
});

test("a 500 also reports the site as ONLINE", async () => {
  queued = [htmlResponse("Server error", 500)];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.uptime?.isOnline, true);
  assert.equal(result.uptime?.statusCode, 500);
});

test("records a response time whenever the server answered", async () => {
  queued = [htmlResponse("Not found", 404)];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(typeof result.uptime?.serverResponseTimeMs, "number");
});

// ---------------------------------------------------------------------------
// Never claim a measurement we did not take
// ---------------------------------------------------------------------------

test("reports NO uptime when nothing responded", async () => {
  // Claiming "offline" here would be inventing a measurement: we never got an
  // answer, so we know nothing about the server's state.
  queued = [networkError("ECONNREFUSED")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.uptime, null);
});

test("reports NO uptime for an address rejected before any request", async () => {
  const result = await fetchPage("not a url");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.uptime, null);
  assert.equal(requested.length, 0, "nothing should have been requested");
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test("follows a redirect and records the chain", async () => {
  queued = [
    redirectResponse(`https://${HOST}/final`),
    htmlResponse("<html><body>Done</body></html>"),
  ];
  const result = await fetchPage(`https://${HOST}/start`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.finalUrl, `https://${HOST}/final`);
  assert.deepEqual(result.page.redirectChain, [
    `https://${HOST}/start`,
    `https://${HOST}/final`,
  ]);
});

test("resolves a relative redirect against the current address", async () => {
  queued = [redirectResponse("/moved"), htmlResponse("<html><body>Here</body></html>")];
  const result = await fetchPage(`https://${HOST}/original`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.finalUrl, `https://${HOST}/moved`);
});

test("gives up after too many redirects rather than looping forever", async () => {
  // More hops than the fetcher allows.
  queued = Array.from({ length: 10 }, () => redirectResponse(`https://${HOST}/again`));
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /redirected too many times/i);
});

test("rejects a redirect to a non-web protocol", async () => {
  queued = [redirectResponse("ftp://example.com/file")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /isn't a web page/i);
});

test("reports a redirect with no destination", async () => {
  queued = [new Response(null, { status: 301 })]; // 3xx with no Location
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /incomplete redirect/i);
});

// ---------------------------------------------------------------------------
// Content type
// ---------------------------------------------------------------------------

test("rejects a response that is not a web page", async () => {
  queued = [new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })];
  const result = await fetchPage(`https://${HOST}/file.pdf`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /doesn't point to a web page/i);
  // We still learned the server answered.
  assert.equal(result.uptime?.statusCode, 200);
});

test("records the content type of a page it accepted", async () => {
  queued = [htmlResponse("<html></html>")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.page.contentType ?? "", /text\/html/);
});

// ---------------------------------------------------------------------------
// HTTPS handling
// ---------------------------------------------------------------------------

test("falls back to HTTP when the scheme was assumed and HTTPS fails", async () => {
  queued = [
    networkError("ECONNREFUSED"), // the https attempt
    htmlResponse("<html><body>Plain</body></html>"), // the http retry
  ];
  const result = await fetchPage(HOST); // bare host, so https was our guess

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.servedOverHttps, false);
  assert.equal(result.page.httpsUnavailable, true);
  assert.equal(requested[0], `https://${HOST}/`);
  assert.equal(requested[1], `http://${HOST}/`);
});

test("never downgrades an explicitly requested https:// address", async () => {
  // The user asked for HTTPS. Quietly retrying unencrypted would undo their
  // choice without telling them.
  queued = [networkError("ECONNREFUSED")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  assert.equal(requested.length, 1, "should not have retried over http");
});

test("keeps the certificate problem when the page loads over HTTP instead", async () => {
  // Otherwise a site with an expired certificate looks perfectly healthy.
  queued = [
    networkError("CERT_HAS_EXPIRED"),
    htmlResponse("<html><body>Plain</body></html>"),
  ];
  const result = await fetchPage(HOST);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.certificateProblem, "expired");
  assert.equal(result.page.httpsUnavailable, true);
});

test("marks a page read over HTTPS as such", async () => {
  queued = [htmlResponse("<html></html>")];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.servedOverHttps, true);
  assert.equal(result.page.httpsUnavailable, false);
  assert.equal(result.page.certificateProblem, undefined);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("names each kind of certificate problem", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["CERT_HAS_EXPIRED", "expired", /expired/i],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed", /self-signed/i],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed", /self-signed/i],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "wrong-hostname", /different address/i],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "untrusted", /could not be verified/i],
  ];
  for (const [code, expectedProblem, expectedMessage] of cases) {
    const classified = classifyConnectionError(networkError(code));
    assert.equal(classified.certificateProblem, expectedProblem, `for ${code}`);
    assert.match(classified.reason, expectedMessage, `for ${code}`);
  }
});

test("distinguishes network failures from certificate failures", () => {
  assert.match(classifyConnectionError(networkError("ENOTFOUND")).reason, /could not be found/i);
  assert.match(classifyConnectionError(networkError("ECONNREFUSED")).reason, /refused/i);
  assert.match(classifyConnectionError(networkError("ECONNRESET")).reason, /closed the connection/i);

  // None of these are certificate problems.
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET"]) {
    assert.equal(classifyConnectionError(networkError(code)).certificateProblem, undefined);
  }
});

test("recognises a timeout", () => {
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.match(classifyConnectionError(timeout).reason, /too long to respond/i);
});

test("falls back to a general message for an unknown failure", () => {
  assert.match(classifyConnectionError(networkError("SOMETHING_NEW")).reason, /could not connect/i);
  assert.match(classifyConnectionError(new Error("plain")).reason, /could not connect/i);
});

// ---------------------------------------------------------------------------
// Character encoding
// ---------------------------------------------------------------------------

test("decodes UTF-8 by default", () => {
  const bytes = new TextEncoder().encode("<html><title>Café</title></html>");
  assert.match(decodeHtml(bytes, "text/html"), /Café/);
});

test("uses the charset from the Content-Type header", () => {
  // "é" is a single byte (0xE9) in ISO-8859-1. Read as UTF-8 it is nonsense.
  const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in latin1
  assert.equal(decodeHtml(bytes, "text/html; charset=iso-8859-1"), "Café");
});

test("falls back to the <meta charset> tag when the header is silent", () => {
  const prefix = new TextEncoder().encode('<html><head><meta charset="iso-8859-1"><title>');
  const bytes = new Uint8Array([...prefix, 0x43, 0x61, 0x66, 0xe9]);
  assert.match(decodeHtml(bytes, "text/html"), /Café$/);
});

test("falls back to UTF-8 when the declared encoding is unknown", () => {
  const bytes = new TextEncoder().encode("<html>hello</html>");
  assert.match(decodeHtml(bytes, "text/html; charset=not-a-real-encoding"), /hello/);
});
