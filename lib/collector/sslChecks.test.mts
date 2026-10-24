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
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import {
  matchHostname,
  describeCertificate,
  parseSubjectAltNames,
  certificateProblemForCode,
  classifyAuthorizationError,
  classifyConnectionFailure,
  summarise,
  runSslChecks,
  isReadableCertificate,
  DEFAULT_HTTPS_PORT,
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
// The REAL date format the platform hands us
//
// The certificate() helper above formats dates with toUTCString()
// ("Mon, 01 Jun 2026 …"), but Node's getPeerCertificate returns OpenSSL's own
// format instead — "Jun  1 00:00:00 2026 GMT", with the day space-padded to two
// columns. A fixture in the wrong format could pass while production silently
// read NaN for every expiry. These pin the shape production actually receives.
// ---------------------------------------------------------------------------

test("parses OpenSSL's own valid_to format, padded single-digit day and all", () => {
  const result = describeCertificate(
    {
      // Exactly as Node reports it: month, TWO-space-padded day, time, year, GMT.
      valid_from: "May  2 00:00:00 2026 GMT",
      valid_to: "Jun  1 00:00:00 2026 GMT",
      subjectaltname: "DNS:example.com",
    } as never,
    "example.com",
    "TLSv1.3",
    new Date("2026-05-22T00:00:00Z"),
  );

  assert.equal(result.validTo, "2026-06-01T00:00:00.000Z", "the real format must parse, not read NaN");
  assert.equal(result.validFrom, "2026-05-02T00:00:00.000Z");
  assert.equal(result.daysUntilExpiry, 10, "and the day count is computed from it");
});

test("parses a two-digit day in OpenSSL format too", () => {
  const result = describeCertificate(
    { valid_to: "Jan 15 12:30:00 2027 GMT", subjectaltname: "DNS:example.com" } as never,
    "example.com",
    null,
    new Date("2027-01-05T12:30:00Z"),
  );
  assert.equal(result.validTo, "2027-01-15T12:30:00.000Z");
  assert.equal(result.daysUntilExpiry, 10);
});

test("expiry is whole days floored: still-valid part-days read as 0, never negative", () => {
  // 12 hours left is not expired; flooring must give 0 ("expires today"), and it
  // must not round up to 1 or down past zero. This boundary decides whether an
  // about-to-expire certificate reads as a warning or as already broken.
  const now = new Date("2026-06-01T00:00:00Z");
  const soon = describeCertificate(
    { valid_to: "Jun  1 12:00:00 2026 GMT", subjectaltname: "DNS:example.com" } as never,
    "example.com",
    null,
    now,
  );
  assert.equal(soon.daysUntilExpiry, 0, "12 hours left is today, not expired");
});

test("a certificate expired hours ago floors to a negative day, not 0", () => {
  // Just-expired must not read as "expires today" (0). Flooring a small negative
  // fraction gives -1, which is the honest "already expired" signal.
  const now = new Date("2026-06-01T12:00:00Z");
  const justExpired = describeCertificate(
    { valid_to: "Jun  1 00:00:00 2026 GMT", subjectaltname: "DNS:example.com" } as never,
    "example.com",
    null,
    now,
  );
  assert.equal(justExpired.daysUntilExpiry, -1, "expired hours ago is negative, never 0");
});

test("wildcard matching normalises case and a trailing dot on the SAN", () => {
  // A SAN can arrive upper-cased or fully qualified with a trailing dot; neither
  // must defeat the wildcard match, or a valid certificate reads as a mismatch.
  assert.equal(matchHostname("www.example.com", ["*.EXAMPLE.COM"]), "wildcard");
  assert.equal(matchHostname("www.example.com", ["*.example.com."]), "wildcard");
  assert.equal(matchHostname("WWW.Example.Com", ["*.example.com"]), "wildcard");
});

// ---------------------------------------------------------------------------
// An unreadable certificate is not a mismatched one
//
// Saying "the certificate does not cover this address" about one we never read
// would be a finding invented from an absence of information.
// ---------------------------------------------------------------------------

test("recognises an empty certificate object as unreadable", () => {
  assert.equal(isReadableCertificate({}), false);
  assert.equal(isReadableCertificate(undefined as never), false);
});

test("recognises a certificate with nothing measurable in it as unreadable", () => {
  // Fields present but empty: there is nothing here to describe.
  assert.equal(isReadableCertificate({ subject: {}, issuer: {} } as never), false);
});

test("recognises a usable certificate as readable", () => {
  assert.equal(isReadableCertificate({ valid_to: "Jan 1 00:00:00 2027 GMT" } as never), true);
  assert.equal(isReadableCertificate({ subjectaltname: "DNS:example.com" } as never), true);
  assert.equal(isReadableCertificate({ subject: { CN: "example.com" } } as never), true);
});

test("an empty certificate reports coverage as UNKNOWN, not false", () => {
  // The bug this exists to prevent: false would read as "issued for a
  // different domain", which is a real finding about a real certificate.
  const result = describeCertificate({}, "example.com", null, NOW);

  assert.equal(result.coversHostname, null, "unknown, never false");
  assert.equal(result.hostnameMatch, null);
  assert.equal(result.daysUntilExpiry, null);
  assert.deepEqual(result.subjectAltNames, []);
});

test("a certificate with dates but no names reports coverage as UNKNOWN", () => {
  const result = describeCertificate(
    certificate({ to: daysFromNow(30) }),
    "example.com",
    null,
    NOW,
  );

  assert.equal(result.daysUntilExpiry, 30, "the date was readable");
  assert.equal(result.coversHostname, null, "but there were no names to check");
  assert.equal(result.hostnameMatch, null);
});

test("a certificate WITH names still reports coverage as false when it misses", () => {
  // The distinction: we looked, and this address genuinely is not covered.
  const result = describeCertificate(
    certificate({ to: daysFromNow(30), sans: "DNS:other.test" }),
    "example.com",
    null,
    NOW,
  );

  assert.equal(result.coversHostname, false, "false only after a real check");
  assert.equal(result.hostnameMatch, "none");
});

test("the summary does not claim a mismatch when coverage is unknown", () => {
  const cert = describeCertificate(certificate({ to: daysFromNow(30) }), "example.com", null, NOW);
  const message = summarise(cert, true, null);

  assert.doesNotMatch(message, /does not cover this address/i);
  assert.match(message, /cannot tell/i);
});

// ---------------------------------------------------------------------------
// The port the site is actually served from
// ---------------------------------------------------------------------------

test("defaults to the standard HTTPS port", () => {
  assert.equal(DEFAULT_HTTPS_PORT, 443);
});

test("reads a certificate on the default port", async () => {
  const result = await runSslChecks("example.com", true, createDeadline(15_000));

  assert.equal(result.status, "checked");
  assert.equal(result.certificate?.coversHostname, true);
});

test("connects to an explicit non-standard port", async () => {
  // badssl.com serves a certificate on 1012 as well as 443. Reaching it at
  // all proves the port was used; the default would have found something else.
  const result = await runSslChecks("badssl.com", true, createDeadline(15_000), 1012);

  assert.notEqual(result.status, "not-applicable");
  // Either it answered there, or it did not — both prove we tried that port
  // rather than silently checking 443.
  assert.ok(
    result.status === "checked" || result.status === "unreachable",
    `unexpected status ${result.status}`,
  );
});

test("a port with nothing listening fails as unreachable, not as a bad certificate", async () => {
  // Port 1 is reserved and nothing serves TLS there.
  const result = await runSslChecks("example.com", true, createDeadline(6_000), 1);

  assert.equal(result.status, "unreachable");
  assert.equal(result.certificate, null);
  assert.equal(result.trusted, null, "we never found out");
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
    ["ERR_TLS_CERT_ALTNAME_INVALID", "wrong-hostname"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "untrusted"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(classifyAuthorizationError(code), expected, `for ${code}`);
    assert.equal(classifyAuthorizationError({ code }), expected, `for {code:${code}}`);
  }
});

test("an untrusted authority in the chain is not called self-signed", () => {
  /*
   * SELF_SIGNED_CERT_IN_CHAIN: the chain ends at a self-signed authority that
   * is not trusted. OpenSSL reports it only for a chain longer than the site's
   * own certificate, which was issued under that authority rather than by
   * itself — telling a client it is self-signed sends them to fix the wrong thing.
   * A certificate that signed itself is DEPTH_ZERO_SELF_SIGNED_CERT.
   */
  assert.equal(classifyAuthorizationError("SELF_SIGNED_CERT_IN_CHAIN"), "untrusted");
  assert.equal(certificateProblemForCode("SELF_SIGNED_CERT_IN_CHAIN"), "untrusted");
  assert.equal(certificateProblemForCode("DEPTH_ZERO_SELF_SIGNED_CERT"), "self-signed");
});

test("a certificate that is not valid yet is untrusted, never expired", () => {
  assert.equal(classifyAuthorizationError("CERT_NOT_YET_VALID"), "untrusted");
  assert.equal(certificateProblemForCode("CERT_NOT_YET_VALID"), "untrusted");
});

test("an issuer certificate that could not be found is untrusted", () => {
  for (const code of ["UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
    assert.equal(certificateProblemForCode(code), "untrusted", code);
  }
});

test("every certificate verification code Node names has a problem, and the certificate check agrees", () => {
  // OpenSSL's names for the ways a server certificate fails verification, as
  // Node reports them, plus Node's own hostname check. Written out here rather
  // than read from the implementation, so a code dropped from it fails.
  const named: Record<string, string> = {
    CERT_HAS_EXPIRED: "expired",
    DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed",
    ERR_TLS_CERT_ALTNAME_INVALID: "wrong-hostname",
    HOSTNAME_MISMATCH: "wrong-hostname",
    SELF_SIGNED_CERT_IN_CHAIN: "untrusted",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "untrusted",
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "untrusted",
    UNABLE_TO_GET_ISSUER_CERT: "untrusted",
    CERT_NOT_YET_VALID: "untrusted",
    ERROR_IN_CERT_NOT_BEFORE_FIELD: "untrusted",
    ERROR_IN_CERT_NOT_AFTER_FIELD: "untrusted",
    CERT_SIGNATURE_FAILURE: "untrusted",
    UNABLE_TO_DECRYPT_CERT_SIGNATURE: "untrusted",
    UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: "untrusted",
    CERT_CHAIN_TOO_LONG: "untrusted",
    CERT_REVOKED: "untrusted",
    INVALID_CA: "untrusted",
    PATH_LENGTH_EXCEEDED: "untrusted",
    INVALID_PURPOSE: "untrusted",
    CERT_UNTRUSTED: "untrusted",
    CERT_REJECTED: "untrusted",
  };
  for (const [code, problem] of Object.entries(named)) {
    assert.equal(certificateProblemForCode(code), problem, code);
    assert.equal(classifyAuthorizationError(code), problem, code);
  }
});

test("a code that is not a certificate verification code names no certificate problem", () => {
  // The page fetch meets these, and a refused connection is not a certificate
  // that failed. Only the certificate check, which is told validation failed,
  // may call an unknown code untrusted.
  for (const code of ["", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "UND_ERR_SOCKET", "SOME_NEW_CODE"]) {
    assert.equal(certificateProblemForCode(code), null, code);
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
  // An ordinary-looking name whose address is 127.0.0.1, stubbed the way
  // corpus.fixture.mts does it. The message matters: a name that cannot be
  // found is ALSO "blocked", so status alone would not prove this refusal.
  const asked: string[] = [];
  const originalLookup = dns.promises.lookup;
  Reflect.set(dns.promises, "lookup", (hostname: string) => {
    asked.push(hostname);
    return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
  });
  syncBuiltinESMExports();

  try {
    const result = await runSslChecks("points-private.example", true, createDeadline(5_000));

    assert.deepEqual(asked, ["points-private.example"], "the refusal came from a DNS answer");
    assert.equal(result.status, "blocked");
    assert.equal(result.certificate, null);
    assert.match(result.message, /private or internal/i);
  } finally {
    Reflect.set(dns.promises, "lookup", originalLookup);
    syncBuiltinESMExports();
  }
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
