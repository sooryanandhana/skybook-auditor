/**
 * One prepared document, shared by the renderer tests.
 *
 * NOT A TEST FILE and shipped nowhere: only `*.test.mts` imports it, and it
 * holds no assertions. It exists so the shell, cover, findings and browser
 * tests argue about the same document.
 *
 * IT IS DELIBERATELY HOSTILE. The audited site's own title, its evidence and
 * one of its addresses are written the way an attacker would write them,
 * because a fixture of polite data proves only that polite data is safe. The
 * renderer builds HTML, so a fixture that never contains a tag would never
 * exercise the one thing that choosing a browser cost us.
 *
 * IT CARRIES BOTH SCOPES AND BOTH COMMENTARY STATES. One site-wide finding
 * with no commentary and no reach, one page-level finding with a reach line,
 * affected pages and commentary. Those are the four combinations the findings
 * section has to get right, and a fixture with only one of them would let
 * three of them break quietly.
 */
import type { PdfDocument } from "../pdfDocument.ts";

/** Markup an audited page could genuinely serve, and a model could echo back. */
export const HOSTILE = '<script>fetch("https://evil.example")</script>';

/** A sentinel that appears nowhere in this file except as document content. */
export const SENTINEL = "ZZQQ-RENDERER-SENTINEL";

/** The rule ids the fixture's findings carry, in the order they are rendered. */
export const FIXTURE_RULE_IDS = ["security.dns.spf.missing", "seo.meta-description.missing"] as const;

export function testDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    labels: {
      remediation: "What to do",
      aiSummaryHeading: "AI summary",
      aiProvenance:
        "Written by AI from the findings below. The findings, their severities " +
        "and every number in this report were measured by this tool.",
      aiExplanation: "AI explanation",
      aiImpact: "Why it matters",
      aiRecommendation: "Suggested next step",
      speedField: "Real visitors",
      speedLab: "Simulated load",
      speedNotInspected: "What this does not cover",
    },
    cover: {
      client: { companyName: "Example Company Ltd", contactName: null, preparedBy: null },
      auditedUrl: "https://example.com/",
      requestedUrl: null,
      // Already a sentence. The projection phrases it; the renderer prints it.
      checkedAt: "8 September 2026 at 10:00 UTC",
      partial: false,
      statusLine: "Website audit complete",
    },
    coverage: {
      partial: false,
      headline: "128 pages read of 128 found",
      stopReason: null,
      facts: [
        { label: "Pages read", value: "128" },
        { label: "Pages found", value: "128" },
        { label: "Excluded by robots.txt", value: "4", note: "Not a fault in the site." },
      ],
    },
    score: {
      graded: true,
      grade: "B",
      bandLabel: "Good",
      gradeClass: "tile-good",
      passRate: 82,
      coveragePercent: 90,
      statusMessage: null,
      partialNote: null,
      capNote: "82% of checks passed, but unresolved serious issues cap the grade at B.",
      categories: [
        {
          assessed: true, label: "Security", grade: "B", passRate: 80, coveragePercent: 83, gradeClass: "tile-good",
          category: "security", ranCount: 10, skippedCount: 2,
        },
        {
          assessed: true, label: "Search visibility", grade: "C", passRate: 62, coveragePercent: 100, gradeClass: "tile-medium",
          category: "seo", ranCount: 10, skippedCount: 0,
        },
        { assessed: false, label: "Speed", category: "speed", ranCount: 0, skippedCount: 0 },
        {
          assessed: true, label: "Technical", grade: "A", passRate: 100, coveragePercent: 100, gradeClass: "tile-good",
          category: "technical", ranCount: 1, skippedCount: 0,
        },
      ],
      ranCount: 21,
      expectedCount: 23,
      gateHeading: "What's holding the grade back",
      gateReasons: ["No SPF record"],
      gateNote:
        "These issues cap the overall grade regardless of how many other checks passed. Fixing them is what lifts it.",
    },
    summary: {
      severityCounts: [
        { severity: "critical", label: "Critical", count: 0 },
        { severity: "high", label: "High", count: 1 },
        { severity: "medium", label: "Medium", count: 1 },
      ],
      state: "findings",
      stateSentence: "",
      ai: {
        executiveSummary: `This site has two issues worth attention. ${SENTINEL}`,
        partial: false,
        rejectedCount: 0,
        rejectedNote: null,
        coverageNote: null,
      },
    },
    clientSummary: {
      overallSummary: `This site has two issues worth attention. ${SENTINEL}`,
      whatWeChecked: [
        "Security — certificates, DNS records and the protections that keep the site and its visitors safe.",
        "Search visibility — the titles, descriptions and page structure that decide how the site appears in search results.",
      ],
      keyFindings: [
        {
          finding: "No SPF record",
          explanation: "Mail servers cannot tell which senders are allowed to use this domain.",
          impact: "Messages from the business are more likely to be treated as spam.",
        },
        {
          finding: "No meta description",
          explanation: "Search engines write their own summary when a page supplies none.",
          impact: "The snippet a customer reads in results is chosen for you.",
        },
      ],
      recommendations: [
        {
          action: "Publish an SPF record for this domain.",
          reason: "Messages from the business are more likely to be treated as spam.",
        },
        {
          action: "Write a description of about 155 characters.",
          reason: "The snippet a customer reads in results is chosen for you.",
        },
      ],
      nextSteps: [
        "Resolve the high-priority issue: No SPF record.",
        "Resolve the medium-priority issue: No meta description.",
      ],
    },
    // Off by default so the long-standing renderer tests see the document they
    // were written against; the overall summary has its own tests.
    overallSummary: null,
    siteFindings: {
      heading: "Site-wide issues",
      intro: "These apply to the whole website.",
      count: 1,
      groups: [
        {
          category: "security",
          label: "Security",
          findings: [
            {
              ruleId: FIXTURE_RULE_IDS[0],
              title: "No SPF record",
              category: "security",
              categoryLabel: "Security",
              severity: "high",
              severityLabel: "High",
              scope: "site",
              scopeLabel: "Site-wide",
              // A site finding has no page denominator and must never be shown one.
              reach: null,
              evidence: `No SPF record was found. ${HOSTILE}`,
              remediation: "Publish an SPF record for this domain.",
              affected: [],
              affectedNote: null,
              commentary: null,
              explainer: null,
              evidencePanel: null,
              scopeCounts: null,
              truncated: false,
              scopeDomain: "example.com",
              evidenceKind: "site",
            },
          ],
        },
      ],
    },
    pageFindings: {
      heading: "Page-level issues",
      intro: "These were found on individual pages.",
      count: 1,
      groups: [
        {
          category: "seo",
          label: "Search visibility",
          findings: [
            {
              ruleId: FIXTURE_RULE_IDS[1],
              title: "No meta description",
              category: "seo",
              categoryLabel: "Search visibility",
              severity: "medium",
              severityLabel: "Medium",
              scope: "page",
              scopeLabel: "Page-level",
              reach: "19 of 128 evaluated pages",
              evidence: "No meta description tag was found.",
              remediation: "Write a description of about 155 characters.",
              affected: [
                { url: "https://example.com/about", evidence: "No meta description tag." },
                { url: "https://example.com/contact", evidence: "No meta description tag." },
              ],
              affectedNote: "Showing 2 of 19 affected pages.",
              commentary: {
                explanation: "Search engines write their own summary when a page supplies none.",
                businessImpact: "The snippet a customer reads is chosen for you.",
                recommendation: "Write a description for each page.",
              },
              explainer: null,
              evidencePanel: null,
              scopeCounts: { affected: 19, evaluated: 128 },
              truncated: true,
              scopeDomain: null,
              evidenceKind: "examplePage",
            },
          ],
        },
      ],
    },
    skipped: null,
    speed: {
      measured: false,
      status: "not-requested",
      message: "Speed was not measured. It is an optional extra check.",
    },
    desktopSpeed: null,
    measured: [
      { heading: `Measured facts ${SENTINEL}`, facts: [{ label: "Page title", value: HOSTILE }] },
    ],
    coverageDetail: [{ heading: "Crawl limits", facts: [{ label: "Page limit", value: "150" }] }],
    // The F13 fields. No renderer reads them yet; they are present so the
    // fixture is a complete document, consistent with the coverage above.
    coverageCheck: { valid: true, includesStartingAddress: false, pagesRead: 128 },
    coverageCounts: {
      discovered: 128, evaluated: 128, unavailable: 0, notWebPages: 0, notVisited: 0,
      robotsExcluded: 4, includesStartingAddress: false,
      // 120 + 8 = 128: no starting address counted outside the two sources.
      fromLinks: 120, fromSitemap: 8,
    },
    coverageFlags: { partial: false, hasExclusions: true },
    configuredLimits: { maxPages: 150, maxDurationMs: 300_000 },
    singlePageAudit: false,
    checklists: [],
    speedFindings: [],
    technicalFiles: { robots: "found", sitemap: "found" },
    // The step 3a fields. No current renderer reads them.
    searchMeasurement: {
      pageUrl: "https://example.com/",
      facts: [{ label: "Readable text", value: "2,400 characters" }],
    },
    configuredLimitsSentence: "Configured limits for this audit: up to 150 pages and 5 minutes.",
    // The step 3b-i fields: the two problem findings above, in their order.
    certificateFailureAreas: null,
    improvements: [
      {
        ruleId: FIXTURE_RULE_IDS[0], title: "No SPF record", severityLabel: "High",
        category: "security", categoryLabel: "Security", destination: "security-audit",
      },
      {
        ruleId: FIXTURE_RULE_IDS[1], title: "No meta description", severityLabel: "Medium",
        category: "seo", categoryLabel: "Search visibility", destination: "page-level",
      },
    ],
    ...overrides,
  };
}
