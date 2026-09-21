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
 * THREE SEAMS, ALL ALREADY IN PRODUCTION. `crawl.fetchImpl` answers for pages,
 * `crawl.sitemapFetchImpl` for robots.txt and sitemaps, and `siteChecksImpl`
 * for the certificate, the DNS records and the site-level technical summary.
 * Nothing was added to the application for this.
 *
 * THE MIDDLE SEAM WAS ONCE MISSING, AND NOTHING NOTICED. With no
 * `sitemapFetchImpl` the crawl reads robots.txt with the production fetcher,
 * which resolves the host through DNS and then makes the request. Offline that
 * failed quietly and became "robots.txt unavailable"; online it went to the
 * real example.com. Both passed. So the network is now not merely unused but
 * unplugged: `runRealAudit` runs inside `withNetworkUnplugged`, and any attempt
 * to resolve a name, open a connection or make a request fails the call.
 *
 * NOTHING HERE REACHES THE NETWORK, asks a model anything, or reads a key.
 */
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls, { type PeerCertificate } from "node:tls";

import { runSiteAudit, type SiteChecks } from "../siteAudit.ts";
import type { fetchPage, FetchPageResult } from "../../collector/fetchPage.ts";
import type { SitemapFetcher } from "../../collector/sitemap.ts";
import { classifyAuthorizationError, describeCertificate } from "../../collector/sslChecks.ts";
import { isCertificateFailureAudit } from "../../report/siteFindingsView.ts";
import type {
  AuditResult,
  CertificateFailureAudit,
  CertificateProblem,
  SiteAuditResult,
  SslData,
} from "../../types.ts";

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
  /**
   * When set, what stopped it was the certificate.
   *
   * The fetcher then answers as the real one does for a refused certificate:
   * the collector's sentence, the classified problem, and the address that
   * presented it. Nothing responded, so there is no uptime to report.
   */
  readonly certificateProblem?: CertificateProblem;
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

    if (page?.certificateProblem !== undefined) {
      return {
        ok: false,
        reason: page.unreadable ?? "The website's security certificate has expired.",
        certificateProblem: page.certificateProblem,
        certificateUrl: url,
        // Nothing answered, so there is nothing to say about uptime.
        uptime: null,
      };
    }

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

/**
 * The robots.txt this imaginary site serves: present, and permitting every
 * crawler.
 *
 * It is the same file `siteChecksFor` reports at site level — found, blocking
 * nothing. In production the crawl's reading of robots.txt is handed to the
 * site-level check, so the two can never disagree; a fixture that let them
 * disagree would be testing a site that cannot exist.
 */
export const FIXTURE_ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/**
 * The fetcher for robots.txt and sitemaps, standing in for the socket.
 *
 * robots.txt answers with the file above and goes through the production
 * parser and the production enforcement. Any other file — a sitemap — is
 * absent: a real answer, given without a request.
 */
export function siteFilesFor(): SitemapFetcher {
  return async (url) =>
    new URL(url).pathname === "/robots.txt"
      ? { ok: true, body: FIXTURE_ROBOTS_TXT }
      : { ok: false, reason: "absent" };
}

/** What the site-level checks would have measured. */
export interface FakeSiteChecks {
  readonly certificateExpired?: boolean;
  /** A lookup that failed. "Could not check" must never become "not there". */
  readonly dnsError?: boolean;
  readonly spfMissing?: boolean;
}

/**
 * When the fixture's certificate is judged.
 *
 * Fixed, so the certificate is always exactly 253 days past its expiry and a
 * test can quote the day count the rule reports. With the real clock the count
 * would grow by one every day.
 */
export const FIXTURE_CERTIFICATE_CHECKED_AT = new Date("2026-09-11T00:00:00.000Z");

/**
 * An expired certificate, as the TLS layer describes one and as the production
 * collector turns it into facts.
 *
 * BUILT BY `describeCertificate`, NOT WRITTEN OUT. The facts the certificate
 * rules read — days until expiry, whether the certificate covers the host — are
 * computed by the collector, so a hand-written object can silently lack them.
 * This one used to: it carried a `daysRemaining` the type has never had, behind
 * an `as unknown as` cast, so the expired-certificate rule could not fire.
 */
function expiredCertificate(): SslData {
  const issuer = { C: "US", ST: "", L: "", O: "Example CA", OU: "", CN: "Example CA" };
  const subject = { C: "US", ST: "", L: "", O: "Example Company", OU: "", CN: "example.com" };
  const peer: Partial<PeerCertificate> = {
    valid_from: "Jan  1 00:00:00 2025 GMT",
    valid_to: "Jan  1 00:00:00 2026 GMT",
    subjectaltname: "DNS:example.com",
    issuer,
    subject,
  };

  return {
    status: "checked",
    hostname: "example.com",
    certificate: describeCertificate(peer, "example.com", "TLSv1.3", FIXTURE_CERTIFICATE_CHECKED_AT),
    trusted: false,
    problem: classifyAuthorizationError("CERT_HAS_EXPIRED"),
    failure: null,
    message: "The certificate was read.",
  };
}

/**
 * The certificate, the DNS records and the site-level technical summary, as
 * measured values.
 *
 * These are the site-level lookups the audit injects for tests. The shapes are
 * the production ones — checked by the compiler rather than asserted with a
 * cast — so the production rules grade them.
 */
export function siteChecksFor(options: FakeSiteChecks = {}) {
  /*
   * NO PARAMETERS. The seam's type passes four -- the entry address, whether it
   * was served over HTTPS, the deadline and the robots measurement -- and this
   * stand-in needs none of them: what it returns is fixed by the scenario. A
   * function of fewer arguments is assignable to one of more, so naming them
   * only to ignore them would be four unused variables and nothing gained.
   */
  return async (): Promise<SiteChecks> => ({
    technical: {
      robotsTxtStatus: "found",
      sitemapStatus: "absent",
      robotsBlocksEverything: false,
      sitemapUrl: null,
    },
    ssl: options.certificateExpired
      ? expiredCertificate()
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
        ? { status: "error", records: [], error: "The lookup timed out." }
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
  });
}

// ---------------------------------------------------------------------------
// The network, unplugged
// ---------------------------------------------------------------------------

/** One unplugging, shared by any calls that overlap, and restored when the last one ends. */
interface Unplugged {
  depth: number;
  readonly attempts: string[];
  readonly restore: () => void;
}

let unplugged: Unplugged | null = null;

/** The error every refused attempt fails with, so the code under test sees an ordinary failure. */
function refusal(attempt: string): Error {
  return Object.assign(new Error(`realAudit fixture: ${attempt} with the network unplugged`), { code: "ENOTFOUND" });
}

function unplug(): Unplugged {
  if (unplugged !== null) {
    unplugged.depth += 1;
    return unplugged;
  }

  const attempts: string[] = [];
  const replaced: Array<[object, string, unknown]> = [];
  const replace = (owner: object, key: string, stand_in: unknown) => {
    replaced.push([owner, key, Reflect.get(owner, key)]);
    Reflect.set(owner, key, stand_in);
  };

  /*
   * EVERY DOOR, NOT ONLY THE ONE THAT WAS OPEN. The address check resolves
   * through `dns/promises`; sockets and TLS resolve through the callback
   * lookup; the DNS collector uses a Resolver; pages and files are requested
   * with fetch; the certificate check opens a TLS connection. Each records the
   * attempt and refuses it.
   */
  replace(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    attempts.push(`a request to ${address}`);
    throw refusal(`a request to ${address}`);
  });
  replace(dns.promises, "lookup", async (hostname: string) => {
    attempts.push(`a DNS lookup of ${hostname}`);
    throw refusal(`a DNS lookup of ${hostname}`);
  });
  replace(dns, "lookup", (hostname: string, ...rest: unknown[]) => {
    attempts.push(`a DNS lookup of ${hostname}`);
    const callback = rest.find((argument) => typeof argument === "function");
    if (typeof callback === "function") process.nextTick(callback, refusal(`a DNS lookup of ${hostname}`));
  });
  for (const resolver of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const method of ["resolve", "resolve4", "resolve6", "resolveMx", "resolveNs", "resolveTxt", "resolveAny", "resolveCname"]) {
      replace(resolver, method, (hostname: string) => {
        attempts.push(`a DNS ${method} of ${hostname}`);
        throw refusal(`a DNS ${method} of ${hostname}`);
      });
    }
  }
  for (const [owner, method] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]] as const) {
    replace(owner, method, () => {
      attempts.push(`a ${method === "connect" && owner === tls ? "TLS" : "TCP"} connection`);
      throw refusal("a connection");
    });
  }
  syncBuiltinESMExports();

  unplugged = {
    depth: 1,
    attempts,
    restore: () => {
      for (const [owner, key, original] of replaced.reverse()) Reflect.set(owner, key, original);
      syncBuiltinESMExports();
    },
  };
  return unplugged;
}

/**
 * Runs `work` with the network unplugged, and fails if anything reached for it.
 *
 * REFUSING IS NOT ENOUGH ON ITS OWN. Production code turns a failed lookup or a
 * refused request into an "unavailable" measurement and carries on — which is
 * exactly how the robots.txt read went unnoticed. So every attempt is also
 * written down, and once the work has finished a non-empty record fails the
 * call, whatever the work itself made of the refusal.
 */
export async function withNetworkUnplugged<T>(work: () => Promise<T>): Promise<T> {
  const state = unplug();
  const from = state.attempts.length;

  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await work() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const attempted = state.attempts.slice(from);
  state.depth -= 1;
  if (state.depth === 0) {
    state.restore();
    unplugged = null;
  }

  // A network attempt outranks whatever the work returned or threw: it means
  // the test proved nothing about an offline audit.
  if (attempted.length > 0) {
    throw new Error(`realAudit fixture: the audit reached for the network: ${attempted.join("; ")}`);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
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
 * One audit, produced the way the application produces them, with the network
 * unplugged.
 *
 * Sitemap discovery is off because this site has none. robots.txt is read, from
 * `siteFilesFor`, through the production parser and enforcement. Everything
 * else runs.
 */
export async function runRealAudit(options: RealAuditOptions): Promise<SiteAuditResult> {
  const audit = await runRealAuditOutcome(options);

  /*
   * The suites built on this one audit a site whose entry page was read. An
   * audit that could not read one has a different shape and different
   * questions; `runRealCertificateFailure` below is for those, so a silent
   * swap between them cannot happen here.
   */
  if (isCertificateFailureAudit(audit)) {
    throw new Error("realAudit fixture: the entry page was not read; use runRealCertificateFailure");
  }
  return audit;
}

/** The same audit, whichever kind of result it produced. */
export async function runRealAuditOutcome(options: RealAuditOptions): Promise<AuditResult> {
  return withNetworkUnplugged(() =>
    runSiteAudit({
      requestedUrl: options.requestedUrl ?? "https://example.com/",
      crawl: {
        fetchImpl: fetcherFor(options.site, options.asked),
        sitemapFetchImpl: siteFilesFor(),
        useSitemaps: false,
        ...(options.maxPages === undefined ? {} : { limits: { maxPages: options.maxPages } }),
      },
      siteChecksImpl: siteChecksFor(options.checks),
    }),
  );
}

/**
 * One audit of a site whose entry page could not be fetched securely.
 *
 * The same production path as every other audit here: the crawl asks the
 * fetcher, the fetcher refuses with a classified certificate problem, and
 * the audit does what it does with that. Asserting the kind here is what
 * stops a test about a partial report quietly passing on a whole-site one.
 */
export async function runRealCertificateFailure(
  options: RealAuditOptions,
): Promise<CertificateFailureAudit> {
  const audit = await runRealAuditOutcome(options);
  if (!isCertificateFailureAudit(audit)) {
    throw new Error("realAudit fixture: expected an audit whose entry page could not be fetched");
  }
  return audit;
}
