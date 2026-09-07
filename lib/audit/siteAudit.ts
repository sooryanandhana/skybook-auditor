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
import { runTechnicalChecks } from "../collector/technicalChecks.ts";
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
import { aggregateFindings, type PageRuleResult } from "../report/aggregate.ts";
import type {
  AuditData,
  Finding,
  PageAudit,
  SiteAuditResult,
  TechnicalData,
} from "../types";

/** How long a whole site audit may take, crawl included. */
export const SITE_AUDIT_BUDGET_MS = 6 * 60 * 1000;

/** The three measurements that describe the site rather than any one page. */
export interface SiteChecks {
  technical: TechnicalData | null;
  ssl: AuditData["ssl"];
  dns: AuditData["dns"];
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
  const [ssl, dns] = await Promise.all([
    runSslChecks(url.hostname, servedOverHttps, siteDeadline, port),
    runDnsChecks(url.hostname, siteDeadline),
  ]);

  return { technical, ssl, dns };
}

export interface SiteAuditOptions {
  requestedUrl: string;
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
  crawl?: Omit<Parameters<typeof crawlSite>[0], "requestedUrl" | "onProgress">;
}

/**
 * A site audit that could not be produced at all.
 *
 * Only ever the entry page being unreadable: without it there is no site to
 * report on, and inventing one would be inventing measurements. Every OTHER
 * page that cannot be read stays an ordinary unavailable page inside a
 * perfectly good audit.
 */
export class EntryPageUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EntryPageUnavailableError";
    this.reason = reason;
  }
}

export async function runSiteAudit(options: SiteAuditOptions): Promise<SiteAuditResult> {
  const deadline = options.deadline ?? createDeadline(SITE_AUDIT_BUDGET_MS);
  const crawlImpl = options.crawlImpl ?? crawlSite;

  const crawl: CrawlResult = await crawlImpl({
    ...options.crawl,
    requestedUrl: options.requestedUrl,
    outerDeadline: deadline,
    onProgress: options.onProgress,
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
    throw new EntryPageUnavailableError(entryFailureReason(crawl, options.requestedUrl));
  }

  /*
   * Site-level measurements, taken ONCE.
   *
   * A certificate, a domain's DNS records and a robots.txt do not change
   * between pages. Measuring them per page would be a hundred and fifty
   * identical answers and a hundred and fifty times the requests.
   */
  const { technical, ssl, dns } = await (options.siteChecksImpl ?? measureSite)(
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
      seo: runSeoChecks(page.html, page.finalUrl),
      security: runSecurityChecks(
        page.headers,
        page.html,
        page.servedOverHttps,
        page.setCookieHeaders,
      ),
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
      : { findings: [], skipped: [] };

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
      evaluatedPages: site.evaluatedPages,
    },
    pages: pageAudits,
    crawl: crawl.summary,
  };
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

/**
 * Why the entry page produced nothing, in the collector's own words.
 *
 * The crawler already recorded a reason; this finds it rather than composing a
 * new sentence, so the person is told what actually happened.
 */
function entryFailureReason(crawl: CrawlResult, requestedUrl: string): string {
  const seed = normalizeCrawlUrl(requestedUrl, requestedUrl);

  if (seed.ok) {
    const wanted = seed.key;
    for (const attempt of crawl.attempts) {
      const resolved = normalizeCrawlUrl(attempt.url, attempt.url);
      if (!resolved.ok || resolved.key !== wanted) continue;
      if (attempt.outcome === "unavailable" || attempt.outcome === "non-html") {
        return attempt.reason;
      }
    }
    for (const failure of crawl.summary.unavailable) {
      const resolved = normalizeCrawlUrl(failure.url, failure.url);
      if (resolved.ok && dedupKey(resolved.url) === wanted) return failure.reason;
    }
  }

  // Nothing was attempted at all — robots.txt refused it, or the crawl ran out
  // of time before it began. Said plainly, without guessing which.
  return "That page could not be checked, so there is nothing to report on.";
}
