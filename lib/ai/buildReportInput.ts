/**
 * Turning a finished audit into the only thing an AI provider ever sees.
 *
 * THIS FILE IS A WHITELIST. Every field that crosses the boundary is named
 * here, one at a time, by hand. There is no spread of an audit object anywhere
 * in it, and there must never be one.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS
 *
 * `return { ...auditResult }` fails open. The day somebody adds a field to
 * `AuditData` for debugging, that field is in a prompt, in a provider's logs,
 * and possibly in a client's report, and nobody had to decide it should be. An
 * explicit build fails closed instead: the new field simply does not appear,
 * and if it SHOULD appear, the type system says so at the point somebody
 * widened the contract on purpose.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It does not measure, and it does not grade. Severity, evidence, remediation,
 * counts, denominators and the completeness verdict all arrive already
 * decided; this copies them. The only arithmetic here is picking the limit
 * that stopped the crawl out of the limits the crawl was given, and comparing
 * a sample's length with a count that was measured elsewhere. Neither can
 * change what the audit found.
 *
 * WHAT IT DOES DO
 *
 * It normalises the engine's many ways of saying "we do not know" into a
 * single field a reader must consult first, WITHOUT losing which way it was
 * said. See `AIMeasurement` in `contract.ts`.
 */
import {
  AI_CONTRACT_VERSION,
  MAX_DECLARED_URL_LENGTH,
  MAX_EVIDENCE_LENGTH,
  MAX_LIST_ITEMS,
  MAX_SAMPLE_URL_LENGTH,
  MAX_SAMPLE_URLS,
  MAX_TEXT_LENGTH,
  type AIMeasurement,
  type AIReportCertificate,
  type AIReportCookies,
  type AIReportCoverage,
  type AIReportDmarc,
  type AIReportDnsMeasurements,
  type AIReportEmailMeasurements,
  type AIReportFieldPerformance,
  type AIReportFinding,
  type AIReportHeaderPresence,
  type AIReportHsts,
  type AIReportInput,
  type AIReportLabPerformance,
  type AIReportLimit,
  type AIReportMailRouting,
  type AIReportMixedContent,
  type AIReportPageMeasurements,
  type AIReportPerformance,
  type AIReportRecordCount,
  type AIReportReach,
  type AIReportRobotsFile,
  type AIReportSecurityMeasurements,
  type AIReportSiteContext,
  type AIReportSiteFileMeasurements,
  type AIReportSitemapFile,
  type AIReportSkipped,
  type AIReportTimeMetric,
  type AIReportShiftMetric,
  type AIText,
  type AIUnknownState,
} from "./contract.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import { withoutCredentials } from "../collector/url.ts";
import type {
  AuditData,
  MxRecord,
  DnsRecordSet,
  EmailPolicyRecord,
  FieldPerformance,
  Finding,
  LabPerformance,
  PerformanceData,
  SecurityData,
  SecurityHeader,
  SeoData,
  SiteAuditResult,
  SkippedCheck,
  SslData,
  TechnicalData,
} from "../types";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Carries a string across the boundary with any cut made visible.
 *
 * `originalLength` is measured before the cut, so nothing downstream has to
 * guess how long the real value was — and a report can still say a title is
 * far too long without carrying the whole of it.
 */
function clamp(value: string, limit: number): AIText {
  return {
    text: value.length > limit ? value.slice(0, limit) : value,
    truncated: value.length > limit,
    originalLength: value.length,
  };
}

/** A value copied straight from the audited site: a title, a heading, a header. */
function siteText(value: string): AIText {
  return clamp(value, MAX_TEXT_LENGTH);
}

/** A sentence one of our own rules or collectors wrote, which may quote the site. */
function ourSentence(value: string): AIText {
  return clamp(value, MAX_EVIDENCE_LENGTH);
}

// ---------------------------------------------------------------------------
// Measurement states
// ---------------------------------------------------------------------------

function measured<T>(sourceState: string, value: T): AIMeasurement<T> {
  return { knowledge: "value", state: "measured", sourceState, value };
}

/** We looked, and it genuinely is not there. The only state that permits a claim. */
function confirmedAbsent<T>(sourceState: string, reason: string | null): AIMeasurement<T> {
  return {
    knowledge: "confirmed-absent",
    state: "absent",
    sourceState,
    reason: reason === null ? null : ourSentence(reason),
  };
}

/** We do not know. A statement about the audit, and never about the website. */
function unknown<T>(
  state: AIUnknownState,
  sourceState: string,
  reason: string | null,
): AIMeasurement<T> {
  return {
    knowledge: "unknown",
    state,
    sourceState,
    reason: reason === null ? null : ourSentence(reason),
  };
}

/** The question does not arise here. Not a gap, and not a fault. */
function notApplicable<T>(sourceState: string, reason: string | null): AIMeasurement<T> {
  return {
    knowledge: "not-applicable",
    state: "not-applicable",
    sourceState,
    reason: reason === null ? null : ourSentence(reason),
  };
}

/**
 * The three-state DNS answer, mapped without translating a single word.
 *
 * "error" stays "error". It is carried as `knowledge: "unknown"` so nothing
 * can read it as a missing record, which is the false security finding this
 * whole distinction exists to prevent.
 */
function fromDnsRecordSet<T, U>(
  set: DnsRecordSet<T>,
  toValue: (records: T[]) => U,
): AIMeasurement<U> {
  if (set.status === "found") return measured(set.status, toValue(set.records));
  if (set.status === "absent") return confirmedAbsent(set.status, null);
  return unknown("error", set.status, set.error);
}

/** The same three states for a single email policy record. */
function fromEmailRecord<U>(
  record: EmailPolicyRecord,
  toValue: (text: string) => U,
): AIMeasurement<U> {
  if (record.status === "found") {
    // A "found" record with no text is a state the collector should not be
    // able to produce. If it ever does, saying we do not know is the honest
    // answer; inventing an empty record would be a claim.
    if (record.record === null) {
      return unknown("error", record.status, "The record was reported as found but carried no text.");
    }
    return measured(record.status, toValue(record.record));
  }
  if (record.status === "absent") return confirmedAbsent(record.status, null);
  return unknown("error", record.status, record.error);
}

/** A header the server either sent or did not. */
function fromHeader(header: SecurityHeader): AIMeasurement<AIText> {
  if (!header.present || header.value === null) return confirmedAbsent("absent", null);
  return measured("present", siteText(header.value));
}

/** A value the page either declares or does not. */
function fromOptionalText(value: string | null): AIMeasurement<AIText> {
  if (value === null) return confirmedAbsent("absent", null);
  return measured("found", siteText(value));
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Whether an address may travel in a LIST of examples.
 *
 * Over-long addresses are dropped rather than cut, because a truncated address
 * is a different address and reporting a different address would be a false
 * claim. Dropping one never changes a count: `affectedCount` is measured
 * elsewhere and `sampleTruncated` still says the list is a sample.
 *
 * The limit is the crawler's own, so nothing the engine accepted as an address
 * is refused here.
 */
function usableInSample(url: string): boolean {
  return url.length > 0 && url.length <= MAX_SAMPLE_URL_LENGTH;
}

/**
 * The same address with any sign-in name and password removed.
 *
 * WHY EVERY ADDRESS GOES THROUGH THIS. An address may carry credentials in
 * front of the host, and the crawler already strips them from everything it
 * queues -- see `crawlUrl.ts`, which does exactly this and says why. But the
 * canonical a page declares, the sitemap named in robots.txt and the address
 * the operator typed never pass through that code, so three of the addresses
 * here arrived unstripped. A staging site is perfectly capable of publishing
 * its own password in a link, and there is no reason to forward it.
 *
 * UNPARSEABLE VALUES ARE RETURNED UNTOUCHED, which is safe: a string the URL
 * parser rejects has no credentials in the sense that matters, and rewriting
 * it would change a measured value on a guess.
 *
 * AN ADDRESS WITHOUT CREDENTIALS IS RETURNED UNTOUCHED TOO, rather than
 * rebuilt. Re-serialising normalises, so "https://example.com" would come back
 * as "https://example.com/" -- a different string from the one measured, and
 * the requested address is a fact this contract reports.
 */
/** The same, for an address the collector may not have recorded at all. */
function optionalWithoutCredentials(url: string | null): string | null {
  return url === null ? null : withoutCredentials(url);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * How far a page-scoped finding reaches.
 *
 * SITE-SCOPED FINDINGS NEVER GET ONE. The aggregator gives them a single
 * synthetic affected entry -- the site's own address -- so that the report has
 * something to show, and projecting that as page reach would turn one
 * certificate into "1 of 1 pages affected". A finding with no stated scope
 * gets none either, because we cannot say which kind it is.
 */
function reachOf(finding: Finding): AIReportReach | null {
  if (finding.scope !== "page") return null;

  /*
   * Each sampled page keeps ITS OWN measurement.
   *
   * The aggregator recorded one per affected page precisely because they
   * differ. Reducing them to a list of addresses beside the finding's single
   * evidence sentence would invite that one measurement to be read as true of
   * every address in the list, which it is not.
   */
  const samples = (finding.affected ?? [])
    .filter((entry) => usableInSample(entry.url))
    .slice(0, MAX_SAMPLE_URLS)
    .map((entry) => ({
      url: withoutCredentials(entry.url),
      evidence: ourSentence(entry.evidence),
    }));

  /*
   * The measured total, not the sample's length.
   *
   * `affectedCount` falls back to the aggregator's own list length only when
   * the count is absent, which is the single-page shape. It is never derived
   * from the sample above: the sample is capped twice over, and reading a cap
   * as a total is the exact mistake this field exists to prevent.
   */
  const affectedCount = finding.affectedCount ?? finding.affected?.length ?? 0;

  return {
    affectedCount,
    // Never filled in from the page count. A page where a rule could not run
    // was not a page the rule found to be fine.
    evaluatedPages: finding.evaluatedPages ?? null,
    samples,
    sampleTruncated: affectedCount > samples.length,
  };
}

/**
 * One finding, copied.
 *
 * Severity, title, category, evidence and remediation are all read straight
 * off what the rules decided. Nothing here inspects them, compares them, or
 * has any way to produce a different value.
 */
function toFinding(finding: Finding): AIReportFinding {
  return {
    ruleId: finding.id,
    title: finding.title,
    category: finding.category,
    // Copied, never chosen. This single line is the architecture.
    severity: finding.severity,
    evidence: ourSentence(finding.evidence),
    remediation: finding.remediation,
    // Read from the rule's own declaration. Never inferred from a count.
    scope: finding.scope ?? "unstated",
    reach: reachOf(finding),
  };
}

/** One check that did not run. It has no severity, and never acquires one. */
function toSkipped(check: SkippedCheck): AIReportSkipped {
  return { ruleId: check.ruleId, reason: ourSentence(check.reason) };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The limit that actually stopped the crawl, or none.
 *
 * A lookup, not a calculation: the stop reason was decided by the crawler and
 * this only pairs it with the configured value it hit. "deadline" is not one
 * of ours -- it is the surrounding audit's clock -- and "completed" hit
 * nothing, so both report no limit.
 */
function limitReached(crawl: SiteCrawlSummary): AIReportLimit | null {
  switch (crawl.stoppedBecause) {
    case "max-pages":
      return { limit: "pages", value: crawl.limits.maxPages };
    case "max-duration":
      return { limit: "duration", value: crawl.limits.maxDurationMs };
    case "max-queue":
      return { limit: "queue", value: crawl.limits.maxQueueSize };
    default:
      return null;
  }
}

function toCoverage(
  crawl: SiteCrawlSummary,
  pagesGraded: number,
  auditTimedOut: boolean,
): AIReportCoverage {
  return {
    // The server's own verdict, copied. It already accounts for sitemap
    // discovery, so a drained queue with an unread sitemap is honestly partial.
    complete: crawl.complete,
    stoppedBecause: crawl.stoppedBecause,
    auditTimedOut,

    pagesEvaluated: crawl.evaluated,
    pagesGraded,
    pagesDiscovered: crawl.discovered,
    // A count, never the addresses. Which pages our own crawler could not read
    // is not a fact about the client's website.
    pagesNotRead: crawl.unavailable.length,
    pagesNotHtml: crawl.skippedNonHtml,
    pagesExcludedByRobots: crawl.robots.excluded,
    pagesFoundButNotVisited: crawl.queuedAtStop,
    discoveredFrom: { links: crawl.sources.html, sitemap: crawl.sources.sitemap },

    limitReached: limitReached(crawl),

    robots: {
      status: crawl.robots.status,
      enforced: crawl.robots.enforced,
      excluded: crawl.robots.excluded,
    },
    sitemap: {
      attempted: crawl.sitemapDiscovery.attempted,
      complete: crawl.sitemapDiscovery.complete,
      stoppedBecause: crawl.sitemapDiscovery.stoppedBecause,
    },
  };
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/**
 * The canonical address the page declares, in three states rather than two.
 *
 * A canonical is written by the audited page and resolved with no length check
 * anywhere, so it is bounded only by the response body. An over-long one is
 * NOT reported as absent -- the page did declare one, and saying otherwise
 * would be a false claim about the page. It crosses as unknown, with a reason,
 * which is the same treatment every other value we could not carry receives.
 */
function toCanonicalUrl(canonicalUrl: string | null): AIMeasurement<string> {
  if (canonicalUrl === null) return confirmedAbsent("absent", null);
  if (canonicalUrl.length > MAX_DECLARED_URL_LENGTH) {
    return unknown(
      "unavailable",
      "found:too-long",
      `The page declares a canonical address of ${canonicalUrl.length} characters, which is too long to carry.`,
    );
  }
  return measured("found", withoutCredentials(canonicalUrl));
}

/**
 * The sitemap's location, in three states rather than two.
 *
 * The same problem the canonical has, from a different direction. This address
 * is a raw non-whitespace capture from the site's own robots.txt, which is
 * read up to half a megabyte, so a single directive can carry far more than
 * the rest of this contract put together.
 *
 * An over-long one is NOT absent. A sitemap really was declared, and the
 * reason says so and gives the measured length -- while the oversized value
 * itself goes nowhere.
 */
function toSitemapFile(
  status: TechnicalData["sitemapStatus"],
  sitemapUrl: string | null,
): AIMeasurement<AIReportSitemapFile> {
  if (status === "absent") return confirmedAbsent(status, null);
  // "unavailable" keeps its own word. It says nothing about the site.
  if (status === "unavailable") return unknown("unavailable", status, null);

  if (sitemapUrl !== null && sitemapUrl.length > MAX_DECLARED_URL_LENGTH) {
    return unknown(
      "unavailable",
      "found:too-long",
      `A sitemap was declared at an address of ${sitemapUrl.length} characters, which is too long to carry.`,
    );
  }

  return measured(status, { url: optionalWithoutCredentials(sitemapUrl) });
}

function toPageMeasurements(url: string, seo: SeoData): AIReportPageMeasurements {
  return {
    url: withoutCredentials(url),
    title: fromOptionalText(seo.titleText),
    metaDescription: fromOptionalText(seo.metaDescriptionText),
    bodyTextLength: seo.bodyTextLength,
    h1Count: seo.h1Count,
    h2Count: seo.h2Count,
    h3Count: seo.h3Count,
    // Capped, while `h1Count` above keeps the measured total.
    h1Texts: seo.h1Texts.slice(0, MAX_LIST_ITEMS).map(siteText),
    // Measured against the list we were given, not inferred by comparing
    // lengths: an empty heading shortens the list without anything being cut.
    h1TextsTruncated: seo.h1Texts.length > MAX_LIST_ITEMS,
    headingSkipCount: seo.headingSkips.length,
    imageCount: seo.imageCount,
    imagesMissingAlt: seo.imagesMissingAlt,
    canonicalUrl: toCanonicalUrl(seo.canonicalUrl),
    langAttribute: fromOptionalText(seo.langAttribute),
    hasViewportMeta: seo.hasViewportMeta,
  };
}

/** Presence only. The text of these headers is not needed to explain them. */
function toHeaderPresence(security: SecurityData): AIReportHeaderPresence {
  return {
    strictTransportSecurity: security.strictTransportSecurity.present,
    contentSecurityPolicy: security.contentSecurityPolicy.present,
    contentSecurityPolicyReportOnly: security.contentSecurityPolicyReportOnly.present,
    xFrameOptions: security.xFrameOptions.present,
    xContentTypeOptions: security.xContentTypeOptions.present,
    referrerPolicy: security.referrerPolicy.present,
    permissionsPolicy: security.permissionsPolicy.present,
  };
}

function toHsts(security: SecurityData): AIReportHsts {
  return {
    applicable: security.hsts.applicable,
    valid: security.hsts.valid,
    maxAgeSeconds: security.hsts.maxAgeSeconds,
    disabledByZeroMaxAge: security.hsts.disabledByZeroMaxAge,
    includesSubdomains: security.hsts.includesSubdomains,
    preload: security.hsts.preload,
  };
}

function toMixedContent(security: SecurityData): AIReportMixedContent {
  return {
    applicable: security.mixedContent.applicable,
    total: security.mixedContent.total,
    activeCount: security.mixedContent.activeCount,
    truncated: security.mixedContent.truncated,
    // Our own sentences. Carried because a total of zero is not a clean bill.
    notInspected: security.mixedContent.notInspected.slice(0, MAX_LIST_ITEMS),
    /*
     * `items` is deliberately absent. Each entry is an address written by the
     * audited site, and the finding's evidence already names what was found.
     */
  };
}

/**
 * Cookie protections, counted.
 *
 * NAMES DO NOT CROSS, and values were never captured in the first place. A
 * count answers "are your cookies protected?" without carrying a list of
 * someone's session cookie names into a third party's logs.
 */
function toCookies(security: SecurityData): AIReportCookies {
  const cookies = security.cookies.cookies;
  return {
    total: security.cookies.total,
    secureCount: cookies.filter((cookie) => cookie.secure).length,
    httpOnlyCount: cookies.filter((cookie) => cookie.httpOnly).length,
    sameSiteSetCount: cookies.filter((cookie) => cookie.sameSite !== null).length,
    notInspected: security.cookies.notInspected.slice(0, MAX_LIST_ITEMS),
  };
}

function toSecurityMeasurements(security: SecurityData): AIReportSecurityMeasurements {
  return {
    servedOverHttps: security.servedOverHttps,
    headers: toHeaderPresence(security),
    hsts: toHsts(security),
    mixedContent: toMixedContent(security),
    cookies: toCookies(security),
    // A count. The form addresses themselves stay behind.
    insecureFormCount: security.insecureFormActions.length,
    serverHeader: fromHeader(security.serverHeader),
    poweredByHeader: fromHeader(security.poweredByHeader),
  };
}

/**
 * The certificate, and the four separate reasons there might not be one.
 *
 * "not-applicable" is a plain HTTP site, where there is no certificate to
 * read and reporting one as missing would be noise on top of the far bigger
 * finding. "blocked" is our own safety check declining to connect. Neither is
 * a fault of the website, and neither is an error.
 */
function toCertificate(ssl: SslData): AIMeasurement<AIReportCertificate> {
  // The status word, plus the failure value when the engine recorded one, so
  // a timeout and an unreadable certificate stay distinguishable.
  const sourceState = ssl.failure === null ? ssl.status : `${ssl.status}:${ssl.failure}`;

  if (ssl.status === "not-applicable") return notApplicable(sourceState, ssl.message);
  if (ssl.status === "blocked") return unknown("unmeasured", sourceState, ssl.message);
  if (ssl.status === "unreachable") return unknown("error", sourceState, ssl.message);

  if (ssl.certificate === null) {
    return unknown("error", sourceState, ssl.message);
  }

  return measured(sourceState, {
    hostname: ssl.hostname,
    daysUntilExpiry: ssl.certificate.daysUntilExpiry,
    validTo: ssl.certificate.validTo,
    issuer: ssl.certificate.issuer === null ? null : siteText(ssl.certificate.issuer),
    trusted: ssl.trusted,
    problem: ssl.problem,
    coversHostname: ssl.certificate.coversHostname,
    hostnameMatch: ssl.certificate.hostnameMatch,
    protocol: ssl.certificate.protocol,
    // A count. The names themselves are a list of the client's other domains.
    altNameCount: ssl.certificate.subjectAltNames.length,
  });
}

/**
 * Where a domain routes its mail, or that it has published that it takes none.
 *
 * RFC 7505: a single MX pointing at the root says the domain accepts no email.
 * The resolver hands that back as an empty exchange, so projected as an
 * ordinary record it read as "one mail server whose name is blank" -- one
 * server, when the domain published none. The report already tells these
 * apart; this is the same reading, in the contract's own terms.
 *
 * ONLY WHEN IT IS THE SOLE RECORD, which is what the specification requires.
 * A domain publishing a root target alongside real servers has published
 * something contradictory, and the honest projection of that is the records it
 * actually has rather than a conclusion drawn from the broken one.
 */
function toMailRouting(records: MxRecord[]): AIReportMailRouting {
  const isRoot = (exchange: string) => {
    const name = exchange.trim();
    return name === "" || name === ".";
  };

  if (records.length === 1 && isRoot(records[0].exchange)) return { acceptsMail: false };

  return {
    acceptsMail: true,
    count: records.length,
    hosts: records.slice(0, MAX_LIST_ITEMS).map((record) => siteText(record.exchange)),
  };
}

function toDnsMeasurements(dns: AuditData["dns"]): AIReportDnsMeasurements {
  const count = (records: unknown[]): AIReportRecordCount => ({ count: records.length });

  return {
    hostname: dns.hostname,
    emailDomain: dns.emailDomain,
    a: fromDnsRecordSet(dns.a, count),
    aaaa: fromDnsRecordSet(dns.aaaa, count),
    mx: fromDnsRecordSet(dns.mx, toMailRouting),
    ns: fromDnsRecordSet(dns.ns, count),
    /*
     * `txt` is deliberately absent. It is the whole of a domain's TXT records,
     * which routinely carry verification tokens for third-party services, and
     * SPF -- the only one this audit grades -- is carried on its own below.
     */
  };
}

function toEmailMeasurements(dns: AuditData["dns"]): AIReportEmailMeasurements {
  return {
    /*
     * The domain both policies are ABOUT, carried whatever state they are in.
     *
     * `dns.emailDomain` is the value the collector looked both records up on,
     * and is what it sets as the DMARC record's own `appliesTo`. Naming it at
     * the group means "this domain publishes no SPF record" still says which
     * domain, which it could not when the value lived inside a found record.
     */
    appliesTo: dns.emailDomain,
    spf: fromEmailRecord(dns.spf, siteText),
    dmarc: fromEmailRecord(
      dns.dmarc,
      (text): AIReportDmarc => ({
        record: siteText(text),
        // The domain it was READ FROM, which differs when inherited.
        policyDomain: dns.dmarc.policyDomain,
        inherited: dns.dmarc.inherited,
        // sp= when inherited, p= otherwise. Decided by the collector.
        effectivePolicy: dns.dmarc.effectivePolicy,
      }),
    ),
  };
}

/**
 * The two site-level files, including the case where neither was looked for.
 *
 * `technical` is null when the audit ran out of time before these checks ran.
 * That is not "this site has no robots.txt", so it crosses as unmeasured.
 */
function toSiteFiles(technical: TechnicalData | null): AIReportSiteFileMeasurements {
  if (technical === null) {
    const reason = "These checks did not run on this audit, so nothing was established either way.";
    return {
      robotsTxt: unknown("unmeasured", "not-run", reason),
      sitemap: unknown("unmeasured", "not-run", reason),
    };
  }

  const robotsTxt: AIMeasurement<AIReportRobotsFile> =
    technical.robotsTxtStatus === "found"
      ? // `blocksEverything` is meaningful only because the file was read.
        measured(technical.robotsTxtStatus, { blocksEverything: technical.robotsBlocksEverything })
      : technical.robotsTxtStatus === "absent"
        ? confirmedAbsent(technical.robotsTxtStatus, null)
        : // "unavailable" keeps its own word. It says nothing about the site.
          unknown("unavailable", technical.robotsTxtStatus, null);

  return {
    robotsTxt,
    sitemap: toSitemapFile(technical.sitemapStatus, technical.sitemapUrl),
  };
}

function toTimeMetric(
  metric: { percentileMs: number; category: AIReportTimeMetric["category"] } | null,
): AIReportTimeMetric | null {
  if (metric === null) return null;
  return { percentileMs: metric.percentileMs, category: metric.category };
}

function toShiftMetric(
  metric: { percentile: number; category: AIReportShiftMetric["category"] } | null,
): AIReportShiftMetric | null {
  if (metric === null) return null;
  return { percentile: metric.percentile, category: metric.category };
}

/**
 * What real visitors experienced, or why there is no such data.
 *
 * "absent" here means Google has TOO FEW VISITS to report on anonymously. A
 * quiet site and a slow site produce completely different states, and this is
 * the line that keeps them apart.
 */
function toFieldPerformance(field: FieldPerformance): AIMeasurement<AIReportFieldPerformance> {
  if (field.status === "absent") return confirmedAbsent(field.status, null);
  if (field.status === "error") return unknown("error", field.status, field.error);

  return measured(field.status, {
    // Google follows redirects we did not, so these figures carry their own
    // address rather than borrowing the one we asked about.
    measuredUrl: optionalWithoutCredentials(field.measuredUrl),
    scope: field.scope,
    overall: field.overall,
    lcp: toTimeMetric(field.lcp),
    inp: toTimeMetric(field.inp),
    cls: toShiftMetric(field.cls),
    fcp: toTimeMetric(field.fcp),
    ttfb: toTimeMetric(field.ttfb),
  });
}

function toLabPerformance(lab: LabPerformance): AIMeasurement<AIReportLabPerformance> {
  if (lab.status === "error") return unknown("error", lab.status, lab.error);

  return measured(lab.status, {
    measuredUrl: optionalWithoutCredentials(lab.measuredUrl),
    score: lab.score,
    lcpMs: lab.lcpMs,
    fcpMs: lab.fcpMs,
    tbtMs: lab.tbtMs,
    speedIndexMs: lab.speedIndexMs,
    cls: lab.cls,
  });
}

/**
 * The speed check, and the four separate reasons it might have no numbers.
 *
 * NO API KEY IS NOT A SLOW WEBSITE, and neither is a pending check, an opt-out
 * or a timeout. Each keeps its own state word so a report can say the true
 * thing rather than the alarming one.
 */
function toPerformance(performance: PerformanceData): AIMeasurement<AIReportPerformance> {
  if (performance.status !== "checked") {
    // "not-requested", "no-api-key", "pending" and "error" are all states the
    // contract carries verbatim. None of them is a measurement.
    return unknown(performance.status, performance.status, performance.message);
  }

  return measured(performance.status, {
    strategy: performance.strategy,
    requestedUrl: withoutCredentials(performance.requestedUrl),
    field: toFieldPerformance(performance.field),
    lab: toLabPerformance(performance.lab),
    notInspected: performance.notInspected.slice(0, MAX_LIST_ITEMS),
  });
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

function toSiteContext(data: AuditData): AIReportSiteContext {
  return {
    // Both stripped of credentials. Neither passes through the crawler's
    // normalisation, which is where that removal happens for everything else.
    requestedUrl: withoutCredentials(data.website.requestedUrl),
    finalUrl: withoutCredentials(data.fetch.finalUrl),
    wasRedirected: data.fetch.wasRedirected,
    checkedAt: data.website.checkedAt,
    servedOverHttps: data.fetch.servedOverHttps,
    httpsUnavailable: data.fetch.httpsUnavailable,
    /*
     * `redirectChain` is deliberately absent: it is internal fetch detail, and
     * the two addresses that matter are already here. `contentType` and
     * `certificateProblem` are absent for the same reason -- the certificate
     * is measured properly in its own section.
     */
  };
}

/**
 * Everything an AI provider is given about one audited website.
 *
 * READS `site.findings`, NOT `data.findings`. The site summary is the
 * aggregated set: one finding per rule outcome, each already carrying its
 * scope, its measured total and its denominator. `data.findings` is the entry
 * page's own copy of a subset of the same list, and sending both would let the
 * same problem be described twice.
 *
 * DOES NOT READ `pages`. Every crawled page carries a complete `AuditData` of
 * about five and a half kilobytes, which at the crawl's own limit is most of a
 * megabyte -- and all of it is already summarised in the findings above. The
 * measurements below describe the ENTRY PAGE, which is the one a reader of the
 * report will actually open.
 */
export function buildAIReportInput(result: SiteAuditResult): AIReportInput {
  const data = result.data;

  return {
    version: AI_CONTRACT_VERSION,
    site: toSiteContext(data),
    coverage: toCoverage(result.crawl, result.site.evaluatedPages, data.timedOut),
    findings: result.site.findings.map(toFinding),
    notEvaluated: result.site.skippedChecks.map(toSkipped),
    measurements: {
      page: toPageMeasurements(data.fetch.finalUrl, data.seo),
      security: toSecurityMeasurements(data.security),
      certificate: toCertificate(data.ssl),
      dns: toDnsMeasurements(data.dns),
      email: toEmailMeasurements(data.dns),
      siteFiles: toSiteFiles(data.technical),
      performance: toPerformance(data.performance),
      /*
       * `uptime` is deliberately absent. Its `serverResponseTimeMs` is time to
       * first byte, which has been mistaken for a page-load time in this
       * project before; the speed section above carries the figures that
       * describe how the site actually feels, and the uptime rules already
       * turned that measurement into findings.
       *
       * `hosting` is absent because its module does not exist. Null there
       * means "not measured", and a field that is always unmeasured teaches a
       * reader nothing.
       */
    },
  };
}
