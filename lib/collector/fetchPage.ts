// The .ts extension is required so Node can run the unit tests directly;
// Next.js resolves it the same way.
import { normalizeUrl } from "./url.ts";
import { checkHostnameIsPublic } from "./safety.ts";
import type { CertificateProblem, UptimeCheck } from "@/lib/types";

export type { CertificateProblem };

/** How long we'll wait for any single request. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Total time budget for the whole operation, including every redirect.
 * Without this, a chain of slow redirects could take 6 x 10s = a minute.
 */
const TOTAL_TIMEOUT_MS = 20_000;

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
  /**
   * Whether the page we ended up reading was served over HTTPS.
   * Step 6's severity rules use this — a site with no HTTPS is a critical finding.
   */
  servedOverHttps: boolean;
  /**
   * True when we tried HTTPS first, couldn't connect, and succeeded over
   * plain HTTP instead. Strong evidence the site has no working HTTPS at all.
   */
  httpsUnavailable: boolean;
  /**
   * Set when the HTTPS attempt failed because of a certificate problem, but
   * the page loaded over plain HTTP. Without carrying this forward we would
   * silently lose a critical finding — the audit would report a working site
   * and never mention that its certificate is broken.
   */
  certificateProblem?: CertificateProblem;
  /** The Content-Type header the server sent, if any. */
  contentType: string | null;
  uptime: UptimeCheck;
}

export type FetchPageResult =
  | { ok: true; page: FetchedPage }
  /**
   * `uptime` is null when we never got far enough to measure anything — a bad
   * address, or one the safety check refused. Reporting "offline" there would
   * be claiming a measurement we never took.
   */
  | {
      ok: false;
      reason: string;
      uptime: UptimeCheck | null;
      certificateProblem?: CertificateProblem;
    };

/**
 * Works out what actually went wrong from Node's error code.
 *
 * Without this, every failure reads "could not connect" — which is wrong and
 * unhelpful when the truth is "the certificate expired three weeks ago".
 */
export function classifyConnectionError(error: unknown): {
  reason: string;
  certificateProblem?: CertificateProblem;
} {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { reason: "The website took too long to respond." };
  }

  // Node puts the real network error in `cause`.
  const code =
    error instanceof Error && error.cause && typeof error.cause === "object"
      ? (error.cause as { code?: string }).code
      : undefined;

  switch (code) {
    case "CERT_HAS_EXPIRED":
      return {
        reason: "The website's security certificate has expired.",
        certificateProblem: "expired",
      };
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return {
        reason: "The website's security certificate is self-signed, so browsers will not trust it.",
        certificateProblem: "self-signed",
      };
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return {
        reason: "The website's security certificate was issued for a different address.",
        certificateProblem: "wrong-hostname",
      };
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return {
        reason: "The website's security certificate could not be verified.",
        certificateProblem: "untrusted",
      };
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { reason: "That website address could not be found." };
    case "ECONNREFUSED":
      return { reason: "The website refused the connection." };
    case "ECONNRESET":
      return { reason: "The website closed the connection unexpectedly." };
    default:
      return { reason: "Could not connect to that website." };
  }
}

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
    return { ok: false, reason: normalized.reason, uptime: null };
  }

  const first = await attemptFetch(normalized.url, false);

  // If we *guessed* https and simply couldn't connect, the site may only
  // support plain http. Retrying tells us something worth knowing, rather
  // than reporting a site as unreachable when it is merely insecure.
  //
  // We only do this when the scheme was our guess. If the user explicitly
  // asked for https, we never quietly fall back to an unencrypted request.
  const shouldRetryOverHttp =
    !first.ok &&
    first.uptime === null &&
    normalized.schemeWasAssumed &&
    normalized.url.protocol === "https:";

  if (shouldRetryOverHttp) {
    const httpUrl = new URL(normalized.url.toString());
    httpUrl.protocol = "http:";
    // Pass along why HTTPS failed, so a broken certificate is still reported
    // even though we ended up reading the page over plain HTTP.
    const second = await attemptFetch(httpUrl, true, first.certificateProblem);
    // Only prefer the http result if it actually worked.
    if (second.ok) return second;
  }

  return first;
}

/** One attempt at fetching, following redirects from a given starting address. */
async function attemptFetch(
  startUrl: URL,
  httpsUnavailable: boolean,
  certificateProblem?: CertificateProblem,
): Promise<FetchPageResult> {
  let currentUrl = startUrl;
  const redirectChain: string[] = [currentUrl.toString()];
  const startedAt = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > TOTAL_TIMEOUT_MS) {
      return { ok: false, reason: "The website took too long to respond.", uptime: null };
    }

    // Every hop gets checked, not just the first.
    const safety = await checkHostnameIsPublic(currentUrl.hostname);
    if (!safety.safe) {
      return { ok: false, reason: safety.reason, uptime: null };
    }

    // Whichever is shorter: the per-request limit, or what's left of the budget.
    const remaining = Math.max(1, TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        // Don't let fetch follow redirects itself — we need to check each one.
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const classified = classifyConnectionError(error);
      return {
        ok: false,
        reason: classified.reason,
        certificateProblem: classified.certificateProblem,
        // Nothing responded, so there is no measurement to report.
        uptime: null,
      };
    }

    const serverResponseTimeMs = Date.now() - startedAt;

    /*
     * The server answered, so the site IS online — whatever the status code.
     *
     * A 404 or 500 means the server is up and talking to us; it just doesn't
     * like this particular request. Recording those as "offline" would make
     * the uptime history in Phase 8 plainly wrong.
     */
    const uptime: UptimeCheck = {
      isOnline: true,
      statusCode: response.status,
      serverResponseTimeMs,
    };

    // A 3xx status with a Location header means "the page moved here".
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, reason: "The website sent an incomplete redirect.", uptime };
      }

      // A redirect can be relative ("/home"), so resolve it against the
      // current address to get a complete one.
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return {
          ok: false,
          reason: "The website redirected to an address we couldn't read.",
          uptime,
        };
      }

      if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
        return {
          ok: false,
          reason: "The website redirected somewhere that isn't a web page.",
          uptime,
        };
      }

      currentUrl = nextUrl;
      redirectChain.push(currentUrl.toString());
      continue; // loop round; the new address gets safety-checked too
    }

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
      return { ok: false, reason: "That address doesn't point to a web page.", uptime };
    }

    const body = await readCapped(response);
    if (body === null) {
      return { ok: false, reason: "That page could not be read in full.", uptime };
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
        html: decodeHtml(body, contentType),
        headers,
        servedOverHttps: currentUrl.protocol === "https:",
        httpsUnavailable,
        certificateProblem,
        contentType: contentType || null,
        uptime,
      },
    };
  }

  return { ok: false, reason: "That website redirected too many times.", uptime: null };
}

/**
 * Reads the response body, stopping if it exceeds MAX_BYTES.
 *
 * We read it in pieces rather than all at once, so an enormous file gets
 * abandoned early instead of being loaded into memory first.
 */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);

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
  return merged;
}

/**
 * Turns raw bytes into text using the page's own character encoding.
 *
 * Most pages are UTF-8, but not all. Assuming UTF-8 for a page written in,
 * say, ISO-8859-1 turns accented characters into nonsense — and that nonsense
 * would end up quoted in the audit report as if it were the real page title.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1];

  // If the header doesn't say, look for <meta charset="..."> near the top of
  // the document. Reading the first bytes as Latin-1 is safe for this, since
  // the tag itself is always plain ASCII.
  const fromMeta = fromHeader
    ? undefined
    : new TextDecoder("iso-8859-1")
        .decode(bytes.subarray(0, 2048))
        .match(/<meta[^>]+charset=["']?([^;"'\s/>]+)/i)?.[1];

  const label = fromHeader ?? fromMeta ?? "utf-8";

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An encoding name we don't recognise — fall back rather than fail.
    return new TextDecoder("utf-8").decode(bytes);
  }
}
