/**
 * The shape of our audit data.
 *
 * This file is the contract between every part of the app:
 *   - The Collector fills these fields with real, measured facts.
 *   - Claude (a later phase) reads these fields and explains them. It never
 *     sees anything else.
 *   - The PDF report displays these fields.
 *
 * Nothing here is invented at runtime. Every field is either measured or
 * explicitly marked as not measured.
 */

/**
 * A section of the audit whose module has not been built yet.
 *
 * `null` here means "this check has not run". It does NOT mean "the check ran
 * and found nothing wrong". Anything reading this data — including Claude —
 * must treat null as an absence of information, never as a clean result.
 *
 * When a module is implemented, widen its field to `TheData | null`.
 */
export type NotYetImplemented = null;

/**
 * How serious a problem is.
 *
 * IMPORTANT: severity is decided by fixed rules in our own code, never by AI.
 * Claude explains a severity we already calculated; it doesn't choose one.
 */
export type Severity = "critical" | "high" | "medium" | "good";

/** Which area of the audit a finding belongs to. */
export type Category = "seo" | "speed" | "security" | "technical";

/** A single thing we found out about the website. */
export interface Finding {
  /** Stable identifier, e.g. "missing-meta-description". Useful for testing. */
  id: string;
  /** Short human-readable name, e.g. "Missing meta description". */
  title: string;
  category: Category;
  severity: Severity;
  /**
   * The measured fact behind this finding, e.g. "No <meta name='description'> tag found".
   * This is what makes the finding checkable by a human.
   */
  evidence: string;
}

/** Why a certificate stopped an HTTPS connection succeeding. */
export type CertificateProblem = "expired" | "self-signed" | "wrong-hostname" | "untrusted";

// ---------------------------------------------------------------------------
// website — what was audited, and when
// ---------------------------------------------------------------------------

export interface WebsiteInfo {
  /** The address after tidying up what the user typed, before any redirects. */
  requestedUrl: string;
  /** When this audit ran, as an ISO date string. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// fetch — what happened while retrieving the page
// ---------------------------------------------------------------------------

export interface FetchData {
  /** The address finally reached. Differs from requestedUrl if it redirected. */
  finalUrl: string;
  /** Every address passed through, starting with the one requested. */
  redirectChain: string[];
  /** True when the final address differs from the one requested. */
  wasRedirected: boolean;
  /** Whether the page finally read was served over HTTPS. */
  servedOverHttps: boolean;
  /**
   * True when HTTPS could not be reached at all and the page was read over
   * plain HTTP instead. Strong evidence the site has no working HTTPS.
   */
  httpsUnavailable: boolean;
  /**
   * A certificate problem observed while trying to connect over HTTPS.
   *
   * This is NOT a certificate inspection. It only records why an HTTPS
   * connection failed. `null` means no such failure occurred — which is NOT
   * the same as "the certificate was checked and found valid". A proper
   * certificate inspection belongs to the (not yet built) ssl module.
   */
  certificateProblem: CertificateProblem | null;
  /** The Content-Type header the server sent for the page. */
  contentType: string | null;
}

// ---------------------------------------------------------------------------
// uptime — did it answer, and how quickly
// ---------------------------------------------------------------------------

export interface UptimeCheck {
  /**
   * Whether the server responded at all.
   *
   * True for ANY HTTP status, including 404 and 500 — a server that answers
   * is online, even if it answers with an error. False only when nothing
   * responded.
   */
  isOnline: boolean;
  /** HTTP status code, e.g. 200 = OK, 404 = not found. Null if we got no response at all. */
  statusCode: number | null;
  /**
   * Milliseconds until the server STARTED responding — the moment its reply
   * headers arrived. Commonly called "time to first byte".
   *
   * This is NOT how long the page took to load. It excludes downloading the
   * page content, and excludes the browser work of rendering it. A large page
   * on a fast server has a low value here and can still feel slow to a visitor.
   *
   * It measures server responsiveness only. Actual page-load speed will come
   * from the (not yet built) performance module.
   *
   * Includes DNS lookup, connection setup, and any redirects along the way.
   * Null if the site never responded.
   */
  serverResponseTimeMs: number | null;
}

// ---------------------------------------------------------------------------
// seo — read from the page's own HTML
// ---------------------------------------------------------------------------

/**
 * On-page SEO facts, read from the page's own HTML.
 *
 * IMPORTANT — some fields here (`titleText`, `metaDescriptionText`, `h1Texts`)
 * contain text copied from someone else's website. Treat it as DATA, never as
 * instructions or as code:
 *   - When displaying it, always render as plain text. React does this by
 *     default; the PDF template must do the same deliberately.
 *   - When sending it to Claude, the prompt must state that these are measured
 *     values to describe, not commands to follow.
 */
export interface SeoData {
  /** The <title> text, or null if the page has none. */
  titleText: string | null;
  /** Character count of the title. 0 when absent. */
  titleLength: number;

  /** The meta description, or null if absent. */
  metaDescriptionText: string | null;
  metaDescriptionLength: number;

  /** How many <h1> elements the page has. Ideally exactly one. */
  h1Count: number;
  /** How many <h2> elements the page has. */
  h2Count: number;
  /** How many <h3> elements the page has. */
  h3Count: number;
  /**
   * The text of each <h1> that actually has text, in page order.
   *
   * This can be SHORTER than h1Count: an empty <h1></h1> is counted as an
   * element but contributes no text. So "h1Count: 2, h1Texts: ['About us']"
   * means one heading has text and one is empty — not that a heading is missing
   * from this list.
   */
  h1Texts: string[];
  /**
   * Places where heading levels skip a step, e.g. an <h2> followed by an <h4>.
   * Each entry describes one skip. An empty list means the order is sensible.
   */
  headingSkips: string[];

  /** Total <img> elements found. */
  imageCount: number;
  /** How many of those have no usable alt attribute. */
  imagesMissingAlt: number;

  /**
   * The canonical URL the page declares, if any.
   * Resolved to an absolute address, since the tag may hold a relative one.
   */
  canonicalUrl: string | null;
  /** The <html lang="..."> value, if set. */
  langAttribute: string | null;
  /** Whether a viewport meta tag is present — required for mobile display. */
  hasViewportMeta: boolean;
}

// ---------------------------------------------------------------------------
// technical — site-level files search engines look for
// ---------------------------------------------------------------------------

export interface TechnicalData {
  /** Whether /robots.txt exists and could be read. */
  robotsTxtFound: boolean;
  /**
   * Whether robots.txt blocks all crawlers from the whole site.
   * A common and costly misconfiguration.
   */
  robotsBlocksEverything: boolean;
  /** A sitemap URL, from robots.txt or the usual /sitemap.xml location. */
  sitemapUrl: string | null;
}

// ---------------------------------------------------------------------------
// security — protective settings the server sent, and insecure page resources
// ---------------------------------------------------------------------------

/** One security header: was it sent, and what did it say? */
export interface SecurityHeader {
  /** Whether the server sent this header at all. */
  present: boolean;
  /**
   * Exactly what the server sent, or null when absent.
   *
   * Kept verbatim so a human can check our reading of it. This is text from
   * someone else's server — display it as plain text, never as markup.
   */
  value: string | null;
}

/**
 * Strict-Transport-Security, read in detail.
 *
 * Worth parsing rather than just checking presence: `max-age=0` is a header
 * that is technically there and deliberately does nothing. Counting it as
 * "protected" would be wrong.
 */
export interface HstsData {
  /**
   * Whether HSTS can do anything here. It is only meaningful on an HTTPS
   * page — on a plain HTTP page the header is ignored by browsers, so
   * reporting it as "missing" would be noise on top of the far bigger
   * problem that the site has no HTTPS.
   */
  applicable: boolean;
  /**
   * Whether the header is one a browser would actually act on.
   *
   * False when no header was sent, and also when a header WAS sent but
   * carries no usable max-age. RFC 6797 requires max-age, so a header
   * without it is invalid and browsers ignore it completely — writing
   * `includeSubDomains` alone protects nothing at all.
   *
   * When this is false, every field below is false or null regardless of
   * what the header said. The text that was actually sent is still available
   * on the SecurityHeader for this header, so "they wrote includeSubDomains
   * but forgot max-age" remains a finding that can be made — but nothing here
   * will claim protection the site does not have.
   */
  valid: boolean;
  /** How long browsers are told to stay on HTTPS. Null if absent or unreadable. */
  maxAgeSeconds: number | null;
  /** True when max-age is explicitly 0, which switches HSTS off. */
  disabledByZeroMaxAge: boolean;
  /** Whether subdomains are covered too. Only ever true on a valid header. */
  includesSubdomains: boolean;
  /**
   * Whether the site asks to be in browsers' built-in preload list.
   * Only ever true on a valid header.
   */
  preload: boolean;
}

/**
 * How a browser is expected to treat an insecure resource.
 *
 * - "active" — scripts, stylesheets, iframes, fonts. These can change the
 *   page, so browsers usually BLOCK them and the page may visibly break.
 * - "passive" — images, audio, video. Usually still loaded, but the padlock
 *   is downgraded and the visitor sees a warning.
 * - "unknown" — the markup does not say what kind of resource it is. A
 *   `url(...)` inside CSS could be an image or a font, and guessing from the
 *   file extension would be inference, not measurement. Reported honestly as
 *   undetermined instead.
 */
export type MixedContentKind = "active" | "passive" | "unknown";

/** One resource the page loads over plain HTTP. */
export interface MixedContentItem {
  /** The insecure address, exactly as written in the page. */
  url: string;
  /** Which element referred to it, e.g. "img", "script", "div". */
  element: string;
  /**
   * How the element referred to it — an attribute name such as "src", or a
   * mechanism such as "style attribute" or "CSS url()".
   *
   * Present so a person can find the reference in the page source. Without
   * it, a CSS background image would be reported against a "div" with no clue
   * where in that div to look.
   */
  via: string;
  kind: MixedContentKind;
}

export interface MixedContentData {
  /**
   * Whether mixed content is possible here. Only an HTTPS page can have it;
   * on an HTTP page every resource is insecure by definition, which is the
   * same single finding, not dozens.
   */
  applicable: boolean;
  /**
   * How many insecure resources were found IN THE PAGE'S OWN HTML.
   *
   * Read `notInspected` before treating 0 as "this site is clean" — see the
   * note on that field. This is a count of what a static read of the served
   * markup can see, not of everything a browser would end up loading.
   */
  total: number;
  /** How many of those a browser is expected to block outright. */
  activeCount: number;
  /**
   * The insecure resources found, capped at MIXED_CONTENT_LIMIT.
   * `total` is the true count even when this list is shorter.
   */
  items: MixedContentItem[];
  /** True when more were found than this list holds. */
  truncated: boolean;
  /**
   * Places this scan could NOT look, in plain words.
   *
   * This exists so that `total: 0` is never presented as "the whole website
   * is free of mixed content". We read the HTML the server sent; we do not
   * run the page. Anything a browser fetches afterwards — resources named
   * inside a separate .css file, or added by JavaScript once the page runs —
   * is outside what we can honestly report on.
   *
   * Whatever displays this data must say so alongside the count.
   */
  notInspected: string[];
}

/**
 * The protective flags on one cookie.
 *
 * IMPORTANT — the cookie's VALUE is deliberately never stored. A cookie value
 * is often a live session token: capturing it would put a working key to
 * someone's account into our audit data, our logs, and the report we send a
 * client. Only the name and the flags are recorded, which is all an audit
 * needs.
 */
export interface CookieInfo {
  /** The cookie's name. Its value is intentionally not captured. */
  name: string;
  /** Secure — the browser will only send this cookie over HTTPS. */
  secure: boolean;
  /** HttpOnly — JavaScript on the page cannot read this cookie. */
  httpOnly: boolean;
  /** The SameSite setting, lowercased, or null when the server did not set one. */
  sameSite: string | null;
}

export interface CookieData {
  /** How many cookies the response set. */
  total: number;
  /** The cookies, with names and flags only — never values. */
  cookies: CookieInfo[];
  /**
   * What this check cannot see: cookies created later by JavaScript, and
   * cookies set on other pages of the site. Recorded so an empty list is not
   * read as "this site sets no cookies".
   */
  notInspected: string[];
}

export interface SecurityData {
  /** Whether the page itself was served over HTTPS. Everything else depends on this. */
  servedOverHttps: boolean;

  strictTransportSecurity: SecurityHeader;
  contentSecurityPolicy: SecurityHeader;
  /**
   * Content-Security-Policy-Report-Only.
   *
   * A report-only policy is monitored but NOT enforced, so it protects
   * nobody. Recorded separately so "no policy at all" and "a policy being
   * trialled" are distinguishable — they are different conversations to have
   * with a client, and folding them together loses that.
   */
  contentSecurityPolicyReportOnly: SecurityHeader;
  xFrameOptions: SecurityHeader;
  xContentTypeOptions: SecurityHeader;
  referrerPolicy: SecurityHeader;
  permissionsPolicy: SecurityHeader;

  hsts: HstsData;
  mixedContent: MixedContentData;
  cookies: CookieData;

  /**
   * Forms that submit to a plain HTTP address.
   *
   * Kept separate from mixed content on purpose: mixed content is about
   * resources the page LOADS, whereas this is about data the visitor SENDS.
   * Anything typed into such a form — a password, a phone number, a message —
   * travels unencrypted, and browsers mark the form "Not secure".
   *
   * Reported even on an HTTP page, where it is one more consequence of having
   * no HTTPS at all.
   */
  insecureFormActions: string[];

  /**
   * Headers that announce the server software, often including its version.
   *
   * Telling the world exactly which version you run makes it easier for
   * someone to look up its known weaknesses, so hiding these is common
   * advice. Note this is an information-disclosure check, NOT hosting
   * detection — the hosting module will read the same headers later for a
   * different purpose.
   */
  serverHeader: SecurityHeader;
  poweredByHeader: SecurityHeader;
}

// ---------------------------------------------------------------------------
// ssl — the certificate the site presents
// ---------------------------------------------------------------------------

/** How the audited hostname relates to the names on the certificate. */
export type HostnameMatch = "exact" | "wildcard" | "none";

/** What happened when we tried to read the certificate. */
export type SslCheckStatus =
  /** We connected and read the certificate. */
  | "checked"
  /** The page is not served over HTTPS, so there is no certificate to read. */
  | "not-applicable"
  /** The safety check refused the address, so no connection was attempted. */
  | "blocked"
  /** We could not complete a TLS connection. See `failure`. */
  | "unreachable";

/** Why a TLS connection could not be completed. */
export type SslFailure =
  | "timeout"
  | "connection-refused"
  | "host-not-found"
  | "handshake-failed";

export interface SslCertificate {
  /** When the certificate became valid, as an ISO date. Null if unreadable. */
  validFrom: string | null;
  /** When it expires, as an ISO date. Null if unreadable. */
  validTo: string | null;
  /**
   * Whole days until expiry — negative when it has already expired.
   *
   * The most useful number here: an expired certificate shows every visitor a
   * full-page browser warning, and it is entirely preventable.
   */
  daysUntilExpiry: number | null;
  /** The authority that issued it, e.g. "Let's Encrypt". Null if unreadable. */
  issuer: string | null;
  /** The certificate's subject name. Null if unreadable. */
  subject: string | null;
  /** Every hostname the certificate covers, from its Subject Alternative Names. */
  subjectAltNames: string[];
  /** Whether the audited hostname is one of them. */
  coversHostname: boolean;
  /** How it matched — an exact name, a wildcard, or not at all. */
  hostnameMatch: HostnameMatch;
  /** The TLS version negotiated, e.g. "TLSv1.3". Null if not reported. */
  protocol: string | null;
}

export interface SslData {
  status: SslCheckStatus;
  /** The hostname whose certificate was checked. */
  hostname: string;
  /** Present only when status is "checked". */
  certificate: SslCertificate | null;
  /**
   * Whether the certificate chain passed the platform's own validation.
   *
   * Null when we never got far enough to know — which is NOT the same as
   * "untrusted". A null here means unknown, never a verdict.
   */
  trusted: boolean | null;
  /**
   * Why validation failed, as a value rather than a sentence.
   * Null when validation passed, or when we could not determine it.
   */
  problem: CertificateProblem | null;
  /** Why the check itself could not complete. Null when it did. */
  failure: SslFailure | null;
  /** A plain-language summary for a person reading the report. */
  message: string;
}

// ---------------------------------------------------------------------------
// dns — the domain's records
// ---------------------------------------------------------------------------

/**
 * The outcome of one DNS lookup.
 *
 * The distinction between "absent" and "error" is the whole point: a lookup
 * that failed is NOT evidence a record is missing. Reporting a timeout as
 * "this domain has no SPF record" would invent a security finding.
 */
export type DnsStatus =
  /** The lookup succeeded and returned at least one record. */
  | "found"
  /** The lookup succeeded and the domain genuinely has no such record. */
  | "absent"
  /** The lookup did not complete, so we do not know either way. */
  | "error";

export interface DnsRecordSet<T> {
  status: DnsStatus;
  /** The records found. Empty unless status is "found". */
  records: T[];
  /** Why the lookup failed, when status is "error". Null otherwise. */
  error: string | null;
}

/** One mail server, with the priority the domain assigns it. */
export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * An email anti-forgery record.
 *
 * Without SPF and DMARC, anyone can send email that appears to come from the
 * domain — a fake invoice from the company's own address. Common, invisible
 * until abused, and fixable.
 */
export interface EmailPolicyRecord {
  status: DnsStatus;
  /** The record's text when found. Null otherwise. */
  record: string | null;
  /** Why the lookup failed, when status is "error". Null otherwise. */
  error: string | null;
}

export interface DnsData {
  /** The host serving the website — where the address records were looked up. */
  hostname: string;
  /**
   * The domain the mail and zone records were looked up on.
   *
   * Usually the same as `hostname`, but with a leading "www." removed. This
   * matters: a site served from "www.example.com" is very often a CDN alias
   * with no records of its own, while the mail policy lives on
   * "example.com". Looking only at the www name would report "no SPF record"
   * for a domain that has one — a false security finding in a client's report.
   */
  emailDomain: string;
  a: DnsRecordSet<string>;
  aaaa: DnsRecordSet<string>;
  mx: DnsRecordSet<MxRecord>;
  ns: DnsRecordSet<string>;
  txt: DnsRecordSet<string>;
  /** SPF, taken from the TXT records above — a record starting "v=spf1". */
  spf: EmailPolicyRecord;
  /**
   * DMARC, which lives at its own hostname rather than in the domain's TXT.
   * The hostname is derived from user input, so it is safety-checked in its
   * own right before any lookup.
   */
  dmarc: EmailPolicyRecord & {
    /** The derived hostname that was checked, e.g. "_dmarc.example.com". */
    hostname: string;
  };
}

// ---------------------------------------------------------------------------
// One complete audit
// ---------------------------------------------------------------------------

/**
 * One complete audit of one website.
 *
 * Sections are grouped so each future module owns exactly one of them. The
 * sections typed `NotYetImplemented` are placeholders: their modules have not
 * been built, and null means "not measured", never "measured and fine".
 */
export interface AuditData {
  website: WebsiteInfo;
  fetch: FetchData;
  uptime: UptimeCheck;
  seo: SeoData;
  /**
   * robots.txt and sitemap findings.
   *
   * Null when the audit ran out of time before these checks could run — which
   * is NOT the same as "this site has no robots.txt". `timedOut` says why.
   */
  technical: TechnicalData | null;

  /** Speed / Core Web Vitals. Module not built yet. */
  performance: NotYetImplemented;
  /** Security headers and mixed content. */
  security: SecurityData;
  /**
   * The certificate the site presents.
   *
   * Site-level: a certificate does not change between pages, so Phase 4 runs
   * this once per site and shares the result across every page it crawls.
   */
  ssl: SslData;
  /**
   * The domain's DNS records.
   *
   * Site-level, for the same reason as ssl.
   */
  dns: DnsData;
  /** Hosting/CDN detection. Module not built yet. */
  hosting: NotYetImplemented;

  /**
   * Graded issues derived from the measurements above by fixed rules.
   * Empty until the severity-rules module is built.
   */
  findings: Finding[];

  /**
   * True when the audit's overall time budget ran out before every check
   * finished. The checks that did run are still reported; the ones that did
   * not are null.
   *
   * This exists so a partial audit is never mistaken for a complete one.
   */
  timedOut: boolean;
}

/**
 * What the /api/audit endpoint sends back.
 *
 * Either the audit succeeded and `data` is present, or it failed and `error`
 * explains why.
 *
 * A failure can still carry `uptime`: if a site answers with a 404, we could
 * not audit its content, but we genuinely did learn that the server is up and
 * how fast it replied. Throwing that away would discard a real measurement.
 * It is absent when we never reached the site at all.
 */
export type AuditResponse =
  | { ok: true; data: AuditData }
  | {
      ok: false;
      error: string;
      uptime?: UptimeCheck;
      /**
       * Why an HTTPS connection failed, when that is what stopped the audit.
       *
       * The `error` message already says this in English, but a sentence is
       * not something the severity rules or Claude should have to parse. This
       * is the same value that reaches `fetch.certificateProblem` when the
       * page can still be read over plain HTTP — kept here for the case where
       * it cannot, so the finding is not lost with the failure.
       */
      certificateProblem?: CertificateProblem;
    };
