/**
 * The rule sets, and which request runs which.
 *
 * They are split because the two requests hold different measurements, not for
 * tidiness:
 *
 *   AUDIT_RULES  run by POST /api/audit, which holds every measurement EXCEPT
 *                the speed figures. Its `performance` is "pending" or
 *                "not-requested", so running the speed rules there would skip
 *                all seven on every audit and fill `skippedChecks` with noise
 *                about a check that was never going to run in that request.
 *
 *   SPEED_RULES  run by POST /api/audit/performance, once Google has actually
 *                answered. That endpoint holds the speed figures and nothing
 *                else, which is why those rules read a narrower fact type.
 *
 *   ALL_RULES    both, as the complete inventory. Used to prove no two rules
 *                anywhere share an id — a duplicate would make a finding
 *                impossible to trace back to the rule that made it.
 */
import { SECURITY_RULES } from "./security.ts";
import { SEO_RULES } from "./seo.ts";
import { TECHNICAL_RULES } from "./technical.ts";
import { SPEED_RULES } from "./speed.ts";
import type { CompiledRule, SiteFacts } from "./types";

/** Everything POST /api/audit has the measurements to grade. */
export const AUDIT_RULES: readonly CompiledRule[] = [
  ...SECURITY_RULES,
  ...SEO_RULES,
  ...TECHNICAL_RULES,
];

/**
 * The audit rules split by what their measurement actually describes.
 *
 * WHY THE SPLIT EXISTS. A crawl of 128 pages runs the page rules 128 times,
 * because two pages can genuinely differ about a title or a heading. It must
 * NOT run the site rules 128 times: there is one certificate, one set of DNS
 * records and one robots.txt for the whole website, and measuring them once
 * per page produced the sentence "128 of 128 pages affected" about a single
 * SPF record. That is not a display problem to be tidied up afterwards — it is
 * a false statement about the measurement, so the two are evaluated apart.
 *
 * Derived from each rule's own declared `scope` rather than from a list kept
 * here, so a new rule joins the right group by saying what it measures.
 */
export const PAGE_RULES: readonly CompiledRule[] = AUDIT_RULES.filter(
  (rule) => rule.scope === "page",
);

/**
 * TYPED BY WHAT THEY READ, which is what lets them be evaluated without a
 * page. Each site rule is declared over `SiteFacts` where it is defined, so
 * the predicate below states a relation the compiler has already checked at
 * every one of those definitions; `scope.test.mts` then proves at runtime
 * that no site rule reaches for a page measurement.
 */
export const SITE_RULES: readonly CompiledRule<SiteFacts>[] = AUDIT_RULES.filter(
  (rule): rule is CompiledRule<SiteFacts> => rule.scope === "site",
);

export { SPEED_RULES };

/**
 * Every rule in the audit, for inventory and uniqueness checks.
 *
 * The speed rules read only `performance`, so they satisfy the wider fact type
 * as well — a set of facts carrying everything necessarily carries that.
 */
export const ALL_RULES: readonly CompiledRule[] = [...AUDIT_RULES, ...SPEED_RULES];
