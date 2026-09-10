/**
 * The boundary between the deterministic audit and any AI provider.
 *
 * WHAT THIS FILE IS FOR
 *
 * Everything before this point measures and grades. Everything after it only
 * explains. This file describes the exact set of facts that crosses that line,
 * and nothing else may cross it.
 *
 * PROVIDER-NEUTRAL, DELIBERATELY. No SDK is imported here and no provider is
 * named. Swapping one model for another must not require a single change to
 * this file, because the contract describes OUR audit, not somebody's API.
 *
 * THE THREE RULES THIS SHAPE ENFORCES
 *
 *   1. Severity is already decided. It arrives as a value a rule declared and
 *      is copied out untouched. There is no field an AI could write it into.
 *   2. Counts are already decided. `affectedCount` is the measured total and
 *      the URL sample is explicitly marked as a sample, so nothing downstream
 *      can count a list of ten and call it the answer.
 *   3. A gap is not a fault. Every measurement carries WHAT WE KNOW as its own
 *      field, so "we could not check this" cannot be read as "this is broken".
 *
 * WHAT IS NOT HERE, AND WHY THAT IS THE POINT
 *
 * No raw HTML, no response bodies, no headers beyond the two named ones, no
 * cookies, no credentials, no redirect chains, no crawler queue state, no rule
 * selectors or thresholds, no per-page audit data. The builder in
 * `buildReportInput.ts` names every field it copies, so none of that can
 * arrive by accident when somebody widens an internal type later.
 */
import { MAX_URL_LENGTH as CRAWLER_MAX_URL_LENGTH } from "../collector/crawlUrl.ts";
import type { CrawlStopReason } from "../collector/crawlFrontier.ts";
import type { RobotsStatus } from "../collector/robots.ts";
import type { SitemapStopReason } from "../collector/sitemap.ts";
import type {
  Category,
  CertificateProblem,
  DmarcPolicy,
  HostnameMatch,
  PerformanceRating,
  Severity,
} from "../types";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * The contract's version, as a value and as a type.
 *
 * A literal type rather than `string` on purpose: a shape change that is not
 * accompanied by a version change should not compile. Widening this to
 * `string` would let the version drift silently, which is the one thing a
 * version is for.
 *
 * Bump it when the SHAPE changes. Never for a change in the values that flow
 * through an unchanged shape.
 */
export type AIContractVersion = "1";

export const AI_CONTRACT_VERSION: AIContractVersion = "1";

// ---------------------------------------------------------------------------
// Deterministic limits
// ---------------------------------------------------------------------------

/**
 * How many affected addresses travel with one finding.
 *
 * Far smaller than the report's own cap of fifty, because these are examples
 * rather than a list to work through: `affectedCount` carries the real total,
 * and ten addresses are enough to make a finding concrete. Keeping it small
 * also keeps down the volume of text written by the audited site.
 */
export const MAX_SAMPLE_URLS = 10;

/**
 * The longest a single value copied from the audited site may be.
 *
 * A title, a heading, a header value. Chosen against what the report already
 * measures: a title worth writing is under about sixty characters, so two
 * hundred still shows a bad long one AS long without carrying a page of
 * someone else's text. Nothing is lost by the cut, because `originalLength`
 * on every clamped value records the length that was actually measured.
 */
export const MAX_TEXT_LENGTH = 200;

/**
 * The longest a rule's evidence sentence may be.
 *
 * Longer than a single value because evidence is a sentence OUR rule wrote,
 * and it may quote several measured values inside it. Still bounded, because
 * some of what it quotes came from the audited site.
 */
export const MAX_EVIDENCE_LENGTH = 500;

/**
 * The longest address that may travel in a LIST of examples.
 *
 * THE CRAWLER'S OWN LIMIT, imported rather than chosen. `crawlUrl.ts` already
 * decides what counts as a usable address for this project, and inventing a
 * second, stricter rule here would drop addresses the engine considers
 * perfectly valid -- and would drift the day that limit changed. Two constants
 * with the same name and different values is how that goes wrong quietly.
 *
 * Longer ones are DROPPED rather than cut. A truncated address is a different
 * address, and reporting a different address is exactly the kind of false
 * claim this project exists to avoid. Dropping one never changes a count:
 * `affectedCount` is measured elsewhere, and `sampleTruncated` still says the
 * list is a sample.
 */
export const MAX_SAMPLE_URL_LENGTH = CRAWLER_MAX_URL_LENGTH;

/**
 * The longest address DECLARED BY THE AUDITED SITE that may cross.
 *
 * Two of them, and neither passes through the crawler's normalisation:
 *
 *   the canonical    resolved from the page's own link tag with no length
 *                    check, so bounded only by the response body
 *   the sitemap      a raw non-whitespace capture from the site's robots.txt,
 *                    which is read up to half a megabyte
 *
 * The same crawler limit applies to both: beyond it, this is not an address
 * anything would follow. One constant rather than one per field, because they
 * are the same kind of value with the same problem.
 *
 * AN OVER-LONG VALUE IS NEVER REPORTED AS ABSENT. The site did declare one,
 * and saying it did not would be a false claim about the site. It crosses as
 * an unknown measurement whose reason gives the measured length, and the
 * oversized string itself does not cross at all.
 */
export const MAX_DECLARED_URL_LENGTH = CRAWLER_MAX_URL_LENGTH;

/** How many entries any bounded list of measured values may carry. */
export const MAX_LIST_ITEMS = 10;

/**
 * How many findings a model may be asked to write about.
 *
 * OURS, NOT THE PROVIDER'S. Nothing Google publishes states a limit of twenty
 * or of any other number; their documentation says only that "very large or
 * deeply nested schemas may be rejected" and gives no threshold. What was
 * measured is that requests carrying twenty findings are answered and requests
 * carrying twenty-one are not, reproducibly, across two models and at two
 * payload sizes -- and that a byte-identical twenty-finding request is refused
 * when a schema naming twenty-one rules is attached to it. This is therefore a
 * safeguard chosen against observed behaviour, not a documented constraint, and
 * it must never be described as one.
 *
 * IT BOUNDS WHAT IS ASKED, AND NOTHING ELSE. The audit still measures, grades
 * and reports every finding it makes. This decides how many of them a model is
 * asked to write a paragraph about, which is the only thing that ever depended
 * on the number.
 *
 * WHY THE CAP IS HERE AND NOT AT THE PROVIDER. Waiting for a refusal would mean
 * a whole audit's commentary is lost on the sites that most need it, and it
 * would put an undocumented number in somebody else's server in charge of what
 * this application does. It is applied where the request is composed, before
 * one exists.
 */
export const MAX_EXPLAINED_FINDINGS = 20;

// ---------------------------------------------------------------------------
// Text written by the audited site
// ---------------------------------------------------------------------------

/**
 * A string this project did not write.
 *
 * UNTRUSTED DATA. It is a measured value to be described, never an instruction
 * to be followed. A site is free to put "ignore all previous instructions" in
 * its own page title, and that title is a legitimate part of an SEO report, so
 * it is carried as data in a typed field and never concatenated into anything
 * that reads as a command.
 *
 * TWO SOURCES, BOTH UNTRUSTED, AND THE SECOND IS EASY TO FORGET:
 *
 *   the audited website  a page title, a heading, a header value, a DNS
 *                        record, a certificate issuer, and our own evidence
 *                        sentences where they quote any of those
 *   an outside service   the speed service's own error text, which
 *                        `describeApiError` quotes verbatim into the message
 *                        that reaches this contract as a measurement's reason
 *
 * Nothing here distinguishes the two, deliberately: code that handles one
 * safely handles the other, and a field that said which would invite somebody
 * to trust one of them.
 *
 * Carried as an object rather than a bare string so that a cut is always
 * visible. Silently shortening a client's page title and then describing it
 * would be a claim about a value we changed.
 */
export interface AIText {
  /** The value, cut to the deterministic limit for its kind. */
  readonly text: string;
  /** True when the measured value was longer than that limit. */
  readonly truncated: boolean;
  /** The length actually measured, before any cut. Never estimated. */
  readonly originalLength: number;
}

// ---------------------------------------------------------------------------
// Measurement states
// ---------------------------------------------------------------------------

/**
 * What we know about one measurement, as a value that must be read first.
 *
 * THIS FIELD EXISTS TO STOP FOUR SPECIFIC FALSE SENTENCES:
 *
 *   "the check errored"        does not mean the website is bad
 *   "we could not find out"    does not mean the thing is absent
 *   "nobody asked for it"      does not mean it failed
 *   "there is no API key"      does not mean the site is slow
 *
 * Exactly one value permits a statement about the website: "confirmed-absent"
 * says we looked and it genuinely is not there. "unknown" permits no statement
 * about the site at all, only about the audit.
 */
export type AIKnowledge =
  /** A value was measured and is present. */
  | "value"
  /** We looked, and the thing genuinely is not there. A fact about the site. */
  | "confirmed-absent"
  /** We do not know. A fact about the audit, and never about the site. */
  | "unknown"
  /** The question does not arise here. Not a gap and not a fault. */
  | "not-applicable";

/**
 * The states that mean "we do not know", in the engine's own words.
 *
 * Kept as separate values rather than one generic state because they call for
 * different responses from whoever reads the report, and flattening them would
 * tell that person the wrong thing to go and fix. "error" and "unavailable"
 * are the two words this codebase already uses for the same idea in different
 * subsystems; both are kept so that no value is translated on its way across
 * this boundary.
 */
export type AIUnknownState =
  /** A lookup did not complete. The word the DNS and TLS checks use. */
  | "error"
  /** We could not find out. The word the site-file checks use. */
  | "unavailable"
  /** Asked for, and the answer has not come back yet. Not a result. */
  | "pending"
  /** Nobody asked for it. An opt-in check that was not opted into. */
  | "not-requested"
  /** No API key is configured, so nothing was attempted. */
  | "no-api-key"
  /** Never measured at all. The module did not run. */
  | "unmeasured";

/** Every state a measurement may report, across all four kinds of knowledge. */
export type AIMeasurementState = "measured" | "absent" | "not-applicable" | AIUnknownState;

/**
 * One measurement, and what we know about it.
 *
 * A DISCRIMINATED UNION, so a value cannot be attached to a state that did not
 * measure one. This is the same discipline the rules layer uses: `evaluate`
 * never sees an unmeasured state, and nothing here can read a value off a
 * measurement that has none.
 *
 * `sourceState` is the most specific word available for how the state was
 * arrived at, so no distinction is lost to the grouping above. When the
 * certificate check says "unreachable" and a DNS lookup says "error", both are
 * `knowledge: "unknown"` and both still say exactly which check said what.
 *
 * IT IS NOT ALWAYS AN ENGINE LITERAL, and the difference is worth knowing:
 *
 *   quoted     where the collector has a status field, its value verbatim:
 *              "checked", "found", "absent", "unavailable", "no-api-key",
 *              "pending", "not-requested", "error", "not-applicable"
 *   composed   a status plus the collector's own failure value, joined with a
 *              colon, so two states that share a status stay apart:
 *              "unreachable:timeout", "found:too-long"
 *   derived    where the collector reports a boolean or a null instead of a
 *              status, a word describing what was observed: "present" and
 *              "absent" for a response header, "found" and "absent" for an
 *              optional value read from the page, "not-run" for a module that
 *              did not run at all
 *
 * Typed as `string` rather than a union for exactly this reason: it is a label
 * for a person reading the report, not a value to branch on. BRANCH ON `state`
 * AND `knowledge`, which are closed unions and mean the same thing everywhere.
 */
export type AIMeasurement<T> =
  | {
      readonly knowledge: "value";
      readonly state: "measured";
      /** The engine's own status word, e.g. "checked" or "found". */
      readonly sourceState: string;
      readonly value: T;
    }
  | {
      readonly knowledge: "confirmed-absent";
      readonly state: "absent";
      readonly sourceState: string;
      /** The engine's own words, when it wrote any. */
      readonly reason: AIText | null;
    }
  | {
      readonly knowledge: "unknown";
      readonly state: AIUnknownState;
      readonly sourceState: string;
      readonly reason: AIText | null;
    }
  | {
      readonly knowledge: "not-applicable";
      readonly state: "not-applicable";
      readonly sourceState: string;
      readonly reason: AIText | null;
    };

// ---------------------------------------------------------------------------
// Site context
// ---------------------------------------------------------------------------

/**
 * Which website this report is about.
 *
 * Two addresses, and no more. The requested one is what the salesperson typed;
 * the final one is where it ended up. The chain between them is internal fetch
 * detail and does not cross.
 *
 * NO ADDRESS ANYWHERE IN THIS CONTRACT CARRIES CREDENTIALS. A sign-in name and
 * password can be written into any address, and the crawler already strips
 * them from everything it queues; every address here is put through the same
 * removal, so a staging site that publishes its own password in a link does
 * not hand it to an outside service.
 */
export interface AIReportSiteContext {
  /** The address the audit was asked about, after normalisation. */
  readonly requestedUrl: string;
  /** The address finally read. Differs when the site redirected. */
  readonly finalUrl: string;
  /** True when those differ. Stated rather than left to a string comparison. */
  readonly wasRedirected: boolean;
  /** When the audit ran, as an ISO date string. */
  readonly checkedAt: string;
  /** Whether the page finally read was served over HTTPS. */
  readonly servedOverHttps: boolean;
  /**
   * True when HTTPS could not be reached at all and plain HTTP was read
   * instead. Distinct from `servedOverHttps` being false for any other reason.
   */
  readonly httpsUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** The one limit that actually stopped the crawl. */
export interface AIReportLimit {
  readonly limit: "pages" | "duration" | "queue";
  /** The configured value that was reached. */
  readonly value: number;
}

/** What the site's robots.txt said, and what the crawl did about it. */
export interface AIReportRobotsCoverage {
  readonly status: RobotsStatus;
  /**
   * Whether the site's rules were actually applied. False when the file could
   * not be read: the crawl went ahead, and nothing may claim it obeyed rules
   * it never saw.
   */
  readonly enforced: boolean;
  /**
   * How many addresses robots.txt kept the crawl away from.
   *
   * CRAWL METADATA, NOT A FINDING. A site asking crawlers to stay out of its
   * checkout is a well-run site behaving normally.
   */
  readonly excluded: number;
}

/** How sitemap discovery went, as opposed to what it found. */
export interface AIReportSitemapCoverage {
  readonly attempted: boolean;
  readonly complete: boolean;
  readonly stoppedBecause: SitemapStopReason;
}

/**
 * How much of the site was seen.
 *
 * `complete` IS THE ANSWER. It is the server's own verdict, and it accounts
 * for sitemap discovery as well as the page queue, so a crawl that drained its
 * queue while a sitemap went unread is honestly incomplete. Anything asking
 * "was the whole site audited?" reads this and never the stop reason alone.
 */
export interface AIReportCoverage {
  /** The authoritative completeness verdict. Never recomputed here. */
  readonly complete: boolean;
  /**
   * Why the page crawl stopped.
   *
   * "completed" here alongside `complete: false` is a real and correct
   * combination: the page queue drained while sitemap discovery did not
   * finish. Read `sitemap.stoppedBecause` for that half.
   */
  readonly stoppedBecause: CrawlStopReason;
  /** True when the surrounding audit's own clock ran out mid-audit. */
  readonly auditTimedOut: boolean;

  /** Pages fetched and read as HTML. */
  readonly pagesEvaluated: number;
  /** Pages the grading rules were actually run against. */
  readonly pagesGraded: number;
  /** Same-site addresses the crawl became aware of, visited or not. */
  readonly pagesDiscovered: number;
  /** Pages that could not be read. Not faults of the website. */
  readonly pagesNotRead: number;
  /** Fetched but not HTML: a PDF, an image. Not a failure either. */
  readonly pagesNotHtml: number;
  /** Addresses robots.txt kept the crawl away from. */
  readonly pagesExcludedByRobots: number;
  /** Still waiting in the queue when the crawl stopped. Above zero is partial. */
  readonly pagesFoundButNotVisited: number;
  /** Where the discovered pages came from. */
  readonly discoveredFrom: { readonly links: number; readonly sitemap: number };

  /**
   * The limit that stopped the crawl, or null when none did.
   *
   * Only the limit that actually fired. Sending all of them would let a report
   * mention a ceiling the crawl never came near.
   */
  readonly limitReached: AIReportLimit | null;

  readonly robots: AIReportRobotsCoverage;
  readonly sitemap: AIReportSitemapCoverage;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * One page a finding was found on, with what was measured ON THAT PAGE.
 *
 * THE PAIRING IS THE POINT. The aggregator records a separate evidence
 * sentence for every affected page, because they differ: "the title is 92
 * characters" is true of one page and not of the next. Carrying a list of
 * addresses beside a single sentence would let all of them be described by a
 * measurement taken from one, which is a false claim about the other nine.
 */
export interface AIReportAffectedPage {
  readonly url: string;
  /** What was measured on THIS page. Never copied from another page. */
  readonly evidence: AIText;
}

/**
 * How far a page-scoped finding reaches.
 *
 * PRESENT ONLY ON PAGE-SCOPED FINDINGS. A certificate was not measured on a
 * hundred and thirteen pages, and giving a site fact a page denominator would
 * let anyone reading it quote a proportion nobody measured.
 */
export interface AIReportReach {
  /** How many pages the finding was actually found on. The real total. */
  readonly affectedCount: number;
  /**
   * How many pages the rule ACTUALLY RAN on. The denominator.
   *
   * Null when the deterministic data does not carry one. Never filled in from
   * the page count: a page where the rule could not run was not a page the
   * rule found to be fine.
   */
  readonly evaluatedPages: number | null;
  /**
   * Example pages, capped at MAX_SAMPLE_URLS, each with its own measurement.
   *
   * A SAMPLE, NEVER A TOTAL. Read `affectedCount` for how many there are.
   */
  readonly samples: readonly AIReportAffectedPage[];
  /**
   * True when the sample is shorter than `affectedCount`.
   *
   * Computed from the two numbers, so it cannot disagree with them.
   */
  readonly sampleTruncated: boolean;
}

/**
 * One graded finding, exactly as the deterministic rules decided it.
 *
 * Everything here was decided before this object existed. The AI layer
 * receives it to explain, and there is no field on it an explanation could
 * write back into.
 */
export interface AIReportFinding {
  /** The rule that produced this. Stable, and the key an explanation attaches to. */
  readonly ruleId: string;
  /** The rule's own written title. A constant in our source. */
  readonly title: string;
  readonly category: Category;
  /**
   * DECIDED BY A FIXED RULE IN OUR OWN CODE. Copied out untouched.
   *
   * Includes "good", which is a passing check rather than a problem. A report
   * that only ever listed problems would be a list of complaints, so passes
   * travel too, and "good" must never be described as something to fix.
   */
  readonly severity: Severity;
  /**
   * The measured fact behind the finding. May quote text from the site.
   *
   * ON A PAGE-SCOPED FINDING THIS IS ONE EXAMPLE, NOT A CLAIM ABOUT EVERY
   * AFFECTED PAGE. The aggregator fills it from the first page it happened to
   * meet, and that page need not even be in `reach.samples`, which is sorted
   * by address. Each sampled page carries its own measurement; use those to
   * say anything about a particular page.
   *
   * On a site-scoped finding there is only one measurement, so this is it.
   */
  readonly evidence: AIText;
  /**
   * The fixed action the rule declares. A constant in our source, not written
   * per audit and not written by an AI. An explanation may expand on it; it
   * never replaces it.
   */
  readonly remediation: string;
  /**
   * Whether this describes one page or the whole site.
   *
   * "unstated" when the deterministic data carried no scope. NEVER inferred
   * from counts: a finding with one affected page is not thereby site-scoped,
   * and one with many is not thereby page-scoped.
   */
  readonly scope: "page" | "site" | "unstated";
  /** Null for site-scoped findings, and for findings with no stated scope. */
  readonly reach: AIReportReach | null;
}

/**
 * A grading rule that did not run.
 *
 * NOT A FINDING, and it never becomes one. It has no severity, because "we
 * could not check the SPF record" is not a problem with the website. It is
 * carried so that a gap in the audit is visible rather than silent, since a
 * silent gap reads as a pass.
 */
export interface AIReportSkipped {
  readonly ruleId: string;
  /** Why, in the collector's own words. Never reworded. */
  readonly reason: AIText;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** What the entry page's own HTML says. */
export interface AIReportPageMeasurements {
  /** The page these measurements describe. */
  readonly url: string;
  /** The title text. Absent when the page has none. */
  readonly title: AIMeasurement<AIText>;
  /** The meta description. Absent when the page has none. */
  readonly metaDescription: AIMeasurement<AIText>;
  /**
   * Characters of visible text in the SERVED HTML.
   *
   * A measurement, not a verdict. A site that builds its content in the
   * browser serves an almost empty body while being perfectly complete for a
   * visitor, so a low number here is not evidence of a thin page.
   */
  readonly bodyTextLength: number;
  readonly h1Count: number;
  readonly h2Count: number;
  readonly h3Count: number;
  /**
   * The text of each h1 that has any, capped at MAX_LIST_ITEMS.
   *
   * Can be shorter than `h1Count` for two unrelated reasons: an empty heading
   * is counted as an element and contributes no text, and the list is capped.
   * That is why `h1TextsTruncated` exists rather than leaving the comparison
   * to whoever reads this.
   */
  readonly h1Texts: readonly AIText[];
  /**
   * True when there were more headings with text than this list holds.
   *
   * MEASURED, NOT INFERRED. `h1Texts.length < h1Count` cannot answer this,
   * because an empty heading makes the list shorter without anything having
   * been left out.
   */
  readonly h1TextsTruncated: boolean;
  /** How many places heading levels skip a step. */
  readonly headingSkipCount: number;
  readonly imageCount: number;
  readonly imagesMissingAlt: number;
  /** The canonical address the page declares. Absent when it declares none. */
  readonly canonicalUrl: AIMeasurement<string>;
  /** The declared language. Absent when unset. */
  readonly langAttribute: AIMeasurement<AIText>;
  readonly hasViewportMeta: boolean;
}

/** Which protective headers the server sent. Presence only, not their text. */
export interface AIReportHeaderPresence {
  readonly strictTransportSecurity: boolean;
  readonly contentSecurityPolicy: boolean;
  /** Monitored but NOT enforced, so it protects nobody. Kept distinct. */
  readonly contentSecurityPolicyReportOnly: boolean;
  readonly xFrameOptions: boolean;
  readonly xContentTypeOptions: boolean;
  readonly referrerPolicy: boolean;
  readonly permissionsPolicy: boolean;
}

/** Strict-Transport-Security, read in detail rather than merely counted. */
export interface AIReportHsts {
  /** HSTS does nothing on a plain HTTP page, so "missing" would be noise. */
  readonly applicable: boolean;
  /** Whether a browser would act on it. A header without max-age is ignored. */
  readonly valid: boolean;
  readonly maxAgeSeconds: number | null;
  readonly disabledByZeroMaxAge: boolean;
  readonly includesSubdomains: boolean;
  readonly preload: boolean;
}

/** Resources the page loads over plain HTTP. */
export interface AIReportMixedContent {
  /** Only an HTTPS page can have mixed content. */
  readonly applicable: boolean;
  /** How many were found in the page's own markup. */
  readonly total: number;
  /** How many a browser is expected to block outright. */
  readonly activeCount: number;
  /** True when more were found than the collector's own list holds. */
  readonly truncated: boolean;
  /**
   * Where this scan could not look, in our own words.
   *
   * Carried so a total of zero is never presented as "this site is clean". We
   * read the markup the server sent; we do not run the page.
   */
  readonly notInspected: readonly string[];
}

/** Cookie protections, counted. Names and values never cross. */
export interface AIReportCookies {
  readonly total: number;
  readonly secureCount: number;
  readonly httpOnlyCount: number;
  readonly sameSiteSetCount: number;
  /** What this check cannot see, so an empty result is not read as none. */
  readonly notInspected: readonly string[];
}

export interface AIReportSecurityMeasurements {
  readonly servedOverHttps: boolean;
  readonly headers: AIReportHeaderPresence;
  readonly hsts: AIReportHsts;
  readonly mixedContent: AIReportMixedContent;
  readonly cookies: AIReportCookies;
  /** How many forms submit to a plain HTTP address. Their addresses do not cross. */
  readonly insecureFormCount: number;
  /** The Server header's text. Short, and the disclosure is the finding. */
  readonly serverHeader: AIMeasurement<AIText>;
  /** The X-Powered-By header's text, for the same reason. */
  readonly poweredByHeader: AIMeasurement<AIText>;
}

/** The certificate the site presents. */
export interface AIReportCertificate {
  /** The hostname whose certificate was read. */
  readonly hostname: string;
  /** Whole days until expiry, negative when it has already expired. */
  readonly daysUntilExpiry: number | null;
  /** When it expires, as an ISO date. */
  readonly validTo: string | null;
  /** The authority that issued it. Written by the issuer, so carried as text. */
  readonly issuer: AIText | null;
  /**
   * Whether the chain passed the platform's own validation.
   *
   * Null means we never got far enough to know, which is NOT "untrusted".
   */
  readonly trusted: boolean | null;
  /** Why validation failed, as a value. Null when it passed or is unknown. */
  readonly problem: CertificateProblem | null;
  /**
   * Whether the audited hostname is one the certificate covers.
   *
   * Null means the certificate carried no names we could check. Saying it does
   * not cover the address would be a claim we never measured.
   */
  readonly coversHostname: boolean | null;
  readonly hostnameMatch: HostnameMatch | null;
  /** The TLS version negotiated, e.g. "TLSv1.3". */
  readonly protocol: string | null;
  /** How many hostnames it covers. The names themselves do not cross. */
  readonly altNameCount: number;
}

/** One set of DNS records, counted. */
export interface AIReportRecordCount {
  readonly count: number;
}

/**
 * Where the domain routes its email, or that it has said it takes none.
 *
 * A DISCRIMINATED UNION BECAUSE OF RFC 7505. A domain that accepts no email
 * says so by publishing a single MX record pointing at the root, which arrives
 * from the resolver as an empty exchange with preference 0. Projected as an
 * ordinary record it became "one mail server, name blank" -- and one mail
 * server is the opposite of what the domain published. Plenty of domains that
 * only serve a website do exactly this, `example.com` among them.
 *
 * Read `acceptsMail` before anything else here. Nothing else is a count.
 */
export type AIReportMailRouting =
  | {
      /**
       * The domain publishes a null MX. It states that it accepts no email.
       *
       * A MEASURED FACT, not a judgement: it is what the record says. Whether
       * a domain ought to accept email is not this audit's business, and there
       * is no finding for it.
       */
      readonly acceptsMail: false;
    }
  | {
      readonly acceptsMail: true;
      /** How many mail servers the domain publishes. Always at least one. */
      readonly count: number;
      /** The mail hostnames, capped at MAX_LIST_ITEMS. */
      readonly hosts: readonly AIText[];
    };

export interface AIReportDnsMeasurements {
  /** The host serving the website. */
  readonly hostname: string;
  /**
   * The domain the mail records were looked up on.
   *
   * Usually the hostname with a leading "www." removed, because a www name is
   * very often a CDN alias with no mail policy of its own while the policy
   * lives on the parent. Naming it stops a reader assuming otherwise.
   */
  readonly emailDomain: string;
  readonly a: AIMeasurement<AIReportRecordCount>;
  readonly aaaa: AIMeasurement<AIReportRecordCount>;
  readonly mx: AIMeasurement<AIReportMailRouting>;
  readonly ns: AIMeasurement<AIReportRecordCount>;
}

/** A DMARC policy, and where it actually came from. */
export interface AIReportDmarc {
  /** The record's text, as published. */
  readonly record: AIText;
  /*
   * The domain this policy is ABOUT is `appliesTo` on the group below, not
   * here. It was here, and only on a record that was found -- which meant a
   * domain publishing NO policy could not say which domain that was.
   */
  /** WHERE THE RECORD WAS READ FROM. A parent domain when inherited. */
  readonly policyDomain: string | null;
  /**
   * True when the policy came from a parent rather than the domain itself.
   *
   * "Your domain publishes DMARC" and "your parent's DMARC covers you" are
   * different sentences, and only one of them is true at a time.
   */
  readonly inherited: boolean;
  /**
   * The policy governing mail from `appliesTo`.
   *
   * Null when the record carries no policy tag we recognise. An unreadable tag
   * is not "none", and reading it that way would claim the record permits
   * forged mail through.
   */
  readonly effectivePolicy: DmarcPolicy | null;
}

export interface AIReportEmailMeasurements {
  /**
   * THE DOMAIN BOTH POLICIES BELOW ARE ABOUT.
   *
   * AT THE GROUP, SO IT SURVIVES AN ABSENCE. "This domain publishes no SPF
   * record" is meaningless without saying which domain, and the absence is
   * exactly the case where a value carried inside a found record disappears.
   *
   * It is the MAIL domain, which is very often not the address that was
   * audited: a site served from a www name usually has its mail on the parent,
   * and the collector drops the label before any lookup. Reporting the web
   * hostname here would name a domain nobody sends mail from.
   */
  readonly appliesTo: string;
  /** The SPF record's text, when the domain publishes one. */
  readonly spf: AIMeasurement<AIText>;
  readonly dmarc: AIMeasurement<AIReportDmarc>;
}

/** What robots.txt says, once it has been read. */
export interface AIReportRobotsFile {
  /**
   * Whether it blocks every crawler from the whole site.
   *
   * A common and costly misconfiguration. Meaningful only because the file was
   * actually read: an unreadable file reaches this contract as unknown.
   */
  readonly blocksEverything: boolean;
}

/** What was found when looking for a sitemap. */
export interface AIReportSitemapFile {
  /**
   * The sitemap's address, when one was found and was short enough to carry.
   *
   * Null when the collector recorded no address. An address too long to carry
   * does NOT arrive here as null: the whole measurement is unknown in that
   * case, so an oversized value can never be mistaken for a missing one.
   */
  readonly url: string | null;
}

export interface AIReportSiteFileMeasurements {
  readonly robotsTxt: AIMeasurement<AIReportRobotsFile>;
  readonly sitemap: AIMeasurement<AIReportSitemapFile>;
}

/** One timing figure from real visitors, with Google's own rating of it. */
export interface AIReportTimeMetric {
  /** The value three out of four visits did better than, in milliseconds. */
  readonly percentileMs: number;
  /** Google's rating. Taken from the API, never calculated here. */
  readonly category: PerformanceRating;
}

/** Cumulative Layout Shift, which is a score rather than a duration. */
export interface AIReportShiftMetric {
  readonly percentile: number;
  readonly category: PerformanceRating;
}

/**
 * What real visitors actually experienced.
 *
 * This is the data Google ranks on, and it is kept strictly apart from the lab
 * figures below.
 */
export interface AIReportFieldPerformance {
  /**
   * The address these figures belong to, in Google's own words.
   *
   * Carried because Google follows redirects we did not: asked about one
   * domain it has reported on another. Without this the figures could be
   * described as belonging to a site they do not.
   */
  readonly measuredUrl: string | null;
  /**
   * Whether these figures describe THIS PAGE or the whole SITE.
   *
   * Google falls back to site-wide data when one page has too little traffic.
   */
  readonly scope: "page" | "origin" | null;
  readonly overall: PerformanceRating | null;
  readonly lcp: AIReportTimeMetric | null;
  readonly inp: AIReportTimeMetric | null;
  readonly cls: AIReportShiftMetric | null;
  readonly fcp: AIReportTimeMetric | null;
  readonly ttfb: AIReportTimeMetric | null;
}

/**
 * One simulated load in Google's datacentre.
 *
 * Repeatable and useful for diagnosis, but nobody experienced it. Where the
 * two disagree, the field figures above are what matter.
 */
export interface AIReportLabPerformance {
  readonly measuredUrl: string | null;
  readonly score: number | null;
  readonly lcpMs: number | null;
  readonly fcpMs: number | null;
  readonly tbtMs: number | null;
  readonly speedIndexMs: number | null;
  readonly cls: number | null;
}

export interface AIReportPerformance {
  /** Which device was simulated. */
  readonly strategy: "mobile";
  /** The address the speed check was asked about. */
  readonly requestedUrl: string;
  /**
   * Real-visitor data.
   *
   * ABSENT MEANS TOO FEW VISITORS TO REPORT ANONYMOUSLY. It does not mean the
   * site is slow. A quiet site and a slow site must never look the same.
   */
  readonly field: AIMeasurement<AIReportFieldPerformance>;
  readonly lab: AIMeasurement<AIReportLabPerformance>;
  /** What this check cannot tell you, so a gap is never read as a result. */
  readonly notInspected: readonly string[];
}

/**
 * The measured facts, grouped the way the report presents them.
 *
 * Every one of these is a fact a reader can go and verify. None of them is a
 * judgement: the judgements are in `findings`, and rules made them.
 */
export interface AIReportMeasurements {
  /** The entry page's own HTML. */
  readonly page: AIReportPageMeasurements;
  readonly security: AIReportSecurityMeasurements;
  readonly certificate: AIMeasurement<AIReportCertificate>;
  readonly dns: AIReportDnsMeasurements;
  readonly email: AIReportEmailMeasurements;
  readonly siteFiles: AIReportSiteFileMeasurements;
  readonly performance: AIMeasurement<AIReportPerformance>;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Everything an AI provider is given, and the only thing it is given.
 *
 * Built by `buildReportInput.ts`, which names every field it copies. Nothing
 * reaches here by spreading an internal object, so widening `AuditData` or
 * `SiteAuditResult` later cannot quietly widen what leaves the building.
 */
export interface AIReportInput {
  readonly version: AIContractVersion;
  readonly site: AIReportSiteContext;
  readonly coverage: AIReportCoverage;
  /** Graded by fixed rules. Already decided, and not open to revision. */
  readonly findings: readonly AIReportFinding[];
  /** Checks that did not run. Neither problems nor passes. */
  readonly notEvaluated: readonly AIReportSkipped[];
  readonly measurements: AIReportMeasurements;
}
