/**
 * Tests for the address safety check.
 *
 * This is the most security-sensitive code in the project: it decides whether
 * our server is allowed to fetch an address. A mistake here means the tool can
 * be pointed at a private network.
 *
 * These tests use no network — they check the address classification directly,
 * so they are fast and always give the same answer.
 *
 * Run with:  npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, safeFetch } from "./safety.ts";

test("allows ordinary public IPv4 addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.1.140"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("blocks loopback", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("blocks the three private IPv4 ranges", () => {
  const blocked = [
    "10.0.0.1", "10.255.255.255", // 10.0.0.0/8
    "172.16.0.1", "172.31.255.255", // 172.16.0.0/12
    "192.168.0.1", "192.168.1.1", // 192.168.0.0/16
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("does not over-block addresses that merely look private", () => {
  // 172.15.x and 172.32.x sit just OUTSIDE the private 172.16-31 range, and
  // 11.x is not 10.x. Blocking these would wrongly refuse real websites.
  for (const ip of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "9.255.255.255"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("blocks the cloud metadata address", () => {
  // 169.254.169.254 is where cloud servers keep their own credentials.
  // Reaching it via someone else's server is a well-known attack.
  assert.equal(isPublicAddress("169.254.169.254"), false);
  assert.equal(isPublicAddress("169.254.0.1"), false);
});

test("blocks other reserved IPv4 ranges", () => {
  const blocked = [
    "0.0.0.0", // "this network"
    "100.64.0.1", // carrier-grade NAT
    "192.0.0.1", // protocol assignments
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("blocks IPv6 loopback and private ranges", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("allows ordinary public IPv6 addresses", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("sees through IPv4 addresses disguised as IPv6", () => {
  // "::ffff:127.0.0.1" is loopback wearing an IPv6 costume. Checking only the
  // IPv6 rules would let it straight through.
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:192.168.1.1"), false);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
});

test("treats anything unparseable as unsafe", () => {
  // When in doubt, refuse. A malformed address should never be assumed public.
  for (const ip of ["", "not-an-ip", "999.999.999.999", "1.2.3"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

// ---------------------------------------------------------------------------
// The reserved ranges, at the edges that were wrong
// ---------------------------------------------------------------------------

test("only the two reserved /24s inside 192.0.0.0/16 are blocked", () => {
  // 192.0.0.0/24 and 192.0.2.0/24 are reserved; the rest of 192.0.x.x is not.
  for (const ip of ["192.0.0.1", "192.0.0.255", "192.0.2.1", "192.0.2.254"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} is reserved`);
  }
  for (const ip of ["192.0.43.7", "192.0.43.8", "192.0.32.8", "192.0.1.1", "192.0.100.1"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} is ordinary public space`);
  }
});

test("loopback, metadata and unspecified are blocked in every IPv6 spelling", () => {
  const blocked = [
    "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", // loopback
    "::", "0:0:0:0:0:0:0:0", // unspecified
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:1", // mapped loopback, dotted and hex
    "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", // mapped cloud metadata
    "::ffff:10.0.0.1", "::ffff:192.168.1.1", // mapped private
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("a mapped public address stays public whatever its spelling", () => {
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:0808:0808"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} is 8.8.8.8`);
  }
});

test("the classifier reduces an address to its bytes, not its text", () => {
  // The property behind D9: two spellings of one address get one verdict.
  assert.equal(isPublicAddress("::1"), isPublicAddress("0:0:0:0:0:0:0:1"));
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), isPublicAddress("::ffff:7f00:1"));
});

test("forms that are not private ranges stay public, so the fix does not over-block", () => {
  // These are deliberately NOT blocked (corpus D10 decisions): IPv4-compatible
  // and NAT64 are not ::ffff mapped, and the rest are ordinary global unicast.
  // A parser that blocked them would be a different, unapproved change.
  for (const ip of [
    "::127.0.0.1", // IPv4-compatible (deprecated), not ::ffff mapped
    "fec0::1", // site-local (deprecated)
    "2001:db8::1", // documentation
    "64:ff9b::7f00:1", "64:ff9b::808:808", // NAT64
    "2001:4860:4860::8888", "2606:4700:4700::1111", // ordinary public
  ]) {
    assert.equal(isPublicAddress(ip), true, `${ip} must stay public`);
  }
});

test("malformed IPv6-shaped input is refused, never assumed public", () => {
  for (const ip of ["1:2:3", "::ffff:999.0.0.1", "gggg::1", "1::2::3"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be refused`);
  }
});

// ---------------------------------------------------------------------------
// safeFetch — the redirect guard
//
// A site can answer any request with "go look over there instead". Checking
// only the address we started with is not enough, because "over there" may be
// inside a private network. These tests replace `fetch` with a stand-in and
// use IP literals as hosts, so no network is contacted.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let queued: Response[] = [];
let requested: string[] = [];

beforeEach(() => {
  queued = [];
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(input.toString());
    const next = queued.shift();
    if (!next) throw new Error("test asked for more requests than were queued");
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A 3xx response pointing somewhere else. */
function redirectTo(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

test("safeFetch refuses a redirect that lands on loopback", async () => {
  queued = [redirectTo("http://127.0.0.1/secret")];
  const response = await safeFetch("https://93.184.216.34/");

  assert.equal(response, null, "the redirect target must not be fetched");
  assert.equal(requested.length, 1, "only the first address should be requested");
});

test("safeFetch refuses a redirect that lands on a private network", async () => {
  queued = [redirectTo("http://192.168.1.1/")];
  const response = await safeFetch("https://93.184.216.34/");

  assert.equal(response, null);
  assert.equal(requested.length, 1);
});

test("safeFetch refuses a redirect to the cloud metadata address", async () => {
  queued = [redirectTo("http://169.254.169.254/latest/meta-data/")];
  assert.equal(await safeFetch("https://93.184.216.34/"), null);
});

test("safeFetch follows a redirect to a public address", async () => {
  queued = [redirectTo("https://1.1.1.1/moved"), new Response("done", { status: 200 })];
  const response = await safeFetch("https://93.184.216.34/");

  assert.notEqual(response, null);
  assert.equal(response?.status, 200);
  assert.deepEqual(requested, ["https://93.184.216.34/", "https://1.1.1.1/moved"]);
});

test("safeFetch releases the body of a redirect it follows, not leaving the connection open", async () => {
  // The intermediate hop's body is never returned to the caller, so it must be
  // cancelled before the next hop or its connection is held open.
  let cancelled = false;
  const redirectBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("moved"));
    },
    cancel() {
      cancelled = true;
    },
  });
  queued = [
    new Response(redirectBody, { status: 302, headers: { location: "https://1.1.1.1/moved" } }),
    new Response("done", { status: 200 }),
  ];

  const response = await safeFetch("https://93.184.216.34/");

  assert.equal(response?.status, 200);
  assert.equal(cancelled, true, "the redirect body's stream was cancelled");
});

test("safeFetch refuses a redirect to a non-web protocol", async () => {
  queued = [redirectTo("file:///C:/Windows/win.ini")];
  assert.equal(await safeFetch("https://93.184.216.34/"), null);
});

test("safeFetch refuses an unsafe address given directly", async () => {
  assert.equal(await safeFetch("http://127.0.0.1/"), null);
  assert.equal(requested.length, 0, "nothing should have been requested");
});

test("safeFetch gives up rather than following redirects forever", async () => {
  queued = Array.from({ length: 10 }, () => redirectTo("https://1.1.1.1/again"));
  assert.equal(await safeFetch("https://93.184.216.34/"), null);
});

test("safeFetch returns an ordinary response unchanged", async () => {
  queued = [new Response("hello", { status: 200 })];
  const response = await safeFetch("https://93.184.216.34/");

  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "hello");
});
