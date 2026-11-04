/**
 * Everything the PDF is allowed to show, and nothing else.
 *
 * WHAT THIS IS FOR. A renderer that received the audit itself could print any
 * of it: the crawler's internals, every page's raw measurements, a provider's
 * error body. This is the boundary that decides instead, field by field, in
 * the same way `buildAIReportInput` decides what a model may see. Widening an
 * internal type cannot widen the document, because nothing here is spread.
 *
 * IT ADDS NO JUDGEMENT. Every value below was measured, graded and worded
 * before this ran. Nothing recalculates a severity, a count, a denominator or
 * a verdict; nothing re-runs a rule; nothing asks a model anything. The
 * strings come from the report layer, which is the same source the browser
 * report reads, so the two cannot disagree about the same measurement.
 *
 * IT TOUCHES NOTHING. The job, the audit, the findings, the speed result and
 * the AI answer are all read and never written. The composition returns a new
 * object; the stored audit is left exactly as the crawl produced it.
 *
 * NO NETWORK, NO PROVIDER, NO PERSISTENCE. This function does arithmetic on
 * data it was handed and returns an object. It makes no request, reads no
 * environment variable, and stores nothing.
 */
import { withSpeed } from "./withSpeed.ts";
import { withoutCredentials } from "../collector/url.ts";
import { EVIDENCE_PANEL_HEADINGS, explainerFor, whoFixesLabel } from "../report/findingExplainers.ts";
import { buildOverallSummary, type OverallSummary } from "../report/overallSummary.ts";

/*
 * The summary's shape, passed through for the renderer. The renderer imports
 * only from this file, so the report layer's types reach it from here.
 */
export type { OverallSummary, SummaryArea, SummaryPriority } from "../report/overallSummary.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";
import { MAX_EXPLAINED_FINDINGS } from "../ai/contract.ts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import {
  METRIC_NOT_REPORTED,
  categoryLabel,
  certificateFacts,
  certificateProblemFacts,
  contentFacts,
  crawlCountTiles,
  crawlLimitFacts,
  crawlStatusText,
  discoverySourceFacts,
  findingsHeadline,
  dmarcFacts,
  dnsFacts,
  fieldOverallText,
  fieldShiftText,
  groupByCategory,
  groupSkippedByReason,
  labShiftText,
  metricDurationText,
  ratingLabel,
  SPEED_FIELD_HEADING,
  SPEED_LAB_HEADING,
  SPEED_NOT_INSPECTED_HEADING,
  readableTimestamp,
  robotsFacts,
  SECURITY_FACT_LABELS,
  securityFacts,
  severityCounts,
  severityLabel,
  sitemapDiscoveryFacts,
  spfFacts,
  strategyLabel,
  skippedCheckCount,
  type FactRow,
} from "../report/measurementsView.ts";
import {
  PAGE_FINDINGS_HEADING,
  PAGE_FINDINGS_INTRO,
  REMEDIATION_LABEL,
  SITE_FINDINGS_HEADING,
  SITE_FINDINGS_INTRO,
  affectedViewFor,
  auditStatusText,
  certificateFailureView,
  coverageCheck,
  crawlView,
  isCertificateFailureAudit,
  SPEED_NOT_MEASURED_WITHOUT_PAGE,
  partitionByScope,
  scopeLabel,
  stopReasonText,
  type CoverageCheck,
  type FindingScope,
} from "../report/siteFindingsView.ts";
import { AUDIT_RULES } from "../rules/all.ts";
import {
  AI_EXPLANATION_LABEL,
  AI_IMPACT_LABEL,
  AI_PROVENANCE,
  AI_RECOMMENDATION_LABEL,
  AI_SUMMARY_HEADING,
  coverageNote,
  rejectedNote,
} from "../report/commentaryView.ts";
import { buildClientAiSummary, type ClientAiSummary } from "../report/clientSummary.ts";
/*
 * RE-EXPORTED SO THE RENDERER STAYS SEALED. The PDF section files may import only
 * from within their own folder and from this projection (a test in shell.test
 * enforces it), so the client-summary section reads its type from here rather
 * than reaching into the report layer directly.
 */
export type { ClientAiSummary, ClientKeyFinding, ClientRecommendation } from "../report/clientSummary.ts";
import {
  SKIPPED_HEADING,
  SKIPPED_INTRO,
  findingsState,
  showsSkippedPanel,
  type FindingsState,
} from "../report/findingsState.ts";
import { scoreAudit, type CategoryScore, type Grade, type ScoreResult } from "../scoring/score.ts";
import {
  GATE_HEADING,
  GATE_NOTE,
  SCORE_CATEGORY_ORDER,
  SCORE_PARTIAL_NOTE,
  coveragePercent,
  gateReasons,
  gradeBandLabel,
  scoreStatusMessage,
} from "../report/scoreView.ts";
import type {
  AuditData,
  Category,
  CertificateFailureAudit,
  Finding,
  PerformanceRating,
  Severity,
  SiteAuditResult,
  SiteFileStatus,
  SkippedCheck,
} from "../types";

// ---------------------------------------------------------------------------
// The client's own details
// ---------------------------------------------------------------------------

/**
 * Typed by the salesperson at export time, held for one request.
 *
 * EVERY FIELD OPTIONAL, and the document must read correctly without any of
 * them. Nothing here is derived from the audited domain: guessing a company
 * name from a hostname is the kind of small invention that gets noticed.
 */
export interface PdfClient {
  readonly companyName: string | null;
  readonly contactName: string | null;
  readonly preparedBy: string | null;
}

const EMPTY_CLIENT: PdfClient = { companyName: null, contactName: null, preparedBy: null };

/** Trimmed, and empty means absent rather than an empty line on the cover. */
function clientField(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** One label-and-value row, exactly as the results page renders facts. */
export type PdfFact = FactRow;

/** A titled group of fact rows. */
export interface PdfFactSection {
  readonly heading: string;
  readonly facts: readonly PdfFact[];
}

export interface PdfCover {
  readonly client: PdfClient;
  /** The address the audit ended at, with any credentials removed. */
  readonly auditedUrl: string;
  /** Where it started, when that differed. Null otherwise. */
  readonly requestedUrl: string | null;
  /**
   * When the site was measured, as a sentence: "8 September 2026 at 10:00 UTC".
   *
   * NOT WHEN THE DOCUMENT WAS MADE, which 7A §20 is explicit about.
   *
   * DISPLAY-READY, like every other string here. It arrived as a stored
   * timestamp until the 7C-1 review found it -- the one field the renderer
   * would have had to interpret, and a renderer that formats a date is a
   * renderer that can disagree with the screen about one.
   *
   * Null when the stored value could not be read. That does not happen today,
   * because the audit writes it itself, and it is a state rather than a
   * fallback because the alternative is printing the raw timestamp, which is
   * the thing this field exists to keep out of the document.
   */
  readonly checkedAt: string | null;
  readonly partial: boolean;
  /** "Website audit complete" or "Partial website audit". */
  readonly statusLine: string;
}

export interface PdfCoverage {
  readonly partial: boolean;
  readonly headline: string;
  /** Why the crawl stopped short. Null when it finished properly. */
  readonly stopReason: string | null;
  readonly facts: readonly PdfFact[];
}

export interface PdfSeverityCount {
  readonly severity: Exclude<Severity, "good">;
  readonly label: string;
  readonly count: number;
}

/**
 * Prose about the audit as a whole, when a model wrote some.
 *
 * NULL WHENEVER THERE IS NONE, for any reason. A document without it is a
 * complete document.
 */
export interface PdfAiSummary {
  readonly executiveSummary: string;
  /** True when the validator dropped at least one entry. */
  readonly partial: boolean;
  /** How many were dropped. A count, never the reasons. */
  readonly rejectedCount: number;
  /**
   * What to say about the dropped entries, or null when none were.
   *
   * Phrased by the report layer, because the count has to become a sentence
   * with the right plural and a renderer that pluralises is a renderer that
   * writes.
   */
  readonly rejectedNote: string | null;
  /**
   * What to say when more findings were made than were written about, or null.
   *
   * Beside `rejectedNote` because it answers the same reader: both explain a
   * difference between the number of findings and the number of explanations,
   * and a document that accounted for one gap and not the other would be worse
   * than one that accounted for neither.
   */
  readonly coverageNote: string | null;
}

/**
 * The words that label parts of the document, rather than describe the site.
 *
 * WHY THEY TRAVEL WITH THE DOCUMENT. Every one of these is also on screen, and
 * 7A §5 settled that shared wording lives in the report layer with one copy:
 * two copies of a sentence about a client's website drift, and the browser
 * report and the PDF would then disagree. The renderer cannot reach the report
 * layer -- 7A §25 gives it this object and nothing else -- so the labels come
 * through here, exactly as the section headings already do.
 *
 * THEY ARE LABELS, NOT MEASUREMENTS. Nothing here is derived from the audit,
 * and the same six strings appear in every document.
 */
export interface PdfLabels {
  /** Above a finding's remediation. 7A §8 requires it labelled and set apart. */
  readonly remediation: string;
  /** Above the whole-audit summary. */
  readonly aiSummaryHeading: string;
  /** The sentence saying every finding and figure was measured by the tool. */
  readonly aiProvenance: string;
  /** The three labels inside one finding's commentary, in contract order. */
  readonly aiExplanation: string;
  readonly aiImpact: string;
  readonly aiRecommendation: string;
  /** The two halves of a speed result, which are not the same measurement. */
  readonly speedField: string;
  readonly speedLab: string;
  /** Above the list of what the speed check could not see. */
  readonly speedNotInspected: string;
}

export interface PdfSummary {
  readonly severityCounts: readonly PdfSeverityCount[];
  readonly state: FindingsState;
  /**
   * The audit's own sentence about what it found.
   *
   * MEASURED, AND ABOVE THE WRITTEN SUMMARY on the page. A model's
   * paragraph sits below this one, so a reader never has to take that
   * paragraph's word for whether anything is wrong.
   */
  readonly stateSentence: string;
  readonly ai: PdfAiSummary | null;
}

// ---------------------------------------------------------------------------
// The deterministic score, made ready for the page
//
// DISPLAY-ONLY, LIKE EVERYTHING ELSE HERE. Every value below is read from the
// `ScoreResult` that `scoreAudit` already computed from the verified findings.
// This projection grades nothing, averages nothing and re-derives nothing: it
// chooses which of the score's own numbers the document shows and the words to
// show them in, drawing that wording from `scoreView` so the PDF and the
// on-screen dashboard cannot disagree about the same grade. A model never
// reaches any of it.
// ---------------------------------------------------------------------------

/**
 * One pillar's line in the score block, or a plain "not assessed".
 *
 * A DISCRIMINATED UNION on `assessed`, so a Not Assessed category carries no
 * grade or number to show as a zero, and the renderer cannot reach one.
 */
export type PdfScoreCategory =
  | {
      readonly assessed: false;
      readonly label: string;
      /** Which pillar, so a renderer never has to recognise one by its wording. */
      readonly category: Category;
      /** Nothing in this category reached a result. */
      readonly ranCount: 0;
      /** Expected checks in this category that did not run. Zero when none were expected. */
      readonly skippedCount: number;
    }
  | {
      readonly assessed: true;
      readonly label: string;
      /** A letter, carried in words as well as colour. */
      readonly grade: Grade;
      readonly passRate: number;
      readonly coveragePercent: number;
      /** The severity class that tints the grade. */
      readonly gradeClass: string;
      readonly category: Category;
      /** Expected checks that reached a result: passes and findings alike (CP3-Q17). */
      readonly ranCount: number;
      /** Expected checks that did not run. `ranCount + skippedCount` is every check expected. */
      readonly skippedCount: number;
    };

/** The whole score, projected for the document. */
export interface PdfScore {
  /** True only when a headline grade was given. */
  readonly graded: boolean;
  readonly grade: Grade | null;
  readonly bandLabel: string | null;
  /** The severity class tinting the overall grade, or "" when withheld. */
  readonly gradeClass: string;
  readonly passRate: number | null;
  readonly coveragePercent: number;
  /** The sentence explaining a withheld grade, or null when one was given. */
  readonly statusMessage: string | null;
  /** Said when the grade covers less than the whole site. */
  readonly partialNote: string | null;
  /** Said when a gate held the grade below its pass rate. */
  readonly capNote: string | null;
  readonly categories: readonly PdfScoreCategory[];
  /** Expected checks across the audit that reached a result. */
  readonly ranCount: number;
  /** Every check the audit expected, whether or not it could run. */
  readonly expectedCount: number;
  readonly gateHeading: string;
  /** The findings that capped the grade, by title. Empty when none did. */
  readonly gateReasons: readonly string[];
  readonly gateNote: string | null;
}

/** Prose about one finding. Never a measurement. */
export interface PdfCommentary {
  readonly explanation: string;
  readonly businessImpact: string;
  readonly recommendation: string;
}

export interface PdfAffectedPage {
  readonly url: string;
  readonly evidence: string;
}

/**
 * The plain-language explanation of a rule, from `findingExplainers.ts`.
 *
 * WRITTEN IN OUR SOURCE, NOT BY A MODEL, so it is present whether or not the AI
 * layer answered and it says the same thing in every report.
 */
export interface PdfExplainer {
  readonly whatItMeans: string;
  readonly whyItMatters: string;
  readonly possibleImpact: string;
  readonly steps: readonly string[];
  /** "Website developer, Hosting or server administrator". */
  readonly whoFixes: string;
  /** What the fix is intended to bring about, copied from the explainer unchanged. */
  readonly whatFixingAchieves: string;
}

export interface PdfFinding {
  /** The rule that produced it. Needed to match commentary and to key a list. */
  readonly ruleId: string;
  readonly title: string;
  readonly category: Category;
  readonly categoryLabel: string;
  readonly severity: Severity;
  readonly severityLabel: string;
  readonly scope: FindingScope;
  readonly scopeLabel: string;
  /** "19 of 128 evaluated pages". Null for a site finding, which has no denominator. */
  readonly reach: string | null;
  readonly evidence: string;
  readonly remediation: string;
  /** A sample, already capped by the aggregator. */
  readonly affected: readonly PdfAffectedPage[];
  /** Said aloud when the sample is shorter than the true total. */
  readonly affectedNote: string | null;
  readonly commentary: PdfCommentary | null;
  /**
   * What the finding means, why it matters, what may follow, the steps and who
   * fixes it. Null for a passing ("good") finding, which is not a problem to
   * fix, and for a rule with no written explanation.
   */
  readonly explainer: PdfExplainer | null;
  /**
   * The measured rows this finding rests on, taken from the same fact builders
   * as the measured-facts section (response headers already removed). Null when
   * the finding's own evidence and affected pages already say everything.
   */
  readonly evidencePanel: PdfEvidencePanel | null;
  /**
   * The figures for "found on {affected} of {evaluated} pages", or null. Present
   * only for a page finding whose crawl counts reconciled; `evaluated` is the
   * pages this rule ran on, not the pages the audit read.
   */
  readonly scopeCounts: PdfScopeCounts | null;
  /** Whether the affected list is shorter than the true total. No figure is carried. */
  readonly truncated: boolean;
  /** The domain a site finding applies to, or null when it is unknown or not a site finding. */
  readonly scopeDomain: string | null;
  /** Which evidence heading applies: the whole domain, the one page read, or an example page. */
  readonly evidenceKind: PdfEvidenceKind;
}

export interface PdfScopeCounts {
  readonly affected: number;
  readonly evaluated: number;
}

export type PdfEvidenceKind = "site" | "onePage" | "examplePage";

/**
 * One check's line in a category's check list, as a status rather than a
 * sentence: the renderer supplies the approved label and wording.
 *
 *   issue        a finding exists for this rule
 *   no-issue     the rule is known to have run, was skipped nowhere and found nothing
 *   partly       a page rule that ran on some pages and was skipped on others
 *   not-checked  anything else: the rule did not run, or that it ran cannot be shown
 */
export type PdfChecklistStatus = "issue" | "no-issue" | "partly" | "not-checked";

export interface PdfChecklistItem {
  readonly ruleId: string;
  readonly scope: FindingScope;
  readonly status: PdfChecklistStatus;
  /** The finding's own title, for an issue; null otherwise. */
  readonly findingTitle: string | null;
}

/**
 * One category's check list. A list of these rather than an object keyed by
 * category, so no raw block's name ("seo", say) ever appears as a document key.
 */
export interface PdfChecklist {
  readonly category: "seo" | "security" | "technical";
  readonly items: readonly PdfChecklistItem[];
}

/** The crawl's counts, carried only when they reconciled. */
export interface PdfCoverageCounts {
  readonly discovered: number;
  readonly evaluated: number;
  readonly unavailable: number;
  /** Addresses found that were not web pages (n). */
  readonly notWebPages: number;
  /** Found but not visited before the audit stopped (r). */
  readonly notVisited: number;
  readonly robotsExcluded: number;
  readonly includesStartingAddress: boolean;
}

/** What may be said about the crawl without any figure. */
export interface PdfCoverageFlags {
  readonly partial: boolean;
  /** Whether robots.txt kept any address from being visited. The count is not carried here. */
  readonly hasExclusions: boolean;
}

/** Settings, not measurements: shown whether or not the counts reconciled. */
export interface PdfConfiguredLimits {
  readonly maxPages: number;
  readonly maxDurationMs: number;
}

/** robots.txt and the sitemap as the audit found them. */
export interface PdfTechnicalFiles {
  readonly robots: SiteFileStatus;
  readonly sitemap: SiteFileStatus;
}

/** Measured rows shown under a finding, so its evidence sits beside it. */
export interface PdfEvidencePanel {
  /** "Measured for the whole site" or "Measured on the main page checked". */
  readonly heading: string;
  readonly facts: readonly PdfFact[];
}

export interface PdfFindingGroup {
  readonly category: Category;
  readonly label: string;
  readonly findings: readonly PdfFinding[];
}

export interface PdfFindingSection {
  readonly heading: string;
  readonly intro: string;
  readonly count: number;
  readonly groups: readonly PdfFindingGroup[];
}

export interface PdfSkippedGroup {
  readonly checks: readonly string[];
  readonly reason: string;
}

export interface PdfSkipped {
  readonly heading: string;
  readonly intro: string;
  readonly count: number;
  readonly groups: readonly PdfSkippedGroup[];
}

export interface PdfMetric {
  readonly label: string;
  /** Display-ready, or null where the panel shows nothing. */
  readonly value: string | null;
  /** "Good", "Needs work", "Poor". Null when the metric carries no rating. */
  readonly rating: string | null;
}

/**
 * The speed section, which is present whatever happened.
 *
 * `measured: false` IS NOT A FAILURE. It covers a check nobody asked for, one
 * still running, one with no key configured, and one that errored, and the
 * message says which. None of them says anything about the website.
 */
export type PdfSpeed =
  | {
      readonly measured: false;
      readonly status: AuditData["performance"]["status"];
      readonly message: string;
    }
  | {
      readonly measured: true;
      readonly status: AuditData["performance"]["status"];
      /** "Mobile" or "Desktop", read from the result rather than assumed. */
      readonly device: string | null;
      /** Google's own overall verdict on real visits. Null when it gave none. */
      readonly overall: string | null;
      readonly fieldAvailable: boolean;
      readonly field: readonly PdfMetric[];
      readonly labAvailable: boolean;
      readonly labScore: number | null;
      readonly lab: readonly PdfMetric[];
      /** What the speed check cannot tell you. */
      readonly notInspected: readonly string[];
    };

export interface PdfDocument {
  /** The document's own labels. The same six strings in every document. */
  readonly labels: PdfLabels;
  readonly cover: PdfCover;
  readonly coverage: PdfCoverage;
  /** The deterministic grade, read from `result.score`. Never recomputed here. */
  readonly score: PdfScore;
  readonly summary: PdfSummary;
  /**
   * The client-facing AI summary, in five plain-English sections. Built from the
   * same validated answer and the same measured findings the sections below use;
   * no second model call is made for the PDF (7A §9).
   */
  readonly clientSummary: ClientAiSummary;
  /**
   * The overall summary, written by code from the verified audit: scope, each
   * area's condition, strengths, priorities, limitations, what this audit does
   * not check, and how Skybook can help. Present with or without an AI answer.
   * Null only for the certificate-failure document, which explains its own case.
   */
  readonly overallSummary: OverallSummary | null;
  readonly siteFindings: PdfFindingSection;
  readonly pageFindings: PdfFindingSection;
  /** Null when nothing was skipped, which is when the panel is not shown. */
  readonly skipped: PdfSkipped | null;
  readonly speed: PdfSpeed;
  /**
   * The separately measured DESKTOP speed, when one was filed against this
   * audit. Never graded and never part of the score; shown beside mobile.
   */
  readonly desktopSpeed: PdfSpeed | null;
  /** The measured facts, in the order the results page shows them. */
  readonly measured: readonly PdfFactSection[];
  readonly coverageDetail: readonly PdfFactSection[];

  /**
   * Whether the crawl's counts reconcile, worked out once for the whole
   * document. Null when there is no crawl of pages to check: a certificate
   * failure read no page.
   */
  readonly coverageCheck: CoverageCheck | null;
  /** Null unless `coverageCheck` passed. */
  readonly coverageCounts: PdfCoverageCounts | null;
  readonly coverageFlags: PdfCoverageFlags;
  readonly configuredLimits: PdfConfiguredLimits;
  /** True only when the counts reconciled and the audit read exactly one page (CP3-Q20). */
  readonly singlePageAudit: boolean;
  /** SEO, Security and Technical, in that order. Speed has no check list. */
  readonly checklists: readonly PdfChecklist[];
  /**
   * The speed findings, for the cards that follow the Speed section. They are
   * still in `pageFindings` too, until the renderer moves them.
   */
  readonly speedFindings: readonly PdfFinding[];
  /** Null when the technical checks did not run. */
  readonly technicalFiles: PdfTechnicalFiles | null;
}

// ---------------------------------------------------------------------------
// What can come back
// ---------------------------------------------------------------------------

/**
 * Why no document could be prepared.
 *
 * None of these is a fault in the website, and none may be rendered as one.
 */
export type PdfDocumentRefusal =
  /** No such job. Unknown and expired cannot be told apart, and are not. */
  | "unknown-job"
  /** Still running, or it failed. There is no finished report to describe. */
  | "not-finished"
  /**
   * Terminal and successful, and yet no result.
   *
   * The store writes the result in the same step that sets the status, so this
   * does not happen today. It is handled rather than asserted away because a
   * blind non-null here would print an empty report as though it were an
   * audit, and the response helper already guards the same case the same way.
   */
  | "no-result";

export type PdfDocumentOutcome =
  | { readonly ok: true; readonly document: PdfDocument }
  | { readonly ok: false; readonly reason: PdfDocumentRefusal };

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * The commentary for one rule, when a validated answer carried any.
 *
 * MATCHED BY RULE ID, NEVER MERGED. An entry naming a rule that is not on the
 * report finds no finding and renders nothing; there is no card for it to
 * appear on and none is created. The validator has already refused entries for
 * rules that did not fire, so this is the second place that cannot invent one.
 */
function commentaryFor(
  explanation: ExplainResult | null,
): ReadonlyMap<string, PdfCommentary> {
  if (explanation === null || explanation.state !== "explained") return new Map();

  return new Map(
    explanation.explanations.explanations.map((entry) => [
      entry.ruleId,
      {
        explanation: entry.explanation,
        businessImpact: entry.businessImpact,
        recommendation: entry.recommendation,
      },
    ]),
  );
}

/**
 * What a finding's document fields depend on beyond the finding itself, worked
 * out once per document so every card reads the same answer.
 */
interface FindingContext {
  readonly check: CoverageCheck | null;
  readonly singlePageAudit: boolean;
  readonly domains: SiteDomains;
}

/**
 * The domains a site finding can apply to, each read from a measured field and
 * null when that field holds nothing usable. Never guessed from another field.
 */
interface SiteDomains {
  /** The mail domain the SPF and DMARC records were looked up for. */
  readonly email: string | null;
  /** The host the certificate check read. */
  readonly certificate: string | null;
  /** The host of the address audited, where robots.txt lives. */
  readonly site: string | null;
}

/** A hostname as measured, or null when the value is empty or not a hostname at all. */
function domainOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  /*
   * AN IP ADDRESS IS NOT A DOMAIN (CP3-O4). Every label all digits is an IPv4
   * address in some form -- dotted, shortened, or with a trailing dot -- and is
   * treated as unknown. IPv6 never matches the pattern below.
   */
  if (/^\d+(\.\d+)*\.?$/.test(trimmed)) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/i.test(trimmed) ? trimmed : null;
}

/** The host of an address, or null when the address cannot be parsed. */
function hostOf(address: string): string | null {
  try {
    return domainOrNull(new URL(address).hostname);
  } catch {
    return null;
  }
}

/** Which measured domain each site rule speaks about (CP3-F13-Q3). */
function scopeDomainFor(ruleId: string, domains: SiteDomains): string | null {
  if (ruleId === "security.dns.spf" || ruleId === "security.dns.dmarc") return domains.email;
  if (ruleId.startsWith("security.ssl.")) return domains.certificate;
  if (ruleId === "technical.robots.blocks-all") return domains.site;
  return null;
}

/**
 * One finding, worded by the report layer.
 *
 * EVERY VALUE IS COPIED, NEVER COMPUTED. The severity is the rule's own; the
 * reach comes from the server's counts through `affectedViewFor`, which gives a
 * site finding no denominator and hides every figure when the crawl's counts
 * did not reconcile; the sample is the aggregator's, already capped. The one
 * comparison made here -- whether the sample is shorter than the true total --
 * yields a yes or no, never a number.
 */
function toFinding(
  finding: Finding,
  scope: FindingScope,
  commentary: ReadonlyMap<string, PdfCommentary>,
  panels: ReadonlyMap<string, PdfEvidencePanel>,
  context: FindingContext,
): PdfFinding {
  const reach = affectedViewFor(finding, context.check);
  const counted =
    scope === "page" &&
    context.check !== null &&
    context.check.valid &&
    finding.affectedCount !== undefined &&
    finding.evaluatedPages !== undefined;

  return {
    ruleId: finding.id,
    title: finding.title,
    category: finding.category,
    categoryLabel: categoryLabel(finding.category),
    severity: finding.severity,
    severityLabel: severityLabel(finding.severity),
    scope,
    scopeLabel: scopeLabel(scope),
    reach: reach.reach,
    evidence: finding.evidence,
    remediation: finding.remediation,
    affected: reach.pages.map((page) => ({ url: page.url, evidence: page.evidence })),
    affectedNote: reach.sample,
    commentary: commentary.get(finding.id) ?? null,
    explainer: explainerView(finding),
    evidencePanel: finding.severity === "good" ? null : (panels.get(finding.id) ?? null),
    scopeCounts: counted ? { affected: finding.affectedCount!, evaluated: finding.evaluatedPages! } : null,
    truncated: (finding.affectedCount ?? 0) > (finding.affected ?? []).length,
    scopeDomain: scope === "site" ? scopeDomainFor(finding.id, context.domains) : null,
    evidenceKind: scope === "site" ? "site" : context.singlePageAudit ? "onePage" : "examplePage",
  };
}

/**
 * The measured rows behind each kind of finding, built once per document.
 *
 * SAME BUILDERS AS THE MEASURED-FACTS SECTION, so a value under a finding can
 * never disagree with the same value in the tables. Security rows come from
 * `securitySection`, which has already taken the response headers back out:
 * a document that leaves the building never prints a raw header.
 *
 * Only for findings whose evidence lives in a site-level or main-page
 * measurement. Page findings about content keep their per-page evidence in the
 * affected-pages list, and speed findings have the speed section.
 */
function evidencePanels(
  data: AuditData,
  crawl: SiteAuditResult["crawl"],
): ReadonlyMap<string, PdfEvidencePanel> {
  const site = EVIDENCE_PANEL_HEADINGS.site;
  const mainPage = EVIDENCE_PANEL_HEADINGS.mainPage;
  const security = securitySection(data.security).facts;
  const securityRow = (label: string) => security.filter((row) => row.label === label);

  const panels = new Map<string, PdfEvidencePanel>();
  const add = (ids: readonly string[], heading: string, facts: readonly PdfFact[]) => {
    if (facts.length === 0) return;
    for (const id of ids) panels.set(id, { heading, facts });
  };
  add(["security.ssl.expired", "security.ssl.hostname", "security.ssl.untrusted"], site, certificateFacts(data.ssl));
  add(["security.dns.spf"], site, spfFacts(data.dns));
  add(["security.dns.dmarc"], site, dmarcFacts(data.dns));
  add(["technical.robots.blocks-all"], site, robotsFacts(crawl, data.technical));
  add(["security.headers.hsts"], mainPage, securityRow(SECURITY_FACT_LABELS.hsts));
  add(["security.headers.csp"], mainPage, securityRow(SECURITY_FACT_LABELS.csp));
  add(["security.cookies.secure", "security.cookies.httponly"], mainPage, securityRow(SECURITY_FACT_LABELS.cookies));
  return panels;
}

/** The written explanation for a problem finding. Passing checks get none. */
function explainerView(finding: Finding): PdfExplainer | null {
  if (finding.severity === "good") return null;
  const entry = explainerFor(finding.id);
  if (entry === null) return null;
  return {
    whatItMeans: entry.whatItMeans,
    whyItMatters: entry.whyItMatters,
    possibleImpact: entry.possibleImpact,
    steps: entry.steps,
    whoFixes: whoFixesLabel(entry),
    whatFixingAchieves: entry.whatFixingAchieves,
  };
}

/**
 * One scope's findings, grouped by the subject each rule declared.
 *
 * ORDER IS THE AGGREGATOR'S, carried through: worst first, then rule id, with
 * `groupByCategory` ordering the groups the same way the results page does.
 * The same audit therefore always produces the same document.
 */
function toSection(
  findings: readonly Finding[],
  scope: FindingScope,
  heading: string,
  intro: string,
  commentary: ReadonlyMap<string, PdfCommentary>,
  panels: ReadonlyMap<string, PdfEvidencePanel>,
  context: FindingContext,
): PdfFindingSection {
  return {
    heading,
    intro,
    count: findings.length,
    groups: groupByCategory(findings).map((group) => ({
      category: group.category,
      label: group.label,
      findings: group.findings.map((finding) => toFinding(finding, scope, commentary, panels, context)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Check lists
// ---------------------------------------------------------------------------

/** The categories that have a check list, each listing its rules in registry order. Speed has none. */
const CHECKLIST_CATEGORIES = ["seo", "security", "technical"] as const;

/**
 * Every check-list line, as a status (CP3 revision 9, §1.9).
 *
 * BUILT FROM STRUCTURE ONLY: which findings exist, which rules have a skipped
 * entry, which rules the ledger says ran, each rule's declared scope, and
 * whether this is a certificate failure. The words a skipped entry carries are
 * never read here, so no status can depend on how a reason happens to be
 * phrased.
 *
 * NEVER A PASS WITHOUT EVIDENCE. "no-issue" needs the ledger to name the rule.
 * A stored audit that predates the ledger cannot show that a silent rule ran,
 * so such a rule reads "not-checked" rather than borrowing a pass.
 */
function checklistsFor(
  findings: readonly Finding[],
  skippedChecks: readonly SkippedCheck[],
  ranRules: readonly string[] | undefined,
  certificateFailure: boolean,
): PdfChecklist[] {
  const issues = new Map<string, Finding>();
  for (const finding of findings) {
    if (finding.severity !== "good" && !issues.has(finding.id)) issues.set(finding.id, finding);
  }
  const skippedIds = new Set(skippedChecks.map((entry) => entry.ruleId));
  const ranIds = ranRules === undefined ? null : new Set(ranRules);

  const statusOf = (ruleId: string, scope: FindingScope): PdfChecklistStatus => {
    if (certificateFailure && scope === "page") return "not-checked";
    if (issues.has(ruleId)) return "issue";
    if (ranIds === null || !ranIds.has(ruleId)) return "not-checked";
    if (skippedIds.has(ruleId)) return scope === "page" ? "partly" : "not-checked";
    return "no-issue";
  };

  return CHECKLIST_CATEGORIES.map((category) => ({
    category,
    items: AUDIT_RULES.filter((rule) => rule.category === category).map((rule) => {
      const status = statusOf(rule.id, rule.scope);
      return {
        ruleId: rule.id,
        scope: rule.scope,
        status,
        findingTitle: status === "issue" ? (issues.get(rule.id)?.title ?? null) : null,
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Coverage, safe to show
// ---------------------------------------------------------------------------

/** The crawl's counts, only when the shared check says they reconcile. */
function coverageCountsFor(crawl: SiteAuditResult["crawl"], check: CoverageCheck | null): PdfCoverageCounts | null {
  if (check === null || !check.valid) return null;
  const unavailable = crawl.unavailable.length;
  return {
    discovered: crawl.discovered,
    evaluated: crawl.evaluated,
    unavailable,
    notWebPages: crawl.skippedNonHtml,
    notVisited: crawl.discovered - crawl.evaluated - unavailable - crawl.skippedNonHtml,
    robotsExcluded: crawl.robots.excluded,
    includesStartingAddress: check.includesStartingAddress,
  };
}

function technicalFilesFrom(technical: AuditData["technical"] | null): PdfTechnicalFiles | null {
  return technical === null ? null : { robots: technical.robotsTxtStatus, sitemap: technical.sitemapStatus };
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/**
 * The speed section, from whatever state the check ended in.
 *
 * READS THE STORED MEASUREMENT ONLY. Nothing here starts a check, and a check
 * that never ran is reported as not having run rather than as a slow site.
 *
 * EVERY STRING BELOW COMES FROM THE REPORT LAYER. Nothing is worded, rounded
 * or abbreviated here; this decides which measurements the document carries
 * and in what shape, and the report layer decides how each one reads.
 */
function toSpeed(performance: AuditData["performance"]): PdfSpeed {
  if (performance.status !== "checked") {
    return {
      measured: false,
      status: performance.status,
      // The collector's own sentence, which already says which state this is.
      message: performance.message,
    };
  }

  const field = performance.field;
  const lab = performance.lab;

  const fieldMetric = (
    label: string,
    value: string | null,
    rating?: PerformanceRating,
  ): PdfMetric => ({
    label,
    value: value ?? METRIC_NOT_REPORTED,
    rating: rating === undefined ? null : ratingLabel(rating),
  });

  return {
    measured: true,
    status: performance.status,
    device: strategyLabel(performance.strategy),
    overall: fieldOverallText(field),
    fieldAvailable: field.status === "found",
    field:
      field.status === "found"
        ? [
            fieldMetric("LCP", metricDurationText(field.lcp?.percentileMs), field.lcp?.category),
            fieldMetric("INP", metricDurationText(field.inp?.percentileMs), field.inp?.category),
            fieldMetric("CLS", fieldShiftText(field.cls), field.cls?.category),
            fieldMetric("FCP", metricDurationText(field.fcp?.percentileMs), field.fcp?.category),
            fieldMetric("TTFB", metricDurationText(field.ttfb?.percentileMs), field.ttfb?.category),
          ]
        : [],
    labAvailable: lab.status !== "error",
    labScore: lab.score,
    lab:
      lab.status === "error"
        ? []
        : [
            { label: "LCP", value: metricDurationText(lab.lcpMs), rating: null },
            { label: "FCP", value: metricDurationText(lab.fcpMs), rating: null },
            { label: "TBT", value: metricDurationText(lab.tbtMs), rating: null },
            { label: "Speed Index", value: metricDurationText(lab.speedIndexMs), rating: null },
            { label: "CLS", value: labShiftText(lab.cls), rating: null },
          ],
    notInspected: [...performance.notInspected],
  };
}

// ---------------------------------------------------------------------------
// Measured facts
// ---------------------------------------------------------------------------

/** The entry page's own content measurements. */
function contentSection(data: AuditData): PdfFactSection {
  return {
    heading: "Measured facts",
    facts: [...contentFacts(data.seo), ...certificateProblemFacts(data.fetch.certificateProblem)],
  };
}

/**
 * The security rows, with the response headers taken back out.
 *
 * THE ONE PLACE THE DOCUMENT NARROWS A SHARED PRESENTATION, and it is
 * deliberate. The results page shows an HSTS or policy header verbatim so a
 * reader can check our reading of it; a document that leaves the building and
 * is forwarded on has a different rule, and the specification excludes
 * response headers in raw form from it.
 *
 * DROPPED BY MARK, NEVER BY LABEL. The shared builder says which notes are a
 * server's own words. Matching on the label instead would stop matching the
 * day somebody rewords one, and would do it silently.
 *
 * The notes that survive are not header text: cookie names and flags, which
 * the audit never captures a value for, and addresses the crawl measured.
 *
 * ONE VALUE IS NARROWED THE SAME WAY. The row announcing the server's software
 * carries the header text in its VALUE rather than its note, so the mark above
 * never reached it and the build identifier of somebody's infrastructure was
 * printed in a document that gets forwarded. The shared builder now supplies
 * what a document should say instead, and this takes it. Nothing here decides
 * which values are sensitive -- that decision, and the wording, stay with the
 * rest of the report's words.
 */
function securitySection(security: AuditData["security"]): PdfFactSection {
  return {
    heading: "Security",
    facts: securityFacts(security).map((row) => ({
      label: row.label,
      value: row.documentValue ?? row.value,
      note: row.rawHeaderNote ? undefined : row.note,
    })),
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * The document for an audit whose entry page could not be fetched securely.
 *
 * EVERY SECTION THAT WOULD DESCRIBE A PAGE IS ABSENT, and the renderer draws
 * nothing for an absent one. There is no content section, no response-header
 * section and no page findings, because no page was read; there is no AI
 * summary, because nothing was asked. The certificate and the domain records
 * are here because they were measured.
 *
 * THE COVERAGE SECTION IS WHERE THE LIMIT IS STATED, in the report layer's
 * own words, and the cover carries the partial marker as it does for a crawl
 * that stopped early. The crawl's counts are deliberately not shown: a queue
 * that drained after its only address failed reports itself complete, and
 * those numbers beside a finished-looking status would read as a whole-site
 * audit of a site with no pages.
 */
function certificateFailureDocument(
  audit: CertificateFailureAudit,
  client: PdfClient,
): PdfDocument {
  const findings = audit.site.findings;
  const skippedChecks = audit.site.skippedChecks;
  const { site, page } = partitionByScope(findings);
  const state = findingsState(findings.length, skippedChecks.length);
  const coverage = certificateFailureView(audit);

  // No commentary was asked for, so no card carries any.
  const commentary = new Map<string, PdfCommentary>();

  /*
   * NO CRAWL OF PAGES TO CHECK. No page was read, so there are no coverage or
   * finding-scope figures to verify and none is shown -- the dashboard passes
   * the same null for this audit. The domains come from the failure record.
   */
  const context: FindingContext = {
    check: null,
    singlePageAudit: false,
    domains: {
      email: domainOrNull(audit.dns.emailDomain),
      certificate: domainOrNull(audit.ssl.hostname),
      site: hostOf(audit.failedUrl),
    },
  };

  const requested = withoutCredentials(audit.website.requestedUrl);
  const audited = withoutCredentials(audit.failedUrl);

  return {
    labels: documentLabels(),

    cover: {
      client:
        client.companyName === null && client.contactName === null && client.preparedBy === null
          ? EMPTY_CLIENT
          : client,
      auditedUrl: audited,
      // Shown only when the address that failed is not the one asked for,
      // which means the entry page redirected before the failure.
      requestedUrl: requested === audited ? null : requested,
      checkedAt: readableTimestamp(audit.website.checkedAt),
      partial: true,
      statusLine: auditStatusText(false),
    },

    coverage: {
      partial: coverage.partial,
      headline: coverage.headline,
      stopReason: coverage.reason,
      facts: coverage.facts.map((fact) => ({ label: fact.label, value: fact.value })),
    },

    /*
     * A CERTIFICATE FAILURE IS STILL GRADED, on the checks that could run. No
     * page was read, so its page-only categories score as Not Assessed rather
     * than as a made-up pass, and the certificate critical caps the grade at F —
     * the same score the result endpoint and dashboard show for this audit.
     */
    score: toScore(scoreAudit(audit), findings),

    summary: {
      severityCounts: severityCounts(findings).map((entry) => ({
        severity: entry.severity,
        label: entry.label,
        count: entry.count,
      })),
      state,
      stateSentence: findingsHeadline(findings, state),
      ai: null,
    },

    // No commentary was produced for a certificate failure, so the client
    // summary carries only its derived sections.
    clientSummary: buildClientAiSummary(findings, commentary, null),
    overallSummary: null,

    siteFindings: toSection(site, "site", SITE_FINDINGS_HEADING, SITE_FINDINGS_INTRO, commentary, new Map(), context),
    // Empty, and the renderer draws nothing for it. No page was read, so
    // there is no page-level finding and none may be implied.
    pageFindings: toSection(page, "page", PAGE_FINDINGS_HEADING, PAGE_FINDINGS_INTRO, commentary, new Map(), context),

    skipped: showsSkippedPanel(state)
      ? {
          heading: SKIPPED_HEADING,
          intro: SKIPPED_INTRO,
          count: skippedCheckCount(skippedChecks),
          groups: groupSkippedByReason(skippedChecks).map((group) => ({
            checks: [...group.checks],
            reason: group.reason,
          })),
        }
      : null,

    speed: {
      measured: false,
      // Nobody asked Google about this address, and the sentence says why.
      status: "not-requested",
      message: SPEED_NOT_MEASURED_WITHOUT_PAGE,
    },
    desktopSpeed: null,

    measured: [
      {
        heading: "Certificate",
        facts: [
          ...certificateProblemFacts(audit.certificateProblem),
          ...certificateFacts(audit.ssl),
        ],
      },
      {
        heading: "Domain and email records",
        facts: [...dnsFacts(audit.dns), ...spfFacts(audit.dns), ...dmarcFacts(audit.dns)],
      },
    ],

    // Nothing here: every row of it describes a crawl of pages.
    coverageDetail: [],

    coverageCheck: null,
    coverageCounts: null,
    coverageFlags: { partial: true, hasExclusions: audit.crawl.robots.excluded > 0 },
    configuredLimits: { maxPages: audit.crawl.limits.maxPages, maxDurationMs: audit.crawl.limits.maxDurationMs },
    singlePageAudit: false,
    checklists: checklistsFor(findings, skippedChecks, audit.site.ranRules, true),
    // A speed check needs a page to measure, and none was read.
    speedFindings: [],
    technicalFiles: technicalFilesFrom(audit.technical),
  };
}

/**
 * ONE COPY OF EVERY SHARED LABEL, read from the report layer here so the
 * renderer never has to. See `PdfLabels`. Both projections use these: the
 * labels name parts of the document and say nothing about any website, so
 * they are the same six strings whatever the audit found.
 */
function documentLabels(): PdfLabels {
  return {
    remediation: REMEDIATION_LABEL,
    aiSummaryHeading: AI_SUMMARY_HEADING,
    aiProvenance: AI_PROVENANCE,
    aiExplanation: AI_EXPLANATION_LABEL,
    aiImpact: AI_IMPACT_LABEL,
    aiRecommendation: AI_RECOMMENDATION_LABEL,
    speedField: SPEED_FIELD_HEADING,
    speedLab: SPEED_LAB_HEADING,
    speedNotInspected: SPEED_NOT_INSPECTED_HEADING,
  };
}

export interface PdfDocumentOptions {
  readonly companyName?: string;
  readonly contactName?: string;
  readonly preparedBy?: string;
}

/**
 * The severity class that tints one grade.
 *
 * REUSES THE DOCUMENT'S EXISTING, CONTRAST-CHECKED PALETTE rather than inventing
 * five grade colours: A and B are the passing green, C the amber, D the orange,
 * F the red a critical already carries. The grade's own letter and band word
 * carry the meaning in words, so a greyscale print loses nothing.
 */
function gradeClassFor(grade: Grade): string {
  switch (grade) {
    case "A":
    case "B":
      return "tile-good";
    case "C":
      return "tile-medium";
    case "D":
      return "tile-high";
    case "F":
      return "tile-critical";
  }
}

/** The counts are the scorer's own (CP3-Q17), copied rather than re-derived. */
function toScoreCategory(name: Category, label: string, category: CategoryScore): PdfScoreCategory {
  if (category.status !== "assessed") {
    return { label, assessed: false, category: name, ranCount: 0, skippedCount: category.skippedCount };
  }
  return {
    label,
    assessed: true,
    grade: category.grade,
    passRate: category.passRate,
    coveragePercent: coveragePercent(category.coverage),
    gradeClass: gradeClassFor(category.grade),
    category: name,
    ranCount: category.ranCount,
    skippedCount: category.skippedCount,
  };
}

/**
 * The deterministic score, made ready for the page.
 *
 * READS THE SCORE, DECIDES NOTHING. The grade, the pass rate, the coverage and
 * the gated-by ids are the scorer's; the sentences are `scoreView`'s, the same
 * ones the dashboard shows. The one arithmetic is turning a 0–1 coverage into a
 * percentage, exactly as the screen does. The gate titles are looked up in the
 * findings already on the page.
 */
function toScore(score: ScoreResult, findings: readonly Finding[]): PdfScore {
  const reasons = gateReasons(score, findings);
  const capNote =
    reasons.length > 0 && score.grade !== null && score.passRate !== null
      ? `${score.passRate}% of checks passed, but unresolved serious issues cap the grade at ${score.grade}.`
      : null;

  return {
    graded: score.status === "graded",
    grade: score.grade,
    bandLabel: score.grade !== null ? gradeBandLabel(score.grade) : null,
    gradeClass: score.grade !== null ? gradeClassFor(score.grade) : "",
    passRate: score.passRate,
    coveragePercent: coveragePercent(score.coverage),
    statusMessage: scoreStatusMessage(score),
    partialNote: score.partial ? SCORE_PARTIAL_NOTE : null,
    capNote,
    categories: SCORE_CATEGORY_ORDER.map((name) =>
      toScoreCategory(name, categoryLabel(name), score.categories[name]),
    ),
    ranCount: score.ranCount,
    expectedCount: score.ranCount + score.skippedCount,
    gateHeading: GATE_HEADING,
    gateReasons: reasons.map((reason) => reason.title),
    gateNote: reasons.length > 0 ? GATE_NOTE : null,
  };
}

/**
 * Prepares everything the PDF will show, for one finished audit.
 *
 * COMPOSED FROM WHAT THE SERVER MEASURED. The caller supplies a job id and the
 * client's own details; nothing else a browser sends is an input. The speed
 * result is joined by the existing `withSpeed`, which returns a new object and
 * leaves the stored audit untouched -- the same composition the AI path uses.
 *
 * NEVER THROWS FOR AN EXPECTED OUTCOME, and never starts anything. An unknown
 * job, an unfinished one and a finished one with no result are all refusals
 * with a reason; none of them is a fault in the website.
 */
export function buildPdfDocument(
  jobId: string,
  store: AuditJobStore,
  options: PdfDocumentOptions = {},
): PdfDocumentOutcome {
  const job = store.get(jobId);
  if (job === null) return { ok: false, reason: "unknown-job" };

  const finished = job.status === "completed" || job.status === "partial";
  if (!finished) return { ok: false, reason: "not-finished" };

  /*
   * DEFENSIVE, NOT DECORATIVE. The store writes the result in the same step
   * that sets a successful status, so this cannot happen today. It is checked
   * because a blind assertion would print an empty document as though it were
   * an audit, and because the store's own type still permits null.
   */
  if (job.result === null) return { ok: false, reason: "no-result" };

  const client: PdfClient = {
    companyName: clientField(options.companyName),
    contactName: clientField(options.contactName),
    preparedBy: clientField(options.preparedBy),
  };

  /*
   * AN AUDIT THAT COULD NOT READ A PAGE IS TYPESET FROM WHAT IT DID MEASURE.
   * Its own projection, below, because there is no entry page to read the
   * content, security and speed sections from -- and inventing empty ones to
   * fill the shape is what this file exists to prevent.
   */
  if (isCertificateFailureAudit(job.result)) {
    return { ok: true, document: certificateFailureDocument(job.result, client) };
  }

  const whole: SiteAuditResult = withSpeed(job.result, job.attached);
  const data = whole.data;
  const crawl = whole.crawl;

  const findings = whole.site.findings;
  const skippedChecks = whole.site.skippedChecks;
  const { site, page } = partitionByScope(findings);

  const commentary = commentaryFor(job.explanation);
  const panels = evidencePanels(data, crawl);
  const state = findingsState(findings.length, skippedChecks.length);
  const coverage = crawlView(crawl);

  /*
   * ONE CHECK OF THE CRAWL'S COUNTS FOR THE WHOLE DOCUMENT. Every coverage or
   * finding-scope figure below is filled from it, so no two parts of the report
   * can disagree about whether those counts may be shown.
   */
  const check = coverageCheck(crawl);
  const singlePageAudit = check.valid && check.pagesRead === 1;
  const context: FindingContext = {
    check,
    singlePageAudit,
    domains: {
      email: domainOrNull(data.dns.emailDomain),
      certificate: domainOrNull(data.ssl.hostname),
      site: hostOf(data.fetch.finalUrl),
    },
  };

  const aiSummary: PdfAiSummary | null =
    job.explanation !== null && job.explanation.state === "explained"
      ? {
          executiveSummary: job.explanation.explanations.executiveSummary,
          partial: job.explanation.partial,
          rejectedCount: job.explanation.rejected.length,
          rejectedNote: rejectedNote(job.explanation.rejected.length),
          coverageNote: coverageNote(findings.length, MAX_EXPLAINED_FINDINGS),
        }
      : null;

  const labels = documentLabels();

  /*
   * THE GRADE, TAKEN FROM THE WHOLE AUDIT EXACTLY AS THE DASHBOARD TAKES IT.
   * `whole` is already `withSpeed(job.result, job.attached)`, so scoring it
   * here gives the identical `ScoreResult` the result endpoint attaches and
   * the dashboard shows. Nothing is recomputed differently for the PDF, and the
   * overall summary quotes this same grade rather than working out its own.
   */
  const score = toScore(scoreAudit(whole), findings);

  return {
    ok: true,
    document: {
      labels,
      cover: {
        client: client.companyName === null && client.contactName === null && client.preparedBy === null
          ? EMPTY_CLIENT
          : client,
        /*
         * CREDENTIALS STRIPPED, using the projection's own helper. These two
         * addresses do not pass through the crawler's normalisation, which is
         * where that removal happens for every other address in the report.
         */
        auditedUrl: withoutCredentials(data.fetch.finalUrl),
        requestedUrl: data.fetch.wasRedirected
          ? withoutCredentials(data.website.requestedUrl)
          : null,
        /*
         * PHRASED HERE, BY THE REPORT LAYER, using the same helper the rest of
         * the report's dates go through. The renderer receives the sentence.
         */
        checkedAt: readableTimestamp(data.website.checkedAt),
        partial: !crawl.complete,
        statusLine: auditStatusText(crawl.complete),
      },

      coverage: {
        partial: coverage.partial,
        headline: coverage.headline,
        stopReason: coverage.reason,
        facts: coverage.facts.map((fact) => ({ label: fact.label, value: fact.value })),
      },

      score,

      summary: {
        severityCounts: severityCounts(findings).map((entry) => ({
          severity: entry.severity,
          label: entry.label,
          count: entry.count,
        })),
        state,
        stateSentence: findingsHeadline(findings, state),
        ai: aiSummary,
      },

      /*
       * THE SAME VALIDATED ANSWER, RESHAPED FOR A CLIENT. Built from the findings
       * and the commentary already in hand -- no second model call. Overall
       * summary, key findings and recommendations are the model's validated prose;
       * "what we checked" and "next steps" are derived from the measured findings.
       */
      clientSummary: buildClientAiSummary(findings, commentary, aiSummary?.executiveSummary ?? null),

      overallSummary: buildOverallSummary({
        auditedUrl: withoutCredentials(data.fetch.finalUrl),
        checkedAt: readableTimestamp(data.website.checkedAt),
        data,
        crawl,
        findings,
        skippedChecks,
        ranRules: whole.site.ranRules ?? null,
        grade: score.grade,
        gradeLabel: score.bandLabel,
        desktop: job.desktop,
        // The same check as every other figure in the document (CP3-Q11).
        coverage: check,
      }),

      siteFindings: toSection(
        site,
        "site",
        SITE_FINDINGS_HEADING,
        SITE_FINDINGS_INTRO,
        commentary,
        panels,
        context,
      ),
      pageFindings: toSection(
        page,
        "page",
        PAGE_FINDINGS_HEADING,
        PAGE_FINDINGS_INTRO,
        commentary,
        panels,
        context,
      ),

      skipped: showsSkippedPanel(state)
        ? {
            heading: SKIPPED_HEADING,
            intro: SKIPPED_INTRO,
            count: skippedCheckCount(skippedChecks),
            groups: groupSkippedByReason(skippedChecks).map((group) => ({
              checks: [...group.checks],
              reason: group.reason,
            })),
          }
        : null,

      speed: toSpeed(data.performance),
      desktopSpeed: job.desktop === null ? null : toSpeed(job.desktop),

      measured: [
        contentSection(data),
        securitySection(data.security),
        { heading: "Certificate", facts: certificateFacts(data.ssl) },
        {
          heading: "Domain and email records",
          facts: [...dnsFacts(data.dns), ...spfFacts(data.dns), ...dmarcFacts(data.dns)],
        },
      ],

      coverageDetail: [
        {
          heading: "Crawl coverage",
          facts: crawlCountTiles(crawl).map((tile) => ({ label: tile.label, value: tile.value })),
        },
        {
          heading: "Crawl status",
          facts: [
            { label: "Crawl status", value: crawlStatusText(crawl) },
            /*
             * ONLY FOR AN INCOMPLETE CRAWL. A stop reason explains why the crawl
             * ended early, so a complete crawl has none to show. `crawlView`
             * applies the same condition.
             */
            ...(crawl.complete ? [] : [{ label: "Stopped because", value: stopReasonText(crawl) }]),
            /*
             * COUNTS FROM THE SAME CRAWL, so shown only when that crawl's counts
             * reconciled. These two rows have no check of their own; leaving them
             * out here keeps the shared fact builders unchanged.
             */
            ...(check.valid ? discoverySourceFacts(crawl) : []),
            ...(check.valid ? sitemapDiscoveryFacts(crawl) : []),
            ...robotsFacts(crawl, data.technical),
          ],
        },
        { heading: "Audit limits", facts: crawlLimitFacts(crawl.limits) },
      ],

      coverageCheck: check,
      coverageCounts: coverageCountsFor(crawl, check),
      coverageFlags: { partial: !crawl.complete, hasExclusions: crawl.robots.excluded > 0 },
      configuredLimits: { maxPages: crawl.limits.maxPages, maxDurationMs: crawl.limits.maxDurationMs },
      singlePageAudit,
      checklists: checklistsFor(findings, skippedChecks, whole.site.ranRules, false),
      speedFindings: findings
        .filter((finding) => finding.category === "speed")
        .map((finding) => toFinding(finding, "page", commentary, panels, context)),
      technicalFiles: technicalFilesFrom(data.technical),
    },
  };
}

