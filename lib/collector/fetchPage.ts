// The .ts extension is required so Node can run the unit tests directly;
// Next.js resolves it the same way.
import { normalizeUrl } from "./url.ts";
import { checkHostnameIsPublic, releaseBody } from "./safety.ts";
import { createDeadline, type Deadline } from "./deadline.ts";
import { certificateProblemForCode } from "./sslChecks.ts";
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
  /**
   * Response headers, lowercased.
   *
   * Set-Cookie is NOT usable from here: when a server sends several, this
   * record keeps only one of them. Use `setCookieHeaders` instead.
   */
  headers: Record<string, string>;
  /**
   * Every Set-Cookie header, kept separately and in full.
   *
   * A response commonly sets several cookies, but flattening headers into a
   * plain object keeps only one — and not reliably the first. Since a cookie
   * missing its Secure or HttpOnly flag is exactly the kind of thing an audit
   * should report, they are collected properly here rather than being lost.
   */
  setCookieHeaders: string[];
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

/**
 * The reason given when a URL answered, but with something other than a page.
 *
 * A PDF, an image, a JSON feed. The server is healthy and the address is real —
 * it simply is not a web page, which is a different fact from "we could not
 * reach it". Named rather than written inline so a caller that needs to tell
 * those apart compares a symbol instead of an English sentence that someone
 * might one day reword.
 */
export const NOT_A_WEB_PAGE = "That address doesn't point to a web page.";

/**
 * The reason given when the server never said what it was sending.
 *
 * DELIBERATELY NOT `NOT_A_WEB_PAGE`, and that distinction is the whole point.
 * A response carrying `Content-Type: application/pdf` is a statement by the
 * server: this is not a page. A response carrying no Content-Type at all is
 * the absence of a statement, and the two must not produce the same sentence.
 *
 * The wording says what was measured — the server did not declare a type — and
 * what followed from it, rather than asserting anything about the address. The
 * page is not read, because reading an undeclared body as HTML would be
 * guessing; a browser sniffs, and this deliberately does not.
 *
 * Its own symbol, like NOT_A_WEB_PAGE, so a caller that needs to tell the two
 * apart compares a constant rather than an English sentence someone may
 * one day reword.
 */
export const UNDECLARED_CONTENT_TYPE =
  "The server did not say what kind of file this address returns, so it was not read as a web page.";

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
      /**
       * The addresses passed through before the failure, starting with the one
       * requested — present only when an HTTP response was actually received and
       * processed (a redirect that then 404'd, answered with non-HTML, sent an
       * incomplete redirect, or looped past the limit). So a report can still say
       * where the redirects led.
       *
       * ABSENT when nothing responded — a rejected URL, a DNS or connection
       * error, a timeout before any answer, or a hostname the safety check
       * refused. There is no walked chain to report in those cases, and a
       * refused hop is never disclosed here. It travels with `uptime`: where one
       * is present the other is, and where `uptime` is null this is absent.
       */
      redirectChain?: string[];
      certificateProblem?: CertificateProblem;
      /**
       * The address whose certificate failed, when one did.
       *
       * NOT ALWAYS THE ADDRESS ASKED FOR. A page may redirect to another host
       * before the connection fails, and the certificate that failed belongs
       * to the host that presented it. Anything that goes on to read that
       * certificate has to read it there, so the address travels with the
       * problem rather than being assumed.
       */
      certificateUrl?: string;
    };

/**
 * Why a certificate stopped the connection, one sentence per kind of problem.
 *
 * Keyed by the problem rather than the error code, so the sentence a user
 * reads can never name a different problem from the one the audit records.
 */
const CERTIFICATE_FAILURE_REASONS: Record<CertificateProblem, string> = {
  expired: "The website's security certificate has expired.",
  "self-signed": "The website's security certificate is self-signed, so browsers will not trust it.",
  "wrong-hostname": "The website's security certificate was issued for a different address.",
  untrusted: "The website's security certificate could not be verified.",
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

  /*
   * Certificate codes are classified by the certificate check's own function,
   * not a list kept here. This file used to keep one, and it fell behind:
   * a certificate whose issuer could not be found, or that was not valid yet,
   * was reported as "Could not connect to that website."
   */
  const certificateProblem = code ? certificateProblemForCode(code) : null;
  if (certificateProblem !== null) {
    return { reason: CERTIFICATE_FAILURE_REASONS[certificateProblem], certificateProblem };
  }

  switch (code) {
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
 * Puts an unsuccessful HTTP status into words.
 *
 * The distinction that matters: a site REFUSING our scanner is not a site that
 * is broken. 401, 403 and 429 all mean the server understood us perfectly and
 * declined — usually a firewall or bot protection. Calling that "an error"
 * would tell a salesperson their prospect's website is failing when visitors
 * can use it perfectly well.
 */
export function describeErrorStatus(status: number): string {
  if (status === 401) {
    return `The website requires a login (${status}), so its pages could not be checked. This is not a fault with the site.`;
  }
  if (status === 403) {
    return `The website refused our request (${status}). This usually means it blocks automated checks — it does not mean the site is broken for visitors.`;
  }
  if (status === 429) {
    return `The website asked us to slow down (${status}). It is limiting automated requests, not failing.`;
  }
  if (status >= 500) {
    return `The website's server reported a problem (${status}).`;
  }
  return `The website responded with an error (${status}).`;
}

/**
 * Downloads a web page, safely.
 *
 * Redirects are followed one at a time rather than automatically, because
 * every new address has to pass the safety check too — a public URL is
 * allowed to redirect to a private one, and that's exactly the trick the
 * safety check exists to stop.
 */
export async function fetchPage(
  rawUrl: string,
  /**
   * The audit's shared clock. When omitted, one is created just for this
   * fetch — so calling fetchPage on its own still cannot run forever.
   */
  deadline: Deadline = createDeadline(TOTAL_TIMEOUT_MS),
  /**
   * The most of one page body to read.
   *
   * Configurable so a caller that declares a response limit actually gets it.
   * The crawler passes its own `maxResponseBytes`; before this it could set
   * that value and be silently given the default instead — a limit the API
   * advertised and did not honour.
   */
  maxBytes: number = MAX_BYTES,
): Promise<FetchPageResult> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason, uptime: null };
  }

  const first = await attemptFetch(normalized.url, deadline, false, undefined, maxBytes);

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
    normalized.url.protocol === "https:" &&
    // The retry shares the same clock, so there is no point starting one with
    // nothing left. Previously the second attempt got a fresh 20 seconds,
    // which is how a single fetch could take forty.
    !deadline.expired();

  if (shouldRetryOverHttp) {
    const httpUrl = new URL(normalized.url.toString());
    httpUrl.protocol = "http:";
    // Pass along why HTTPS failed, so a broken certificate is still reported
    // even though we ended up reading the page over plain HTTP.
    const second = await attemptFetch(httpUrl, deadline, true, first.certificateProblem, maxBytes);
    // Only prefer the http result if it actually worked.
    if (second.ok) return second;
  }

  return first;
}

/** One attempt at fetching, following redirects from a given starting address. */
async function attemptFetch(
  startUrl: URL,
  deadline: Deadline,
  httpsUnavailable: boolean,
  certificateProblem?: CertificateProblem,
  maxBytes: number = MAX_BYTES,
): Promise<FetchPageResult> {
  let currentUrl = startUrl;
  const redirectChain: string[] = [currentUrl.toString()];
  const startedAt = Date.now();
  /*
   * The uptime from the most recent response, kept so a failure that happens
   * AFTER answers arrived can still report that the server was online. It stays
   * null until a response is received, so a failure before any answer (a
   * connection error, a refused hostname) correctly reports no measurement.
   */
  let lastUptime: UptimeCheck | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (deadline.expired()) {
      return { ok: false, reason: "The website took too long to respond.", uptime: null };
    }

    // Every hop gets checked, not just the first.
    const safety = await checkHostnameIsPublic(currentUrl.hostname);
    if (!safety.safe) {
      return { ok: false, reason: safety.reason, uptime: null };
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
        // Whichever is shorter: this request's own cap, or what is left of
        // the audit's shared budget.
        signal: deadline.signal(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const classified = classifyConnectionError(error);
      return {
        ok: false,
        reason: classified.reason,
        certificateProblem: classified.certificateProblem,
        // The hop that failed, kept only when a certificate is what failed on
        // it. Spread rather than set to undefined, so a result that has no
        // certificate problem carries no field about one.
        ...(classified.certificateProblem === undefined
          ? {}
          : { certificateUrl: currentUrl.toString() }),
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
    // A response arrived, so from here on a failure can still report uptime.
    lastUptime = uptime;

    // A 3xx status with a Location header means "the page moved here".
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // The redirect's own body is never read, whichever branch follows —
      // incomplete, unreadable, non-web, or a hop we go on to follow. Release it
      // here so its connection is not left open. Only the Location header is
      // needed from this response, and it has already been read.
      await releaseBody(response);
      if (!location) {
        return { ok: false, reason: "The website sent an incomplete redirect.", uptime, redirectChain };
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
          redirectChain,
        };
      }

      if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
        return {
          ok: false,
          reason: "The website redirected somewhere that isn't a web page.",
          uptime,
          redirectChain,
        };
      }

      currentUrl = nextUrl;
      redirectChain.push(currentUrl.toString());
      continue; // loop round; the new address gets safety-checked too
    }

    if (!response.ok) {
      // An error status is not read as a page, so its body is released.
      await releaseBody(response);
      return { ok: false, reason: describeErrorStatus(response.status), uptime, redirectChain };
    }

    /*
     * WHAT KIND OF THING DID WE JUST RECEIVE? THREE ANSWERS, NOT TWO.
     *
     *   an HTML type      a web page. Read it.
     *   another type      the server said this is a PDF, an image, a feed.
     *                     Not a page, and it said so.
     *   NO TYPE AT ALL    the server did not say. That is not the same fact.
     *
     * The third used to be folded into the second, so a response with no
     * Content-Type was refused with "That address doesn't point to a web
     * page" — a claim about the client's website resting on nothing but a
     * header the server omitted. It may well be a page; browsers sniff and
     * render it. We do not sniff, so what we honestly have is "we could not
     * establish what this is", and that is what it now says.
     *
     * Both refusals return HERE, before the body is read, so an undeclared
     * response is never parsed as HTML and never reaches the size cap — there
     * is nothing to cap, because nothing is downloaded. The address has
     * already passed the safety check for this hop, and nothing about that
     * changes.
     *
     * The comparison is lower-cased because media types are case-insensitive
     * and `TEXT/HTML` is a perfectly ordinary thing for a server to send. It
     * used to be refused as not a web page.
     */
    const declaredType = response.headers.get("content-type");
    if (declaredType === null || declaredType.trim() === "") {
      // The server declared no type, so the body is not read — release it.
      await releaseBody(response);
      return { ok: false, reason: UNDECLARED_CONTENT_TYPE, uptime, redirectChain };
    }

    const contentType = declaredType;
    if (!contentType.toLowerCase().includes("html")) {
      // Not HTML, so it is not read as a page — release the body.
      await releaseBody(response);
      return { ok: false, reason: NOT_A_WEB_PAGE, uptime, redirectChain };
    }

    const body = await readCapped(response, maxBytes);
    if (body === null) {
      return { ok: false, reason: "That page could not be read in full.", uptime, redirectChain };
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // getSetCookie() returns every Set-Cookie header individually. The
    // forEach above cannot: it collapses them into one entry, silently
    // discarding the rest. Guarded because older runtimes lack the method.
    const setCookieHeaders =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    return {
      ok: true,
      page: {
        finalUrl: currentUrl.toString(),
        redirectChain,
        html: decodeHtml(body, contentType),
        headers,
        setCookieHeaders,
        servedOverHttps: currentUrl.protocol === "https:",
        httpsUnavailable,
        certificateProblem,
        contentType: contentType || null,
        uptime,
      },
    };
  }

  /*
   * The redirect limit was reached, so every hop answered — the server is
   * online, and `lastUptime` holds the final response's measurement (a 3xx). It
   * is null only if the loop never ran, which cannot happen here: MAX_REDIRECTS
   * is positive, so at least one hop was attempted. The chain is reported too,
   * so a report can show where the redirects went.
   */
  return {
    ok: false,
    reason: "That website redirected too many times.",
    uptime: lastUptime,
    redirectChain,
  };
}

/**
 * Reads the response body, stopping if it exceeds MAX_BYTES.
 *
 * We read it in pieces rather than all at once, so an enormous file gets
 * abandoned early instead of being loaded into memory first.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);

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
