/**
 * The shape of our audit data.
 *
 * This file is the contract between every part of the app:
 *   - The Collector (Phase 3) fills these fields with real, measured facts.
 *   - Claude (Phase 5) reads these fields and explains them. It never sees anything else.
 *   - The PDF report (Phase 7) displays these fields.
 *
 * Nothing here is invented at runtime. Every field is either measured or absent.
 */

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

/** Whether the site responded, and how quickly. */
export interface UptimeCheck {
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
   * It measures server responsiveness only. Actual page-load speed comes from
   * the PageSpeed Insights data collected separately.
   *
   * Includes DNS lookup, connection setup, and any redirects along the way.
   * Null if the site never responded.
   */
  serverResponseTimeMs: number | null;
}

/** One complete audit of one website. */
export interface AuditData {
  /** The URL we actually checked (after cleaning up what the user typed). */
  url: string;
  /** When this audit ran, as an ISO date string. */
  checkedAt: string;
  uptime: UptimeCheck;
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
