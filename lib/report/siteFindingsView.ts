/**
 * What the findings section should SAY about a whole-site audit.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT, for the same reason `findingsState`
 * is not: every sentence below is a claim about somebody's website, and the
 * ways to get one subtly wrong are exactly the ways nobody notices. "50 pages
 * affected" when 147 were, "1 of 128 pages" about a DNS record that was
 * measured once, "the whole site was audited" after stopping at a limit —
 * each reads perfectly well and each is false. They are worth tests, and
 * testing them inside JSX would need a React stack this project does not have.
 *
 * NOTHING HERE DECIDES ANYTHING. It reads values the server already produced
 * and turns them into English. It computes no severity, no counts, no
 * denominators, and no judgement about whether a crawl was complete — every
 * one of those arrives already decided, and this file would be the wrong place
 * to second-guess any of them.
 */
import type { SiteCrawlSummary } from "../collector/crawlSite";
import { withoutCredentials } from "../collector/url.ts";
import { TOO_LARGE_TO_ANALYSE } from "../collector/analysisLimit.ts";
import { certificateProblemLabel } from "./measurementsView.ts";
import type { AuditResult, CertificateFailureAudit, Finding, SiteFileStatus } from "../types";

/** Whether a finding is about one page or the whole site. */
export type FindingScope = "site" | "page";

/**
 * The scope a finding declares.
 *
 * READ, NEVER INFERRED. A rule declares its own scope and the server carries
 * it here; guessing from an id, a title or a category would be the browser
 * deciding something about a measurement it never took. Findings from before
 * the scope existed — and the speed findings, which describe one address —
 * are page-level, which is what they have always been.
 */
export function findingScope(finding: Finding): FindingScope {
  return finding.scope === "site" ? "site" : "page";
}

/**
 * Site findings first, then page findings, each keeping the order it arrived in.
 *
 * The server has already sorted by severity and then rule id. Re-sorting here
 * on anything else — how many pages are affected, how alarming a title reads —
 * would be the browser putting its own opinion above the rules'.
 */
export function partitionByScope(findings: readonly Finding[]): {
  site: Finding[];
  page: Finding[];
} {
  return {
    site: findings.filter((finding) => findingScope(finding) === "site"),
    page: findings.filter((finding) => findingScope(finding) === "page"),
  };
}

export interface AffectedView {
  /**
   * How much of the site this finding covers, e.g. "19 of 128 evaluated pages".
   *
   * Null for a site finding, which has no page denominator and must never be
   * given one — and null for any finding the server sent no counts for.
   */
  reach: string | null;
  /**
   * Present ONLY when the list is shorter than the true total.
   *
   * The server caps the affected list. Showing fifty entries under a heading
   * that says "147 pages affected" is honest; letting the reader assume the
   * fifty ARE the total is not, so this says so outright.
   */
  sample: string | null;
  /** The pages the server listed, exactly as it listed them. */
  pages: ReadonlyArray<{ url: string; evidence: string }>;
}

const pages = (count: number) => (count === 1 ? "page" : "pages");

export function affectedView(finding: Finding): AffectedView {
  const listed = finding.affected ?? [];

  /*
   * A SITE FINDING GETS NO PAGE COUNT AT ALL.
   *
   * Its `affectedCount` is 1 because one site was affected, not because one
   * page was. Rendering "1 of 128 pages" would turn a fact about a domain into
   * a claim about a page, and a reader would reasonably conclude the other 127
   * pages were fine.
   */
  if (findingScope(finding) === "site") {
    return { reach: null, sample: null, pages: listed };
  }

  const total = finding.affectedCount;
  const denominator = finding.evaluatedPages;

  let reach: string | null = null;
  if (total !== undefined && denominator !== undefined) {
    // The denominator is pages the RULE RAN ON — not pages discovered, not
    // pages crawled. The server worked it out; this only reads it.
    reach = `${total} of ${denominator} evaluated ${pages(denominator)}`;
  } else if (total !== undefined) {
    reach = `${total} ${pages(total)} affected`;
  }

  const sample =
    total !== undefined && listed.length > 0 && listed.length < total
      ? `Showing ${listed.length} of ${total}`
      : null;

  return { reach, sample, pages: listed };
}

/**
 * Whether the affected-pages list is worth offering.
 *
 * A finding with nothing listed has nothing to expand, and an empty
 * disclosure control is a small broken promise.
 */
export function hasAffectedList(finding: Finding): boolean {
  return (finding.affected?.length ?? 0) > 0;
}

/** The label shown on a finding, saying which kind of thing it describes. */
export function scopeLabel(scope: FindingScope): string {
  return scope === "site" ? "Site-wide" : "Page-level";
}

/**
 * The label above a finding's remediation.
 *
 * 7A §8 requires the action to be "labelled and set apart". On screen the
 * evidence and the action were once two grey paragraphs of the same size, and
 * a reader could not tell what was measured from what to do about it. The
 * label carries that distinction in words, so it does not rest on styling
 * alone, and it is shared so the PDF says exactly what the screen says.
 */
export const REMEDIATION_LABEL = "What to do";

export const SITE_FINDINGS_HEADING = "Site-wide issues";
export const PAGE_FINDINGS_HEADING = "Page-level issues";

export const SITE_FINDINGS_INTRO =
  "One fact about the whole website — its certificate, its domain records, its robots file. Each was measured once.";

export const PAGE_FINDINGS_INTRO =
  "Measured on each page that could be read. The count beside a finding is how many of those pages it was found on.";

// ---------------------------------------------------------------------------
// The crawl itself
// ---------------------------------------------------------------------------

/**
 * Why a crawl stopped, in words rather than an enum.
 *
 * Presentation only. The decision that a crawl was incomplete is the server's
 * — `complete` — and nothing here revisits it. This just spells out a value
 * the server already chose.
 */
/**
 * What the report calls itself, in one line.
 *
 * "COMPLETE" IS A CLAIM ABOUT THE SITE, so it may only be made when the crawl
 * actually covered it. `complete` is the server's own verdict, which accounts
 * for the page crawl and sitemap discovery both; nothing here recomputes it
 * from counts, because a second opinion could disagree with the banner beside
 * it and one of them would then be wrong.
 */
export function auditStatusText(complete: boolean): string {
  return complete ? "Website audit complete" : "Partial website audit";
}

export function stopReasonText(crawl: SiteCrawlSummary): string {
  switch (crawl.stoppedBecause) {
    case "max-pages":
      return `Stopped at the ${crawl.limits.maxPages}-page safety limit.`;
    case "max-duration":
      return "Stopped because the crawl reached its time limit.";
    case "max-queue":
      return "Stopped because the list of pages to visit reached its safety limit.";
    case "deadline":
      return "Stopped because the audit's overall time ran out.";
    case "completed":
      /*
       * The crawl of PAGES finished, yet the audit is not complete — which
       * happens when sitemap discovery was cut short, so there are parts of
       * the site we never learned about. Saying "stopped at a limit" would be
       * wrong; saying nothing would leave the banner unexplained.
       */
      return "The pages we knew about were all visited, but the site's sitemaps could not be read in full, so there may be more.";
  }
}

export interface CrawlView {
  /** True when the report covers less than the whole site. */
  partial: boolean;
  /** One line stating what was covered. */
  headline: string;
  /** Why it stopped short. Null when the crawl finished properly. */
  reason: string | null;
  /** Compact facts worth showing a salesperson. Only server-supplied values. */
  facts: Array<{ label: string; value: string }>;
}

/**
 * What to say about the crawl.
 *
 * `partial` comes STRAIGHT FROM `complete`. The browser does not work out
 * whether a crawl finished by comparing counts — the server already decided,
 * having accounted for the page crawl and sitemap discovery both, and a second
 * opinion computed from numbers could disagree with it.
 */
export function crawlView(crawl: SiteCrawlSummary): CrawlView {
  const partial = !crawl.complete;
  /*
   * A page too large to analyse is kept with the pages that could not be read,
   * so it is never graded or counted as clean -- but it WAS read, so it is
   * named separately here rather than miscounted as unreadable.
   */
  const tooLarge = crawl.unavailable.filter((failure) => failure.reason === TOO_LARGE_TO_ANALYSE).length;
  const unavailable = crawl.unavailable.length - tooLarge;

  const facts: Array<{ label: string; value: string }> = [
    { label: "Pages read", value: String(crawl.evaluated) },
    { label: "Pages found", value: String(crawl.discovered) },
  ];

  // Only shown when they happened. A row of zeroes is noise, and "0 pages
  // excluded by robots.txt" invites a question nobody asked.
  if (unavailable > 0) {
    facts.push({ label: `${pages(unavailable)} that could not be read`, value: String(unavailable) });
  }
  if (tooLarge > 0) {
    facts.push({ label: `${pages(tooLarge)} too large to analyse`, value: String(tooLarge) });
  }
  if (crawl.skippedNonHtml > 0) {
    facts.push({ label: "Files that were not web pages", value: String(crawl.skippedNonHtml) });
  }
  if (crawl.robots.excluded > 0) {
    facts.push({ label: "Excluded by robots.txt", value: String(crawl.robots.excluded) });
  }
  if (crawl.queuedAtStop > 0) {
    facts.push({ label: "Found but not visited", value: String(crawl.queuedAtStop) });
  }

  /*
   * TWO NUMBERS, TWO SEPARATE AGREEMENTS.
   *
   * The noun follows what was FOUND — "of 1 page", "of 100 pages" — because
   * that is the thing being counted. The verb follows what was READ, because
   * that is the subject of the sentence: one page WAS read, twenty-five WERE.
   *
   * Tying both to the same number reads wrong as soon as they differ, and
   * hard-coding the plural produced "1 of 1 pages ... were read" on the
   * smallest site there is.
   */
  const headline = partial
    ? `${crawl.evaluated} of ${crawl.discovered} ${pages(crawl.discovered)} found on this site ` +
      `${crawl.evaluated === 1 ? "was" : "were"} read, so this covers part of the site rather than all of it.`
    : `${crawl.evaluated} ${pages(crawl.evaluated)} read. Every page we found was visited.`;

  return { partial, headline, reason: partial ? stopReasonText(crawl) : null, facts };
}

/**
 * How a site-level file's three states read on the page.
 *
 * THE THIRD ONE IS WHY THIS EXISTS. "Not found" is a claim about the client's
 * website. When our own request timed out we have no such claim to make, and
 * making it anyway reports a robots.txt as missing from a site that has one.
 *
 * Lives here rather than in the component for the same reason every other
 * sentence does: it is a statement about somebody's website, so it is worth a
 * test, and a React component cannot easily be given one in this project.
 */
export function siteFileText(status: SiteFileStatus, foundText: string): string {
  switch (status) {
    case "found":
      return foundText;
    case "absent":
      return "Not found";
    case "unavailable":
      return "Could not be checked";
  }
}

/**
 * Whether robots.txt rules were actually applied.
 *
 * Worth saying when they were not: a crawl that could not read robots.txt has
 * not disobeyed the site, but it has not obeyed it either, and a report should
 * not imply otherwise.
 */
export function robotsNote(crawl: SiteCrawlSummary): string | null {
  if (crawl.robots.enforced) return null;
  return "This site's robots.txt could not be read, so its crawling rules were not applied.";
}

// ---------------------------------------------------------------------------
// An audit whose entry page could not be fetched securely
// ---------------------------------------------------------------------------

/**
 * Whether this audit is the kind that could not read a page.
 *
 * THE ONE TEST, so no reader of an audit has to know the shape of two. It is
 * a value, never a guess from a missing field: an audit that read pages does
 * not carry `kind` at all.
 */
export function isCertificateFailureAudit(
  result: AuditResult,
): result is CertificateFailureAudit {
  return "kind" in result && result.kind === "certificate-failure";
}

/**
 * What such an audit covered, in the same shape `crawlView` returns.
 *
 * IT NEVER USES THE CRAWL'S COUNTS. A crawl whose only page failed drained
 * its queue and so reports itself complete, and `crawlView` would turn that
 * into "0 pages read. Every page we found was visited." -- which reads as a
 * whole-site audit of a site with no pages. What happened is said instead.
 *
 * THE REASON IS THE COLLECTOR'S OWN SENTENCE, carried rather than reworded,
 * so the report says what the fetch said.
 */
export function certificateFailureView(audit: CertificateFailureAudit): CrawlView {
  return {
    partial: true,
    headline:
      "The entry page could not be fetched securely, so no page on this site was read.",
    reason: audit.reason,
    facts: [
      { label: "Address", value: withoutCredentials(audit.failedUrl) },
      {
        label: "Certificate problem",
        value: certificateProblemLabel(audit.certificateProblem),
      },
      {
        label: "Checked",
        value: "The certificate and the domain's records, measured once for the whole site",
      },
      {
        label: "Not checked",
        value: "Every check that reads a page, and page speed. Each is listed below.",
      },
    ],
  };
}

/** The heading this audit's coverage section carries on screen. */
export const CERTIFICATE_FAILURE_HEADING = "Partial audit";

/**
 * What the speed section says when there was no page to measure.
 *
 * The speed check is never started for such an audit: Google would be asked
 * to load a page this server could not load securely, and an answer about it
 * would describe something the audit did not see. Said in the section rather
 * than leaving it blank, because a blank speed panel reads as a fast site.
 */
export const SPEED_NOT_MEASURED_WITHOUT_PAGE =
  "Page speed was not measured. The entry page could not be fetched securely, so there was no page to measure.";
