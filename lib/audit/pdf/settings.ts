/**
 * The page itself: size, margins, and how long a render may take.
 *
 * ALMOST EVERYTHING HERE IS TEMPORARY AND SAYS SO. 7A specifies the body text
 * size, the leading and the measure (§16), and it specifies what the running
 * head and foot carry (§20). It does not specify a paper size, an orientation
 * or a margin, and 7C-1 is not the step that decides them. The values below
 * are the smallest set that lets a page render at all, marked so that the step
 * which does decide them can find them.
 */

/**
 * TEMPORARY. A4 portrait.
 *
 * Chosen because it is the paper the rest of the world outside North America
 * prints on, and because a foundation needs some size to lay out against. The
 * real decision belongs with whoever knows where these reports get printed.
 */
export const PAGE_FORMAT = "a4";

/**
 * TEMPORARY, and the same paper as `PAGE_FORMAT`.
 *
 * Stated as a length so the stylesheet can work out how tall a page's content
 * box is and give the cover exactly that height. The alternative was `100vh`,
 * which resolves against the page box in print but does so by a route worth
 * less trust than arithmetic on two numbers this file already owns.
 *
 * IT MUST AGREE WITH `PAGE_FORMAT`, and a test asserts they describe the same
 * paper, because two constants that must match will eventually not.
 */
export const PAGE_HEIGHT = "297mm";

/** A4 is 210mm wide. Beside the height, for the one page that fills the sheet. */
export const PAGE_WIDTH = "210mm";

/**
 * TEMPORARY, and measured rather than guessed.
 *
 * The top and bottom margins are what reserve room for the running head and
 * foot, which are drawn inside them; see `runningHeadFoot.ts`. They were
 * measured for the header and footer templates this report used to have, which
 * Chromium drew whether or not the margin left space for them, and they are
 * kept because the head and foot still sit at the same heights.
 */
export const PAGE_MARGIN = {
  top: "24mm",
  bottom: "20mm",
  left: "18mm",
  right: "18mm",
} as const;

/**
 * How long one render may take before it is abandoned.
 *
 * 7A §23 gives the renderer its own budget, separate from the audit's and the
 * model's, and forbids a retry: a second attempt at a deterministic render of
 * the same data fails the same way. This is that budget. It covers the whole
 * call, browser launch included, because a launch that hangs is exactly the
 * failure a budget is for.
 */
export const PDF_RENDER_BUDGET_MS = 20_000;
