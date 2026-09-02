/**
 * Tests for URL normalisation.
 *
 * This is the entry point of the whole audit, and one of its outputs
 * (`schemeWasAssumed`) gates a security decision: whether the fetcher is
 * allowed to fall back to unencrypted HTTP. A regression here would weaken
 * that quietly, so it is worth pinning down precisely.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "./url.ts";

/** Small helper: assert success and return the parsed URL. */
function expectOk(input: string) {
  const result = normalizeUrl(input);
  assert.equal(result.ok, true, `expected "${input}" to be accepted`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

/** Small helper: assert rejection and return the reason. */
function expectRejected(input: string): string {
  const result = normalizeUrl(input);
  assert.equal(result.ok, false, `expected "${input}" to be rejected`);
  if (result.ok) throw new Error("unreachable");
  return result.reason;
}

test("adds https:// to a bare domain", () => {
  const result = expectOk("example.com");
  assert.equal(result.url.toString(), "https://example.com/");
  assert.equal(result.url.protocol, "https:");
});

test("marks the scheme as assumed when we added it", () => {
  // This flag is what permits the HTTP fallback later. It must be true only
  // when the user did NOT choose a scheme themselves.
  assert.equal(expectOk("example.com").schemeWasAssumed, true);
  assert.equal(expectOk("www.example.com/page").schemeWasAssumed, true);
});

test("marks the scheme as NOT assumed when the user typed one", () => {
  assert.equal(expectOk("https://example.com").schemeWasAssumed, false);
  assert.equal(expectOk("http://example.com").schemeWasAssumed, false);
});

test("preserves an explicit http:// instead of upgrading it", () => {
  // Silently upgrading would hide the fact that the site was asked for over
  // plain HTTP, which is itself an audit-relevant detail.
  const result = expectOk("http://example.com");
  assert.equal(result.url.protocol, "http:");
});

test("normalises an uppercase scheme and host", () => {
  const result = expectOk("HTTPS://Example.COM/Path");
  assert.equal(result.url.protocol, "https:");
  assert.equal(result.url.hostname, "example.com");
  // The path keeps its case: paths are case-sensitive, hostnames are not.
  assert.equal(result.url.pathname, "/Path");
});

test("keeps the path, query and port", () => {
  const result = expectOk("example.com:8080/some/page?q=1");
  assert.equal(result.url.pathname, "/some/page");
  assert.equal(result.url.search, "?q=1");
  assert.equal(result.url.port, "8080");
});

test("strips the #fragment", () => {
  // A fragment is never sent to the server, so keeping it would imply we
  // requested something we did not.
  const result = expectOk("example.com/page#section-two");
  assert.equal(result.url.hash, "");
  assert.equal(result.url.toString(), "https://example.com/page");
});

test("trims surrounding whitespace", () => {
  assert.equal(expectOk("  example.com  ").url.toString(), "https://example.com/");
});

test("rejects an empty input", () => {
  assert.match(expectRejected(""), /enter a website address/i);
  assert.match(expectRejected("   "), /enter a website address/i);
});

test("rejects input containing spaces", () => {
  assert.match(expectRejected("not a url"), /doesn't look like a website address/i);
});

test("rejects non-web protocols", () => {
  // file: could read local files; javascript: and data: are not websites.
  for (const input of [
    "file:///C:/Windows/win.ini",
    "ftp://example.com",
    "data://example.com",
  ]) {
    assert.match(
      expectRejected(input),
      /only http and https/i,
      `${input} should be rejected as a non-web protocol`,
    );
  }
});

test("rejects a hostname with no dot", () => {
  // "localhost" and "intranet" are not public websites. The safety check would
  // also catch these, but rejecting here gives a clearer message.
  for (const input of ["localhost", "http://localhost:3000", "intranet"]) {
    assert.match(expectRejected(input), /full website address/i);
  }
});

test("rejects text that cannot be parsed as a URL at all", () => {
  assert.match(expectRejected("https://"), /doesn't look like a website address/i);
});
