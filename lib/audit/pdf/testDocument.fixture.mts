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
    measured: [
      { heading: `Measured facts ${SENTINEL}`, facts: [{ label: "Page title", value: HOSTILE }] },
    ],
    coverageDetail: [{ heading: "Crawl limits", facts: [{ label: "Page limit", value: "150" }] }],
    ...overrides,
  };
}
