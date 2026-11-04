/**
 * Tests for the security and SSL rules.
 *
 * The happy paths matter least here. What matters is that a failed lookup, an
 * unreadable certificate or an audit that ran out of time can never turn into
 * a security finding — because a report that invents a security problem is
 * worse than one that misses it. The client checks, finds nothing, and stops
 * believing the rest of the document.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { assertUniqueRuleIds, runRules } from "./runner.ts";
import { SECURITY_RULES } from "./security.ts";
import type { AuditFacts } from "./types.ts";
import type {
  CookieInfo,
  DnsData,
  EmailPolicyRecord,
  PerformanceData,
  SecurityData,
  SslData,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — a healthy site, then whatever a test wants to break
// ---------------------------------------------------------------------------

function header(present: boolean, value: string | null = null) {
  return { present, value };
}

function healthySecurity(overrides: Partial<SecurityData> = {}): SecurityData {
  return {
    servedOverHttps: true,
    strictTransportSecurity: header(true, "max-age=31536000"),
    contentSecurityPolicy: header(true, "default-src 'self'"),
    contentSecurityPolicyMeta: false,
    contentSecurityPolicyReportOnly: header(false),
    xFrameOptions: header(true, "DENY"),
    xContentTypeOptions: header(true, "nosniff"),
    referrerPolicy: header(true, "no-referrer"),
    permissionsPolicy: header(true, "geolocation=()"),
    hsts: {
      applicable: true,
      valid: true,
      maxAgeSeconds: 31_536_000,
      disabledByZeroMaxAge: false,
      includesSubdomains: true,
      preload: false,
    },
    mixedContent: {
      applicable: true,
      total: 0,
      activeCount: 0,
      upgradeInsecureRequests: false,
      items: [],
      truncated: false,
      notInspected: [],
    },
    cookies: { total: 0, cookies: [], notInspected: [] },
    insecureFormActions: [],
    ...overrides,
  } as SecurityData;
}

function healthySsl(overrides: Partial<SslData> = {}): SslData {
  return {
    status: "checked",
    hostname: "example.com",
    certificate: {
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
      daysUntilExpiry: 120,
      issuer: "Let's Encrypt",
      subject: "example.com",
      subjectAltNames: ["example.com", "www.example.com"],
      coversHostname: true,
      matchType: "exact",
    },
    trusted: true,
    problem: null,
    failure: null,
    message: "The certificate is valid.",
    ...overrides,
  } as SslData;
}

function policy(status: EmailPolicyRecord["status"], record: string | null = null): EmailPolicyRecord {
  return { status, record, error: status === "error" ? "Query timed out" : null };
}

/** DMARC lives at its own hostname, so it carries one alongside the record. */
function dmarcPolicy(
  status: EmailPolicyRecord["status"],
  record: string | null = null,
  /**
   * Where the policy came from. Stated rather than derived, so a test that is
   * about an inherited record has to say so outright.
   */
  source: Partial<Pick<DnsData["dmarc"], "policyDomain" | "inherited" | "effectivePolicy">> = {},
): DnsData["dmarc"] {
  return {
    ...policy(status, record),
    hostname: "_dmarc.example.com",
    appliesTo: "example.com",
    policyDomain: status === "found" ? "example.com" : null,
    inherited: false,
    effectivePolicy: null,
    ...source,
  };
}

function healthyDns(overrides: Partial<DnsData> = {}): DnsData {
  return {
    hostname: "example.com",
    emailDomain: "example.com",
    a: { status: "found", records: ["93.184.216.34"], error: null },
    aaaa: { status: "found", records: [], error: null },
    mx: { status: "found", records: [], error: null },
    ns: { status: "found", records: ["ns1.example.com"], error: null },
    txt: { status: "found", records: [], error: null },
    spf: policy("found", "v=spf1 -all"),
    dmarc: dmarcPolicy("found", "v=DMARC1; p=reject"),
    ...overrides,
  } as DnsData;
}

function notCheckedPerformance(): PerformanceData {
  const message = "Speed was not measured: Google's speed test did not finish in time.";
  return {
    status: "error",
    strategy: "mobile",
    requestedUrl: "https://example.com/",
    failureReason: "timeout",
    field: {
      status: "error",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: message,
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
    message,
  };
}

function facts(overrides: Partial<AuditFacts> = {}): AuditFacts {
  return {
    website: { requestedUrl: "https://example.com/", checkedAt: "2026-09-03T00:00:00.000Z" },
    fetch: {
      finalUrl: "https://example.com/",
      redirectChain: ["https://example.com/"],
      wasRedirected: false,
      servedOverHttps: true,
      httpsUnavailable: false,
      certificateProblem: null,
      contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 120 },
    responseTime: null,
    seo: {} as AuditFacts["seo"],
    technical: null,
    performance: notCheckedPerformance(),
    security: healthySecurity(),
    ssl: healthySsl(),
    dns: healthyDns(),
    hosting: null,
    timedOut: false,
    ...overrides,
  };
}

/** Runs the whole security set and returns the ids that fired. */
function firedIds(overrides: Partial<AuditFacts> = {}): string[] {
  return runRules(facts(overrides), SECURITY_RULES)
    .findings.filter((f) => f.severity !== "good")
    .map((f) => f.id);
}

function findingFor(id: string, overrides: Partial<AuditFacts> = {}) {
  return runRules(facts(overrides), SECURITY_RULES).findings.find((f) => f.id === id);
}

function skipReason(id: string, overrides: Partial<AuditFacts> = {}) {
  return runRules(facts(overrides), SECURITY_RULES).skipped.find((s) => s.ruleId === id)?.reason;
}

const cookie = (over: Partial<CookieInfo> = {}): CookieInfo => ({
  name: "session",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  // A cookie the browser keeps, unless a case says otherwise.
  expired: false,
  ...over,
});

// ---------------------------------------------------------------------------
// The rule set itself
// ---------------------------------------------------------------------------

test("every rule id is unique and namespaced", () => {
  assert.doesNotThrow(() => assertUniqueRuleIds(SECURITY_RULES));

  for (const rule of SECURITY_RULES) {
    assert.ok(rule.id.startsWith("security."), `${rule.id} must be namespaced`);
    assert.equal(rule.category, "security");
    assert.notEqual(rule.severity as string, "good", "a rule may never declare good");
  }
});

test("a healthy site produces no security problems at all", () => {
  assert.deepEqual(firedIds(), []);
});

// ---------------------------------------------------------------------------
// A. Transport
// ---------------------------------------------------------------------------

test("no HTTPS: critical, with the fact behind it", () => {
  const finding = findingFor("security.https", {
    security: healthySecurity({
      servedOverHttps: false,
      hsts: { ...healthySecurity().hsts, applicable: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /plain HTTP/);
  assert.ok(finding.remediation.length > 0);
});

test("expired certificate: critical, and the days are the measured ones", () => {
  const finding = findingFor("security.ssl.expired", {
    ssl: healthySsl({
      certificate: { ...healthySsl().certificate!, daysUntilExpiry: -9, validTo: "2026-08-25" },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /9 day\(s\) ago/);
});

test("a valid certificate does not fire the expiry rule", () => {
  assert.equal(findingFor("security.ssl.expired"), undefined);
});

test("an unreadable expiry date is not an expired certificate", () => {
  // null means we could not read the date, not that it lapsed.
  const finding = findingFor("security.ssl.expired", {
    ssl: healthySsl({
      certificate: { ...healthySsl().certificate!, daysUntilExpiry: null, validTo: null },
    }),
  });

  assert.equal(finding, undefined);
});

test("hostname mismatch: critical, listing the names actually covered", () => {
  const finding = findingFor("security.ssl.hostname", {
    ssl: healthySsl({
      hostname: "shop.example.com",
      certificate: {
        ...healthySsl().certificate!,
        coversHostname: false,
        subjectAltNames: ["example.com", "www.example.com"],
      },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /shop\.example\.com/);
  assert.match(finding.evidence, /www\.example\.com/);
});

test("coversHostname: null is unknown and must never become a mismatch", () => {
  // The certificate carried no names we could check. Saying it does not cover
  // this address would be a claim about something we never read.
  const finding = findingFor("security.ssl.hostname", {
    ssl: healthySsl({
      certificate: { ...healthySsl().certificate!, coversHostname: null, subjectAltNames: [] },
    }),
  });

  assert.equal(finding, undefined, "unknown is not a mismatch");
});

test("untrusted certificate: critical", () => {
  const finding = findingFor("security.ssl.untrusted", {
    ssl: healthySsl({ trusted: false, problem: "self-signed" }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /self-signed/);
});

test("trusted: null is unknown and must never become untrusted", () => {
  assert.equal(findingFor("security.ssl.untrusted", { ssl: healthySsl({ trusted: null }) }), undefined);
});

// ---------------------------------------------------------------------------
// One certificate cause, one finding
// ---------------------------------------------------------------------------

/** A certificate the platform rejected, with its own facts adjusted. */
function rejected(
  problem: SslData["problem"],
  facts: Partial<NonNullable<SslData["certificate"]>> = {},
): Partial<AuditFacts> {
  return {
    ssl: healthySsl({ trusted: false, problem, certificate: { ...healthySsl().certificate!, ...facts } }),
  };
}

/** The certificate findings that fired, in a fixed order. */
function certificateIds(overrides: Partial<AuditFacts>): string[] {
  return firedIds(overrides).filter((id) => id.startsWith("security.ssl.")).sort();
}

test("an expired certificate, rejected for expiring, is one Critical finding, not two", () => {
  const overrides = rejected("expired", { daysUntilExpiry: -9, validTo: "2026-08-25" });

  assert.deepEqual(certificateIds(overrides), ["security.ssl.expired"]);
  assert.equal(findingFor("security.ssl.expired", overrides)?.severity, "critical");
});

test("a certificate for another address, rejected for that, is one Critical finding, not two", () => {
  const overrides = rejected("wrong-hostname", { coversHostname: false, subjectAltNames: ["other.example"] });

  assert.deepEqual(certificateIds(overrides), ["security.ssl.hostname"]);
  assert.equal(findingFor("security.ssl.hostname", overrides)?.severity, "critical");
});

test("an authority that is not trusted is reported as not trusted, once", () => {
  // SELF_SIGNED_CERT_IN_CHAIN and a missing issuer both arrive as "untrusted".
  const overrides = rejected("untrusted");

  assert.deepEqual(certificateIds(overrides), ["security.ssl.untrusted"]);
  assert.match(findingFor("security.ssl.untrusted", overrides)?.evidence ?? "", /\(untrusted\)/);
});

test("a certificate not valid yet is reported as not trusted, and never as expired", () => {
  // Its expiry date is in the future; CERT_NOT_YET_VALID arrives as "untrusted".
  assert.deepEqual(certificateIds(rejected("untrusted", { daysUntilExpiry: 471 })), ["security.ssl.untrusted"]);
});

test("an expiry the site's own certificate does not show is still reported, not silently dropped", () => {
  /*
   * An expired intermediate. The platform rejects the chain as "expired", but
   * the certificate we read — the site's own — has months left, so the expiry
   * rule rightly stays silent. Without this rule the rejection would reach the
   * report as nothing at all.
   */
  assert.deepEqual(certificateIds(rejected("expired", { daysUntilExpiry: 107 })), ["security.ssl.untrusted"]);
  assert.deepEqual(certificateIds(rejected("expired", { daysUntilExpiry: null, validTo: null })), ["security.ssl.untrusted"]);
});

test("a hostname rejection the certificate's names cannot show is still reported", () => {
  // No names to compare, so the hostname rule cannot say "does not cover".
  // The platform's verdict is still a measurement.
  assert.deepEqual(
    certificateIds(rejected("wrong-hostname", { coversHostname: null, subjectAltNames: [] })),
    ["security.ssl.untrusted"],
  );
});

test("two different causes are still two findings", () => {
  // Expired AND for another address: the platform names only the first.
  assert.deepEqual(
    certificateIds(rejected("expired", { daysUntilExpiry: -258, coversHostname: false })),
    ["security.ssl.expired", "security.ssl.hostname"],
  );
  // For another address AND under an authority that is not trusted.
  assert.deepEqual(
    certificateIds(rejected("untrusted", { coversHostname: false })),
    ["security.ssl.hostname", "security.ssl.untrusted"],
  );
  // Self-signed AND expired.
  assert.deepEqual(
    certificateIds(rejected("self-signed", { daysUntilExpiry: -1 })),
    ["security.ssl.expired", "security.ssl.untrusted"],
  );
});

test("every rejection is reported, and no cause is ever reported twice", () => {
  /*
   * Every combination of the platform's reason and the certificate's own
   * facts. Read from the rules' actual findings, not restated conditions, so
   * the expiry or hostname rule changing without this one fails here.
   */
  const problems: Array<SslData["problem"]> = [null, "expired", "self-signed", "wrong-hostname", "untrusted"];

  for (const problem of problems) {
    for (const daysUntilExpiry of [null, -30, 0, 30]) {
      for (const coversHostname of [null, false, true]) {
        const fired = certificateIds(rejected(problem, { daysUntilExpiry, coversHostname }));
        const label = `problem ${problem}, days ${daysUntilExpiry}, covers ${coversHostname}`;

        assert.ok(fired.length > 0, `${label}: a rejected certificate produced no finding`);

        const reportedByItsOwnRule =
          (problem === "expired" && fired.includes("security.ssl.expired")) ||
          (problem === "wrong-hostname" && fired.includes("security.ssl.hostname"));
        assert.equal(fired.includes("security.ssl.untrusted"), !reportedByItsOwnRule, label);
      }
    }
  }
});

test("mixed content: high, and names how many a browser will block", () => {
  const finding = findingFor("security.mixed-content", {
    security: healthySecurity({
      mixedContent: {
        ...healthySecurity().mixedContent,
        total: 7,
        activeCount: 2,
      },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.match(finding.evidence, /7 insecure resource/);
  assert.match(finding.evidence, /2 of them/);
});

test("insecure form action: critical, naming the addresses", () => {
  const finding = findingFor("security.form.insecure", {
    security: healthySecurity({ insecureFormActions: ["http://example.com/login"] }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.evidence, /http:\/\/example\.com\/login/);
});

// An enforced upgrade-insecure-requests policy makes browsers rewrite these
// references to https:// before loading them, so they are not the live exposure
// the finding describes. Suppressed for BOTH passive and active content, and
// only the finding is suppressed -- the references stay measured. Report-only
// never reaches here: it leaves upgradeInsecureRequests false by construction.
const mixedWithUir = (over: Partial<SecurityData["mixedContent"]>) =>
  healthySecurity({
    mixedContent: { ...healthySecurity().mixedContent, ...over },
  });

test("enforced UIR suppresses the finding for passive mixed content", () => {
  const overrides = { security: mixedWithUir({ total: 1, activeCount: 0, upgradeInsecureRequests: true }) };
  assert.equal(findingFor("security.mixed-content", overrides), undefined);
  // But the measurement is untouched: the reference is still counted.
  assert.equal(overrides.security.mixedContent.total, 1);
});

test("enforced UIR suppresses the finding for active mixed content too", () => {
  const overrides = { security: mixedWithUir({ total: 2, activeCount: 2, upgradeInsecureRequests: true }) };
  assert.equal(findingFor("security.mixed-content", overrides), undefined);
});

test("without enforced UIR the mixed-content finding still fires (regression guard)", () => {
  const passive = findingFor("security.mixed-content", {
    security: mixedWithUir({ total: 1, activeCount: 0, upgradeInsecureRequests: false }),
  });
  assert.equal(passive?.severity, "high");

  const active = findingFor("security.mixed-content", {
    security: mixedWithUir({ total: 2, activeCount: 2, upgradeInsecureRequests: false }),
  });
  assert.equal(active?.severity, "high");
});

// ---------------------------------------------------------------------------
// B. Headers
// ---------------------------------------------------------------------------

test("missing HSTS: medium", () => {
  const finding = findingFor("security.headers.hsts", {
    security: healthySecurity({
      strictTransportSecurity: header(false),
      hsts: { ...healthySecurity().hsts, valid: false, maxAgeSeconds: null, includesSubdomains: false },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /No Strict-Transport-Security/);
  // includeSubDomains is advised only once every subdomain is known to work over HTTPS.
  assert.equal(
    finding.remediation,
    "Send the Strict-Transport-Security header with a max-age of at least six months (for example max-age=15552000). Add includeSubDomains only after confirming that every subdomain also works over HTTPS.",
  );
});

test("HSTS present but max-age=0 is reported as switched off, not as missing", () => {
  // The parser marks max-age=0 as a validly parsed header (valid: true) -- a
  // number was read -- so this fixture reflects that shape rather than an
  // invented valid: false. The finding must fire anyway, because the number
  // switches HSTS off: this is the case the rule reorder exists to catch.
  const finding = findingFor("security.headers.hsts", {
    security: healthySecurity({
      strictTransportSecurity: header(true, "max-age=0"),
      hsts: {
        ...healthySecurity().hsts,
        valid: true,
        maxAgeSeconds: 0,
        disabledByZeroMaxAge: true,
        includesSubdomains: false,
      },
    }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /max-age=0/);
});

test("a max-age=0 header still fires even though it parsed as valid, because it switches HSTS off", () => {
  // Guards the ORDER of the checks. A rule that tested `valid` before
  // `disabledByZeroMaxAge` would pass this header and produce no finding.
  const finding = findingFor("security.headers.hsts", {
    security: healthySecurity({
      strictTransportSecurity: header(true, "max-age=0"),
      hsts: { ...healthySecurity().hsts, valid: true, maxAgeSeconds: 0, disabledByZeroMaxAge: true },
    }),
  });

  assert.ok(finding, "a valid-but-switched-off header is still a finding");
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /switches it off/);
});

test("two HSTS headers whose first is max-age=0 fire, since only the first counts", () => {
  // RFC 6797 §8.1: the parser takes the first header (max-age=0) and ignores
  // "max-age=31536000". The site is not protected, and the finding says so.
  const finding = findingFor("security.headers.hsts", {
    security: healthySecurity({
      strictTransportSecurity: header(true, "max-age=0, max-age=31536000"),
      hsts: { ...healthySecurity().hsts, valid: true, maxAgeSeconds: 0, disabledByZeroMaxAge: true },
    }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /max-age=0/);
});

test("HSTS present without a usable max-age says browsers ignore it", () => {
  const finding = findingFor("security.headers.hsts", {
    security: healthySecurity({
      strictTransportSecurity: header(true, "includeSubDomains"),
      hsts: { ...healthySecurity().hsts, valid: false, maxAgeSeconds: null, includesSubdomains: false },
    }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /no usable max-age/);
});

test("missing CSP: medium", () => {
  const finding = findingFor("security.headers.csp", {
    security: healthySecurity({ contentSecurityPolicy: header(false) }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /No Content-Security-Policy/);
});

test("report-only CSP is distinguished from having none", () => {
  const finding = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: false,
      contentSecurityPolicyReportOnly: header(true, "default-src 'self'"),
    }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /Report-Only/);
  assert.match(finding.evidence, /blocks nothing/);
});

// ---------------------------------------------------------------------------
// C. Cookies
// ---------------------------------------------------------------------------

test("cookies without Secure: high, naming them", () => {
  const finding = findingFor("security.cookies.secure", {
    security: healthySecurity({
      cookies: {
        total: 2,
        cookies: [cookie({ name: "sid", secure: false }), cookie({ name: "ok" })],
        notInspected: [],
      },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.match(finding.evidence, /1 of 2/);
  assert.match(finding.evidence, /sid/);
});

test("cookies without HttpOnly: medium", () => {
  const finding = findingFor("security.cookies.httponly", {
    security: healthySecurity({
      cookies: { total: 1, cookies: [cookie({ name: "sid", httpOnly: false })], notInspected: [] },
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /sid/);
});

test("no cookies observed is skipped, not passed", () => {
  // The collector records that cookies set by JavaScript or on other pages
  // were not seen, so an empty list is not a clean bill of health.
  assert.equal(findingFor("security.cookies.secure"), undefined);
  assert.match(skipReason("security.cookies.secure") ?? "", /set no cookies/);
  assert.match(skipReason("security.cookies.httponly") ?? "", /set no cookies/);
});

test("cookie transport flags are not graded on an HTTP site", () => {
  // Everything leaks on HTTP already; the no-HTTPS finding covers it.
  const reason = skipReason("security.cookies.secure", {
    security: healthySecurity({
      servedOverHttps: false,
      cookies: { total: 1, cookies: [cookie({ secure: false })], notInspected: [] },
    }),
  });

  assert.match(reason ?? "", /not served over HTTPS/);
});

// ---------------------------------------------------------------------------
// D. Email
// ---------------------------------------------------------------------------

test("no SPF record: medium", () => {
  const finding = findingFor("security.dns.spf", {
    dns: healthyDns({ spf: policy("absent") }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /no SPF record/);
});

test("the SPF finding does not claim senders cannot be verified at all", () => {
  /*
   * The wording this pins down used to read "so senders cannot be verified".
   * SPF is not the only mechanism — DKIM signs the message itself and is
   * published separately — so that sentence drew a conclusion about email
   * authentication as a whole from one missing record.
   *
   * The finding may say what SPF's absence means. It may not speak for
   * mechanisms this audit never measured, in either direction.
   */
  const finding = findingFor("security.dns.spf", {
    dns: healthyDns({ spf: policy("absent") }),
  });

  assert.ok(finding);

  const claim = `${finding.evidence} ${finding.remediation}`;
  assert.doesNotMatch(claim, /cannot be verified/i);
  assert.doesNotMatch(claim, /senders cannot/i);
  assert.doesNotMatch(claim, /no way to (verify|authenticate)/i);
  // And it must not swing the other way into reassurance about DKIM either.
  assert.doesNotMatch(claim, /DKIM/i);

  // It still has to say the useful, measured thing.
  assert.match(finding.evidence, /no SPF record/);
});

test("no DMARC record: medium", () => {
  const finding = findingFor("security.dns.dmarc", {
    dns: healthyDns({ dmarc: dmarcPolicy("absent") }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.equal(
    finding.remediation,
    "Publish a DMARC record for the domain (a TXT record named _dmarc), starting with a monitoring-only policy (p=none) so reports can be reviewed before the policy is enforced.",
  );
});

/*
 * A POLICY INHERITED FROM THE PARENT IS STILL A POLICY.
 *
 * DMARC inherits: a subdomain with no record of its own is covered by its
 * organisational domain's. The collector used to check only the audited name,
 * so an audit of a subdomain reported "the domain publishes no DMARC record"
 * about a domain that was protected. These two tests hold that door shut from
 * the rule's side as well as the collector's.
 */
test("an INHERITED DMARC policy is not reported as a missing one", () => {
  const finding = findingFor("security.dns.dmarc", {
    dns: healthyDns({
      dmarc: dmarcPolicy("found", "v=DMARC1; p=quarantine; sp=none", {
        policyDomain: "example.com",
        inherited: true,
        effectivePolicy: "none",
      }),
    }),
  });

  assert.equal(finding, undefined, "a covered domain has nothing to fix here");
});

test("a genuinely absent policy is STILL a finding", () => {
  // The opposite direction. Fixing the false claim must not quietly stop the
  // rule finding the real thing.
  const finding = findingFor("security.dns.dmarc", {
    dns: healthyDns({ dmarc: dmarcPolicy("absent") }),
  });

  assert.ok(finding, "no record anywhere is a real finding");
  assert.match(finding.evidence, /no DMARC record/);
});

// ===========================================================================
// THE PART THAT MATTERS: unmeasured data must never become a finding
// ===========================================================================

test("spf: error is skipped and must never become 'no SPF record'", () => {
  const overrides = { dns: healthyDns({ spf: policy("error") }) };

  assert.equal(findingFor("security.dns.spf", overrides), undefined);
  assert.match(skipReason("security.dns.spf", overrides) ?? "", /timed out/);
});

test("dmarc: error is skipped", () => {
  const overrides = { dns: healthyDns({ dmarc: dmarcPolicy("error") }) };

  assert.equal(findingFor("security.dns.dmarc", overrides), undefined);
  assert.ok(skipReason("security.dns.dmarc", overrides));
});

test("absent and error are different: one reports, the other does not", () => {
  const absent = firedIds({ dns: healthyDns({ spf: policy("absent") }) });
  const errored = firedIds({ dns: healthyDns({ spf: policy("error") }) });

  assert.ok(absent.includes("security.dns.spf"));
  assert.ok(!errored.includes("security.dns.spf"));
});

test("an unreachable TLS check produces no certificate findings", () => {
  for (const status of ["unreachable", "blocked", "not-applicable"] as const) {
    const overrides = {
      ssl: {
        status,
        hostname: "example.com",
        certificate: null,
        trusted: null,
        problem: null,
        failure: status === "unreachable" ? ("timeout" as const) : null,
        message: `TLS status: ${status}`,
      } as SslData,
    };
    const fired = firedIds(overrides);

    for (const id of [
      "security.ssl.expired",
      "security.ssl.hostname",
      "security.ssl.untrusted",
    ]) {
      assert.ok(!fired.includes(id), `${id} must not fire when TLS status is ${status}`);
    }
  }
});

test("a connection with no readable certificate is not a broken certificate", () => {
  const overrides = {
    ssl: healthySsl({ certificate: null, message: "No readable certificate came back." }),
  };

  assert.equal(findingFor("security.ssl.expired", overrides), undefined);
  assert.equal(findingFor("security.ssl.hostname", overrides), undefined);
  assert.match(skipReason("security.ssl.expired", overrides) ?? "", /no readable certificate/i);
});

test("a PageSpeed timeout produces no security finding whatsoever", () => {
  // Performance is irrelevant here and must stay irrelevant.
  const withTimeout = firedIds({ performance: notCheckedPerformance() });
  const withoutIt = firedIds();

  assert.deepEqual(withTimeout, withoutIt);
  assert.deepEqual(withTimeout, []);
});

test("an audit that ran out of time produces no security finding", () => {
  // technical: null is the timeout marker. No security rule reads it, and
  // none may start to.
  assert.deepEqual(firedIds({ technical: null, timedOut: true }), []);
});

test("HSTS and mixed content are skipped on HTTP, not reported as missing", () => {
  const overrides = {
    security: healthySecurity({
      servedOverHttps: false,
      hsts: { ...healthySecurity().hsts, applicable: false, valid: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false },
    }),
  };

  assert.equal(findingFor("security.headers.hsts", overrides), undefined);
  assert.equal(findingFor("security.mixed-content", overrides), undefined);
  assert.match(skipReason("security.headers.hsts", overrides) ?? "", /ignored by browsers/);

  // The real problem is still reported, once.
  assert.deepEqual(firedIds(overrides), ["security.https"]);
});

// ===========================================================================
// Determinism
// ===========================================================================

test("several problems all report, worst first", () => {
  const broken = {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      insecureFormActions: ["http://example.com/login"],
      mixedContent: { ...healthySecurity().mixedContent, total: 3, activeCount: 1 },
      cookies: { total: 1, cookies: [cookie({ secure: false, httpOnly: false })], notInspected: [] },
    }),
    dns: healthyDns({ spf: policy("absent") }),
  };

  const { findings } = runRules(facts(broken), SECURITY_RULES);
  const problems = findings.filter((f) => f.severity !== "good");

  assert.ok(problems.length >= 5);
  const severities = problems.map((f) => f.severity);
  const order = { critical: 0, high: 1, medium: 2, good: 3 };
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(
      order[severities[i - 1]] <= order[severities[i]],
      "findings must be ordered worst first",
    );
  }
});

test("changing rule order changes nothing", () => {
  const broken = {
    security: healthySecurity({ contentSecurityPolicy: header(false) }),
    dns: healthyDns({ spf: policy("absent") }),
  };

  const forward = runRules(facts(broken), SECURITY_RULES);
  const reversed = runRules(facts(broken), [...SECURITY_RULES].reverse());

  assert.deepEqual(forward.findings, reversed.findings);
});

test("the same facts always produce the same severities", () => {
  const broken = { ssl: healthySsl({ trusted: false, problem: "untrusted" }) };

  const first = runRules(facts(broken), SECURITY_RULES).findings;
  const second = runRules(facts(broken), SECURITY_RULES).findings;

  assert.deepEqual(first, second);
});

test("every finding carries id, category, severity, evidence and remediation", () => {
  const { findings } = runRules(
    facts({ security: healthySecurity({ contentSecurityPolicy: header(false) }) }),
    SECURITY_RULES,
  );
  const finding = findings.find((f) => f.id === "security.headers.csp");

  assert.ok(finding);
  assert.equal(finding.category, "security");
  assert.equal(finding.severity, "medium");
  assert.ok(finding.title.length > 0);
  assert.ok(finding.evidence.length > 0);
  assert.ok(finding.remediation.length > 0);
});

test("evidence stays factual and never editorialises", () => {
  const { findings } = runRules(
    facts({
      security: healthySecurity({
        servedOverHttps: false,
        hsts: { ...healthySecurity().hsts, applicable: false },
        mixedContent: { ...healthySecurity().mixedContent, applicable: false },
      }),
    }),
    SECURITY_RULES,
  );

  for (const finding of findings) {
    for (const word of ["dangerous", "hacked", "catastrophic", "terrible", "urgent"]) {
      assert.ok(
        !finding.evidence.toLowerCase().includes(word),
        `evidence must state the measurement, not dramatise it (found "${word}")`,
      );
    }
  }
});

test("the security rules run with no AI SDK present", () => {
  // Nothing here is async, networked, or dependent on a model. If that ever
  // changed, this synchronous call could not work.
  const result = runRules(facts(), SECURITY_RULES);
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.skipped));
});

// ===========================================================================
// THE SEVERITY POLICY, LOCKED
//
// This table is the approved project policy. It is duplicated here on purpose:
// changing a grade in security.ts now fails a test rather than passing review
// unnoticed. Severity is decided here and in the rule definition, and nowhere
// else — not by the audited site, not by Google, not by Claude.
// ===========================================================================

const SEVERITY_POLICY: Record<string, "critical" | "high" | "medium"> = {
  "security.https": "critical",
  "security.ssl.expired": "critical",
  "security.ssl.hostname": "critical",
  "security.ssl.untrusted": "critical",
  "security.form.insecure": "critical",
  "security.mixed-content": "high",
  "security.cookies.secure": "high",
  "security.headers.hsts": "medium",
  "security.headers.csp": "medium",
  "security.cookies.httponly": "medium",
  "security.dns.spf": "medium",
  "security.dns.dmarc": "medium",
};

test("every rule declares exactly the approved severity", () => {
  for (const rule of SECURITY_RULES) {
    const expected = SEVERITY_POLICY[rule.id];
    assert.ok(expected, `${rule.id} is not in the approved policy table`);
    assert.equal(rule.severity, expected, `${rule.id} must be ${expected}`);
  }
});

test("the policy table and the rule set describe the same twelve rules", () => {
  // Catches a rule added without a policy entry, and an entry left behind
  // after a rule is removed.
  assert.deepEqual(
    SECURITY_RULES.map((r) => r.id).sort(),
    Object.keys(SEVERITY_POLICY).sort(),
  );
});

/** Facts that make every single rule fire at once. */
function allBroken(): Partial<AuditFacts> {
  return {
    security: healthySecurity({
      servedOverHttps: false,
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: false,
      contentSecurityPolicyReportOnly: header(false),
      strictTransportSecurity: header(false),
      hsts: {
        applicable: true,
        valid: false,
        maxAgeSeconds: null,
        disabledByZeroMaxAge: false,
        includesSubdomains: false,
        preload: false,
      },
      mixedContent: {
        applicable: true,
        total: 4,
        activeCount: 2,
        upgradeInsecureRequests: false,
        items: [],
        truncated: false,
        notInspected: [],
      },
      insecureFormActions: ["http://example.com/login"],
      cookies: {
        total: 1,
        cookies: [cookie({ name: "sid", secure: false, httpOnly: false })],
        notInspected: [],
      },
    }),
    ssl: healthySsl({
      trusted: false,
      problem: "expired",
      certificate: {
        ...healthySsl().certificate!,
        daysUntilExpiry: -3,
        coversHostname: false,
        subjectAltNames: ["other.test"],
      },
    }),
    dns: healthyDns({ spf: policy("absent"), dmarc: dmarcPolicy("absent") }),
  };
}

test("when a rule fires, the finding carries its approved severity", () => {
  // Note: cookie transport flags are skipped on HTTP by design, and HSTS and
  // mixed content are kept applicable here so their severities can be checked.
  const { findings } = runRules(facts(allBroken()), SECURITY_RULES);

  assert.ok(findings.length >= 9, `expected most rules to fire, got ${findings.length}`);

  for (const finding of findings) {
    assert.equal(
      finding.severity,
      SEVERITY_POLICY[finding.id],
      `${finding.id} produced ${finding.severity}, policy says ${SEVERITY_POLICY[finding.id]}`,
    );
  }
});

test("severity does not depend on the audited site, only on which rule fired", () => {
  // Two completely different broken sites, same rule, same grade.
  const one = findingFor("security.headers.csp", {
    security: healthySecurity({ contentSecurityPolicy: header(false) }),
  });
  const two = findingFor("security.headers.csp", {
    security: healthySecurity({
      servedOverHttps: false,
      contentSecurityPolicy: header(false),
      hsts: { ...healthySecurity().hsts, applicable: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false },
    }),
  });

  assert.equal(one?.severity, "medium");
  assert.equal(two?.severity, "medium");
});

// ===========================================================================
// An insecure form is its own fact, even on an HTTP site
// ===========================================================================

test("an HTTP site with an insecure form reports BOTH findings", () => {
  const fired = firedIds({
    security: healthySecurity({
      servedOverHttps: false,
      insecureFormActions: ["http://example.com/login"],
      hsts: { ...healthySecurity().hsts, applicable: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false },
    }),
  });

  // Two separate measured facts: how the page was served, and where the form
  // sends data. Moving the site to HTTPS does not automatically fix a form
  // action hardcoded to http://, so hiding one behind the other would lose a
  // real problem.
  assert.ok(fired.includes("security.https"), "the transport problem must report");
  assert.ok(fired.includes("security.form.insecure"), "the form problem must report too");
});

test("both carry their own approved severity and their own evidence", () => {
  const overrides = {
    security: healthySecurity({
      servedOverHttps: false,
      insecureFormActions: ["http://example.com/login"],
      hsts: { ...healthySecurity().hsts, applicable: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false },
    }),
  };

  const https = findingFor("security.https", overrides);
  const form = findingFor("security.form.insecure", overrides);

  assert.equal(https?.severity, "critical");
  assert.equal(form?.severity, "critical");
  assert.notEqual(https?.evidence, form?.evidence, "each must stand on its own measurement");
  assert.match(form!.evidence, /http:\/\/example\.com\/login/);
});

test("an HTTPS site with an insecure form still reports the form", () => {
  const fired = firedIds({
    security: healthySecurity({ insecureFormActions: ["http://legacy.example.com/post"] }),
  });

  assert.ok(fired.includes("security.form.insecure"));
  assert.ok(!fired.includes("security.https"), "HTTPS is fine here");
});

// ===========================================================================
// Skipped checks are a third thing — never a finding, never a pass
// ===========================================================================

test("a skipped check never appears among the findings", () => {
  // The strongest form of the guarantee: across a range of broken and
  // unmeasurable inputs, no rule is ever both skipped and reported.
  const scenarios: Array<Partial<AuditFacts>> = [
    {},
    allBroken(),
    { dns: healthyDns({ spf: policy("error"), dmarc: dmarcPolicy("error") }) },
    { ssl: healthySsl({ status: "unreachable", certificate: null, trusted: null }) },
    { ssl: healthySsl({ certificate: null }) },
    {
      security: healthySecurity({
        servedOverHttps: false,
        hsts: { ...healthySecurity().hsts, applicable: false },
        mixedContent: { ...healthySecurity().mixedContent, applicable: false },
      }),
    },
    { technical: null, timedOut: true },
  ];

  for (const scenario of scenarios) {
    const { findings, skipped } = runRules(facts(scenario), SECURITY_RULES);
    const reported = new Set(findings.map((f) => f.id));

    for (const entry of skipped) {
      assert.ok(
        !reported.has(entry.ruleId),
        `${entry.ruleId} was skipped and reported at the same time`,
      );
    }
  }
});

test("every skipped check keeps a reason a report can print", () => {
  const { skipped } = runRules(
    facts({ dns: healthyDns({ spf: policy("error"), dmarc: dmarcPolicy("error") }) }),
    SECURITY_RULES,
  );

  assert.ok(skipped.length > 0);
  for (const entry of skipped) {
    assert.ok(entry.ruleId.length > 0);
    assert.ok(entry.reason.length > 0, `${entry.ruleId} was skipped with no reason`);
  }
});

test("a skipped check is not a good finding either", () => {
  // Silence must not be mistaken for a pass. The skipped rule appears in
  // `skipped` and nowhere in `findings`, at any severity including "good".
  const { findings, skipped } = runRules(
    facts({ dns: healthyDns({ spf: policy("error") }) }),
    SECURITY_RULES,
  );

  assert.ok(skipped.some((s) => s.ruleId === "security.dns.spf"));
  assert.equal(findings.find((f) => f.id === "security.dns.spf"), undefined);
});

test("skipped and absent stay different for the same rule", () => {
  const errored = runRules(facts({ dns: healthyDns({ spf: policy("error") }) }), SECURITY_RULES);
  const absent = runRules(facts({ dns: healthyDns({ spf: policy("absent") }) }), SECURITY_RULES);

  // error -> skipped, no finding
  assert.ok(errored.skipped.some((s) => s.ruleId === "security.dns.spf"));
  assert.equal(errored.findings.find((f) => f.id === "security.dns.spf"), undefined);

  // absent -> a real finding, and not skipped
  assert.equal(absent.skipped.find((s) => s.ruleId === "security.dns.spf"), undefined);
  assert.equal(absent.findings.find((f) => f.id === "security.dns.spf")?.severity, "medium");
});

test("applicable: false is skipped with a reason, and creates no false positive", () => {
  const overrides = {
    security: healthySecurity({
      servedOverHttps: false,
      hsts: { ...healthySecurity().hsts, applicable: false, valid: false },
      mixedContent: { ...healthySecurity().mixedContent, applicable: false, total: 0 },
    }),
  };

  const { findings, skipped } = runRules(facts(overrides), SECURITY_RULES);
  const skippedIds = skipped.map((s) => s.ruleId);

  assert.ok(skippedIds.includes("security.headers.hsts"));
  assert.ok(skippedIds.includes("security.mixed-content"));
  assert.equal(findings.find((f) => f.id === "security.headers.hsts"), undefined);
  assert.equal(findings.find((f) => f.id === "security.mixed-content"), undefined);
});

test("an unmeasurable audit produces skipped checks and zero findings", () => {
  const { findings, skipped } = runRules(
    facts({
      ssl: healthySsl({ status: "unreachable", certificate: null, trusted: null }),
      dns: healthyDns({ spf: policy("error"), dmarc: dmarcPolicy("error") }),
    }),
    SECURITY_RULES,
  );

  assert.deepEqual(
    findings.filter((f) => f.severity !== "good").map((f) => f.id),
    [],
    "nothing may be reported about a site we could not measure",
  );
  assert.ok(skipped.length >= 5, "and every check that could not run must say so");
});

test("null data is skipped, never graded", () => {
  // A certificate that was never read. The three SSL rules all depend on it.
  const { findings, skipped } = runRules(
    facts({ ssl: healthySsl({ certificate: null }) }),
    SECURITY_RULES,
  );

  const skippedIds = skipped.map((s) => s.ruleId);
  assert.ok(skippedIds.includes("security.ssl.expired"));
  assert.ok(skippedIds.includes("security.ssl.hostname"));
  assert.equal(findings.find((f) => f.id === "security.ssl.expired"), undefined);
  assert.equal(findings.find((f) => f.id === "security.ssl.hostname"), undefined);
});

test("the four unmeasured states all resolve to skipped, never to a finding", () => {
  const cases: Array<[string, Partial<AuditFacts>, string]> = [
    ["error", { dns: healthyDns({ spf: policy("error") }) }, "security.dns.spf"],
    ["null", { ssl: healthySsl({ certificate: null }) }, "security.ssl.expired"],
    [
      "applicable: false",
      {
        security: healthySecurity({
          servedOverHttps: false,
          hsts: { ...healthySecurity().hsts, applicable: false },
          mixedContent: { ...healthySecurity().mixedContent, applicable: false },
        }),
      },
      "security.mixed-content",
    ],
    [
      "nothing observed",
      { security: healthySecurity({ cookies: { total: 0, cookies: [], notInspected: [] } }) },
      "security.cookies.httponly",
    ],
  ];

  for (const [label, overrides, ruleId] of cases) {
    const { findings, skipped } = runRules(facts(overrides), SECURITY_RULES);
    assert.ok(
      skipped.some((s) => s.ruleId === ruleId),
      `${label}: ${ruleId} should be skipped`,
    );
    assert.equal(
      findings.find((f) => f.id === ruleId),
      undefined,
      `${label}: ${ruleId} must produce no finding`,
    );
  }
});

test("unknown is never a verdict: trusted and coversHostname nulls stay silent", () => {
  const overrides = {
    ssl: healthySsl({
      trusted: null,
      certificate: { ...healthySsl().certificate!, coversHostname: null, subjectAltNames: [] },
    }),
  };
  const fired = firedIds(overrides);

  assert.ok(!fired.includes("security.ssl.untrusted"), "null trust is not untrusted");
  assert.ok(!fired.includes("security.ssl.hostname"), "null coverage is not a mismatch");
});

// ---------------------------------------------------------------------------
// Cookies the browser never keeps
// ---------------------------------------------------------------------------

/** The security facts for one response's worth of cookies. */
const withCookies = (cookies: CookieInfo[]) => ({
  security: healthySecurity({ cookies: { total: cookies.length, cookies, notInspected: [] } }),
});

test("a cookie the browser never stores is not graded for flags it does not need", () => {
  // A logout clears a cookie with the same shape a server uses to set one.
  // Secure and HttpOnly protect a stored cookie; there is nothing stored here.
  const cleared = withCookies([cookie({ name: "old_session", secure: false, httpOnly: false, sameSite: null, expired: true })]);

  assert.equal(findingFor("security.cookies.secure", cleared), undefined);
  assert.equal(findingFor("security.cookies.httponly", cleared), undefined);
});

test("and the report says why it was not graded, rather than claiming no cookies were set", () => {
  const cleared = withCookies([cookie({ name: "old_session", secure: false, httpOnly: false, expired: true })]);

  assert.match(skipReason("security.cookies.secure", cleared) ?? "", /had already expired/);
  assert.doesNotMatch(skipReason("security.cookies.secure", cleared) ?? "", /set no cookies/);
  assert.match(skipReason("security.cookies.httponly", cleared) ?? "", /had already expired/);
});

test("a response that set no cookies at all still says exactly that", () => {
  assert.match(skipReason("security.cookies.secure") ?? "", /set no cookies/);
});

test("a stored insecure cookie beside a cleared one is still reported, naming only the stored one", () => {
  const mixed = withCookies([
    cookie({ name: "old_session", secure: false, httpOnly: false, expired: true }),
    cookie({ name: "sid", secure: false, httpOnly: false }),
  ]);

  const secure = findingFor("security.cookies.secure", mixed);
  assert.ok(secure, "the genuine cookie is still a finding");
  assert.match(secure.evidence, /sid/);
  assert.doesNotMatch(secure.evidence, /old_session/, "the cleared one is not counted against the site");
  assert.match(secure.evidence, /1 of 1 cookie/, "the denominator counts stored cookies only");
});

test("a cookie is not exempted merely for having an expiry attribute", () => {
  // The distinction is whether the lifetime has already ended, not whether the
  // server stated one. A cookie stored for an hour is a cookie to protect.
  const stored = withCookies([cookie({ name: "sid", secure: false, httpOnly: false, expired: false })]);

  assert.ok(findingFor("security.cookies.secure", stored));
  assert.ok(findingFor("security.cookies.httponly", stored));
});

test("a CSP delivered only in a meta tag is a distinct finding, not 'no policy'", () => {
  // Browsers enforce a meta policy, so the page is not one with no policy --
  // the title must not say it is. It is a weaker delivery, so it still fires.
  const finding = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: true,
      contentSecurityPolicyReportOnly: header(false),
    }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.notEqual(finding.title, "No Content-Security-Policy");
  assert.match(finding.evidence, /meta/i);
  assert.match(finding.evidence, /response header/i);
  assert.doesNotMatch(finding.evidence, /No Content-Security-Policy header was sent/);
});

test("a real CSP header still passes even when a meta tag is also present", () => {
  // The header wins: a header-delivered policy is the fully-enforced case.
  const finding = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(true, "default-src 'self'"),
      contentSecurityPolicyMeta: true,
    }),
  });
  assert.equal(finding, undefined);
});

test("the meta case ranks above report-only, and both above 'no policy'", () => {
  // The three firing branches, in order, each producing their own evidence.
  const meta = findingFor("security.headers.csp", {
    security: healthySecurity({ contentSecurityPolicy: header(false), contentSecurityPolicyMeta: true, contentSecurityPolicyReportOnly: header(true, "default-src 'self'") }),
  });
  assert.match(meta?.evidence ?? "", /meta/i, "meta is reported before report-only");

  const reportOnly = findingFor("security.headers.csp", {
    security: healthySecurity({ contentSecurityPolicy: header(false), contentSecurityPolicyMeta: false, contentSecurityPolicyReportOnly: header(true, "default-src 'self'") }),
  });
  assert.match(reportOnly?.evidence ?? "", /Report-Only/);

  const none = findingFor("security.headers.csp", {
    security: healthySecurity({ contentSecurityPolicy: header(false), contentSecurityPolicyMeta: false, contentSecurityPolicyReportOnly: header(false) }),
  });
  assert.match(none?.evidence ?? "", /No Content-Security-Policy header was sent/);
});

test("each CSP firing case carries its own verdict-specific title", () => {
  // One rule, three genuinely different facts. The heading a reader sees must
  // name which one it is -- not the rule's generic fallback title, and never
  // the same title for all three. The evidence is asserted elsewhere; here it
  // is the title alone that matters.
  const missing = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: false,
      contentSecurityPolicyReportOnly: header(false),
    }),
  });
  assert.equal(missing?.title, "Content-Security-Policy header is missing");

  const meta = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: true,
      contentSecurityPolicyReportOnly: header(false),
    }),
  });
  assert.equal(meta?.title, "Content-Security-Policy is delivered via a meta tag");

  const reportOnly = findingFor("security.headers.csp", {
    security: healthySecurity({
      contentSecurityPolicy: header(false),
      contentSecurityPolicyMeta: false,
      contentSecurityPolicyReportOnly: header(true, "default-src 'self'"),
    }),
  });
  assert.equal(reportOnly?.title, "Content-Security-Policy is report-only");

  // All three are distinct headings, so a report never shows one heading for
  // two different states.
  const titles = new Set([missing?.title, meta?.title, reportOnly?.title]);
  assert.equal(titles.size, 3);
});
