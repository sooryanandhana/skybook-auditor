/**
 * TEST FIXTURE: the security checks EXACTLY as they were before the one-parse
 * change (commit 2b31d82), kept so the equivalence tests compare the new code
 * with the old code itself rather than with a re-implementation of it.
 *
 * Never imported by application code. Do not edit: it is a record, not a
 * second implementation.
 */
import * as cheerio from "cheerio";
import { relTokens } from "./relTokens.ts";
import type {
  CookieData,
  CookieInfo,
  HstsData,
  MixedContentData,
  MixedContentItem,
  MixedContentKind,
  SecurityData,
  SecurityHeader,
} from "@/lib/types";

/**
 * Reads the security settings a website sent, and looks for insecure
 * resources in its page.
 *
 * This step needs no new requests: the response headers and the HTML both
 * arrived when the page was fetched. It only interprets what we already have.
 *
 * It records facts and does not grade them. Deciding that a missing
 * Content-Security-Policy is "medium" and no HTTPS is "critical" is the job
 * of the severity rules, which are fixed and live in their own module.
 */

/** How many insecure resources we list individually. */
const MIXED_CONTENT_LIMIT = 20;

/**
 * Elements that LOAD something, and how a browser treats an insecure one.
 *
 * "active" resources can change the page, so browsers block them and the page
 * may visibly break. "passive" ones are usually still shown, but the padlock
 * is downgraded and the visitor sees a warning.
 */
const RESOURCE_SOURCES: Array<{
  selector: string;
  /** The element name to report. Taken from the selector, not the DOM node. */
  element: string;
  attribute: string;
  kind: MixedContentKind;
  /** srcset holds several URLs separated by commas, each with a descriptor. */
  isSrcset?: boolean;
}> = [
  { selector: "script[src]", element: "script", attribute: "src", kind: "active" },
  { selector: "iframe[src]", element: "iframe", attribute: "src", kind: "active" },
  { selector: "object[data]", element: "object", attribute: "data", kind: "active" },
  { selector: "embed[src]", element: "embed", attribute: "src", kind: "active" },
  { selector: "img[src]", element: "img", attribute: "src", kind: "passive" },
  { selector: "img[srcset]", element: "img", attribute: "srcset", kind: "passive", isSrcset: true },
  { selector: "source[src]", element: "source", attribute: "src", kind: "passive" },
  { selector: "source[srcset]", element: "source", attribute: "srcset", kind: "passive", isSrcset: true },
  { selector: "audio[src]", element: "audio", attribute: "src", kind: "passive" },
  { selector: "video[src]", element: "video", attribute: "src", kind: "passive" },
  { selector: "video[poster]", element: "video", attribute: "poster", kind: "passive" },
  { selector: "track[src]", element: "track", attribute: "src", kind: "passive" },
  // An image button really does fetch an image.
  { selector: 'input[type="image"][src]', element: "input", attribute: "src", kind: "passive" },
];

/**
 * Elements whose name we must read from the page rather than the selector,
 * because the same attribute appears on several different elements.
 */
const GENERIC_SOURCES: Array<{
  selector: string;
  attribute: string;
  kind: MixedContentKind;
  isSrcset?: boolean;
}> = [
  // The `background` attribute is long deprecated, but browsers still fetch
  // it — and it turns up on exactly the older sites this tool is aimed at.
  { selector: "[background]", attribute: "background", kind: "passive" },
  // <link rel="preload" as="image" imagesrcset="..."> preloads a responsive set.
  { selector: "link[imagesrcset]", attribute: "imagesrcset", kind: "passive", isSrcset: true },
];

/**
 * SVG elements that load something.
 *
 * SVG uses `href`, and older documents use the namespaced `xlink:href`. Both
 * are read, because both still work in browsers.
 */
const SVG_SOURCES: Array<{ selector: string; kind: MixedContentKind }> = [
  { selector: "image", kind: "passive" },
  { selector: "use", kind: "unknown" },
];

/**
 * How a <link> element's `rel` value decides what it loads.
 *
 * `<link>` is not one thing: rel="stylesheet" loads a stylesheet, rel="icon"
 * loads a favicon, rel="preconnect" loads nothing at all. Only the ones that
 * actually fetch a resource can be mixed content.
 */
const LINK_REL_KINDS: Record<string, MixedContentKind> = {
  stylesheet: "active",
  modulepreload: "active",
  icon: "passive",
  "apple-touch-icon": "passive",
  "apple-touch-icon-precomposed": "passive",
  "mask-icon": "passive",
  manifest: "passive",
  prefetch: "passive",
};
// Note: the legacy rel="shortcut icon" needs no entry of its own — its "icon"
// token matches above. "shortcut" on its own loads nothing, so listing it
// would wrongly count a link that fetches no resource.

/**
 * What `<link rel="preload" as="...">` is fetching.
 *
 * A preload can be anything, so its `as` attribute is what says whether a
 * browser would block it. Without `as` we genuinely cannot tell.
 */
const PRELOAD_AS_KINDS: Record<string, MixedContentKind> = {
  script: "active",
  style: "active",
  font: "active",
  worker: "active",
  document: "active",
  image: "passive",
  video: "passive",
  audio: "passive",
  track: "passive",
};

/**
 * The parts of a website this scan cannot see.
 *
 * Recorded in the data so that a count of zero is never presented as "the
 * whole site is clean". We read the HTML the server sent; we do not run the
 * page, and we do not download its stylesheets.
 */
const NOT_INSPECTED = [
  "Resources referenced inside separate CSS files, which are not downloaded",
  "Resources added by JavaScript after the page loads, since the page is not run",
  "Pages other than this one",
];

export function runSecurityChecks(
  headers: Record<string, string>,
  html: string,
  servedOverHttps: boolean,
  setCookieHeaders: string[] = [],
  /** When the response was read. Injectable so a cookie's expiry can be tested. */
  now: Date = new Date(),
): SecurityData {
  const strictTransportSecurity = readHeader(headers, "strict-transport-security");

  return {
    servedOverHttps,

    strictTransportSecurity,
    contentSecurityPolicy: readHeader(headers, "content-security-policy"),
    contentSecurityPolicyReportOnly: readHeader(headers, "content-security-policy-report-only"),
    contentSecurityPolicyMeta: hasMetaContentSecurityPolicy(html),
    xFrameOptions: readHeader(headers, "x-frame-options"),
    xContentTypeOptions: readHeader(headers, "x-content-type-options"),
    referrerPolicy: readHeader(headers, "referrer-policy"),
    permissionsPolicy: readHeader(headers, "permissions-policy"),

    hsts: parseHsts(strictTransportSecurity.value, servedOverHttps),
    mixedContent: findMixedContent(
      html,
      servedOverHttps,
      hasEnforcedUpgradeInsecureRequests(headers, html),
    ),
    cookies: parseCookies(setCookieHeaders, now),
    insecureFormActions: findInsecureFormActions(html),

    serverHeader: readHeader(headers, "server"),
    poweredByHeader: readHeader(headers, "x-powered-by"),
  };
}

/** What a cookie check cannot see. */
const COOKIES_NOT_INSPECTED = [
  "Cookies created later by JavaScript, since the page is not run",
  "Cookies set on other pages of the site",
];

/**
 * Reads the protective flags off each Set-Cookie header.
 *
 * Three flags matter:
 *   Secure    — the cookie is only ever sent over HTTPS
 *   HttpOnly  — scripts on the page cannot read it
 *   SameSite  — limits sending it when another site makes the request
 *
 * The cookie's VALUE is deliberately discarded. It is frequently a live
 * session token, and an audit has no reason to hold one — let alone put it in
 * a report emailed to a client.
 */
/**
 * Whether the header's own lifetime has already ended when it arrives.
 *
 * RFC 6265 §5.2.1-5.2.2, and only what the header itself states:
 *
 *   Max-Age wins over Expires whenever it is present and readable, which is
 *   what the specification says and what browsers do.
 *   Max-Age of zero or less expires the cookie immediately.
 *   Otherwise an Expires date already in the past does the same.
 *   A cookie with neither attribute lasts for the browsing session, so it is
 *   not expired.
 *
 * WHY THIS IS MEASURED AT ALL. A response that clears a cookie -- a logout,
 * most often -- carries the same shape as one that sets it, and without this
 * the audit graded that header as if a cookie were being stored. "This cookie
 * lacks Secure" about a cookie that no browser keeps is a finding about
 * nothing.
 *
 * "ALREADY EXPIRED" IS NOT "A DELETION". Whether some earlier cookie is being
 * cleared is not in the header and is not claimed here. What the header states
 * is that nothing is stored, and that is all this records.
 */
function isAlreadyExpired(attributes: readonly string[], now: Date): boolean {
  const maxAge = attributes.find((part) => part.startsWith("max-age="));
  if (maxAge !== undefined) {
    /*
     * Max-Age is a whole number of seconds. RFC 6265 §5.2.2 says an attribute
     * that does not read as one is ignored entirely -- so "Max-Age=" and
     * "Max-Age=soon" say nothing, and Expires is consulted instead. Reading an
     * empty value as zero would turn a malformed header into a deletion.
     */
    const seconds = maxAge.slice("max-age=".length).trim();
    if (/^-?\d+$/.test(seconds)) return Number(seconds) <= 0;
  }

  const expires = attributes.find((part) => part.startsWith("expires="));
  if (expires === undefined) return false;

  const at = new Date(expires.slice("expires=".length).trim());
  // An unreadable date says nothing, so nothing is concluded from it.
  return Number.isNaN(at.getTime()) ? false : at.getTime() <= now.getTime();
}

/**
 * The cookies a response sets, as the flags that protect them.
 *
 * `now` is injectable so a test can state what "already expired" means for it;
 * production passes the moment the response was read.
 */
export function parseCookies(setCookieHeaders: string[], now: Date = new Date()): CookieData {
  const cookies: CookieInfo[] = [];

  for (const header of setCookieHeaders) {
    // "name=value; Path=/; Secure; HttpOnly; SameSite=Lax"
    const parts = header.split(";");
    const nameAndValue = parts[0] ?? "";
    const equals = nameAndValue.indexOf("=");
    // Everything after the first "=" is the value, and is not read.
    const name = (equals === -1 ? nameAndValue : nameAndValue.slice(0, equals)).trim();
    if (!name) continue;

    // Attribute names are case-insensitive, so compare in lower case.
    const attributes = parts.slice(1).map((part) => part.trim().toLowerCase());
    const sameSiteAttribute = attributes.find((part) => part.startsWith("samesite="));

    cookies.push({
      name,
      secure: attributes.includes("secure"),
      httpOnly: attributes.includes("httponly"),
      sameSite: sameSiteAttribute ? sameSiteAttribute.slice("samesite=".length).trim() || null : null,
      expired: isAlreadyExpired(attributes, now),
    });
  }

  return { total: cookies.length, cookies, notInspected: COOKIES_NOT_INSPECTED };
}

/**
 * Looks up one header.
 *
 * The headers we are given were already lowercased when the page was fetched,
 * which matters because header names are case-insensitive: a server may send
 * "Strict-Transport-Security" or "strict-transport-security" and they mean
 * the same thing.
 *
 * A header sent with an empty value is reported as absent, because an empty
 * value gives the browser nothing to act on.
 */
function readHeader(headers: Record<string, string>, name: string): SecurityHeader {
  const raw = headers[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? { present: true, value } : { present: false, value: null };
}

/**
 * Reads the Strict-Transport-Security header in detail.
 *
 * Presence alone is not enough. `max-age=0` is a header that exists and
 * deliberately switches the protection OFF — treating that as "protected"
 * would put a false reassurance in a client's report.
 */
export function parseHsts(value: string | null, servedOverHttps: boolean): HstsData {
  // Everything false/null until a usable header proves otherwise. Returning
  // this unchanged is how an absent or invalid header is reported.
  const inactive: HstsData = {
    applicable: servedOverHttps,
    valid: false,
    maxAgeSeconds: null,
    disabledByZeroMaxAge: false,
    includesSubdomains: false,
    preload: false,
  };

  if (value === null) return inactive;

  /*
   * ONLY THE FIRST HEADER COUNTS.
   *
   * RFC 6797 section 8.1: if a response carries more than one
   * Strict-Transport-Security header, a browser processes only the first and
   * ignores the rest. Several headers reach us already joined into one
   * comma-separated string, so anything after the first comma belongs to a
   * later header.
   *
   * Merging them would be actively dangerous: a first header of "max-age=0"
   * followed by "max-age=31536000" would look like a well-protected site,
   * when a browser reads the first, switches HSTS off, and protects nothing.
   * Commas have no other meaning inside this header, so splitting on one is
   * unambiguous.
   */
  const firstHeader = value.split(",")[0];

  // Within a header, directives are separated by semicolons, e.g.
  //   max-age=31536000; includeSubDomains; preload
  const directives = firstHeader.split(";").map((part) => part.trim().toLowerCase());

  let maxAgeSeconds: number | null = null;
  const maxAgeDirective = directives.find((part) => part.startsWith("max-age"));
  if (maxAgeDirective) {
    // Values may be quoted: max-age="31536000"
    const rawNumber = maxAgeDirective.split("=")[1]?.replace(/["']/g, "").trim();
    const parsed = Number(rawNumber);
    if (rawNumber !== undefined && rawNumber !== "" && Number.isFinite(parsed) && parsed >= 0) {
      maxAgeSeconds = parsed;
    }
  }

  /*
   * NO USABLE max-age MEANS THE WHOLE HEADER IS IGNORED.
   *
   * RFC 6797 makes max-age required. A header of just "includeSubDomains"
   * is invalid, so a browser discards it entirely and the site gets no
   * protection — not even the subdomain coverage it appears to ask for.
   * Reporting includesSubdomains: true here would describe protection that
   * does not exist.
   *
   * The text the server actually sent is still kept on the header itself,
   * so "they wrote includeSubDomains but forgot max-age" is still a finding
   * that can be made from this data.
   */
  if (maxAgeSeconds === null) return inactive;

  return {
    applicable: servedOverHttps,
    valid: true,
    maxAgeSeconds,
    disabledByZeroMaxAge: maxAgeSeconds === 0,
    includesSubdomains: directives.includes("includesubdomains"),
    preload: directives.includes("preload"),
  };
}

/**
 * Finds resources the page loads over plain HTTP.
 *
 * Only a secure page can have "mixed" content. On a plain HTTP page every
 * resource is insecure already — that is one finding (no HTTPS), not a
 * separate finding for each image on the page.
 *
 * Two kinds of address are deliberately NOT counted:
 *   - "//example.com/x.js" takes whichever protocol the page uses, so on an
 *     HTTPS page it is secure.
 *   - "/x.js" and "x.js" are relative to the page, so likewise.
 * Only an address that explicitly says http:// is insecure.
 *
 * Links (<a href="http://...">) are not counted either. A link is somewhere
 * the visitor may choose to go, not something this page loads.
 */
export function findMixedContent(
  html: string,
  servedOverHttps: boolean,
  /**
   * Whether an enforced CSP upgrades these references before they load. Measured
   * by the caller (see `hasEnforcedUpgradeInsecureRequests`) and only recorded
   * here — the raw references are still found and listed either way. Defaults to
   * false so a caller that has not measured it gets the plain reading.
   */
  upgradeInsecureRequests = false,
): MixedContentData {
  if (!servedOverHttps) {
    return {
      applicable: false,
      total: 0,
      activeCount: 0,
      // Mixed content does not apply on a plain HTTP page, so whether a policy
      // would upgrade it is moot: recorded as false rather than measured.
      upgradeInsecureRequests: false,
      items: [],
      truncated: false,
      notInspected: NOT_INSPECTED,
    };
  }

  const found = collectInsecureResources(html, 0);

  return {
    applicable: true,
    total: found.length,
    activeCount: found.filter((item) => item.kind === "active").length,
    upgradeInsecureRequests,
    items: found.slice(0, MIXED_CONTENT_LIMIT),
    truncated: found.length > MIXED_CONTENT_LIMIT,
    notInspected: NOT_INSPECTED,
  };
}

/** How deep to follow HTML embedded inside an iframe's srcdoc attribute. */
const MAX_SRCDOC_DEPTH = 2;

/** Walks one document's markup for insecure resources. */
function collectInsecureResources(html: string, depth: number): MixedContentItem[] {
  const $ = cheerio.load(html);
  const found: MixedContentItem[] = [];

  // --- Elements with a plain resource attribute -----------------------------
  for (const source of RESOURCE_SOURCES) {
    $(source.selector).each((_, element) => {
      const raw = $(element).attr(source.attribute);
      if (!raw) return;

      const urls = source.isSrcset ? splitSrcset(raw) : [raw.trim()];
      for (const url of urls) {
        if (isInsecureUrl(url)) {
          found.push({
            url,
            element: source.element,
            via: source.attribute,
            kind: source.kind,
          });
        }
      }
    });
  }

  // --- <link> elements, which load different things depending on rel --------
  $("link[href]").each((_, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href || !isInsecureUrl(href)) return;

    const kind = classifyLink($(element).attr("rel"), $(element).attr("as"));
    // null means this rel loads nothing (preconnect, dns-prefetch, canonical,
    // alternate...), so an http address there is not a resource being fetched.
    if (kind === null) return;

    found.push({ url: href, element: "link", via: "href", kind });
  });

  // --- CSS written inside the page ------------------------------------------
  // A background image or font named in a style attribute or a <style> block
  // is fetched just like any other resource.
  $("[style]").each((_, element) => {
    const css = $(element).attr("style");
    if (!css) return;
    const name = "tagName" in element ? String(element.tagName).toLowerCase() : "element";
    for (const item of findCssResources(css)) {
      found.push({ ...item, element: name, via: `style attribute — ${item.via}` });
    }
  });

  $("style").each((_, element) => {
    const css = $(element).text();
    if (!css) return;
    for (const item of findCssResources(css)) {
      found.push({ ...item, element: "style", via: item.via });
    }
  });

  // --- Attributes shared across several elements ----------------------------
  for (const source of GENERIC_SOURCES) {
    $(source.selector).each((_, element) => {
      const raw = $(element).attr(source.attribute);
      if (!raw) return;

      const urls = source.isSrcset ? splitSrcset(raw) : [raw.trim()];
      for (const url of urls) {
        if (isInsecureUrl(url)) {
          found.push({
            url,
            element: tagNameOf(element),
            via: source.attribute,
            kind: source.kind,
          });
        }
      }
    });
  }

  // --- SVG, which uses href and the older xlink:href -------------------------
  for (const source of SVG_SOURCES) {
    $(source.selector).each((_, element) => {
      for (const attribute of ["href", "xlink:href"]) {
        const raw = $(element).attr(attribute)?.trim();
        if (raw && isInsecureUrl(raw)) {
          found.push({
            url: raw,
            element: tagNameOf(element),
            via: attribute,
            kind: source.kind,
          });
        }
      }
    });
  }

  // --- HTML written inside an iframe's srcdoc --------------------------------
  // srcdoc holds a whole document, and its resources are fetched just like the
  // outer page's. Depth is capped so nested srcdocs cannot loop.
  if (depth < MAX_SRCDOC_DEPTH) {
    $("iframe[srcdoc]").each((_, element) => {
      const inner = $(element).attr("srcdoc");
      if (!inner) return;
      for (const item of collectInsecureResources(inner, depth + 1)) {
        found.push({ ...item, via: `iframe srcdoc — ${item.via}` });
      }
    });
  }

  return found;
}

/** The element's own tag name, lowercased, for elements found by attribute. */
function tagNameOf(node: unknown): string {
  return node && typeof node === "object" && "tagName" in node
    ? String((node as { tagName: unknown }).tagName).toLowerCase()
    : "element";
}

/**
 * Decides what a <link> element fetches, from its rel (and `as` for preload).
 *
 * Returns null when the rel loads no resource at all — rel="preconnect" only
 * opens a connection, rel="canonical" and rel="alternate" are references
 * rather than fetches. Counting those as mixed content would invent problems.
 *
 * `rel` may hold several space-separated values (the legacy
 * rel="shortcut icon" is the common example), so every token is considered.
 */
export function classifyLink(
  rel: string | undefined,
  as: string | undefined,
): MixedContentKind | null {
  if (!rel) return null;

  // The shared reader, so this and the SEO canonical check cannot drift apart.
  const tokens = relTokens(rel);

  if (tokens.includes("preload")) {
    // What a preload fetches is entirely decided by its `as` attribute.
    // Without one we cannot say whether a browser would block it.
    return PRELOAD_AS_KINDS[(as ?? "").toLowerCase()] ?? "unknown";
  }

  // An ALTERNATE stylesheet is an optional theme the visitor can switch to.
  // Browsers do not fetch it unless it is chosen, so it is not loaded on an
  // ordinary visit and must not be counted as one.
  if (tokens.includes("alternate") && tokens.includes("stylesheet")) return null;

  for (const token of tokens) {
    const kind = LINK_REL_KINDS[token];
    if (kind) return kind;
  }

  return null;
}

/**
 * Finds insecure addresses inside a piece of CSS.
 *
 * Two ways CSS names a resource:
 *   @import "http://..."   pulls in another stylesheet — a browser blocks it
 *   url(http://...)        loads an image, font, or something else
 *
 * An @import is known to be a stylesheet, so it is classified "active". A
 * plain url() could be an image (which browsers allow with a warning) or a
 * font (which they block), and the CSS does not say which. Guessing from the
 * file extension would be inference rather than measurement, so those are
 * reported as "unknown".
 */
export function findCssResources(css: string): Array<Omit<MixedContentItem, "element">> {
  // Comments must go first. A commented-out rule is never loaded, so counting
  // one would report a problem the site does not have — and a false alarm in a
  // client's report is worse than a missed finding, because they check, find
  // nothing, and stop trusting the rest of it.
  const live = stripCssComments(css);

  const results: Array<Omit<MixedContentItem, "element">> = [];

  // @import is extracted first, then removed from the text, so the same
  // address is not counted again by the url() pass. Removing it (rather than
  // de-duplicating by address) means a genuinely repeated url() still counts
  // once per occurrence, matching how repeated elements are counted.
  let remaining = live;
  for (const match of matchAllWithText(live, IMPORT_PATTERN)) {
    remaining = remaining.replace(match.text, " ");
    if (isInsecureUrl(match.url)) {
      results.push({ url: match.url, via: "CSS @import", kind: "active" });
    }
  }

  for (const url of matchAll(remaining, URL_PATTERN)) {
    if (isInsecureUrl(url)) {
      results.push({ url, via: "CSS url()", kind: "unknown" });
    }
  }

  return results;
}

/**
 * Removes /* … *\/ comments from CSS.
 *
 * An unterminated comment runs to the end of the stylesheet, which is what
 * browsers do too, so the trailing text is dropped rather than kept.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
}

/** Matches url(...) with double quotes, single quotes, or none. */
const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

/** Matches @import "..." and @import url(...). */
const IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')/gi;

/** Runs a pattern over some text and returns whichever capture group matched. */
function matchAll(text: string, pattern: RegExp): string[] {
  return matchAllWithText(text, pattern).map((match) => match.url);
}

/** As matchAll, but also returns the whole matched text so it can be removed. */
function matchAllWithText(text: string, pattern: RegExp): Array<{ url: string; text: string }> {
  const found: Array<{ url: string; text: string }> = [];
  // The pattern is shared, so reset its position before each use.
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = match.slice(1).find((group) => group !== undefined);
    if (url && url.trim().length > 0) found.push({ url: url.trim(), text: match[0] });
  }
  return found;
}

/**
 * Finds forms that send what a visitor types to a plain HTTP address.
 *
 * This is separate from mixed content: mixed content is about what the page
 * LOADS, this is about what the visitor SENDS. A password or phone number
 * typed into such a form travels unencrypted, and browsers label the form
 * "Not secure".
 *
 * Unlike mixed content, this is reported on HTTP pages too — the risk to the
 * person typing is the same either way.
 */
/**
 * Whether the page's HTML delivers a Content-Security-Policy in a meta element.
 *
 * READS THE HTML, LIKE THE MIXED-CONTENT AND FORM CHECKS. The CSP specification
 * defines `<meta http-equiv="Content-Security-Policy" content="...">` as a way
 * to deliver a policy, and browsers enforce it. So a page carrying only this,
 * and no header, is not a page with no policy.
 *
 * The `http-equiv` value is compared in code rather than in the selector,
 * because an attribute-value selector is case-sensitive and the pragma is not:
 * "Content-Security-Policy" and "content-security-policy" are the same pragma.
 * A meta element cannot carry a report-only policy -- the specification forbids
 * it -- so anything found here is an enforcing policy. An empty `content` is
 * not a policy and does not count.
 */
export function hasMetaContentSecurityPolicy(html: string): boolean {
  const $ = cheerio.load(html);
  let found = false;

  $("meta[http-equiv]").each((_, element) => {
    const pragma = $(element).attr("http-equiv")?.trim().toLowerCase();
    const content = $(element).attr("content")?.trim();
    if (pragma === "content-security-policy" && content) found = true;
  });

  return found;
}

/**
 * The policy text of every ENFORCING `<meta>` Content-Security-Policy.
 *
 * The same scan as `hasMetaContentSecurityPolicy` -- same selector, same
 * case-insensitive pragma, same non-empty-content rule -- but it KEEPS the
 * content string so a directive can be read from it. A `<meta>` element cannot
 * carry a report-only policy (the specification forbids it), so anything found
 * here is enforcing.
 */
function metaContentSecurityPolicies(html: string): string[] {
  const $ = cheerio.load(html);
  const policies: string[] = [];

  $("meta[http-equiv]").each((_, element) => {
    const pragma = $(element).attr("http-equiv")?.trim().toLowerCase();
    const content = $(element).attr("content")?.trim();
    if (pragma === "content-security-policy" && content) policies.push(content);
  });

  return policies;
}

/**
 * Whether a CSP policy string contains one directive, matched by NAME.
 *
 * A policy is a list of directives separated by semicolons, each a name
 * optionally followed by whitespace-separated values. So the name is the first
 * whitespace-delimited token of a segment, and only that token is compared.
 *
 * DELIBERATELY EXACT, NOT A SUBSTRING TEST. `upgrade-insecure-requests-foo` is a
 * different (unknown) directive and must not match, and the same word appearing
 * inside another directive's value -- `default-src 'self' upgrade-insecure-requests`
 * -- is a source expression, not this directive, so its segment's first token is
 * `default-src` and it does not match either.
 */
function policyHasDirective(policy: string, directive: string): boolean {
  return policy
    .split(";")
    .some((segment) => segment.trim().toLowerCase().split(/\s+/)[0] === directive);
}

/**
 * Whether an ENFORCED Content-Security-Policy carries
 * `upgrade-insecure-requests`.
 *
 * Reads two enforcing delivery channels and no others:
 *   - the `Content-Security-Policy` response header, and
 *   - an enforcing `<meta http-equiv="Content-Security-Policy">` element.
 *
 * `Content-Security-Policy-Report-Only` is NEVER consulted: a report-only policy
 * is observed but not enforced, so its `upgrade-insecure-requests` upgrades
 * nothing and must not suppress a mixed-content finding. This reads exactly one
 * directive for exactly one purpose -- CSP strength is not graded here (E13).
 */
export function hasEnforcedUpgradeInsecureRequests(
  headers: Record<string, string>,
  html: string,
): boolean {
  const header = readHeader(headers, "content-security-policy");
  const policies = [
    ...(header.present && header.value ? [header.value] : []),
    ...metaContentSecurityPolicies(html),
  ];
  return policies.some((policy) => policyHasDirective(policy, "upgrade-insecure-requests"));
}

export function findInsecureFormActions(html: string): string[] {
  const $ = cheerio.load(html);
  const actions: string[] = [];

  $("form[action]").each((_, element) => {
    const action = $(element).attr("action")?.trim();
    if (action && isInsecureUrl(action)) actions.push(action);
  });

  return actions;
}

/** True only for an address that explicitly starts with http:// */
function isInsecureUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

/**
 * Pulls the addresses out of a srcset attribute.
 *
 * A srcset looks like:  "small.jpg 480w, large.jpg 1024w"
 * Each entry is an address followed by an optional size descriptor.
 */
function splitSrcset(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((url) => url.length > 0);
}
