/**
 * robots.txt: which pages a site is willing for us to fetch.
 *
 * A PERMISSION MECHANISM, NEVER A FINDING. A `Disallow` is the site owner
 * telling crawlers where not to go. It is an instruction we obey, not a fault
 * we report — a staging directory kept out of search results is a perfectly
 * well-run website, and filing it as a problem would be inventing one. Nothing
 * in this file produces a severity, a finding, or a recommendation.
 *
 * The audit's own robots-related MEASUREMENTS already exist in
 * `technicalChecks` — whether the file is present, and whether it blocks every
 * crawler. Those answer questions about the site. This answers a question about
 * us: may we fetch this address.
 *
 * ROBOTS CAN ONLY EVER SUBTRACT.
 *
 * This is the single most important property here. An `Allow` line cannot make
 * anything crawlable that was not already: every address still passes
 * `normalizeCrawlUrl`, still passes the same-site rule, still goes through the
 * frontier, and is still fetched through `fetchPage`, which checks the hostname
 * before every request and every redirect. Robots sits between those checks as
 * a filter that removes addresses. A site could reply with `Allow: /` for
 * `http://169.254.169.254/` and change precisely nothing.
 *
 * WHAT THIS IMPLEMENTS
 *
 * The de-facto standard as written up in RFC 9309: user-agent groups, Allow and
 * Disallow, `*` and `$` wildcards, and longest-match-wins precedence with Allow
 * winning ties. Enough for correct enforcement, and no more.
 */
import { capDeadline, type Deadline } from "./deadline.ts";
import { createSitemapFetcher, type SitemapFetcher } from "./sitemap.ts";

/**
 * The name we answer to in robots.txt.
 *
 * The "product token" — the first word of the User-Agent header this project
 * sends, `SkybookAuditBot/1.0 (+website audit tool)`. A site wanting to keep us
 * out specifically writes `User-agent: SkybookAuditBot`; matching is
 * case-insensitive, as the standard requires.
 *
 * Deliberately the real name rather than something that impersonates a search
 * engine. A crawler that lies about who it is cannot claim to be respecting
 * anything.
 */
export const CRAWLER_USER_AGENT_TOKEN = "SkybookAuditBot";

/** How long the robots.txt request itself may take. */
export const ROBOTS_BUDGET_MS = 10_000;

/** What we know about a site's robots.txt. */
export type RobotsStatus =
  /** Read, and it contains rules. */
  | "rules"
  /** Read, and it contains no rules that apply to anyone. Everything allowed. */
  | "empty"
  /** The server said plainly that there is no robots.txt. Everything allowed. */
  | "absent"
  /** We could not read it. We do not know what it said. */
  | "unavailable";

/** One Allow or Disallow line. */
interface RobotsRule {
  allow: boolean;
  /** The path pattern, exactly as written. May contain `*` and `$`. */
  pattern: string;
}

/** One `User-agent:` group and the rules that follow it. */
export interface RobotsGroup {
  /** Every agent token the group applies to, lowercased. */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsPolicy {
  status: RobotsStatus;
  /**
   * Whether the rules in this policy are the site's actual rules.
   *
   * False ONLY when the file could not be read. A crawl that ran without
   * knowing the rules must never be described as having respected them, so
   * this is reported rather than assumed either way.
   */
  enforced: boolean;
  /** The file's text, so nothing has to fetch it twice. Null if unread. */
  text: string | null;
  /**
   * Whether we may fetch this address.
   *
   * Only ever consulted for an address that has ALREADY passed normalisation
   * and the same-site rule, and only ever able to turn a yes into a no.
   */
  isAllowed(url: URL | string): boolean;
}

/**
 * THE ONE ROBOTS.TXT MEASUREMENT, restated for everything that reports on it.
 *
 * The file is fetched exactly once per audit, by the crawler, before anything
 * is queued. Everything else that has something to say about robots.txt --
 * sitemap discovery, the site-file checks, the report, the AI contract -- is
 * handed this rather than going and looking again.
 *
 * WHY THAT MATTERS MORE THAN THE SAVED REQUEST. Two fetches of one file can
 * disagree: a 404 on the first and a timeout on the second are different
 * answers to the same question, and the report then said both at once, "this
 * site has no robots.txt" beside "robots.txt could not be checked". One is a
 * claim about the client's website and the other is a claim about our own
 * request, and the whole project turns on not confusing them. With one
 * measurement the disagreement cannot arise.
 *
 * A DISCRIMINATED UNION, so only "found" carries text. "absent" and
 * "unavailable" have no text to offer and cannot pretend to.
 *
 * The crawler's four states collapse to three here:
 *
 *   rules / empty  -> found. We read it; it either carried rules or did not.
 *   absent         -> absent. The server told us there is none.
 *   unavailable    -> unavailable. We did not find out, and nothing may say
 *                     otherwise.
 */
export type RobotsMeasurement =
  | { status: "found"; text: string }
  | { status: "absent" | "unavailable" };

/** Projects the policy the crawler holds into the measurement everyone reads. */
export function robotsMeasurement(policy: RobotsPolicy): RobotsMeasurement {
  if (policy.status === "unavailable") return { status: "unavailable" };
  if (policy.status === "absent") return { status: "absent" };
  // "rules" and "empty" both mean the file was read, so the text is there.
  return { status: "found", text: policy.text ?? "" };
}

/** A policy that permits everything, for when there are no rules to apply. */
function permissive(status: RobotsStatus, text: string | null): RobotsPolicy {
  return {
    status,
    // "absent" and "empty" are real answers: the site has no rules, so a crawl
    // that respects none of them has still respected all of them. Only an
    // unreadable file leaves us ignorant.
    enforced: status !== "unavailable",
    text,
    isAllowed: () => true,
  };
}

/**
 * Builds a policy from the text of a robots.txt.
 *
 * Pure, so every matching decision below is testable without a network.
 */
export function parseRobots(text: string, agentToken = CRAWLER_USER_AGENT_TOKEN): RobotsPolicy {
  const groups = parseGroups(text);
  const rules = selectRules(groups, agentToken);

  if (groups.length === 0) return permissive("empty", text);

  return {
    status: "rules",
    enforced: true,
    text,
    isAllowed(url) {
      const target = typeof url === "string" ? new URL(url) : url;
      return isPathAllowed(rules, target.pathname + target.search);
    },
  };
}

/**
 * Splits robots.txt into user-agent groups.
 *
 * Two details the format requires, and both are easy to get wrong:
 *
 * 1. CONSECUTIVE `User-agent` LINES SHARE ONE GROUP. So
 *      User-agent: *
 *      User-agent: Googlebot
 *      Disallow: /private
 *    is one group naming two agents, not two groups the second of which has
 *    all the rules. Starting a fresh group per line would silently give the
 *    first agent no rules at all.
 *
 * 2. A RULE LINE ENDS THE AGENT LIST. The next `User-agent` after a rule
 *    begins a new group.
 */
export function parseGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    // Comments run to the end of the line, wherever they start.
    const line = rawLine.split("#")[0].trim();
    if (line === "") continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!lastLineWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    if (field !== "allow" && field !== "disallow") {
      // Sitemap:, Crawl-delay:, Host: and anything else are not permissions.
      // They do not end the agent list either, so they are simply skipped.
      continue;
    }

    lastLineWasAgent = false;
    // A rule before any User-agent line belongs to no group, and the standard
    // gives it no meaning. Ignored rather than guessed at.
    if (current === null) continue;

    /*
     * `Disallow:` WITH AN EMPTY VALUE MEANS "NOTHING IS DISALLOWED".
     *
     * It is the conventional way to say "crawl everything", and it is the
     * opposite of `Disallow: /`. Treating the empty value as a path would match
     * every address and lock the crawler out of the entire site.
     */
    if (field === "disallow" && value === "") continue;

    // An empty `Allow:` is equally meaningless, and grants nothing.
    if (field === "allow" && value === "") continue;

    current.rules.push({ allow: field === "allow", pattern: value });
  }

  return groups;
}

/**
 * The rules that apply to us.
 *
 * Exactly ONE group applies — the standard is explicit that groups are not
 * merged. The most specific match wins: our own name beats `*`, and a longer
 * matching token beats a shorter one. A file naming only other crawlers leaves
 * us with no rules, which means everything is permitted.
 */
export function selectRules(groups: RobotsGroup[], agentToken: string): RobotsRule[] {
  const me = agentToken.toLowerCase();

  let best: RobotsGroup | null = null;
  let bestLength = -1;

  for (const group of groups) {
    for (const agent of group.agents) {
      // Matching is by prefix of the product token, so "skybookauditbot" in
      // the file matches us whatever version we append to our header.
      const matches = agent !== "*" && me.startsWith(agent) && agent.length > 0;
      if (!matches) continue;
      if (agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }

  if (best !== null) return best.rules;

  // Nothing named us, so the wildcard group applies if there is one.
  for (const group of groups) {
    if (group.agents.includes("*")) return group.rules;
  }

  return [];
}

/**
 * Whether a path is permitted by a group's rules.
 *
 * PRECEDENCE, which is where naive implementations go wrong: the rule with the
 * LONGEST matching pattern wins, regardless of the order the lines appear in.
 * On an exact tie, Allow wins. So
 *
 *   Disallow: /shop
 *   Allow: /shop/public
 *
 * permits /shop/public and refuses /shop/private, whichever order they are
 * written in. Taking the first or last match instead would give the opposite
 * answer for one of them.
 */
export function isPathAllowed(rules: RobotsRule[], path: string): boolean {
  let winner: RobotsRule | null = null;
  let winningLength = -1;

  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;

    const length = rule.pattern.length;
    if (length > winningLength || (length === winningLength && rule.allow)) {
      winner = rule;
      winningLength = length;
    }
  }

  // No rule mentions this path, so nothing forbids it.
  return winner === null ? true : winner.allow;
}

/**
 * Whether one robots pattern matches a path.
 *
 * Patterns are PREFIX matches with two special characters:
 *
 *   *   any run of characters, including none
 *   $   only at the end, meaning the path must finish here
 *
 * Percent-encoding is compared both ways round. A robots.txt may write
 * `/private path` where the URL arrives as `/private%20path`, or the reverse,
 * and a crawler that compared only one form would walk straight into a
 * directory it was asked to stay out of. Matching either form is deterministic
 * and errs toward honouring the rule.
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;

  const candidates = new Set([path, safeDecode(path)]);
  const patterns = new Set([pattern, safeDecode(pattern)]);

  for (const p of patterns) {
    for (const candidate of candidates) {
      if (matchesOnce(p, candidate)) return true;
    }
  }
  return false;
}

function matchesOnce(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const segments = body.split("*");

  // No wildcard: a plain prefix match, or a full match when anchored.
  if (segments.length === 1) {
    return anchored ? path === body : path.startsWith(body);
  }

  // The first segment must sit at the very start.
  if (!path.startsWith(segments[0])) return false;
  let cursor = segments[0].length;

  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    if (segment === "") {
      // A trailing `*` matches whatever remains — unless `$` demands the end,
      // which an empty tail satisfies anyway.
      if (isLast) return true;
      continue;
    }

    if (isLast && anchored) {
      // The final piece must land exactly at the end of the path.
      return path.length >= cursor + segment.length && path.endsWith(segment);
    }

    const found = path.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }

  return anchored ? cursor === path.length : true;
}

/** Percent-decoding that returns the input unchanged rather than throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a site's robots.txt and builds the policy from it.
 *
 * WHAT HAPPENS WHEN IT CANNOT BE READ, and why.
 *
 * The strict reading of the standard is that a crawler meeting a failed
 * robots.txt should assume it is disallowed everything. That is right for a
 * search engine indexing the whole web unattended; it is wrong here. This tool
 * runs because a person asked for an audit of one named site, and answering "we
 * audited nothing because a file timed out" would fail them for a reason that
 * has nothing to do with their website. Worse, it would look identical to a
 * site that genuinely blocks us.
 *
 * So a crawl continues when robots.txt cannot be read — and `enforced` is set
 * to FALSE, permanently and visibly, so nothing downstream can claim the rules
 * were honoured. The behaviour is permissive; the reporting is not.
 *
 * A 404 is a different thing entirely and is not a failure: the server told us
 * there are no rules. That is `absent`, and enforcement genuinely did apply.
 */
export async function fetchRobots(options: {
  site: URL;
  deadline: Deadline;
  fetchImpl?: SitemapFetcher;
  agentToken?: string;
}): Promise<RobotsPolicy> {
  const deadline = capDeadline(options.deadline, ROBOTS_BUDGET_MS);
  const fetchImpl = options.fetchImpl ?? createSitemapFetcher(MAX_ROBOTS_BYTES);

  // No time even to look. We do not know the rules, and must not pretend to.
  if (deadline.expired()) return permissive("unavailable", null);

  const result = await fetchImpl(`${options.site.origin}/robots.txt`, deadline);

  if (!result.ok) {
    return permissive(result.reason === "absent" ? "absent" : "unavailable", null);
  }

  if (result.body.trim() === "") return permissive("empty", result.body);

  return parseRobots(result.body, options.agentToken ?? CRAWLER_USER_AGENT_TOKEN);
}

/** robots.txt files are small; anything larger is not worth reading. */
const MAX_ROBOTS_BYTES = 512_000;
