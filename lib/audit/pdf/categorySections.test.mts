/**
 * The SEO, Security and Technical sections (CP1 F4, CP3 step 3a).
 *
 * Three kinds of test:
 *   - the wording: every string copied from the report layer is held equal to
 *     its original, and every string defined only by CP3 revision 9 or the CP1
 *     wording proposal is pinned literally;
 *   - the behaviour, on hand-built documents where one input changes at a time;
 *   - real audits, through the production projection, including a certificate
 *     failure and counts that do not reconcile.
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import {
  ADDRESSES_FOUND_LABELS,
  CATEGORY_SECTION_HEADINGS,
  CATEGORY_SECTION_INTROS,
  CHECK_LABELS,
  CHECK_STATUS_LINES,
  CRAWL_TABLE_LABELS,
  FILE_ABSENT_SENTENCES,
  INFORMATION_ONLY_NOTE,
  ROBOTS_EXCLUSION_WITHOUT_COUNT,
  SEARCH_MEASUREMENT_HEADING,
  SITE_LEVEL_ISSUES_HEADING,
  SITE_NO_ISSUE_LINE,
  pageIssueLine,
  securitySectionHtml,
  seoSectionHtml,
  siteIssueLine,
  technicalSectionHtml,
} from "./categorySections.ts";
import { documentHtml } from "./shell.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import { runRealAudit, runRealCertificateFailure, type FakeSite } from "./realAudit.fixture.mts";
import {
  ADDRESSES_FOUND_LABEL,
  CHECK_STATUS,
  INFORMATION_ONLY_LABEL,
  ROBOTS_EXCLUSION_UNCOUNTED,
  SECTION_INTROS,
  checkIssueFound,
} from "../../report/reportSections.ts";
import { EVIDENCE_PANEL_HEADINGS } from "../../report/findingExplainers.ts";
import { AUDIT_RULES } from "../../rules/all.ts";
import { buildPdfDocument, type PdfChecklist, type PdfChecklistItem, type PdfDocument, type PdfFinding } from "../pdfDocument.ts";
import { createJobStore } from "../../jobs/jobStore.ts";
import type { ExplainResult } from "../../ai/gemini/explain.ts";
import type { AuditResult, SpeedResult } from "../../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL = (doc: PdfDocument) => seoSectionHtml(doc) + securitySectionHtml(doc) + technicalSectionHtml(doc);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Markup to text, closely enough to check what a reader sees. The line break
 * between a check's label and its status becomes " | ", so a test can say
 * which status belongs to which label.
 */
const text = (markup: string) =>
  markup
    .replace(/<br>/g, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** "Label | Status", as `text` renders one check-list line. */
const line = (label: string, status: string) => `${label} | ${status}`;

/** The subsection heading as markup, so a check-list line naming it is not mistaken for it. */
const SITE_LEVEL_H3 = `<h3>${SITE_LEVEL_ISSUES_HEADING}</h3>`;

function item(ruleId: string, scope: "page" | "site", status: PdfChecklistItem["status"], findingTitle: string | null = null): PdfChecklistItem {
  return { ruleId, scope, status, findingTitle };
}

function withChecklists(lists: readonly PdfChecklist[], over: Partial<PdfDocument> = {}): PdfDocument {
  return testDocument({ checklists: lists, ...over });
}

/** A site card, copied from the fixture's own and given a new category and rule. */
function siteCard(ruleId: string, title: string, category: PdfFinding["category"]): PdfFinding {
  const base = testDocument().siteFindings.groups[0].findings[0];
  return { ...base, ruleId, title, category };
}

/** The document for any finished real audit, through the production projection. */
function documentOf(audit: AuditResult): PdfDocument {
  const store = createJobStore<AuditResult, SpeedResult, ExplainResult, SpeedResult["data"]>();
  const job = store.create("https://example.com/");
  store.finish(job.id, "partial", audit);
  const outcome = buildPdfDocument(job.id, store);
  if (!outcome.ok) assert.fail(outcome.reason);
  return outcome.document;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

const words = "We sell widgets to businesses across the country and have supplied, installed and maintained them since 1994.";

const SITE: FakeSite = {
  "https://example.com/": { html: page("Example Company", `<h1>Welcome</h1><p>${words}</p><a href="/a">A</a> <a href="/b">B</a>`) },
  "https://example.com/a": { html: page("Page A", `<h1>Page A</h1><p>${words}</p><a href="/">Home</a>`) },
  "https://example.com/b": { html: page("Page B", `<h1>Page B</h1><p>${words}</p><a href="/">Home</a>`) },
};

const realAudits = (async () => {
  const valid = await runRealAudit({ site: SITE, checks: { spfMissing: true } });
  // One copy breaking invariant I1, as the coverage fixtures elsewhere do.
  const failing = structuredClone(valid);
  failing.crawl.sources.html += 3;
  failing.crawl.robots.excluded = 2;
  const certificate = await runRealCertificateFailure({
    site: {
      "https://example.com/": {
        html: "",
        unreadable: "The website's security certificate has expired.",
        certificateProblem: "expired",
      },
    },
    checks: { certificateExpired: true },
  });
  return { valid, failing, certificate };
})();

// ---------------------------------------------------------------------------
// Wording: copies held equal to their originals
// ---------------------------------------------------------------------------

test("wording copied from the report layer is equal to it", () => {
  assert.deepEqual(CATEGORY_SECTION_INTROS, {
    seo: SECTION_INTROS.seo,
    security: SECTION_INTROS.security,
    technical: SECTION_INTROS.technical,
  });
  assert.deepEqual(CHECK_STATUS_LINES, CHECK_STATUS);
  for (const title of ["Missing page title", HOSTILE]) assert.equal(pageIssueLine(title), checkIssueFound(title));
  assert.equal(INFORMATION_ONLY_NOTE, INFORMATION_ONLY_LABEL);
  assert.deepEqual(ADDRESSES_FOUND_LABELS, ADDRESSES_FOUND_LABEL);
  assert.equal(ROBOTS_EXCLUSION_WITHOUT_COUNT, ROBOTS_EXCLUSION_UNCOUNTED);
  assert.equal(SEARCH_MEASUREMENT_HEADING, EVIDENCE_PANEL_HEADINGS.mainPage);
});

test("the absence sentences are the ones the overall summary already prints", () => {
  // Unexported there, so held to the source text itself.
  const source = fs.readFileSync(new URL("../../report/overallSummary.ts", import.meta.url), "utf8");
  assert.ok(source.includes(`"${FILE_ABSENT_SENTENCES.robots}"`));
  assert.ok(source.includes(`"${FILE_ABSENT_SENTENCES.sitemap}"`));
});

// ---------------------------------------------------------------------------
// Wording: approved in CP3 revision 9 or the CP1 wording proposal only
// ---------------------------------------------------------------------------

test("the revision 9 and CP1 strings, exactly", () => {
  assert.deepEqual(CATEGORY_SECTION_HEADINGS, { seo: "SEO Audit", security: "Security Audit", technical: "Technical Audit" });
  assert.equal(siteIssueLine("No SPF record"), "Issue found: see Site-Level Issues: No SPF record");
  assert.equal(SITE_NO_ISSUE_LINE, "No issue found on the site");
  assert.equal(SITE_LEVEL_ISSUES_HEADING, "Site-Level Issues");
  assert.deepEqual(FILE_ABSENT_SENTENCES, {
    robots: "No robots.txt file was found. Without one, search engines may visit every page.",
    sitemap: "No sitemap was found. A sitemap lists the site's pages for search engines.",
  });
  assert.deepEqual(CRAWL_TABLE_LABELS, {
    evaluated: "Pages read and checked",
    fromLinks: "Found by following links",
    fromSitemap: "Found in the sitemap",
    unavailable: "Pages that could not be read",
    notWebPages: "Files that were not web pages",
    robotsExcluded: "Excluded by the site's robots.txt",
  });
});

test("the 23 check labels are exactly the approved ones (CP3-Q27)", () => {
  assert.deepEqual(CHECK_LABELS, {
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
  });
});

test("the labels cover exactly the registry's SEO, Security and Technical rules, and no Speed rule", () => {
  const registry = AUDIT_RULES.filter((rule) => rule.category !== "speed").map((rule) => rule.id).sort();
  assert.deepEqual(Object.keys(CHECK_LABELS).sort(), registry);
  assert.ok(AUDIT_RULES.filter((rule) => rule.category === "speed").every((rule) => !(rule.id in CHECK_LABELS)));
  const scopes = (category: string, scope: string) =>
    AUDIT_RULES.filter((rule) => rule.category === category && rule.scope === scope).length;
  assert.deepEqual(
    [scopes("seo", "page"), scopes("seo", "site"), scopes("security", "page"), scopes("security", "site"), scopes("technical", "site")],
    [10, 0, 7, 5, 1],
    "the scope counts revision 9 §1.17 states",
  );
});

// ---------------------------------------------------------------------------
// Check lists (revision 9, §1.9 and §1.17)
// ---------------------------------------------------------------------------

test("every status is worded as revision 9 §1.9 says, for page and site rules", () => {
  const doc = withChecklists([
    {
      category: "security",
      items: [
        item("security.https", "page", "issue", "Site not served over HTTPS"),
        item("security.mixed-content", "page", "no-issue"),
        item("security.form.insecure", "page", "partly"),
        item("security.headers.hsts", "page", "not-checked"),
        item("security.dns.spf", "site", "issue", "No SPF record"),
        item("security.dns.dmarc", "site", "no-issue"),
        item("security.ssl.expired", "site", "not-checked"),
      ],
    },
  ]);
  const lines = text(securitySectionHtml(doc));
  for (const expected of [
    line("Secure connection (HTTPS)", "Issue found: see Page-Level Issues: Site not served over HTTPS"),
    line("File loading on secure pages (mixed content)", "No issue found on the pages where this could be checked"),
    line("Form submission addresses", "Could not be checked on some pages: see Limitations"),
    line("HSTS header", "Not checked: see Limitations"),
    line("Email sender record (SPF)", "Issue found: see Site-Level Issues: No SPF record"),
    line("Email policy record (DMARC)", "No issue found on the site"),
    line("Certificate expiry date", "Not checked: see Limitations"),
  ]) {
    assert.ok(lines.includes(expected), expected);
  }
  assert.ok(!lines.includes("Not applicable"), "the not-applicable line is not used (CP3-Q16)");
});

test("each line is the label, a line break, then the status; no dash separator", () => {
  const out = seoSectionHtml(withChecklists([{ category: "seo", items: [item("seo.title.missing", "page", "no-issue")] }]));
  assert.ok(
    out.includes(
      `<li class="check"><span class="check-label">Page title</span><br><span class="check-status">No issue found on the pages where this could be checked</span></li>`,
    ),
  );
  assert.ok(!out.includes(" — "));
});

test("check lists are found by category, not by their place in the list", () => {
  const seo: PdfChecklist = { category: "seo", items: [item("seo.title.missing", "page", "no-issue")] };
  const technical: PdfChecklist = { category: "technical", items: [item("technical.robots.blocks-all", "site", "not-checked")] };
  const doc = withChecklists([technical, seo]);
  assert.ok(seoSectionHtml(doc).includes("Page title"));
  assert.ok(!seoSectionHtml(doc).includes("Search engine access"));
  assert.ok(technicalSectionHtml(doc).includes("Search engine access (robots.txt)"));
  assert.ok(!securitySectionHtml(doc).includes(`<ul class="checklist">`), "no security list, no list markup");
});

test("a rule without an approved label stops the render rather than printing its id", () => {
  const doc = withChecklists([{ category: "seo", items: [item("seo.invented.rule", "page", "no-issue")] }]);
  assert.throws(() => seoSectionHtml(doc), /no approved label/);
});

test("a finding title is escaped in its check-list line", () => {
  const doc = withChecklists([{ category: "seo", items: [item("seo.title.missing", "page", "issue", HOSTILE)] }]);
  const out = seoSectionHtml(doc);
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

// ---------------------------------------------------------------------------
// Site-Level Issues (revision 9 §1.7, U7, G1)
// ---------------------------------------------------------------------------

test("site cards follow the check list in their own category, each once; none in SEO", () => {
  const doc = testDocument({
    checklists: [{ category: "security", items: [item("security.dns.spf", "site", "issue", "No SPF record")] }],
    siteFindings: {
      ...testDocument().siteFindings,
      groups: [
        { category: "security", label: "Security", findings: [siteCard("security.dns.spf", "No SPF record", "security")] },
        { category: "technical", label: "Technical", findings: [siteCard("technical.robots.blocks-all", "robots.txt blocks all search engines", "technical")] },
      ],
    },
  });
  const security = securitySectionHtml(doc);
  const technical = technicalSectionHtml(doc);

  assert.ok(security.indexOf("</ul>") < security.indexOf(SITE_LEVEL_H3), "after the check list");
  assert.equal(count(security, `<article class="finding`), 1);
  assert.ok(security.includes("No SPF record</h4>"));
  assert.ok(!security.includes("robots.txt blocks all search engines</h4>"));
  assert.equal(count(technical, `<article class="finding`), 1);
  assert.ok(technical.includes("robots.txt blocks all search engines</h4>"));
  assert.ok(!seoSectionHtml(doc).includes(SITE_LEVEL_H3));
});

test("with no site cards in a category there is no Site-Level Issues subsection", () => {
  const doc = testDocument({ siteFindings: { ...testDocument().siteFindings, count: 0, groups: [] } });
  assert.ok(!securitySectionHtml(doc).includes(SITE_LEVEL_H3));
  assert.ok(!technicalSectionHtml(doc).includes(SITE_LEVEL_H3));
});

// ---------------------------------------------------------------------------
// SEO: the search measurement (CP1 §5.4, 3a-Q5)
// ---------------------------------------------------------------------------

test("the readable-text row is printed under the main-page heading, with its page on its own line", () => {
  const out = seoSectionHtml(testDocument());
  assert.ok(out.includes(`<h3>${SEARCH_MEASUREMENT_HEADING}</h3><p class="page-url">https://example.com/</p>`));
  assert.ok(out.includes("Readable text") && out.includes("2,400 characters"));
});

test("no page read, no search measurement", () => {
  assert.ok(!seoSectionHtml(testDocument({ searchMeasurement: null })).includes(SEARCH_MEASUREMENT_HEADING));
});

test("the measured page's address is escaped", () => {
  const out = seoSectionHtml(
    testDocument({ searchMeasurement: { pageUrl: `https://example.com/${HOSTILE}`, facts: [{ label: "Readable text", value: "1 characters" }] } }),
  );
  assert.ok(!out.includes("<script>"));
});

// ---------------------------------------------------------------------------
// Security: the tables (CP1 §5.5, 3a-Q2, 3a-Q4)
// ---------------------------------------------------------------------------

const TABLES: PdfDocument["measured"] = [
  { key: "content", heading: "Measured facts", facts: [{ label: "Readable text", value: "CONTENT-ROW" }] },
  {
    key: "security",
    heading: "Security",
    facts: [
      { label: "HTTPS protection (HSTS)", value: "HSTS-ROW" },
      { label: "X-Frame-Options", value: "DENY", informationOnly: true },
      { label: "Insecure resources", value: "MIXED-ROW" },
    ],
  },
  { key: "certificate", heading: "Certificate", facts: [{ label: "Issuer", value: "CERT-ROW" }] },
  { key: "domain", heading: "Domain and email records", facts: [{ label: "SPF", value: "DNS-ROW" }] },
];

test("the security, certificate and domain tables appear in that order; the content table does not", () => {
  const out = securitySectionHtml(testDocument({ measured: TABLES }));
  const at = ["HSTS-ROW", "CERT-ROW", "DNS-ROW"].map((marker) => out.indexOf(marker));
  assert.ok(at.every((index) => index > 0) && at[0] < at[1] && at[1] < at[2]);
  assert.ok(!out.includes("CONTENT-ROW"));
});

test("tables are chosen by key: renamed and reordered headings change nothing", () => {
  const renamed = [...TABLES].reverse().map((section, index) => ({ ...section, heading: `Heading ${index}` }));
  const out = securitySectionHtml(testDocument({ measured: renamed }));
  assert.ok(out.indexOf("HSTS-ROW") < out.indexOf("CERT-ROW") && out.indexOf("CERT-ROW") < out.indexOf("DNS-ROW"));
  assert.ok(!out.includes("CONTENT-ROW"));
  // A section without a key is never picked up, whatever it is called.
  const unkeyed = securitySectionHtml(testDocument({ measured: [{ heading: "Security", facts: [{ label: "l", value: "UNKEYED" }] }] }));
  assert.ok(!unkeyed.includes("UNKEYED"));
});

test("a marked row carries the information-only label as its note; other rows do not", () => {
  const out = securitySectionHtml(testDocument({ measured: TABLES }));
  assert.equal(count(out, INFORMATION_ONLY_NOTE), 1);
  assert.ok(out.includes(`<td>DENY<span class="fact-note">${INFORMATION_ONLY_NOTE}</span></td>`));
});

// ---------------------------------------------------------------------------
// Technical (CP1 §4, §5.7, §9.3; revision 9 §1.10)
// ---------------------------------------------------------------------------

const summaryWith = (statusLabel: string): PdfDocument["overallSummary"] => ({
  overview: [],
  areas: [{ key: "site", heading: "Pages read and instructions for search engines", status: "improve", statusLabel, paragraphs: [] }],
  securityStatus: "good",
  strengths: [],
  priorities: [],
  limitations: [],
  notChecked: [],
  help: { intro: "", items: [], closing: "" },
});

test("the status label stands alone on its own line straight after the introduction", () => {
  const out = technicalSectionHtml(testDocument({ overallSummary: summaryWith("Room for improvement") }));
  assert.ok(out.includes(`<p class="lead">${CATEGORY_SECTION_INTROS.technical}</p><p class="section-status">Room for improvement</p>`));
});

test("with no overall summary there is no status line, and none is made up (3a-Q1)", () => {
  const out = technicalSectionHtml(testDocument({ overallSummary: null }));
  assert.ok(!out.includes("section-status"));
  for (const label of ["In good shape", "Room for improvement", "Needs attention", "Partly checked", "Not measured"]) {
    assert.ok(!out.includes(label), label);
  }
});

test("an absence sentence appears only when its file is confirmed absent", () => {
  const states = ["found", "absent", "unavailable"] as const;
  for (const robots of states) {
    for (const sitemap of states) {
      const out = text(technicalSectionHtml(testDocument({ technicalFiles: { robots, sitemap } })));
      assert.equal(out.includes(FILE_ABSENT_SENTENCES.robots), robots === "absent", `robots ${robots}`);
      assert.equal(out.includes(FILE_ABSENT_SENTENCES.sitemap), sitemap === "absent", `sitemap ${sitemap}`);
    }
  }
  const none = text(technicalSectionHtml(testDocument({ technicalFiles: null })));
  assert.ok(!none.includes(FILE_ABSENT_SENTENCES.robots) && !none.includes(FILE_ABSENT_SENTENCES.sitemap));
});

test("the crawl table: seven rows in order, zeros included, plain digits, no start-address or unvisited row", () => {
  const doc = testDocument({
    coverageCounts: {
      discovered: 2150, evaluated: 150, unavailable: 0, notWebPages: 0, notVisited: 2000,
      robotsExcluded: 0, includesStartingAddress: true, fromLinks: 2149, fromSitemap: 0,
    },
  });
  const out = technicalSectionHtml(doc);
  const rows = [...out.matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [
    ["Addresses found (including the starting address)", "2150"],
    ["Pages read and checked", "150"],
    ["Found by following links", "2149"],
    ["Found in the sitemap", "0"],
    ["Pages that could not be read", "0"],
    ["Files that were not web pages", "0"],
    ["Excluded by the site&#39;s robots.txt", "0"],
  ]);
  for (const absent of ["Start address", "not visited when the audit stopped", "2000", "2,150", "Queued"]) {
    assert.ok(!out.includes(absent), absent);
  }
});

test("the first row reads plain when the found total does not include the starting address (L1)", () => {
  const out = technicalSectionHtml(testDocument());
  assert.ok(out.includes(`<th scope="row">Addresses found</th><td>128</td>`));
  assert.ok(!out.includes("including the starting address"));
});

test("without reconciled counts: no table and no figure; the exclusion sentence only when there were exclusions", () => {
  const withExclusions = technicalSectionHtml(testDocument({ coverageCounts: null, coverageFlags: { partial: true, hasExclusions: true } }));
  assert.ok(!withExclusions.includes("<table"));
  assert.ok(text(withExclusions).includes(ROBOTS_EXCLUSION_WITHOUT_COUNT));
  for (const figure of ["128", "120", ">8<", ">4<"]) assert.ok(!withExclusions.includes(figure), figure);

  const without = technicalSectionHtml(testDocument({ coverageCounts: null, coverageFlags: { partial: true, hasExclusions: false } }));
  assert.ok(!text(without).includes(ROBOTS_EXCLUSION_WITHOUT_COUNT));
});

test("with reconciled counts the exclusion is a counted row, not the uncounted sentence", () => {
  const out = technicalSectionHtml(testDocument());
  assert.ok(out.includes(`<td>4</td>`));
  assert.ok(!text(out).includes(ROBOTS_EXCLUSION_WITHOUT_COUNT));
});

test("the configured limits are printed whether or not the counts reconciled", () => {
  for (const coverageCounts of [testDocument().coverageCounts, null]) {
    const out = technicalSectionHtml(testDocument({ coverageCounts }));
    assert.ok(out.includes("Configured limits for this audit: up to 150 pages and 5 minutes."));
  }
});

test("the technical parts come in the planned order", () => {
  const doc = testDocument({
    overallSummary: summaryWith("Room for improvement"),
    technicalFiles: { robots: "absent", sitemap: "absent" },
    checklists: [{ category: "technical", items: [item("technical.robots.blocks-all", "site", "issue", "robots.txt blocks all search engines")] }],
    siteFindings: {
      ...testDocument().siteFindings,
      groups: [{ category: "technical", label: "Technical", findings: [siteCard("technical.robots.blocks-all", "robots.txt blocks all search engines", "technical")] }],
    },
  });
  const out = technicalSectionHtml(doc);
  const order = [
    "<h2>Technical Audit</h2>",
    CATEGORY_SECTION_INTROS.technical,
    `<p class="section-status">Room for improvement</p>`,
    "Search engine access (robots.txt)",
    "No robots.txt file was found.",
    "No sitemap was found.",
    SITE_LEVEL_H3,
    "Addresses found",
    "Configured limits for this audit",
  ];
  let at = -1;
  for (const marker of order) {
    const next = out.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" follows the part before it`);
    at = next;
  }
});

// ---------------------------------------------------------------------------
// Structure and the boundary
// ---------------------------------------------------------------------------

test("each section is one section with one numbered heading, and escapes the audited site's text", () => {
  const doc = testDocument();
  for (const out of [seoSectionHtml(doc), securitySectionHtml(doc), technicalSectionHtml(doc)]) {
    assert.equal(count(out, "<section"), 1);
    assert.equal(count(out, "<h2"), 1);
    assert.ok(!out.includes("<script>"));
  }
});

test("not wired: the current document prints none of the new sections, and the shell does not import them", () => {
  const whole = documentHtml(testDocument());
  for (const heading of Object.values(CATEGORY_SECTION_HEADINGS)) assert.ok(!whole.includes(heading), heading);
  assert.ok(!whole.includes(SITE_LEVEL_ISSUES_HEADING));
  const shell = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(!shell.includes("categorySections"));
});

// ---------------------------------------------------------------------------
// Real audits, through the production projection
// ---------------------------------------------------------------------------

test("a real audit: every check has a line, labels match the registry, site cards sit in Security", async () => {
  const { valid } = await realAudits;
  const doc = documentOf(valid);
  const out = ALL(doc);
  assert.equal(count(out, `<li class="check">`), 23, "10 SEO, 12 Security, 1 Technical");
  assert.equal(count(seoSectionHtml(doc), `<li class="check">`), 10);
  assert.equal(count(securitySectionHtml(doc), `<li class="check">`), 12);
  assert.equal(count(technicalSectionHtml(doc), `<li class="check">`), 1);

  const spf = doc.siteFindings.groups.flatMap((group) => group.findings).find((card) => card.ruleId === "security.dns.spf");
  assert.ok(spf !== undefined, "the fixture produces the SPF site finding");
  const security = securitySectionHtml(doc);
  assert.ok(text(security).includes(line("Email sender record (SPF)", siteIssueLine(spf.title))));
  assert.ok(security.indexOf("</ul>") < security.indexOf(SITE_LEVEL_H3), "the card follows the check list");
  assert.equal(count(out, `${spf.title}</h4>`), 1, "the card is printed once");
  assert.equal(count(out, INFORMATION_ONLY_NOTE), 4, "the four ungraded headers, each labelled");
  assert.ok(technicalSectionHtml(doc).includes("section-status"), "a whole-site audit has its technical status");
  assert.ok(technicalSectionHtml(doc).includes("<table"), "reconciled counts: the crawl table");
});

test("a real audit whose counts do not reconcile: no crawl table and no coverage figure in the technical section", async () => {
  const { failing } = await realAudits;
  const doc = documentOf(failing);
  assert.equal(doc.coverageCounts, null);
  const out = technicalSectionHtml(doc);
  assert.ok(!out.includes("<table"));
  assert.ok(text(out).includes(ROBOTS_EXCLUSION_WITHOUT_COUNT), "X1: exclusions, without their number");
  const crawl = failing.crawl;
  const figures = new Set([crawl.discovered, crawl.evaluated, crawl.sources.html, crawl.sources.sitemap, crawl.robots.excluded, crawl.skippedNonHtml]);
  const visible = text(out).replace(doc.configuredLimitsSentence, "");
  for (const figure of figures) {
    assert.ok(!new RegExp(`\\b${figure}\\b`).test(visible), `no coverage figure ${figure}`);
  }
  assert.ok(out.includes(doc.configuredLimitsSentence), "the configured limits stay");
});

test("a real certificate failure: page checks not checked, site lines and cards, no measurement, no table, no status", async () => {
  const { certificate } = await realAudits;
  const doc = documentOf(certificate);

  const seo = text(seoSectionHtml(doc));
  assert.equal(count(seo, CHECK_STATUS_LINES.notChecked), 10, "every SEO check");
  assert.ok(!seoSectionHtml(doc).includes(SEARCH_MEASUREMENT_HEADING));

  const security = securitySectionHtml(doc);
  const pageRules = AUDIT_RULES.filter((rule) => rule.category === "security" && rule.scope === "page").map((rule) => CHECK_LABELS[rule.id]);
  for (const label of pageRules) assert.ok(text(security).includes(line(label, CHECK_STATUS_LINES.notChecked)), label);
  const expired = doc.siteFindings.groups.flatMap((group) => group.findings).find((card) => card.ruleId === "security.ssl.expired");
  assert.ok(expired !== undefined, "the fixture produces the expired-certificate site finding");
  assert.ok(text(security).includes(line("Certificate expiry date", siteIssueLine(expired.title))));
  assert.ok(security.indexOf("</ul>") < security.indexOf(SITE_LEVEL_H3));
  assert.ok(!security.includes(INFORMATION_ONLY_NOTE), "no header table was measured");
  assert.ok(security.includes("<h3>Certificate</h3>") && security.includes("<h3>Domain and email records</h3>"));

  const technical = technicalSectionHtml(doc);
  assert.ok(!technical.includes("<table"), "no crawl table");
  assert.ok(!technical.includes("section-status"), "the certificate-failure status arrives in step 3b");
  assert.ok(text(technical).includes("Search engine access (robots.txt)"));
});
