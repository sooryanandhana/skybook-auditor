/**
 * Security and SSL grading rules.
 *
 * Every rule here reads facts already collected by Steps 1-5. Nothing in this
 * file inspects a website, makes a request, or asks an AI anything.
 *
 * ---------------------------------------------------------------------------
 * SEVERITY POLICY — APPROVED AND FIXED
 *
 * These twelve grades are the project policy. They are declared as constants
 * on the rules below and are the ONLY place severity is decided. Nothing at
 * runtime can change them: not the audited website, not Google, and not
 * Claude. `evaluate` has no way to express a severity, and the runner copies
 * the declared constant without inspecting it.
 *
 *   critical  security.https              security.ssl.expired
 *             security.ssl.hostname       security.ssl.untrusted
 *             security.form.insecure
 *   high      security.mixed-content      security.cookies.secure
 *   medium    security.headers.hsts       security.headers.csp
 *             security.cookies.httponly   security.dns.spf
 *             security.dns.dmarc
 *
 * A locked table in security.test.mts asserts every one of these, so changing
 * a grade here fails a test rather than slipping through review.
 *
 * The bands mean:
 *
 *   critical — the visitor is shown a browser warning, or their data travels
 *              in the clear. The site is visibly broken or actively unsafe.
 *   high     — a real exposure with no warning shown to the visitor.
 *   medium   — a missing protection. Nothing is leaking today; the site is
 *              simply less defended than it should be.
 *
 * ---------------------------------------------------------------------------
 * WHAT KEEPS THESE HONEST
 *
 * Each rule's `select` decides whether the fact exists. Where it does not, the
 * rule is skipped and `evaluate` never runs. So none of the evaluate functions
 * below contains a check for "error", "null" or "timeout" — they cannot see
 * those states, which is exactly the point.
 */
import type { CookieInfo, SecurityData, SslCertificate, SslData } from "../types";
import { defineRule } from "./runner.ts";
import {
  fromCertificate,
  fromEmailPolicy,
  fromSsl,
  whenApplicable,
} from "./selectors.ts";
import { fires, measured, passes, type Presence } from "./types.ts";

// ---------------------------------------------------------------------------
// A. Transport security
// ---------------------------------------------------------------------------

/**
 * The single most serious thing this audit can find.
 *
 * Every browser marks an HTTP page "Not secure", everything the visitor types
 * travels readable, and search engines rank it down. Severity documented in
 * the collector before this file existed.
 */
export const httpsRule = defineRule<SecurityData>({
  id: "security.https",
  scope: "page",
  title: "Site is not served over HTTPS",
  category: "security",
  severity: "critical",
  remediation:
    "Install a TLS certificate and redirect all HTTP traffic to HTTPS. Free certificates are available from Let's Encrypt.",
  select: (data) => measured(data.security),
  evaluate: (security) =>
    security.servedOverHttps
      ? passes
      : fires("The audited address was served over plain HTTP, not HTTPS."),
});

/**
 * An expired certificate shows every visitor a full-page interstitial. It is
 * both highly visible and entirely preventable, which is why it sits alongside
 * having no HTTPS at all.
 *
 * Policy: fixed by the table at the top of this file.
 */
export const certificateExpiredRule = defineRule<SslCertificate>({
  id: "security.ssl.expired",
  scope: "site",
  title: "TLS certificate has expired",
  category: "security",
  severity: "critical",
  remediation:
    "Renew the certificate and enable automatic renewal so it cannot lapse again.",
  select: (data) => fromCertificate(data.ssl),
  evaluate: (certificate) => {
    // Null means the date was unreadable — not that it expired.
    if (certificate.daysUntilExpiry === null) return passes;
    return certificate.daysUntilExpiry < 0
      ? fires(
          `The certificate expired ${Math.abs(certificate.daysUntilExpiry)} day(s) ago${
            certificate.validTo ? `, on ${certificate.validTo}` : ""
          }.`,
        )
      : passes;
  },
});

/**
 * A certificate that does not cover the address being visited produces the
 * same full-page warning as an expired one.
 *
 * Policy: fixed by the table at the top of this file.
 */
export const certificateHostnameRule = defineRule<{
  certificate: SslCertificate;
  hostname: string;
}>({
  id: "security.ssl.hostname",
  scope: "site",
  title: "TLS certificate does not cover this address",
  category: "security",
  severity: "critical",
  remediation:
    "Reissue the certificate including this hostname, or serve the site from an address the current certificate covers.",
  select: (data) => {
    const certificate = fromCertificate(data.ssl);
    if (!certificate.measured) return certificate as never;
    return measured({ certificate: certificate.value, hostname: data.ssl.hostname });
  },
  evaluate: ({ certificate, hostname }) => {
    /*
     * `coversHostname` is deliberately three-valued and null means "the
     * certificate carried no names we could check". Saying it does not cover
     * this address would then be a claim about something we never read.
     */
    if (certificate.coversHostname !== false) return passes;
    return fires(
      `The certificate does not list ${hostname}. It covers: ${
        certificate.subjectAltNames.length > 0
          ? certificate.subjectAltNames.join(", ")
          : "no readable names"
      }.`,
    );
  },
});

/**
 * The platform's own chain validation failed — self-signed, or issued by an
 * authority browsers do not trust. Same visitor-facing warning again.
 *
 * Policy: fixed by the table at the top of this file.
 */
export const certificateUntrustedRule = defineRule<SslData>({
  id: "security.ssl.untrusted",
  scope: "site",
  title: "TLS certificate is not trusted",
  category: "security",
  severity: "critical",
  remediation:
    "Replace the certificate with one issued by a publicly trusted certificate authority, and serve the full chain.",
  select: (data) => fromSsl(data.ssl),
  evaluate: (ssl) => {
    // `trusted` is boolean | null, and null means we never got far enough to
    // know. Only an explicit false is a verdict.
    if (ssl.trusted !== false) return passes;
    return fires(
      `The certificate did not pass validation${ssl.problem ? ` (${ssl.problem})` : ""}.`,
    );
  },
});

/**
 * Insecure resources on an HTTPS page. Browsers block the active ones outright
 * — scripts and stylesheets simply do not load — and drop the padlock for the
 * rest.
 *
 * Policy: High rather than critical: the page still works for the
 * visitor in the passive case, and nothing they type is exposed by it.
 */
export const mixedContentRule = defineRule<SecurityData["mixedContent"]>({
  id: "security.mixed-content",
  scope: "page",
  title: "Page loads insecure resources over HTTP",
  category: "security",
  severity: "high",
  remediation:
    "Update the affected URLs to https://, or serve those resources from a host that supports HTTPS.",
  select: (data) =>
    whenApplicable(
      data.security.mixedContent.applicable,
      data.security.mixedContent,
      "Mixed content only applies to HTTPS pages, and this page was served over HTTP.",
    ),
  evaluate: (mixed) => {
    if (mixed.total === 0) return passes;
    const blocked =
      mixed.activeCount > 0
        ? ` ${mixed.activeCount} of them are scripts or stylesheets a browser will block.`
        : "";
    return fires(
      `${mixed.total} insecure resource(s) were found in the page's HTML.${blocked}`,
    );
  },
});

/**
 * A form that posts to http:// sends whatever the visitor typed in the clear,
 * and browsers label it "Not secure" as they submit.
 *
 * Policy: Critical because it is the visitor's own data, not ours.
 */
export const insecureFormRule = defineRule<string[]>({
  id: "security.form.insecure",
  scope: "page",
  title: "Form sends data over an insecure connection",
  category: "security",
  severity: "critical",
  remediation:
    "Change the form's action to an https:// address so submitted data is encrypted in transit.",
  select: (data) => measured(data.security.insecureFormActions),
  evaluate: (actions) =>
    actions.length === 0
      ? passes
      : fires(
          `${actions.length} form(s) submit to an insecure address: ${actions.join(", ")}.`,
        ),
});

// ---------------------------------------------------------------------------
// B. Security headers
// ---------------------------------------------------------------------------

/**
 * HSTS tells browsers to refuse plain HTTP for this site in future, which is
 * what closes the gap on a visitor's very first request.
 *
 * Policy: Medium: HTTPS already works, this hardens it.
 */
export const hstsRule = defineRule<SecurityData>({
  id: "security.headers.hsts",
  scope: "page",
  title: "No usable HTTP Strict-Transport-Security header",
  category: "security",
  severity: "medium",
  remediation:
    "Send Strict-Transport-Security with a max-age of at least six months, e.g. max-age=15552000; includeSubDomains.",
  select: (data) =>
    whenApplicable(
      data.security.hsts.applicable,
      data.security,
      "HSTS is ignored by browsers on a plain HTTP page, so it was not graded here.",
    ),
  evaluate: (security) => {
    if (security.hsts.valid) return passes;

    // A header that exists but does nothing is worth saying out loud — it
    // usually means someone believes the site is protected.
    if (security.hsts.disabledByZeroMaxAge) {
      return fires("Strict-Transport-Security is present but sets max-age=0, which switches it off.");
    }
    if (security.strictTransportSecurity.present) {
      return fires(
        "Strict-Transport-Security is present but carries no usable max-age, so browsers ignore it entirely.",
      );
    }
    return fires("No Strict-Transport-Security header was sent.");
  },
});

/**
 * Content-Security-Policy limits what a page may load and execute, which is
 * the main defence against injected scripts.
 *
 * Severity documented in the collector before this file existed.
 */
export const cspRule = defineRule<SecurityData>({
  id: "security.headers.csp",
  scope: "page",
  title: "No Content-Security-Policy",
  category: "security",
  severity: "medium",
  remediation:
    "Add a Content-Security-Policy header. Start in report-only mode to find breakages before enforcing it.",
  select: (data) => measured(data.security),
  evaluate: (security) => {
    if (security.contentSecurityPolicy.present) return passes;

    // Report-only is a real step towards a policy, and saying so is fairer
    // than reporting it identically to a site that has done nothing.
    if (security.contentSecurityPolicyReportOnly.present) {
      return fires(
        "Only Content-Security-Policy-Report-Only was sent. It reports violations but blocks nothing.",
      );
    }
    return fires("No Content-Security-Policy header was sent.");
  },
});

// ---------------------------------------------------------------------------
// C. Cookies
// ---------------------------------------------------------------------------

/**
 * Only the cookies observed on this one response can be graded. The collector
 * records in `notInspected` that cookies set later by JavaScript, or on other
 * pages, were not seen — so an empty list is not a clean bill of health, and
 * these rules skip rather than pass when there is nothing to look at.
 */
function cookiesToGrade(security: SecurityData): CookieInfo[] {
  return security.cookies.cookies;
}

export const cookieSecureRule = defineRule<CookieInfo[]>({
  id: "security.cookies.secure",
  scope: "page",
  title: "Cookies sent without the Secure flag",
  category: "security",
  severity: "high",
  remediation:
    "Add the Secure attribute to every cookie so browsers only ever send them over HTTPS.",
  select: (data) => {
    if (!data.security.servedOverHttps) {
      return {
        measured: false,
        reason:
          "The site is not served over HTTPS, so cookie transport flags were not graded separately from that.",
      };
    }
    const cookies = cookiesToGrade(data.security);
    if (cookies.length === 0) {
      return {
        measured: false,
        reason:
          "This response set no cookies. Cookies set later by JavaScript or on other pages were not seen.",
      };
    }
    return measured(cookies);
  },
  evaluate: (cookies) => {
    const missing = cookies.filter((cookie) => !cookie.secure);
    return missing.length === 0
      ? passes
      : fires(
          `${missing.length} of ${cookies.length} cookie(s) lack the Secure flag: ${missing
            .map((cookie) => cookie.name)
            .join(", ")}.`,
        );
  },
});

/**
 * HttpOnly stops page JavaScript reading a cookie, which is what limits the
 * damage when a script is injected.
 *
 * Policy: Medium rather than high: it is a defence-in-depth
 * measure, and exploiting it requires a separate scripting flaw first.
 *
 * Not gated on HTTPS, unlike Secure — this is about JavaScript access, which
 * is the same on either protocol.
 */
export const cookieHttpOnlyRule = defineRule<CookieInfo[]>({
  id: "security.cookies.httponly",
  scope: "page",
  title: "Cookies readable by page JavaScript",
  category: "security",
  severity: "medium",
  remediation:
    "Add the HttpOnly attribute to any cookie that page scripts do not need to read, especially session cookies.",
  select: (data) => {
    const cookies = cookiesToGrade(data.security);
    if (cookies.length === 0) {
      return {
        measured: false,
        reason:
          "This response set no cookies. Cookies set later by JavaScript or on other pages were not seen.",
      };
    }
    return measured(cookies);
  },
  evaluate: (cookies) => {
    const missing = cookies.filter((cookie) => !cookie.httpOnly);
    return missing.length === 0
      ? passes
      : fires(
          `${missing.length} of ${cookies.length} cookie(s) lack the HttpOnly flag: ${missing
            .map((cookie) => cookie.name)
            .join(", ")}.`,
        );
  },
});

// ---------------------------------------------------------------------------
// D. Email security, via DNS
// ---------------------------------------------------------------------------

/**
 * Without SPF, anyone can send email claiming to be from this domain.
 *
 * Policy: Medium: it is a real exposure, but it affects email
 * rather than the website the client asked us to audit.
 *
 * The selector is what makes this safe. A DNS lookup that FAILED never reaches
 * evaluate, so "we could not check" can never be reported as "no record".
 */
export const spfRule = defineRule<Presence<string>>({
  id: "security.dns.spf",
  scope: "site",
  title: "No SPF record published",
  category: "security",
  severity: "medium",
  remediation:
    "Publish an SPF TXT record listing the servers allowed to send email for this domain.",
  select: (data) => fromEmailPolicy(data.dns.spf),
  /*
   * THE WORDING IS THE CAREFUL PART, AND IT USED TO OVERCLAIM.
   *
   * It said "so senders cannot be verified". SPF is not the only way a sender
   * is checked — DKIM signs the message itself and is published separately —
   * so a domain with no SPF record may still have its mail authenticated. The
   * sentence stated the consequence of the whole absence of authentication on
   * the strength of one missing record.
   *
   * What replaced it says only what the measurement supports: SPF's job is to
   * publish the list of servers allowed to send, and there is no such list.
   * It makes no claim, either way, about any other mechanism — because none
   * was measured.
   */
  evaluate: (spf) =>
    spf.present
      ? passes
      : fires(
          "The domain publishes no SPF record, so it names no servers as allowed to send email for it.",
        ),
});

/**
 * DMARC tells receiving servers what to do with mail that fails SPF or DKIM.
 * Without it, a failing message is usually delivered anyway.
 *
 * Policy: fixed by the table at the top of this file.
 */
export const dmarcRule = defineRule<Presence<string>>({
  id: "security.dns.dmarc",
  scope: "site",
  title: "No DMARC record published",
  category: "security",
  severity: "medium",
  remediation:
    "Publish a DMARC TXT record at _dmarc.<domain>, starting with p=none to monitor before enforcing.",
  select: (data) => fromEmailPolicy(data.dns.dmarc),
  evaluate: (dmarc) =>
    dmarc.present
      ? passes
      : fires(
          "The domain publishes no DMARC record, so nothing tells receiving servers how to treat forged mail.",
        ),
});

/**
 * Every security rule, in one list.
 *
 * Order is irrelevant — the runner sorts findings by severity and id — but
 * keeping them grouped by topic makes the set easy to review.
 */
export const SECURITY_RULES = [
  httpsRule,
  certificateExpiredRule,
  certificateHostnameRule,
  certificateUntrustedRule,
  mixedContentRule,
  insecureFormRule,
  hstsRule,
  cspRule,
  cookieSecureRule,
  cookieHttpOnlyRule,
  spfRule,
  dmarcRule,
] as const;
