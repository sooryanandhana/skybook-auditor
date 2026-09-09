/**
 * The type scale and the palette, in one place.
 *
 * 7A §16 fixes what matters and leaves the rest open. It requires body text at
 * 10 to 11 point with generous leading, a measure near 65 to 75 characters, a
 * single scale used consistently, tabular figures where digits line up,
 * embedded fonts, and addresses set in a monospace face that is allowed to
 * break. Every one of those is honoured below.
 *
 * WHAT IT DOES NOT FIX is the paper size, the margins and the exact sizes. The
 * numbers here are the ones recommended in the 7C evaluation and they are a
 * recommendation, not a requirement. They are gathered in this file rather
 * than spread through the components so the step that revisits them has one
 * place to look.
 *
 * SIX STEPS AND NO MORE. A scale earns its keep by being short enough that a
 * component has to pick one of its steps rather than invent a size. Report
 * title, section heading, group heading, finding title, body, caption.
 */
import { FONT_FACE_CSS, MONO, SANS, SERIF } from "./fonts.ts";
import { LOGO_BOX } from "./logo.ts";
import { PAGE_HEIGHT, PAGE_MARGIN } from "./settings.ts";

/**
 * How tall a page's content box is, once the margins are taken off.
 *
 * The cover is given exactly this height so it fills its page and its foot
 * sits on the bottom rule rather than wherever the content happened to end.
 * Computed rather than written down, so changing a margin moves the cover with
 * it instead of leaving it half a centimetre out.
 */
const CONTENT_HEIGHT = `calc(${PAGE_HEIGHT} - ${PAGE_MARGIN.top} - ${PAGE_MARGIN.bottom})`;

/**
 * The brand, from 7A §15.
 *
 * ONLY THE DEEP BLUE IS USED FOR TEXT. It is the one of the three that carries
 * enough contrast on white to be read at body size; the mid and bright blues
 * are for rules and accents, where 7A §24's 4.5:1 requirement does not apply
 * because nothing is being read from them.
 */
export const SKYBOOK_DEEP = "#264a9a";
export const SKYBOOK_MID = "#147ac3";
export const SKYBOOK_BRIGHT = "#05a2e4";

/** Ink, in three weights. Chosen for print on white rather than for a screen. */
const INK = "#16213a";
const INK_SOFT = "#4a5872";
const INK_FAINT = "#7c89a3";
const RULE = "#d5dfec";

/**
 * The whole stylesheet, fonts included.
 *
 * A single string because the page is set from a string: 7A §25 forbids the
 * renderer reaching the filesystem while rendering, and a linked stylesheet
 * would be a network request the page cannot make.
 */
export const STYLESHEET: string =
  FONT_FACE_CSS +
  `
  /*
   * NO @page MARGIN RULE HERE, deliberately. The margins are set by the
   * renderer when it asks for the PDF, and they have to be, because that is
   * also what reserves room for the running head and foot. A second margin
   * declared here would be a second answer to one question.
   */
  html { -webkit-print-color-adjust: exact; }

  body {
    margin: 0;
    font-family: ${SANS};
    font-size: 10.5pt;
    line-height: 1.55;
    color: ${INK};
    font-variant-numeric: tabular-nums;
  }

  /* The measure, held near 70 characters at this size and page width. */
  main { max-width: 68ch; }

  h1 { font-family: ${SERIF}; font-size: 30pt; font-weight: 600; line-height: 1.15; margin: 0; }
  h2 { font-family: ${SERIF}; font-size: 16pt; font-weight: 600; line-height: 1.25; margin: 0 0 6pt; }
  h3 {
    font-size: 9pt; font-weight: 600; line-height: 1.3;
    letter-spacing: .08em; text-transform: uppercase; color: ${INK_FAINT};
    margin: 0 0 5pt;
  }
  .finding-title { font-family: ${SERIF}; font-size: 12pt; font-weight: 600; line-height: 1.3; }

  p { margin: 0 0 8pt; }
  .note { font-size: 8.5pt; line-height: 1.45; color: ${INK_SOFT}; }

  /*
   * Addresses break mid-string rather than pushing the page sideways, which
   * 7A §16 requires by name. A long path is the usual cause.
   */
  .url { font-family: ${MONO}; font-size: 8.5pt; line-height: 1.45; overflow-wrap: anywhere; }

  /* ---------- the cover ---------- */

  .cover {
    /* Its own page, per 7A §18, and exactly one page tall. */
    break-after: page;
    height: ${CONTENT_HEIGHT};
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  /*
   * The mark. The box is exactly the artwork's ink, with the artwork scaled
   * uniformly inside it and offset so its white padding falls outside. Both
   * dimensions come from one measured width, so the aspect ratio cannot drift
   * and nothing is ever stretched.
   */
  .logo {
    position: relative;
    width: ${LOGO_BOX.width}mm;
    height: ${LOGO_BOX.height}mm;
    overflow: hidden;
  }
  .logo img {
    position: absolute;
    left: -${LOGO_BOX.offsetLeft}mm;
    top: -${LOGO_BOX.offsetTop}mm;
    width: ${LOGO_BOX.imageWidth}mm;
    /* Height follows the width, so the square stays square. */
    height: auto;
  }

  .cover-main { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .cover h1 { text-wrap: balance; max-width: 22ch; }
  .cover .for { margin: 0 0 4pt; }
  .cover .client { font-size: 15pt; font-weight: 600; line-height: 1.3; margin: 0; }
  .cover .contact { font-size: 11pt; color: ${INK_SOFT}; margin: 2pt 0 0; }
  .cover .site { margin: 14pt 0 0; }
  .cover .redirect { margin: 3pt 0 0; }

  /*
   * The partial marker. Words carry it, not the colour: 7A §24 requires the
   * document to survive being printed in greyscale, and 7A §13 forbids a
   * partial crawl being shown as a whole-site audit anywhere.
   */
  .partial {
    display: inline-block;
    border: 1pt solid ${SKYBOOK_DEEP};
    color: ${SKYBOOK_DEEP};
    border-radius: 2pt;
    padding: 2pt 5pt;
    font-size: 8.5pt;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    margin: 0 0 10pt;
  }

  .cover-foot { border-top: .75pt solid ${RULE}; padding-top: 7pt; }
  .cover-foot p { margin: 0 0 2pt; }
  .cover-foot p:last-child { margin-bottom: 0; }

  /* ---------- body pages ---------- */

  /*
   * TEMPORARY. One section per page makes the running head, the running foot
   * and "page n of m" observable on a real multi-page document. 7A §18 decides
   * the real page breaks, at 7C-6.
   */
  section + section { break-before: page; }
`;
