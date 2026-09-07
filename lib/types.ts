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

/*
 * Type-only, so nothing is imported at runtime and no cycle is created — the
 * crawler already reads its own types from this file. The crawl summary lives
 * with the crawler because that is what produces it; it is referenced here so
 * a whole-site result can carry it without a second, drifting copy.
 */
import type { SiteCrawlSummary } from "./collector/crawlSite";

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
  /**
   * What to do about it, in one sentence.
   *
   * A constant declared by the rule, exactly like severity — not generated,
   * not chosen per audit, and not written by an AI. Claude may expand on it in
   * Phase 5; it never replaces it.
   */
  remediation: string;

  /*
   * The three fields below are set ONLY by site-wide aggregation, when one
   * finding stands for the same rule firing across many crawled pages. A
   * single-page audit leaves all three absent, so everything written before
   * multi-page crawling reads exactly as it did.
   *
   * None of them influences `severity`. The rule declares that, and a finding
   * on eighty pages carries the same severity as the same finding on one —
   * counting is not grading.
   */

  /**
   * Which pages this finding was found on, and what was measured on each.
   *
   * A BOUNDED SAMPLE, not the whole list: see `affectedCount` for the real
   * total. Sorted by address so the same crawl always produces the same order,
   * whatever order the workers happened to finish in.
   */
  affected?: Array<{ url: string; evidence: string }>;

  /**
   * How many pages this finding was actually found on.
   *
   * Reported separately because `affected` is capped. Without it, a rule
   * firing on four hundred pages would silently read as fifty.
   */
  affectedCount?: number;

  /**
   * Whether this finding describes one page or the whole site.
   *
   * Copied from the rule, which declares it. It changes how the counts above
   * are to be read: a `"page"` finding names the pages it was found on, while
   * a `"site"` finding describes a single fact about the domain — one
   * certificate, one SPF record — and carries no page denominator at all,
   * because it does not have one.
   */
  scope?: "page" | "site";

  /**
   * How many crawled pages this rule ACTUALLY RAN on — the denominator.
   *
   * ABSENT ON SITE-SCOPED FINDINGS, deliberately. A domain's DNS records were
   * not measured "on 128 pages", and giving that finding a page denominator
   * would invite every reader of it to quote a proportion that was never
   * measured.
   *
   * Not the number of pages crawled. A page where the rule was skipped could
   * not have fired it, so counting that page would quietly turn "we could not
   * check this" into "this page was fine". Pages that could not be read, that
   * were not HTML, or that robots.txt kept us away from are not in it either.
   */
  evaluatedPages?: number;
}

/**
 * A grading rule that could not run, and why.
 *
 * WHY THIS IS NOT A FINDING: "we could not check the SPF record" is not a
 * problem with the website. Turning it into one would invent a fault, and
 * dropping it silently would let a gap read as a pass. It is a third thing,
 * and it is kept as a third thing.
 *
 * Distinct from every neighbouring state on purpose:
 *   error            the measurement failed        -> skipped
 *   null             never measured                -> skipped
 *   applicable:false meaningless in this context   -> skipped
 *   absent           measured, genuinely missing    -> a real finding
 */
export interface SkippedCheck {
  /** The rule that did not run, e.g. "security.dns.spf". */
  ruleId: string;
  /** Why, in plain words, from the collector that knew. */
  reason: string;
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

  /**
   * Characters of visible text in the SERVED HTML.
   *
   * A measurement, not a verdict. It says how much text arrived — it does not
   * say the page is client-rendered, broken, or thin, and nothing here should
   * be read as any of those.
   *
   * It exists because this scan does not run JavaScript. A site that builds
   * its content in the browser serves an almost empty body, so its headings
   * and images are absent from the HTML while being perfectly present for a
   * visitor. Rules that depend on body content consult this first, so they can
   * decline to judge rather than report half a dozen problems that are not
   * there.
   *
   * HEAD-BASED FACTS BELOW — title, meta description, canonical, lang,
   * viewport — ARE MEASURED INDEPENDENTLY OF IT. A tag present in the served
   * markup is present, and nothing about the body changes that.
   *
   * Their ABSENCE is a different claim, and it IS gated on this number. A page
   * that builds itself in the browser commonly sets its own head tags at
   * runtime, so their absence from the served markup is not evidence they are
   * missing from the page. The rules that would report one as missing decline
   * to run when the body is too thin to judge by, and say so in
   * `skippedChecks` rather than leaving a silent gap.
   *
   * `fromServedHead` in `lib/rules/selectors.ts` is where that happens and is
   * authoritative; it shares this same threshold deliberately, so there is one
   * notion of "too little was served to judge by" rather than two.
   *
   * Excludes script, style, noscript and template contents: none of it is ever
   * shown to a visitor.
   */
  bodyTextLength: number;

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

/**
 * What we managed to establish about a site-level file.
 *
 * THREE STATES, NOT TWO, AND THE THIRD IS THE POINT. A boolean can only say
 * "found" or "not found", so a request that timed out had to be recorded as
 * "not found" — reporting a file as absent from the client's website when all
 * we actually knew was that our own request failed.
 *
 *   found        we read it
 *   absent       THE SERVER TOLD US it is not there: 404, 410, or a site that
 *                answers every unknown address with its homepage
 *   unavailable  we could not find out. A timeout, a 5xx, a refused
 *                connection, or a body too large to read. Says nothing
 *                whatsoever about the website.
 *
 * Nothing downstream may treat `unavailable` as `absent`, and the rule that
 * reads robots.txt skips rather than passes when it sees one.
 */
export type SiteFileStatus = "found" | "absent" | "unavailable";

export interface TechnicalData {
  /**
   * Whether /robots.txt was found, genuinely absent, or could not be checked.
   *
   * Replaced a `robotsTxtFound: boolean`, which had no way to express the
   * third case and so reported our own failed request as the client having no
   * robots.txt.
   */
  robotsTxtStatus: SiteFileStatus;
  /**
   * Whether robots.txt blocks all crawlers from the whole site.
   * A common and costly misconfiguration.
   *
   * Meaningful ONLY when `robotsTxtStatus` is "found". False when the file is
   * absent — nothing is blocked — and false when it is unavailable, where the
   * value carries no information and the rule declines to run.
   */
  robotsBlocksEverything: boolean;
  /** Whether a sitemap was found, genuinely absent, or could not be checked. */
  sitemapStatus: SiteFileStatus;
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
  | "handshake-failed"
  /**
   * The connection succeeded but no readable certificate came back.
   *
   * Distinct from the others because it is not a network problem — and
   * distinct from a certificate that IS readable but covers a different
   * address, which is a real finding rather than a failure to look.
   */
  | "no-certificate";

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
  /**
   * Whether the audited hostname is one of them.
   *
   * `false` means we read the certificate's names and this address was not
   * among them — a real finding. `null` means the certificate carried no
   * names we could check, so we do not know. Those must never be confused:
   * saying "the certificate does not cover this address" about a certificate
   * we could not read would be a claim we never measured.
   */
  coversHostname: boolean | null;
  /**
   * How it matched — an exact name, a wildcard, or not at all.
   * Null when there were no names to check against.
   */
  hostnameMatch: HostnameMatch | null;
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

/**
 * What a DMARC record instructs receiving servers to do with failing mail.
 *
 * These three are the only values the specification defines. Anything else in
 * the record is not one of them, and is recorded as no readable policy rather
 * than being rounded to the nearest.
 */
export type DmarcPolicy = "none" | "quarantine" | "reject";

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
   *
   * UNLIKE SPF, DMARC IS INHERITED. A subdomain with no record of its own is
   * covered by its organisational domain's record, so checking only the
   * audited name reported "this domain publishes no DMARC record" for domains
   * that are, in fact, protected. `policyDomain` says which name the record
   * actually came from.
   */
  dmarc: EmailPolicyRecord & {
    /** The derived hostname that was READ, e.g. "_dmarc.example.com". */
    hostname: string;
    /**
     * THE DOMAIN THIS POLICY IS ABOUT.
     *
     * Every other field here describes the DMARC position of this name and no
     * other. It is the MAIL DOMAIN — `emailDomain` above — not the hostname
     * the website is served from.
     *
     * Those differ, and the difference is the reason this field exists. A site
     * at "www.example.com" has its mail on "example.com": nobody sends email
     * from the www name, and `emailDomainFor` drops the label before any
     * lookup happens. So an audit of "www.example.com" reports the DMARC
     * position of "example.com", which is the one the client actually has.
     *
     * Without this field a reader had to know that rule to interpret the rest,
     * and "the audited domain" could reasonably be read as the hostname that
     * was typed. Now nothing has to be inferred.
     */
    appliesTo: string;
    /**
     * WHERE THE RECORD WAS READ FROM.
     *
     * The domain whose `_dmarc` name held the record — equal to `appliesTo`
     * when the domain publishes its own, and a parent of it when the policy
     * was inherited.
     *
     * Null when no record was found, and null when the lookup failed: we
     * cannot name a source for a record we never read.
     */
    policyDomain: string | null;
    /**
     * Whether the policy came from somewhere OTHER than `appliesTo`.
     *
     * True exactly when `policyDomain` is a parent rather than `appliesTo`
     * itself. Kept as its own field so nothing has to compare two strings to
     * find out. "Your domain publishes DMARC" and "your parent domain's DMARC
     * covers you" are different sentences, and only one is true at a time.
     */
    inherited: boolean;
    /**
     * The policy that governs mail from `appliesTo`.
     *
     * Which tag that is depends on where the record was found, because DMARC
     * says so:
     *
     *   direct     `p=`               the record is this domain's own
     *   inherited  `sp=`, else `p=`   `sp=` governs a parent's subdomains,
     *                                 and a record without one applies its
     *                                 `p=` to them instead
     *
     * NOT simply "whatever the record said". A parent publishing
     * `p=reject; sp=none` protects itself and leaves its subdomains open, and
     * reporting `reject` for a subdomain would overstate what the client has.
     *
     * Null when no record was found, and null when the record carries no
     * policy tag we recognise — an unreadable tag is not `none`, and reading
     * it that way would claim the record permits forged mail through.
     */
    effectivePolicy: DmarcPolicy | null;
  };
}

// ---------------------------------------------------------------------------
// performance — how fast the site is, from Google PageSpeed Insights
// ---------------------------------------------------------------------------

/** Google's own rating of a metric. We record it rather than judging ourselves. */
export type PerformanceRating = "FAST" | "AVERAGE" | "SLOW";

/**
 * Why a speed check produced no numbers.
 *
 * These are deliberately separate causes rather than one "it failed". A
 * timeout, a reply too large to read, and a reply we could not parse each call
 * for a different response from whoever reads the report, and collapsing them
 * would tell that person the wrong thing to go and fix.
 */
export type PerformanceFailureReason =
  /** No PAGESPEED_API_KEY on the server. Nothing was attempted. */
  | "no-api-key"
  /** The audit's clock ran out before the check could start. */
  | "out-of-time"
  /** Google was reached but did not finish in time — connecting, waiting, or sending. */
  | "timeout"
  /** Google could not be reached at all. */
  | "network"
  /** Google answered with an error status. Its own words are in `message`. */
  | "api-error"
  /** The reply exceeded the size we are willing to hold in memory. */
  | "response-too-large"
  /**
   * The reply arrived complete but was not usable PageSpeed data.
   *
   * Strictly about Google's answer. An error on our side is never this — see
   * "internal-error" below.
   */
  | "unreadable-response"
  /**
   * The check itself failed unexpectedly.
   *
   * Our fault, not Google's. Kept separate so a bug here can never be read as
   * evidence that Google sent something bad.
   */
  | "internal-error";

/** Whether the speed check ran, and why not if it did not. */
export type PerformanceStatus =
  /** The check ran and returned results. */
  | "checked"
  /** Nobody asked for it — the speed check is opt-in because it is slow. */
  | "not-requested"
  /** Asked for, but we have no API key configured. */
  | "no-api-key"
  /**
   * Asked for, and running as a separate request.
   *
   * The speed check no longer holds up the audit: the main audit returns with
   * this, and the answer arrives from /api/audit/performance afterwards. It is
   * emphatically NOT a result — nothing has been measured yet, and it must
   * never be read as "fine" or as "slow".
   */
  | "pending"
  /** Asked for, but the check could not complete. See `message`. */
  | "error";

/** Whether real-visitor data exists for this address. */
export type FieldDataStatus =
  /** Google has enough real visits to report on. */
  | "found"
  /**
   * Google has no data for this address. That means TOO FEW VISITORS to
   * report anonymously — it does NOT mean the site is slow. A quiet site and
   * a slow site must never look the same in a report.
   */
  | "absent"
  /** The lookup did not complete, so we know nothing either way. */
  | "error";

/**
 * One timing measurement from real visitors, in milliseconds.
 *
 * The unit is in the field name on purpose. An earlier bug in this project
 * came from a number called `responseTime` being read as a page-load time, so
 * anything measured in milliseconds now says so where it cannot be missed.
 */
export interface FieldTimeMetric {
  /**
   * The value three out of four visits did better than, in milliseconds.
   *
   * Not an average: Google judges a site on the 75th percentile, so this is a
   * statement about nearly all visitors rather than a typical one.
   */
  percentileMs: number;
  /** Google's rating for that value. Taken from the API, not calculated here. */
  category: PerformanceRating;
}

/**
 * Cumulative Layout Shift from real visitors.
 *
 * Separate from the timing metrics because CLS is a unitless score, not a
 * duration. Giving it its own type makes it impossible to write it into a
 * millisecond field by mistake.
 */
export interface FieldShiftMetric {
  /** The 75th-percentile layout-shift score. Around 0.1 is good, 0.25 is poor. */
  percentile: number;
  category: PerformanceRating;
}

/**
 * What real visitors actually experienced, from the Chrome UX Report.
 *
 * This is the data Google ranks on. It is the truth about the site, and it is
 * kept strictly apart from the lab data below — a single number labelled
 * "LCP" that could have come from either source would be misleading in a way
 * that is very hard to spot in a client report.
 */
export interface FieldPerformance {
  status: FieldDataStatus;
  /**
   * The address these real-visitor figures belong to, in Google's own words.
   *
   * Read from the field block's own `id` — never from the lab run's final URL.
   * The two normally agree, but they are separate statements by Google about
   * separate measurements, and borrowing one to label the other would be a
   * guess dressed up as a reading.
   *
   * When `scope` is "origin" this is the whole site, not a page.
   * Null when Google's reply does not say.
   */
  measuredUrl: string | null;
  /**
   * Whether these figures describe THIS PAGE or the whole SITE.
   *
   * Google falls back to site-wide data when one page has too little traffic
   * of its own. Reporting that as page data would be wrong, so which one it
   * is gets recorded.
   */
  scope: "page" | "origin" | null;
  /** Google's overall verdict for the address. */
  overall: PerformanceRating | null;
  /** Largest Contentful Paint — when the biggest thing on screen appears. */
  lcp: FieldTimeMetric | null;
  /** Interaction to Next Paint — how quickly the page answers a tap or click. */
  inp: FieldTimeMetric | null;
  /** Cumulative Layout Shift — how much the page jumps about while loading. */
  cls: FieldShiftMetric | null;
  /** First Contentful Paint — when anything at all appears. */
  fcp: FieldTimeMetric | null;
  /** Time to First Byte — when the server started replying. */
  ttfb: FieldTimeMetric | null;
  /** Why the data could not be read, when status is "error". */
  error: string | null;
}

/**
 * One simulated page load in Google's own datacentre.
 *
 * Repeatable and useful for diagnosis, but nobody experienced it. Where the
 * two disagree, the field data above is what matters — this is a laboratory
 * result, not a measurement of the client's actual visitors.
 */
export interface LabPerformance {
  status: "found" | "error";
  /**
   * The address Google's test browser actually loaded.
   *
   * Read from `lighthouseResult.finalUrl`, which is where the simulation ended
   * up after any redirects Google followed and we did not. It describes THIS
   * SECTION only — the field figures above carry their own address.
   *
   * Null when the run produced nothing, or when Google's reply does not say.
   */
  measuredUrl: string | null;
  /** Lighthouse's performance score, 0–100. */
  score: number | null;
  /** Largest Contentful Paint, in milliseconds. */
  lcpMs: number | null;
  /** First Contentful Paint, in milliseconds. */
  fcpMs: number | null;
  /**
   * Total Blocking Time — how long the page was frozen and unable to respond.
   * The lab's stand-in for INP, because a simulation cannot tap anything.
   */
  tbtMs: number | null;
  /** Speed Index — how quickly the page visibly fills in. */
  speedIndexMs: number | null;
  /** Cumulative Layout Shift, as a score rather than a time. */
  cls: number | null;
  /** Why the run could not be read, when status is "error". */
  error: string | null;
}

export interface PerformanceData {
  status: PerformanceStatus;
  /**
   * Which device was simulated. Mobile only for now — it is what Google ranks
   * on, and running both would double the time and quota for a second opinion
   * the client's ranking does not depend on.
   */
  strategy: "mobile";
  /**
   * The address we asked Google to measure.
   *
   * Always the address the rest of this audit is about, so the speed section
   * can be lined up against the others.
   */
  requestedUrl: string;
  /*
   * There is deliberately no `measuredUrl` here.
   *
   * WHY: Google follows redirects we did not. Asked for https://www.bbc.co.uk/
   * it reported on https://www.bbc.com/ — a different domain. But the lab run
   * and the real-visitor figures are separate measurements that Google labels
   * separately, so a single address at this level would inevitably be used to
   * describe both. Each section carries its own `measuredUrl` instead, and
   * `requestedUrl` above is the only address this whole audit asked about.
   */
  /**
   * Why the check failed, in a form code can branch on.
   *
   * `message` says the same thing in English, but nothing later should have to
   * read English to find out that Google timed out rather than replied with
   * nonsense. Null whenever the check succeeded.
   */
  failureReason: PerformanceFailureReason | null;
  field: FieldPerformance;
  lab: LabPerformance;
  /** What this check cannot tell you, so a gap is never read as a result. */
  notInspected: string[];
  /** A plain-language summary for a person reading the report. */
  message: string;
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

  /**
   * Speed and Core Web Vitals, from Google PageSpeed Insights.
   *
   * Always an object, never null: the check is opt-in, so a report has to be
   * able to say WHY there are no numbers here. Its own `status` field
   * separates "nobody asked for it" from "we asked and it failed".
   */
  performance: PerformanceData;
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
   * Checks that could not run on this audit.
   *
   * Sits beside `findings` rather than inside it: a skipped check is never a
   * problem and never a pass. Kept so a report can say what it could not look
   * at, instead of leaving a silent gap that reads as a clean result.
   */
  skippedChecks: SkippedCheck[];

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
/**
 * What POST /api/audit/performance returns.
 *
 * Separate from AuditResponse because the speed check is now its own request.
 * A failed check still answers ok:true with a PerformanceData explaining
 * itself — ok:false is reserved for never reaching the check at all (a bad
 * address, or too many requests).
 */
export type PerformanceResponse =
  | {
      ok: true;
      data: PerformanceData;
      /**
       * The speed rules, graded on the server by the same engine the audit
       * uses. The browser displays these; it never decides a severity, a
       * threshold, or whether a site is slow.
       */
      findings: Finding[];
      /** Speed checks that could not run, kept apart from the findings. */
      skippedChecks: SkippedCheck[];
    }
  | { ok: false; error: string };

/** One crawled page, measured and graded on its own. */
export interface PageAudit {
  /** The address we ended up reading, after any redirects. */
  url: string;
  /**
   * Exactly the same shape a single-page audit produces.
   *
   * Deliberately not a reduced "page summary" type: a reader debugging why a
   * site-level finding named a page needs the measurements behind it, and a
   * second, smaller shape would be a second thing to keep in step.
   */
  data: AuditData;
}

/** Findings that describe the site rather than any one page. */
export interface SiteFindingsSummary {
  /** One finding per rule outcome, each naming the pages it was found on. */
  findings: Finding[];
  /** Checks that could not run somewhere on the site. Never findings. */
  skippedChecks: SkippedCheck[];
  /** How many pages were read and had rules run against them. */
  evaluatedPages: number;
}

/**
 * A whole-site audit.
 *
 * `data` is the ENTRY PAGE, in the exact shape single-page audits have always
 * used, so everything built before crawling reads it unchanged. Everything
 * about the wider site sits beside it rather than replacing it.
 */
export interface SiteAuditResult {
  /** The entry page. The Phase 3 shape, unchanged. */
  data: AuditData;
  /** Findings aggregated across every page the crawl read. */
  site: SiteFindingsSummary;
  /** Every page, individually, for detail and for debugging. */
  pages: PageAudit[];
  /**
   * How the crawl went.
   *
   * Carries `complete` and `stoppedBecause`, which are what stop a crawl that
   * halted at a limit from being read as a whole-site audit. Not a finding and
   * not a severity: a limit we imposed is not a fault of the website.
   */
  crawl: SiteCrawlSummary;
}

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

/** POST /api/audit — the audit has been accepted, not finished. */
export type AuditStartResponse =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

/** GET /api/audit/status */
export type AuditStatusResponse =
  | {
      ok: true;
      jobId: string;
      status: "queued" | "running" | "completed" | "partial";
      progress: JobProgressView;
    }
  | { ok: false; jobId: string; status: "failed"; error: string }
  | { ok: false; error: string };

/** GET /api/audit/result */
export type AuditResultResponse =
  | {
      ok: true;
      jobId: string;
      status: "completed" | "partial";
      result: SiteAuditResult;
    }
  | {
      ok: false;
      jobId: string;
      status: "queued" | "running";
      error: string;
    }
  | { ok: false; jobId: string; status: "failed"; error: string }
  | { ok: false; error: string };

/**
 * What a poll may see about a crawl in flight.
 *
 * Counts only. There is no percentage here because there is no honest
 * denominator: a crawl discovers more of a site as it reads it, so "12 of 40
 * discovered" is a fact and "30% complete" is a guess.
 */
export interface JobProgressView {
  discovered: number;
  queued: number;
  evaluated: number;
  unavailable: number;
  skippedNonHtml: number;
  robotsExcluded: number;
  complete: boolean;
}
