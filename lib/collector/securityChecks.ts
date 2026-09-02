import * as cheerio from "cheerio";
import type {
  HstsData,
  MixedContentData,
  MixedContentItem,
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
  kind: "active" | "passive";
  /** srcset holds several URLs separated by commas, each with a descriptor. */
  isSrcset?: boolean;
}> = [
  { selector: "script[src]", element: "script", attribute: "src", kind: "active" },
  { selector: 'link[rel="stylesheet"][href]', element: "link", attribute: "href", kind: "active" },
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
];

export function runSecurityChecks(
  headers: Record<string, string>,
  html: string,
  servedOverHttps: boolean,
): SecurityData {
  const strictTransportSecurity = readHeader(headers, "strict-transport-security");

  return {
    servedOverHttps,

    strictTransportSecurity,
    contentSecurityPolicy: readHeader(headers, "content-security-policy"),
    xFrameOptions: readHeader(headers, "x-frame-options"),
    xContentTypeOptions: readHeader(headers, "x-content-type-options"),
    referrerPolicy: readHeader(headers, "referrer-policy"),
    permissionsPolicy: readHeader(headers, "permissions-policy"),

    hsts: parseHsts(strictTransportSecurity.value, servedOverHttps),
    mixedContent: findMixedContent(html, servedOverHttps),
    insecureFormActions: findInsecureFormActions(html),

    serverHeader: readHeader(headers, "server"),
    poweredByHeader: readHeader(headers, "x-powered-by"),
  };
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
  const base: HstsData = {
    applicable: servedOverHttps,
    maxAgeSeconds: null,
    disabledByZeroMaxAge: false,
    includesSubdomains: false,
    preload: false,
  };

  if (value === null) return base;

  // The header is a list of directives separated by semicolons, e.g.
  //   max-age=31536000; includeSubDomains; preload
  const directives = value.split(";").map((part) => part.trim().toLowerCase());

  const maxAgeDirective = directives.find((part) => part.startsWith("max-age"));
  if (maxAgeDirective) {
    // Values may be quoted: max-age="31536000"
    const rawNumber = maxAgeDirective.split("=")[1]?.replace(/["']/g, "").trim();
    const parsed = Number(rawNumber);
    if (rawNumber !== undefined && rawNumber !== "" && Number.isFinite(parsed) && parsed >= 0) {
      base.maxAgeSeconds = parsed;
      base.disabledByZeroMaxAge = parsed === 0;
    }
  }

  base.includesSubdomains = directives.includes("includesubdomains");
  base.preload = directives.includes("preload");

  return base;
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
export function findMixedContent(html: string, servedOverHttps: boolean): MixedContentData {
  if (!servedOverHttps) {
    return { applicable: false, total: 0, activeCount: 0, items: [], truncated: false };
  }

  const $ = cheerio.load(html);
  const found: MixedContentItem[] = [];

  for (const source of RESOURCE_SOURCES) {
    $(source.selector).each((_, element) => {
      const raw = $(element).attr(source.attribute);
      if (!raw) return;

      const urls = source.isSrcset ? splitSrcset(raw) : [raw.trim()];
      for (const url of urls) {
        if (isInsecureUrl(url)) {
          found.push({ url, element: source.element, kind: source.kind });
        }
      }
    });
  }

  return {
    applicable: true,
    total: found.length,
    activeCount: found.filter((item) => item.kind === "active").length,
    items: found.slice(0, MIXED_CONTENT_LIMIT),
    truncated: found.length > MIXED_CONTENT_LIMIT,
  };
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
