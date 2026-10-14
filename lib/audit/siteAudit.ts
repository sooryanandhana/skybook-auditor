/**
 * The whole-site audit: crawl, measure, grade, aggregate.
 *
 * This is orchestration and nothing else. Every part it calls already existed
 * and was tested on its own — the crawler, the collectors, the rule engine, the
 * aggregator. Nothing here measures anything, nothing here grades anything, and
 * nothing here decides how serious a finding is. It calls things in order and
 * puts their answers in a box.
 *
 * THE PIPELINE, WHICH RUNS IN EXACTLY THIS DIRECTION
 *
 *   crawl  →  measure each page  →  run the rules on each page  →  aggregate
 *
 * There is no step where anything looks back. A rule never sees another rule's
 * finding, the aggregator never sees a measurement, and no model is asked for
 * an opinion at any point. Claude arrives in Phase 5 to EXPLAIN what this
 * produced; it will not be given a vote on it.
 *
 * ONE ENGINE, NOT TWO. The entry page is measured and graded by the same
 * functions as every other crawled page — the only thing special about it is
 * that the site-level checks (certificate, DNS, robots.txt) are run once from
 * it and shared, because they describe the site rather than any one page.
 */
import { crawlSite, type CrawlProgress, type CrawlResult } from "../collector/crawlSite.ts";
import { dedupKey, normalizeCrawlUrl } from "../collector/crawlUrl.ts";
import { runSeoChecks } from "../collector/seoChecks.ts";
import { runSecurityChecks } from "../collector/securityChecks.ts";
import { logOutcome, sizeBand } from "../log/reliabilityLog.ts";
import { runTechnicalChecks } from "../collector/technicalChecks.ts";
import { measureResponseTime } from "../collector/responseTime.ts";
import type { RobotsMeasurement } from "../collector/robots.ts";
import { runSslChecks, DEFAULT_HTTPS_PORT } from "../collector/sslChecks.ts";
import { runDnsChecks } from "../collector/dnsChecks.ts";
import {
  performanceNotRequested,
  performancePending,
} from "../collector/performanceChecks.ts";
import { normalizeUrl } from "../collector/url.ts";
import { capDeadline, createDeadline, type Deadline } from "../collector/deadline.ts";
import type { FetchedPage } from "../collector/fetchPage.ts";
import { SITE_CHECKS_BUDGET_MS } from "../budgets.ts";
import { runRules } from "../rules/runner.ts";
import { PAGE_RULES, SITE_RULES } from "../rules/all.ts";
import type { SiteFacts } from "../rules/types.ts";
import { aggregateFindings, type PageRuleResult } from "../report/aggregate.ts";
import type {
  AuditData,
  AuditResult,
  CertificateFailureAudit,
  CertificateProblem,
  Finding,
  ResponseTimeMeasurement,
  PageAudit,
  SkippedCheck,
  TechnicalData,
} from "../types";

/** How long a whole site audit may take, crawl included. */
export const SITE_AUDIT_BUDGET_MS = 6 * 60 * 1000;

/** The measurements that describe the site rather than any one page. */
export interface SiteChecks {
  technical: TechnicalData | null;
  ssl: AuditData["ssl"];
  dns: AuditData["dns"];
  /**
   * Three timed requests to the entry address, and their median.
   *
   * SITE-LEVEL FOR THE SAME REASON THE CERTIFICATE IS. It describes the
   * server, not a page, so measuring it per crawled page would be four hundred
   * and fifty requests saying the same thing. Null only when it was never
   * attempted, which the audit's own `timedOut` already explains.
   */
  responseTime: ResponseTimeMeasurement | null;
}

/**
 * Measures the certificate, the DNS records and robots.txt. Once, per audit.
 *
 * These do not change between pages, so measuring them per page would be a
 * hundred and fifty identical answers and a hundred and fifty times the
 * requests. Extracted from the audit body so a test can substitute it.
 */
async function measureSite(
  entryUrl: string,
  servedOverHttps: boolean,
  deadline: Deadline,
  robots: RobotsMeasurement,
): Promise<SiteChecks> {
  const url = new URL(entryUrl);
  // A site on a non-standard port presents its certificate there, not on 443.
  const port = url.port ? Number(url.port) : DEFAULT_HTTPS_PORT;

  let technical: TechnicalData | null = null;
  if (!deadline.expired()) {
    technical = await runTechnicalChecks(entryUrl, robots, deadline);
  }

  const siteDeadline = capDeadline(deadline, SITE_CHECKS_BUDGET_MS);
  /*
   * RUN ALONGSIDE THE OTHERS, NOT AMONG THEM.
   *
   * The certificate and DNS checks share a capped slice of the audit's clock
   * because they are lookups that can hang. The timings are HTTP requests to
   * the site itself, and putting them inside that same slice would mean a slow
   * certificate handshake shortening a measurement of how fast the server
   * answers -- which would make the number describe our budget rather than
   * their server.
   *
   * They share the audit's deadline like everything else, so they cannot run
   * past it, and they are awaited together so three sequential requests do not
   * add their seconds on top of the certificate's.
   */
  const [ssl, dns, responseTime] = await Promise.all([
    runSslChecks(url.hostname, servedOverHttps, siteDeadline, port),
    runDnsChecks(url.hostname, siteDeadline),
    measureResponseTime(entryUrl, { deadline }),
  ]);

  return { technical, ssl, dns, responseTime };
}

export interface SiteAuditOptions {
  requestedUrl: string;
  /**
   * Whether the scheme in `requestedUrl` was one WE assumed, because the person
   * typed a bare host and normalisation added `https://`.
   *
   * It gates the one HTTP fallback this audit allows: an assumed `https://`
   * that could not connect at all may be an HTTP-only site, so the audit retries
   * over HTTP. An `https://` the person typed themselves is never downgraded —
   * the same rule `normalizeUrl` documents — so this stays false for those and
   * for every discovered address. Certificate failures are excluded separately:
   * they are reported from the certificate, never re-fetched over HTTP.
   */
  schemeWasAssumed?: boolean;
  includePerformance?: boolean;
  onProgress?: (progress: CrawlProgress) => void;
  /** Injected by tests so nothing here reaches the network. */
  crawlImpl?: typeof crawlSite;
  /**
   * The site-level measurements: the certificate, the DNS records, robots.txt.
   *
   * Injectable for the same reason the crawl is. Without it these three make
   * real network requests, which makes a unit test slow, flaky, and — worse —
   * unable to control whether a site rule fires. A test that cannot make a
   * site rule fire cannot prove that site rules are evaluated once, because
   * "evaluated once" and "never evaluated" look identical when the answer is
   * silence.
   */
  siteChecksImpl?: (
    entryUrl: string,
    servedOverHttps: boolean,
    deadline: Deadline,
    robots: RobotsMeasurement,
  ) => Promise<SiteChecks>;
  deadline?: Deadline;
  /** Passed through to the crawler untouched. */
  crawl?: Omit<Parameters<typeof crawlSite>[0], "requestedUrl" | "onProgress" | "measurePage" | "onParse" | "onParsed">;
  /** The job this audit runs for. Only labels diagnostic log lines. */
  jobId?: string;
}

/**
 * What the two checks that read a page's markup found, or the error one threw.
 *
 * AN ERROR IS KEPT, NOT THROWN, because of where the measuring now happens.
 * These checks used to run after the crawl; they run during it now, so the
 * markup can be let go. An error thrown there would end the crawl from the
 * inside. Kept here and thrown where the checks used to run, it ends the audit
 * exactly as it always did.
 */
type PageMeasurement =
  | { readonly ok: true; readonly seo: AuditData["seo"]; readonly security: AuditData["security"] }
  | { readonly ok: false; readonly error: unknown };

/** Runs the two checks that need a page's markup. The only readers of it. */
function measurePage(page: FetchedPage): PageMeasurement {
  try {
    return {
      ok: true,
      seo: runSeoChecks(page.html, page.finalUrl),
      security: runSecurityChecks(
        page.headers,
        page.html,
        page.servedOverHttps,
        page.setCookieHeaders,
      ),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * A site audit that could not be produced at all.
 *
 * Only ever the entry page being unreadable: without it there is no site to
 * report on, and inventing one would be inventing measurements. Every OTHER
 * page that cannot be read stays an ordinary unavailable page inside a
 * perfectly good audit.
 */
/**
 * Why no page check ran, when a certificate stopped the entry page's fetch.
 *
 * ONE SENTENCE, ON EVERY PAGE CHECK, so a reader meeting the list of checks
 * that did not run can tell why in one place. It says what happened and
 * stops: it claims nothing about the page, because nobody read it.
 */
export const PAGE_CHECKS_NOT_RUN =
  "The entry page could not be fetched securely, so no page was read for this check.";

export class EntryPageUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EntryPageUnavailableError";
    this.reason = reason;
  }
}

export async function runSiteAudit(options: SiteAuditOptions): Promise<AuditResult> {
  const deadline = options.deadline ?? createDeadline(SITE_AUDIT_BUDGET_MS);
  const crawlImpl = options.crawlImpl ?? crawlSite;

  /*
   * EACH PAGE IS MEASURED AS IT ARRIVES, and the crawl then lets its markup go.
   *
   * The crawl used to hand back every page with its full HTML, and the checks
   * below read it afterwards -- so a 150-page crawl held 150 pages of markup
   * until it ended, and a small server ran out of memory doing it. What the
   * checks produce is small and is what the audit keeps anyway; the markup is
   * needed only long enough to produce it.
   *
   * Keyed by the page object itself, so a result can only ever be read back for
   * the page it was measured from.
   */
  const measured = new WeakMap<FetchedPage, PageMeasurement>();

  const crawl: CrawlResult = await crawlImpl({
    ...options.crawl,
    requestedUrl: options.requestedUrl,
    outerDeadline: deadline,
    onProgress: options.onProgress,
    /*
     * ONE DIAGNOSTIC LINE PER PAGE, written immediately before it is parsed, so
     * that if a page ever exhausts memory the last line says how large it was.
     * The job's short id, the page's place in the crawl and a rounded size --
     * never its address, and never anything on it. A page too large to analyse
     * gets a line saying so instead.
     */
    onParse: ({ order, bytes, tooLarge }) => {
      logOutcome({
        op: "page.parse",
        job: options.jobId,
        outcome: tooLarge ? "skipped" : "parsing",
        reason: tooLarge ? "too-large" : undefined,
        order,
        size: sizeBand(bytes),
      });
    },
    /*
     * AND ONE WHEN IT IS DONE, with how long the parsing and checking took. The
     * gap between two "parsing" lines also holds downloads and waiting; this is
     * the work itself, measured on the monotonic clock.
     */
    onParsed: ({ order, bytes, ms }) => {
      logOutcome({ op: "page.parse", job: options.jobId, outcome: "measured", order, size: sizeBand(bytes), ms });
    },
    measurePage: (page) => {
      measured.set(page, measurePage(page));
    },
  });

  /*
   * The entry page is found by ADDRESS, not by position.
   *
   * With three workers running, pages finish in whatever order the network
   * allows, so `pages[0]` is whichever came back first — not necessarily the
   * one that was asked for.
   */
  const entry = findEntryPage(crawl, options.requestedUrl);
  if (entry === null) {
    const failure = entryFailure(crawl, options.requestedUrl);

    /*
     * A FAILED CERTIFICATE IS A MEASUREMENT, NOT AN ABSENCE.
     *
     * When the entry page could not be fetched because the certificate
     * offered for it failed, the thing that stopped the audit is itself the
     * finding -- and the certificate can still be read, because the
     * certificate check connects without trusting what it is given. So the
     * audit goes on with the checks that need no page, and says plainly that
     * it has nothing else.
     *
     * ONLY WHEN NOTHING WAS READ. A crawl that reached other pages has an
     * audit of those pages to report, which is a different thing from this
     * and is not quietly turned into it.
     */
    const certificateProblem = failure.certificateProblem;
    if (certificateProblem !== undefined && crawl.pages.length === 0) {
      return certificateFailureAudit(options, crawl, failure, certificateProblem, deadline);
    }

    /*
     * AN ASSUMED https:// THAT COULD NOT CONNECT MAY BE AN HTTP-ONLY SITE.
     *
     * When WE added the scheme (the person typed a bare host) and the entry's
     * HTTPS attempt did not connect at all -- not a certificate failure, which
     * is the certificate-only report above, and not a server that answered with
     * an error -- the site may simply not serve HTTPS. So the audit is retried
     * over HTTP, seeded at the same host, and produces an ordinary report that
     * grades the missing HTTPS as the Critical finding it is.
     *
     * The retry passes schemeWasAssumed: false, so an HTTP attempt that also
     * fails is reported as unavailable rather than looping. An https:// the
     * person typed themselves has schemeWasAssumed false and never reaches here,
     * so an explicit security choice is never silently downgraded. The HTTP
     * fetch goes through the same per-hop safety check as every other request.
     */
    const httpUrl =
      options.schemeWasAssumed === true &&
      !failure.serverResponded &&
      certificateProblem === undefined &&
      crawl.pages.length === 0
        ? toHttpUrl(options.requestedUrl)
        : null;
    if (httpUrl !== null) {
      return runSiteAudit({ ...options, requestedUrl: httpUrl, schemeWasAssumed: false });
    }

    throw new EntryPageUnavailableError(failure.reason);
  }

  /*
   * Site-level measurements, taken ONCE.
   *
   * A certificate, a domain's DNS records and a robots.txt do not change
   * between pages. Measuring them per page would be a hundred and fifty
   * identical answers and a hundred and fifty times the requests.
   */
  const { technical, ssl, dns, responseTime } = await (options.siteChecksImpl ?? measureSite)(
    entry.finalUrl,
    entry.servedOverHttps,
    deadline,
    // The crawler already read robots.txt. Handing its measurement on is what
    // keeps one audit from holding two answers about the same file.
    crawl.robots,
  );

  const normalized = normalizeUrl(options.requestedUrl);
  const requestedUrl = normalized.ok ? normalized.url.toString() : options.requestedUrl;
  const checkedAt = new Date().toISOString();

  const shared = {
    website: { requestedUrl, checkedAt },
    technical,
    ssl,
    dns,
    /*
     * Measured once, carried onto every page's facts unchanged.
     *
     * The same value on all of them, deliberately: it describes the server,
     * and a per-page copy would invite somebody to average it later.
     */
    responseTime,
    hosting: null,
    timedOut: technical === null,
  };

  /*
   * Every page measured and graded, using the same functions for all of them.
   *
   * `crawl.pages` holds ONLY pages that were read as HTML. A page that timed
   * out, answered with a PDF, or that robots.txt kept us away from is not in
   * it — so none of them can arrive here and be graded as though it were
   * fine. That exclusion is structural: there is no filter to forget.
   */
  const pageAudits: PageAudit[] = [];
  const pageResults: PageRuleResult[] = [];

  for (const page of crawl.pages) {
    const performance = options.includePerformance
      ? performancePending(page.finalUrl)
      : performanceNotRequested(page.finalUrl);

    /*
     * What was measured when the page was read. A crawl that did not measure
     * as it went -- a substitute handed in by a test -- still has the markup,
     * so it is measured here, as it always was. An error from either place is
     * thrown here, where it always was.
     */
    const measurement = measured.get(page) ?? measurePage(page);
    if (!measurement.ok) throw measurement.error;

    const facts: AuditData = {
      ...shared,
      fetch: {
        finalUrl: page.finalUrl,
        redirectChain: page.redirectChain,
        wasRedirected: page.redirectChain.length > 1,
        servedOverHttps: page.servedOverHttps,
        httpsUnavailable: page.httpsUnavailable,
        certificateProblem: page.certificateProblem ?? null,
        contentType: page.contentType,
      },
      uptime: page.uptime,
      seo: measurement.seo,
      security: measurement.security,
      performance,
      // Filled in immediately below, from the very same facts.
      findings: [],
      skippedChecks: [],
    };

    /*
     * ONLY THE PAGE RULES RUN HERE, once per page.
     *
     * The site rules are evaluated once, below, against the same shared facts.
     * Running them here as well would measure one certificate a hundred and
     * twenty-eight times and then need de-duplicating afterwards — and the
     * duplication, not its display, is the thing that was wrong.
     *
     * The rules read measurements only. `findings` is empty at the moment they
     * run, so a rule has no way to see another rule's output even by accident —
     * the same guarantee the single-page audit has always had.
     */
    const graded = runRules(facts, PAGE_RULES);
    facts.findings = graded.findings;
    facts.skippedChecks = graded.skipped;

    pageAudits.push({ url: page.finalUrl, data: facts });
    pageResults.push({
      url: page.finalUrl,
      findings: graded.findings,
      skipped: graded.skipped,
    });
  }

  /*
   * The rule ids are passed so the denominator is exact.
   *
   * Without them the aggregator can only count pages where a rule SAID
   * something, which undercounts rules that ran quietly — and an undercounted
   * denominator makes a problem look worse than it was measured to be.
   */
  /*
   * The site rules, evaluated ONCE against the site's own measurements.
   *
   * The facts object handed over is the entry page's, but the only parts these
   * rules read are the shared, site-level ones — the certificate, the DNS
   * records, robots.txt. Each of those was measured a single time above.
   */
  const siteGraded =
    pageAudits.length > 0
      ? runRules(pageAudits[0].data, SITE_RULES)
      : { findings: [], skipped: [], ran: [] };

  const site = aggregateFindings(pageResults, {
    // Page rules only: the denominator is a count of PAGES, and a site rule
    // has no place in it.
    ruleIds: PAGE_RULES.map((rule) => rule.id),
    site: {
      siteUrl: new URL(entry.finalUrl).origin,
      findings: siteGraded.findings,
      skipped: siteGraded.skipped,
    },
  });

  const entryAudit = pageAudits.find((audit) => audit.url === entry.finalUrl);

  /*
   * The entry page keeps the complete Phase 3 report.
   *
   * A single-page audit has always listed both kinds of finding together, and
   * still does: the site findings evaluated once above are merged in here
   * rather than re-evaluated, so the entry page's `data` is unchanged in shape
   * and content while the site rules have still only run once.
   */
  const entryData = entryAudit?.data ?? pageAudits[0].data;
  const entryWithSite: AuditData = {
    ...entryData,
    findings: sortFindings([...entryData.findings, ...siteGraded.findings]),
    skippedChecks: [...entryData.skippedChecks, ...siteGraded.skipped],
  };

  return {
    // The Phase 3 shape, unchanged, for the entry page. Everything written
    // before full-site crawling reads this exactly as it always did.
    data: entryWithSite,
    site: {
      findings: site.findings,
      skippedChecks: site.skipped,
      // The authoritative ran-ledger the scorer reads: the page rules that ran
      // across the crawl (from the aggregator) UNION the site rules that ran once
      // above. Without the site half, a site rule that ran and passed quietly
      // would be absent from the ledger and, once the scorer treats an absent
      // expected rule as skipped rather than passed, be miscounted.
      ranRules: mergeRanLedger(site.ran, siteGraded.ran),
      evaluatedPages: site.evaluatedPages,
    },
    pages: pageAudits,
    crawl: crawl.summary,
  };
}

/**
 * The audit of a site whose entry page could not be fetched securely.
 *
 * IT MEASURES WHAT DOES NOT NEED A PAGE: the certificate, the domain's
 * records, and robots.txt as far as it could be read. The same site-level
 * function a whole-site audit uses measures them, from the address that
 * actually presented the failing certificate -- which is the address the
 * entry page redirected to, when it redirected before failing.
 *
 * WHAT IT DID NOT MEASURE IS SAID, NOT LEFT OUT. Every page-scoped rule is
 * listed as a check that did not run, with its reason. Left out, their
 * silence would read as a page that passed them.
 *
 * NOTHING HERE IS INVENTED. There is no `data`: `AuditData` describes a page
 * and no page was read. The response time the site checks measure is
 * deliberately not carried, because its vocabulary cannot tell a refused
 * certificate from a server that never answered, and "the server could not
 * be reached" would be false about a server that answered the handshake.
 */
async function certificateFailureAudit(
  options: SiteAuditOptions,
  crawl: CrawlResult,
  failure: EntryFailure,
  certificateProblem: CertificateProblem,
  deadline: Deadline,
): Promise<CertificateFailureAudit> {
  const normalized = normalizeUrl(options.requestedUrl);
  const requestedUrl = normalized.ok ? normalized.url.toString() : options.requestedUrl;
  const failedUrl = failure.certificateUrl ?? requestedUrl;

  const { technical, ssl, dns } = await (options.siteChecksImpl ?? measureSite)(
    failedUrl,
    // The address that failed is an HTTPS one -- having a certificate to fail
    // is what that means -- so the certificate check applies to it.
    new URL(failedUrl).protocol === "https:",
    deadline,
    crawl.robots,
  );

  /*
   * THE SITE RULES, ON THE SITE'S OWN FACTS. They read the certificate, the
   * domain records and robots.txt and nothing else, which their fact type
   * declares -- so they can be graded here, where there is no page, with
   * nothing made up to satisfy a signature.
   */
  const siteFacts: SiteFacts = { ssl, dns, technical };
  const graded = runRules(siteFacts, SITE_RULES);

  const site = aggregateFindings([], {
    site: {
      siteUrl: new URL(failedUrl).origin,
      findings: graded.findings,
      skipped: [...graded.skipped, ...pageChecksNotRun()],
    },
  });

  return {
    kind: "certificate-failure",
    website: { requestedUrl, checkedAt: new Date().toISOString() },
    failedUrl,
    reason: failure.reason,
    certificateProblem,
    ssl,
    dns,
    technical,
    site: {
      findings: site.findings,
      skippedChecks: site.skipped,
      // No page was read, so no page-scoped rule ran (`site.ran` is empty here);
      // the ledger is the SITE rules that ran once against the certificate, DNS
      // and robots facts. It must still be recorded, so the scorer can tell a
      // site rule that ran and passed from one that never ran at all.
      ranRules: mergeRanLedger(site.ran, graded.ran),
      evaluatedPages: 0,
    },
    crawl: crawl.summary,
  };
}

/** Every page-scoped check, listed as one that did not run, with the reason. */
function pageChecksNotRun(): SkippedCheck[] {
  return PAGE_RULES.map((rule) => ({ ruleId: rule.id, reason: PAGE_CHECKS_NOT_RUN }));
}

/**
 * The one ran-ledger the scorer reads: page rules that ran across the crawl,
 * plus the site rules that ran once. De-duplicated and sorted so the result is
 * deterministic, and each list already holds only ids of rules that reached a
 * verdict — a skipped or thrown rule is in neither, so nothing here can mark one
 * as having run.
 */
function mergeRanLedger(pageRan: readonly string[], siteRan: readonly string[]): string[] {
  return [...new Set([...pageRan, ...siteRan])].sort();
}

/**
 * Worst first, then by rule id — exactly the order the rule runner uses.
 *
 * Needed here because this list is assembled from two separate runs: the page
 * rules and the site rules. The comparison is the runner's own, so a reader
 * meets a merged list in the order they meet any other.
 */
function sortFindings(findings: Finding[]): Finding[] {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, good: 3 };
  return [...findings].sort((a, b) => {
    const bySeverity = order[a.severity] - order[b.severity];
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });
}

/**
 * The page the audit was actually asked about.
 *
 * Matched on the canonical key so `https://example.com` finds the page fetched
 * as `https://example.com/`. The final address is checked too, because the
 * entry page is entitled to redirect.
 */
/**
 * The same address over http, or null when it is not an https address.
 *
 * Only ever used to retry an assumed-https entry that could not connect. It
 * changes the scheme and nothing else, and refuses anything that is not https
 * so it can never turn some other address into an http one.
 */
function toHttpUrl(requestedUrl: string): string | null {
  try {
    const url = new URL(requestedUrl);
    if (url.protocol !== "https:") return null;
    url.protocol = "http:";
    return url.toString();
  } catch {
    return null;
  }
}

function findEntryPage(crawl: CrawlResult, requestedUrl: string): FetchedPage | null {
  const seed = normalizeCrawlUrl(requestedUrl, requestedUrl);
  if (!seed.ok) return null;

  const wanted = seed.key;

  for (const page of crawl.pages) {
    for (const address of [page.redirectChain[0], page.finalUrl]) {
      const resolved = normalizeCrawlUrl(address, address);
      if (resolved.ok && resolved.key === wanted) return page;
    }
  }

  return null;
}

/** Why the entry page produced nothing, and what the fetcher made of it. */
interface EntryFailure {
  /** The collector's own sentence. */
  reason: string;
  /**
   * Whether the server answered before the entry fetch failed.
   *
   * Defaults to true, so the HTTP fallback is taken only when a connection
   * failure is PROVEN — a served error, a non-HTML answer, or a failure we
   * cannot classify all leave this true and are never downgraded to HTTP.
   */
  serverResponded: boolean;
  /** Set when a certificate is what stopped it. The fetcher classified it. */
  certificateProblem?: CertificateProblem;
  /** The address that presented that certificate. */
  certificateUrl?: string;
}

/**
 * Why the entry page produced nothing, in the collector's own words.
 *
 * The crawler already recorded a reason; this finds it rather than composing
 * a new sentence, so the person is told what actually happened. The fetcher's
 * own classification travels with it, so a caller deciding what to do about a
 * certificate failure matches on a value and never on the sentence.
 */
function entryFailure(crawl: CrawlResult, requestedUrl: string): EntryFailure {
  const seed = normalizeCrawlUrl(requestedUrl, requestedUrl);

  if (seed.ok) {
    const wanted = seed.key;
    for (const attempt of crawl.attempts) {
      const resolved = normalizeCrawlUrl(attempt.url, attempt.url);
      if (!resolved.ok || resolved.key !== wanted) continue;
      // The server answered with something that is not a page, so it is up.
      if (attempt.outcome === "non-html") return { reason: attempt.reason, serverResponded: true };
      if (attempt.outcome === "unavailable") {
        return {
          reason: attempt.reason,
          serverResponded: attempt.serverResponded,
          certificateProblem: attempt.certificateProblem,
          certificateUrl: attempt.certificateUrl,
        };
      }
    }
    for (const failure of crawl.summary.unavailable) {
      const resolved = normalizeCrawlUrl(failure.url, failure.url);
      // The frontier's summary keeps only a sentence, so whether the server
      // answered cannot be proven here; the safe default is "it did".
      if (resolved.ok && dedupKey(resolved.url) === wanted) return { reason: failure.reason, serverResponded: true };
    }
  }

  // Nothing was attempted at all — robots.txt refused it, or the crawl ran out
  // of time before it began. Said plainly, without guessing which.
  return {
    reason: "That page could not be checked, so there is nothing to report on.",
    serverResponded: true,
  };
}
