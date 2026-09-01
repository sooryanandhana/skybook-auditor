import { normalizeUrl } from "./url";
import { checkHostnameIsPublic } from "./safety";
import type { UptimeCheck } from "@/lib/types";

/** How long we'll wait for a website before giving up. */
const TIMEOUT_MS = 10_000;

/** How much HTML we'll read. Enough for any real page; stops a huge file hanging us. */
const MAX_BYTES = 5_000_000; // 5 MB

/** How many redirects to follow before assuming something is wrong. */
const MAX_REDIRECTS = 5;

/** Identifies this tool honestly to the sites we visit. */
const USER_AGENT = "SkybookAuditBot/1.0 (+website audit tool)";

/** A page we successfully downloaded. */
export interface FetchedPage {
  /** The address we ended up at, which differs from the input if it redirected. */
  finalUrl: string;
  /** Every address we passed through, starting with the one requested. */
  redirectChain: string[];
  /** The page's HTML source. */
  html: string;
  /** Response headers, lowercased. Used later for the security checks. */
  headers: Record<string, string>;
  uptime: UptimeCheck;
}

export type FetchPageResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; reason: string; uptime: UptimeCheck };

/** Uptime result for a site that never answered. */
const NO_RESPONSE: UptimeCheck = {
  isOnline: false,
  statusCode: null,
  responseTimeMs: null,
};

/**
 * Downloads a web page, safely.
 *
 * Redirects are followed one at a time rather than automatically, because
 * every new address has to pass the safety check too — a public URL is
 * allowed to redirect to a private one, and that's exactly the trick the
 * safety check exists to stop.
 */
export async function fetchPage(rawUrl: string): Promise<FetchPageResult> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason, uptime: NO_RESPONSE };
  }

  let currentUrl = normalized.url;
  const redirectChain: string[] = [currentUrl.toString()];
  const startedAt = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop gets checked, not just the first.
    const safety = await checkHostnameIsPublic(currentUrl.hostname);
    if (!safety.safe) {
      return { ok: false, reason: safety.reason, uptime: NO_RESPONSE };
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        // Don't let fetch follow redirects itself — we need to check each one.
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        ok: false,
        reason: timedOut
          ? "The website took too long to respond."
          : "Could not connect to that website.",
        uptime: NO_RESPONSE,
      };
    }

    const responseTimeMs = Date.now() - startedAt;

    // A 3xx status with a Location header means "the page moved here".
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          reason: "The website sent an incomplete redirect.",
          uptime: { isOnline: true, statusCode: response.status, responseTimeMs },
        };
      }

      // A redirect can be relative ("/home"), so resolve it against the
      // current address to get a complete one.
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return {
          ok: false,
          reason: "The website redirected to an address we couldn't read.",
          uptime: { isOnline: true, statusCode: response.status, responseTimeMs },
        };
      }

      redirectChain.push(currentUrl.toString());
      continue; // loop round; the new address gets safety-checked too
    }

    // Not a redirect, so this is the real response.
    const uptime: UptimeCheck = {
      isOnline: response.ok,
      statusCode: response.status,
      responseTimeMs,
    };

    if (!response.ok) {
      return {
        ok: false,
        reason: `The website responded with an error (${response.status}).`,
        uptime,
      };
    }

    // Make sure we got a web page, not a PDF or an image.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return {
        ok: false,
        reason: "That address doesn't point to a web page.",
        uptime,
      };
    }

    const html = await readCapped(response);
    if (html === null) {
      return { ok: false, reason: "That page is too large to audit.", uptime };
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      ok: true,
      page: {
        finalUrl: currentUrl.toString(),
        redirectChain,
        html,
        headers,
        uptime,
      },
    };
  }

  return {
    ok: false,
    reason: "That website redirected too many times.",
    uptime: NO_RESPONSE,
  };
}

/**
 * Reads the response body, stopping if it exceeds MAX_BYTES.
 *
 * We read it in pieces rather than all at once, so an enormous file gets
 * abandoned early instead of being loaded into memory first.
 */
async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
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
