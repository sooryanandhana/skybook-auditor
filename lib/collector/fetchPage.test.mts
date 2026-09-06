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
import {
  fetchPage,
  classifyConnectionError,
  decodeHtml,
  describeErrorStatus,
  NOT_A_WEB_PAGE,
  UNDECLARED_CONTENT_TYPE,
} from "./fetchPage.ts";
import { createDeadline } from "./deadline.ts";

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
// A site refusing us is not a site that is broken
// ---------------------------------------------------------------------------

test("says a 403 is a refusal, not a fault with the website", () => {
  // A salesperson reading "error" would tell a prospect their site is broken.
  // It is not — visitors can use it fine; we were blocked.
  const message = describeErrorStatus(403);
  assert.match(message, /refused/i);
  assert.match(message, /does not mean the site is broken/i);
  assert.doesNotMatch(message, /responded with an error/i);
});

test("says a 401 means a login is needed, not a fault", () => {
  const message = describeErrorStatus(401);
  assert.match(message, /requires a login/i);
  assert.match(message, /not a fault/i);
});

test("says a 429 means slow down, not failure", () => {
  const message = describeErrorStatus(429);
  assert.match(message, /slow down|limiting/i);
  assert.doesNotMatch(message, /responded with an error/i);
});

test("still calls a 500 a problem with the server", () => {
  // This one really is the website failing.
  assert.match(describeErrorStatus(500), /server reported a problem/i);
  assert.match(describeErrorStatus(503), /server reported a problem/i);
});

test("keeps the plain wording for other error statuses", () => {
  assert.match(describeErrorStatus(404), /responded with an error \(404\)/i);
  assert.match(describeErrorStatus(410), /responded with an error \(410\)/i);
});

test("a refused page still reports the server as reachable", async () => {
  queued = [htmlResponse("Forbidden", 403)];
  const result = await fetchPage(`https://${HOST}/`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /refused/i);
  assert.equal(result.uptime?.isOnline, true, "the server answered, so it is up");
  assert.equal(result.uptime?.statusCode, 403);
});

// ---------------------------------------------------------------------------
// The shared audit deadline
// ---------------------------------------------------------------------------

test("stops immediately when the shared budget is already gone", async () => {
  // fetchPage no longer gets its own fresh clock — it uses the audit's.
  const spent = createDeadline(0);
  const result = await fetchPage(`https://${HOST}/`, spent);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /too long to respond/i);
  assert.equal(requested.length, 0, "nothing should have been requested");
});

test("does NOT retry over HTTP once the shared budget is gone", async () => {
  // The retry used to get a fresh 20 seconds, which is how one fetch could
  // take forty. It now shares the same clock.
  const deadline = createDeadline(80);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(input.toString());
    // Spend the whole budget, then fail as a connection error would.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const error = new TypeError("fetch failed");
    (error as unknown as { cause: unknown }).cause = { code: "ECONNREFUSED" };
    throw error;
  }) as typeof fetch;

  const result = await fetchPage(HOST, deadline); // bare host, so https is a guess

  assert.equal(result.ok, false);
  assert.equal(requested.length, 1, "the http retry should not have been attempted");
  assert.ok(requested[0].startsWith("https://"), "only the https attempt was made");
});

test("still retries over HTTP when the budget allows it", async () => {
  queued = [
    networkError("ECONNREFUSED"),
    htmlResponse("<html><body>Plain</body></html>"),
  ];
  const result = await fetchPage(HOST, createDeadline(5_000));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.httpsUnavailable, true);
  assert.equal(requested.length, 2);
});

test("a generous shared budget does not change ordinary behaviour", async () => {
  queued = [htmlResponse("<html><head><title>Hi</title></head><body></body></html>")];
  const result = await fetchPage(`https://${HOST}/`, createDeadline(10_000));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.uptime.statusCode, 200);
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

// ---------------------------------------------------------------------------
// The caller's byte limit is honoured
// ---------------------------------------------------------------------------

test("a body over the caller's limit is refused, not silently truncated", async () => {
  // A partly-read page would be graded as though it were the whole page —
  // missing headings and images that are simply past the cut.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("x".repeat(50_000), {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

  try {
    const result = await fetchPage("https://93.184.216.34/", createDeadline(5_000), 1_000);

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /could not be read in full/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a body inside the caller's limit is read normally", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html><body>small</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

  try {
    const result = await fetchPage("https://93.184.216.34/", createDeadline(5_000), 1_000_000);

    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.page.html, /small/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// "IT IS NOT A PAGE" AND "THE SERVER DID NOT SAY" ARE DIFFERENT FACTS
//
// A response carrying `Content-Type: application/pdf` is a statement: this is
// not a web page. A response carrying no Content-Type at all is the absence of
// a statement. Both used to produce "That address doesn't point to a web
// page", which asserts something about the client's website on the strength of
// a header the server left out.
//
// `fetch` is replaced and the host is a public IP literal, so nothing here
// contacts anything and no DNS query is needed.
// ---------------------------------------------------------------------------

const CT_HOST = "https://93.184.216.34";
const CT_HTML = "<html><head><title>T</title></head><body><p>hello</p></body></html>";
const realCtFetch = globalThis.fetch;

async function fetchWithHeaders(
  headers: Record<string, string> | null,
  body = CT_HTML,
  extra: { redirectFirst?: boolean } = {},
) {
  let hop = 0;
  globalThis.fetch = (async () => {
    hop += 1;
    if (extra.redirectFirst && hop === 1) {
      return new Response("", { status: 302, headers: { location: `${CT_HOST}/next` } });
    }
    /*
     * The Response constructor INVENTS a Content-Type for a string body, so a
     * fixture that simply omits the header is not testing a missing header at
     * all. It has to be removed after the fact.
     */
    const response = new Response(body, { status: 200, headers: headers ?? {} });
    if (headers === null) response.headers.delete("content-type");
    return response;
  }) as typeof fetch;

  try {
    return await fetchPage(`${CT_HOST}/`, createDeadline(10_000));
  } finally {
    globalThis.fetch = realCtFetch;
  }
}

// --- a declared HTML type is read, whatever its spelling -------------------

test("a declared HTML type is read as a page", async () => {
  for (const value of [
    "text/html",
    "text/html; charset=utf-8",
    "TEXT/HTML",
    "Text/HTML; charset=UTF-8",
    "application/xhtml+xml",
  ]) {
    const result = await fetchWithHeaders({ "content-type": value });
    assert.equal(result.ok, true, value);
    assert.equal(result.ok && result.page.contentType, value, "recorded exactly as sent");
  }
});

test("an upper-cased type is no longer refused", async () => {
  // Media types are case-insensitive, and `TEXT/HTML` used to be turned away
  // as though the address were not a web page at all.
  const result = await fetchWithHeaders({ "content-type": "TEXT/HTML" });

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.page.html.includes("hello"));
});

// --- a declared NON-HTML type is still a statement we can repeat ------------

test("a declared non-HTML type is still reported as not a web page", async () => {
  for (const value of ["application/pdf", "image/png", "application/json", "text/plain"]) {
    const result = await fetchWithHeaders({ "content-type": value });

    assert.equal(result.ok, false, value);
    assert.equal(!result.ok && result.reason, NOT_A_WEB_PAGE, value);
  }
});

// --- NO type at all is its own answer --------------------------------------

test("a missing Content-Type does NOT claim the address is not a web page", async () => {
  const result = await fetchWithHeaders(null);

  assert.equal(result.ok, false, "it is still not read as a page");
  assert.equal(!result.ok && result.reason, UNDECLARED_CONTENT_TYPE);
  assert.notEqual(!result.ok && result.reason, NOT_A_WEB_PAGE, "the two must stay apart");
  // The sentence describes our own limit, not a fault in the website.
  assert.match(!result.ok ? result.reason : "", /did not say/);
});

test("an empty Content-Type is treated as no Content-Type", async () => {
  for (const value of ["", "   "]) {
    const result = await fetchWithHeaders({ "content-type": value });
    assert.equal(!result.ok && result.reason, UNDECLARED_CONTENT_TYPE, JSON.stringify(value));
  }
});

test("an undeclared response is never read as a page", async () => {
  // It must not become a successful audit of a page nobody confirmed existed.
  const result = await fetchWithHeaders(null, "<html><body><h1>Looks like HTML</h1></body></html>");

  assert.equal(result.ok, false, "looking like HTML is not being declared HTML");
});

test("an undeclared response is refused before its body is downloaded", async () => {
  /*
   * The size cap is not bypassed — there is nothing to cap, because the body is
   * never read. Proved with a body that NEVER COMPLETES: if the fetch tried to
   * read it, this test would hang instead of returning. A flag set inside the
   * stream would prove nothing, because a stream fills its queue eagerly
   * whether or not anybody is reading.
   */
  globalThis.fetch = (async () => {
    const neverEnds = new ReadableStream({ pull() { /* never enqueues, never closes */ } });
    const response = new Response(neverEnds, { status: 200 });
    response.headers.delete("content-type");
    return response;
  }) as typeof fetch;

  try {
    const result = await fetchPage(`${CT_HOST}/`, createDeadline(10_000));
    assert.equal(!result.ok && result.reason, UNDECLARED_CONTENT_TYPE);
  } finally {
    globalThis.fetch = realCtFetch;
  }
});

test("the answer comes from the FINAL response in a redirect chain", async () => {
  // A redirect carries no content type of its own that matters; what counts is
  // what the address we ended up at declared.
  const undeclared = await fetchWithHeaders(null, CT_HTML, { redirectFirst: true });
  assert.equal(!undeclared.ok && undeclared.reason, UNDECLARED_CONTENT_TYPE);

  const declared = await fetchWithHeaders({ "content-type": "text/html" }, CT_HTML, {
    redirectFirst: true,
  });
  assert.equal(declared.ok, true);
  assert.equal(declared.ok && declared.page.redirectChain.length, 2, "the hop is still recorded");
});

test("an undeclared response still reports what the server DID tell us", async () => {
  // The server answered, and that is a real measurement worth keeping.
  const result = await fetchWithHeaders(null);

  assert.ok(!result.ok && result.uptime !== null);
  assert.equal(!result.ok && result.uptime?.isOnline, true);
  assert.equal(!result.ok && result.uptime?.statusCode, 200);
});
