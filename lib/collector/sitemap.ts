/**
 * Reading a site's own list of its pages.
 *
 * A sitemap is the one place a website states, in its own words, which pages it
 * wants found. Following links discovers what is reachable by navigation; a
 * sitemap adds the pages that are not — a product buried six filters deep, an
 * article only reachable from a search box. For an audit that claims to cover a
 * site, missing those is missing the point.
 *
 * WHY NOT fetchPage
 *
 * `fetchPage` is the boundary for PAGES, and it refuses anything whose
 * content-type is not HTML — a sitemap is XML, so it comes back as
 * NOT_A_WEB_PAGE. Widening it to accept XML would weaken the one function whose
 * entire job is "give me a web page, safely", and would put XML bodies into a
 * type built around `FetchedPage`.
 *
 * So sitemaps go through `safeFetch` instead — the OTHER existing boundary in
 * this codebase, already used for exactly this kind of request: robots.txt and
 * the sitemap HEAD check in `technicalChecks`. It does the same thing that
 * matters, and does it per hop: scheme check, `checkHostnameIsPublic`, and
 * `redirect: "manual"` so a site cannot redirect us somewhere private. No new
 * HTTP client was introduced and no safety logic is duplicated here.
 *
 * NOTHING HERE IS A FINDING. A missing sitemap, an unreachable one, a malformed
 * one — none of them are faults this file reports. `technicalChecks` already
 * measures whether a sitemap EXISTS, which is the audit-facing question. This
 * file only asks it for addresses, and silence is a perfectly ordinary answer.
 */
import * as cheerio from "cheerio";
import { safeFetch } from "./safety.ts";
import { capDeadline, type Deadline } from "./deadline.ts";
import { dedupKey, isSameSite, normalizeCrawlUrl } from "./crawlUrl.ts";

const USER_AGENT = "SkybookAuditBot/1.0 (+website audit tool)";

/**
 * How far sitemap discovery may go before it stops.
 *
 * A sitemap index may reference sitemaps, which may reference more. Left alone
 * that is unbounded work directed entirely by the audited site — so every one
 * of these is a hard stop, and reaching any of them ends discovery quietly
 * rather than failing the crawl.
 */
export interface SitemapLimits {
  /** How many sitemap FILES may be downloaded, index files included. */
  maxFiles: number;
  /** How many page addresses may be collected in total. */
  maxUrls: number;
  /** The largest single sitemap file we will read. */
  maxBytes: number;
  /** The whole of sitemap discovery, so it cannot spend the crawl's budget. */
  budgetMs: number;
}

export const DEFAULT_SITEMAP_LIMITS: SitemapLimits = {
  // 20 files covers a large real site: an index plus per-section sitemaps.
  maxFiles: 20,
  // Well past maxQueueSize, so the frontier's limit is what actually decides
  // how much gets crawled — this only stops the array itself running away.
  maxUrls: 10_000,
  maxBytes: 5_000_000,
  // Sitemaps are worth a slice of the crawl, never the whole of it.
  budgetMs: 20_000,
};

/** What one sitemap file said. */
export interface ParsedSitemap {
  /** Addresses of pages, from `<url><loc>`. */
  urls: string[];
  /** Addresses of further sitemap files, from `<sitemap><loc>`. */
  sitemaps: string[];
  /**
   * True when the file named more pages than `maxUrls` allowed us to keep.
   *
   * Reported rather than swallowed, because it is the difference between "this
   * is the site's list" and "this is part of the site's list" — and a crawl
   * that cannot tell those apart will eventually claim a whole-site audit it
   * did not perform.
   */
  truncated: boolean;
}

/** Why sitemap discovery stopped. Only one value means it read everything. */
export type SitemapStopReason =
  /** The sitemaps ran out. The ONLY value that means discovery was complete. */
  | "completed"
  /**
   * A sitemap we knew about could not be read.
   *
   * NOT the same as a site having no sitemap — that is a finished, successful
   * discovery. This means a file exists, or may exist, and a timeout or a 503
   * stopped us finding out what was in it. There are pages we may never have
   * heard of, so the discovery is not complete however tidily the rest of it
   * went.
   */
  | "unavailable"
  /** Hit `maxFiles`, so sitemaps were referenced and never read. */
  | "max-files"
  /** Hit `maxUrls`, so pages were listed and never collected. */
  | "max-urls"
  /** Discovery's own slice of time ran out. */
  | "budget"
  /** The surrounding crawl or audit ran out of time, which is not our limit. */
  | "deadline";

/**
 * How sitemap discovery went, as opposed to what it found.
 *
 * Kept separate from the page crawl's own outcome because they fail
 * independently: a crawl can visit every page it knew about — a perfectly
 * complete page crawl — while never having learned about a section of the site
 * whose sitemap we ran out of time to read. Reporting that as a full audit is
 * exactly the claim this project refuses to make.
 */
export interface SitemapDiscovery {
  /** Whether discovery ran at all. False when the caller turned it off. */
  attempted: boolean;
  /**
   * True when discovery left nothing unread.
   *
   * Vacuously true when `attempted` is false: discovery that was never asked
   * to read anything has left nothing unread. Whether a crawl without sitemaps
   * can be called whole-site is a separate question, and `attempted` is the
   * field that answers it.
   */
  complete: boolean;
  stoppedBecause: SitemapStopReason;
}

/** The state for a crawl that was told not to look at sitemaps. */
export const SITEMAP_DISCOVERY_SKIPPED: SitemapDiscovery = {
  attempted: false,
  complete: true,
  stoppedBecause: "completed",
};

export interface SitemapDiscoveryResult {
  /** Page addresses, raw, in the order the sitemaps listed them. */
  urls: string[];
  discovery: SitemapDiscovery;
}

/**
 * Reads the addresses out of one sitemap document.
 *
 * Pure, and deliberately forgiving. A `<loc>` is interpreted by WHAT CONTAINS
 * IT: inside `<url>` it is a page, inside `<sitemap>` it is another sitemap
 * file. That distinction is the whole difference between a sitemap and a
 * sitemap index, and getting it backwards would mean either crawling index
 * files as if they were pages or trying to parse pages as XML.
 *
 * Namespace prefixes are tolerated. Plenty of real sitemaps are written
 * `<sitemap:urlset><sitemap:url><sitemap:loc>`, and a parser that only
 * recognised the unprefixed form would silently read those as empty.
 *
 * Anything that is not a sitemap — an HTML error page, JSON, gibberish —
 * simply yields nothing. That is not an error; it is the common case of a
 * server answering every unknown address with its homepage.
 */
export function parseSitemap(xml: string, limits: SitemapLimits): ParsedSitemap {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  let truncated = false;

  // xmlMode, because HTML parsing rules would restructure the document —
  // and a sitemap is XML, where <loc> is not a known HTML element.
  const $ = cheerio.load(xml, { xmlMode: true });

  for (const node of $("*").toArray()) {
    // Text, comments and the document node are not elements and have no name.
    if (node.type !== "tag") continue;
    if (localName(node.name) !== "loc") continue;

    const address = $(node).text().trim();
    if (address === "") continue;

    // A <loc> at the top of the document has the document itself as its
    // parent, which is not an element and names no container.
    const parent = node.parent;
    const container = parent !== null && parent.type === "tag" ? localName(parent.name) : "";

    if (container === "sitemap") {
      sitemaps.push(address);
    } else if (container === "url") {
      if (urls.length < limits.maxUrls) urls.push(address);
      else truncated = true;
    }
    // A <loc> somewhere else is not something this format defines, so it is
    // ignored rather than guessed at.
  }

  return { urls, sitemaps, truncated };
}

/** `sitemap:loc` and `loc` are the same element; the prefix is decoration. */
function localName(tagName: string): string {
  const colon = tagName.indexOf(":");
  return (colon === -1 ? tagName : tagName.slice(colon + 1)).toLowerCase();
}

/** Reads every `Sitemap:` line in a robots.txt, in order. */
export function findAllSitemapDirectives(robotsTxt: string): string[] {
  const found: string[] = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const match = line.match(/^sitemap\s*:\s*(\S+)/i);
    if (match) found.push(match[1]);
  }
  return found;
}

/**
 * Why a site-level text file could not be read.
 *
 * The distinction matters for robots.txt and only for robots.txt: a 404 is the
 * server telling us plainly that there are no rules, while a timeout tells us
 * nothing at all. Treating those alike would let us claim we had honoured rules
 * we never managed to read.
 *
 * Optional, so a stub that answers a plain `{ ok: false }` still type-checks —
 * and is read as `unavailable`, the honest reading of "we do not know".
 */
export type SitemapFetchFailure = "absent" | "unavailable";

export type SitemapFetchResult =
  | { ok: true; body: string }
  | { ok: false; reason?: SitemapFetchFailure };

/**
 * Downloads one of a site's text files — a sitemap, or robots.txt.
 *
 * Injectable so tests never touch the network; the production value is the one
 * below, and it is the only thing in this file that makes a request.
 */
export type SitemapFetcher = (url: string, deadline: Deadline) => Promise<SitemapFetchResult>;

export function createSitemapFetcher(maxBytes: number): SitemapFetcher {
  return async (url, deadline) => {
    if (deadline.expired()) return { ok: false, reason: "unavailable" };

    try {
      // safeFetch, not fetch: a site may redirect its sitemap anywhere,
      // including at a private address. Every hop is checked.
      const response = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml" },
        signal: deadline.signal(),
      });

      // Nothing came back at all: a timeout, a refused connection, or an
      // address the safety check declined. We learned nothing.
      if (!response) return { ok: false, reason: "unavailable" };

      // The server answered and said there is no such file. That IS knowledge.
      if (response.status === 404 || response.status === 410) {
        return { ok: false, reason: "absent" };
      }

      if (!response.ok) return { ok: false, reason: "unavailable" };

      /*
       * A server answering with HTML has no sitemap here — many serve their
       * homepage for any unknown address. The same reasoning `technicalChecks`
       * already applies to robots.txt and to the sitemap HEAD check, and it is
       * the same conclusion as a 404: the file does not exist.
       */
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("html")) return { ok: false, reason: "absent" };

      const body = await readCapped(response, maxBytes);
      // Too large, or the body failed mid-read: we did not get to see it.
      return body === null ? { ok: false, reason: "unavailable" } : { ok: true, body };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };
}

/** Reads a response body up to a byte limit, returning null if it exceeds it. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

export interface SitemapDiscoveryOptions {
  /** The site being audited. Defines the origin to look in, and the boundary. */
  site: URL;
  /** The crawl's clock. Discovery takes a capped slice of it, never all of it. */
  deadline: Deadline;
  limits?: Partial<SitemapLimits>;
  fetchImpl?: SitemapFetcher;
  /**
   * robots.txt, when the caller has already read it.
   *
   * The crawler fetches robots.txt for its rules before any of this runs, and
   * that same file carries the `Sitemap:` lines — so passing it here means one
   * request instead of two for the same file. Leaving it out says "not read
   * yet, fetch it".
   *
   * A DISCRIMINATED UNION, so the states cannot be mixed up: only "found"
   * carries text, and "absent" and "unavailable" cannot pretend to. That
   * distinction matters here as much as anywhere — a robots.txt we could not
   * read might have declared sitemaps we will now never look for, so it makes
   * discovery incomplete, while one that genuinely does not exist does not.
   */
  robots?: { status: "found"; text: string } | { status: "absent" | "unavailable" };
}

/**
 * Every page address the site's own sitemaps declare.
 *
 * Walks robots.txt for `Sitemap:` lines, then /sitemap.xml, then any sitemap
 * those reference, breadth-first, until one of the limits stops it.
 *
 * READING robots.txt IS NOT ENFORCING IT. All that is taken from the file is
 * the `Sitemap:` directive — a signpost, and the only reliable way to find
 * sitemaps that do not live at the conventional address. `Disallow` is not
 * parsed, not honoured, and not consulted; that is a separate stage.
 *
 * The addresses returned are RAW, exactly as the sitemap wrote them. They have
 * not been normalised, checked for scheme, or judged same-site — the caller
 * puts them through the same frontier gate every other discovered address goes
 * through, so a sitemap gets no privilege that a link in the page body lacks.
 */
export async function discoverSitemapUrls(
  options: SitemapDiscoveryOptions,
): Promise<SitemapDiscoveryResult> {
  const limits: SitemapLimits = { ...DEFAULT_SITEMAP_LIMITS, ...options.limits };
  const fetchImpl = options.fetchImpl ?? createSitemapFetcher(limits.maxBytes);
  const deadline = capDeadline(options.deadline, limits.budgetMs);

  const origin = options.site.origin;
  const found: string[] = [];

  /*
   * Which clock ran out, when one does.
   *
   * `deadline` is our own budget capped inside the crawl's, so an expiry could
   * be either. Asking the OUTER clock separates them: if it has expired too,
   * the crawl ran out of time and discovery was merely caught by it; if it has
   * not, discovery spent the slice it was given. Merging the two would hide
   * which limit needs raising.
   */
  const expiryReason = (): SitemapStopReason =>
    options.deadline.expired() ? "deadline" : "budget";

  let stoppedBecause: SitemapStopReason | null = null;

  /*
   * Sticky, because it changes the meaning of the whole result.
   *
   * Set the moment any sitemap we knew about could not be read. The walk
   * carries on — whatever the other sitemaps hold is still worth having — but
   * the discovery can never afterwards be called complete, because there may
   * be a section of the site inside the file we failed to read.
   *
   * Kept apart from `stoppedBecause` so that a limit which actually HALTED the
   * walk still gets to name itself. Both mean incomplete, so no truth is lost
   * either way; this only decides which reason is the more useful one to show.
   */
  let sawUnavailable = false;

  const outcome = (): SitemapDiscoveryResult => {
    const reason: SitemapStopReason =
      stoppedBecause ?? (sawUnavailable ? "unavailable" : "completed");

    return {
      urls: found,
      discovery: {
        attempted: true,
        // The single line that decides whether a crawl may call itself whole.
        complete: reason === "completed",
        stoppedBecause: reason,
      },
    };
  };

  /*
   * Which sitemap files have already been dealt with.
   *
   * This is what makes a loop impossible: a sitemap index that references
   * itself, or two that reference each other, are each fetched once and then
   * recognised. `maxFiles` is the second line of defence behind it, for a site
   * that generates an endless supply of DISTINCT index files.
   */
  const seen = new Set<string>();
  const queue: string[] = [];

  /** Queues a sitemap file, if it is one we are willing to fetch. */
  const considerSitemap = (address: string, base: URL): void => {
    const resolved = normalizeCrawlUrl(address, base);
    if (!resolved.ok) return;

    /*
     * A SITEMAP CANNOT SEND US TO ANOTHER DOMAIN.
     *
     * Cross-domain sitemap references exist in the specification, unlocked by
     * proving ownership in Search Console. We are not Google and have proved
     * nothing, and "the file told us to" is not a reason to fetch a stranger's
     * server. Same-site or not at all — the same rule the page links obey.
     */
    if (!isSameSite(resolved.url, options.site)) return;

    const key = dedupKey(resolved.url);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(resolved.url.toString());
  };

  /*
   * Checked before the first request, not only between them.
   *
   * A crawl whose clock has already run out must make no request at all —
   * including this one. Relying on the fetcher to notice would make that
   * depend on which fetcher is in use, and the guarantee belongs here.
   */
  if (deadline.expired()) {
    stoppedBecause = expiryReason();
    return outcome();
  }

  /*
   * robots.txt is read ONLY for its Sitemap: lines.
   *
   * When the caller has already read the file — the crawler does, for its
   * rules — its text is passed in and no second request is made for it.
   */
  /*
   * robots.txt, read once — for its `Sitemap:` lines only.
   *
   * An UNREADABLE robots.txt makes discovery incomplete. It may have declared
   * sitemaps, and we will now never look for them, so we cannot claim to have
   * found everything the site publishes. A robots.txt that genuinely does not
   * exist declares nothing, and costs us nothing.
   */
  const robots =
    options.robots ??
    (await (async () => {
      const fetched = await fetchImpl(`${origin}/robots.txt`, deadline);
      if (fetched.ok) return { status: "found" as const, text: fetched.body };
      return { status: fetched.reason === "absent" ? ("absent" as const) : ("unavailable" as const) };
    })());

  if (robots.status === "found") {
    for (const declared of findAllSitemapDirectives(robots.text)) {
      considerSitemap(declared, options.site);
    }
  } else if (robots.status === "unavailable") {
    sawUnavailable = true;
  }

  // The conventional address is tried whether or not robots.txt named one:
  // plenty of sites have a sitemap and never declare it.
  considerSitemap(`${origin}/sitemap.xml`, options.site);

  let filesFetched = 0;

  while (queue.length > 0) {
    /*
     * A bound only counts as a stop if it actually left work undone — and
     * inside this loop the queue is not empty, so it always has. Each of these
     * means a sitemap we know about will never be read.
     */
    if (filesFetched >= limits.maxFiles) {
      stoppedBecause = "max-files";
      break;
    }
    if (found.length >= limits.maxUrls) {
      stoppedBecause = "max-urls";
      break;
    }
    if (deadline.expired()) {
      stoppedBecause = expiryReason();
      break;
    }

    const address = queue.shift();
    if (address === undefined) break;

    const result = await fetchImpl(address, deadline);
    filesFetched += 1;

    if (!result.ok) {
      /*
       * THE TWO FAILURES ARE NOT THE SAME, AND THIS IS THE WHOLE FIX.
       *
       * "absent" is a successful measurement: the server told us the file is
       * not there, so there is nothing in it we have missed and discovery may
       * still finish complete. A site with no sitemap must not be reported as
       * a site we failed to examine.
       *
       * Anything else — a timeout, a 503, a body too large — means the file
       * may exist and we do not know what is in it. There could be a whole
       * section of the site listed inside it that we will never hear about, so
       * discovery is not complete. Continuing to read the OTHER sitemaps is
       * still worthwhile; what changes is the claim made at the end.
       *
       * A failure with no stated reason counts as unavailable: "we do not
       * know" is the honest reading of an unexplained one.
       */
      if (result.reason !== "absent") sawUnavailable = true;
      continue;
    }

    const parsed = parseSitemap(result.body, limits);
    const base = new URL(address);

    // The file itself held more than we were allowed to keep.
    if (parsed.truncated) stoppedBecause = "max-urls";

    for (const url of parsed.urls) {
      if (found.length >= limits.maxUrls) {
        // There was another address and we did not take it. Precise, rather
        // than inferring truncation from the count reaching the cap — a site
        // with exactly maxUrls pages is complete, not truncated.
        stoppedBecause = "max-urls";
        break;
      }
      found.push(url);
    }

    // Nested indexes go through the same gate the top-level ones did.
    for (const nested of parsed.sitemaps) considerSitemap(nested, base);
  }

  return outcome();
}
