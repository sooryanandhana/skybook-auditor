/**
 * Fixed wording for the redesigned PDF report (CP1 v6).
 *
 * WORDING ONLY. Every string here is approved report text, kept in one place so
 * that each sentence is written once and tested once. Nothing in this file
 * reads an audit, counts anything or decides what to show: the code that
 * places these texts decides whether they apply. Where a sentence carries a
 * figure, it is a small function that takes the figure, so the figure always
 * comes from the caller's verified data and never from here.
 *
 * NOT YET PRINTED. The redesigned report sections that use these texts arrive
 * in a later checkpoint. Until then the report prints exactly what it printed
 * before, and these constants are covered by their own tests only.
 *
 * COMPANY CONFIRMATION (CP1 R2): CONFIRMED. Skybook has approved the Skybook
 * section's marketing claims, the report contact wording ("your Skybook
 * contact") and contact-field approach, and the exact brand name: Skybook.
 */

// ---------------------------------------------------------------------------
// Section introductions
// ---------------------------------------------------------------------------

export const SECTION_INTROS = {
  pageLevelIssues:
    "These issues were found on individual pages. Each one explains what was found, where, why it matters and what to do about it. The count beside each issue shows how many of the pages we checked it was found on.",
  seo:
    "This section shows every search-visibility check and its result. Issues are explained in full under Page-Level Issues and are only referred to here.",
  security:
    "This section covers how safely the site is delivered and how its domain is protected, including in email. Issues that apply to the whole domain are explained here in full.",
  technical:
    "This section covers the instructions the site gives to search engines and how many of its pages could be found and read.",
  limitations:
    "This section explains what the audit could and could not check, so the results above can be read accurately.",
} as const;

// ---------------------------------------------------------------------------
// "What we checked and why it matters" -- the fixed parts of each area
// ---------------------------------------------------------------------------

export interface AreaText {
  readonly whatItIs: string;
  readonly whyItMatters: string;
  readonly whatWeChecked: string;
}

export const AREA_TEXTS: Readonly<Record<"seo" | "security" | "speed" | "technical", AreaText>> = {
  seo: {
    whatItIs:
      "Search visibility, often called SEO, is how clearly your pages describe themselves to search engines such as Google and to the people who find them there.",
    whyItMatters:
      "When pages have clear titles, descriptions, headings and a stated preferred address, search engines can understand and present them more accurately, and visitors can see quickly that a page is relevant to them.",
    whatWeChecked:
      "Page titles, the descriptions shown in search results, main headings and heading order, the preferred-address (canonical) setting, the declared language, the mobile display setting, and image descriptions, on every page we could read.",
  },
  security: {
    whatItIs:
      "Website security covers how safely your site is delivered to visitors and how well your domain is protected from being misused, including in email.",
    whyItMatters:
      "Visitors and browsers look for signs that a site is genuine and that information sent to it is protected. A missing safeguard does not mean a site has been attacked, but it leaves fewer layers of protection in place.",
    whatWeChecked:
      "The secure (HTTPS) connection and its certificate, the protective instructions the site sends to browsers, how forms and files are loaded, cookie protection where cookies are used, and the domain's email-authentication records.",
  },
  speed: {
    whatItIs:
      "Speed and performance describe how quickly your pages appear and respond for visitors on a mobile phone.",
    whyItMatters:
      "Visitors judge a site partly by how quickly it loads. Slow pages can lead some visitors to leave before they see what you offer.",
    whatWeChecked:
      "Google's records of real visits to the page where available, and a simulated test of the page on a mobile phone. A desktop measurement is shown for information and does not affect the grade.",
  },
  technical: {
    whatItIs:
      "Technical setup covers the instructions your site gives to search engines and how easily its pages can be found and read.",
    whyItMatters:
      "If search engines are told not to visit a site, or cannot find its pages, those pages may be missing from search results.",
    whatWeChecked:
      "The robots.txt file (the site's instructions to search engines), whether a sitemap (a list of the site's pages for search engines) is published, and how many of the pages we found could be read.",
  },
};

// ---------------------------------------------------------------------------
// Check-list status lines (SEO and Security sections)
// ---------------------------------------------------------------------------

export const CHECK_STATUS = {
  noIssue: "No issue found on the pages where this could be checked",
  partlyChecked: "Could not be checked on some pages: see Limitations",
  notChecked: "Not checked: see Limitations",
} as const;

/** "Issue found: see Page-Level Issues: {title}". */
export function checkIssueFound(title: string): string {
  return `Issue found: see Page-Level Issues: ${title}`;
}

/** "Not applicable: {reason}", for example "the site sets no cookies". */
export function checkNotApplicable(reason: string): string {
  return `Not applicable: ${reason}`;
}

/** Labels the four security headers that are recorded but not graded. */
export const INFORMATION_ONLY_LABEL = "Recorded for information only; not part of the grade.";

// ---------------------------------------------------------------------------
// The AI paragraph's label (PDF only; the dashboard keeps its own)
// ---------------------------------------------------------------------------

export const AI_SUMMARY_LABEL =
  "Written by AI from the verified findings in this report. Every finding, severity and figure was measured by the audit itself.";

// ---------------------------------------------------------------------------
// Speed: the glossary and the real-visitor explanation
// ---------------------------------------------------------------------------

export const SPEED_GLOSSARY_HEADING = "What these measurements mean";

/**
 * One entry per metric. An entry is printed only when its metric is actually
 * shown in the report; the caller makes that decision.
 */
export const SPEED_GLOSSARY = {
  lcp: "LCP (Largest Contentful Paint): how long the main visible content of the page takes to appear.",
  fcp: "FCP (First Contentful Paint): how long it takes before anything first appears on the screen.",
  tbt: "TBT (Total Blocking Time): how much time the browser is too busy to respond to the visitor while the page loads.",
  speedIndex: "Speed Index: how quickly the visible parts of the page are filled in.",
  cls: "CLS (Cumulative Layout Shift): how much the page's content unexpectedly moves around while it loads.",
  inp: "INP (Interaction to Next Paint): how quickly the page responds visually after a visitor interacts with it, such as clicking a button or tapping a menu.",
  ttfb: "TTFB (Time to First Byte): how long it takes for the server to begin sending a response after a visitor requests a page.",
} as const;

export const REAL_VISITOR_HEADING = "About real-visitor data";

/** The full explanation, printed once, in the Speed section. */
export function realVisitorExplanation(url: string): readonly string[] {
  return [
    "Google records how fast pages load for real people who visit them using the Chrome browser, collected over recent weeks. Where a page has enough visits, Google reports how fast it was for most of those visitors. Many smaller websites do not receive enough visits for Google to report these figures.",
    "When real-visitor figures are not available, the report relies on a simulated test: Google loads the page once on a simulated mobile phone and network. A simulated test is useful for finding what slows a page down, but it is a single run under fixed conditions, so its results can differ from what real visitors experience. Missing real-visitor data says nothing, good or bad, about how fast the site is.",
    `Speed is measured on ${url}. Desktop results are shown for information and do not affect the grade.`,
  ];
}

/** The short reference printed in Limitations instead of repeating the explanation. */
export const REAL_VISITOR_REFERENCE =
  "Google's real-visitor speed data was not available for this site; see Speed & Performance for what this means.";

// ---------------------------------------------------------------------------
// Crawl coverage
// ---------------------------------------------------------------------------

/**
 * The first row of the Technical crawl table. Which one applies depends on
 * whether the found total includes the starting address -- a fact the shared
 * coverage check establishes, never this file.
 */
export const ADDRESSES_FOUND_LABEL = {
  includingStartingAddress: "Addresses found (including the starting address)",
  plain: "Addresses found",
} as const;

/** robots.txt exclusions, with the count: only when the coverage counts reconciled. */
export function robotsExclusionSentence(excluded: number): string {
  return excluded === 1
    ? "A further 1 address was not visited because the site's robots.txt asks automated tools not to."
    : `A further ${excluded} addresses were not visited because the site's robots.txt asks automated tools not to.`;
}

/** robots.txt exclusions, without a count: when the coverage counts did not reconcile. */
export const ROBOTS_EXCLUSION_UNCOUNTED =
  "Some addresses were not visited because the site's robots.txt asks automated tools not to.";

/** Why a crawl stopped at a limit, when the coverage counts did not reconcile. No figures. */
export const SAFETY_LIMIT_STOP = "The audit stopped after reaching its configured safety limit.";

/**
 * The limits the audit was configured with. These are settings, not
 * measurements, so they may be shown even when the coverage counts could not
 * be verified. `duration` arrives with its unit already written out.
 */
export function configuredLimitsSentence(maxPages: string, duration: string): string {
  return `Configured limits for this audit: up to ${maxPages} pages and ${duration}.`;
}

/** Printed under an affected-page list only when the list was actually cut short. */
export const AFFECTED_LIST_TRUNCATED = "Further affected pages are not listed.";

/** The sitemap fact when the site publishes none. */
export const NO_SITEMAP_SENTENCE = "No sitemap was found, so none was read.";

// ---------------------------------------------------------------------------
// The Skybook section [COMPANY: confirmed, CP1 R2]
// ---------------------------------------------------------------------------

/** The printed heading. "How Skybook Can Help" is the section's internal name only. */
export const PITCH_HEADING = "Let's Make Your Website Work Better for Your Business";

export const PITCH_PARAGRAPHS: readonly string[] = [
  "This audit gives a clear picture of how your website performs today: where it is working well and where it could do more for your business. The next step is turning those findings into practical improvements.",
  "The Skybook team can work through this report with you, explain what each finding means for your business, and help you decide which improvements matter most and in what order. We can help improve how quickly your pages load and how smoothly they work for visitors, and strengthen how clearly your website presents itself to search engines and to the people searching for what you offer.",
  "Where findings involve technical or security settings, we can work alongside your developer or hosting provider so that changes are planned carefully and made without disrupting your website or email. Beyond the first round of changes, we can help you plan ongoing improvements and run a follow-up audit to confirm what has changed, using the same measurements as this report.",
  "If you would like to discuss these findings, your Skybook contact will be glad to talk them through with you.",
];
