/**
 * Turning a link found in someone's HTML into a URL we may safely queue.
 *
 * SEPARATE FROM url.ts ON PURPOSE. `normalizeUrl` handles what a PERSON typed:
 * it assumes https when no scheme is given and returns sentences a user reads.
 * A link discovered in markup is different — it is relative to the page it came
 * from, it is untrusted, there are thousands of them, and nobody reads the
 * reason one was rejected. So this file resolves against a base, returns a
 * machine-readable rejection, and never guesses.
 *
 * TWO ADDRESSES COME OUT OF ONE LINK, and the distinction matters:
 *
 *   url  what we would actually FETCH. Kept as close to what the site linked
 *        as safety allows, because the server decides what a URL means.
 *
 *   key  what we compare for DE-DUPLICATION. More aggressively canonical:
 *        scheme dropped, "www." collapsed, trailing slash removed, query
 *        parameters sorted. Two links that are certainly the same page
 *        produce the same key.
 *
 * Keeping them apart means we can recognise `/about/?b=2&a=1` and `/about?a=1&b=2`
 * as one page without ever fetching an address the site did not publish.
 *
 * NOTHING HERE FETCHES. These are pure functions, which is why they can be
 * tested exhaustively — and why the SSRF checks stay where they already are, in
 * `fetchPage`, which validates every hostname on every redirect hop.
 */

/**
 * The longest link we will queue.
 *
 * 2048 is the practical browser limit. Beyond it we are almost certainly
 * looking at a generated tracking URL or a loop, and a crawl frontier that
 * accepts unbounded strings is a memory problem waiting to happen.
 */
export const MAX_URL_LENGTH = 2048;

/**
 * Query parameters that identify a marketing campaign rather than a page.
 *
 * Stripped so `/pricing?utm_source=twitter` and `/pricing` are recognised as
 * one page rather than crawled twice. Deliberately a short, well-known list:
 * a parameter we do not recognise might genuinely select different content,
 * and crawling the same page twice is a smaller mistake than missing a page.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
]);

/** Why a discovered link cannot be queued. */
export type CrawlUrlRejection =
  /** The href was empty or whitespace, so it names no new page. */
  | "empty"
  /** It could not be parsed as a URL, even relative to its page. */
  | "malformed"
  /** Not http or https — `javascript:`, `mailto:`, `data:`, `file:` and friends. */
  | "unsupported-scheme"
  /** A hostname with no dot: "localhost", "intranet", a machine name. */
  | "dotless-host"
  /** Longer than MAX_URL_LENGTH. */
  | "too-long";

export type CrawlUrlResult =
  | { ok: true; url: URL; key: string }
  | { ok: false; reason: CrawlUrlRejection };

/**
 * Resolves one discovered link and produces its fetch address and dedup key.
 *
 * `base` is the page the link was found on — the address relative links are
 * relative to. Pass the page's FINAL url, after redirects, or relative links
 * resolve against a page that redirected elsewhere.
 */
export function normalizeCrawlUrl(href: string, base: URL | string): CrawlUrlResult {
  const trimmed = href.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: "too-long" };

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  /*
   * The single most important line in this file.
   *
   * `javascript:`, `data:`, `file:`, `mailto:` and every other scheme stops
   * here, before anything is queued. fetchPage would refuse them too, but a
   * frontier full of addresses we can never fetch is its own problem.
   */
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported-scheme" };
  }

  // No dot means a machine name rather than a public site. The SSRF check in
  // fetchPage catches these as well; rejecting here keeps them out of the queue.
  if (!url.hostname.includes(".")) {
    return { ok: false, reason: "dotless-host" };
  }

  /*
   * Credentials are dropped rather than carried.
   *
   * A link like `https://user:pass@example.com/` would otherwise send those
   * credentials on our behalf. We are auditing a site, not authenticating to
   * it, and a crawler that logs in is doing something nobody asked for.
   */
  url.username = "";
  url.password = "";

  // Fragments are a browser-only concept and never reach the server, so two
  // links differing only by fragment are the same request.
  url.hash = "";

  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
  }

  // Re-check length: resolving a relative link against a long base can grow it.
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, reason: "too-long" };

  return { ok: true, url, key: dedupKey(url) };
}

/**
 * The address two links must share to be the same page.
 *
 * Canonical in ways the server cannot reasonably disagree with:
 *
 *   scheme dropped     a site linking to itself over http and https means one
 *                      page; fetchPage already handles the redirect between them
 *   "www." collapsed   www.example.com and example.com are the same site
 *   port normalised    :443 and :80 are already dropped by URL itself
 *   trailing slash     /about/ and /about are one page, except the root "/"
 *   params sorted      ?a=1&b=2 and ?b=2&a=1 are one request
 *   path tidied        /a//b and /a/b are one page, and /%61 is /a — see
 *                      pathForKey, which explains what is deliberately NOT
 *                      decoded and why
 *
 * Path CASE is deliberately preserved: /About and /about are different files
 * on most servers, and merging them would silently skip a page.
 */
export function dedupKey(url: URL): string {
  // Sorted for comparison only. The URL we fetch keeps its original order,
  // because a server is entitled to care even though almost none do.
  const params = [...url.searchParams.entries()].sort(([a], [b]) =>
    a === b ? 0 : a < b ? -1 : 1,
  );
  const query = params.length === 0
    ? ""
    : "?" + params.map(([k, v]) => `${k}=${v}`).join("&");

  let path = pathForKey(url.pathname);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // The host part is `siteKey` itself rather than a second copy of the same
  // rules. Two pages on one site must always agree about which site that is —
  // if these ever disagreed, the crawler could treat an address as same-site
  // and simultaneously as a page it had never seen.
  return `${siteKey(url)}${path}${query}`;
}

/**
 * Characters that mean themselves, encoded or not.
 *
 * RFC 3986 calls these unreserved and says plainly that percent-encoding them
 * changes nothing: `/%61` and `/a` are the same path, to every server. So the
 * key decodes them and two links written differently become one page.
 *
 * EVERYTHING ELSE IS LEFT ALONE, and that is the important half. `%2F` is an
 * encoded slash and is NOT a path separator — a server that receives it sees
 * one path segment containing a slash, not two segments. Decoding it would
 * invent a directory boundary and could merge two genuinely different pages.
 * The same caution covers `%20`, `%3F` and every encoded byte of a non-ASCII
 * character: unrecognised is left exactly as it arrived.
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * The path, in the form two links must share to be one page.
 *
 * FOR THE KEY ONLY. The address actually fetched is never touched by this —
 * it stays as the site published it, because a server is entitled to care
 * about details we consider cosmetic, and a crawler that rewrites addresses
 * before requesting them asks for pages nobody linked to.
 *
 * Two changes, both of them things a server cannot reasonably disagree with:
 *
 *   /a//b -> /a/b    repeated separators are one separator. A site whose
 *                    template joins a base ending in "/" with a path starting
 *                    "/" produces these by accident, and without this the same
 *                    page is crawled twice and counted twice — which then
 *                    shows up in a report as "2 of 20 pages" when it is one.
 *   /%61  -> /a      an unreserved character decoded to itself.
 *
 * Percent-escapes that survive are upper-cased, because `%2f` and `%2F` are
 * the same escape and only one of them can be the key.
 */
export function pathForKey(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");

  return collapsed.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED.test(character) ? character : escape.toUpperCase();
  });
}

/**
 * The identity of a site, for deciding what counts as "the same site".
 *
 * Only the literal leading "www." label is removed. `www.blog.example.com`
 * becomes `blog.example.com`, NOT `example.com` — those are different sites and
 * merging them would send the crawler somewhere it was not asked to go.
 *
 * THE PORT IS PART OF THE IDENTITY, because a different port is a different
 * server. `example.com:8080` is routinely a staging copy, an admin panel or an
 * unrelated application that happens to share a hostname, and auditing one
 * while reporting on the other would be describing the wrong software.
 *
 * A DEFAULT port is not, though, and that distinction is free: the URL parser
 * drops `:443` from an https address and `:80` from an http one before we ever
 * see them, so `https://example.com:443` and `https://example.com` arrive here
 * identical. What is left is only ever a port someone chose deliberately.
 *
 * The SCHEME stays absent from the identity. A site that links to itself over
 * http still means itself, and fetchPage already resolves the redirect between
 * them. One consequence follows from the two rules together: because default
 * ports vanish, `https://example.com` and `http://example.com` are one site,
 * while `https://example.com:8080` and `http://example.com:8080` are also one
 * site as each other — and neither is the first.
 */
export function siteKey(url: URL | string): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const host = collapseWww(parsed.hostname.toLowerCase());
  return parsed.port === "" ? host : `${host}:${parsed.port}`;
}

function collapseWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

/**
 * Whether a discovered URL belongs to the site being audited.
 *
 * Exact host match after collapsing "www.", so:
 *
 *   example.com      ≡  www.example.com          same site
 *   example.com      ≢  blog.example.com         a subdomain is its own site
 *   example.com      ≢  example.co.uk            different site
 *   example.com      ≢  evil.com/example.com     different site
 *
 * Subdomains are excluded on purpose. A blog or shop on its own subdomain is
 * usually a separate property with separate owners, and wandering onto it
 * without being asked is exactly the behaviour that gets a crawler blocked.
 *
 * Scheme is ignored: a site linking to itself over http still means itself.
 */
export function isSameSite(candidate: URL | string, site: URL | string): boolean {
  try {
    return siteKey(candidate) === siteKey(site);
  } catch {
    return false;
  }
}

/** A set of pages already seen, compared by dedup key rather than by string. */
export interface UrlSet {
  /** Records a URL. Returns true if it had not been seen before. */
  add(url: URL | string): boolean;
  has(url: URL | string): boolean;
  readonly size: number;
}

/**
 * Remembers which pages a crawl has already met.
 *
 * Compares by `dedupKey`, so `/about`, `/about/`, `//about?utm_source=x` and
 * `HTTPS://WWW.example.com/about` are one entry rather than four — which is
 * what stops a crawl looping between two pages that link to each other.
 *
 * A URL that cannot be parsed is refused rather than silently treated as new,
 * so a malformed link can never be queued repeatedly.
 */
export function createUrlSet(): UrlSet {
  const keys = new Set<string>();

  const keyFor = (url: URL | string): string | null => {
    try {
      return dedupKey(typeof url === "string" ? new URL(url) : url);
    } catch {
      return null;
    }
  };

  return {
    add(url) {
      const key = keyFor(url);
      if (key === null) return false;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    has(url) {
      const key = keyFor(url);
      return key === null ? false : keys.has(key);
    },
    get size() {
      return keys.size;
    },
  };
}
