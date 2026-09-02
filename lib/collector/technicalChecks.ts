// The .ts extension is required so Node can run the unit tests directly;
// Next.js resolves it the same way.
import { safeFetch } from "./safety.ts";
import type { TechnicalData } from "@/lib/types";

const TIMEOUT_MS = 8_000;
const USER_AGENT = "SkybookAuditBot/1.0 (+website audit tool)";

/** robots.txt files are small; anything larger is not worth reading. */
const MAX_ROBOTS_BYTES = 512_000;

/**
 * Checks the site-level files search engines look for.
 *
 * These live at fixed addresses (/robots.txt, /sitemap.xml) rather than in the
 * page's HTML, so they need their own requests.
 *
 * The hostname was already safety-checked before the main page was fetched,
 * and we only build URLs on that same origin — so no new address is being
 * reached that wasn't already approved.
 */
export async function runTechnicalChecks(pageUrl: string): Promise<TechnicalData> {
  const origin = new URL(pageUrl).origin;

  const robots = await fetchRobotsTxt(`${origin}/robots.txt`);

  // A sitemap can be declared inside robots.txt. If it isn't, check the
  // conventional location before concluding there isn't one.
  const sitemapFromRobots = robots.text ? findSitemapDirective(robots.text) : null;
  const sitemapUrl =
    sitemapFromRobots ?? (await findDefaultSitemap(`${origin}/sitemap.xml`));

  return {
    robotsTxtFound: robots.found,
    robotsBlocksEverything: robots.text ? blocksEveryCrawler(robots.text) : false,
    sitemapUrl,
  };
}

async function fetchRobotsTxt(url: string): Promise<{ found: boolean; text: string | null }> {
  try {
    // safeFetch, not fetch: a site can redirect /robots.txt anywhere it likes,
    // including at a private address. Every hop is safety-checked.
    const response = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Many sites answer 404 here, which simply means "no robots.txt".
    if (!response || !response.ok) return { found: false, text: null };

    /*
     * Some sites serve their homepage for any unknown path, so a "robots.txt"
     * that is actually HTML means there is no real robots.txt.
     */
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("html")) return { found: false, text: null };

    const text = await readCapped(response, MAX_ROBOTS_BYTES);
    if (text === null) return { found: false, text: null };

    return { found: true, text };
  } catch {
    return { found: false, text: null };
  }
}

/**
 * Whether robots.txt tells every crawler to stay off the whole site.
 *
 * We only look at the `User-agent: *` group, since a rule aimed at one
 * specific crawler doesn't block search engines generally.
 *
 * Two details the format requires:
 *
 * 1. Consecutive User-agent lines share the rules that follow them, so
 *      User-agent: *
 *      User-agent: Googlebot
 *      Disallow: /
 *    blocks everyone. Treating each line as starting a fresh group would
 *    miss this.
 *
 * 2. An `Allow:` rule alongside `Disallow: /` carves out an exception, so the
 *    site is not entirely blocked.
 */
export function blocksEveryCrawler(robotsTxt: string): boolean {
  let inWildcardGroup = false;
  let lastLineWasUserAgent = false;
  let sawDisallowAll = false;
  let sawAllowInGroup = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    // Strip comments and surrounding space.
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // A User-agent line directly after another one joins the same group
      // rather than starting a new one.
      inWildcardGroup = lastLineWasUserAgent
        ? inWildcardGroup || value === "*"
        : value === "*";
      lastLineWasUserAgent = true;
      if (!inWildcardGroup) {
        sawDisallowAll = false;
        sawAllowInGroup = false;
      }
      continue;
    }

    lastLineWasUserAgent = false;
    if (!inWildcardGroup) continue;

    if (field === "disallow" && value === "/") sawDisallowAll = true;
    // "Allow:" with an empty value means nothing; any real path is an exception.
    if (field === "allow" && value.length > 0) sawAllowInGroup = true;
  }

  return sawDisallowAll && !sawAllowInGroup;
}

/** Reads a `Sitemap:` line from robots.txt, if there is one. */
export function findSitemapDirective(robotsTxt: string): string | null {
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const match = line.match(/^sitemap\s*:\s*(\S+)/i);
    if (match) return match[1];
  }
  return null;
}

/** Checks whether the conventional /sitemap.xml exists. */
async function findDefaultSitemap(url: string): Promise<string | null> {
  try {
    // HEAD asks only "does this exist?" without downloading the file, which
    // can be large. Not every server supports it, so fall back to GET.
    let response = await safeFetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // 405 Method Not Allowed / 501 Not Implemented mean "we don't do HEAD",
    // not "no sitemap" — ask again properly before concluding it's absent.
    if (!response || response.status === 405 || response.status === 501) {
      response = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }

    if (!response || !response.ok) return null;

    // Again, a site serving HTML here has no real sitemap.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("html")) return null;

    return url;
  } catch {
    return null;
  }
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
