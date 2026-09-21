/**
 * Corpus G — cookies set by the audited page's response.
 *
 * Yardsticks: RFC 6265 (and its successor draft for SameSite), the approved
 * severity table (Secure missing: High, "a real exposure"; HttpOnly missing:
 * Medium), and the project rule that cookie values are never stored.
 *
 * RFC 6265 §5.2 and §5.3: a Set-Cookie with an empty name is ignored entirely;
 * Max-Age of zero or less, or an Expires date in the past, instructs the browser
 * to delete the cookie. A deletion carries no value worth protecting.
 */
import assert from "node:assert/strict";

import type { SiteAuditResult } from "../types.ts";
import {
  auditFixtureSite,
  correct,
  decision,
  findingsOf,
  page,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  installOfflineCorpus,
} from "./corpus.fixture.mts";

installOfflineCorpus();

function auditCookies(setCookieHeaders: string[], options: { http?: boolean } = {}): Promise<SiteAuditResult> {
  const root = `${options.http ? "http" : "https"}://${PUBLIC_HOST}/`;
  return auditFixtureSite({ [root]: { html: page(), headers: { ...PROTECTED_HEADERS }, setCookieHeaders } });
}

const cookieFindings = (result: SiteAuditResult) => findingsOf(result).ids.filter((id) => id.startsWith("security.cookies."));

correct("G1 a cookie with Secure, HttpOnly and SameSite produces no cookie finding, and its flags are recorded", async () => {
  const result = await auditCookies(["sid=abc123; Path=/; Secure; HttpOnly; SameSite=Lax"]);
  assert.deepEqual(result.data.security.cookies.cookies, [{ name: "sid", secure: true, httpOnly: true, sameSite: "lax", expired: false }]);
  assert.deepEqual(cookieFindings(result), []);
});

correct("G2 a cookie without Secure on an HTTPS page: High, naming the cookie", async () => {
  const finding = findingsOf(await auditCookies(["sid=abc123; Path=/; HttpOnly"])).get("security.cookies.secure");
  assert.equal(finding?.severity, "high");
  assert.equal(finding?.evidence, "1 of 1 cookie(s) lack the Secure flag: sid.");
});

correct("G3 a cookie without HttpOnly: Medium, naming the cookie", async () => {
  const finding = findingsOf(await auditCookies(["sid=abc123; Path=/; Secure"])).get("security.cookies.httponly");
  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.evidence, "1 of 1 cookie(s) lack the HttpOnly flag: sid.");
});

decision("G4 a cookie that page scripts must read (a consent choice) is still reported as lacking HttpOnly", async () => {
  // Per the approved policy every cookie without HttpOnly is graded. Some
  // cookies are meant to be readable by scripts; the rule cannot tell which.
  const result = await auditCookies(["cookie_consent=accepted; Path=/; Secure; SameSite=Lax"]);
  assert.deepEqual(cookieFindings(result), ["security.cookies.httponly"]);
});

correct("G5 SameSite is read as None, Strict or absent, and is not graded", async () => {
  const result = await auditCookies(["a=1; Secure; HttpOnly; SameSite=None", "b=1; Secure; HttpOnly; SameSite=Strict", "c=1; Secure; HttpOnly"]);
  assert.deepEqual(result.data.security.cookies.cookies.map((cookie) => cookie.sameSite), ["none", "strict", null]);
  assert.deepEqual(cookieFindings(result), []);
});

decision("G6 SameSite=None without Secure is graded only for the missing Secure flag", async () => {
  // Chromium rejects such a cookie outright. Whether that deserves its own
  // finding is a decision.
  const result = await auditCookies(["a=1; HttpOnly; SameSite=None"]);
  assert.deepEqual(cookieFindings(result), ["security.cookies.secure"]);
});

correct("G7 a cookie-deletion header (Max-Age=0) is not graded as an insecure cookie", async () => {
  // Max-Age=0 expires the cookie immediately (RFC 6265 §5.2.2), so a browser
  // stores nothing and there is nothing for Secure or HttpOnly to protect.
  // (Was a defect: a logout was reported as a High and a Medium finding.)
  const result = await auditCookies(["old_session=; Max-Age=0; Path=/"]);

  assert.deepEqual(cookieFindings(result), []);
  // Still measured and still reported as sent — it simply is not graded.
  assert.equal(result.data.security.cookies.total, 1);
  assert.equal(result.data.security.cookies.cookies[0].expired, true);
});

correct("G8 a cookie-deletion header (Expires in 1970) is not graded either", async () => {
  // The other way a server clears a cookie: an expiry date already past.
  // (Was a defect, reported exactly as G7 was.)
  const result = await auditCookies(["old_session=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"]);

  assert.deepEqual(cookieFindings(result), []);
  assert.equal(result.data.security.cookies.cookies[0].expired, true);
});

correct("G8b a deletion beside a genuine cookie hides neither: the real one is still reported", async () => {
  // The case that stops this becoming a way to silence findings.
  const result = await auditCookies(["old_session=; Max-Age=0", "sid=abc; Path=/"]);

  assert.deepEqual(cookieFindings(result), ["security.cookies.httponly", "security.cookies.secure"]);
  assert.deepEqual(
    result.data.security.cookies.cookies.map((cookie) => [cookie.name, cookie.expired]),
    [["old_session", true], ["sid", false]],
  );
});

correct("G8c a cookie that is stored, however briefly, is graded normally", async () => {
  // A short life is not no life: Max-Age=600 stores a cookie for ten minutes,
  // and ten minutes of an unprotected session cookie is a real exposure.
  assert.deepEqual(cookieFindings(await auditCookies(["sid=abc; Max-Age=600"])), [
    "security.cookies.httponly",
    "security.cookies.secure",
  ]);
  assert.deepEqual(cookieFindings(await auditCookies(["sid=abc; Expires=Tue, 01 Jan 2030 00:00:00 GMT"])), [
    "security.cookies.httponly",
    "security.cookies.secure",
  ]);
});

correct("G9 attributes are read whatever their capitalisation and spacing", async () => {
  const result = await auditCookies(["a=1; secure; httponly", "b=2;Secure;HttpOnly"]);
  assert.deepEqual(result.data.security.cookies.cookies.map((cookie) => [cookie.secure, cookie.httpOnly]), [[true, true], [true, true]]);
});

correct("G10 a cookie whose VALUE is the word Secure does not count as having the Secure attribute", async () => {
  assert.deepEqual(cookieFindings(await auditCookies(["a=Secure; HttpOnly"])), ["security.cookies.secure"]);
});

correct("G11 a Set-Cookie with no name is ignored, as RFC 6265 requires, so there is nothing to grade", async () => {
  const result = await auditCookies(["=abc; Secure; HttpOnly"]);
  assert.equal(result.data.security.cookies.total, 0);
  assert.deepEqual(cookieFindings(result), []);
});

correct("G12 on a plain-HTTP page Secure is not graded separately from HTTPS itself; HttpOnly still is", async () => {
  const result = await auditCookies(["sid=abc123; Path=/"], { http: true });
  assert.deepEqual(cookieFindings(result), ["security.cookies.httponly"]);
  assert.match(findingsOf(result).skipped("security.cookies.secure")[0]?.reason ?? "", /not served over HTTPS/);
});

correct("G13 no cookie value reaches the audit result", async () => {
  const result = await auditCookies(["sid=s3cr3t-session-value; Path=/; Secure; HttpOnly"]);
  assert.equal(JSON.stringify(result).includes("s3cr3t-session-value"), false);
});
