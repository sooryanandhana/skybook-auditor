import * as cheerio from "cheerio";
import type { SeoData } from "@/lib/types";
import { hasRel } from "./relTokens.ts";

/**
 * Reads on-page SEO facts out of a page's HTML.
 *
 * Cheerio parses the HTML into a structure we can query, similar to how a
 * browser does — but without running any JavaScript, loading images, or
 * displaying anything. It just reads the markup that was sent.
 *
 * A consequence worth knowing: content that a site builds with JavaScript
 * after the page loads is NOT visible here. For most sites the title, meta
 * tags and headings are in the initial HTML, so this is fine — but a fully
 * JavaScript-rendered site could show fewer headings or images than a visitor
 * would see. Nothing here is guessed; it reports exactly what was sent.
 */
export function runSeoChecks(html: string, pageUrl?: string): SeoData {
  const $ = cheerio.load(html);

  // --- Title ---------------------------------------------------------------
  // .first() matters: a malformed page can contain more than one <title>,
  // and a browser would use the first.
  const rawTitle = $("head title").first().text();
  const titleText = normalizeText(rawTitle);

  // --- Meta description ----------------------------------------------------
  // The attribute selector is case-sensitive but HTML attribute values are
  // not, so we search case-insensitively for name="description".
  const rawDescription = $('meta[name]')
    .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "description")
    .first()
    .attr("content");
  const metaDescriptionText = normalizeText(rawDescription ?? "");

  /*
   * Everything below reads the RENDERED body, with <template> removed.
   *
   * A <template> is inert: the browser parses it but never puts its contents
   * on the page. Counting them made a perfectly correct page report three
   * findings it did not deserve — a second <h1> no visitor can see, a heading
   * level "skipped" inside the template, and a placeholder image with no alt.
   * Worse, the h1 evidence quoted the template placeholder back to the client
   * as though it were their own heading.
   *
   * <noscript> is removed for the same reason: it is shown only when scripts
   * are off, and its usual content is a tracking pixel with no alt attribute.
   *
   * The head-based facts above are unaffected — they are read from the head.
   */
  const rendered = $("body").clone();
  rendered.find("template, noscript").remove();

  // --- Headings ------------------------------------------------------------
  const h1Elements = rendered.find("h1");
  const h1Texts = h1Elements
    .map((_, el) => normalizeText($(el).text()) ?? "")
    .get()
    .filter((text) => text.length > 0);

  // --- Images --------------------------------------------------------------
  const images = rendered.find("img");
  let imagesMissingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr("alt");
    /*
     * A missing alt attribute is a problem. An EMPTY one (alt="") is not —
     * that is the correct, deliberate way to mark a decorative image, and
     * flagging it would be telling clients to "fix" something already right.
     */
    if (alt === undefined) imagesMissingAlt += 1;
  });

  // --- Other head elements -------------------------------------------------
  // A canonical tag may hold a relative address (href="/about"). Resolving it
  // against the page URL gives the absolute address it actually means; without
  // that, the report would show a fragment like "/about" as if it were a URL.
  /*
   * `rel` is a token list, so an exact attribute match is not enough. A tag
   * written rel="canonical alternate" declares a canonical relation just as
   * much as rel="canonical" does, and matching the whole string missed it —
   * which told a client their page declares no canonical URL when it does.
   *
   * `.first()` is unchanged: where a page carries several, the first one wins,
   * exactly as before.
   */
  const canonicalLink = $("link[rel]")
    .filter((_, el) => hasRel($(el).attr("rel"), "canonical"))
    .first();
  const rawCanonical = normalizeText(canonicalLink.attr("href") ?? "");
  const canonicalUrl = resolveUrl(rawCanonical, pageUrl);

  const langAttribute = normalizeText($("html").attr("lang") ?? "") ?? null;

  /*
   * A viewport tag with nothing in it does nothing.
   *
   * `<meta name="viewport" content="">` is a tag a browser reads and ignores,
   * so a phone still renders the page at desktop width. Counting it as present
   * passed the rule and told a client their page was fine on mobile on the
   * strength of a declaration that has no effect.
   *
   * Presence of CONTENT is all that is checked. Whether the content is any
   * good — width=device-width, a sane initial-scale, user-scaling left alone —
   * is a different question and deliberately not asked here.
   */
  const hasViewportMeta = $("meta[name]")
    .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "viewport")
    .toArray()
    .some((el) => normalizeText($(el).attr("content") ?? "") !== null);

  return {
    titleText,
    titleLength: titleText?.length ?? 0,
    metaDescriptionText,
    metaDescriptionLength: metaDescriptionText?.length ?? 0,
    bodyTextLength: measureBodyText($),
    h1Count: h1Elements.length,
    h2Count: rendered.find("h2").length,
    h3Count: rendered.find("h3").length,
    h1Texts,
    headingSkips: findHeadingSkips(rendered),
    imageCount: images.length,
    imagesMissingAlt,
    canonicalUrl,
    langAttribute,
    hasViewportMeta,
  };
}

/**
 * How many characters of visible text the SERVED HTML contained.
 *
 * WHAT THIS IS: a count. Nothing more. It does not decide anything about the
 * page, and it deliberately is NOT a flag called "isClientRendered" — that
 * would be a guess dressed up as a measurement, and this project does not ship
 * those. It reports what arrived, and something else may draw conclusions.
 *
 * WHY IT WAS ADDED: this scan does not run JavaScript, so a site that builds
 * its content in the browser serves little more than an empty container. Its
 * headings and images are genuinely absent FROM THE HTML while being perfectly
 * present for a visitor. Without a way to notice that, every body-dependent
 * SEO check would fire at once on a page that has nothing wrong with it.
 *
 * Script, style and template contents are excluded: they are never shown to a
 * visitor, and a page whose only "text" is a bundled JavaScript file has no
 * visible text at all.
 */
export function measureBodyText($: cheerio.CheerioAPI): number {
  // Work on a copy so removing nodes cannot disturb any later query.
  const body = $("body").clone();
  body.find("script, style, noscript, template").remove();
  return normalizeText(body.text())?.length ?? 0;
}

/**
 * Finds places where heading levels skip a step, e.g. an <h2> followed
 * directly by an <h4> with no <h3> between them.
 *
 * Headings are meant to work like a contents page: h1 is the chapter, h2 the
 * sections, h3 the subsections. Skipping a level makes the structure harder
 * for search engines and screen readers to follow.
 */
function findHeadingSkips(rendered: ReturnType<cheerio.CheerioAPI>): string[] {
  const skips: string[] = [];
  let previousLevel = 0;

  rendered.find("h1, h2, h3, h4, h5, h6").each((_, el) => {
    // Element names come back lowercase, so "h3" -> 3.
    const level = Number(el.tagName.slice(1));
    if (Number.isNaN(level)) return;

    // Only a jump DOWN the hierarchy by more than one is a skip. Going back
    // up (h4 -> h2) is normal — that's just starting a new section.
    if (previousLevel > 0 && level > previousLevel + 1) {
      skips.push(`h${previousLevel} is followed by h${level}, skipping a level`);
    }
    previousLevel = level;
  });

  return skips;
}

/**
 * Tidies text taken from a page: collapses runs of whitespace and trims.
 * Returns null for text that is empty once tidied, so "present but blank"
 * is reported the same as "absent" — because to a search engine it is.
 */
function normalizeText(value: string): string | null {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Turns a possibly-relative address into an absolute one.
 *
 * Returns the original value unchanged if there is no page URL to resolve
 * against, or if it cannot be parsed — reporting what the page actually said
 * is better than reporting nothing.
 */
function resolveUrl(value: string | null, baseUrl?: string): string | null {
  if (value === null) return null;
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}
