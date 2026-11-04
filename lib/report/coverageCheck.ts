/**
 * Whether a crawl's coverage counts add up, before any of them is shown.
 *
 * ONE CHECK, USED EVERYWHERE. The dashboard and the PDF both print figures from
 * the same crawl summary: how many addresses were found, read, could not be
 * read, and so on. If those counts contradict each other, every figure built
 * from them is suspect, so none is shown. This file is the only place that
 * decides whether they are consistent; every view that prints a coverage or
 * finding-scope figure asks it, and none re-derives the answer.
 *
 * PURE AND SILENT. It reads the summary and returns a verdict. It does not log,
 * cache or correct anything, and it never invents a substitute figure.
 *
 * The invariants (s = the starting address, r = addresses not reached):
 *
 *   I1  s = discovered − sources.html − sources.sitemap is 0 or 1
 *   I2  evaluated + unavailable + skippedNonHtml ≤ discovered
 *   I3  r = discovered − evaluated − unavailable − skippedNonHtml ≥ 0
 *   I4  a complete crawl leaves nothing unreached: complete ⇒ r = 0
 *   I5  anything unreached means the crawl was not complete: r > 0 ⇒ not complete
 *   I6  no address is listed twice among the pages that could not be read
 *
 * I2 and I3 are the same condition stated two ways, as are I4 and I5; each is
 * kept and tested under its own name so every stated requirement maps to code.
 *
 * WHAT I6 CANNOT SEE. The summary records unreadable pages by address, but read
 * pages and non-page files only as counts. An address counted in two different
 * outcomes is therefore invisible here; I2 and I3 catch it only when the totals
 * exceed what was found.
 */
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";

export type CoverageInvariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6";

/**
 * The verdict. When the counts reconcile, it also carries the two facts the
 * views need from them, so a view never re-reads the raw counts to get them.
 */
export type CoverageCheck =
  | { readonly valid: true; readonly includesStartingAddress: boolean; readonly pagesRead: number }
  | { readonly valid: false };

/** Each invariant, held or not. Exported so tests can show which one a case breaks. */
export function coverageInvariants(crawl: SiteCrawlSummary): Record<CoverageInvariant, boolean> {
  const read = crawl.evaluated;
  const unreadable = crawl.unavailable.length;
  const notPages = crawl.skippedNonHtml;
  const startingAddress = crawl.discovered - crawl.sources.html - crawl.sources.sitemap;
  const unreached = crawl.discovered - read - unreadable - notPages;
  const unreadableAddresses = new Set(crawl.unavailable.map((failure) => failure.url));

  return {
    I1: startingAddress === 0 || startingAddress === 1,
    I2: read + unreadable + notPages <= crawl.discovered,
    I3: unreached >= 0,
    I4: !crawl.complete || unreached === 0,
    I5: !(unreached > 0) || !crawl.complete,
    I6: unreadableAddresses.size === unreadable,
  };
}

export function coverageCheck(crawl: SiteCrawlSummary): CoverageCheck {
  const held = coverageInvariants(crawl);
  if (!Object.values(held).every(Boolean)) return { valid: false };

  return {
    valid: true,
    includesStartingAddress: crawl.discovered - crawl.sources.html - crawl.sources.sitemap === 1,
    pagesRead: crawl.evaluated,
  };
}
