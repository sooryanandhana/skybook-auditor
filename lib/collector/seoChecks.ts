import * as cheerio from "cheerio";
import type { SeoData } from "@/lib/types";

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
export function runSeoChecks(html: string): SeoData {
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

  // --- Headings ------------------------------------------------------------
  const h1Elements = $("h1");
  const h1Texts = h1Elements
    .map((_, el) => normalizeText($(el).text()) ?? "")
    .get()
    .filter((text) => text.length > 0);

  // --- Images --------------------------------------------------------------
  const images = $("img");
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
  const canonicalUrl =
    normalizeText($('link[rel="canonical"]').first().attr("href") ?? "") ?? null;

  const langAttribute = normalizeText($("html").attr("lang") ?? "") ?? null;

  const hasViewportMeta =
    $("meta[name]").filter(
      (_, el) => ($(el).attr("name") ?? "").toLowerCase() === "viewport",
    ).length > 0;

  return {
    titleText,
    titleLength: titleText?.length ?? 0,
    metaDescriptionText,
    metaDescriptionLength: metaDescriptionText?.length ?? 0,
    h1Count: h1Elements.length,
    h1Texts,
    headingSkips: findHeadingSkips($),
    imageCount: images.length,
    imagesMissingAlt,
    canonicalUrl,
    langAttribute,
    hasViewportMeta,
  };
}

/**
 * Finds places where heading levels skip a step, e.g. an <h2> followed
 * directly by an <h4> with no <h3> between them.
 *
 * Headings are meant to work like a contents page: h1 is the chapter, h2 the
 * sections, h3 the subsections. Skipping a level makes the structure harder
 * for search engines and screen readers to follow.
 */
function findHeadingSkips($: cheerio.CheerioAPI): string[] {
  const skips: string[] = [];
  let previousLevel = 0;

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
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
