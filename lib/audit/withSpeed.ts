/**
 * Joining the speed check back onto the audit it belongs to.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The speed check is measured in its own request, on its own 95-second budget,
 * so that a slow answer from Google never delays a report the salesperson is
 * waiting for. That was the right call and it stays. Its cost is that the two
 * halves of one audit are produced in two places, and for a long while they
 * were only ever brought together in the browser's own state.
 *
 * Nothing on the server could therefore describe a whole audit. The AI
 * contract, built from a `SiteAuditResult`, could only ever report that the
 * speed check was pending — so a report generated from it would be silent on
 * speed, which is one of the four things a client is being sold.
 *
 * WHY THE BROWSER MUST NOT DO THE JOINING
 *
 * The obvious alternative is to let the browser post both halves back. It
 * already holds them. But `buildAIReportInput` is the fail-closed boundary
 * this project spent a whole phase building, and feeding it JSON that came
 * from a client would let a modified client hand a model whatever findings and
 * severities it liked. The join happens here, from what the server measured,
 * and nothing a browser sends is ever an input to it.
 *
 * THIS FILE MEASURES NOTHING AND GRADES NOTHING
 *
 * Both halves arrive already measured and already graded. All this does is put
 * them in one object, and say honestly how far the speed findings reach.
 */
import { SPEED_RULES } from "../rules/all.ts";
import { withoutCredentials } from "../collector/url.ts";
import type { Finding, SiteAuditResult, SpeedResult } from "../types";

/**
 * How far a speed finding reaches, stated rather than inferred.
 *
 * THE ONLY JUDGEMENT IN THIS FILE, AND IT IS A SMALL ONE. The speed rules
 * declare themselves page-scoped, and they are: they describe a page. But they
 * ran against exactly ONE address — whatever the speed check was pointed at —
 * not against the crawl. So the reach is one page out of one page evaluated.
 *
 * Saying anything else would be a false proportion. Borrowing the crawl's
 * denominator would report "1 of 128 pages" about a measurement that never
 * looked at the other 127; leaving the fields off entirely would let the
 * contract read the count as zero, which says the finding affects nothing.
 */
function withReach(finding: Finding, measuredUrl: string): Finding {
  /*
   * Scope is READ FROM THE RULE, not assumed.
   *
   * `runRules` leaves it off the finding it emits — the crawl's aggregator
   * attaches it afterwards, and the speed check has no aggregator. Taking it
   * from the rule's own declaration means a speed rule that ever declares
   * itself site-scoped is honoured rather than quietly overridden here, and an
   * id with no rule behind it stays unstated rather than being guessed at.
   */
  const scope = SPEED_RULES.find((rule) => rule.id === finding.id)?.scope;

  const reach =
    scope === "page"
      ? {
          affected: [{ url: measuredUrl, evidence: finding.evidence }],
          affectedCount: 1,
          // The rule ran once, on one page. That is the whole denominator.
          evaluatedPages: 1,
        }
      : {};

  return { ...finding, scope, ...reach };
}

/**
 * Worst first, then by rule id.
 *
 * The same order the rule runner and the aggregator both use, so a merged list
 * reads exactly like every other list of findings in the report.
 */
function sortFindings(findings: Finding[]): Finding[] {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, good: 3 };
  return [...findings].sort((a, b) => {
    const bySeverity = order[a.severity] - order[b.severity];
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });
}

/**
 * One audit result carrying the speed check that was measured for it.
 *
 * Returns a NEW result and leaves the original untouched. The stored job holds
 * the audit exactly as the crawl produced it, and this is a view built on top
 * of that — which is what lets the same job be composed twice without the
 * second answer differing from the first.
 *
 * `null` speed returns the audit unchanged, deliberately: an audit where the
 * speed check was never asked for is a complete audit, and its performance
 * measurement already says `not-requested` in its own words.
 */
export function withSpeed(result: SiteAuditResult, speed: SpeedResult | null): SiteAuditResult {
  if (speed === null) return result;

  // Strip credentials before exposing the measured URL in Speed findings.
  const measuredUrl = withoutCredentials(speed.data.requestedUrl);
  const speedFindings = speed.findings.map((finding) => withReach(finding, measuredUrl));

  return {
    ...result,
    data: {
      ...result.data,
      // The real measurement, replacing the placeholder the audit left behind.
      performance: speed.data,
      findings: sortFindings([...result.data.findings, ...speedFindings]),
      skippedChecks: [...result.data.skippedChecks, ...speed.skippedChecks],
    },
    site: {
      ...result.site,
      findings: sortFindings([...result.site.findings, ...speedFindings]),
      skippedChecks: [...result.site.skippedChecks, ...speed.skippedChecks],
      /*
       * Untouched. This counts the pages the CRAWL evaluated, and the speed
       * check did not read a page of the site — it asked Google about one
       * address. Adding to it would inflate every other finding's denominator.
       */
      evaluatedPages: result.site.evaluatedPages,
    },
    /*
     * `pages` and `crawl` are untouched. The speed check visited nothing, so it
     * discovered nothing, evaluated nothing and changes no crawl count.
     */
  };
}
