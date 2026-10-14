/**
 * The largest page this server will analyse, and what is said about one larger.
 *
 * TWO LIMITS, FOR TWO DIFFERENT THINGS. The download limit (5 MB, in
 * fetchPage.ts) bounds what is read off the network, and it is enforced while
 * the page is still arriving. This one bounds what is PARSED. Parsing turns a
 * page into a tree of objects many times the size of its markup -- measured at
 * roughly a hundred times or more for dense HTML -- and a single page well
 * under the download limit was enough to exhaust the production server's
 * JavaScript heap on its own. A page above this size is downloaded, counted
 * and named in the report, and is not parsed.
 *
 * NOT A PASS, NOT A FAILURE. A page too large to analyse has had nothing
 * checked on it. It is recorded with the pages that could not be read, which
 * is where the rest of the application already keeps "nothing was measured
 * here": it is never graded, never counted as clean, and never followed for
 * further links, because finding them would mean parsing it.
 *
 * Its own module, with no imports, because the report layer reads the
 * sentence below to tell these pages apart from unreadable ones, and the
 * report layer is also used in the browser, where the crawler cannot go.
 */

/** 1.5 MB of markup, measured as UTF-8. Above this a page is not parsed. */
export const MAX_ANALYSIS_BYTES = 1_500_000;

/** The reason recorded for a page larger than the analysis limit. */
export const TOO_LARGE_TO_ANALYSE =
  "This page is larger than 1.5 MB, so it was too large to analyse: none of its checks were run, and links on it were not followed.";
