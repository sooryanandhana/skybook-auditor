/**
 * The SEO, Security and Technical sections of the redesigned report (CP1 F4,
 * CP3 step 3a).
 *
 * NOT YET PRINTED. These functions are complete and tested, but nothing in the
 * document calls them until the shell is rewired in CP3 step 4. Until then the
 * report prints exactly what it printed before.
 *
 * IT MEASURES NOTHING AND DECIDES NOTHING. Every status, title, count, address
 * and measured row comes from the document model. This file chooses only the
 * approved wording and the layout:
 *
 *   - each check-list line is the model's status, worded (CP3 revision 9, §1.9);
 *   - site findings are drawn with the same card as everywhere else;
 *   - the crawl table is printed only when the model carries reconciled counts,
 *     and no coverage figure is printed when it does not (S1);
 *   - tables are chosen by the model's section key, never by their heading.
 *
 * THE WORDING IS COPIED HERE, NOT IMPORTED. Renderer files may import only from
 * this folder and from the document model (shell.test.mts). Every string below
 * that also exists in the report layer is held equal to it by a test
 * (categorySections.test.mts); the strings that exist only in the approved CP3
 * revision 9 are pinned there literally.
 */
import type {
  AreaStatus,
  PdfChecklist,
  PdfChecklistItem,
  PdfDocument,
  PdfFact,
  PdfFactSection,
  PdfFactSectionKey,
  PdfFinding,
} from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { factGroupsHtml } from "./factSections.ts";
import { factTable } from "./facts.ts";
import { findingCardsHtml } from "./findings.ts";

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/**
 * Each area status in words. Equal to `AREA_STATUS_LABELS` in
 * lib/report/overallSummary.ts (CP3 C3, R6). Shared with the Executive Summary,
 * so the report names a status the same way wherever it prints one.
 */
export const AREA_STATUS_LABEL_TEXT: Readonly<Record<AreaStatus, string>> = {
  good: "In good shape",
  improve: "Room for improvement",
  attention: "Needs attention",
  incomplete: "Partly checked",
  "not-measured": "Not measured",
};

/** The three sections' printed headings (CP3 revision 9, §4). */
export const CATEGORY_SECTION_HEADINGS = {
  seo: "SEO Audit",
  security: "Security Audit",
  technical: "Technical Audit",
} as const;

/** Equal to `SECTION_INTROS` in lib/report/reportSections.ts. */
export const CATEGORY_SECTION_INTROS = {
  seo: "This section shows every search-visibility check and its result. Issues are explained in full under Page-Level Issues and are only referred to here.",
  security:
    "This section covers how safely the site is delivered and how its domain is protected, including in email. Issues that apply to the whole domain are explained here in full.",
  technical:
    "This section covers the instructions the site gives to search engines and how many of its pages could be found and read.",
} as const;

/** Equal to `CHECK_STATUS` in lib/report/reportSections.ts. */
export const CHECK_STATUS_LINES = {
  noIssue: "No issue found on the pages where this could be checked",
  partlyChecked: "Could not be checked on some pages: see Limitations",
  notChecked: "Not checked: see Limitations",
} as const;

/** Equal to `checkIssueFound` in lib/report/reportSections.ts. */
export function pageIssueLine(title: string): string {
  return `Issue found: see Page-Level Issues: ${title}`;
}

/** A site rule with a finding (CP3-Q18a). */
export function siteIssueLine(title: string): string {
  return `Issue found: see Site-Level Issues: ${title}`;
}

/** A site rule that ran and found nothing (CP3-Q18b). */
export const SITE_NO_ISSUE_LINE = "No issue found on the site";

/** The subsection holding a category's site cards (CP3-Q18a placement, U7). */
export const SITE_LEVEL_ISSUES_HEADING = "Site-Level Issues";

/** Equal to `INFORMATION_ONLY_LABEL` in lib/report/reportSections.ts. */
export const INFORMATION_ONLY_NOTE = "Recorded for information only; not part of the grade.";

/** Equal to `EVIDENCE_PANEL_HEADINGS.mainPage` in lib/report/findingExplainers.ts (3a-Q5). */
export const SEARCH_MEASUREMENT_HEADING = "Measured on the main page checked";

/** Shown only when the file is confirmed absent (CP3 revision 9, §1.10). */
export const FILE_ABSENT_SENTENCES = {
  robots: "No robots.txt file was found. Without one, search engines may visit every page.",
  sitemap: "No sitemap was found. A sitemap lists the site's pages for search engines.",
} as const;

/** Equal to `ADDRESSES_FOUND_LABEL` in lib/report/reportSections.ts (L1). */
export const ADDRESSES_FOUND_LABELS = {
  includingStartingAddress: "Addresses found (including the starting address)",
  plain: "Addresses found",
} as const;

/** The other six rows of the crawl table (CP1 wording §9.3, D4, Q12). */
export const CRAWL_TABLE_LABELS = {
  evaluated: "Pages read and checked",
  fromLinks: "Found by following links",
  fromSitemap: "Found in the sitemap",
  unavailable: "Pages that could not be read",
  notWebPages: "Files that were not web pages",
  robotsExcluded: "Excluded by the site's robots.txt",
} as const;

/** Equal to `ROBOTS_EXCLUSION_UNCOUNTED` in lib/report/reportSections.ts (X1). */
export const ROBOTS_EXCLUSION_WITHOUT_COUNT =
  "Some addresses were not visited because the site's robots.txt asks automated tools not to.";

/**
 * Each check's printed label (CP3-Q27, revision 9 §1.17). Speed has no check
 * list. A test holds these keys equal to the registry's SEO, Security and
 * Technical rules.
 */
export const CHECK_LABELS: Readonly<Record<string, string>> = {
  "seo.viewport.missing": "Viewport setting",
  "seo.title.missing": "Page title",
  "seo.meta-description.missing": "Search result description (meta description)",
  "seo.canonical.missing": "Preferred page address (canonical)",
  "seo.lang.missing": "Page language setting",
  "seo.h1.missing": "Main heading",
  "seo.h1.multiple": "Number of main headings",
  "seo.h1.empty": "Main heading text",
  "seo.headings.order": "Heading order",
  "seo.images.alt": "Image descriptions (alt text)",
  "security.https": "Secure connection (HTTPS)",
  "security.mixed-content": "File loading on secure pages (mixed content)",
  "security.ssl.expired": "Certificate expiry date",
  "security.ssl.hostname": "Certificate name match",
  "security.ssl.untrusted": "Certificate trust",
  "security.form.insecure": "Form submission addresses",
  "security.headers.hsts": "HSTS header",
  "security.headers.csp": "Content-Security-Policy header",
  "security.cookies.secure": "Cookie Secure setting",
  "security.cookies.httponly": "Cookie HttpOnly setting",
  "security.dns.spf": "Email sender record (SPF)",
  "security.dns.dmarc": "Email policy record (DMARC)",
  "technical.robots.blocks-all": "Search engine access (robots.txt)",
};

// ---------------------------------------------------------------------------
// Check lists
// ---------------------------------------------------------------------------

/**
 * One line's status sentence, from the model's status (revision 9, §1.9).
 *
 * The model never gives a site rule "partly"; it is worded as a page rule
 * would be only so that no status can fall through unprinted.
 */
function statusLine(item: PdfChecklistItem): string {
  const site = item.scope === "site";
  switch (item.status) {
    case "issue": {
      // The model always carries the title with an issue (pdfDocument.test.mts).
      if (item.findingTitle === null) throw new Error(`Check ${item.ruleId} has an issue without a title.`);
      return site ? siteIssueLine(item.findingTitle) : pageIssueLine(item.findingTitle);
    }
    case "no-issue":
      return site ? SITE_NO_ISSUE_LINE : CHECK_STATUS_LINES.noIssue;
    case "partly":
      return CHECK_STATUS_LINES.partlyChecked;
    case "not-checked":
      return CHECK_STATUS_LINES.notChecked;
  }
}

/**
 * A check's line: the label, a line break, then the status (revision 9, §1.17).
 *
 * A rule without an approved label is a defect, not something to guess a
 * label for: it stops the render rather than printing an internal rule id. A
 * test keeps the labels and the registry equal, so this is caught there first.
 */
function checkLine(item: PdfChecklistItem): string {
  const label = CHECK_LABELS[item.ruleId];
  if (label === undefined) throw new Error(`Check ${item.ruleId} has no approved label.`);
  return (
    `<li class="check">` +
    html`<span class="check-label">${label}</span><br>` +
    html`<span class="check-status">${statusLine(item)}</span>` +
    `</li>`
  );
}

function checklistHtml(checklist: PdfChecklist | undefined): string {
  if (checklist === undefined || checklist.items.length === 0) return "";
  return `<ul class="checklist">` + checklist.items.map(checkLine).join("") + `</ul>`;
}

function checklistFor(doc: PdfDocument, category: PdfChecklist["category"]): PdfChecklist | undefined {
  return doc.checklists.find((checklist) => checklist.category === category);
}

// ---------------------------------------------------------------------------
// Parts shared by more than one section
// ---------------------------------------------------------------------------

/** A category's site cards under their subsection, after the check list; nothing when there are none (U7). */
function siteLevelIssuesHtml(doc: PdfDocument, category: "security" | "technical"): string {
  const findings: readonly PdfFinding[] =
    doc.siteFindings.groups.find((group) => group.category === category)?.findings ?? [];
  if (findings.length === 0) return "";
  return (
    `<div class="site-level-issues">` +
    html`<h3>${SITE_LEVEL_ISSUES_HEADING}</h3>` +
    findingCardsHtml(findings, doc.labels) +
    `</div>`
  );
}

function measuredByKey(doc: PdfDocument, key: PdfFactSectionKey): readonly PdfFactSection[] {
  return doc.measured.filter((section) => section.key === key);
}

/** A recorded-but-ungraded row carries the approved label as its note (3a-Q4). */
function withInformationOnlyNote(fact: PdfFact): PdfFact {
  return fact.informationOnly ? { ...fact, note: INFORMATION_ONLY_NOTE } : fact;
}

function section(className: string, heading: string, intro: string, body: string): string {
  return (
    html`<section class="${className}">` +
    html`<h2>${heading}</h2>` +
    html`<p class="lead">${intro}</p>` +
    body +
    `</section>`
  );
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

/** SEO Audit: the check list, then the readable-text measurement with its page (CP1 §5.4). */
export function seoSectionHtml(doc: PdfDocument): string {
  const measurement = doc.searchMeasurement;
  const measured =
    measurement === null || measurement.facts.length === 0
      ? ""
      : `<div class="fact-group search-measurement">` +
        html`<h3>${SEARCH_MEASUREMENT_HEADING}</h3>` +
        html`<p class="page-url">${measurement.pageUrl}</p>` +
        factTable(measurement.facts) +
        `</div>`;

  return section(
    "seo-audit",
    CATEGORY_SECTION_HEADINGS.seo,
    CATEGORY_SECTION_INTROS.seo,
    checklistHtml(checklistFor(doc, "seo")) + measured,
  );
}

/**
 * Security Audit: the check list, the site cards, then the tables for the
 * security headers, the certificate and the domain records (CP1 §5.5).
 */
export function securitySectionHtml(doc: PdfDocument): string {
  const tables = factGroupsHtml(
    (["security", "certificate", "domain"] as const)
      .flatMap((key) => measuredByKey(doc, key))
      .map((group) => ({ ...group, facts: group.facts.map(withInformationOnlyNote) })),
  );

  return section(
    "security-audit",
    CATEGORY_SECTION_HEADINGS.security,
    CATEGORY_SECTION_INTROS.security,
    checklistHtml(checklistFor(doc, "security")) + siteLevelIssuesHtml(doc, "security") + tables,
  );
}

/**
 * The crawl table, only when the model carries reconciled counts (L1, D4, Q12,
 * X1, 3a-Q9). Every row is shown, zeros included, as plain digits.
 */
function crawlTableHtml(doc: PdfDocument): string {
  const counts = doc.coverageCounts;
  if (counts === null) return "";
  const rows: PdfFact[] = [
    {
      label: counts.includesStartingAddress
        ? ADDRESSES_FOUND_LABELS.includingStartingAddress
        : ADDRESSES_FOUND_LABELS.plain,
      value: String(counts.discovered),
    },
    { label: CRAWL_TABLE_LABELS.evaluated, value: String(counts.evaluated) },
    { label: CRAWL_TABLE_LABELS.fromLinks, value: String(counts.fromLinks) },
    { label: CRAWL_TABLE_LABELS.fromSitemap, value: String(counts.fromSitemap) },
    { label: CRAWL_TABLE_LABELS.unavailable, value: String(counts.unavailable) },
    { label: CRAWL_TABLE_LABELS.notWebPages, value: String(counts.notWebPages) },
    { label: CRAWL_TABLE_LABELS.robotsExcluded, value: String(counts.robotsExcluded) },
  ];
  return `<div class="crawl-table">` + factTable(rows) + `</div>`;
}

/**
 * Technical Audit (CP1 §4, §5.7; revision 9 §1.10): the status, the robots
 * line, the absence sentences, the site card, then the crawl counts or, when
 * they did not reconcile, only the figure-free exclusion sentence; and the
 * configured limits, which are settings rather than measurements.
 */
export function technicalSectionHtml(doc: PdfDocument): string {
  /*
   * From the overall summary when there is one; a certificate failure has
   * none, and takes its Technical status from the model's own certificate-
   * failure statuses instead (CP3 step 3b-ii, B16). Never worked out here.
   */
  const fallback = doc.certificateFailureAreas;
  const status =
    doc.overallSummary?.areas.find((area) => area.key === "site")?.statusLabel ??
    (fallback === null ? null : AREA_STATUS_LABEL_TEXT[fallback.technical]);
  const files = doc.technicalFiles;

  const body =
    (status === null ? "" : html`<p class="section-status">${status}</p>`) +
    checklistHtml(checklistFor(doc, "technical")) +
    (files?.robots === "absent" ? html`<p>${FILE_ABSENT_SENTENCES.robots}</p>` : "") +
    (files?.sitemap === "absent" ? html`<p>${FILE_ABSENT_SENTENCES.sitemap}</p>` : "") +
    siteLevelIssuesHtml(doc, "technical") +
    crawlTableHtml(doc) +
    (doc.coverageCounts === null && doc.coverageFlags.hasExclusions
      ? html`<p>${ROBOTS_EXCLUSION_WITHOUT_COUNT}</p>`
      : "") +
    html`<p class="note">${doc.configuredLimitsSentence}</p>`;

  return section("technical-audit", CATEGORY_SECTION_HEADINGS.technical, CATEGORY_SECTION_INTROS.technical, body);
}
