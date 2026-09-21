/**
 * Corpus D — which addresses the audit treats as public.
 *
 * Yardsticks: the IANA IPv4 and IPv6 Special-Purpose Address Registries, and
 * the security invariant that the audit must never connect to a private,
 * loopback, link-local or metadata address.
 *
 * The classifier is tested directly, and through `checkHostnameIsPublic` and
 * the page fetcher, with IP literals and stubbed names only. Bracketed IPv6
 * hostnames are deliberately absent: how the operating system's resolver treats
 * "[::1]" differs between Windows and Linux, so no single expectation holds.
 */
import assert from "node:assert/strict";

import { createDeadline } from "../collector/deadline.ts";
import { fetchPage } from "../collector/fetchPage.ts";
import { checkHostnameIsPublic, isPublicAddress } from "../collector/safety.ts";
import { normalizeUrl } from "../collector/url.ts";
import { correct, decision, installOfflineCorpus, withServer } from "./corpus.fixture.mts";

const offline = installOfflineCorpus();

/** Asserts the classifier's verdict for each address, naming the address on failure. */
function expectVerdicts(verdicts: Record<string, boolean>) {
  for (const [address, isPublic] of Object.entries(verdicts)) {
    assert.equal(isPublicAddress(address), isPublic, `${address} should be ${isPublic ? "public" : "blocked"}`);
  }
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

correct("D1 loopback, private, carrier-grade NAT, link-local and 'this network' ranges are blocked at both edges", () => {
  expectVerdicts({
    "127.0.0.1": false,
    "127.255.255.254": false,
    "10.0.0.1": false,
    "10.255.255.255": false,
    "172.16.0.1": false,
    "172.31.255.255": false,
    "192.168.0.1": false,
    "192.168.255.255": false,
    "100.64.0.1": false,
    "100.127.255.255": false,
    "169.254.0.1": false,
    "169.254.169.254": false,
    "0.0.0.0": false,
  });
});

correct("D2 addresses just outside those ranges stay public", () => {
  expectVerdicts({
    "11.0.0.1": true,
    "172.15.255.255": true,
    "172.32.0.1": true,
    "192.167.255.255": true,
    "192.169.0.1": true,
    "100.63.255.255": true,
    "100.128.0.1": true,
    "8.8.8.8": true,
    "93.184.216.34": true,
  });
});

correct("D3 benchmarking, multicast, reserved and broadcast addresses are blocked", () => {
  expectVerdicts({
    "198.18.0.1": false,
    "198.19.255.255": false,
    "198.20.0.1": true,
    "224.0.0.1": false,
    "239.255.255.255": false,
    "240.0.0.1": false,
    "255.255.255.255": false,
  });
});

correct("D4 the two IANA-reserved blocks inside 192.0.0.0/16 are blocked: 192.0.0.0/24 and 192.0.2.0/24", () => {
  expectVerdicts({ "192.0.0.8": false, "192.0.2.1": false });
});

correct("D5 the 192.0.0.0/16 block is narrowed to the two reserved /24s, freeing icann.org and iana.org", () => {
  // Only 192.0.0.0/24 (protocol assignments) and 192.0.2.0/24 (documentation)
  // are reserved in that space; 192.0.43.x (icann.org, iana.org) is ordinary,
  // routable, auditable address space. (Was a : the whole /16 was blocked
  // and the audit refused icann.org and iana.org as "a private network".)
  expectVerdicts({ "192.0.43.7": true, "192.0.43.8": true, "192.0.32.8": true, "192.0.0.8": false, "192.0.2.1": false });
});

decision("D6 the documentation ranges 198.51.100.0/24 and 203.0.113.0/24, and 192.88.99.0/24, are treated as public", () => {
  // Not private networks and not routable on the internet, so no internal
  // service is reachable through them. The registry marks them not globally
  // reachable; blocking them is defence in depth, and a decision.
  expectVerdicts({ "198.51.100.1": true, "203.0.113.5": true, "192.88.99.1": true });
});

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

correct("D7 IPv6 loopback, unspecified, unique-local, link-local and multicast addresses are blocked", () => {
  expectVerdicts({ "::1": false, "::": false, "fc00::1": false, "fd12:3456::1": false, "fe80::1": false, "ff02::1": false });
});

correct("D8 IPv4-mapped IPv6 in dotted form is judged by the IPv4 rules", () => {
  expectVerdicts({
    "::ffff:127.0.0.1": false,
    "::ffff:10.0.0.1": false,
    "::ffff:169.254.169.254": false,
    "::ffff:8.8.8.8": true,
    "2001:4860:4860::8888": true,
  });
});

correct("D9 loopback and metadata are blocked in every valid IPv6 spelling, not just the ones typed as strings", () => {
  // "::ffff:7f00:1" is ::ffff:127.0.0.1 in hex, "::ffff:a9fe:a9fe" is the
  // metadata address, "0:0:0:0:0:0:0:1" is ::1 uncompressed. The classifier now
  // reduces an address to its bytes before judging it, so a spelling cannot
  // slip past. (Was a defence-in-depth defect: the string-matcher missed these.)
  expectVerdicts({ "::ffff:7f00:1": false, "::ffff:a9fe:a9fe": false, "0:0:0:0:0:0:0:1": false });
});

decision("D10 deprecated and translated IPv6 forms are treated as public", () => {
  // "::127.0.0.1" (IPv4-compatible, deprecated), "fec0::1" (site-local,
  // deprecated) and "2001:db8::1" (documentation) are not routed on the
  // internet. "64:ff9b::7f00:1" is NAT64 wrapping 127.0.0.1, while
  // "64:ff9b::808:808" wraps the public 8.8.8.8 — blocking the whole NAT64
  // prefix would make every IPv4 site unauditable from an IPv6-only host, so
  // how to handle it is a decision.
  expectVerdicts({
    "::127.0.0.1": true,
    "fec0::1": true,
    "2001:db8::1": true,
    "64:ff9b::7f00:1": true,
    "64:ff9b::808:808": true,
  });
});

correct("D11 anything that is not an IP address is refused, never assumed public", () => {
  expectVerdicts({ "[::1]": false, "not-an-ip": false, "": false });
});

// ---------------------------------------------------------------------------
// Hostnames and typed addresses
// ---------------------------------------------------------------------------

correct("D12 a hostname is public only if every address it resolves to is public", async () => {
  offline.hosts.set("localhost", ["127.0.0.1", "::1"]);
  offline.hosts.set("mixed.corpus.example", ["93.184.216.34", "10.0.0.1"]);
  offline.hosts.set("public.corpus.example", ["93.184.216.34", "2001:4860:4860::8888"]);
  assert.equal((await checkHostnameIsPublic("localhost")).safe, false);
  assert.equal((await checkHostnameIsPublic("mixed.corpus.example")).safe, false);
  assert.equal((await checkHostnameIsPublic("public.corpus.example")).safe, true);
  assert.equal((await checkHostnameIsPublic("10.0.0.1")).safe, false);
  const missing = await checkHostnameIsPublic("unregistered.corpus.example");
  assert.equal(missing.safe, false);
  if (!missing.safe) assert.equal(missing.reason, "That website address could not be found.");
});

correct("D13 the hex spelling of IPv4-mapped loopback is refused by the full hostname check too", async () => {
  // The same gap as D9, surfacing on the SSRF guard's public entry point.
  // (Was a defect: this literal was judged safe to fetch.)
  assert.equal((await checkHostnameIsPublic("::ffff:7f00:1")).safe, false);
});

correct("D14 loopback typed as 127.1, 0x7f000001 or 2130706433 is accepted as input but refused before any request", async () => {
  // normalizeUrl canonicalises all three to 127.0.0.1; the address check, not
  // the input check, is the defence, and it holds.
  for (const typed of ["http://127.1/", "http://0x7f000001/", "http://2130706433/"]) {
    const normalized = normalizeUrl(typed);
    assert.equal(normalized.ok, true, typed);
    if (!normalized.ok) continue;
    assert.equal(normalized.url.hostname, "127.0.0.1", typed);
    const outcome = await withServer(
      (_url, server) => server.respond("never"),
      async (server) => ({ result: await fetchPage(typed, createDeadline(5_000)), server }),
    );
    assert.equal(outcome.result.ok, false, typed);
    assert.deepEqual(outcome.server.requests, [], typed);
  }
});

correct("D15 localhost and bracketed IPv6 literals are refused at input for having no dot", () => {
  for (const typed of ["http://localhost/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
    const normalized = normalizeUrl(typed);
    assert.equal(normalized.ok, false, typed);
  }
});
