/**
 * Reading the links out of a page's HTML.
 *
 * DELIBERATELY THE DUMBEST FILE IN THE CRAWLER. It returns the `href` text of
 * every `<a>` element, in document order, and makes no decision about any of
 * them. It does not resolve them, does not judge their scheme, does not know
 * what site we are on, and does not know which pages have been seen.
 *
 * That is the point. Every one of those decisions already exists exactly once:
 * resolution and validation in `normalizeCrawlUrl`, the same-site rule in
 * `isSameSite`, de-duplication and the queue limits in the frontier. A link
 * extractor that started making its own judgements would be a second copy of
 * rules that must not be allowed to disagree with the first.
 *
 * WHY CHEERIO, AND WHY NOT A REGULAR EXPRESSION
 *
 * Cheerio is already a dependency and already parses HTML for the SEO and
 * security checks, so nothing new was added for this. It parses markup the way
 * a browser's parser does, which matters more here than it first appears: an
 * href can contain a quoted `>`, an `<a>` can be unclosed, an attribute can be
 * unquoted or spread across lines, and links can sit inside comments or
 * `<script>` blocks. A regular expression gets those wrong in both directions —
 * missing real pages, and inventing addresses that only exist inside a comment.
 * Neither mistake is acceptable in something that decides what we fetch.
 *
 * WHAT IS NOT READ HERE, ON PURPOSE
 *
 *   <link rel="canonical">   a canonical tag is a claim about identity, not
 *                            permission to crawl. A page can name any address
 *                            it likes, including one on someone else's domain.
 *   <area>, <iframe>, <form> not anchors. Out of scope for this stage.
 *   anything JavaScript adds  never executed, so never seen.
 *
 * `<base href>` IS read, but only reported — never applied. Deciding whether a
 * base is usable, and resolving anything against it, happens in the crawler
 * where every other address decision already lives.
 */
import * as cheerio from "cheerio";

/**
 * The most links READ FROM ONE PAGE'S MARKUP.
 *
 * AN EXTRACTION SAFETY LIMIT, AND NOTHING ELSE. It is not a crawl limit, it
 * does not bound the site, and it replaces neither `maxPages` nor
 * `maxQueueSize` — those decide how much of a site gets audited and are the
 * only limits that make a crawl report itself partial. This one exists purely
 * so that parsing a single hostile or generated document cannot produce an
 * unbounded array: a calendar or a faceted product filter can emit a hundred
 * thousand anchors, and every one of them would otherwise be remembered by the
 * frontier for the rest of the crawl.
 *
 * Reaching it is therefore NOT a reason to call a crawl partial, and nothing
 * reports it. Five thousand links is far beyond any real page's navigation; a
 * page that exceeds it is generated, and the pages past the cut are
 * overwhelmingly more of the same generated thing.
 */
export const MAX_LINKS_PER_PAGE = 5_000;

export interface PageLinks {
  /**
   * The first `<base href>` in the document, exactly as written, or null.
   *
   * Reported, not applied: whether it is usable, and what it resolves to, is
   * decided by the caller. It can be relative, absolute, malformed, or point at
   * another site entirely, and this file judges none of that.
   */
  baseHref: string | null;
  /** Every `<a href>`, trimmed, in document order. */
  hrefs: string[];
}

/**
 * Reads the addresses a page's markup mentions.
 *
 * The order of `hrefs` is load-bearing: the frontier is FIFO, so document order
 * is the order pages get crawled in, and a site's own navigation comes first.
 *
 * Nothing is resolved here. The caller resolves against the page's FINAL url —
 * the address we actually ended up reading, after any redirects — or against
 * `baseHref` when the page carries a usable one.
 *
 * Empty and whitespace-only hrefs are dropped, because they name no address.
 * Everything else is passed through exactly as written, including `javascript:`
 * and nonsense — refusing those is `normalizeCrawlUrl`'s job, and doing it here
 * as well would mean two lists of unsafe schemes to keep in step.
 */
export function extractLinks(html: string): PageLinks {
  const $ = cheerio.load(html);

  /*
   * A <template> IS NOT PART OF THE PAGE, so the links in it are not links.
   *
   * The browser parses a template and then leaves it alone: nothing inside is
   * rendered, nothing is clickable, and a search engine follows none of it.
   * What it usually holds is a pattern waiting to be filled in — markup like
   *
   *     <a href="/product/{{id}}">
   *
   * which is not an address at all. Discovering those queued them for
   * crawling, spent page budget fetching addresses that cannot exist, and then
   * listed the failures in the report as pages of the client's site that could
   * not be read. It also inflated `discovered`, which is the denominator
   * behind "N of M pages found on this site were read".
   *
   * REMOVED BEFORE ANYTHING IS SELECTED, deliberately. Filtering the addresses
   * afterwards would mean teaching the crawler to recognise placeholder syntax
   * — a guess about what a URL means. Dropping the element instead is not a
   * guess: the markup already said this content is inert.
   *
   * This is the same reasoning, and the same one-line remedy, that the SEO
   * checks already apply before counting headings and images. A nested
   * template goes with its parent, since removing an element removes what is
   * inside it.
   *
   * <noscript> IS LEFT ALONE. Its contents are already absent from what is
   * selected here, and changing that is not this function's business.
   */
  $("template").remove();

  // The FIRST base element wins, as it does in a browser. A second one is
  // ignored rather than merged; a document with two is already malformed, and
  // guessing which the author meant would be inventing an answer.
  const rawBase = $("base[href]").first().attr("href")?.trim();
  const baseHref = rawBase === undefined || rawBase === "" ? null : rawBase;

  const hrefs: string[] = [];
  for (const element of $("a[href]").toArray()) {
    if (hrefs.length >= MAX_LINKS_PER_PAGE) break;

    const href = $(element).attr("href")?.trim();
    if (href === undefined || href === "") continue;

    hrefs.push(href);
  }

  return { baseHref, hrefs };
}
