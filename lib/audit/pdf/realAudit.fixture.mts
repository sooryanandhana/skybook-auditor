/**
 * A real audit, run against a site that exists only in this file.
 *
 * WHAT IS REAL HERE, WHICH IS ALMOST EVERYTHING. The crawler is the production
 * crawler: its frontier, its address normalisation, its de-duplication, its
 * robots enforcement, its concurrency and its politeness pacing. The per-page
 * checks are the production checks. All twenty-three audit rules are graded by
 * the production runner, partitioned by the production scope split and
 * aggregated by the production aggregator. What is replaced is the socket.
 *
 * WHY THAT IS THE RIGHT LINE. 7C-6 exists to prove that genuine audit results
 * survive the projection and the renderer. A hand-built `SiteAuditResult`
 * would prove only that a hand-built object survives, and it is the parts
 * nobody hand-builds -- an affected list the aggregator actually produced, a
 * denominator the crawl actually counted, a skipped check a real page actually
 * caused -- that the document has to get right.
 *
 * TWO SEAMS, BOTH ALREADY IN PRODUCTION. `crawl.fetchImpl` and
 * `siteChecksImpl` exist on the audit today, and both carry comments saying
 * they are there so tests reach nothing external. Nothing was added for this.
 *
 * NOTHING HERE REACHES THE NETWORK, asks a model anything, or reads a key.
 */
import { runSiteAudit, type SiteChecks } from "../siteAudit.ts";
import type { fetchPage, FetchPageResult } from "../../collector/fetchPage.ts";
import type { SiteAuditResult } from "../../types.ts";

/** One page of the imaginary site. */
export interface FakePage {
  readonly html: string;
  /** Lowercased response headers, as a real server would send them. */
  readonly headers?: Record<string, string>;
  /** Every Set-Cookie, in full. Values included, because the audit must drop them. */
  readonly setCookieHeaders?: readonly string[];
  readonly servedOverHttps?: boolean;
  readonly statusCode?: number;
  /** When set, the page cannot be read at all and the crawl records the gap. */
  readonly unreadable?: string;
}

export type FakeSite = Readonly<Record<string, FakePage>>;

/**
 * The page fetcher, standing in for the socket and nothing else.
 *
 * It returns what a server returns. It does not decide what the audit makes of
 * it: the same `FetchedPage` shape the real fetcher produces goes into the
 * same checks.
 */
export function fetcherFor(site: FakeSite, asked?: string[]): typeof fetchPage {
  return async (url: string): Promise<FetchPageResult> => {
    asked?.push(url);
    /*
     * Looked up by the address the crawler asks for, which is the address AFTER
     * its own normalisation. That is deliberate: if normalisation ever changed
     * what it produces, these lookups would miss and the tests would fail
     * loudly rather than quietly testing a different site.
     */
    const page = site[url] ?? site[url.replace(/\/$/, "")] ?? site[`${url}/`];

    if (page === undefined || page.unreadable !== undefined) {
      return {
        ok: false,
        reason: page?.unreadable ?? "Not found.",
        uptime: { isOnline: page !== undefined, statusCode: page === undefined ? 404 : 500, serverResponseTimeMs: 12 },
      };
    }

    const servedOverHttps = page.servedOverHttps ?? url.startsWith("https:");

    return {
      ok: true,
      page: {
        finalUrl: url,
        redirectChain: [url],
        html: page.html,
        headers: { "content-type": "text/html; charset=utf-8", ...(page.headers ?? {}) },
        setCookieHeaders: [...(page.setCookieHeaders ?? [])],
        servedOverHttps,
        httpsUnavailable: false,
        contentType: "text/html; charset=utf-8",
        uptime: { isOnline: true, statusCode: page.statusCode ?? 200, serverResponseTimeMs: 12 },
      },
    };
  };
}

/** What the site-level checks would have measured. */
export interface FakeSiteChecks {
  readonly certificateExpired?: boolean;
  /** A lookup that failed. "Could not check" must never become "not there". */
  readonly dnsError?: boolean;
  readonly spfMissing?: boolean;
}

/**
 * The certificate, the DNS records and robots.txt, as measured values.
 *
 * These are the three the audit itself injects for tests, because they are
 * network lookups rather than page reads. The shapes are the production ones,
 * so the production rules grade them.
 */
export function siteChecksFor(options: FakeSiteChecks = {}) {
  /*
   * NO PARAMETERS. The seam's type passes four -- the entry address, whether it
   * was served over HTTPS, the deadline and the robots measurement -- and this
   * stand-in needs none of them: what it returns is fixed by the scenario. A
   * function of fewer arguments is assignable to one of more, so naming them
   * only to ignore them would be four unused variables and nothing gained.
   */
  return async (): Promise<SiteChecks> =>
    ({
      technical: {
        robotsTxtStatus: "found",
        sitemapStatus: "absent",
        robotsBlocksEverything: false,
        sitemapUrl: null,
      },
      ssl: options.certificateExpired
        ? {
            status: "checked",
            hostname: "example.com",
            certificate: {
              issuer: "Example CA",
              subject: "example.com",
              validFrom: "2025-01-01T00:00:00.000Z",
              validTo: "2026-01-01T00:00:00.000Z",
              daysRemaining: -253,
              subjectAltNames: ["example.com"],
            },
            trusted: false,
            problem: "expired",
            failure: null,
            message: "The certificate was read.",
          }
        : {
            status: "not-applicable",
            hostname: "example.com",
            certificate: null,
            trusted: null,
            problem: null,
            failure: null,
            message: "The site is not served over HTTPS.",
          },
      dns: {
        hostname: "example.com",
        emailDomain: "example.com",
        a: { status: "found", records: ["93.184.216.34"], error: null },
        aaaa: { status: "absent", records: [], error: null },
        /*
         * A LOOKUP THAT FAILED, not a record that is absent. The document has
         * to tell those apart: one is a gap in the audit and the other is a
         * finding about the client.
         */
        mx: options.dnsError
          ? { status: "error", records: [], error: "The lookup timed out.", }
          : { status: "found", records: [{ exchange: "mail.example.com", priority: 10 }], error: null },
        ns: { status: "found", records: ["a.iana-servers.net"], error: null },
        txt: { status: "absent", records: [], error: null },
        spf: options.spfMissing
          ? { status: "absent", record: null, error: null }
          : { status: "found", record: "v=spf1 -all", error: null },
        dmarc: {
          status: "absent",
          record: null,
          error: null,
          hostname: "_dmarc.example.com",
          appliesTo: "example.com",
          policyDomain: null,
          inherited: false,
          effectivePolicy: null,
        },
      },
      responseTime: null,
    }) as unknown as SiteChecks;
}

export interface RealAuditOptions {
  readonly requestedUrl?: string;
  readonly site: FakeSite;
  readonly checks?: FakeSiteChecks;
  /** Lowered so a crawl can be made to stop short on purpose. */
  readonly maxPages?: number;
  /**
   * Every address the crawl actually asked the fetcher for, appended here.
   *
   * WHAT IT IS FOR. It is the only place a test can see what the crawl put on
   * the wire, as opposed to what it was given. A credentialed address handed
   * in as the requested URL should never appear in this list, because the
   * crawl's own normalisation strips credentials before anything is fetched --
   * and that is a claim worth checking rather than believing.
   */
  readonly asked?: string[];
}

/**
 * One audit, produced the way the application produces them.
 *
 * Sitemaps are off because this site has none and the discovery attempt would
 * be a fetch of a file the fixture does not describe. Everything else runs.
 */
export async function runRealAudit(options: RealAuditOptions): Promise<SiteAuditResult> {
  return runSiteAudit({
    requestedUrl: options.requestedUrl ?? "https://example.com/",
    crawl: {
      fetchImpl: fetcherFor(options.site, options.asked),
      useSitemaps: false,
      ...(options.maxPages === undefined ? {} : { limits: { maxPages: options.maxPages } }),
    },
    siteChecksImpl: siteChecksFor(options.checks),
  });
}
