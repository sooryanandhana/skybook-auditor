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
  technical: TechnicalData;

  /** Speed / Core Web Vitals. Module not built yet. */
  performance: NotYetImplemented;
  /** Security headers and mixed content. Module not built yet. */
  security: NotYetImplemented;
  /** Certificate inspection. Module not built yet — see fetch.certificateProblem. */
  ssl: NotYetImplemented;
  /** Domain record lookups. Module not built yet. */
  dns: NotYetImplemented;
  /** Hosting/CDN detection. Module not built yet. */
  hosting: NotYetImplemented;

  /**
   * Graded issues derived from the measurements above by fixed rules.
   * Empty until the severity-rules module is built.
   */
  findings: Finding[];
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
  | { ok: false; error: string; uptime?: UptimeCheck };
