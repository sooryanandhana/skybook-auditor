/**
 * The verified client report for Adems Travel, as data.
 *
 * THIS FILE IS THE SOURCE OF TRUTH FOR THE CLIENT PDF, and it is the only one.
 * Every finding, measurement, severity and sentence below was transcribed from
 * the Final Verified Audit Source of Truth after its fact-check and five
 * wording corrections. Nothing here is measured, derived or generated: the
 * renderer lays these values out and adds no facts of its own.
 *
 * NOT CONNECTED TO THE AUTOMATED AUDIT. The collector, the rules and the AI
 * explanation layer are not read by anything in `lib/clientReport`. This is a
 * manually verified report, and mixing it with automated results would make it
 * impossible to say which of the two a sentence came from.
 *
 * INLINE MARKUP. Text fields may use two conventions, and only these two:
 * `backticks` for an address or code-like value, and **double asterisks** for
 * emphasis. Everything else is escaped as plain text by `markup.ts`.
 *
 * COUNTS ARE NOT WRITTEN DOWN. The executive summary counts findings from the
 * lists below, and a test pins those counts to the verified totals (60
 * confirmed: 7 High, 23 Medium, 23 Low, 7 not assigned; 5 requiring
 * validation). A finding added or lost here fails that test.
 */

/** How a finding is graded. Only severities the evidence established. */
export type Severity = "high" | "medium" | "low" | "not-assigned" | "requires-validation";

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  "not-assigned": "Severity not assigned",
  "requires-validation": "Requires validation",
};

/** A finding with its evidence. Evidence is one paragraph or a list. */
export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly affected: string;
  readonly evidence: string | readonly string[];
  readonly impact: string;
  readonly action: string;
  /** For requires-validation items: the severity recorded if confirmed. */
  readonly recordedSeverity?: string;
}

export type HealthStatus = "healthy" | "needs-attention";

export interface HealthItem {
  readonly category: string;
  readonly status: HealthStatus;
  readonly basis: string;
}

export interface CheckRow {
  readonly check: string;
  readonly result: string;
  /** Pass, issue, not assessed — drives the small status marker. */
  readonly state: "pass" | "issue" | "not-assessed" | "info";
}

export interface ContentRow {
  readonly id: string;
  readonly location: string;
  readonly current: string;
  readonly recommended: string;
  readonly type: string;
  readonly severity: Severity;
}

export interface ActionRow {
  readonly ids: string;
  readonly issue: string;
  readonly action: string;
  readonly benefit: string;
}

export interface ValidationRow {
  readonly id: string;
  readonly item: string;
  readonly step: string;
  readonly why: string;
}

// ---------------------------------------------------------------------------
// Cover and summary
// ---------------------------------------------------------------------------

export const CLIENT = {
  name: "Adems Travel",
  site: "ademstravel.com",
  url: "https://ademstravel.com/",
  auditDate: "17 September 2026",
  preparedBy: "Skybook",
} as const;

export const EXECUTIVE_INTRO =
  "Skybook audited the Adems Travel website across search visibility, technical setup, performance, security, SSL, DNS, content quality, and user experience and accessibility. All results come from direct inspection and recognised independent testing tools.";

export const EXECUTIVE_CONDITION =
  "The site has a sound technical foundation: a valid, trusted security certificate with an SSL Labs **Grade A**, a working secure (HTTPS) version, correctly functioning domain records, pages that search engines can index, a layout that stays intact on every screen size tested with no horizontal scrolling from 320 px to 1440 px, a fast server response (first byte in 0.143 seconds), and a stable layout while loading (low layout shift and low blocking time).";

export const EXECUTIVE_AREAS: readonly string[] = [
  "**Conversion.** Visitors can't move from a package or service to an enquiry. The Contact page's two branch mobile numbers each dial the other branch. Floating on-screen buttons cover content, including prices.",
  "**Search visibility.** Every page shares the same title and description, and no page has a main heading.",
  "**Security.** Visitors who arrive on the unencrypted (HTTP) address are not moved to the secure version, and six recommended security headers are missing.",
  "**Performance.** Total page weight is about 12.5 MB, mostly images. The mobile performance score is 55 and the desktop score is 59.",
];

export const EXECUTIVE_PRIORITIES: readonly string[] = [
  "Redirect all visitors to the secure HTTPS address (K1).",
  "Correct the Contact page phone links (K2).",
  "Give packages and services a path to an enquiry (K3, K4).",
  "Stop floating buttons from covering content (K5).",
  "Give each page a unique title and a main heading (K6, K7).",
];

export const HEALTH: readonly HealthItem[] = [
  { category: "SEO", status: "needs-attention", basis: "Identical page titles (K6) and meta descriptions (SEO-01). No main heading (K7). No canonical tags (SEO-03). Empty image descriptions (SEO-02)." },
  { category: "Technical SEO", status: "needs-attention", basis: "Broken internal “Home” link (TECH-01). No robots.txt (TECH-02). No XML sitemap (TECH-03). No custom error page (TECH-05)." },
  { category: "Performance", status: "needs-attention", basis: "PageSpeed performance: mobile 55, desktop 59. Page weight about 12.5 MB." },
  { category: "Security", status: "needs-attention", basis: "HTTP not redirected to HTTPS (K1). Security headers missing, securityheaders.com Grade F (SEC-01)." },
  { category: "SSL", status: "healthy", basis: "SSL Labs Grade A. Certificate valid and trusted until 27 Nov 2026." },
  { category: "DNS", status: "healthy", basis: "Web, name server and mail records resolve correctly." },
  { category: "UX / Accessibility", status: "needs-attention", basis: "No route from packages or services to an enquiry. Phone link errors. Overlapping elements. Contrast and keyboard-access gaps." },
  { category: "Content", status: "needs-attention", basis: "Spelling, grammar and consistency errors, including in a main service name." },
];

export const HEALTH_STRENGTHS: readonly string[] = [
  "SSL Labs Grade A",
  "Valid, trusted certificate",
  "HTTPS available",
  "DNS functioning correctly",
  "Pages indexable",
  "No horizontal overflow on any tested viewport",
  "Good server response (first byte 0.143 s)",
  "Low layout shift (CLS 0.007) and low blocking time (TBT 80 ms)",
];

// ---------------------------------------------------------------------------
// 4. Key findings
// ---------------------------------------------------------------------------

export const KEY_FINDINGS: readonly Finding[] = [
  {
    id: "K1",
    title: "Visitors are not redirected from HTTP to HTTPS",
    severity: "high",
    affected: "`http://ademstravel.com/` and `http://www.ademstravel.com/`",
    evidence: [
      "Both addresses stay on unencrypted HTTP, and the browser shows “Not Secure”.",
      "PageSpeed Insights reports “Does not redirect HTTP traffic to HTTPS” and “Does not use HTTPS — 83 insecure requests found”.",
      "The secure HTTPS version works and has a valid certificate (Section 9).",
    ],
    impact:
      "Visitors reaching the site through an HTTP address see a “Not Secure” warning, and their connection isn't encrypted, even though the business already has a valid certificate.",
    action: "Set up permanent (301) redirects from both HTTP addresses to one preferred HTTPS address.",
  },
  {
    id: "K2",
    title: "Contact page mobile numbers dial the wrong branch",
    severity: "high",
    affected: "Contact page, “Our Branches”",
    evidence: [
      "Lagoona Mall displays **+974 7727 5958**, but tapping it dials **+974 7727 4011**.",
      "Umm Qarn displays **+974 7727 4011**, but tapping it dials **+974 7727 5958**.",
    ],
    impact: "Mobile visitors who tap a number reach the other branch.",
    action: "Swap the two phone links so each dials the number displayed.",
  },
  {
    id: "K3",
    title: "Packages have no detail page or enquiry option",
    severity: "high",
    affected: "Homepage (“Most Popular Tours”) and the Packages page (23 packages)",
    evidence: [
      "Package names don't open anything.",
      "The “VIEW MORE” button on each of the 6 homepage hero slides opens the general Packages page.",
      "Package cards show only a destination and a “starting from” price.",
    ],
    impact:
      "Visitors can't see what a package includes or enquire about a specific package from its card.",
    action: "Give each package a detail view, or at minimum an enquiry action on each card.",
  },
  {
    id: "K4",
    title: "Service tiles look clickable but do nothing",
    severity: "high",
    affected: "Services page (12 tiles) and the homepage “Our Services” section (5 cards)",
    evidence: [
      "**Services page tiles:** a pointer cursor appears on hover, and a test click did nothing.",
      "**Homepage service cards:** they link to `javascript:void(0)`, so clicking them does nothing.",
      "The Services page lists service titles only, with no descriptions.",
    ],
    impact: "Services such as visas, Umrah packages and travel insurance can't be explored.",
    action: "Add descriptions or links for each service, or remove the clickable appearance.",
  },
  {
    id: "K5",
    title: "Floating on-screen elements cover content",
    severity: "high",
    affected:
      "All pages. Four fixed elements: WhatsApp button, chat button, “Adems Holidays” badge (not clickable), and “Raise a request!” pop-up",
    evidence: [
      "**1024 px:** the chat button hides the last digit of the Gold Coast price, so “QAR 12111” reads as “QAR 1211”. The WhatsApp button covers “International Cruises” (Services) and the Umm Qarn phone and email (Contact).",
      "**390 px:** the badge covers About text. The WhatsApp button covers a tour title and the “Quick Contact” heading. The chat button covers the copyright line.",
      "**360 px:** the pop-up and badge cover Mission text.",
      "**320 px:** the pop-up covers the “Our Branches” heading.",
      "**400 px:** screenshots show the elements overlapping card titles and headings.",
    ],
    impact: "Visitors may misread prices or miss contact details.",
    action:
      "Remove or reposition the decorative badge, and keep the floating buttons clear of page content.",
  },
  {
    id: "K6",
    title: "Every page has the same title",
    severity: "high",
    affected: "Home, Packages, Services, About, Contact",
    evidence:
      "Every page's title is “Adems Travel”. No title is missing, and none is over 60 characters.",
    impact:
      "In search results the pages look identical, with nothing to tell searchers what each page offers.",
    action: "Write a unique, descriptive title for each page.",
  },
  {
    id: "K7",
    title: "No page has a main heading (H1)",
    severity: "high",
    affected: "Home, Packages, Services, About, Contact",
    evidence: "No H1 heading was found on any of the five main pages.",
    impact: "Search engines and screen readers use the main heading to understand a page's topic.",
    action: "Add one clear, descriptive H1 to each page.",
  },
];

// ---------------------------------------------------------------------------
// 5. SEO
// ---------------------------------------------------------------------------

export const SEO_TITLE_CHECKS: readonly CheckRow[] = [
  { check: "Missing", result: "None missing", state: "pass" },
  { check: "Duplicate", result: "See K6", state: "issue" },
  { check: "Length", result: "None over 60 characters", state: "pass" },
];

export const SEO_META_NOTE =
  "The meta description is the short summary shown under a page's link in search results.";

export const SEO_META_CHECKS: readonly CheckRow[] = [
  { check: "Missing", result: "None missing", state: "pass" },
  { check: "Duplicate", result: "See SEO-01", state: "issue" },
  { check: "Length", result: "All under 70 characters (included in SEO-01)", state: "info" },
];

export const SEO_HEADING_CHECKS: readonly CheckRow[] = [
  { check: "H1", result: "See K7. No duplicate or multiple H1s.", state: "issue" },
  { check: "H2", result: "No page is missing an H2. Several H2s on one page is not a problem.", state: "pass" },
  { check: "H3", result: "Not assessed", state: "not-assessed" },
  { check: "Overall heading structure", result: "Not assessed", state: "not-assessed" },
];

export const SEO_01: Finding = {
  id: "SEO-01",
  title: "Same meta description on every page",
  severity: "medium",
  affected: "Home, Packages, Services, About, Contact",
  evidence: "Every main page uses “Tours and Travel” (16 characters).",
  impact: "Search results show little information about each page, and the pages can't be told apart.",
  action: "Write a unique, informative description for each page.",
};

export const SEO_02: Finding = {
  id: "SEO-02",
  title: "Content images have empty ALT text",
  severity: "medium",
  affected:
    "Package and destination images, including Paris, Azerbaijan, Norway, Georgia, Singapore, Turkey, Maldives, Austria, Gold Coast, London, Italy, Switzerland, Thailand, South Africa, Indonesia, Malaysia, Tanzania, Armenia, Orlando, US East Coast, US West Coast and Nadi",
  evidence:
    "These images have an empty ALT description. The exact number of affected images was **not recorded**.",
  impact:
    "ALT text is the written description of an image. It's read aloud to visually impaired visitors and helps image search. Decorative images can correctly leave it empty; content images should not.",
  action:
    "Add short, descriptive ALT text to package and destination images. Leave it empty only on decorative images.",
};

export const SEO_CANONICAL_NOTE =
  "A canonical tag tells search engines which address is the main version of a page.";

export const SEO_CANONICAL_CHECKS: readonly CheckRow[] = [
  { check: "Canonical tag present", result: "See SEO-03", state: "issue" },
  { check: "Multiple canonical declarations", result: "None", state: "pass" },
];

export const SEO_03: Finding = {
  id: "SEO-03",
  title: "No canonical tags",
  severity: "medium",
  affected:
    "Homepage, Packages, Services, About, `index.php`, Contact, their www versions, and the company profile PDF",
  evidence: "No canonical tag found. There are no conflicting multiple canonicals.",
  impact:
    "When the same page is available at several addresses, search engines have no signal about which to prefer.",
  action:
    "Choose one preferred domain and add canonical tags to important pages. Handle the PDF separately.",
};

export const SEO_INDEXABILITY: readonly CheckRow[] = [
  { check: "Indexability", result: "All pages checked can be indexed by search engines, and the site appears in Google search results.", state: "pass" },
  { check: "Google Search Console", result: "Not assessed (no access)", state: "not-assessed" },
];

export const SEO_URL_NOTES: readonly string[] = [
  "The homepage loads at both `/` and `/index.php`. This is covered by SEO-03 and TECH-04.",
  "For the broken URL, see TECH-01.",
];

// ---------------------------------------------------------------------------
// 6. Technical SEO / crawl
// ---------------------------------------------------------------------------

export const TECH_CHECKS: readonly CheckRow[] = [
  { check: "Page availability", result: "Every crawled address except `/index.html` loads normally", state: "pass" },
  { check: "Indexability", result: "Pass (Section 5)", state: "pass" },
  { check: "HTTP → HTTPS redirect", result: "See K1", state: "issue" },
];

export const TECH_FINDINGS: readonly Finding[] = [
  {
    id: "TECH-01",
    title: "Broken internal link to /index.html",
    severity: "medium",
    affected:
      "The “Home” breadcrumb link on About, Services and Contact; the footer logo and mobile-menu logo on every page",
    evidence: "`https://ademstravel.com/index.html` returns “404 Not Found”.",
    impact: "Visitors using these “Home” links reach an error page.",
    action:
      "Point these links to the homepage (`https://ademstravel.com/`). A redirect also works, but fixing the links is better.",
  },
  {
    id: "TECH-02",
    title: "No robots.txt file",
    severity: "medium",
    affected: "`https://ademstravel.com/robots.txt`",
    evidence: "Returns 404 Not Found.",
    impact:
      "robots.txt is a small file that gives search engines crawling instructions and points them to the sitemap.",
    action: "Create a robots.txt file with appropriate rules and the sitemap address.",
  },
  {
    id: "TECH-03",
    title: "No XML sitemap",
    severity: "medium",
    affected: "`/sitemap.xml` and `/sitemap_index.xml`",
    evidence: "Both return 404 Not Found. Google is still finding the site's pages.",
    impact: "A sitemap lists a site's pages so search engines can find them reliably.",
    action:
      "Publish an XML sitemap, and submit it through Google Search Console once access is available.",
  },
  {
    id: "TECH-04",
    title: "Site loads at both www and non-www addresses",
    severity: "not-assigned",
    affected: "The whole site",
    evidence:
      "All four combinations load with no redirect: `http://` and `https://`, each with and without `www`.",
    impact: "The same content is available at several addresses.",
    action:
      "Choose one preferred address and redirect the others to it. This can be done together with K1.",
  },
  {
    id: "TECH-05",
    title: "No custom error (404) page",
    severity: "medium",
    affected: "Any non-existent address on the site",
    evidence:
      "The server's plain “Not Found” page is shown, including a server configuration error message. There is no branding, navigation or link to the homepage.",
    impact: "Visitors who reach a missing page have no clear way back into the site.",
    action: "Set up a branded 404 page with navigation and a homepage link.",
  },
];

// ---------------------------------------------------------------------------
// 7. Performance
// ---------------------------------------------------------------------------

export interface Metric {
  readonly label: string;
  readonly value: string;
  /** PageSpeed's own rating, where it gave one. */
  readonly rating?: "Good" | "Poor";
  readonly requiresValidation?: boolean;
}

export const PSI_MOBILE_CONDITIONS =
  "Simulated mid-range phone, slow 4G connection, 17 Sep 2026.";

export const PSI_MOBILE_SCORES: readonly Metric[] = [
  { label: "Performance", value: "55" },
  { label: "Accessibility", value: "90" },
  { label: "Best Practices", value: "74" },
  { label: "SEO", value: "82" },
];

export const PSI_MOBILE_METRICS: readonly Metric[] = [
  { label: "First Contentful Paint", value: "5.5 s", rating: "Poor" },
  { label: "Largest Contentful Paint", value: "39.7 s", rating: "Poor", requiresValidation: true },
  { label: "Total Blocking Time", value: "80 ms", rating: "Good" },
  { label: "Cumulative Layout Shift", value: "0.007", rating: "Good" },
  { label: "Speed Index", value: "13.8 s", rating: "Poor" },
];

export const PSI_FIELD_DATA = "Not available: too few recent visits for Google to report.";

export const LCP_VALIDATION_NOTE =
  "PageSpeed reported 39.7 s — requires validation by re-test. PageSpeed's own breakdown of this measurement adds up to about 2.0 s, so the figure should not be relied on until a re-test confirms it. No finding in this report depends on it.";

export const PSI_DESKTOP_SCORES: readonly Metric[] = [
  { label: "Performance", value: "59" },
  { label: "Accessibility", value: "83" },
  { label: "Best Practices", value: "74" },
  { label: "SEO", value: "82" },
];

export const PSI_DESKTOP_NOTE = "Individual desktop metrics: Not assessed.";

export const WPT_CONDITIONS = "Chrome, test location Bratislava, median of 3 runs.";

export const WPT_METRICS: readonly Metric[] = [
  { label: "Load time", value: "1.046 s" },
  { label: "First byte", value: "0.143 s" },
  { label: "Start render", value: "1.200 s" },
  { label: "Speed Index", value: "1.453 s" },
  { label: "Requests", value: "91" },
  { label: "Page weight", value: "12,556 KB" },
  { label: "Fully loaded", value: "1.148 s" },
  { label: "Requests (fully loaded)", value: "93" },
  { label: "Page weight (fully loaded)", value: "12,559 KB" },
];

export const WPT_GRADES: readonly { label: string; grade: string; note?: string }[] = [
  { label: "First byte", grade: "A" },
  { label: "Keep-alive", grade: "A" },
  { label: "Compress transfer", grade: "F" },
  { label: "Compress images", grade: "F" },
  { label: "Cache static content", grade: "F" },
  { label: "CDN", grade: "X", note: "Not detected" },
];

export const PERF_COMPARISON_NOTE =
  "PageSpeed simulates a slow mobile connection. The WebPageTest connection profile was not recorded. Timings from the two tools should not be compared directly.";

/** Performance findings: what was found → why it matters → recommended action. */
export interface PerfFinding {
  readonly id: string;
  readonly title: string;
  readonly found: string | readonly string[];
  readonly why: string;
  readonly action: string;
}

export const PERF_FINDINGS: readonly PerfFinding[] = [
  {
    id: "PERF-01",
    title: "Very large page weight, mostly images",
    found: [
      "Total download: 12,509 KiB (PageSpeed) and 12,556 KB (WebPageTest).",
      "Images are 83.7% of the bytes.",
      "PageSpeed estimates 7,300 KiB could be saved through better image delivery. For example, `Nadi.jpg` (901.4 KiB) is 1914×1003 px but is displayed at 382×204 px.",
      "WebPageTest grades image compression **F**.",
    ],
    why: "Large downloads slow page loading, especially on mobile data.",
    action:
      "Resize images to their displayed size, compress them, and consider modern formats such as WebP or AVIF.",
  },
  {
    id: "PERF-02",
    title: "Browser caching not configured",
    found:
      "The site's own files (12,269 KiB) have no cache lifetime set, and PageSpeed estimates a saving of 12,368 KiB. WebPageTest grades static-content caching **F**.",
    why: "Returning visitors download every file again.",
    action: "Set long cache lifetimes for images, stylesheets and scripts.",
  },
  {
    id: "PERF-03",
    title: "Text files are not compressed",
    found: "WebPageTest grades transfer compression **F**.",
    why: "Uncompressed text files take longer to download.",
    action: "Enable server compression (gzip or Brotli).",
  },
  {
    id: "PERF-04",
    title: "Files delay page display, and much of the code is unused",
    found: [
      "Render-blocking files: estimated saving 4,970 ms.",
      "Unused CSS: 520 KiB. Unused JavaScript: 678 KiB.",
      "CSS and JavaScript not minified: 78 KiB and 162 KiB.",
    ],
    why: "The browser must download and process these files before it can show the page.",
    action:
      "Remove unused styles and scripts, defer files that aren't needed immediately, and minify the rest.",
  },
  {
    id: "PERF-05",
    title: "The main hero image isn't loaded as a priority",
    found:
      "The largest visible element is the hero image (`gold-coast.jpg`). PageSpeed recommends it be marked as high priority.",
    why: "The first thing visitors see appears sooner when it's loaded first.",
    action: "Give the hero image loading priority and reduce its file size.",
  },
];

// ---------------------------------------------------------------------------
// 8. Security
// ---------------------------------------------------------------------------

export const SECURITY_PASSES: readonly CheckRow[] = [
  { check: "HTTPS available", result: "The secure HTTPS version loads correctly.", state: "pass" },
  { check: "SSL", result: "Healthy: Grade A with a valid, trusted certificate (Section 9).", state: "pass" },
  { check: "Mixed content", result: "No mixed-content warning confirmed on the HTTPS site. The test method was not recorded.", state: "pass" },
];

export const SECURITY_HEADERS: readonly { header: string; purpose: string }[] = [
  { header: "Strict-Transport-Security (HSTS)", purpose: "Tells browsers to always use the secure HTTPS version" },
  { header: "Content-Security-Policy (CSP)", purpose: "Limits which resources the browser may load, reducing some types of browser-based attack" },
  { header: "X-Frame-Options", purpose: "Stops other sites from embedding this site in a frame (protects against “clickjacking”)" },
  { header: "X-Content-Type-Options", purpose: "Stops browsers from guessing file types, reducing some attack risks" },
  { header: "Referrer-Policy", purpose: "Controls what address information is shared with other sites" },
  { header: "Permissions-Policy", purpose: "Controls which browser features, such as camera or location, the site may use" },
];

export const SEC_01: Finding = {
  id: "SEC-01",
  title: "Recommended security headers are missing",
  severity: "not-assigned",
  affected:
    "`https://ademstravel.com/` (tested with securityheaders.com); `https://www.ademstravel.com/` (HSTS, CSP and X-Frame-Options checked with curl)",
  evidence:
    "securityheaders.com tested `https://ademstravel.com/` and gave it Grade **F**, with all six recommended headers missing. A separate curl check of `https://www.ademstravel.com/` confirmed that HSTS, CSP and X-Frame-Options are absent there too. SSL Labs also reports HSTS as not configured.",
  impact: "The browser protections these headers provide are not in place.",
  action:
    "Configure these headers on the server. Introduce CSP carefully, testing first so site features aren't affected. Add HSTS once the HTTPS redirect (K1) is in place.",
};

export const SEC_02: Finding = {
  id: "SEC-02",
  title: "Server software is disclosed",
  severity: "low",
  affected: "Server responses",
  evidence: "Responses include “Server: Apache”. No version number is disclosed.",
  impact: "Reveals which server software the site runs.",
  action: "Reduce server information disclosure where practical.",
};

// ---------------------------------------------------------------------------
// 9. SSL
// ---------------------------------------------------------------------------

export const SSL_RESULTS: readonly CheckRow[] = [
  { check: "Overall rating (Qualys SSL Labs)", result: "Grade A", state: "pass" },
  { check: "Certificate status", result: "Valid and trusted (Mozilla, Apple, Android, Java, Windows); not revoked", state: "pass" },
  { check: "Domains covered", result: "`ademstravel.com` and `www.ademstravel.com`", state: "pass" },
  { check: "Validity", result: "29 August 2026 to 27 November 2026", state: "pass" },
  { check: "Key and signature", result: "RSA 2048-bit, SHA256withRSA", state: "pass" },
  { check: "Certificate chain", result: "Complete (3 certificates); no chain issues", state: "pass" },
  { check: "Protocols", result: "TLS 1.3 and TLS 1.2 only; older insecure protocols disabled", state: "pass" },
  { check: "Known vulnerabilities", result: "None found; BEAST mitigated; downgrade prevention supported", state: "pass" },
  { check: "Forward secrecy", result: "Supported (robust)", state: "pass" },
  { check: "HTTPS in use", result: "Available, but visitors are not redirected to it (K1)", state: "issue" },
];

export const SSL_INFO: readonly string[] = [
  "HSTS is not configured (covered in SEC-01).",
  "OCSP stapling and DNS CAA, both optional hardening measures, are not configured.",
  "The following clients can't connect securely: Safari 6 (iOS 6.0.1), Safari 7 (iOS 7.1, OS X 10.9), Safari 8 (iOS 8.4, OS X 10.10), and Internet Explorer 11 on Windows Phone 8.1.",
  "The certificate expires on 27 November 2026. Make sure it renews before then.",
];

// ---------------------------------------------------------------------------
// 10. DNS
// ---------------------------------------------------------------------------

export const DNS_RECORDS: readonly { record: string; result: string; meaning: string; state: CheckRow["state"] }[] = [
  { record: "A", result: "92.204.41.53", meaning: "The domain correctly points to the web server", state: "pass" },
  { record: "AAAA", result: "None", meaning: "No IPv6 address. This is not a problem by itself.", state: "info" },
  { record: "CNAME", result: "None", meaning: "Not a problem by itself", state: "info" },
  { record: "NS", result: "ns43.domaincontrol.com, ns44.domaincontrol.com", meaning: "Name servers are set up and responding", state: "pass" },
  { record: "MX", result: "ademstravel-com.mail.protection.outlook.com", meaning: "Email is routed through Microsoft's mail service", state: "pass" },
  { record: "SPF", result: "Not assessed", meaning: "Email authentication", state: "not-assessed" },
  { record: "DMARC", result: "Not assessed", meaning: "Email authentication", state: "not-assessed" },
];

// ---------------------------------------------------------------------------
// 11. Content quality
// ---------------------------------------------------------------------------

export const CONTENT_ROWS: readonly ContentRow[] = [
  { id: "CQ-01", location: "Homepage service card; Services page", current: "Travel Insurence", recommended: "Travel Insurance", type: "Spelling", severity: "medium" },
  { id: "CQ-02", location: "About, heading", current: "Ready for an unforgetable tour?", recommended: "Ready for an unforgettable tour?", type: "Spelling", severity: "medium" },
  { id: "CQ-03", location: "About, introduction", current: "We prioratize your comfort", recommended: "We prioritize your comfort", type: "Spelling", severity: "low" },
  { id: "CQ-04", location: "Services", current: "World Wide Car Rental, World Wide Hotel Booking", recommended: "Worldwide Car Rental, Worldwide Hotel Booking", type: "Spelling", severity: "low" },
  { id: "CQ-05", location: "Homepage About section; footer (every page)", current: "…sweet memories of a noteworthy travel.", recommended: "…sweet memories of a noteworthy trip.", type: "Grammar", severity: "medium" },
  { id: "CQ-06", location: "About, Mission", current: "More than earning a reputation without noting the pieces of muddle heads, we step ourselves for customer satisfaction.", recommended: "Rewrite recommended. The meaning is unclear, and “muddle heads” may read as unprofessional. Wording should come from the business.", type: "Grammar / clarity", severity: "medium" },
  { id: "CQ-07", location: "About", current: "provides top-notch travel solution", recommended: "provides top-notch travel solutions", type: "Grammar", severity: "low" },
  { id: "CQ-08", location: "About, Vision", current: "Anybody can be a world voyager is our main motto.", recommended: "‘Anybody can be a world voyager’ is our main motto.", type: "Grammar", severity: "low" },
  { id: "CQ-09", location: "About, Vision", current: "Trustworthy to all destinations to bring the travel mind with minimum budget…", recommended: "Rewrite recommended (incomplete sentence)", type: "Grammar", severity: "low" },
  { id: "CQ-10", location: "About, Vision", current: "ecofriendly", recommended: "eco-friendly", type: "Spelling", severity: "low" },
  { id: "CQ-11", location: "Hero slides; all package cards", current: "All inclusive package", recommended: "All-inclusive package", type: "Grammar", severity: "low" },
  { id: "CQ-12", location: "Hero slides; all package cards", current: "Price Starting from QAR. 12111*", recommended: "Price starting from QAR 12,111*", type: "Typography", severity: "low" },
  { id: "CQ-13", location: "Footer (every page)", current: "@ Copyright 2021, All rights reserved", recommended: "© 2021 Adems Travel. All rights reserved.", type: "Typography", severity: "low" },
  { id: "CQ-14", location: "About", current: "Our Experienced team", recommended: "Our experienced team", type: "Capitalisation", severity: "low" },
  { id: "CQ-15", location: "Homepage About list", current: "customized tour plans with 24/7 support", recommended: "Customized tour plans with 24/7 support", type: "Capitalisation", severity: "low" },
  { id: "CQ-16", location: "About, Mission (twice)", current: "Adems travel", recommended: "Adems Travel", type: "Consistency", severity: "low" },
  { id: "CQ-17", location: "Contact", current: "Mob:+974…, Ph:44515599, Ph:4451 5559", recommended: "Mob: +974…, Ph: 4451 5599, Ph: 4451 5559", type: "Typography", severity: "low" },
  { id: "CQ-18", location: "Contact form", current: "Your name / Your Subject", recommended: "Use one capitalisation style", type: "Consistency", severity: "low" },
  { id: "CQ-19", location: "Contact form", current: "E-mail (error message) vs Email address (field)", recommended: "Use “Email” throughout", type: "Consistency", severity: "low" },
  { id: "CQ-20", location: "Homepage", current: "Orlando US (hero) vs Orlando (card)", recommended: "Use one name", type: "Consistency", severity: "low" },
  { id: "CQ-21", location: "Services", current: "Holiday Package, Wellness Package vs Adventure Tour Packages, Umrah Packages", recommended: "Use either singular or plural throughout", type: "Consistency", severity: "low" },
  { id: "CQ-22", location: "Section labels", current: "Our Services / About us / Featured tours; How Adems can help vs Most Popular Tours", recommended: "Use one capitalisation style", type: "Consistency", severity: "low" },
];

export const CONTENT_FINDINGS: readonly Finding[] = [
  {
    id: "CQ-23",
    title: "The price asterisk is never explained",
    severity: "medium",
    affected: "Homepage and Packages",
    evidence:
      "Every price is followed by “*”, but no footnote or terms appear on the pages that show prices.",
    impact: "Visitors can't tell what conditions apply to the price.",
    action: "State the condition the asterisk refers to, or remove it.",
  },
  {
    id: "CQ-24",
    title: "Two brand names shown",
    severity: "low",
    affected: "All pages",
    evidence: "The “Adems Travel” logo and an “Adems Holidays” badge appear together.",
    impact: "Creates uncertainty about the brand.",
    action: "Confirm which brand name the site should present.",
  },
  {
    id: "CQ-25",
    title: "Contact numbers differ across the site",
    severity: "medium",
    affected: "Footer, mobile menu, Contact page",
    evidence: [
      "The footer shows +974 7727 4011 alongside the Lagoona Mall address, while the Contact page lists that number under Umm Qarn.",
      "The mobile menu shows +974 41420094, which appears nowhere else on the site.",
    ],
    impact: "Visitors can't tell which number to use.",
    action: "Agree one list of numbers and use it everywhere.",
  },
];

// ---------------------------------------------------------------------------
// 12. Visual / UX / accessibility
// ---------------------------------------------------------------------------

export interface UxGroup {
  readonly heading: string;
  readonly note?: string;
  readonly findings: readonly Finding[];
}

export const UX_GROUPS: readonly UxGroup[] = [
  {
    heading: "Navigation",
    findings: [
      {
        id: "UX-01",
        title: "Full menu hidden behind a menu icon on screens up to 1199 px",
        severity: "low",
        affected: "All pages, including 1024 px laptop screens",
        evidence: "The five-item menu collapses into a menu icon.",
        impact: "The site's pages are harder to discover on mid-sized screens.",
        action: "Show the full menu from about 992 px.",
      },
      {
        id: "UX-02",
        title: "Mobile-menu social icons don't go anywhere",
        severity: "low",
        affected: "Mobile menu",
        evidence: "The Facebook and Instagram icons link to “#”.",
        impact: "Visitors can't reach the social profiles.",
        action: "Link the real profiles, or remove the icons.",
      },
    ],
  },
  {
    heading: "Content and layout",
    findings: [
      {
        id: "UX-03",
        title: "The hero doesn't state what the company offers",
        severity: "medium",
        affected: "Homepage",
        evidence:
          "The hero shows only a rotating destination, a price and “VIEW MORE”. The first description of the business appears in the third section (about 1,788 px down at 1440×900).",
        impact: "New visitors don't immediately see what the business does.",
        action: "Add a short statement of what the company offers.",
      },
      {
        id: "UX-04",
        title: "Hero slider changes every 3 seconds with no pause",
        severity: "medium",
        affected: "Homepage",
        evidence:
          "Slides advance every 3 seconds in a continuous loop, with no pause control. The arrows are hidden on mobile.",
        impact: "There isn't enough time to read each destination and price.",
        action: "Add a pause control and lengthen the timing.",
      },
      {
        id: "UX-05",
        title: "Package prices shown at 10 px",
        severity: "medium",
        affected: "Homepage and Packages",
        evidence: "Price text is 10 px, and the asterisk is 7.5 px.",
        impact: "The key decision information is hard to read, especially on phones.",
        action: "Increase the price text size.",
      },
      {
        id: "UX-06",
        title: "Justified paragraphs leave large word gaps on mobile",
        severity: "low",
        affected: "About",
        evidence: "The 360 px screenshot shows wide word gaps in paragraphs of about 110 words.",
        impact: "Harder to read on phones.",
        action: "Left-align the text and use shorter paragraphs.",
      },
    ],
  },
  {
    heading: "Responsive behaviour",
    note:
      "Verified strength: no horizontal scrolling or cut-off content on any of the 5 pages at any of the 8 tested sizes (320–1440 px).",
    findings: [
      {
        id: "UX-07",
        title: "“Most Popular Tours” carousel has no controls on phones",
        severity: "medium",
        affected: "Homepage, screens 767 px wide and below",
        evidence: "One card shows at a time out of 23, with no navigation dots or arrows.",
        impact: "The other 22 tours are hard to find on mobile, with no visible way to browse them.",
        action: "Show navigation controls on mobile.",
      },
      {
        id: "UX-08",
        title: "Service images enlarged beyond their original size on tablets",
        severity: "medium",
        affected: "Homepage at 768 px",
        evidence:
          "Two images display at 690×690 px from 285×285 px originals, and the section is 2,745 px tall. At 390 px, tile heights alternate between 360 px and 177 px.",
        impact:
          "Images enlarged beyond their original resolution, and a very long scroll before the tours section.",
        action: "Use a two-column tablet layout and larger source images.",
      },
    ],
  },
  {
    heading: "Forms",
    note: "UX-10 (the form may not send the phone number and subject) requires validation. See the Priority Action Plan.",
    findings: [
      {
        id: "UX-09",
        title: "Contact form usability",
        severity: "medium",
        affected: "Contact",
        evidence: [
          "No visible field labels; hints disappear once typing starts.",
          "No required-field markers.",
          "The message placeholder reads “Write Comment”.",
          "The phone field doesn't accept “+”.",
          "The error message doesn't mention that a name is required.",
        ],
        impact: "More errors and abandoned enquiries.",
        action: "Add visible labels and required markers, and correct the field type and wording.",
      },
    ],
  },
  {
    heading: "Contrast",
    findings: [
      {
        id: "UX-11",
        title: "Main buttons have low contrast",
        severity: "medium",
        affected: "All pages (“VIEW MORE”, “LEARN MORE”, “SEND A MESSAGE”)",
        evidence:
          "White text on light blue gives a contrast ratio of 2.07:1. The recommended minimum is 4.5:1.",
        impact: "The main calls to action are hard to read.",
        action: "Use a darker button colour.",
      },
      {
        id: "UX-12",
        title: "Other text has low contrast",
        severity: "medium",
        affected: "All pages",
        evidence:
          "Section labels 2.36:1; copyright line 3.10:1; form text 4.08:1; body text 4.42:1. PageSpeed flags the section labels, About text and copyright line.",
        impact: "Reduced readability, especially for people with low vision.",
        action: "Darken these text colours.",
      },
    ],
  },
  {
    heading: "Accessibility",
    findings: [
      {
        id: "UX-13",
        title: "No visible keyboard focus",
        severity: "medium",
        affected: "All pages",
        evidence:
          "Moving through the page with the keyboard shows no visible highlight on buttons or form fields.",
        impact: "Keyboard users can't see where they are on the page.",
        action: "Add a visible focus style.",
      },
      {
        id: "UX-14",
        title: "Icon buttons have no accessible name",
        severity: "medium",
        affected: "The menu icon, chat button and homepage logo link",
        evidence:
          "These controls have no text label for screen readers. PageSpeed flags the logo and menu-icon links.",
        impact: "Screen-reader users can't identify these controls.",
        action: "Add descriptive labels.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Requires validation (in addition to the 60 confirmed findings)
// ---------------------------------------------------------------------------

export const REQUIRES_VALIDATION: readonly ValidationRow[] = [
  { id: "RV-01", item: "Mobile Largest Contentful Paint 39.7 s", step: "Re-run PageSpeed Insights", why: "The reported value doesn't match PageSpeed's own breakdown (about 2.0 s)" },
  { id: "RV-02", item: "“Links are not crawlable” and “1 link without descriptive text” (PageSpeed SEO)", step: "Re-run and record the specific links", why: "The affected links were not recorded" },
  { id: "RV-03", item: "“Displays images with incorrect aspect ratio” (PageSpeed Best Practices)", step: "Re-run and record the specific images", why: "The affected images were not recorded" },
  { id: "UX-10", item: "Contact form may not send the phone number and subject correctly; no failure message is shown", step: "Make a test submission and check what is received", why: "Based on the form's code; the received result is not yet confirmed. Recorded severity if confirmed: Medium." },
  { id: "SEO-04", item: "No structured data detected (Rich Results Test)", step: "Re-run the Rich Results Test and keep the result", why: "The detailed test output was not retained. Recorded severity if confirmed: Low–Medium." },
];

// ---------------------------------------------------------------------------
// 13. Strengths
// ---------------------------------------------------------------------------

export const STRENGTHS: readonly { title: string; text: string }[] = [
  { title: "Security certificate", text: "SSL Labs Grade A. The certificate is valid and trusted, covers both domain variants, uses only modern TLS 1.2 and 1.3, and has no known vulnerabilities." },
  { title: "HTTPS available", text: "The secure version of the site works correctly." },
  { title: "DNS", text: "Web, name server and email records are correctly configured." },
  { title: "Search visibility", text: "All checked pages are indexable and appear in Google. Every page has a title and a meta description." },
  { title: "Responsive layout", text: "No horizontal overflow on any page at any tested viewport (320–1440 px)." },
  { title: "Server response", text: "First byte in 0.143 s (WebPageTest Grade A), and PageSpeed reports the server responds quickly (245 ms)." },
  { title: "Stability", text: "Cumulative Layout Shift 0.007 and Total Blocking Time 80 ms, both rated Good." },
  { title: "Page foundations", text: "Every page declares its language and is set up for mobile devices." },
  { title: "Consistency", text: "Package cards follow one consistent design, and images keep their proportions." },
  { title: "Navigation", text: "The mobile menu opens, closes and lists all five pages correctly." },
];

// ---------------------------------------------------------------------------
// 14. Priority action plan
// ---------------------------------------------------------------------------

export const ACTIONS_HIGH: readonly ActionRow[] = [
  { ids: "K1", issue: "HTTP not redirected to HTTPS", action: "Set up 301 redirects to one HTTPS address", benefit: "Every visitor gets a secure connection, with no “Not Secure” warning" },
  { ids: "K2", issue: "Phone links dial the wrong branch", action: "Swap the two phone links", benefit: "Callers reach the intended branch" },
  { ids: "K3", issue: "No package detail or enquiry option", action: "Add package detail views or enquiry actions", benefit: "Visitor interest can turn into enquiries" },
  { ids: "K4", issue: "Service tiles do nothing", action: "Add service content or links", benefit: "Services can be explored" },
  { ids: "K5", issue: "Floating elements cover content", action: "Reposition or remove the floating elements", benefit: "Prices and contact details are fully visible" },
  { ids: "K6", issue: "Identical page titles", action: "Write unique page titles", benefit: "Pages are distinct in search results" },
  { ids: "K7", issue: "No main heading", action: "Add one H1 per page", benefit: "Clearer topics for search engines and screen readers" },
];

export const ACTIONS_MEDIUM: readonly ActionRow[] = [
  { ids: "SEO-01", issue: "Identical meta descriptions", action: "Write unique descriptions", benefit: "More informative search listings" },
  { ids: "SEO-02", issue: "Empty image ALT text", action: "Add descriptive ALT text", benefit: "Better accessibility and image search" },
  { ids: "SEO-03", issue: "No canonical tags", action: "Add canonical tags to a preferred domain", benefit: "A clear preferred address for each page" },
  { ids: "TECH-01", issue: "Broken “Home” link", action: "Point the links to the homepage", benefit: "No error pages from navigation" },
  { ids: "TECH-02", issue: "No robots.txt", action: "Create robots.txt", benefit: "Clear crawling instructions" },
  { ids: "TECH-03", issue: "No XML sitemap", action: "Publish and submit a sitemap", benefit: "More reliable page discovery" },
  { ids: "TECH-05", issue: "No custom 404 page", action: "Create a branded error page", benefit: "Lost visitors can find their way back" },
  { ids: "UX-03", issue: "Hero doesn't state the offer", action: "Add a short value statement", benefit: "Immediate understanding of the business" },
  { ids: "UX-04", issue: "Fast hero slider", action: "Add a pause control; lengthen the timing", benefit: "Offers can be read" },
  { ids: "UX-05", issue: "10 px prices", action: "Enlarge the price text", benefit: "Easier price comparison" },
  { ids: "UX-07", issue: "No mobile carousel controls", action: "Show navigation on mobile", benefit: "All 23 tours can be found on phones" },
  { ids: "UX-08", issue: "Enlarged tablet images", action: "Two-column layout, larger images", benefit: "Sharper images, shorter page" },
  { ids: "UX-09", issue: "Form usability", action: "Labels, required markers, correct field types", benefit: "Fewer form errors" },
  { ids: "UX-11, UX-12", issue: "Low contrast", action: "Darken the button and text colours", benefit: "Better readability" },
  { ids: "UX-13", issue: "No keyboard focus", action: "Add a visible focus style", benefit: "Usable by keyboard" },
  { ids: "UX-14", issue: "Unnamed icon controls", action: "Add labels", benefit: "Usable with screen readers" },
  { ids: "CQ-01, CQ-02, CQ-05, CQ-06", issue: "Key spelling and grammar errors", action: "Correct them as listed in Section 11", benefit: "A more professional impression" },
  { ids: "CQ-23", issue: "Unexplained price asterisk", action: "State the condition, or remove the asterisk", benefit: "Transparent pricing" },
  { ids: "CQ-25", issue: "Inconsistent contact numbers", action: "Standardise the numbers", benefit: "Callers reach the right place" },
];

export const ACTIONS_LOW: readonly ActionRow[] = [
  { ids: "SEC-02", issue: "Server software disclosed", action: "Reduce server information", benefit: "Less information exposed" },
  { ids: "UX-01", issue: "Menu hidden up to 1199 px", action: "Show the full menu from about 992 px", benefit: "Easier navigation on laptops" },
  { ids: "UX-02", issue: "Dead social links", action: "Link the profiles or remove the icons", benefit: "No dead ends" },
  { ids: "UX-06", issue: "Justified text gaps", action: "Left-align the text", benefit: "Easier reading on mobile" },
  { ids: "CQ-03, CQ-04, CQ-07 to CQ-22", issue: "Minor text errors and inconsistencies", action: "Correct them as listed in Section 11", benefit: "Polished, consistent content" },
  { ids: "CQ-24", issue: "Two brand names", action: "Confirm one brand presentation", benefit: "Consistent brand identity" },
];

export const ACTIONS_NOT_ASSIGNED: readonly ActionRow[] = [
  { ids: "SEC-01", issue: "Six security headers missing (Grade F)", action: "Configure the headers; add CSP carefully; add HSTS after K1", benefit: "Stronger browser-level protection" },
  { ids: "TECH-04", issue: "Site loads at www and non-www addresses", action: "Choose one preferred address and redirect the other (together with K1)", benefit: "One consistent address" },
  { ids: "PERF-01", issue: "About 12.5 MB page weight, mostly images", action: "Resize, compress and modernise images", benefit: "Faster loading, especially on mobile" },
  { ids: "PERF-02", issue: "No browser caching", action: "Set cache lifetimes", benefit: "Faster repeat visits" },
  { ids: "PERF-03", issue: "No text compression", action: "Enable gzip or Brotli", benefit: "Smaller downloads" },
  { ids: "PERF-04", issue: "Render-blocking files and unused code", action: "Remove, defer and minify", benefit: "Faster first display" },
  { ids: "PERF-05", issue: "Hero image not prioritised", action: "Prioritise and compress the hero image", benefit: "Main content appears sooner" },
];

// ---------------------------------------------------------------------------
// 15. Final assessment
// ---------------------------------------------------------------------------

export const FINAL_ASSESSMENT = {
  foundation:
    "The Adems Travel website has a solid technical base: a Grade A, fully trusted certificate; correctly configured domain records; indexable pages; a fast-responding server; and a layout that holds together on every tested screen size. No Critical issues were identified.",
  risks: [
    "**Enquiries:** visitors can't move from packages or services to an enquiry, the Contact page's phone links are swapped, and floating elements cover prices and contact details.",
    "**Search visibility:** identical titles and descriptions and missing main headings.",
    "**Security:** plain HTTP visitors aren't redirected to the secure site, and recommended security headers are missing.",
    "**Performance:** page weight of about 12.5 MB, mostly images.",
  ],
  nextSteps: [
    "Redirect to HTTPS and correct the phone links.",
    "Make packages and services lead to an enquiry.",
    "Keep floating elements clear of content.",
    "Give each page a unique title, description and main heading.",
    "Optimise images and caching.",
    "Complete the five validation checks.",
  ],
  closing: "A follow-up audit after these changes will measure the improvement.",
} as const;

// ---------------------------------------------------------------------------
// 16. Appendix
// ---------------------------------------------------------------------------

export const APPENDIX_SCOPE: readonly string[] = [
  "**Audit Date:** 17 September 2026. The tool table below keeps the date each individual check was run, as recorded in its evidence.",
  "**Pages:** Home (`/`, `/index.php`), About, Services, Packages, Contact, plus the company profile PDF and the broken `/index.html` address.",
  "**Addresses:** `ademstravel.com` and `www.ademstravel.com`, over both HTTP and HTTPS.",
  "**Screen sizes tested:** 1440×900, 1280×800, 1024×768, 768×1024, 390×844, 375×812, 360×800, 320×568. Additional screenshots at 400×546.",
];

export const APPENDIX_TOOLS: readonly { tool: string; purpose: string; date: string }[] = [
  { tool: "Browser inspection and Chrome developer tools", purpose: "Content, UX, accessibility, responsive layout", date: "17–19 Sep 2026" },
  { tool: "Google PageSpeed Insights (Lighthouse 13.4.1)", purpose: "Mobile and desktop performance", date: "17 Sep 2026" },
  { tool: "WebPageTest (Chrome, Bratislava, 3 runs)", purpose: "Load performance", date: "17 Sep 2026" },
  { tool: "Qualys SSL Labs", purpose: "Certificate and TLS configuration", date: "17 Sep 2026" },
  { tool: "securityheaders.com", purpose: "Security headers", date: "17 Sep 2026" },
  { tool: "SEO crawl, Google site: search, Google Rich Results Test", purpose: "On-page SEO and indexability", date: "17 Sep 2026" },
  { tool: "DNS lookup", purpose: "Domain records", date: "17 Sep 2026" },
  { tool: "HTTP status checks", purpose: "Redirects, robots.txt, sitemap", date: "19 Sep 2026" },
];

export const APPENDIX_LIMITATIONS: readonly string[] = [
  "Google Search Console was not available.",
  "The PageSpeed mobile test ran on the HTTP address. The SSL and security-header tests ran on the HTTPS address. All four address variants serve the same site.",
  "The WebPageTest connection profile was not recorded.",
  "The contact form was not submitted during the audit.",
  "Lab performance results vary between runs.",
];

export const NOT_ASSESSED: readonly string[] = [
  "H3 headings and overall heading structure",
  "Duplicate body content",
  "Title and description display width in search results",
  "Desktop PageSpeed individual metrics",
  "SPF and DMARC email authentication",
  "Google Search Console data",
  "Total crawled-URL count",
  "Exact count of images with empty ALT text",
];

export const TO_CONFIRM: readonly string[] = [
  "The chat widget works as intended.",
  "Contact form messages are received.",
  "The WhatsApp number is active.",
  "The “Nadi, Fiji” hero image shows the intended destination.",
  "Which branch the map pin marks.",
  "What triggers the “Raise a request!” pop-up.",
  "The brochure PDF content.",
  "The target market and primary conversion goal.",
];

// ---------------------------------------------------------------------------
// Every confirmed finding, for counting and ID checks
// ---------------------------------------------------------------------------

/** One entry per confirmed finding ID, with its severity. */
export function confirmedFindings(): readonly { id: string; severity: Severity }[] {
  const cards: Finding[] = [
    ...KEY_FINDINGS,
    SEO_01,
    SEO_02,
    SEO_03,
    ...TECH_FINDINGS,
    SEC_01,
    SEC_02,
    ...CONTENT_FINDINGS,
    ...UX_GROUPS.flatMap((group) => group.findings),
  ];
  return [
    ...cards.map(({ id, severity }) => ({ id, severity })),
    ...CONTENT_ROWS.map(({ id, severity }) => ({ id, severity })),
    ...PERF_FINDINGS.map(({ id }) => ({ id, severity: "not-assigned" as Severity })),
  ];
}

/** The executive summary's counts, derived rather than typed. */
export function findingCounts() {
  const all = confirmedFindings();
  const of = (severity: Severity) => all.filter((f) => f.severity === severity).length;
  return {
    confirmed: all.length,
    critical: 0,
    high: of("high"),
    medium: of("medium"),
    low: of("low"),
    notAssigned: of("not-assigned"),
    requiresValidation: REQUIRES_VALIDATION.length,
  };
}
