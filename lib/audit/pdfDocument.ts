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
import type { AuditJobStore } from "../jobs/auditJobs.ts";
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
  affectedView,
  auditStatusText,
  crawlView,
  partitionByScope,
  scopeLabel,
  stopReasonText,
  type FindingScope,
} from "../report/siteFindingsView.ts";
import {
  AI_EXPLANATION_LABEL,
  AI_IMPACT_LABEL,
  AI_PROVENANCE,
  AI_RECOMMENDATION_LABEL,
  AI_SUMMARY_HEADING,
  rejectedNote,
} from "../report/commentaryView.ts";
import {
  SKIPPED_HEADING,
  SKIPPED_INTRO,
  findingsState,
  findingsSummary,
  showsSkippedPanel,
  type FindingsState,
} from "../report/findingsState.ts";
import type {
  AuditData,
  Category,
  Finding,
  PerformanceRating,
  Severity,
  SiteAuditResult,
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
  /** The clean-state sentence, or empty when the findings speak for themselves. */
  readonly stateSentence: string;
  readonly ai: PdfAiSummary | null;
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
  readonly summary: PdfSummary;
  readonly siteFindings: PdfFindingSection;
  readonly pageFindings: PdfFindingSection;
  /** Null when nothing was skipped, which is when the panel is not shown. */
  readonly skipped: PdfSkipped | null;
  readonly speed: PdfSpeed;
  /** The measured facts, in the order the results page shows them. */
  readonly measured: readonly PdfFactSection[];
  readonly coverageDetail: readonly PdfFactSection[];
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
 * One finding, worded by the report layer.
 *
 * EVERY VALUE IS COPIED, NEVER COMPUTED. The severity is the rule's own; the
 * reach comes from the server's counts through `affectedView`, which gives a
 * site finding no denominator; the sample is the aggregator's, already capped.
 * Nothing here counts the sample array to produce a total.
 */
function toFinding(
  finding: Finding,
  scope: FindingScope,
  commentary: ReadonlyMap<string, PdfCommentary>,
): PdfFinding {
  const reach = affectedView(finding);

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
): PdfFindingSection {
  return {
    heading,
    intro,
    count: findings.length,
    groups: groupByCategory(findings).map((group) => ({
      category: group.category,
      label: group.label,
      findings: group.findings.map((finding) => toFinding(finding, scope, commentary)),
    })),
  };
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
 */
function securitySection(security: AuditData["security"]): PdfFactSection {
  return {
    heading: "Security",
    facts: securityFacts(security).map((row) => ({
      label: row.label,
      value: row.value,
      note: row.rawHeaderNote ? undefined : row.note,
    })),
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export interface PdfDocumentOptions {
  readonly companyName?: string;
  readonly contactName?: string;
  readonly preparedBy?: string;
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

  const whole: SiteAuditResult = withSpeed(job.result, job.attached);
  const data = whole.data;
  const crawl = whole.crawl;

  const findings = whole.site.findings;
  const skippedChecks = whole.site.skippedChecks;
  const { site, page } = partitionByScope(findings);

  const commentary = commentaryFor(job.explanation);
  const state = findingsState(findings.length, skippedChecks.length);
  const coverage = crawlView(crawl);

  const aiSummary: PdfAiSummary | null =
    job.explanation !== null && job.explanation.state === "explained"
      ? {
          executiveSummary: job.explanation.explanations.executiveSummary,
          partial: job.explanation.partial,
          rejectedCount: job.explanation.rejected.length,
          rejectedNote: rejectedNote(job.explanation.rejected.length),
        }
      : null;

  const client: PdfClient = {
    companyName: clientField(options.companyName),
    contactName: clientField(options.contactName),
    preparedBy: clientField(options.preparedBy),
  };

  /*
   * ONE COPY OF EVERY SHARED LABEL, read from the report layer here so the
   * renderer never has to. See `PdfLabels`.
   */
  const labels: PdfLabels = {
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

      summary: {
        severityCounts: severityCounts(findings).map((entry) => ({
          severity: entry.severity,
          label: entry.label,
          count: entry.count,
        })),
        state,
        stateSentence: findingsSummary(state),
        ai: aiSummary,
      },

      siteFindings: toSection(
        site,
        "site",
        SITE_FINDINGS_HEADING,
        SITE_FINDINGS_INTRO,
        commentary,
      ),
      pageFindings: toSection(
        page,
        "page",
        PAGE_FINDINGS_HEADING,
        PAGE_FINDINGS_INTRO,
        commentary,
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
            { label: "Stopped because", value: stopReasonText(crawl) },
            ...discoverySourceFacts(crawl),
            ...sitemapDiscoveryFacts(crawl),
            ...robotsFacts(crawl, data.technical),
          ],
        },
        { heading: "Audit limits", facts: crawlLimitFacts(crawl.limits) },
      ],
    },
  };
}

