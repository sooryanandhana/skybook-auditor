/**
 * Turning site-level measurements into rows a person can read.
 *
 * WHY THIS FILE EXISTS AT ALL. The certificate, the DNS records, SPF and DMARC
 * were all measured, travelled to the browser, and were then displayed
 * nowhere. The only way any of it reached a reader was by being wrong enough
 * to produce a finding — so a healthy certificate and an unread one looked
 * identical from the outside, which is to say: like nothing.
 *
 * That is the shape this file is built to break:
 *
 *     if a finding exists -> show the measurement
 *     otherwise           -> show nothing
 *
 * A salesperson should be able to say "your certificate expires on 27 October"
 * and "your email is protected, with a reject policy". Both were known. Neither
 * was on the page.
 *
 * WHY THE DECISIONS LIVE HERE RATHER THAN IN THE COMPONENT. Every sentence
 * below is a statement about somebody's website, so each one is worth a test,
 * and this project has no React testing stack. Same reasoning as
 * `siteFindingsView` and `findingsState`, and the same vocabulary too: a thing
 * that is genuinely not there reads "Not found", and a thing we failed to
 * measure reads "Could not be checked". Those are different sentences because
 * they are different facts.
 *
 * NOTHING HERE GRADES ANYTHING. There is no severity, no pass or fail, no
 * threshold. It reads measured values and writes them out. A certificate that
 * expires tomorrow produces the same kind of row as one that expires next year;
 * whether that is a problem is the rules' business, and they already decided it
 * somewhere else.
 */
import { ALL_RULES } from "../rules/all.ts";
import type { CrawlStopReason } from "../collector/crawlFrontier.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import type { RobotsStatus } from "../collector/robots.ts";
import type { SitemapStopReason } from "../collector/sitemap.ts";
import type {
  Category,
  DnsData,
  DnsRecordSet,
  FieldPerformance,
  Finding,
  HostnameMatch,
  MxRecord,
  PerformanceRating,
  SeoData,
  Severity,
  SkippedCheck,
  SslData,
  TechnicalData,
} from "../types";

/** One label-and-value row, as the results page already renders facts. */
export interface FactRow {
  label: string;
  value: string;
  /** A second line under the value: units, context, or a caveat. */
  note?: string;
}

/** A measurement that was looked for and genuinely is not there. */
export const NOT_FOUND = "Not found";

/**
 * A measurement we failed to take.
 *
 * Deliberately the same words `siteFileText` uses, because it is the same
 * fact: we do not know. It must never read as a fault in the website.
 */
export const NOT_CHECKED = "Could not be checked";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * An ISO timestamp as a date a person reads: "27 October 2026".
 *
 * Written out rather than handed to `toLocaleDateString`, which would answer
 * differently depending on where the browser thinks it is — and a certificate
 * expiry that reads "10/27/2026" to one colleague and "27/10/2026" to another
 * is a date that can be misread by a month.
 *
 * Returns null for anything unparseable, so a caller shows nothing rather than
 * "Invalid Date".
 */
export function readableDate(iso: string | null): string | null {
  if (!iso) return null;

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** "in 84 days", "today", "42 days ago" — the sign carries the meaning. */
export function expiryNote(days: number | null): string | undefined {
  if (days === null) return undefined;
  if (days === 0) return "Expires today";
  if (days < 0) {
    const ago = Math.abs(days);
    return `Expired ${ago} ${ago === 1 ? "day" : "days"} ago`;
  }
  return `${days} ${days === 1 ? "day" : "days"} from now`;
}

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

/**
 * What the certificate check established, whatever it established.
 *
 * Four situations, and only one of them is a certificate:
 *
 *   not-applicable  the site is not on HTTPS, so there is nothing to read.
 *                   NOT a failure of the check, and not stated as one.
 *   blocked /
 *   unreachable     we could not read it. The collector's own message says
 *                   why, and is repeated rather than paraphrased.
 *   checked, no
 *   certificate     the connection worked and nothing readable came back.
 *   checked         the rows below.
 */
export function certificateFacts(ssl: SslData): FactRow[] {
  if (ssl.status === "not-applicable") {
    return [
      {
        label: "Certificate",
        value: "None — this site is not served over HTTPS",
        note: ssl.message,
      },
    ];
  }

  if (ssl.status !== "checked") {
    return [{ label: "Certificate", value: NOT_CHECKED, note: ssl.message }];
  }

  const certificate = ssl.certificate;
  if (certificate === null) {
    return [
      {
        label: "Certificate",
        value: NOT_CHECKED,
        note: "The connection succeeded but no readable certificate came back.",
      },
    ];
  }

  const rows: FactRow[] = [{ label: "Certificate", value: "Read from the site's TLS connection" }];

  if (certificate.issuer) rows.push({ label: "Issued by", value: certificate.issuer });
  if (certificate.subject) rows.push({ label: "Issued to", value: certificate.subject });

  const from = readableDate(certificate.validFrom);
  if (from) rows.push({ label: "Valid from", value: from });

  const until = readableDate(certificate.validTo);
  if (until) {
    rows.push({ label: "Expires", value: until, note: expiryNote(certificate.daysUntilExpiry) });
  }

  rows.push({
    label: "Covers this address",
    value: hostnameCoverage(certificate.coversHostname, certificate.hostnameMatch),
    note: certificate.subjectAltNames.length > 0 ? namesNote(certificate.subjectAltNames) : undefined,
  });

  rows.push({ label: "Trusted", value: trustText(ssl.trusted), note: ssl.problem ? problemNote(ssl.problem) : undefined });

  if (certificate.protocol) rows.push({ label: "Protocol", value: certificate.protocol });

  return rows;
}

/**
 * Whether the certificate names the address we visited.
 *
 * `coversHostname` is three-valued and null means the certificate carried no
 * names we could compare. Saying "No" there would be a claim about a check
 * that did not happen.
 */
function hostnameCoverage(covers: boolean | null, match: HostnameMatch | null): string {
  if (covers === null) return NOT_CHECKED;
  if (!covers) return "No — the certificate does not list this address";
  return match === "wildcard" ? "Yes, by a wildcard" : "Yes";
}

/** The names on the certificate, capped so one row cannot become a wall. */
function namesNote(names: string[]): string {
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? `Also covers ${shown} and ${names.length - 6} more` : `Also covers ${shown}`;
}

/**
 * Trust, with null kept apart from false.
 *
 * Null means the platform gave us no verdict. "Not trusted" is a serious thing
 * to tell somebody about their own website and it is not what null means.
 */
function trustText(trusted: boolean | null): string {
  if (trusted === null) return NOT_CHECKED;
  return trusted ? "Yes, by the system's certificate store" : "No — it did not pass validation";
}

function problemNote(problem: NonNullable<SslData["problem"]>): string {
  switch (problem) {
    case "expired":
      return "The certificate has expired";
    case "self-signed":
      return "The certificate is self-signed, so browsers will not trust it";
    case "wrong-hostname":
      return "The certificate was issued for a different address";
    case "untrusted":
      return "The certificate could not be verified";
  }
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

/** How many records of one kind are listed before the rest are summarised. */
const MAX_RECORDS_SHOWN = 8;

/**
 * One set of DNS records, in its three states.
 *
 *   found  the records, as published
 *   absent the domain genuinely publishes none. A real answer, not a gap.
 *   error  we did not find out.
 */
export function recordSetText(set: DnsRecordSet<string>): string {
  if (set.status === "error") return NOT_CHECKED;
  if (set.status === "absent" || set.records.length === 0) return "None published";

  const shown = set.records.slice(0, MAX_RECORDS_SHOWN).join(", ");
  return set.records.length > MAX_RECORDS_SHOWN
    ? `${shown} and ${set.records.length - MAX_RECORDS_SHOWN} more`
    : shown;
}

/** Mail servers read the same way, with their priorities kept. */
export function mxText(set: DnsRecordSet<MxRecord>): string {
  if (set.status === "error") return NOT_CHECKED;
  if (set.status === "absent" || set.records.length === 0) return "None published";

  const ordered = [...set.records].sort((a, b) => a.priority - b.priority);
  const shown = ordered.slice(0, MAX_RECORDS_SHOWN).map(mailServerText);
  return ordered.length > MAX_RECORDS_SHOWN
    ? `${shown.join(", ")} and ${ordered.length - MAX_RECORDS_SHOWN} more`
    : shown.join(", ");
}

/**
 * One mail server, including the one that names no server.
 *
 * A record with an EMPTY exchange is not a broken record — it is a deliberate
 * one. Publishing a single MX with no name and priority 0 is how a domain
 * states that it accepts no email at all, and plenty of domains that only
 * serve a website do exactly that. `example.com` is one of them.
 *
 * Rendered naively it came out as "(priority 0)", a blank followed by a
 * number, which reads as a bug in the report rather than a fact about the
 * domain. What it says is repeated here without being judged: whether a domain
 * should accept mail is not this audit's business.
 */
function mailServerText(mx: MxRecord): string {
  const name = mx.exchange.trim();
  const named = name === "" || name === ".";
  return named
    ? `no mail server named (priority ${mx.priority})`
    : `${name} (priority ${mx.priority})`;
}

/**
 * The domain's records, and which names they were read from.
 *
 * The two names are shown because they are frequently different and the
 * difference explains everything below them: addresses belong to the host
 * serving the site, while mail and zone records belong to the domain, which is
 * the same name with any leading "www." removed.
 */
export function dnsFacts(dns: DnsData): FactRow[] {
  const rows: FactRow[] = [
    { label: "Website address records", value: recordSetText(dns.a), note: `Looked up on ${dns.hostname}` },
  ];

  if (dns.aaaa.status !== "absent" || dns.aaaa.records.length > 0) {
    rows.push({ label: "IPv6 records", value: recordSetText(dns.aaaa) });
  }

  rows.push(
    { label: "Mail servers", value: mxText(dns.mx), note: `Looked up on ${dns.emailDomain}` },
    { label: "Name servers", value: recordSetText(dns.ns) },
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Email authentication
// ---------------------------------------------------------------------------

/**
 * SPF, exactly as measured.
 *
 * The record is shown whole. What it means is not interpreted here, and
 * nothing here says or implies that having one makes email secure — SPF is one
 * mechanism among several, and the findings wording was corrected once already
 * for claiming more than that.
 */
export function spfFacts(dns: DnsData): FactRow[] {
  const spf = dns.spf;

  if (spf.status === "error") {
    return [{ label: "SPF", value: NOT_CHECKED, note: spf.error ?? undefined }];
  }
  if (spf.status === "absent" || spf.record === null) {
    return [{ label: "SPF", value: NOT_FOUND, note: `Looked for on ${dns.emailDomain}` }];
  }

  return [{ label: "SPF", value: "Published", note: spf.record }];
}

/**
 * DMARC, including where the policy came from.
 *
 * DMARC inherits, so four names can be in play and the reader should not have
 * to know that to read the rows. `appliesTo` is the domain being described,
 * `policyDomain` is where the record was read from, and they differ exactly
 * when the policy was inherited from a parent.
 *
 * `effectivePolicy` is shown as the value because it is the one that governs
 * this domain — `sp=` for an inherited record, `p=` for its own. Where the
 * record states no policy we recognise, that is said rather than guessed at.
 */
export function dmarcFacts(dns: DnsData): FactRow[] {
  const dmarc = dns.dmarc;

  if (dmarc.status === "error") {
    return [{ label: "DMARC", value: NOT_CHECKED, note: dmarc.error ?? undefined }];
  }
  if (dmarc.status === "absent" || dmarc.record === null) {
    return [{ label: "DMARC", value: NOT_FOUND, note: `Looked for on ${dmarc.appliesTo}` }];
  }

  const policy = dmarc.effectivePolicy;
  const rows: FactRow[] = [
    {
      label: "DMARC",
      value: policy === null ? "Published" : `Published, policy ${policy}`,
      note:
        policy === null
          ? "The record states no policy this audit recognises."
          : undefined,
    },
    { label: "Applies to", value: dmarc.appliesTo },
  ];

  if (dmarc.inherited && dmarc.policyDomain) {
    rows.push({
      label: "Inherited from",
      value: dmarc.policyDomain,
      note: `${dmarc.appliesTo} publishes no record of its own, so its parent's applies.`,
    });
  } else {
    rows.push({ label: "Published by", value: dmarc.policyDomain ?? dmarc.appliesTo });
  }

  rows.push({ label: "Record", value: dmarc.record });

  return rows;
}

// ---------------------------------------------------------------------------
// Checks that could not run
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Findings, gathered by subject
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, good: 3 };

const CATEGORY_LABELS: Record<Category, string> = {
  security: "Security",
  seo: "Search visibility",
  speed: "Speed",
  technical: "Technical",
};

export function categoryLabel(category: Category): string {
  return CATEGORY_LABELS[category];
}

export interface CategoryGroup {
  category: Category;
  label: string;
  findings: Finding[];
}

/**
 * Findings gathered by the category each rule already declares.
 *
 * WHAT THIS DOES NOT DO: change any severity, invent a category, or drop a
 * finding. The category is the rule's own constant, carried through
 * aggregation untouched, and this only decides what sits next to what.
 *
 * THE ORDER IS STILL WORST FIRST, and that took a decision. Grouping by
 * category could easily bury a critical security problem under a list of
 * medium SEO ones, so the GROUPS are ordered by the worst finding inside them.
 * A category containing a critical comes first, and within a category the
 * existing severity order is untouched. Nothing that was near the top before
 * moves far from it.
 */
export function groupByCategory(findings: readonly Finding[]): CategoryGroup[] {
  const groups = new Map<Category, Finding[]>();

  for (const finding of findings) {
    const existing = groups.get(finding.category);
    if (existing === undefined) groups.set(finding.category, [finding]);
    else existing.push(finding);
  }

  const worstIn = (list: Finding[]) =>
    list.reduce((worst, f) => Math.min(worst, SEVERITY_ORDER[f.severity]), SEVERITY_ORDER.good);

  return [...groups.entries()]
    .map(([category, list]) => ({
      category,
      label: CATEGORY_LABELS[category],
      findings: [...list].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
      ),
    }))
    .sort(
      (a, b) =>
        worstIn(a.findings) - worstIn(b.findings) || a.label.localeCompare(b.label),
    );
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/**
 * How the simulated load was run, when the collector says.
 *
 * The simulation is a throttled mobile device, and a score presented without
 * that is a score a client will reasonably assume describes their desktop
 * site. Read from the data rather than assumed, so if it ever runs another
 * way the label follows.
 */
export function strategyLabel(strategy: string | null | undefined): string | null {
  if (!strategy) return null;

  const known: Record<string, string> = {
    mobile: "Mobile simulation",
    desktop: "Desktop simulation",
  };
  return known[strategy.toLowerCase()] ?? `${strategy} simulation`;
}

// ---------------------------------------------------------------------------
// How much of the site was seen, and why it stopped
// ---------------------------------------------------------------------------

/** A whole number with thousands separated, the same way everywhere. */
export function withThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const CRAWL_STOP_REASONS: Record<CrawlStopReason, string> = {
  completed: "the queue was emptied",
  "max-pages": "the page limit was reached",
  "max-duration": "the crawl's time limit was reached",
  "max-queue": "the queue limit was reached",
  deadline: "the audit's overall time ran out",
};

/**
 * The crawl's outcome in one line: whether it finished, and what ended it.
 *
 * BOTH HALVES COME FROM THE RESULT. `complete` is the server's own verdict —
 * it accounts for the page queue AND sitemap discovery, so it is not the same
 * question as "did the queue empty". A crawl can drain every page it knew
 * about and still be incomplete because a sitemap went unread, and this line
 * has to be able to say exactly that.
 *
 * It never reads "Complete" merely because the audit returned successfully.
 */
export function crawlStatusText(crawl: SiteCrawlSummary): string {
  const ending = CRAWL_STOP_REASONS[crawl.stoppedBecause];
  return crawl.complete ? `Complete — ${ending}` : `Partial — ${ending}`;
}

/**
 * Where the addresses came from.
 *
 * Counted by the frontier as it discovered them, never recomputed here. The
 * split is worth showing because it says how a site is put together: a site
 * whose pages are reachable only through its sitemap is one whose navigation
 * does not lead anywhere useful.
 */
export function discoverySourceFacts(crawl: SiteCrawlSummary): FactRow[] {
  return [
    { label: "Found by following links", value: withThousands(crawl.sources.html) },
    { label: "Found in the sitemap", value: withThousands(crawl.sources.sitemap) },
  ];
}

/** Minutes where they divide evenly, seconds otherwise. */
function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${withThousands(seconds)} seconds`;
}

/**
 * The limits this crawl was given.
 *
 * Shown because they explain a partial result. "128 of 417 pages" invites the
 * question of why the other 289 were left, and the answer is a number somebody
 * chose, not a fault in the website.
 */
export function crawlLimitFacts(limits: SiteCrawlSummary["limits"]): FactRow[] {
  return [
    { label: "Most pages read", value: withThousands(limits.maxPages) },
    { label: "Longest crawl", value: durationText(limits.maxDurationMs) },
    { label: "Largest queue", value: `${withThousands(limits.maxQueueSize)} addresses` },
    {
      label: "Largest page read",
      value: `${withThousands(Math.round(limits.maxResponseBytes / 1_000_000))} MB`,
    },
    { label: "Pages at once", value: String(limits.concurrency) },
    { label: "Pause between requests", value: `${withThousands(limits.perRequestDelayMs)} ms` },
  ];
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

const SITEMAP_STOP_REASONS: Record<SitemapStopReason, string> = {
  completed: "Every sitemap the site names was read.",
  unavailable: "A sitemap could not be read, so it may list pages that were never seen.",
  "max-files": "The limit on sitemap files was reached before they had all been read.",
  "max-urls": "The limit on sitemap addresses was reached.",
  budget: "Sitemap reading used the time it was given.",
  deadline: "The audit's overall time ran out while sitemaps were being read.",
};

/**
 * What happened when the crawl went looking for the site's sitemaps.
 *
 * A DIFFERENT MEASUREMENT from the "Sitemap" row in the page facts, and both
 * are worth having. That row is a single request to the conventional address,
 * answering "does this site publish one". This is the walk: robots directives,
 * sitemap indexes, the files they point at, and whether all of them were read.
 *
 * The four states stay apart, which is the whole point:
 *
 *   not attempted  sitemaps were turned off for this crawl. Not a failure.
 *   complete       nothing was left unread.
 *   unavailable    a file could not be read. NOT the same as there being none.
 *   any other stop a limit was reached, and it says which.
 *
 * Nothing here is a finding. A site with no sitemap has nothing to fix by
 * virtue of that alone, and one we failed to read is our gap rather than
 * theirs.
 *
 * WHAT IS NOT SHOWN, and why: how many sitemap FILES were read. The crawl
 * result does not carry that number, and inventing one from the addresses
 * would be arithmetic dressed as a measurement.
 */
export function sitemapDiscoveryFacts(crawl: SiteCrawlSummary): FactRow[] {
  const discovery = crawl.sitemapDiscovery;

  if (!discovery.attempted) {
    return [
      {
        label: "Sitemap discovery",
        value: "Not attempted",
        note: "This crawl was asked to follow links only.",
      },
    ];
  }

  const status = discovery.complete
    ? "Complete"
    : discovery.stoppedBecause === "unavailable"
      ? NOT_CHECKED
      : "Incomplete";

  return [
    {
      label: "Sitemap discovery",
      value: status,
      note: SITEMAP_STOP_REASONS[discovery.stoppedBecause],
    },
    {
      label: "Addresses taken from sitemaps",
      value: withThousands(crawl.sources.sitemap),
      note:
        crawl.sources.sitemap === 0 && discovery.complete
          ? "The sitemaps listed no addresses, or this site publishes none."
          : undefined,
    },
  ];
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

const ROBOTS_STATUS_TEXT: Record<RobotsStatus, string> = {
  rules: "Published, with rules",
  empty: "Published, and empty",
  absent: NOT_FOUND,
  unavailable: NOT_CHECKED,
};

/**
 * What the site's robots.txt said, as a measurement rather than a verdict.
 *
 * THE DANGEROUS ROW IS THE SECOND ONE. `robotsBlocksEverything` is a plain
 * boolean, and it is false in two completely different situations: the file
 * exists and blocks nobody, and the file could not be read at all. Printing
 * the boolean would tell a client their site is open to search engines on the
 * strength of a request that timed out.
 *
 * So it is gated on the measured status. Unknown says unknown.
 *
 * This does not duplicate `technical.robots.blocks-all`. That rule decides
 * whether the measurement is a critical problem and says so with a severity;
 * this is the measured fact underneath it, in plain words and with no badge.
 */
export function robotsFacts(
  crawl: SiteCrawlSummary,
  technical: TechnicalData | null,
): FactRow[] {
  const rows: FactRow[] = [
    { label: "robots.txt", value: ROBOTS_STATUS_TEXT[crawl.robots.status] },
  ];

  const known =
    technical !== null &&
    technical.robotsTxtStatus !== "unavailable" &&
    crawl.robots.status !== "unavailable";

  rows.push({
    label: "Blocks all search engines",
    value: known ? (technical.robotsBlocksEverything ? "Yes" : "No") : NOT_CHECKED,
    note: known ? undefined : "The file could not be read, so this is unknown either way.",
  });

  if (!crawl.robots.enforced) {
    rows.push({
      label: "Rules applied to this crawl",
      value: "No",
      note: "The file could not be read, so the crawl went ahead without applying its rules.",
    });
  }

  if (crawl.robots.excluded > 0) {
    rows.push({
      label: "Pages the site asked us to skip",
      value: withThousands(crawl.robots.excluded),
      note: "Excluded because robots.txt said so, which is a site behaving normally.",
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Page content
// ---------------------------------------------------------------------------

/**
 * How much readable text the page carried, and its main headings.
 *
 * PAGE-LEVEL, and about the audited page only, so these belong among the other
 * page facts rather than the site-wide ones.
 *
 * The character count is reported and not judged. There is a threshold in the
 * rules that decides when a page is too thin to grade headings by, and it
 * stays there — a number shown next to the words "Poor" or "Good" would be
 * this layer grading, which it does not do.
 */
export function contentFacts(seo: SeoData): FactRow[] {
  return [
    {
      label: "Readable text",
      value: `${withThousands(seo.bodyTextLength)} characters`,
      note: "Counted from the HTML as sent. Scripts are not run, so anything the page adds in the browser is not included.",
    },
  ];
}

/**
 * The count, and where the texts do not account for it.
 *
 * `h1Texts` can be SHORTER than `h1Count`, because an empty `<h1></h1>` is an
 * element carrying no text. Saying "1 found" and printing one heading when the
 * page has two would hide the empty one, which is exactly the thing a heading
 * rule cares about.
 */
export function headingCountText(count: number, texts: readonly string[]): string {
  if (count === 0) return NOT_FOUND;

  const found = `${withThousands(count)} found`;
  const empty = count - texts.length;
  if (empty <= 0) return found;

  return `${found}, ${withThousands(empty)} with no text`;
}

// ---------------------------------------------------------------------------
// What real visitors experienced
// ---------------------------------------------------------------------------

const RATING_TEXT: Record<PerformanceRating, string> = {
  FAST: "Fast",
  AVERAGE: "Average",
  SLOW: "Slow",
};

/**
 * Google's own overall verdict on real visits, when it gave one.
 *
 * READ, NEVER DERIVED. This is Google's word, taken from the field block. It
 * is deliberately not calculated from the individual metrics and never from
 * the simulated score — those answer different questions, and a site can be
 * rated fast by real visitors while a throttled simulation scores it badly.
 *
 * Null when there is no verdict to report, which covers both a field block
 * Google could not give us and one that carries metrics but no overall
 * category. The caller says what it wants to say about nothing.
 */
export function fieldOverallText(field: FieldPerformance): string | null {
  if (field.status !== "found" || field.overall === null) return null;
  return RATING_TEXT[field.overall];
}

// ---------------------------------------------------------------------------
// How many problems, at a glance
// ---------------------------------------------------------------------------

/** One severity and how many findings carry it. Worst first. */
export interface SeverityCount {
  severity: Exclude<Severity, "good">;
  label: string;
  count: number;
}

const PROBLEM_SEVERITIES: Array<Exclude<Severity, "good">> = ["critical", "high", "medium"];

const SEVERITY_LABELS: Record<Exclude<Severity, "good">, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
};

/**
 * The severity split, for the line under the findings heading.
 *
 * "Findings (11)" was the only number on the page, and it is the wrong one: a
 * report with one critical and ten mediums is a different conversation from
 * one with eleven mediums, and a salesperson opening this wants to know which
 * they are walking into.
 *
 * COUNTS, NOT GRADES. Every severity read here was decided by a rule on the
 * server and carried through aggregation untouched. Nothing in this function
 * can change one, and there is no threshold anywhere in it.
 *
 * "good" is excluded, because a passing check is not a finding to report. So
 * are skipped checks, which are neither a problem nor a pass and are counted
 * in their own panel.
 *
 * Severities with no findings are left out rather than shown as zero — "0
 * Critical" is a number nobody needs and it dilutes the ones that matter.
 */
export function severityCounts(findings: readonly Finding[]): SeverityCount[] {
  return PROBLEM_SEVERITIES.map((severity) => ({
    severity,
    label: SEVERITY_LABELS[severity],
    count: findings.filter((finding) => finding.severity === severity).length,
  })).filter((entry) => entry.count > 0);
}

// ---------------------------------------------------------------------------
// Checks that could not run, in words a client can read
// ---------------------------------------------------------------------------

/**
 * Every rule's own title, by id.
 *
 * The skipped panel used to print raw identifiers — `security.cookies.httponly`
 * — into a document meant for a prospect. The rules already carry a written
 * title, so this reads theirs rather than keeping a second list that could
 * drift away from them.
 *
 * A rule this audit does not know about falls back to its id, which is ugly but
 * true. Inventing a friendly name for an unknown identifier would be worse.
 */
const RULE_TITLES = new Map(ALL_RULES.map((rule) => [rule.id, rule.title]));

export function ruleTitle(ruleId: string): string {
  return RULE_TITLES.get(ruleId) ?? ruleId;
}

/** One reason, and every check it stopped. */
export interface SkippedReasonGroup {
  reason: string;
  /** The checks this reason applied to, by their written titles. */
  checks: string[];
}

/**
 * Skipped checks gathered by REASON rather than by rule.
 *
 * WHY THIS WAY ROUND. Grouping by rule solved one problem and left its mirror
 * image. A site on plain HTTP skips three separate certificate checks, and all
 * three give the same explanation — so the panel printed "The site is not
 * served over HTTPS, so it presents no certificate" three times in a row.
 *
 * Grouping by reason handles both shapes at once:
 *
 *   three checks, one reason  -> one line, naming all three
 *   one check, two reasons    -> two lines, each naming that check
 *
 * NOTHING IS LOST AND NOTHING IS MERGED. Two different reasons stay two
 * groups, however similar they read. The only thing collapsed is a sentence
 * that was already identical, and the checks it applied to are all still
 * named.
 *
 * Order follows first appearance, so the output is stable for the same audit.
 */
export function groupSkippedByReason(skipped: readonly SkippedCheck[]): SkippedReasonGroup[] {
  const groups = new Map<string, string[]>();

  for (const check of skipped) {
    const title = ruleTitle(check.ruleId);
    const checks = groups.get(check.reason);

    if (checks === undefined) {
      groups.set(check.reason, [title]);
      continue;
    }
    // The same check twice for the same reason is one mention, not two.
    if (!checks.includes(title)) checks.push(title);
  }

  return [...groups.entries()].map(([reason, checks]) => ({ reason, checks }));
}

/** How many distinct checks did not run, however their reasons group. */
export function skippedCheckCount(skipped: readonly SkippedCheck[]): number {
  return new Set(skipped.map((check) => check.ruleId)).size;
}

// ---------------------------------------------------------------------------
// Crawl coverage, compactly
// ---------------------------------------------------------------------------

/** A number worth a tile: short label, short value. */
export interface CountTile {
  label: string;
  value: string;
}

/**
 * The crawl's numbers, in the compact form the coverage tiles already use.
 *
 * These were rendered as a column of label-above-value rows, each with an
 * explanatory paragraph under it, for values like "0" and "416". That is a lot
 * of vertical space to say very little, and it pushed the findings down the
 * page far enough to undo a deliberate earlier decision about reading order.
 *
 * Same facts, read from the same fields, in a grid.
 *
 * Zeroes are kept here, unlike in the coverage row above, because these
 * describe how the crawl found things rather than what it found wrong: "0
 * addresses from the sitemap" is a fact worth seeing next to "416 from links".
 */
export function crawlCountTiles(crawl: SiteCrawlSummary): CountTile[] {
  return [
    { label: "Discovered", value: withThousands(crawl.discovered) },
    { label: "Evaluated", value: withThousands(crawl.evaluated) },
    { label: "From links", value: withThousands(crawl.sources.html) },
    { label: "From sitemap", value: withThousands(crawl.sources.sitemap) },
    { label: "Not read", value: withThousands(crawl.unavailable.length) },
    { label: "Not web pages", value: withThousands(crawl.skippedNonHtml) },
    { label: "Excluded by robots", value: withThousands(crawl.robots.excluded) },
    { label: "Queued at stop", value: withThousands(crawl.queuedAtStop) },
  ];
}

/**
 * The crawl facts that are sentences rather than numbers.
 *
 * Kept apart from the tiles because they do not fit one: each carries a state
 * and often a caveat, and squeezing "Could not be checked" into a tile beside
 * "416" would make a measurement look like a count.
 */
export function crawlStateFacts(
  crawl: SiteCrawlSummary,
  technical: TechnicalData | null,
): FactRow[] {
  return [
    { label: "Crawl status", value: crawlStatusText(crawl) },
    ...sitemapDiscoveryFacts(crawl).filter((row) => row.label === "Sitemap discovery"),
    ...robotsFacts(crawl, technical),
  ];
}
