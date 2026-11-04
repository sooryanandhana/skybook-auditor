/**
 * On-page SEO grading rules.
 *
 * Every rule reads facts Step 2 already read out of the served HTML. Nothing
 * here fetches anything, and nothing here asks an AI anything.
 *
 * ---------------------------------------------------------------------------
 * SEVERITY POLICY — APPROVED AND FIXED
 *
 *   high    seo.viewport.missing        seo.title.missing
 *   medium  seo.meta-description.missing  seo.canonical.missing
 *           seo.lang.missing            seo.h1.missing
 *           seo.h1.multiple             seo.h1.empty
 *           seo.headings.order          seo.images.alt
 *
 * The bands, in SEO terms rather than the security ones:
 *
 *   critical — the site is excluded from search, or unusable for a whole class
 *              of visitors. Nothing in this file reaches that; robots.txt
 *              blocking every crawler does, and lives in technical.ts.
 *   high     — a primary ranking or usability signal is entirely absent.
 *   medium   — a signal is weak, or a secondary one is missing.
 *
 * A locked table in seo.test.mts asserts every grade, so changing one here
 * fails a test rather than slipping through review.
 *
 * ---------------------------------------------------------------------------
 * NO LENGTH RULES, ON PURPOSE
 *
 * `titleLength` and `metaDescriptionLength` are measured and reported, and
 * nothing grades them. Google truncates by PIXEL WIDTH, not character count,
 * so any character threshold would be our opinion presented as a measurement —
 * and arguing with a client about a 62-character title is not worth it. The
 * numbers are in the report; a person can judge them.
 *
 * ---------------------------------------------------------------------------
 * HEAD VERSUS BODY
 *
 * The rules below split into two groups with different selectors:
 *
 *   HEAD-BASED  title, meta description, canonical, lang, viewport.
 *               Served in the markup whether or not a page builds its body in
 *               the browser, so they are always judged.
 *
 *   BODY-BASED  headings, heading order, images. These read the page body, and
 *               this scan does not run JavaScript — so a client-rendered site
 *               serves almost nothing for them to read. They go through
 *               `fromRenderedBody`, which declines to judge when the served
 *               HTML carried too little text, rather than firing five findings
 *               about a page that has nothing wrong with it.
 */
import type { SeoData } from "../types";
import { defineRule } from "./runner.ts";
import { fromRenderedBody, fromServedHead } from "./selectors.ts";
import { fires, passes } from "./types.ts";

// ---------------------------------------------------------------------------
// Head-based. Evaluated whenever the tag is there, or the served HTML was
// substantial enough for its absence to mean something. See `fromServedHead`.
// ---------------------------------------------------------------------------

/**
 * Without a viewport tag a phone renders the page at desktop width and zooms
 * out, leaving text too small to read. Most traffic is mobile, and Google
 * indexes the mobile version first.
 */
export const viewportRule = defineRule<SeoData>({
  id: "seo.viewport.missing",
  scope: "page",
  title: "No mobile viewport tag",
  category: "seo",
  severity: "high",
  remediation:
    'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page head.',
  select: (data) => fromServedHead(data.seo, (s) => s.hasViewportMeta),
  evaluate: (seo) =>
    seo.hasViewportMeta
      ? passes
      : fires("The page has no viewport meta tag, so phones render it at desktop width."),
});

/**
 * The title is the strongest on-page ranking signal and the line a searcher
 * actually clicks. A page without one is listed under whatever Google decides
 * to invent for it.
 */
export const titleRule = defineRule<SeoData>({
  id: "seo.title.missing",
  scope: "page",
  title: "No page title",
  category: "seo",
  severity: "high",
  remediation:
    "Add a <title> in the page head describing this specific page, not the site as a whole.",
  select: (data) => fromServedHead(data.seo, (s) => s.titleText !== null),
  evaluate: (seo) =>
    seo.titleText === null
      ? fires("The page head contains no <title> element, or it is empty.")
      : passes,
});

/**
 * The description is not a ranking factor, but it is the sentence under the
 * link in search results. Without one Google takes an arbitrary fragment of
 * the page.
 */
export const metaDescriptionRule = defineRule<SeoData>({
  id: "seo.meta-description.missing",
  scope: "page",
  title: "No meta description",
  category: "seo",
  severity: "medium",
  remediation:
    'Add <meta name="description" content="..."> summarising the page, so search results show a written summary rather than an arbitrary fragment.',
  select: (data) => fromServedHead(data.seo, (s) => s.metaDescriptionText !== null),
  evaluate: (seo) =>
    seo.metaDescriptionText === null
      ? fires("The page has no meta description tag, or it is empty.")
      : passes,
});

/**
 * A canonical tag tells search engines which address is the real one when the
 * same content is reachable several ways — with and without www, with tracking
 * parameters, and so on. Without it, those can compete with each other.
 */
export const canonicalRule = defineRule<SeoData>({
  id: "seo.canonical.missing",
  scope: "page",
  title: "No canonical URL",
  category: "seo",
  severity: "medium",
  remediation:
    "Add a canonical link to the page's head section that points to this page's preferred web address.",
  select: (data) => fromServedHead(data.seo, (s) => s.canonicalUrl !== null),
  evaluate: (seo) =>
    seo.canonicalUrl === null
      ? fires("No canonical URL was declared on the affected page(s).")
      : passes,
});

/**
 * The lang attribute tells screen readers which pronunciation to use and
 * search engines which language to index the page as.
 */
export const langRule = defineRule<SeoData>({
  id: "seo.lang.missing",
  scope: "page",
  title: "No language declared",
  category: "seo",
  severity: "medium",
  remediation: 'Add a lang attribute to the <html> element, e.g. <html lang="en">.',
  select: (data) => fromServedHead(data.seo, (s) => s.langAttribute !== null),
  evaluate: (seo) =>
    seo.langAttribute === null
      ? fires("The <html> element has no lang attribute.")
      : passes,
});

// ---------------------------------------------------------------------------
// Body-based. Skipped when the served HTML carried too little text to judge.
// ---------------------------------------------------------------------------

/**
 * The h1 is the page's headline — what the content is about, in the content
 * itself rather than the browser tab.
 */
export const h1MissingRule = defineRule<SeoData>({
  id: "seo.h1.missing",
  scope: "page",
  title: "No main heading",
  category: "seo",
  severity: "medium",
  remediation: "Add a single <h1> naming what this page is about.",
  select: (data) => fromRenderedBody(data.seo),
  evaluate: (seo) =>
    seo.h1Count === 0 ? fires("The page contains no <h1> element.") : passes,
});

/**
 * More than one h1 leaves no single answer to "what is this page about".
 */
export const h1MultipleRule = defineRule<SeoData>({
  id: "seo.h1.multiple",
  scope: "page",
  title: "More than one main heading",
  category: "seo",
  severity: "medium",
  remediation:
    "Keep one <h1> per page and demote the others to <h2>, which is what they usually are.",
  select: (data) => fromRenderedBody(data.seo),
  evaluate: (seo) =>
    seo.h1Count > 1
      ? fires(
          `The page contains ${seo.h1Count} <h1> elements: ${
            seo.h1Texts.length > 0 ? seo.h1Texts.join(" · ") : "none of them with text"
          }.`,
        )
      : passes,
});

/**
 * An h1 element with no text inside it.
 *
 * Neither of the two rules above catches this: the element exists, so it is
 * not missing, and there may be only one, so it is not a duplicate. It is
 * usually an image-only heading or a leftover from a template, and it is
 * invisible in exactly the way that makes it survive for years.
 *
 * `h1Texts` holds only the headings that actually have text, so the gap
 * between it and `h1Count` is the measurement.
 */
export const h1EmptyRule = defineRule<SeoData>({
  id: "seo.h1.empty",
  scope: "page",
  title: "Main heading has no text",
  category: "seo",
  severity: "medium",
  remediation:
    "Put readable text inside the <h1>. If it is an image, the text can be the image's alt attribute.",
  select: (data) => fromRenderedBody(data.seo),
  evaluate: (seo) => {
    if (seo.h1Count === 0) return passes; // that is seo.h1.missing's job
    const empty = seo.h1Count - seo.h1Texts.length;
    return empty > 0
      ? fires(`${empty} of ${seo.h1Count} <h1> element(s) contain no text.`)
      : passes;
  },
});

/**
 * Headings are meant to read like a contents page: h1 the chapter, h2 the
 * sections, h3 below those. Jumping a level makes the structure harder for
 * screen readers and search engines to follow.
 */
export const headingOrderRule = defineRule<SeoData>({
  id: "seo.headings.order",
  scope: "page",
  title: "Heading levels skip a step",
  category: "seo",
  severity: "medium",
  remediation:
    "Use heading levels in order without gaps. Style them with CSS if a level looks wrong at its default size.",
  select: (data) => fromRenderedBody(data.seo),
  evaluate: (seo) =>
    seo.headingSkips.length > 0
      ? fires(
          seo.headingSkips.length === 1
            ? `1 place skips a heading level: ${seo.headingSkips.join("; ")}.`
            : `${seo.headingSkips.length} places skip a heading level: ${seo.headingSkips.join("; ")}.`,
        )
      : passes,
});

/**
 * Images with no alt attribute are invisible to screen readers and to image
 * search.
 *
 * Note what is NOT counted: an EMPTY alt (alt="") is the correct way to mark a
 * decorative image, and the collector already excludes it. Only a missing
 * attribute reaches here, so this never tells a client to "fix" something they
 * have already done right.
 */
export const imageAltRule = defineRule<SeoData>({
  id: "seo.images.alt",
  scope: "page",
  title: "Images without alt text",
  category: "seo",
  severity: "medium",
  remediation:
    'Add an alt attribute to each image describing it. Use alt="" for images that are purely decorative.',
  select: (data) => fromRenderedBody(data.seo),
  evaluate: (seo) =>
    seo.imagesMissingAlt > 0
      ? fires(
          `${seo.imagesMissingAlt} of ${seo.imageCount} image(s) have no alt attribute. Decorative images marked alt="" are not counted.`,
        )
      : passes,
});

/** Every SEO rule, head-based first. */
export const SEO_RULES = [
  viewportRule,
  titleRule,
  metaDescriptionRule,
  canonicalRule,
  langRule,
  h1MissingRule,
  h1MultipleRule,
  h1EmptyRule,
  headingOrderRule,
  imageAltRule,
] as const;
