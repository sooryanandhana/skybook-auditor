// The .ts extension is required so Node can run the unit tests directly;
// Next.js resolves it the same way.
import { safeFetch } from "./safety.ts";
import { findAllSitemapDirectives } from "./sitemap.ts";
import {
  isPathAllowed,
  parseGroups,
  selectRules,
  type RobotsMeasurement,
} from "./robots.ts";
import { capDeadline, createDeadline, type Deadline } from "./deadline.ts";
import type { SiteFileStatus, TechnicalData } from "@/lib/types";

/**
 * The total time ALL technical checks may take together.
 *
 * This is one budget shared across every request, not a limit per request.
 * Giving each request its own timeout let a single audit run for 20 seconds:
 * a slow sitemap could consume a full timeout on HEAD and another on the GET
 * fallback, on top of whatever robots.txt had already used. Multi-page
 * crawling would multiply that by the page count.
 */
const TOTAL_BUDGET_MS = 10_000;

const USER_AGENT = "SkybookAuditBot/1.0 (+website audit tool)";

/**
 * The shared countdown now lives in its own module, because the page fetch
 * uses the same one — that is what keeps a whole audit inside one budget
 * rather than each part keeping its own clock.
 */

/**
 * Checks the site-level files search engines look for.
 *
 * These live at fixed addresses rather than in the page's HTML. Only the
 * sitemap is requested here: robots.txt arrives already measured, because the
 * crawler read it before it queued anything and one file gets one answer.
 *
 * The hostname was already safety-checked before the main page was fetched,
 * and we only build URLs on that same origin — so no new address is being
 * reached that wasn't already approved.
 */
export async function runTechnicalChecks(
  pageUrl: string,
  /**
   * robots.txt, ALREADY MEASURED.
   *
   * Not fetched here, and there is no code path left that could. The crawler
   * reads the file once before it queues anything and hands the result on;
   * this module reports on that measurement and finds the Sitemap: lines in
   * the same text. Fetching it a second time is how one audit came to say
   * both "no robots.txt" and "robots.txt could not be checked" about the same
   * file, so the second request is gone rather than reconciled.
   */
  robots: RobotsMeasurement,
  /**
   * The audit's clock, or a number of milliseconds to run on its own.
   * Sharing the audit's clock is what keeps the whole audit inside one budget.
   */
  budget: number | Deadline = TOTAL_BUDGET_MS,
): Promise<TechnicalData> {
  const origin = new URL(pageUrl).origin;

  /*
   * One clock for every request below, so whatever robots.txt spends is time
   * the sitemap check no longer has.
   *
   * When given the audit's own deadline, these checks are ALSO capped at their
   * own budget. Using the audit's remaining time directly would let them
   * consume every second the page fetch did not — turning a ten-second limit
   * back into "whatever is left", which is the problem this budget exists to
   * prevent.
   */
  const deadline =
    typeof budget === "number"
      ? createDeadline(budget)
      : capDeadline(budget, TOTAL_BUDGET_MS);

  // A sitemap can be declared inside robots.txt. If it isn't, check the
  // conventional location before concluding there isn't one. The text is the
  // crawler's copy, so this reads the same file the rules were taken from.
  const sitemapFromRobots =
    robots.status === "found" ? findSitemapDirective(robots.text) : null;

  const sitemap =
    sitemapFromRobots !== null
      ? { status: "found" as const, url: sitemapFromRobots }
      : await findDefaultSitemap(`${origin}/sitemap.xml`, deadline);

  return {
    robotsTxtStatus: robots.status,
    /*
     * False unless we actually read the file and it actually blocks everyone.
     *
     * Meaningless on its own when the status is "unavailable" — which is why
     * the rule reading it consults the status first and declines to run rather
     * than reporting a site as unblocked on the strength of a failed request.
     */
    robotsBlocksEverything: robots.status === "found" && blocksEveryCrawler(robots.text),
    sitemapStatus: sitemap.status,
    sitemapUrl: sitemap.url,
  };
}

/**
 * The search engines this rule speaks for.
 *
 * The finding says "blocks all search engines", so it has to be true of the
 * engines a client cares about rather than of some abstract crawler. Each one
 * is resolved through the robots file's own group selection, so a file naming
 * none of them falls through to `User-agent: *` exactly as a real crawler
 * would — and a file that names one gets that group's answer instead.
 *
 * Deliberately short. These two account for essentially all search traffic a
 * small business sees, and a longer list would not change any answer this rule
 * gives: an engine with no group of its own always inherits the wildcard.
 */
const SEARCH_ENGINE_AGENTS = ["googlebot", "bingbot"] as const;

/**
 * Whether robots.txt tells every search engine to stay off the whole site.
 *
 * THIS USES THE CRAWLER'S OWN PARSER, AND THAT IS THE POINT OF THE FUNCTION.
 *
 * It used to scan the file itself, line by line, and it got a common shape
 * wrong:
 *
 *     User-agent: *
 *     Disallow: /
 *
 *     User-agent: AhrefsBot
 *     Disallow: /admin
 *
 * That file hides the entire site from Google, which has no group of its own
 * and so falls into the wildcard. The old scanner discarded what the wildcard
 * group had said the moment it met another `User-agent` line, and reported
 * nothing — on a file shape that is common, because sites routinely add groups
 * for SEO crawlers. A staging site left with `Disallow: /` passed the audit.
 *
 * It also did not understand `Disallow: /*`, which matches every path.
 *
 * Both failures came from the same cause: a second implementation of a
 * question the codebase had already answered correctly. `parseGroups`,
 * `selectRules` and `isPathAllowed` are what the crawler obeys when deciding
 * whether it may fetch a page, and they handle groups, precedence, `*` and `$`
 * between them. Now the rule and the crawler read the same file the same way,
 * and cannot disagree about it.
 *
 * The one thing added on top is the ALLOW EXCEPTION: a group carrying any
 * `Allow:` rule has carved something out, so the site is not entirely blocked
 * even though its root is. That is a property of the parsed rules rather than
 * a second reading of the text.
 */
/**
 * A stand-in for "any page that is not the home page".
 *
 * Used to tell a whole-site block from one that only names the root. Its exact
 * value does not matter, only that it is a non-root path a broad `Disallow: /`
 * or `Disallow: /*` matches while an end-anchored `Disallow: /$` does not.
 */
const NON_ROOT_PROBE_PATH = "/robots-scope-probe";

export function blocksEveryCrawler(robotsTxt: string): boolean {
  const groups = parseGroups(robotsTxt);

  return SEARCH_ENGINE_AGENTS.every((agent) => {
    // Exactly the group a real crawler of that name would obey, wildcard
    // fallback included.
    const rules = selectRules(groups, agent);

    // Nothing addressed to it at all means nothing forbids it.
    if (rules.length === 0) return false;

    // An exception anywhere in the group means some of the site is reachable.
    if (rules.some((rule) => rule.allow)) return false;

    /*
     * "BLOCKS THE WHOLE SITE" IS MORE THAN "BLOCKS THE HOME PAGE".
     *
     * `Disallow: /$` matches only the exact path "/" -- the `$` anchors the end
     * -- so /about and every other page stay crawlable and the site is NOT
     * entirely blocked. Probing the root alone read that as a full block and
     * raised a false Critical. So a representative non-root path is probed too,
     * and the site counts as entirely blocked only when BOTH are disallowed:
     * `Disallow: /` and `Disallow: /*` block both, `Disallow: /$` blocks only
     * the root.
     */
    return !isPathAllowed(rules, "/") && !isPathAllowed(rules, NON_ROOT_PROBE_PATH);
  });
}

/**
 * Reads a `Sitemap:` line from robots.txt, if there is one.
 *
 * The audit records ONE sitemap address, because the question it answers is
 * "does this site have a sitemap". The crawler needs every one of them, so the
 * line-reading itself lives in `sitemap.ts` and this takes the first — one
 * definition of what a Sitemap: directive looks like, used by both.
 */
export function findSitemapDirective(robotsTxt: string): string | null {
  return findAllSitemapDirectives(robotsTxt)[0] ?? null;
}

/**
 * Checks whether the conventional /sitemap.xml exists.
 *
 * Carries the same three-state answer as robots.txt, and for the same reason:
 * a HEAD request that times out told us nothing, and reporting "no sitemap"
 * would be a claim about the client's website drawn from our own failure.
 */
async function findDefaultSitemap(
  url: string,
  deadline: Deadline,
): Promise<{ status: SiteFileStatus; url: string | null }> {
  if (deadline.expired()) return { status: "unavailable", url: null };

  try {
    // HEAD asks only "does this exist?" without downloading the file, which
    // can be large.
    let response = await safeFetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      signal: deadline.signal(),
    });

    /*
     * The GET fallback is ONLY for a server that answered and said it does not
     * do HEAD. 405 Method Not Allowed and 501 Not Implemented are exactly that.
     *
     * A null response means the request never completed — a timeout, a network
     * failure, or an address the safety check refused. Retrying with GET there
     * would repeat a request we already know does not work, and on a slow
     * server it would burn a second full timeout for nothing. That doubling was
     * how a single audit reached twenty seconds.
     */
    const serverRejectedHead =
      response !== null && (response.status === 405 || response.status === 501);

    if (serverRejectedHead && !deadline.expired()) {
      response = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: deadline.signal(),
      });
    }

    if (!response) return { status: "unavailable", url: null };

    if (response.status === 404 || response.status === 410) {
      return { status: "absent", url: null };
    }

    if (!response.ok) return { status: "unavailable", url: null };

    // Again, a site serving HTML here has no real sitemap.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("html")) return { status: "absent", url: null };

    return { status: "found", url };
  } catch {
    return { status: "unavailable", url: null };
  }
}
