/**
 * The PDF's overall summary, written by code from the verified audit.
 *
 * WHY CODE AND NOT A MODEL. The summary has to exist, be accurate and cover
 * every area on every report -- including the day the AI service is down. So
 * every sentence here is assembled from a measured value, a rule's outcome or a
 * fixed explanation in our source. The AI summary, when there is one, is shown
 * beside it as an addition; nothing here depends on it.
 *
 * FOUR KINDS OF "NO" ARE KEPT APART, because a client reads them very
 * differently:
 *   - a record that was looked for and NOT FOUND ("No DMARC policy was found"),
 *   - a check that FAILED or could not be completed ("the lookup failed, so this
 *     could not be determined"),
 *   - a check that was NOT RUN for this report (speed not requested), and
 *   - a check this audit DOES NOT PERFORM AT ALL ("Not checked by this audit").
 * None of them is described as a problem with the website unless a rule said so.
 *
 * NOTHING IS INVENTED. Numbers are measured values or counts of findings the
 * rules produced; addresses are the ones the audit read; classifications are
 * Google's own (FAST / AVERAGE / SLOW, and the published 90/50 bands for the
 * simulated score). Consequences are phrased as possibilities.
 *
 * PURE. Reads its input, returns an object. No network, no environment, no
 * clock: the dates printed are the audit's own.
 */
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import { ALL_RULES, SPEED_RULES } from "../rules/all.ts";
import type {
  AuditData,
  Finding,
  PerformanceData,
  PerformanceRating,
  Severity,
  SkippedCheck,
} from "../types.ts";
import { explainerFor, whoFixesLabel } from "./findingExplainers.ts";
import { fieldShiftText, metricDurationText } from "./measurementsView.ts";
import { affectedViewFor, crawlView, findingScope, scopeLabel, type CoverageCheck } from "./siteFindingsView.ts";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The verdict shown beside an area's heading. Never stronger than the evidence. */
export type AreaStatus = "good" | "improve" | "attention" | "incomplete" | "not-measured";

export const AREA_STATUS_LABELS: Record<AreaStatus, string> = {
  good: "In good shape",
  improve: "Room for improvement",
  attention: "Needs attention",
  incomplete: "Partly checked",
  "not-measured": "Not measured",
};

export interface SummaryArea {
  readonly key: "speed" | "seo" | "security" | "certificate" | "domain" | "site";
  readonly heading: string;
  readonly status: AreaStatus;
  readonly statusLabel: string;
  readonly paragraphs: readonly string[];
}

export interface SummaryPriority {
  readonly title: string;
  readonly severityLabel: string;
  /** Where it was found: "Site-wide" or "19 of 128 evaluated pages". */
  readonly reach: string;
  readonly whyItMatters: string;
  readonly whoFixes: string | null;
}

export interface SkybookHelp {
  readonly intro: string;
  readonly items: readonly string[];
  readonly closing: string;
}

export interface OverallSummary {
  /** Scope and overall condition, in plain sentences. */
  readonly overview: readonly string[];
  readonly areas: readonly SummaryArea[];
  /**
   * The Security status: the most serious of the security, certificate and
   * domain areas' statuses (CP3-Q2a, C2).
   */
  readonly securityStatus: AreaStatus;
  /** Checks that ran and found nothing wrong, in plain words. */
  readonly strengths: readonly string[];
  /** The most important problems, worst first. Empty when there are none. */
  readonly priorities: readonly SummaryPriority[];
  /** What limits the assessment: incomplete crawl, checks that could not run. */
  readonly limitations: readonly string[];
  /** Areas this audit does not examine at all. */
  readonly notChecked: readonly string[];
  readonly help: SkybookHelp;
}

export interface OverallSummaryInput {
  /** The address actually read, credentials already removed. */
  readonly auditedUrl: string;
  /** The audit's own date, already formatted for reading. */
  readonly checkedAt: string | null;
  /** The entry page's measurements. Speed is the MOBILE result, as graded. */
  readonly data: AuditData;
  readonly crawl: SiteCrawlSummary;
  readonly findings: readonly Finding[];
  readonly skippedChecks: readonly SkippedCheck[];
  /** Rules the audit ran, from the result's own ledger. Null when it kept none. */
  readonly ranRules: readonly string[] | null;
  /** The existing grade, e.g. "B", and its band label. Never recomputed here. */
  readonly grade: string | null;
  readonly gradeLabel: string | null;
  /** A separately measured desktop speed result, or null when there is none. */
  readonly desktop: PerformanceData | null;
  /**
   * Whether the crawl's counts reconciled, worked out once by the document and
   * passed in. A finding's reach is shown only when it did; this file never
   * checks the counts itself.
   */
  readonly coverage: CoverageCheck | null;
}

// ---------------------------------------------------------------------------
// Fixed wording
// ---------------------------------------------------------------------------

/** Checks this audit does not perform. Shown so their absence is never read as a pass. */
export const NOT_CHECKED_BY_THIS_AUDIT: readonly string[] = [
  "DKIM email signing (it is configured with the email provider and needs details this audit does not have)",
  "Broken links between pages",
  "Structured data (schema markup)",
  "Search-engine indexing instructions such as \"noindex\"",
  "Whether http:// addresses redirect to https://",
  "Visual layout and how pages look on different screen sizes",
  "Current search rankings, visitor numbers or sales",
];

/** Said wherever an "unknown" could be mistaken for a fault. */
const NOT_A_VERDICT = "This says nothing about the website itself.";

/**
 * What a passing check means, in plain words: the count-safe sentences of
 * CP1 v6 §5.2 (CP3-O7). None claims every page, because a check that ran may
 * still have been unable to judge some of them. Speed is described from
 * measurements instead. Exported so the wording can be reviewed as printed.
 */
export const PASSED: Readonly<Record<string, { readonly text: string; readonly area: SummaryArea["key"] }>> = {
  "security.https": { text: "The pages checked were delivered over a secure HTTPS connection.", area: "security" },
  "security.ssl.expired": { text: "The certificate was within its validity period.", area: "certificate" },
  "security.ssl.hostname": { text: "The certificate covers the address the site was reached on.", area: "certificate" },
  "security.ssl.untrusted": { text: "The certificate is trusted by the system that checked it.", area: "certificate" },
  "security.mixed-content": {
    text: "No files loaded over an insecure (http://) connection were found on the pages where this could be checked.",
    area: "security",
  },
  "security.form.insecure": {
    text: "No forms sending information over an unencrypted connection were found on the pages checked.",
    area: "security",
  },
  "security.headers.hsts": { text: "The site sends the HSTS instruction on the pages where this could be checked.", area: "security" },
  "security.headers.csp": { text: "The site sends a Content-Security-Policy on the pages where this could be checked.", area: "security" },
  "security.cookies.secure": { text: "Cookies set by the pages checked have the Secure protection.", area: "security" },
  "security.cookies.httponly": { text: "Cookies set by the pages checked have the HttpOnly protection.", area: "security" },
  "security.dns.spf": { text: "The domain publishes an SPF record for its email.", area: "domain" },
  "security.dns.dmarc": { text: "The domain publishes a DMARC policy for its email.", area: "domain" },
  "seo.viewport.missing": { text: "No missing mobile display setting was found on the pages where this could be checked.", area: "seo" },
  "seo.title.missing": { text: "No missing page title was found on the pages where this could be checked.", area: "seo" },
  "seo.meta-description.missing": { text: "No missing description was found on the pages where this could be checked.", area: "seo" },
  "seo.canonical.missing": { text: "No missing canonical address was found on the pages where this could be checked.", area: "seo" },
  "seo.lang.missing": { text: "No missing language setting was found on the pages where this could be checked.", area: "seo" },
  "seo.h1.missing": { text: "No page checked was missing a main heading.", area: "seo" },
  "seo.h1.multiple": { text: "No page checked had more than one main heading.", area: "seo" },
  "seo.h1.empty": { text: "No page checked had an empty main heading.", area: "seo" },
  "seo.headings.order": { text: "Heading levels were in order on the pages where this could be checked.", area: "seo" },
  "seo.images.alt": { text: "Images on the pages checked have descriptions (alternative text).", area: "seo" },
  "technical.robots.blocks-all": { text: "The robots.txt file does not block search engines from the site.", area: "site" },
};

/** Added to a strength whose check could not run on every page (CP1 v6 §5.2). */
export const NOT_EVERY_PAGE_CHECKED = "(not every page could be checked; see Limitations)";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, good: 3 };
const SEVERITY_WORD: Record<Exclude<Severity, "good">, string> = {
  critical: "Critical",
  high: "High priority",
  medium: "Medium priority",
};
const MAX_PRIORITIES = 5;
const MAX_NAMES_LISTED = 6;

/** Google's own words for its speed categories. */
const RATING_WORD: Record<PerformanceRating, string> = {
  FAST: "good",
  AVERAGE: "needs improvement",
  SLOW: "poor",
};

/** Rule id -> title, for checks that could not run. */
const RULE_TITLES = new Map(ALL_RULES.map((rule) => [rule.id, rule.title]));
const SPEED_IDS = new Set(SPEED_RULES.map((rule) => rule.id));
const SSL_IDS = new Set(["security.ssl.expired", "security.ssl.hostname", "security.ssl.untrusted"]);
const DNS_IDS = new Set(["security.dns.spf", "security.dns.dmarc"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isProblem = (finding: Finding): boolean => finding.severity !== "good";

function problemsIn(findings: readonly Finding[], test: (finding: Finding) => boolean): Finding[] {
  return findings.filter((finding) => isProblem(finding) && test(finding));
}

/**
 * "No meta description (19 of 128 evaluated pages)", or "No SPF record
 * published (site-wide)".
 *
 * THE REACH IS SHOWN ONLY FROM COUNTS THAT RECONCILED, read from the coverage
 * result the document passed in. When a page finding's reach is withheld, the
 * finding is named without brackets: an unknown reach is never re-labelled as
 * site-wide.
 */
function namedFinding(finding: Finding, coverage: CoverageCheck | null): string {
  const reach = affectedViewFor(finding, coverage).reach;
  if (reach !== null) return `${finding.title} (${reach})`;
  return findingScope(finding) === "site" ? `${finding.title} (site-wide)` : finding.title;
}

/** "a, b and c" -- with the rest counted rather than listed when there are many. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  const shown = items.slice(0, MAX_NAMES_LISTED);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A date from an ISO string, e.g. "25 December 2026". Null when unreadable. */
function readableDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * The rules that ran and did not fire, by the result's own ledger.
 *
 * THE ROBOTS STRENGTH NEEDS A FILE. With no robots.txt at all the rule still
 * passes, because nothing blocks anything; but "the robots.txt file does not
 * block search engines" would describe a file that does not exist. So it is a
 * strength only when the file was found.
 */
function passedRuleIds(input: OverallSummaryInput): string[] {
  if (input.ranRules === null) return [];
  const fired = new Set(input.findings.filter(isProblem).map((finding) => finding.id));
  const robotsFound = input.data.technical?.robotsTxtStatus === "found";
  return input.ranRules.filter(
    (id) =>
      !fired.has(id) &&
      Object.hasOwn(PASSED, id) &&
      (id !== "technical.robots.blocks-all" || robotsFound),
  );
}

/**
 * A strength as printed: the approved sentence, qualified when the check could
 * not run on every page it was meant to.
 */
function strengthText(id: string, skippedIds: ReadonlySet<string>): string {
  const text = PASSED[id].text;
  return skippedIds.has(id) ? text.replace(/\.$/, ` ${NOT_EVERY_PAGE_CHECKED}.`) : text;
}

function strengthsFor(input: OverallSummaryInput, area: SummaryArea["key"]): string[] {
  const skippedIds = new Set(input.skippedChecks.map((skipped) => skipped.ruleId));
  return passedRuleIds(input)
    .filter((id) => PASSED[id].area === area)
    .map((id) => strengthText(id, skippedIds));
}

function area(
  key: SummaryArea["key"],
  heading: string,
  status: AreaStatus,
  paragraphs: readonly string[],
): SummaryArea {
  return { key, heading, status, statusLabel: AREA_STATUS_LABELS[status], paragraphs };
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

/** How the simulated score is classed, using Google's published bands. */
function labBand(score: number): "good" | "needs improvement" | "poor" {
  if (score >= 90) return "good";
  if (score >= 50) return "needs improvement";
  return "poor";
}

/** The worst speed reading on one device, for the area's status. */
function deviceStatus(perf: PerformanceData): AreaStatus | null {
  if (perf.status !== "checked") return null;
  const ratings: PerformanceRating[] = [];
  if (perf.field.status === "found") {
    for (const metric of [perf.field.lcp, perf.field.inp, perf.field.cls]) {
      if (metric !== null) ratings.push(metric.category);
    }
  }
  const score = perf.lab.status === "found" ? perf.lab.score : null;
  if (ratings.includes("SLOW") || (score !== null && score < 50)) return "attention";
  if (ratings.includes("AVERAGE") || (score !== null && score < 90)) return "improve";
  if (ratings.length > 0 || score !== null) return "good";
  return null;
}

/** What one device's speed result says, in plain sentences. */
function deviceParagraphs(device: "Mobile" | "Desktop", perf: PerformanceData | null): string[] {
  if (perf === null) return [`${device}: speed was not measured for this report.`];

  switch (perf.status) {
    case "not-requested":
      return [`${device}: speed was not measured for this report.`];
    case "no-api-key":
      return [
        `${device}: speed was not measured because the speed-testing service is not set up on our server. ${NOT_A_VERDICT}`,
      ];
    case "pending":
      return [`${device}: speed results were not ready when this report was produced.`];
    case "error":
      return [`${device}: the speed test did not complete, so speed could not be measured. ${NOT_A_VERDICT}`];
    case "checked":
      break;
  }

  const out: string[] = [];
  const field = perf.field;
  if (field.status === "found") {
    const parts: string[] = [];
    if (field.lcp !== null) {
      parts.push(`the main content appeared within ${metricDurationText(field.lcp.percentileMs)} (${RATING_WORD[field.lcp.category]})`);
    }
    if (field.inp !== null) {
      parts.push(`the page responded to taps and clicks within ${metricDurationText(field.inp.percentileMs)} (${RATING_WORD[field.inp.category]})`);
    }
    if (field.cls !== null) {
      parts.push(`layout movement measured ${fieldShiftText(field.cls)} (${RATING_WORD[field.cls.category]})`);
    }
    const overall =
      field.overall === null ? "" : ` Google rates the overall experience as ${RATING_WORD[field.overall]}.`;
    out.push(
      `${device}, real visitors: according to Google's records of real visits, ${parts.length > 0 ? listed(parts) : "no individual measurements were reported"}.${overall}`,
    );
  } else {
    out.push(
      `${device}, real visitors: Google does not have enough real-visitor data for this page, so only a simulated test is available. This does not mean the page is slow.`,
    );
  }

  if (perf.lab.status === "found" && perf.lab.score !== null) {
    const score = perf.lab.score;
    out.push(
      `${device}, simulated test: the page scored ${score} out of 100, which Google classes as ${labBand(score)} (90–100 good, 50–89 needs improvement, below 50 poor). A simulated test loads the page once under fixed conditions; it helps to find problems but does not measure every visitor's experience.`,
    );
  } else {
    out.push(`${device}, simulated test: Google's simulated test did not return a score.`);
  }
  return out;
}

function speedArea(input: OverallSummaryInput): SummaryArea {
  const mobile = input.data.performance;
  const desktop = input.desktop;
  const problems = problemsIn(input.findings, (finding) => SPEED_IDS.has(finding.id));

  const paragraphs = [...deviceParagraphs("Mobile", mobile), ...deviceParagraphs("Desktop", desktop)];
  if (problems.length > 0) {
    paragraphs.push(`Speed issues found on mobile: ${listed(problems.map((finding) => finding.title))}.`);
  }
  paragraphs.push("Mobile and desktop are measured separately and can differ; one does not stand in for the other.");
  if (desktop !== null) {
    paragraphs.push(
      "The status for this area reflects the weaker of the two devices, but only the mobile result is graded: the desktop result does not create audit findings or change the grade.",
    );
  }

  const statuses = [deviceStatus(mobile), desktop === null ? null : deviceStatus(desktop)].filter(
    (status): status is AreaStatus => status !== null,
  );
  const status: AreaStatus =
    problems.length > 0 || statuses.includes("attention")
      ? "attention"
      : statuses.includes("improve")
        ? "improve"
        : statuses.includes("good")
          ? "good"
          : "not-measured";

  return area("speed", "Website speed and performance", status, paragraphs);
}

// ---------------------------------------------------------------------------
// Search visibility and content
// ---------------------------------------------------------------------------

function seoArea(input: OverallSummaryInput): SummaryArea {
  const problems = problemsIn(input.findings, (finding) => finding.category === "seo");
  const passed = strengthsFor(input, "seo");
  const paragraphs: string[] = [];

  if (problems.length > 0) {
    paragraphs.push(`Issues found: ${listed(problems.map((finding) => namedFinding(finding, input.coverage)))}.`);
  }
  if (passed.length > 0) paragraphs.push(`Working well: ${passed.join(" ")}`);
  if (paragraphs.length === 0) {
    paragraphs.push("The page titles, descriptions, headings and related checks could not be assessed for this report.");
  }
  paragraphs.push(
    "These checks look at how pages are described and structured for search engines and visitors. They do not measure the site's current search rankings.",
  );

  const status: AreaStatus =
    problems.length > 0 ? "attention" : passed.length > 0 ? "good" : "not-measured";
  return area("seo", "Search visibility and content", status, paragraphs);
}

// ---------------------------------------------------------------------------
// Security and HTTPS
// ---------------------------------------------------------------------------

function securityArea(input: OverallSummaryInput): SummaryArea {
  const { fetch, security } = input.data;
  const paragraphs: string[] = [];

  if (fetch.servedOverHttps) {
    paragraphs.push("The main page checked was delivered over a secure HTTPS connection.");
  } else if (fetch.httpsUnavailable) {
    paragraphs.push("The site could not be reached over HTTPS, so the main page was read over an unencrypted connection.");
  } else {
    paragraphs.push("The main page checked was delivered over an unencrypted (http://) connection.");
  }

  if (security.hsts.applicable) {
    paragraphs.push(
      security.hsts.valid
        ? "It tells browsers to always use the secure version of the site (HSTS is in place)."
        : "It does not send a usable instruction telling browsers to always use the secure version of the site (HSTS).",
    );
  }

  if (security.contentSecurityPolicy.present) {
    paragraphs.push("It sends a Content-Security-Policy, which limits where scripts and other content may come from.");
  } else if (security.contentSecurityPolicyReportOnly.present) {
    paragraphs.push("It sends a Content-Security-Policy in report-only mode, which monitors but does not enforce the policy.");
  } else if (security.contentSecurityPolicyMeta) {
    paragraphs.push("It declares a Content-Security-Policy inside the page rather than as a response header.");
  } else {
    paragraphs.push("It does not send a Content-Security-Policy.");
  }

  const extra = [
    { name: "X-Frame-Options", header: security.xFrameOptions },
    { name: "X-Content-Type-Options", header: security.xContentTypeOptions },
    { name: "Referrer-Policy", header: security.referrerPolicy },
    { name: "Permissions-Policy", header: security.permissionsPolicy },
  ];
  const missing = extra.filter((entry) => !entry.header.present).map((entry) => entry.name);
  paragraphs.push(
    missing.length === 0
      ? "It also sends all four further protective headers we checked (X-Frame-Options, X-Content-Type-Options, Referrer-Policy and Permissions-Policy)."
      : `Of four further protective headers we checked, it does not send ${listed(missing)}. These are recorded for information and are not graded.`,
  );

  const problems = problemsIn(
    input.findings,
    (finding) => finding.category === "security" && !SSL_IDS.has(finding.id) && !DNS_IDS.has(finding.id),
  );
  if (problems.length > 0) {
    paragraphs.push(`Issues found: ${listed(problems.map((finding) => namedFinding(finding, input.coverage)))}.`);
  }
  const passed = strengthsFor(input, "security");
  if (passed.length > 0) paragraphs.push(`Working well: ${passed.join(" ")}`);

  paragraphs.push(
    "A missing protective header means one fewer safeguard. It is not evidence that the site has a weakness or has been attacked.",
  );

  const status: AreaStatus = problems.length > 0 ? "attention" : missing.length > 0 ? "improve" : "good";
  return area("security", "Security and HTTPS", status, paragraphs);
}

// ---------------------------------------------------------------------------
// Certificate
// ---------------------------------------------------------------------------

function certificateArea(input: OverallSummaryInput): SummaryArea {
  const ssl = input.data.ssl;
  const heading = "SSL/TLS certificate";

  if (ssl.status === "not-applicable") {
    return area("certificate", heading, "not-measured", [
      "No certificate was checked, because the site was not served over HTTPS.",
    ]);
  }
  if (ssl.status !== "checked" || ssl.certificate === null) {
    return area("certificate", heading, "incomplete", [
      `The certificate could not be checked: ${ssl.message} ${NOT_A_VERDICT}`,
    ]);
  }

  const cert = ssl.certificate;
  const paragraphs: string[] = [];
  paragraphs.push(
    ssl.trusted === true
      ? "The certificate is trusted by the system that checked it."
      : ssl.trusted === false
        ? "The certificate is not trusted by the system that checked it."
        : "Whether the certificate is trusted could not be determined.",
  );
  if (cert.coversHostname === true) {
    paragraphs.push("It covers the address the website was reached on.");
  } else if (cert.coversHostname === false) {
    paragraphs.push("It does not cover the address the website was reached on.");
  }
  if (cert.subjectAltNames.length > 0) {
    paragraphs.push(`It is issued for: ${listed(cert.subjectAltNames)}.`);
  }
  const expires = readableDate(cert.validTo);
  if (expires !== null && cert.daysUntilExpiry !== null) {
    paragraphs.push(
      cert.daysUntilExpiry >= 0
        ? `It is valid until ${expires} (${plural(cert.daysUntilExpiry, "day", "days")} from the date of the check).`
        : `It expired on ${expires}.`,
    );
  }
  if (cert.protocol !== null) paragraphs.push(`The secure connection used ${cert.protocol}.`);

  const problems = problemsIn(input.findings, (finding) => SSL_IDS.has(finding.id));
  if (problems.length > 0) paragraphs.push(`Issues found: ${listed(problems.map((finding) => finding.title))}.`);
  paragraphs.push(
    "A valid certificate confirms that the connection is encrypted and identifies the website. It does not by itself show that every other part of the site's security is in order.",
  );

  return area("certificate", heading, problems.length > 0 ? "attention" : "good", paragraphs);
}

// ---------------------------------------------------------------------------
// Domain and email records
// ---------------------------------------------------------------------------

const DMARC_POLICY_MEANING: Record<string, string> = {
  none: "which asks receiving email systems only to monitor and report",
  quarantine: "which asks receiving email systems to treat failing messages as suspicious",
  reject: "which asks receiving email systems to refuse failing messages",
};

function domainArea(input: OverallSummaryInput): SummaryArea {
  const dns = input.data.dns;
  const paragraphs: string[] = [];
  let failed = 0;

  switch (dns.a.status) {
    case "found":
      paragraphs.push(`The domain points to ${plural(dns.a.records.length, "web server address", "web server addresses")} (A records).`);
      break;
    case "absent":
      paragraphs.push("No web server addresses (A records) were found for the domain.");
      break;
    case "error":
      failed += 1;
      paragraphs.push("The lookup of the domain's web server addresses failed, so they could not be determined.");
      break;
  }

  if (dns.ns.status === "found") {
    paragraphs.push(`Its name servers, which manage the domain's records, were found (${listed(dns.ns.records)}).`);
  } else if (dns.ns.status === "error") {
    failed += 1;
    paragraphs.push("The lookup of the domain's name servers failed, so they could not be determined.");
  } else {
    paragraphs.push("No name servers were found for the domain.");
  }

  if (dns.mx.status === "found") {
    const nullMx = dns.mx.records.every((record) => record.exchange === "" || record.exchange === ".");
    paragraphs.push(
      nullMx
        ? "The domain states that it does not receive email (a \"null\" mail server record)."
        : `Mail servers are published for the domain (${plural(dns.mx.records.length, "MX record", "MX records")}).`,
    );
  } else if (dns.mx.status === "error") {
    failed += 1;
    paragraphs.push("The lookup of the domain's mail servers failed, so they could not be determined.");
  } else {
    paragraphs.push("No mail servers (MX records) were found for the domain.");
  }

  if (dns.spf.status === "found") {
    paragraphs.push("An SPF record was found. It lists which servers may send email for the domain.");
  } else if (dns.spf.status === "error") {
    failed += 1;
    paragraphs.push("The SPF lookup failed, so whether the domain publishes an SPF record could not be determined.");
  } else {
    paragraphs.push("No SPF record was found. SPF lists which servers may send email for the domain.");
  }

  if (dns.dmarc.status === "found") {
    const policy = dns.dmarc.effectivePolicy;
    const meaning = policy !== null && Object.hasOwn(DMARC_POLICY_MEANING, policy) ? `, ${DMARC_POLICY_MEANING[policy]}` : "";
    const where = dns.dmarc.inherited && dns.dmarc.policyDomain !== null ? `, inherited from ${dns.dmarc.policyDomain}` : "";
    paragraphs.push(
      `A DMARC policy was found${policy === null ? "" : ` with the setting "${policy}"`}${meaning}${where}.`,
    );
  } else if (dns.dmarc.status === "error") {
    failed += 1;
    paragraphs.push("The DMARC lookup failed, so whether the domain publishes a DMARC policy could not be determined.");
  } else {
    paragraphs.push(
      "No DMARC policy was found. DMARC tells receiving email systems what to do with messages that fail the domain's checks.",
    );
  }

  paragraphs.push("DKIM email signing: Not checked by this audit.");
  paragraphs.push(
    "A missing record does not by itself mean that the domain's email is failing to arrive. Any changes should be reviewed by whoever manages the domain.",
  );

  const problems = problemsIn(input.findings, (finding) => DNS_IDS.has(finding.id));
  const status: AreaStatus = problems.length > 0 ? "attention" : failed > 0 ? "incomplete" : "good";
  return area("domain", "Domain and email records", status, paragraphs);
}

// ---------------------------------------------------------------------------
// Site files and crawl
// ---------------------------------------------------------------------------

function siteArea(input: OverallSummaryInput): SummaryArea {
  const technical = input.data.technical;
  const coverage = crawlView(input.crawl);
  const paragraphs: string[] = [coverage.headline];
  if (coverage.reason !== null) paragraphs.push(coverage.reason);

  if (technical === null) {
    paragraphs.push("The robots.txt file and sitemap could not be checked for this report.");
  } else {
    if (technical.robotsTxtStatus === "found") {
      paragraphs.push(
        technical.robotsBlocksEverything
          ? "The robots.txt file tells all search engines not to visit any page of the site."
          : "A robots.txt file was found, and it does not block search engines from the whole site.",
      );
    } else if (technical.robotsTxtStatus === "absent") {
      paragraphs.push("No robots.txt file was found. Without one, search engines may visit every page.");
    } else {
      paragraphs.push("The robots.txt file could not be read, so its instructions could not be determined.");
    }

    if (technical.sitemapStatus === "found") {
      paragraphs.push("A sitemap, which lists the site's pages for search engines, was found.");
    } else if (technical.sitemapStatus === "absent") {
      paragraphs.push("No sitemap was found. A sitemap lists the site's pages for search engines.");
    } else {
      paragraphs.push("The sitemap could not be read, so whether one exists could not be determined.");
    }
  }

  const problems = problemsIn(input.findings, (finding) => finding.category === "technical");
  return area("site", "Pages read and instructions for search engines", technicalStatus(input, problems.length), paragraphs);
}

/**
 * The Technical status, by the precedence of CP1 v6 §4; the first rule that
 * matches decides.
 *
 *   P1  a technical finding                                   Needs attention
 *   P2  robots.txt or the sitemap confirmed absent            Room for improvement
 *   P3  either unreadable, or the technical checks not run    Partly checked
 *   P4  both found, but the crawl stopped short               Partly checked
 *   P5  both found, and the crawl complete                    In good shape
 *
 * A file confirmed missing outranks one that could not be read, because the
 * first is a known fact and the second is not (D2, U4). Whether the crawl was
 * complete is a flag, not a count, so this never depends on counts that might
 * not reconcile.
 */
function technicalStatus(input: OverallSummaryInput, problemCount: number): AreaStatus {
  const technical = input.data.technical;
  if (problemCount > 0) return "attention";
  if (technical !== null && (technical.robotsTxtStatus === "absent" || technical.sitemapStatus === "absent")) {
    return "improve";
  }
  if (technical === null || technical.robotsTxtStatus === "unavailable" || technical.sitemapStatus === "unavailable") {
    return "incomplete";
  }
  return input.crawl.complete ? "good" : "incomplete";
}

/** How serious each status is, for combining areas: the higher number wins. */
const STATUS_RANK: Record<AreaStatus, number> = {
  attention: 4,
  improve: 3,
  incomplete: 2,
  good: 1,
  "not-measured": 0,
};

/**
 * The most serious of the given statuses (CP3-Q2a, C2).
 *
 * "Room for improvement" outranks "Partly checked": a shortfall that was found
 * is a known fact, an unfinished lookup is not. "Not measured" ranks lowest, so
 * it decides nothing unless every status is "Not measured".
 */
function mostSerious(statuses: readonly AreaStatus[]): AreaStatus {
  return statuses.reduce<AreaStatus>(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    "not-measured",
  );
}

// ---------------------------------------------------------------------------
// Overview, priorities, limitations, help
// ---------------------------------------------------------------------------

function overview(input: OverallSummaryInput): string[] {
  const coverage = crawlView(input.crawl);
  const out = [
    `This report covers ${input.auditedUrl}${input.checkedAt === null ? "" : `, checked on ${input.checkedAt}`}. ${coverage.headline}`,
    "The audit examined website speed, search visibility and content, security and HTTPS, the SSL/TLS certificate, domain and email records, and the instructions the site gives to search engines.",
  ];

  const problems = input.findings.filter(isProblem);
  const counts = (["critical", "high", "medium"] as const)
    .map((severity) => ({ severity, count: problems.filter((finding) => finding.severity === severity).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${SEVERITY_WORD[entry.severity].toLowerCase()}`);

  const graded =
    input.grade === null
      ? "There were not enough completed checks to give an overall grade."
      : `Overall, the website received a grade of ${input.grade}${input.gradeLabel === null ? "" : ` (${input.gradeLabel})`} on the checks that could be assessed.`;
  out.push(
    problems.length === 0
      ? `${graded} No problems were found in the checks that could be assessed.`
      : `${graded} The audit found ${plural(problems.length, "issue", "issues")} that need attention: ${listed(counts)}.`,
  );
  return out;
}

/**
 * The most important problems, worst first.
 *
 * Each one's reach comes only from counts that reconciled. Without one, the
 * finding's own scope is named instead -- "Page-level" or "Site-wide" -- so a
 * page finding is never described as site-wide for want of a figure.
 */
function priorities(findings: readonly Finding[], coverage: CoverageCheck | null): SummaryPriority[] {
  return findings
    .filter(isProblem)
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
    .slice(0, MAX_PRIORITIES)
    .map((finding) => {
      const explainer = explainerFor(finding.id);
      return {
        title: finding.title,
        severityLabel: SEVERITY_WORD[finding.severity as Exclude<Severity, "good">],
        reach: affectedViewFor(finding, coverage).reach ?? scopeLabel(findingScope(finding)),
        whyItMatters: explainer?.whyItMatters ?? finding.remediation,
        whoFixes: explainer === null ? null : whoFixesLabel(explainer),
      };
    });
}

function limitations(input: OverallSummaryInput): string[] {
  const coverage = crawlView(input.crawl);
  const out: string[] = [];
  if (coverage.partial) {
    out.push(`Not every page of the site was read. ${coverage.reason ?? ""}`.trim());
  }
  for (const skipped of input.skippedChecks) {
    const title = RULE_TITLES.get(skipped.ruleId) ?? "A check";
    out.push(`Could not be checked — ${title}: ${skipped.reason}`);
  }
  out.push(
    "Pages were read as the server delivered them. Content that appears only after scripts run in a browser was not examined.",
  );
  out.push("The results describe the website at the time of the check. Later changes are not reflected.");
  return out;
}

/** Which help is offered depends on which areas actually need it. Draft for company approval. */
export function skybookHelp(findings: readonly Finding[]): SkybookHelp {
  const problems = findings.filter(isProblem);
  const has = (test: (finding: Finding) => boolean) => problems.some(test);
  const items: string[] = [];

  if (has((finding) => finding.category === "security" && !DNS_IDS.has(finding.id))) {
    items.push(
      "Reviewing the security findings with you and your hosting provider, and agreeing which changes to make first.",
    );
  }
  if (has((finding) => DNS_IDS.has(finding.id))) {
    items.push(
      "Reviewing the domain's email records (SPF and DMARC) with whoever manages your domain, so changes are made without disrupting existing email.",
    );
  }
  if (has((finding) => finding.category === "seo")) {
    items.push("Planning and prioritising the search-visibility and content improvements identified in this report.");
  }
  if (has((finding) => finding.category === "speed")) {
    items.push("Looking into the speed results in more detail to identify what is slowing the pages down.");
  }
  if (has((finding) => finding.category === "technical")) {
    items.push("Checking the instructions the site gives to search engines, such as its robots.txt file.");
  }
  items.push(
    "Running a follow-up audit after changes are made, so improvements can be confirmed with the same measurements.",
  );

  return {
    intro:
      problems.length === 0
        ? "Skybook can help you keep the website in good shape as it changes."
        : "Skybook can help you act on the findings in this report.",
    items,
    closing:
      "Your Skybook contact can talk you through any part of this report and help decide which improvements to make first.",
  };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export function buildOverallSummary(input: OverallSummaryInput): OverallSummary {
  const skippedIds = new Set(input.skippedChecks.map((skipped) => skipped.ruleId));
  const strengths = passedRuleIds(input).map((id) => strengthText(id, skippedIds));
  const security = securityArea(input);
  const certificate = certificateArea(input);
  const domain = domainArea(input);

  return {
    overview: overview(input),
    areas: [speedArea(input), seoArea(input), security, certificate, domain, siteArea(input)],
    securityStatus: mostSerious([security.status, certificate.status, domain.status]),
    strengths,
    priorities: priorities(input.findings, input.coverage),
    limitations: limitations(input),
    notChecked: NOT_CHECKED_BY_THIS_AUDIT,
    help: skybookHelp(input.findings),
  };
}
