/**
 * Site-level technical grading rules.
 *
 * ---------------------------------------------------------------------------
 * SEVERITY POLICY — APPROVED AND FIXED
 *
 *   critical  technical.robots.blocks-all
 *
 * One rule for now. Missing robots.txt and missing sitemap were deliberately
 * left out of this first set: a site without robots.txt is crawled completely,
 * which is usually fine, and calling that Medium alongside a missing meta
 * description would overstate it. The severity scale has no band below Medium,
 * so the honest options were to overstate or to omit, and omitting is the one
 * that does not put a number on something we do not believe.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IS CRITICAL
 *
 * A robots.txt that disallows every crawler removes the site from search
 * results entirely. It is usually left behind after a staging site goes live,
 * it is invisible to anyone browsing the site, and it costs the client every
 * organic visitor they would otherwise have had. Nothing else this audit can
 * measure is quite so expensive or quite so easy to fix.
 */
import type { TechnicalData } from "../types";
import { defineRule } from "./runner.ts";
import { fromRobotsRules } from "./selectors.ts";
import { fires, passes } from "./types.ts";

export const robotsBlocksAllRule = defineRule<TechnicalData>({
  id: "technical.robots.blocks-all",
  scope: "site",
  title: "robots.txt blocks all search engines",
  category: "technical",
  severity: "critical",
  remediation:
    "Remove the site-wide Disallow: / from robots.txt. This is usually left over from a staging site and keeps the whole site out of search results.",
  /*
   * `fromRobotsRules` stops this rule in BOTH directions.
   *
   * It cannot fire on an audit that ran out of time before looking — "we never
   * checked" must never become "this site blocks search engines". And it
   * cannot PASS on a robots.txt we failed to read, which is the subtler of the
   * two: `robotsBlocksEverything` is false there for want of information, and
   * passing would tell a client their site is not blocked from search on the
   * strength of a request that timed out.
   */
  select: (data) => fromRobotsRules(data.technical),
  evaluate: (technical) =>
    technical.robotsBlocksEverything
      ? fires("robots.txt disallows all crawlers from the entire site.")
      : passes,
});

export const TECHNICAL_RULES = [robotsBlocksAllRule] as const;
