/**
 * Turning many pages' findings into one site's findings.
 *
 * A crawl of 147 pages runs the same rules 147 times. Handing a client 83
 * separate copies of "Meta description missing" is not a report, it is a log —
 * so the same rule firing on many pages becomes ONE finding that names the
 * pages it was found on.
 *
 * THIS FILE COUNTS. IT DOES NOT GRADE.
 *
 * That distinction is the whole design. Severity arrives here already decided,
 * as a constant the rule declared, and is copied out untouched. Eighty-three
 * pages missing a meta description is exactly as severe as one page missing
 * it, because severity describes the KIND of problem, not how much of it there
 * is. Nothing here reads a count and reaches for a worse word — there is no
 * code path that could, and a test asserts the aggregator never mentions a
 * severity value at all.
 *
 * It also never looks at other findings. Each rule is aggregated in complete
 * isolation, so no finding can be promoted, suppressed or reworded because of
 * what some other rule happened to say.
 *
 * WHAT THE DENOMINATOR MEANS, AND WHY IT IS NOT THE PAGE COUNT
 *
 * `evaluatedPages` is the number of pages a RULE RAN ON, which is smaller than
 * the number of pages crawled whenever a measurement was unavailable. If 100
 * pages were read and a rule could not run on 20 of them, its denominator is
 * 80 — never 100. Counting those 20 would turn "we could not check this" into
 * "these pages were fine", which is the exact falsehood this project exists to
 * avoid. Their reasons survive as skipped checks instead.
 *
 * Pages that could not be read, that were not HTML, and that robots.txt kept
 * us away from never reach this file at all: only evaluated pages are passed
 * in, so they cannot be counted as clean by accident.
 */
import type { Finding, Severity, SkippedCheck } from "../types";

/**
 * The most pages one finding will list.
 *
 * A cap on the RESPONSE, not on the measurement: `affectedCount` always
 * reports the true total, so a finding on four hundred pages says four
 * hundred and shows fifty. Without it a large site could produce a response
 * of thousands of entries — thirty rules across a hundred and fifty pages —
 * for no benefit, since nobody reads the four hundredth example.
 *
 * The pages kept are the first fifty by address, so the sample is stable
 * rather than whichever pages happened to finish first.
 */
export const MAX_AFFECTED_PAGES = 50;

/** What the rules produced for one page that was successfully read. */
export interface PageRuleResult {
  /** The page's address, as crawled. */
  url: string;
  /** Everything the rules said about this page, problems and passes alike. */
  findings: Finding[];
  /** Rules that could not run here, and why. Never findings. */
  skipped: SkippedCheck[];
}

export interface SiteFindings {
  /** One finding per rule outcome, worst first, then by rule id. */
  findings: Finding[];
  /**
   * Checks that could not run somewhere on the site, de-duplicated.
   *
   * Kept apart from findings, because "we could not check this" is a third
   * thing: not a problem, and emphatically not a pass.
   */
  skipped: SkippedCheck[];
  /** How many pages were read and had rules run against them. */
  evaluatedPages: number;
}

/** Worst first, matching the single-page runner exactly. */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  good: 3,
};

/**
 * Combines the findings from every evaluated page into site-level findings.
 *
 * DETERMINISTIC BY CONSTRUCTION. Pages are sorted by address before anything
 * is read from them, so the result cannot depend on the order the crawl's
 * workers happened to finish in. Two crawls that read the same pages produce
 * byte-identical output.
 *
 * Findings are grouped by rule id AND severity. Grouping by id alone would put
 * a rule that fired on some pages together with the same rule PASSING on
 * others — two genuinely different statements — and something would then have
 * to choose one severity to describe both. There is no honest way to make that
 * choice, so it is never faced: a rule that fires on 30 pages and passes on 50
 * produces one finding of each, sharing a denominator.
 *
 * Two findings with different rule ids stay separate however alike they look.
 * The id is the identity; a matching title is a coincidence.
 */
/**
 * A finding about the whole site, measured once.
 *
 * Handed in already evaluated rather than gathered from the pages, because it
 * was never a page fact to begin with. The site rules run once against the
 * site's own measurements — see `runSiteAudit` — and arrive here to be placed
 * beside the page findings, not counted against them.
 */
export interface SiteScopedFindings {
  /** The address the site-level facts were measured for. */
  siteUrl: string;
  /** What the site rules said, exactly as the rule engine produced it. */
  findings: Finding[];
  /** Site rules that could not run, and why. Never findings. */
  skipped: SkippedCheck[];
}

export interface AggregateOptions {
  /**
   * Findings from rules that describe the site rather than any page.
   *
   * They are passed through untouched apart from being marked `scope: "site"`
   * and given the site's own address as their single affected entry. Nothing
   * multiplies them by the page count, and nothing gives them a page
   * denominator — a certificate expiring is one fact whether the crawl read
   * one page or four hundred.
   */
  site?: SiteScopedFindings;
  /**
   * The ids of every rule that was run against each page.
   *
   * STRONGLY PREFERRED, because it is the only way to get the denominator
   * exactly right. A rule that ran and stayed quiet — did not fire, and
   * declares no pass message — leaves no trace on a page at all, so without
   * being told the rule set, this file can only count pages where the rule
   * SAID something. That undercounts the denominator, which makes a
   * proportion look worse than it was measured to be: "8 of 8 pages" instead
   * of "8 of 10". Overstating a problem is the failure this project cares
   * most about, so callers should pass the rule set they used.
   */
  ruleIds?: readonly string[];
}

export function aggregateFindings(
  pages: readonly PageRuleResult[],
  options: AggregateOptions = {},
): SiteFindings {
  // Sorted first, so every "first one wins" below is decided by the address
  // rather than by which worker got there first.
  const ordered = [...pages].sort((a, b) => a.url.localeCompare(b.url));

  /** Group key → the finding's constants, plus the pages it was found on. */
  const groups = new Map<
    string,
    { template: Finding; affected: Array<{ url: string; evidence: string }>; seen: Set<string> }
  >();

  /** Rule id → how many pages it actually ran on. */
  const ranOn = new Map<string, number>();

  const skipped = new Map<string, SkippedCheck>();

  for (const pageResult of ordered) {
    const skippedHere = new Set<string>();
    for (const check of pageResult.skipped) {
      skippedHere.add(check.ruleId);
      // De-duplicated by rule AND reason: one rule can be unavailable for two
      // different reasons across a site, and both are worth keeping.
      skipped.set(`${check.ruleId}\u0000${check.reason}`, {
        ruleId: check.ruleId,
        reason: check.reason,
      });
    }

    /*
     * Every rule that was not skipped here ran here.
     *
     * That is the whole derivation of the denominator, and it is deliberately
     * indirect: a rule which ran and stayed quiet produces no finding at all,
     * so the only reliable evidence that it ran is the absence of a skip.
     */
    for (const finding of pageResult.findings) {
      if (skippedHere.has(finding.id)) continue;

      const key = `${finding.id}\u0000${finding.severity}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { template: finding, affected: [], seen: new Set() };
        groups.set(key, group);
      }

      // One page cannot be affected twice by the same finding, however many
      // times it appears in that page's results.
      if (group.seen.has(pageResult.url)) continue;
      group.seen.add(pageResult.url);
      group.affected.push({ url: pageResult.url, evidence: finding.evidence });
    }

    /*
     * Counted per rule id rather than per group, so a rule that fires on one
     * page and passes on another has ONE denominator, not two.
     *
     * A rule is counted for this page unless it was skipped here — the skip is
     * the only thing that means "did not run".
     */
    for (const ruleId of options.ruleIds ?? ruleIdsSeenOn(pageResult)) {
      if (skippedHere.has(ruleId)) continue;
      ranOn.set(ruleId, (ranOn.get(ruleId) ?? 0) + 1);
    }
  }

  const findings: Finding[] = [];

  for (const group of groups.values()) {
    // A rule that never produced anything has no group, so nothing here can
    // invent a finding for a rule that did not fire.
    if (group.affected.length === 0) continue;

    const affected = [...group.affected].sort((a, b) => a.url.localeCompare(b.url));

    findings.push({
      // Every one of these is the rule's own constant, carried across
      // untouched. Nothing is recomputed, least of all severity.
      id: group.template.id,
      title: group.template.title,
      category: group.template.category,
      severity: group.template.severity,
      remediation: group.template.remediation,
      // The single-page shape keeps a bare `evidence`, so a report that never
      // learned about crawling still has something to show.
      evidence: group.template.evidence,
      // Page-scoped by construction: everything in `groups` came from a page.
      scope: "page",
      affected: affected.slice(0, MAX_AFFECTED_PAGES),
      affectedCount: affected.length,
      evaluatedPages: ranOn.get(group.template.id) ?? affected.length,
    });
  }

  /*
   * The site's own findings, placed beside the page findings.
   *
   * Each keeps its rule's severity, title and evidence untouched, and is given
   * exactly ONE affected entry: the site itself. It gets no `evaluatedPages`,
   * because a domain's DNS records have no page denominator — inventing one
   * would let a reader quote a proportion that was never measured.
   */
  for (const finding of options.site?.findings ?? []) {
    findings.push({
      ...finding,
      scope: "site",
      affected: [{ url: options.site?.siteUrl ?? "", evidence: finding.evidence }],
      affectedCount: 1,
    });
  }

  for (const check of options.site?.skipped ?? []) {
    skipped.set(`${check.ruleId}\u0000${check.reason}`, {
      ruleId: check.ruleId,
      reason: check.reason,
    });
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });

  return {
    findings,
    skipped: [...skipped.values()].sort(
      (a, b) => a.ruleId.localeCompare(b.ruleId) || a.reason.localeCompare(b.reason),
    ),
    evaluatedPages: ordered.length,
  };
}

/**
 * Every rule id this page has something to say about.
 *
 * The fallback used only when the caller did not name its rule set. A rule
 * that ran and stayed quiet appears in neither list, so it cannot be counted —
 * see `AggregateOptions.ruleIds` for why that is worth avoiding.
 */
function ruleIdsSeenOn(pageResult: PageRuleResult): Set<string> {
  const ids = new Set<string>();
  for (const finding of pageResult.findings) ids.add(finding.id);
  for (const check of pageResult.skipped) ids.add(check.ruleId);
  return ids;
}
