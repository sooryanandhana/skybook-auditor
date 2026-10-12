/**
 * The running head and foot, and the page number.
 *
 * 7A §20 fixes what these carry. The head is the Skybook mark, the audited
 * site, and "Partial audit" when the crawl was incomplete -- repeated on every
 * page after the cover, so a page read on its own cannot be mistaken for a
 * whole-site result. The foot is the audit date and "page n of m". The audit
 * date, not the generation date: what matters is when the site was measured.
 *
 * THEY ARE PART OF THE DOCUMENT, DRAWN IN THE PAGE MARGINS BY CSS. Each of the
 * four is a page-margin box: `@top-left`, `@top-right`, `@bottom-left` and
 * `@bottom-right` inside an `@page` rule. The page number comes from CSS's own
 * `counter(page)` and `counter(pages)`, so there is still no counting on our
 * side. Chrome has drawn margin boxes since version 131; this was verified on
 * the Chrome 152 that Puppeteer 25 installs.
 *
 * WHY NOT CHROMIUM'S HEADER AND FOOTER TEMPLATES, which this file used to
 * build. Two reasons, both measured rather than read:
 *
 *   1. A template is drawn on every page and nothing can switch it off for
 *      one. The cover runs to the paper edge, and it carried the mark, the
 *      address, the date and "Page 1 of n" printed across its artwork. A page
 *      rule can name the first page, so a margin box can simply be empty there.
 *
 *   2. A template renders in a context of its own and cannot reach the
 *      document's embedded faces, so those two lines were the one part of the
 *      file whose typeface depended on the machine that produced it. A margin
 *      box belongs to the document and uses the embedded sans like everything
 *      else.
 *
 * THE COVER HAS NONE OF IT, deliberately. Its own page already carries the
 * mark, the audited address, the audit date and, when it applies, the partial
 * marker, in larger type than a margin could hold. 7A §20's purpose -- that no
 * page can be mistaken for a whole-site result -- is met there by the cover
 * itself.
 *
 * THE MARGINS THEMSELVES ARE STILL THE RENDERER'S. This file declares what is
 * drawn in the margins and never how large they are; see `PAGE_MARGIN`. The one
 * margin the stylesheet does set is the cover's, to nothing.
 *
 * THE MARK IS TYPESET, NOT DRAWN. The artwork sits on the cover, where it has
 * room to be read. Here the mark is a word, because 8pt of artwork in a page
 * margin is a smudge.
 *
 * NOT A CONFORMANCE CLAIM. Whether these lines are marked as artifacts, so a
 * screen reader skips them between sections, has not been established. This
 * project still claims a tagged, navigable document and does NOT claim PDF/UA
 * conformance.
 */
import { SANS } from "./fonts.ts";
import { PAGE_MARGIN, PAGE_WIDTH } from "./settings.ts";
import { fitSans, sansWidthMm } from "./textWidth.ts";

/** What the head repeats on every page. */
export interface RunningHead {
  /** The address that was audited, already credential-stripped by 7B. */
  readonly auditedUrl: string;
  /** True when the crawl did not finish. §20 requires this on every page. */
  readonly partial: boolean;
}

/** What the foot repeats on every page. */
export interface RunningFoot {
  /**
   * When the site was measured, already phrased by the projection. Never when
   * the PDF was made, and never a stored timestamp. Null when the audit's own
   * timestamp could not be read, in which case the foot carries the page
   * number alone rather than an empty label.
   */
  readonly auditDate: string | null;
}

/**
 * A value from the document, as a CSS string.
 *
 * THE ADDRESS CAME FROM SOMEBODY ELSE'S WEBSITE, and this puts it inside a
 * stylesheet inside a page. Two things could go wrong there. A quote or a
 * backslash could end the string and start a declaration of its own; and the
 * letters `</style>` could end the stylesheet and start markup, because the
 * HTML parser reads a style element's text before CSS ever sees it.
 *
 * So nothing but plain letters and digits is written as itself. Every other
 * character is written as a CSS escape: a backslash and its code point in six
 * hexadecimal digits, which is the length that needs nothing after it to end
 * it. A space is escaped too, because CSS swallows one space after an escape
 * and a real space following one would vanish. A reader sees the same
 * characters; neither parser sees anything it could act on. This is the
 * counterpart, for CSS, of `escapeHtml`.
 */
export function cssString(value: string): string {
  let out = "";
  for (const character of value) {
    out += /^[A-Za-z0-9]$/.test(character)
      ? character
      : `\\${character.codePointAt(0)!.toString(16).padStart(6, "0")}`;
  }
  return `"${out}"`;
}

/*
 * Shared styling for all four boxes. The size is stated because a margin box
 * would otherwise take the root's, and these are captions, not body text.
 */
const SIZE_PT = 8;
const BOX = [`font-family:${SANS}`, `font-size:${SIZE_PT}pt`, "line-height:1.3", "color:#4a5872", "white-space:nowrap"].join(";");

/*
 * WHERE THE LINES SIT. The head hangs just below the top of the sheet and the
 * foot stands just above the bottom, each clear of the text by most of its
 * margin. These are the heights the lines have always had.
 */
const HEAD = `${BOX};vertical-align:top;padding-top:5.3mm`;
const FOOT = `${BOX};vertical-align:bottom;padding-bottom:4.9mm`;

/** The mark, in spaced capitals, as every section label in the report is set. */
const MARK = "SKYBOOK";
const MARK_SPACING_EM = 0.22;

/** What follows the address when the crawl did not finish. */
const PARTIAL_MARKER = " · Partial audit";

/** The clear space kept between the mark and whatever stands to its right. */
const HEAD_GAP_MM = 6;

/**
 * How much of the measured room the address may use.
 *
 * The width of a line is read from the font file, and that agrees with what the
 * browser lays out to within half a percent at this size. Two percent is held
 * back so the difference can never be what makes a line touch.
 */
const HEAD_FILL = 0.98;

/**
 * How wide the head is: the sheet, less the left and right margins.
 *
 * Taken from the same constants the renderer prints with, so a change to the
 * paper or a margin moves this with it.
 */
export const HEAD_WIDTH_MM =
  Number.parseFloat(PAGE_WIDTH) - Number.parseFloat(PAGE_MARGIN.left) - Number.parseFloat(PAGE_MARGIN.right);

/**
 * The room the address has, in millimetres, on a partial or a complete audit.
 *
 * WHAT IS LEFT AFTER EVERYTHING THAT MUST BE THERE. The mark is always on the
 * left and the partial marker, when it applies, is always on the right, because
 * 7A §20 requires both on every page. The address gets the space between, less
 * a gap.
 */
export function headAddressRoomMm(partial: boolean): number {
  const mark = sansWidthMm(MARK, SIZE_PT, MARK_SPACING_EM);
  const marker = partial ? sansWidthMm(PARTIAL_MARKER, SIZE_PT) : 0;
  return (HEAD_WIDTH_MM - mark - HEAD_GAP_MM - marker) * HEAD_FILL;
}

/**
 * The address as the head shows it: whole, or cut short and saying so.
 *
 * THE HEAD IS ONE LINE, AND IT HAS TO STAY ONE. A margin box has no room to
 * wrap: an address too wide for it ran across the mark on its left and off the
 * edge of the sheet, taking "Partial audit" with it.
 *
 * FITTED BY WIDTH, NOT BY COUNTING. Eighty characters of "i" and eighty of "W"
 * differ by a factor of more than three, so a limit in characters either cuts
 * ordinary addresses that would have fitted or lets wide ones through. The
 * address is measured in the face it is set in and kept as long as it fits.
 *
 * NEVER SILENTLY. A shortened address ends in an ellipsis, so it cannot be
 * taken for the whole one. The full address is on the cover and in the
 * document's title; the head only has to say which site this page is about.
 */
function headAddress(url: string, partial: boolean): string {
  return fitSans(url, SIZE_PT, headAddressRoomMm(partial));
}

/**
 * The rules that draw the head and foot, for one document.
 *
 * TWO RULES. The first puts the four lines on every page. The second names the
 * first page -- the cover -- and empties all four, so the cover carries nothing
 * in its margins. Neither sets a margin: the renderer's still apply to every
 * page, and the cover's is lifted by the stylesheet.
 *
 * COLOUR AND SPACING, NOT WEIGHT, set the mark apart: the brand's deep blue, in
 * the same spaced capitals as the label above every section title.
 */
export function runningHeadFootCss(head: RunningHead, foot: RunningFoot): string {
  const address = headAddress(head.auditedUrl, head.partial);
  const site = head.partial ? `${address}${PARTIAL_MARKER}` : address;
  const date = foot.auditDate === null ? "none" : cssString(foot.auditDate);

  return (
    `@page{` +
    `@top-left{content:"${MARK}";${HEAD};color:#264a9a;letter-spacing:${MARK_SPACING_EM}em}` +
    `@top-right{content:${cssString(site)};${HEAD}}` +
    `@bottom-left{content:${date};${FOOT}}` +
    `@bottom-right{content:"Page " counter(page) " of " counter(pages);${FOOT}}` +
    `}` +
    `@page :first{` +
    `@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-right{content:none}` +
    `}`
  );
}
