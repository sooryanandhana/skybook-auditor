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
const LINE_SOFT = "#e7edf6";

/**
 * The four severities, as colours.
 *
 * DARK ENOUGH TO BE READ, because the chip's own text takes this colour and 7A
 * §24 asks for 4.5:1 on anything a reader reads. They are the same four the
 * specification documents use.
 *
 * THE COLOUR IS NEVER THE MESSAGE. Every place one of these appears, the
 * severity's word appears with it. The document has to survive a greyscale
 * printer and a reader who does not distinguish these hues, and it does,
 * because removing all four colours would lose nothing but emphasis.
 */
const SEVERITY = {
  critical: "#a4262c",
  high: "#a85411",
  medium: "#7d6413",
  good: "#1f7a55",
} as const;

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

  /* ---------- sections ---------- */

  section { margin: 0 0 10pt; }
  .lead { max-width: 68ch; }
  h2 { margin-top: 0; }
  .group + .group { margin-top: 12pt; }
  .group h3 { margin-top: 0; }

  /* ---------- the severity split ---------- */

  .tiles { display: flex; gap: 6pt; margin: 0 0 12pt; }
  .tile {
    flex: 1;
    border: .75pt solid ${RULE};
    border-top: 2.5pt solid currentColor;
    border-radius: 2pt;
    padding: 6pt 8pt;
  }
  .tile-count {
    display: block;
    font-size: 20pt;
    font-weight: 600;
    line-height: 1.1;
    color: ${INK};
  }
  /* The word, always, so the colour is never the only carrier. 7A §24. */
  .tile-label {
    display: block;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    margin-top: 2pt;
  }
  .tile-critical { color: ${SEVERITY.critical}; }
  .tile-high { color: ${SEVERITY.high}; }
  .tile-medium { color: ${SEVERITY.medium}; }
  .tile-good { color: ${SEVERITY.good}; }

  /* ---------- AI text, always subordinate ---------- */

  .ai { border-left: 2pt solid ${RULE}; padding-left: 8pt; margin: 0 0 10pt; }
  .ai-summary { max-width: 68ch; }
  .ai-label {
    font-size: 8pt; font-weight: 600; letter-spacing: .07em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 3pt;
  }
  .ai-sub {
    font-size: 8.5pt; font-weight: 600; color: ${INK_SOFT}; margin: 6pt 0 2pt;
  }
  .ai-note { font-size: 8pt; color: ${INK_FAINT}; max-width: 68ch; margin: 6pt 0 0; }

  /* ---------- a finding ---------- */

  .finding {
    display: block;
    border: .75pt solid ${RULE};
    border-radius: 3pt;
    padding: 8pt 10pt;
    margin: 0 0 7pt;
  }
  .finding-head { display: flex; gap: 6pt; align-items: baseline; }
  .finding-title { margin: 0; }

  /*
   * The chip. Border and text take the severity's colour and the word sits
   * inside, so greyscale and colour-blind readers both still get it.
   */
  .chip {
    flex-shrink: 0;
    border: .75pt solid currentColor;
    border-radius: 2pt;
    padding: 1pt 4pt;
    font-size: 7.5pt;
    font-weight: 600;
    letter-spacing: .05em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .chip-critical { color: ${SEVERITY.critical}; }
  .chip-high { color: ${SEVERITY.high}; }
  .chip-medium { color: ${SEVERITY.medium}; }
  .chip-good { color: ${SEVERITY.good}; }

  .finding-meta { font-size: 8.5pt; color: ${INK_SOFT}; margin: 3pt 0 5pt; }
  .finding-meta .reach::before { content: " · "; }
  .evidence { max-width: 68ch; margin: 0 0 6pt; }

  /* A rule and an indent separate what was measured from what to do. 7A §17. */
  .remediation { border-left: 2pt solid ${SKYBOOK_MID}; padding-left: 8pt; margin: 0 0 6pt; }
  .remediation-label {
    font-size: 8pt; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 2pt;
  }
  .remediation p:last-child { margin: 0; max-width: 68ch; }

  /*
   * The affected pages, run together rather than stacked. Fifty addresses on
   * one line each, across two dozen findings, would be most of the document.
   */
  .affected { margin: 0 0 6pt; }
  .affected-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: ${MONO};
    font-size: 7.5pt;
    line-height: 1.5;
    color: ${INK_SOFT};
  }
  .affected-list li { display: inline; overflow-wrap: anywhere; }
  .affected-list li + li::before { content: "  ·  "; color: ${INK_FAINT}; }
  .affected .note { margin: 3pt 0 0; }

  .commentary { border-left: 2pt solid ${RULE}; padding-left: 8pt; }
  .commentary p:last-child { margin-bottom: 0; }
  .commentary p { max-width: 68ch; }

  /* ---------- fact tables ---------- */

  .facts { width: 100%; border-collapse: collapse; margin: 0 0 8pt; }
  .facts th, .facts td { text-align: left; vertical-align: top; padding: 3.5pt 8pt 3.5pt 0; }
  .facts thead th {
    font-size: 7.5pt; font-weight: 600; letter-spacing: .07em;
    text-transform: uppercase; color: ${INK_FAINT};
    border-bottom: .75pt solid ${RULE};
  }
  .facts tbody th { font-weight: 400; color: ${INK_SOFT}; width: 40%; }
  .facts tbody td { color: ${INK}; }
  .facts tbody tr + tr th, .facts tbody tr + tr td { border-top: .5pt solid ${LINE_SOFT}; }
  .fact-note { display: block; font-size: 8pt; color: ${INK_FAINT}; }

  /* ---------- body pages ---------- */

  /*
   * TEMPORARY. One section per page makes the running head, the running foot
   * and "page n of m" observable on a real multi-page document. 7A §18 decides
   * the real page breaks, at 7C-6.
   */
  section + section { break-before: page; }
`;
