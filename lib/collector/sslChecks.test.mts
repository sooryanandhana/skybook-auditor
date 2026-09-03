/**
 * Tests for the certificate check.
 *
 * The cases that matter most are ones no real website will provide on demand:
 * a certificate expiring in three days, one that expired last month, a
 * wildcard that does not cover the domain. Those are built here from the same
 * shape the platform hands us, so they can be checked exactly.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchHostname,
  describeCertificate,
  parseSubjectAltNames,
  classifyAuthorizationError,
  classifyConnectionFailure,
  summarise,
  runSslChecks,
} from "./sslChecks.ts";
import { createDeadline } from "./deadline.ts";

// ---------------------------------------------------------------------------
// Hostname matching
//
// Getting this wrong means reporting a mismatched certificate as valid, so
// every rule is pinned down explicitly.
// ---------------------------------------------------------------------------

test("an exact name matches", () => {
  assert.equal(matchHostname("example.com", ["example.com"]), "exact");
});

test("matching ignores capitalisation and a trailing dot", () => {
  assert.equal(matchHostname("EXAMPLE.com", ["example.com"]), "exact");
  assert.equal(matchHostname("example.com.", ["example.com"]), "exact");
  assert.equal(matchHostname("example.com", ["Example.COM."]), "exact");
});

test("a wildcard covers one subdomain level", () => {
  assert.equal(matchHostname("www.example.com", ["*.example.com"]), "wildcard");
  assert.equal(matchHostname("api.example.com", ["*.example.com"]), "wildcard");
});

test("a wildcard does NOT cover the bare domain", () => {
  // "*.example.com" needs a label to replace; "example.com" has none.
  assert.equal(matchHostname("example.com", ["*.example.com"]), "none");
});

test("a wildcard does NOT cover a deeper subdomain", () => {
  // A wildcard replaces exactly one label, never two.
  assert.equal(matchHostname("foo.bar.example.com", ["*.example.com"]), "none");
  assert.equal(matchHostname("a.b.c.example.com", ["*.example.com"]), "none");
});

test("matching is never a substring test", () => {
  // The failure this rule exists to prevent: a certificate for one domain
  // being accepted for another that merely contains its text.
  assert.equal(matchHostname("example.com", ["notexample.com"]), "none");
  assert.equal(matchHostname("example.com", ["example.com.evil.test"]), "none");
  assert.equal(matchHostname("example.com.evil.test", ["example.com"]), "none");
  assert.equal(matchHostname("myexample.com", ["*.example.com"]), "none");
});

test("an exact match wins over a wildcard on the same certificate", () => {
  assert.equal(
    matchHostname("www.example.com", ["*.example.com", "www.example.com"]),
    "exact",
  );
});

test("finds a match anywhere in the list", () => {
  const names = ["other.test", "*.example.com", "another.test"];
  assert.equal(matchHostname("shop.example.com", names), "wildcard");
});

test("refuses a wildcard that is too broad to mean anything", () => {
  // "*.com" would cover every .com domain; no certificate authority issues
  // one, and treating it as a match would be dangerous.
  assert.equal(matchHostname("example.com", ["*.com"]), "none");
  assert.equal(matchHostname("example.com", ["*."]), "none");
  assert.equal(matchHostname("example.com", ["*"]), "none");
});

test("an empty name list matches nothing", () => {
  assert.equal(matchHostname("example.com", []), "none");
  assert.equal(matchHostname("", ["example.com"]), "none");
});

// ---------------------------------------------------------------------------
// Reading Subject Alternative Names
// ---------------------------------------------------------------------------

test("reads the DNS names from a SAN field", () => {
  assert.deepEqual(
    parseSubjectAltNames("DNS:example.com, DNS:*.example.com"),
    ["example.com", "*.example.com"],
  );
});

test("ignores SAN entries that are not hostnames", () => {
  // A certificate can also list IP addresses and email addresses.
  assert.deepEqual(
    parseSubjectAltNames("DNS:example.com, IP Address:1.2.3.4, email:a@b.test"),
    ["example.com"],
  );
});

test("handles a missing or empty SAN field", () => {
  assert.deepEqual(parseSubjectAltNames(undefined), []);
  assert.deepEqual(parseSubjectAltNames(""), []);
});

// ---------------------------------------------------------------------------
// Describing a certificate
//
// Built from the platform's own shape, so expiry cases can be exact.
// ---------------------------------------------------------------------------

/** Builds a certificate as the platform reports one. */
function certificate(options: {
  from?: Date;
  to?: Date;
  sans?: string;
  subjectCN?: string;
  issuerCN?: string;
}) {
  const format = (date: Date) => date.toUTCString().replace("GMT", "GMT");
  return {
    valid_from: options.from ? format(options.from) : undefined,
    valid_to: options.to ? format(options.to) : undefined,
    subjectaltname: options.sans,
    subject: options.subjectCN ? { CN: options.subjectCN } : undefined,
    issuer: options.issuerCN ? { CN: options.issuerCN } : undefined,
  } as never;
}

const NOW = new Date("2026-06-01T00:00:00Z");
const daysFromNow = (days: number) =>
  new Date(NOW.getTime() + days * 86_400_000);

test("reads a healthy certificate", () => {
  const result = describeCertificate(
    certificate({
      from: daysFromNow(-30),
      to: daysFromNow(60),
      sans: "DNS:example.com, DNS:www.example.com",
      subjectCN: "example.com",
      issuerCN: "Let's Encrypt",
    }),
    "example.com",
    "TLSv1.3",
    NOW,
  );

  assert.equal(result.daysUntilExpiry, 60);
  assert.equal(result.issuer, "Let's Encrypt");
  assert.equal(result.subject, "example.com");
  assert.deepEqual(result.subjectAltNames, ["example.com", "www.example.com"]);
  assert.equal(result.coversHostname, true);
  assert.equal(result.hostnameMatch, "exact");
  assert.equal(result.protocol, "TLSv1.3");
});

test("counts down a certificate expiring soon", () => {
  // The valuable case: an expiry a client can still act on.
  const result = describeCertificate(
    certificate({ to: daysFromNow(3), sans: "DNS:example.com" }),
    "example.com",
    null,
    NOW,
  );
  assert.equal(result.daysUntilExpiry, 3);
});

test("reports an expired certificate as a negative count", () => {
  const result = describeCertificate(
    certificate({ to: daysFromNow(-21), sans: "DNS:example.com" }),
    "example.com",
    null,
    NOW,
  );
  assert.equal(result.daysUntilExpiry, -21);
});

test("reports an unreadable expiry as unknown, never as zero", () => {
  // Zero would read as "expires today", which is a claim we cannot make.
  const result = describeCertificate(
    certificate({ sans: "DNS:example.com" }),
    "example.com",
    null,
    NOW,
  );
  assert.equal(result.validTo, null);
  assert.equal(result.daysUntilExpiry, null);
});

test("spots a certificate that does not cover the address", () => {
  const result = describeCertificate(
    certificate({ to: daysFromNow(90), sans: "DNS:other.test" }),
    "example.com",
    null,
    NOW,
  );
  assert.equal(result.coversHostname, false);
  assert.equal(result.hostnameMatch, "none");
});

test("recognises a wildcard certificate", () => {
  const result = describeCertificate(
    certificate({ to: daysFromNow(90), sans: "DNS:*.example.com" }),
    "www.example.com",
    null,
    NOW,
  );
  assert.equal(result.hostnameMatch, "wildcard");
});

test("falls back to the subject name when a certificate has no SANs", () => {
  // Old but legal: before SANs were required, the subject carried the name.
  const result = describeCertificate(
    certificate({ to: daysFromNow(90), subjectCN: "example.com" }),
    "example.com",
    null,
    NOW,
  );
  assert.deepEqual(result.subjectAltNames, []);
  assert.equal(result.hostnameMatch, "exact");
});

// ---------------------------------------------------------------------------
// Classifying failures
//
// A certificate that expired, one issued for another address, and a server
// that never answered are three different findings.
// ---------------------------------------------------------------------------

test("names each kind of certificate problem", () => {
  const cases: Array<[string, string]> = [
    ["CERT_HAS_EXPIRED", "expired"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "wrong-hostname"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "untrusted"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(classifyAuthorizationError(code), expected, `for ${code}`);
    assert.equal(classifyAuthorizationError({ code }), expected, `for {code:${code}}`);
  }
});

test("calls an unrecognised validation failure untrusted, not nothing", () => {
  // The chain was rejected for a reason we have no name for. Saying nothing
  // would read as "validation passed".
  assert.equal(classifyAuthorizationError("SOME_NEW_CODE"), "untrusted");
});

test("reports no problem when there was no validation error", () => {
  assert.equal(classifyAuthorizationError(undefined), null);
  assert.equal(classifyAuthorizationError(""), null);
});

test("distinguishes connection failures from certificate failures", () => {
  /** A socket error as the platform raises one. */
  const socketError = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code });

  assert.equal(classifyConnectionFailure(socketError("ENOTFOUND")).failure, "host-not-found");
  assert.equal(classifyConnectionFailure(socketError("ECONNREFUSED")).failure, "connection-refused");
  assert.equal(classifyConnectionFailure(socketError("ETIMEDOUT")).failure, "timeout");
  assert.equal(classifyConnectionFailure(socketError("EPROTO")).failure, "handshake-failed");
});

// ---------------------------------------------------------------------------
// The safety guard runs before any socket is opened
// ---------------------------------------------------------------------------

test("refuses to open a TLS connection to a private address", async () => {
  // The hostname reaches a raw network socket, so the same guard that protects
  // the page fetch has to apply here.
  const result = await runSslChecks("127.0.0.1", true, createDeadline(5_000));

  assert.equal(result.status, "blocked");
  assert.equal(result.certificate, null);
  assert.equal(result.trusted, null, "we never found out, so this is unknown not false");
  assert.match(result.message, /private or internal/i);
});

test("refuses a public name that resolves to a private address", async () => {
  // localtest.me looks ordinary and points at 127.0.0.1.
  const result = await runSslChecks("localtest.me", true, createDeadline(5_000));
  assert.equal(result.status, "blocked");
});

test("does not check a certificate for a site served over plain HTTP", async () => {
  const result = await runSslChecks("example.com", false, createDeadline(5_000));

  assert.equal(result.status, "not-applicable");
  assert.equal(result.certificate, null);
  assert.equal(result.trusted, null);
  assert.match(result.message, /not served over HTTPS/i);
});

test("stops without connecting when the audit is already out of time", async () => {
  const result = await runSslChecks("example.com", true, createDeadline(0));

  assert.equal(result.status, "unreachable");
  assert.equal(result.failure, "timeout");
  assert.equal(result.trusted, null);
});

// ---------------------------------------------------------------------------
// The summary sentence
// ---------------------------------------------------------------------------

test("summarises a healthy certificate", () => {
  const cert = describeCertificate(
    certificate({ to: daysFromNow(60), sans: "DNS:example.com" }),
    "example.com",
    null,
    NOW,
  );
  const message = summarise(cert, true, null);
  assert.match(message, /expires in 60 days/i);
  assert.doesNotMatch(message, /not trust/i);
});

test("summarises an expired certificate in plain words", () => {
  const cert = describeCertificate(
    certificate({ to: daysFromNow(-1), sans: "DNS:example.com" }),
    "example.com",
    null,
    NOW,
  );
  const message = summarise(cert, false, "expired");
  assert.match(message, /expired 1 day ago/i);
  assert.match(message, /not trust/i);
});

test("mentions when a certificate does not cover the address", () => {
  const cert = describeCertificate(
    certificate({ to: daysFromNow(90), sans: "DNS:other.test" }),
    "example.com",
    null,
    NOW,
  );
  assert.match(summarise(cert, false, "wrong-hostname"), /does not cover this address/i);
});
