/**
 * Corpus E — security headers, from the raw response header to the finding.
 *
 * Every case runs the real pipeline on a one-page fixture site: collector,
 * rules and aggregation. Nothing constructs a parsed header by hand, which is
 * how the HSTS max-age=0 defect survived: the parser test and the rule test
 * each assumed a different parsed shape.
 *
 * Yardsticks: RFC 6797 (HSTS), the CSP specification's delivery mechanisms, the
 * approved severity table in lib/rules/security.ts, and the parser's own
 * comment that a first header of max-age=0 must not "look like a
 * well-protected site".
 *
 * No new grading requirement is introduced here. Where the code does not grade
 * something, the case records that as current behaviour.
 */
import assert from "node:assert/strict";

import type { SiteAuditResult } from "../types.ts";
import { auditFixtureSite, correct, decision, findingsOf, page, PUBLIC_HOST, installOfflineCorpus } from "./corpus.fixture.mts";

installOfflineCorpus();
const HTTPS_ROOT = `https://${PUBLIC_HOST}/`;
const HTTP_ROOT = `http://${PUBLIC_HOST}/`;
const CSP = { "content-security-policy": "default-src 'self'" };
const HSTS = { "strict-transport-security": "max-age=31536000" };

function auditHeaders(headers: Record<string, string>, options: { html?: string; http?: boolean } = {}): Promise<SiteAuditResult> {
  const root = options.http ? HTTP_ROOT : HTTPS_ROOT;
  return auditFixtureSite({ [root]: { html: options.html ?? page(), headers } });
}

const hstsFinding = (result: SiteAuditResult) => findingsOf(result).get("security.headers.hsts");
const cspFinding = (result: SiteAuditResult) => findingsOf(result).get("security.headers.csp");

// ---------------------------------------------------------------------------
// HSTS
// ---------------------------------------------------------------------------

correct("E1 no Strict-Transport-Security header on an HTTPS page: Medium, saying none was sent", async () => {
  const finding = hstsFinding(await auditHeaders({ ...CSP }));
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.evidence, "No Strict-Transport-Security header was sent.");
});

correct("E2 max-age of one year: parsed as protecting, no finding", async () => {
  const result = await auditHeaders({ ...CSP, ...HSTS });
  assert.equal(result.data.security.hsts.valid, true);
  assert.equal(result.data.security.hsts.maxAgeSeconds, 31_536_000);
  assert.equal(hstsFinding(result), undefined);
});

correct("E3 max-age of two years: no finding", async () => {
  assert.equal(hstsFinding(await auditHeaders({ ...CSP, "strict-transport-security": "max-age=63072000" })), undefined);
});

correct("E4 max-age=0, which tells browsers to forget HSTS, is a finding", async () => {
  // The parser marks max-age=0 valid (a number was read) with disabledByZeroMaxAge
  // set. The rule checks disabledByZeroMaxAge before valid, so the switched-off
  // header is graded. (Was a defect: valid was tested first and this branch,
  // with the right evidence already in it, was unreachable.)
  const result = await auditHeaders({ ...CSP, "strict-transport-security": "max-age=0" });
  assert.equal(result.data.security.hsts.valid, true);
  assert.equal(result.data.security.hsts.disabledByZeroMaxAge, true);
  assert.match(hstsFinding(result)?.evidence ?? "", /max-age=0/);
});

decision("E5 max-age=60 (one minute) produces no finding", async () => {
  // The rule's remediation recommends at least six months but the rule does not
  // grade the length. A threshold would be a new grading requirement.
  const result = await auditHeaders({ ...CSP, "strict-transport-security": "max-age=60" });
  assert.equal(result.data.security.hsts.maxAgeSeconds, 60);
  assert.equal(hstsFinding(result), undefined);
});

correct("E6 two HSTS headers: only the first counts (RFC 6797 §8.1), so a valid first header protects", async () => {
  // Node joins repeated headers with ", "; the parser reads up to the first comma.
  const result = await auditHeaders({ ...CSP, "strict-transport-security": "max-age=31536000, max-age=0" });
  assert.equal(result.data.security.hsts.maxAgeSeconds, 31_536_000);
  assert.equal(hstsFinding(result), undefined);
});

correct("E7 two HSTS headers whose first says max-age=0: the first is used and graded as switched off", async () => {
  // RFC 6797 §8.1: only the first header counts. The parser takes max-age=0 and
  // ignores the later max-age=31536000, so the site is unprotected and the
  // finding says so. (Was a defect: the same root cause as E4, via the
  // duplicate-header path.)
  const result = await auditHeaders({ ...CSP, "strict-transport-security": "max-age=0, max-age=31536000" });
  assert.equal(result.data.security.hsts.maxAgeSeconds, 0);
  assert.notEqual(hstsFinding(result), undefined);
  assert.match(hstsFinding(result)?.evidence ?? "", /max-age=0/);
});

correct("E8 includeSubDomains and preload are read and recorded, and are not graded", async () => {
  const result = await auditHeaders({ ...CSP, "strict-transport-security": "max-age=31536000; includeSubDomains; preload" });
  assert.equal(result.data.security.hsts.includesSubdomains, true);
  assert.equal(result.data.security.hsts.preload, true);
  assert.equal(hstsFinding(result), undefined);
});

correct("E9 HSTS on a plain-HTTP page is skipped with a reason, because browsers ignore it there", async () => {
  const result = await auditHeaders({ ...CSP, ...HSTS }, { http: true });
  assert.equal(result.data.security.hsts.applicable, false);
  assert.equal(hstsFinding(result), undefined);
  assert.match(findingsOf(result).skipped("security.headers.hsts")[0]?.reason ?? "", /ignored by browsers on a plain HTTP page/);
});

// ---------------------------------------------------------------------------
// Content-Security-Policy
// ---------------------------------------------------------------------------

correct("E10 no Content-Security-Policy: Medium, saying no header was sent", async () => {
  const finding = cspFinding(await auditHeaders({ ...HSTS }));
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.evidence, "No Content-Security-Policy header was sent.");
});

correct("E11 a Content-Security-Policy header is present: no finding", async () => {
  assert.equal(cspFinding(await auditHeaders({ ...HSTS, ...CSP })), undefined);
});

correct("E12 only Content-Security-Policy-Report-Only: still a finding, saying it blocks nothing", async () => {
  const finding = cspFinding(await auditHeaders({ ...HSTS, "content-security-policy-report-only": "default-src 'self'" }));
  assert.equal(finding?.evidence, "Only Content-Security-Policy-Report-Only was sent. It reports violations but blocks nothing.");
});

decision("E13 a CSP that restricts nothing, or allows unsafe-inline, or a wildcard, produces no finding", async () => {
  // The rule checks presence only, and says so in its title. Grading what a
  // policy permits would be a new requirement.
  for (const policy of ["upgrade-insecure-requests", "script-src 'self' 'unsafe-inline'", "default-src *"]) {
    const result = await auditHeaders({ ...HSTS, "content-security-policy": policy });
    assert.equal(result.data.security.contentSecurityPolicy.present, true, policy);
    assert.equal(cspFinding(result), undefined, policy);
  }
});

correct("E14 a policy delivered in <meta http-equiv> is reported as a meta-tag policy, not as having none", async () => {
  // The CSP specification defines the meta element as a delivery mechanism and
  // browsers enforce it (without frame-ancestors, sandbox and reporting). So the
  // page has a policy: the finding must not claim it has none, and it names the
  // weaker delivery instead. (Was a defect: reported identically to no policy.)
  const html = page({ head: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">` });
  const result = await auditHeaders({ ...HSTS }, { html });
  assert.equal(result.data.security.contentSecurityPolicyMeta, true);
  assert.equal(result.data.security.contentSecurityPolicy.present, false);

  const finding = cspFinding(result);
  assert.notEqual(finding?.title, "No Content-Security-Policy");
  assert.match(finding?.evidence ?? "", /meta/i);
  assert.doesNotMatch(finding?.evidence ?? "", /No Content-Security-Policy header was sent/);
});

// ---------------------------------------------------------------------------
// Headers that are measured and not graded
// ---------------------------------------------------------------------------

correct("E15 X-Frame-Options, X-Content-Type-Options and Referrer-Policy are recorded when present", async () => {
  const result = await auditHeaders({
    ...HSTS,
    ...CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  assert.deepEqual(result.data.security.xFrameOptions, { present: true, value: "DENY" });
  assert.deepEqual(result.data.security.xContentTypeOptions, { present: true, value: "nosniff" });
  assert.deepEqual(result.data.security.referrerPolicy, { present: true, value: "no-referrer" });
  assert.deepEqual(findingsOf(result).ids, []);
});

decision("E16 missing X-Frame-Options, X-Content-Type-Options and Referrer-Policy produce no finding", async () => {
  // The approved severity table has twelve security rules and none reads these
  // headers. They are measured and shown; whether to grade them is a decision.
  const result = await auditHeaders({ ...HSTS, ...CSP });
  assert.equal(result.data.security.xFrameOptions.present, false);
  assert.equal(result.data.security.xContentTypeOptions.present, false);
  assert.equal(result.data.security.referrerPolicy.present, false);
  assert.deepEqual(findingsOf(result).ids, []);
});
