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
import { COVER_ADDRESS, COVER_COLUMN_MM, COVER_REDIRECT } from "./cover.ts";
import { LOGO_BOX } from "./logo.ts";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./settings.ts";

/**
 * The brand, from 7A §15.
 *
 * MEASURED ON WHITE, not judged: deep 8.31:1, mid 4.56:1, bright 2.88:1.
 *
 * Only the deep blue is set on text. The mid blue would in fact clear 7A §24's
 * 4.5:1 -- an earlier comment here claimed it could not, and the contrast test
 * proved that wrong -- but it is kept for rules and accents anyway, because a
 * ratio of 4.56 leaves nothing spare and the deep blue is there for reading.
 * The bright blue genuinely cannot be read at body size, and a test asserts it
 * never becomes a text colour.
 */
export const SKYBOOK_DEEP = "#264a9a";
export const SKYBOOK_MID = "#147ac3";
export const SKYBOOK_BRIGHT = "#05a2e4";

/** Ink, in three weights. Chosen for print on white rather than for a screen. */
const INK = "#16213a";
const INK_SOFT = "#4a5872";
/*
 * DARKENED BECAUSE A TEST MEASURED IT. This was #7c89a3, which is 3.52:1 on
 * white and fails 7A §24's 4.5:1 outright. It was chosen by eye and looked
 * right, which is exactly how one value in a palette ends up wrong while every
 * other passes. It carries every caption, label and column heading in the
 * document, so it is read constantly. Now 4.64:1.
 */
const INK_FAINT = "#68758e";
const RULE = "#d5dfec";

/*
 * THE REPORT'S SURFACES, and there are only three besides white paper. None is
 * ever set on body text, so the contrast rule in `accessibility.test.mts` (which
 * measures every TEXT_COLOURS entry against the paper) does not reach them.
 */
/** The thin outline of a card, and the rule under a table row. */
const HAIRLINE = "#dde1e6";
/** The flat pale ground of a panel: advice, and anything a model wrote. */
const PANEL = "#f5f6f8";
/** The one dark card on the executive summary. Its text is white, read on it. */
const CHARCOAL = "#1b1e23";

/*
 * THE COVER, MEASURED FROM THE APPROVED ARTWORK and scaled to A4. The navy is
 * the artwork's own ground, and it is also the title's colour, read on white at
 * about 17:1.
 */
const COVER_NAVY = "#0d1a33";
/*
 * The colour of the cover's small labels. The artwork sets them in the brand's
 * bright blue, which is 2.88:1 on white and cannot be read at this size. This is
 * the same hue taken darker until it can: 4.67:1, measured by the contrast test
 * like every other colour set on text.
 */
const COVER_LABEL = "#047cae";
/*
 * Where the cover's figure sits, in millimetres. `boundary` is where the white
 * panel ends and the navy begins, and it is also the centre of the circles, so
 * the white panel hides their left halves. `centre` is how far down the sheet
 * that centre is. The other three are radii: the blue ring's outer edge, the
 * dark outline's outer edge, and the white disc.
 */
const COVER = { boundary: 92, centre: 150, ring: 103.7, outline: 83.8, disc: 75.6 } as const;
/** A circle of the given radius about the figure's centre, as CSS. */
const circleAt = (radius: number): string => {
  const mm = (value: number) => `${Math.round(value * 10) / 10}mm`;
  return (
    `left: ${mm(COVER.boundary - radius)}; top: ${mm(COVER.centre - radius)}; ` +
    `width: ${mm(radius * 2)}; height: ${mm(radius * 2)};`
  );
};

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

/** The paper. Every colour below is read against this and nothing else. */
export const PAPER = "#ffffff";

/**
 * Every colour the document sets on text, and what it is used for.
 *
 * EXPORTED SO THE CONTRAST CAN BE MEASURED RATHER THAN TRUSTED. 7A §24 asks
 * for 4.5:1 on body text against its background. These were originally chosen
 * by eye, which is exactly the sort of judgement that turns out to be wrong on
 * the one value nobody checked, so a test computes the real ratio for each.
 *
 * WHAT IS NOT HERE. The mid and bright brand blues, which are used for rules
 * and borders. Nothing is read from a rule, so the requirement does not apply
 * to them, and a test asserts they never appear as a text colour.
 */
export const TEXT_COLOURS: Readonly<Record<string, string>> = {
  body: INK,
  secondary: INK_SOFT,
  caption: INK_FAINT,
  mark: SKYBOOK_DEEP,
  coverLabel: COVER_LABEL,
  critical: SEVERITY.critical,
  high: SEVERITY.high,
  medium: SEVERITY.medium,
  good: SEVERITY.good,
};

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
    font-size: 10pt;
    line-height: 1.55;
    color: ${INK};
    font-variant-numeric: tabular-nums;
  }

  /*
   * THE PAGE IS USED FULL WIDTH; THE READING IS NOT. Cards, tables and the rows
   * of figures run from margin to margin, as an editorial report's do. Running
   * prose is still held to a measure of about seventy characters, which is what
   * 7A §16 asks for and what makes a paragraph comfortable to read.
   *
   * The sections are numbered by the page itself, in the order they are drawn,
   * so a report with a section left out still counts one, two, three.
   */
  main { counter-reset: section; }
  p { margin: 0 0 3mm; max-width: 72ch; }

  h1 { font-family: ${SERIF}; font-size: 30pt; font-weight: 600; line-height: 1.15; margin: 0; }
  /* A major section heading: the largest type after the cover, in the serif's
     heaviest bundled weight (SemiBold -- no heavier face ships with the report). */
  h2 { font-family: ${SERIF}; font-size: 24pt; font-weight: 600; line-height: 1.15; color: ${INK}; margin: 0 0 6mm; }
  /* The small spaced label: a group of findings, a table, a list of notes. */
  h3 {
    font-size: 7.5pt; font-weight: 600; line-height: 1.3;
    letter-spacing: .16em; text-transform: uppercase; color: ${INK_FAINT};
    margin: 0 0 2.5mm;
  }
  /* A sub-heading inside a section, in the body's own face. */
  h3.sub {
    font-size: 12pt; letter-spacing: 0; text-transform: none; color: ${INK};
    margin: 0 0 2.5mm;
  }
  .finding-title { font-family: ${SERIF}; font-size: 12.5pt; font-weight: 600; line-height: 1.3; }

  .note { font-size: 8.5pt; line-height: 1.5; color: ${INK_SOFT}; }

  /*
   * Addresses break mid-string rather than pushing the page sideways, which
   * 7A §16 requires by name. A long path is the usual cause.
   */
  .url { font-family: ${MONO}; font-size: 8.5pt; line-height: 1.45; overflow-wrap: anywhere; }

  /* ---------- the cover ---------- */

  /*
   * THE COVER RUNS TO THE PAPER EDGE, AND ONLY THE COVER. Every other page keeps
   * the margins the renderer sets, which are also what make room for the running
   * head and foot. This rule lifts them for the first page alone, so the panels
   * and the strip reach the edge of the sheet. It names the first page and
   * nothing else: the general page margin is still the renderer's and is still
   * not declared here.
   */
  @page :first { margin: 0; }

  /*
   * A white panel on the left, a navy ground on the right, a blue strip standing
   * on the boundary from the top of the sheet to the bottom, and one circular
   * figure centred on that same boundary. Every measurement below is taken from
   * the approved cover artwork, scaled to A4. The cover is exactly one sheet and
   * clips its own overflow.
   */
  .cover {
    /* Its own page, per 7A §18, and exactly one sheet tall. */
    break-after: page;
    width: ${PAGE_WIDTH};
    height: ${PAGE_HEIGHT};
    box-sizing: border-box;
    position: relative;
    overflow: hidden;
    background: ${COVER_NAVY};
  }

  /*
   * The figure. Four shapes, back to front: the strip, a broad blue ring, a navy
   * disc that leaves the ring showing as a band, and a near-white disc inside
   * that. All four are centred on the panel boundary, so the white panel drawn
   * after them hides their left halves and the white disc reads as the panel
   * swelling out to the right.
   */
  .cover-figure { position: absolute; inset: 0; }
  .cover-figure span { position: absolute; display: block; }
  /* Brightest where it meets the ring, deepening toward the top and bottom edge. */
  .cover-strip {
    left: ${COVER.boundary}mm; top: 0; width: 21.7mm; height: 100%;
    background: linear-gradient(180deg, #0a5380 0%, #079bdf 15.5%, #079bdf 84.5%, #0a5380 100%);
  }
  /*
   * The ring's colour has two parts, layered. Underneath, the blue runs across
   * the ring from bright where it meets the strip to a deep blue at the far
   * right, where it melts into the navy ground and has no hard edge. Over that
   * it darkens toward its outer rim. Only the right half is ever seen, so the
   * gradient starts at the middle.
   *
   * PLAIN LINEAR AND RADIAL GRADIENTS ONLY. A conic gradient drew the same ring
   * and produced a file Chromium's own PDF viewer could not open.
   */
  .cover-ring {
    ${circleAt(COVER.ring)} border-radius: 50%;
    background:
      radial-gradient(circle closest-side, rgba(13, 26, 51, 0) 81%, rgba(13, 26, 51, .54) 100%),
      linear-gradient(90deg,
        #0695d5 51.5%, #1172b6 71%, #18569e 79.6%, #16407c 86%, #15305e 92%, ${COVER_NAVY} 100%);
  }
  /* The dark outline round the white disc: the navy ground showing through. */
  .cover-outline {
    ${circleAt(COVER.outline)} border-radius: 50%;
    background: ${COVER_NAVY};
  }
  /* White where it joins the panel, shading very slightly toward its right rim. */
  .cover-disc {
    ${circleAt(COVER.disc)} border-radius: 50%;
    background: linear-gradient(90deg, ${PAPER} 50%, #edf0f4 100%);
  }

  /*
   * The white panel, and on it everything a reader reads. The blocks are placed
   * from the top of the sheet at the heights the artwork gives them. The panel
   * does not clip, because the title is wider than the panel and runs on over
   * the white disc, exactly as drawn.
   */
  .cover-left {
    position: absolute; left: 0; top: 0;
    width: ${COVER.boundary}mm; height: 100%;
    box-sizing: border-box;
    background: ${PAPER};
  }
  .cover-left > * { position: absolute; left: 22.2mm; }

  /*
   * The mark. The box is exactly the artwork's ink, with the artwork scaled
   * uniformly inside it and offset so its white padding falls outside. Both
   * dimensions come from one measured width, so the aspect ratio cannot drift
   * and nothing is ever stretched.
   */
  .logo {
    width: ${LOGO_BOX.width}mm;
    height: ${LOGO_BOX.height}mm;
    overflow: hidden;
  }
  .cover-left > .logo { left: 21.7mm; top: 24.3mm; }
  .logo img {
    position: absolute;
    left: -${LOGO_BOX.offsetLeft}mm;
    top: -${LOGO_BOX.offsetTop}mm;
    width: ${LOGO_BOX.imageWidth}mm;
    /* Height follows the width, so the square stays square. */
    height: auto;
  }

  /*
   * The small uppercase label above the client's name and the other blocks. It
   * carries the look an h3 has, because it used to be one; it stopped being one
   * so the cover's outline runs h1 then h2 rather than h1 then h3. See cover.ts.
   */
  .eyebrow {
    font-size: 9pt; font-weight: 600; line-height: 1.3;
    letter-spacing: .08em; text-transform: uppercase; color: ${INK_FAINT};
    margin: 0 0 5pt;
  }
  /* On the cover the labels are small, widely spaced, and in the brand's blue. */
  .cover-eyebrow {
    font-size: 6.5pt; letter-spacing: .2em; line-height: 1.2;
    color: ${COVER_LABEL}; margin: 0 0 3.6mm;
  }

  /* Who the report is for: name, then address, as two quiet spaced lines. */
  .cover-for { top: 83.9mm; width: ${COVER_COLUMN_MM}mm; }
  .cover-client, .cover-contact, .cover-domain {
    font-family: ${SANS}; font-size: ${COVER_ADDRESS.sizePt}pt; font-weight: 400; line-height: 1.2;
    letter-spacing: ${COVER_ADDRESS.spacingEm}em; color: ${INK}; margin: 0 0 2.4mm;
  }
  .cover-client, .cover-contact { text-transform: uppercase; }
  /*
   * EVERY LINE IN THIS BLOCK HAS A LIMIT, because the title is placed at a fixed
   * height beneath it and anything that grew past its lines would run into the
   * title. Two lines for the name, one for the contact, two for the address and
   * two for the redirect note come to less than the room there is.
   *
   * The two addresses are already cut to their lines, by measuring, before they
   * reach the page; see cover.ts. The clamp here is the same limit stated to
   * the browser, so a line the measurement did not foresee is still cut and
   * marked, and it is the only limit on the name and the contact, which are
   * typed by a person and are ordinarily short.
   */
  .cover-client, .cover-contact, .cover-domain, .cover-redirect {
    display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
  }
  .cover-client { -webkit-line-clamp: 2; }
  .cover-contact { -webkit-line-clamp: 1; }
  /*
   * An address is shown as it is: never re-cased. It has no spaces to break at,
   * so it breaks between any two characters, which fills each line and is what
   * the measuring in cover.ts counts on.
   */
  .cover-domain { word-break: break-all; -webkit-line-clamp: ${COVER_ADDRESS.lines}; }
  .cover-redirect {
    font-size: ${COVER_REDIRECT.sizePt}pt; color: ${INK_FAINT}; margin: 0;
    -webkit-line-clamp: ${COVER_REDIRECT.lines};
  }
  .cover-redirect-url { word-break: break-all; }

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
    margin: 0;
  }
  /* Beneath the mark, in the clear space the artwork leaves there. */
  .cover-left > .partial { top: 66mm; white-space: nowrap; }

  /*
   * The report title, the strongest element on the page: bold uppercase sans in
   * the cover's navy, on two lines, with the short blue rule beneath it. It is
   * wider than the white panel and is meant to be.
   */
  .cover-titleblock { top: 125.2mm; width: 132mm; }
  .cover-title {
    font-family: ${SANS};
    font-size: 37.5pt; font-weight: 600; line-height: 1.125;
    text-transform: uppercase; letter-spacing: .012em; white-space: nowrap;
    color: ${COVER_NAVY}; margin: 0;
  }
  .cover-accent {
    display: block; width: 18.5mm; height: 1.6mm; margin-top: 8mm;
    background: ${SKYBOOK_BRIGHT};
  }

  /* When it was measured: the label, then the date large and quiet. */
  .cover-when { margin-top: 9.4mm; }
  .cover-date {
    font-size: 16pt; font-weight: 400; line-height: 1.25; letter-spacing: .02em;
    color: ${INK_FAINT}; margin: .6mm 0 0; font-variant-numeric: tabular-nums;
  }
  .cover-status { font-size: 7.5pt; color: ${INK_FAINT}; margin: 1.5mm 0 0; }

  /* The signature, low on the panel: the label, then who prepared the report. */
  .cover-sign { top: 265mm; width: 66mm; }
  .cover-sign-line { font-size: 8.5pt; color: ${INK_SOFT}; margin: -1.6mm 0 1.2mm; }
  .cover-sign-brand {
    font-family: ${SANS}; font-size: 10.5pt; font-weight: 600;
    color: ${INK}; letter-spacing: .02em; margin: 0;
  }

  /* ---------- sections ---------- */

  /*
   * ONE SYSTEM, FROM THE EXECUTIVE SUMMARY TO THE LAST PAGE. Every section opens
   * the same way: a small spaced label carrying its number, the title in the
   * serif, and a short blue rule. Inside, there are only four kinds of surface:
   * a thin-bordered card, a card with a coloured rule along its top, a flat pale
   * panel, and a ruled table. No shadows, no gradients and no rounded corners,
   * so the colour that remains always means something.
   */
  section { margin: 0 0 11mm; }
  /* A little more air before each major section, so one ends visibly before the
     next begins. Modest on purpose: a page break still starts at the top. */
  section + section { margin-top: 4mm; }
  section > h2 { counter-increment: section; }
  /* The numbered label above a section's title. Drawn by the page, not written. */
  section > h2::before {
    content: "Section " counter(section, decimal-leading-zero);
    display: block;
    font-family: ${SANS};
    font-size: 8pt; font-weight: 600; line-height: 1.3;
    letter-spacing: .28em; text-transform: uppercase;
    color: ${SKYBOOK_DEEP};
    margin: 0 0 2.5mm;
  }
  /* The short rule under the title. */
  section > h2::after {
    content: "";
    display: block;
    width: 20mm; height: 1mm;
    margin: 4.5mm 0 0;
    background: ${SKYBOOK_DEEP};
  }
  .lead { font-size: 10.5pt; color: ${INK_SOFT}; max-width: 72ch; }
  .group + .group { margin-top: 6mm; }
  .group h3 { margin-top: 0; font-size: 8pt; color: ${INK_SOFT}; }

  ul, ol { margin: 0 0 3mm; padding-left: 5mm; }
  li { margin: 0 0 1.2mm; max-width: 72ch; }
  li::marker { color: ${INK_FAINT}; }
  strong { font-weight: 600; color: ${INK}; }

  /* ---------- figures: the tiles ---------- */

  /*
   * A figure and what it counts: a large number in the serif over a small spaced
   * label, in a thin-bordered card. A tile that stands for a severity carries
   * that severity's colour as a rule along its top, and the word beneath, so the
   * colour is never the only carrier. 7A §24.
   */
  .tiles { display: flex; gap: 3mm; margin: 0 0 3mm; }
  .tile {
    flex: 1;
    background: ${PAPER};
    border: .25mm solid ${HAIRLINE};
    border-top: 1mm solid currentColor;
    padding: 3.2mm 4.5mm;
  }
  .tile-count {
    display: block;
    font-family: ${SERIF};
    font-size: 21pt;
    font-weight: 600;
    line-height: 1;
    color: ${INK};
  }
  /* The word, always, so the colour is never the only carrier. 7A §24. */
  .tile-label {
    display: block;
    font-size: 7pt;
    font-weight: 600;
    letter-spacing: .16em;
    text-transform: uppercase;
    margin-top: 2.5mm;
    color: ${INK_FAINT};
  }
  .tile-critical { color: ${SEVERITY.critical}; }
  .tile-high { color: ${SEVERITY.high}; }
  .tile-medium { color: ${SEVERITY.medium}; }
  .tile-good { color: ${SEVERITY.good}; }

  /* ---------- executive summary ---------- */

  /*
   * The measured verdict on one page. The grade leads in the one dark card on
   * the page, the figures it rests on stand beside it, and the severity split
   * and the four areas follow as rows of the same cards. Below them the page
   * divides: what the figures mean on the left, what to do first in a pale
   * panel on the right.
   */
  .metrics { display: flex; gap: 3mm; margin: 5mm 0 3mm; }
  .metric {
    flex: 1;
    background: ${PAPER};
    border: .25mm solid ${HAIRLINE};
    padding: 3.2mm 4.5mm;
  }
  .metric-num {
    display: block;
    font-family: ${SERIF}; font-size: 21pt; font-weight: 600; line-height: 1; color: ${INK};
  }
  /* The unit after a figure: smaller, and quieter than the figure itself. */
  .metric-of { font-family: ${SANS}; font-size: 9pt; font-weight: 400; color: ${INK_FAINT}; margin-left: 1mm; }
  /* A figure that is words, where there is no number to show. */
  .metric-text { font-size: 13pt; line-height: 1.2; padding-top: 2mm; }
  .metric-label {
    display: block;
    font-size: 7pt; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
    color: ${INK_FAINT}; margin-top: 2.5mm;
  }
  /* The one dark card. White on charcoal, read against the card and not the paper. */
  .metric-lead { flex: 1.25; background: ${CHARCOAL}; border-color: ${CHARCOAL}; }
  .metric-lead .metric-num { color: #ffffff; font-size: 26pt; }
  .metric-lead .metric-label { color: #aab4c3; }

  /* The four areas, each a card: its name, its grade, and how much was assessed. */
  .score-cats { display: flex; gap: 3mm; margin: 0 0 3mm; }
  .score-cat {
    flex: 1;
    background: ${PAPER};
    border: .25mm solid ${HAIRLINE};
    padding: 3.2mm 4.5mm;
  }
  .score-cat-label {
    display: block; font-size: 7pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 2mm;
  }
  .score-cat-value { display: block; }
  .score-cat-grade { font-family: ${SERIF}; font-size: 15pt; font-weight: 600; line-height: 1; }
  .score-cat-rate { font-size: 10.5pt; color: ${INK}; margin-left: 2mm; font-variant-numeric: tabular-nums; }
  .score-cat-cover { display: block; font-size: 7.5pt; color: ${INK_SOFT}; margin-top: 1.5mm; }
  /* Not a zero: a pillar no rule could run for is stated in words. */
  .score-cat-na { font-size: 9pt; font-weight: 600; color: ${INK_SOFT}; }

  .exec-grid {
    display: grid; grid-template-columns: 1.15fr 1fr; gap: 7mm;
    align-items: start; margin: 6mm 0 0;
  }
  .exec-condition > p { font-size: 9.5pt; }
  .exec-areas { margin-top: 6mm; }
  .exec-areas ol { font-size: 9.5pt; }

  .score-gate { margin: 3mm 0 0; }
  .score-gate-heading {
    font-size: 7pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 1.5mm;
  }
  .score-gate-list { margin: 0 0 1.5mm; font-size: 9.5pt; }
  .score-gate-note { font-size: 8.5pt; color: ${INK_SOFT}; margin: 0; }

  /*
   * The flat pale panel: the one place a list of things to do is set apart from
   * the reading around it. Its label is the brand's deep blue.
   */
  .panel { background: ${PANEL}; padding: 4mm 5mm; }
  .panel-label {
    font-size: 7pt; font-weight: 600; letter-spacing: .18em; text-transform: uppercase;
    color: ${SKYBOOK_DEEP}; margin: 0 0 3mm;
  }
  .panel ol, .panel ul { margin-bottom: 0; font-size: 9pt; }
  .panel li:last-child { margin-bottom: 0; }

  /* ---------- AI text, always subordinate ---------- */

  /*
   * AI text sits on the pale panel with a blue rule down its left edge, so a
   * reader can tell commentary from measured fact at a glance -- and it is still
   * labelled in words, so the distinction survives greyscale. It stays visually
   * subordinate: flat ground, smaller type, never a card of its own.
   */
  .ai {
    background: ${PANEL};
    border-left: .8mm solid ${SKYBOOK_DEEP};
    padding: 4mm 5mm;
    margin: 0 0 4mm;
  }
  .ai-summary { max-width: 72ch; }
  .ai-label {
    font-size: 7pt; font-weight: 600; letter-spacing: .18em;
    text-transform: uppercase; color: ${SKYBOOK_DEEP}; margin: 0 0 2mm;
  }
  .ai-sub {
    font-size: 8.5pt; font-weight: 600; color: ${INK}; margin: 2.5mm 0 .8mm;
  }
  .ai-note { font-size: 8pt; color: ${INK_FAINT}; max-width: 72ch; margin: 3mm 0 0; }

  /* ---------- the client-facing AI summary ----------
     One panel, five plain-English parts. It is allowed to break across pages,
     because it can be long, while each key-finding and recommendation item is
     kept whole. Same ground and provenance label as the commentary, so a reader
     still reads it as written-from-measured. */
  .client-ai {
    background: ${PANEL};
    border-left: .8mm solid ${SKYBOOK_DEEP};
    padding: 5mm 6mm;
    margin: 0 0 4mm;
  }
  .client-ai-summary { font-size: 10pt; line-height: 1.55; color: ${INK}; max-width: 72ch; margin: 1mm 0 0; }
  .client-ai-subhead {
    font-size: 7pt; font-weight: 600; letter-spacing: .18em; text-transform: uppercase;
    color: ${SKYBOOK_DEEP}; margin: 5mm 0 2mm;
  }
  .client-ai-list { margin: 0 0 1.5mm; padding-left: 5mm; max-width: 72ch; }
  .client-ai-list li { font-size: 9pt; line-height: 1.5; color: ${INK_SOFT}; margin: 0 0 .8mm; }
  .client-ai-item { break-inside: avoid; margin: 0 0 2.5mm; max-width: 72ch; }
  .client-ai-item-title { font-size: 9.5pt; font-weight: 600; color: ${INK}; margin: 0 0 .4mm; }
  .client-ai-item-text { font-size: 9pt; line-height: 1.5; color: ${INK_SOFT}; margin: 0 0 .4mm; }
  .client-ai-item-impact { font-size: 8.5pt; line-height: 1.5; color: ${INK_FAINT}; margin: 0; }
  .client-ai-steps { margin: 0 0 1.5mm; padding-left: 5mm; max-width: 72ch; }
  .client-ai-steps li { font-size: 9pt; line-height: 1.5; color: ${INK}; margin: 0 0 .8mm; }

  /* ---------- a finding ---------- */

  /*
   * One finding, one card: a thin border all round and the severity's colour as
   * a rule down the left. The word in the chip still carries the severity, so
   * the rule is emphasis, never the message -- a greyscale print keeps every
   * rule as the same grey and loses nothing. 7A §24.
   */
  .finding {
    display: block;
    background: ${PAPER};
    border: .25mm solid ${HAIRLINE};
    border-left: 1mm solid ${RULE};
    padding: 5mm 6mm;
    margin: 0 0 4mm;
  }
  .finding-critical { border-left-color: ${SEVERITY.critical}; }
  .finding-high { border-left-color: ${SEVERITY.high}; }
  .finding-medium { border-left-color: ${SEVERITY.medium}; }
  .finding-good { border-left-color: ${SEVERITY.good}; }
  .finding-head { display: flex; gap: 3mm; align-items: center; }
  .finding-title { margin: 0; }

  /*
   * The chip. Border and text take the severity's colour and the word sits
   * inside, so greyscale and colour-blind readers both still get it.
   */
  .chip {
    flex-shrink: 0;
    border: .25mm solid currentColor;
    border-radius: 1.2mm;
    padding: .9mm 2.3mm .8mm;
    font-size: 6.8pt;
    font-weight: 600;
    letter-spacing: .14em;
    line-height: 1.2;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .chip-critical { color: ${SEVERITY.critical}; }
  .chip-high { color: ${SEVERITY.high}; }
  .chip-medium { color: ${SEVERITY.medium}; }
  .chip-good { color: ${SEVERITY.good}; }

  .finding-meta { font-size: 8.5pt; color: ${INK_SOFT}; margin: 1.8mm 0 3mm; max-width: none; }
  .finding-meta .reach::before { content: " · "; }
  /* The "Measured" label above the evidence, in the same key as the remediation
     and AI labels so a finding reads as three named parts. */
  .finding-eyebrow {
    font-size: 6.8pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 .8mm;
  }
  .evidence { max-width: 72ch; margin: 0 0 3mm; }

  /*
   * WHAT TO DO: the pale panel with a blue rule. A tinted surface and a label
   * set the advice apart from the measured evidence above it, so a reader never
   * mistakes what to do for what was found. 7A §17.
   */
  .remediation {
    background: ${PANEL};
    border-left: .8mm solid ${SKYBOOK_DEEP};
    padding: 3mm 4mm;
    margin: 3mm 0;
  }
  .remediation-label {
    font-size: 6.8pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${SKYBOOK_DEEP}; margin: 0 0 .8mm;
  }
  .remediation p:last-child { margin: 0; max-width: 72ch; }

  /*
   * THE PLAIN-LANGUAGE EXPLANATION: what it means, why it matters, what may
   * follow, then the steps and who fixes it. Written in our source, so it takes
   * the body's own type rather than the AI note's quieter one. Each block is
   * kept whole, so a label never ends a page without its paragraph; the card
   * itself may still break between blocks, because a long card must.
   */
  .explainer { margin: 0 0 3mm; break-inside: avoid; }
  .explainer p { max-width: 72ch; margin: 0 0 1.6mm; }
  .explainer-label {
    font-size: 6.8pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 2mm 0 .6mm;
  }
  .explainer > .explainer-label:first-child { margin-top: 0; }
  .explainer-steps ol { margin: 0 0 2mm; padding-left: 5mm; max-width: 72ch; }
  .explainer-steps li { margin: 0 0 .8mm; break-inside: avoid; }
  .who-fixes { font-size: 9pt; color: ${INK_SOFT}; }
  .who-fixes .explainer-label { display: inline; margin: 0 1.5mm 0 0; }

  /* ---------- the overall summary ----------
     Written by code from the verified audit, so it takes the body's own type.
     It starts a fresh page after the one-page executive summary, then flows; each
     area and each list is kept whole so a heading never ends a page alone. The
     status word carries the verdict, and its colour is emphasis only. */
  .overall-summary { break-before: page; }
  .summary-overview p { max-width: 72ch; font-size: 10pt; line-height: 1.55; color: ${INK}; }
  .summary-area {
    border-top: .25mm solid ${HAIRLINE};
    padding: 3.5mm 0 1mm;
    break-inside: avoid;
  }
  .summary-area-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; }
  .summary-area-head h3 { font-size: 12pt; letter-spacing: 0; text-transform: none; color: ${INK}; margin: 0 0 1.5mm; }
  .summary-area p { max-width: 72ch; font-size: 9.5pt; line-height: 1.5; margin: 0 0 1.4mm; }
  .area-status {
    flex-shrink: 0; font-size: 6.8pt; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; white-space: nowrap; color: ${INK_SOFT};
  }
  .area-status-good { color: ${SEVERITY.good}; }
  .area-status-improve { color: ${SEVERITY.medium}; }
  .area-status-attention { color: ${SEVERITY.high}; }
  .summary-block { margin: 5mm 0 0; break-inside: avoid; }
  .summary-block ul, .summary-block ol { margin: 0; padding-left: 5mm; max-width: 72ch; }
  .summary-block li { font-size: 9.5pt; line-height: 1.5; margin: 0 0 1.2mm; break-inside: avoid; }
  .summary-priorities li p { margin: 0 0 .6mm; }
  .priority-title { font-weight: 600; color: ${INK}; }
  .priority-meta, .priority-who { font-size: 8.5pt; color: ${INK_SOFT}; }
  .summary-help { background: ${PANEL}; border-left: .8mm solid ${SKYBOOK_DEEP}; padding: 4mm 5mm; }
  .summary-help p { max-width: 72ch; }
  .summary-help p:last-child { margin-bottom: 0; }

  /* A finding's evidence rows: the fact-table style, smaller, kept whole. */
  .evidence-panel { margin: 0 0 3mm; break-inside: avoid; }
  .evidence-facts { font-size: 8.5pt; margin: 0; }
  .evidence-note { display: block; font-size: 7.5pt; color: ${INK_FAINT}; overflow-wrap: anywhere; }

  /* Mobile and desktop speed, one after the other, each under its own label. */
  .speed-device { margin: 0 0 5mm; }
  .speed-device + .speed-device { border-top: .25mm solid ${HAIRLINE}; padding-top: 4mm; }

  /*
   * The affected pages, run together rather than stacked. Fifty addresses on
   * one line each, across two dozen findings, would be most of the document.
   */
  .affected { margin: 0 0 3mm; }
  .affected-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: ${MONO};
    font-size: 7.5pt;
    line-height: 1.5;
    color: ${INK_SOFT};
  }
  .affected-list li { display: inline; overflow-wrap: anywhere; max-width: none; }
  .affected-list li + li::before { content: "  ·  "; color: ${INK_FAINT}; }
  .affected .note { margin: 1.5mm 0 0; }

  /* One finding's AI note: no ground of its own, only a hairline above it and
     its label, so it reads as a quieter fourth part of the card. Subordinate by
     type and by position, labelled in words. */
  .commentary {
    border-top: .25mm solid ${HAIRLINE};
    padding: 3mm 0 0;
    margin: 3mm 0 0;
    font-size: 9.5pt;
    color: ${INK_SOFT};
  }
  .commentary p:last-child { margin-bottom: 0; }
  .commentary p { max-width: 72ch; }

  /* ---------- fact tables ---------- */

  /*
   * A ruled table and nothing else: a dark rule under the column headings and a
   * hairline under every row. No card round it, because the rules already hold
   * it together.
   */
  .facts { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 9.5pt; }
  .facts th, .facts td { text-align: left; vertical-align: top; padding: 2.2mm 3mm 2.2mm 0; }
  .facts thead th {
    font-size: 6.8pt; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; color: ${INK_FAINT};
    border-bottom: .4mm solid ${INK};
    padding-top: 0;
  }
  .facts tbody th { font-weight: 400; color: ${INK_SOFT}; width: 40%; }
  .facts tbody td { color: ${INK}; }
  .facts tbody th, .facts tbody td { border-bottom: .25mm solid ${HAIRLINE}; }
  .fact-note { display: block; font-size: 8pt; color: ${INK_FAINT}; }

  /* ---------- speed ---------- */

  .speed-block { margin: 0 0 6mm; }
  .speed-block h3 { margin-top: 0; }
  .speed-block .facts { margin-bottom: 0; }
  .speed-score {
    font-family: ${SERIF};
    font-size: 21pt;
    font-weight: 600;
    line-height: 1;
    margin: 1mm 0 3mm;
  }
  .speed-score-of { font-family: ${SANS}; font-size: 9pt; font-weight: 400; color: ${INK_FAINT}; }
  .speed-limits { margin: 0 0 4mm; }

  /* ---------- checks that did not run ---------- */

  /*
   * No badge and no colour. 7A §14: a check that could not run is not a
   * finding, and giving it the visual language of one would turn our own gap
   * into an accusation about the client's website.
   */
  .skipped-group { margin: 0 0 3.5mm; }
  .skipped-checks { list-style: none; margin: 0; padding: 0; }
  .skipped-checks li { display: inline; max-width: none; }
  .skipped-checks li + li::before { content: ", "; }
  .skipped-group .note { margin: .6mm 0 0; }

  /* ---------- caveats, and about this report ---------- */

  .caveat { margin: 0 0 5mm; }
  .caveat-label {
    font-size: 7pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 1.5mm;
  }
  .caveat-list { margin: 0; padding-left: 5mm; max-width: 72ch; }
  .caveat-list li { margin: 0 0 1.2mm; }

  /* A group of facts: its small label, then its ruled table. */
  .fact-group { margin: 0 0 7mm; }
  .fact-group h3 { margin-top: 0; }
  .fact-group .facts { margin-bottom: 0; }

  /* ---------- final assessment ----------
     A closing recap of the measured grade and the findings the gate named as
     holding it back. Restated, never re-decided. */
  .final-head { display: flex; gap: 5mm; align-items: center; margin: 0 0 3mm; }
  .final-grade { font-family: ${SERIF}; font-size: 30pt; font-weight: 600; line-height: 1; color: ${INK}; flex-shrink: 0; }
  .final-grade-none { font-family: ${SANS}; font-size: 13pt; font-weight: 600; color: ${INK_SOFT}; }
  .final-lines p { margin: 0 0 .4mm; }
  .final-band { font-size: 12pt; font-weight: 600; color: ${INK}; }
  .final-health { font-size: 9.5pt; color: ${INK_SOFT}; font-variant-numeric: tabular-nums; }
  .final-note { font-size: 9pt; color: ${INK_SOFT}; max-width: 72ch; margin: 0 0 2mm; }
  .final-priorities { margin: 3mm 0 0; }
  .final-label {
    font-size: 7pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 1.5mm;
  }
  .final-list { margin: 0 0 2mm; padding-left: 5mm; max-width: 72ch; }
  .final-list li { margin: 0 0 .6mm; }

  /* ---------- page breaks, 7A §18 ---------- */

  /*
   * A FINDING STAYS TOGETHER. Title, severity, evidence and remediation split
   * across a break is the case §18 names first, because a reader who turns the
   * page mid-finding loses the thing that made the evidence mean something.
   *
   * Chromium breaks it anyway when it is genuinely taller than a page, which
   * §18 permits and which is the right fallback: a clipped finding would be
   * worse than a split one.
   */
  .finding { break-inside: avoid; }

  /* The same, for the smaller blocks that read as one thing. */
  .speed-block,
  .skipped-group,
  .caveat,
  .fact-group,
  .tile,
  .tiles,
  .metric,
  .metrics,
  .score-cats,
  .score-cat,
  .score-gate,
  .remediation,
  .exec-grid,
  .panel,
  .final-head,
  .ai { break-inside: avoid; }

  /*
   * THE FINAL ASSESSMENT STAYS WHOLE. It is a short closing recap — the grade,
   * a line of status, and the gate's own priorities — and it reads as one thing.
   * Kept together it never strands its priority list alone on an otherwise empty
   * page, which is the awkward break §18 asks to avoid. Chromium splits it anyway
   * in the rare case it is genuinely taller than a page, which is the right
   * fallback; the measured-facts tables that follow always start a fresh page.
   */
  .final { break-inside: avoid; }
  /*
   * WHAT WE CHECKED STAYS WHOLE. The heading, its one-line count and the short
   * coverage table read as one thing, so the table never starts on the page after
   * its heading or splits after its first row. Chromium splits it anyway if it is
   * ever taller than a page.
   */
  .coverage { break-inside: avoid; }
  /*
   * A SECTION HEADING KEEPS ITS LABEL AND ITS RULE. Both are the heading's own
   * generated blocks, stacked above and below the text, so without this a page
   * break can fall between them and strand the label at the foot of a page with
   * the title on the next.
   */
  section > h2 { break-inside: avoid; }

  /*
   * A HEADING NEVER SITS ALONE AT THE FOOT. §18 names this too. The break-after rule
   * moves the heading down with the content it introduces rather than leaving
   * it stranded as the last line on a page.
   */
  h1, h2, h3, .finding-title, .ai-label, .caveat-label, .remediation-label, .finding-eyebrow, .client-ai-subhead,
  .panel-label, .score-gate-heading, .final-label, .lead {
    break-after: avoid;
  }

  /*
   * A TABLE THAT SPANS PAGES REPEATS ITS HEADER. §18 requires it, and this is
   * what makes Chromium do it: a real thead element declared as a header group. A
   * row itself never splits, so a label never ends up on one page with its
   * value on the next.
   */
  .facts thead { display: table-header-group; }
  .facts tbody { display: table-row-group; }
  .facts tr { break-inside: avoid; }

  /*
   * Long prose flows. §18 forbids truncating AI commentary, and evidence and
   * remediation are the site's own facts, so all three are allowed to break
   * and none is allowed to be cut. Two lines are kept together at each edge so
   * a break never leaves a single orphaned line behind.
   */
  p, .affected-list, .caveat-list { orphans: 2; widows: 2; }

  /* ---------- the pages that stand alone ---------- */

  /*
   * The cover has its own page above, and "About this report" has one here.
   * The reference-fact sections — the measured facts and the crawl detail — also
   * begin on a fresh page: they are the tables a reader turns to rather than
   * reads through, and starting them clean keeps a long measurement table from
   * beginning three rows above a page break, which is exactly the split §18 asks
   * to avoid for content that reads as one thing. The AI summary starts a page
   * too: it is the one long passage a model wrote, and it reads as a part of its
   * own after the measured summary before it. Every other section flows.
   */
  .ai-section,
  .measured,
  .about { break-before: page; }
`;
