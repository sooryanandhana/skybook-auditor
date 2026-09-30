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
const LINE_SOFT = "#e7edf6";

/*
 * The dashboard's surface palette, brought to print. These are presentation
 * tokens only -- a card border, a card shadow, the dark cover ground, the
 * light-blue remediation panel and the AI tint -- and none is ever set on body
 * text, so the contrast rule in `accessibility.test.mts` (which measures every
 * TEXT_COLOURS entry against the paper) does not reach them. The dark-ground
 * text colours below are read on navy, not on paper, and are checked by eye
 * against that ground rather than against white.
 */
/** The card outline, matched to the dashboard's `--card-border`. */
const CARD_BORDER = "#e6ebf2";
/** A restrained lift under a card, so surfaces read as raised, not boxed. */
const CARD_SHADOW = "0 1pt 3pt rgba(22, 33, 58, 0.06)";
/** The signature dark ground: the dashboard's navy score card and sidebar. */
const NAVY = "#16202e";
/** A soft second navy, for the gradient that keeps the navy ground from reading flat. */
const NAVY_DEEP = "#1c2c48";
/** The light-blue recommendation panel, matched to the dashboard's WHAT TO DO. */
const PANEL_BG = "#f1f6fd";
const PANEL_BORDER = "#dce8f5";
/** The AI tint: a paler blue surface so commentary is never mistaken for measured fact. */
const AI_BG = "#f5f9fd";
/*
 * The cover's cyan highlight. It only ever appears inside `background` gradients
 * on the cover ring, the seam strip and the title accent -- never as a text
 * colour -- so it is not held to 7A §24's 4.5:1 reading contrast, and the test
 * that keeps the brightest blue off text is not touched.
 */
const CYAN = "#4cc4f0";

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

  /*
   * A corporate split: a white panel on the left and a navy panel on the right,
   * with a thin brand seam on the boundary. It is exactly one page tall and
   * clips its own overflow, so the ring on the right is cropped by the cover's
   * edges rather than spilling onto page two. The split sits inside the content
   * box -- the running head and foot occupy the page margins on every page, so
   * the cover cannot bleed to the paper edge without colliding with them.
   */
  .cover {
    /* Its own page, per 7A §18, and exactly one page tall. */
    break-after: page;
    height: ${CONTENT_HEIGHT};
    box-sizing: border-box;
    position: relative;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  .cover-left {
    flex: 0 0 45%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background: ${PAPER};
    padding: 10mm 16mm 10mm 5mm;
  }
  .cover-right {
    flex: 0 0 55%;
    position: relative;
    overflow: hidden;
    background: linear-gradient(160deg, ${NAVY_DEEP} 0%, ${NAVY} 55%, #10161f 100%);
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
  /* On the cover, the labels take the brand's mid blue rather than the caption grey. */
  .cover-eyebrow { color: ${SKYBOOK_MID}; margin: 0 0 3pt; }

  .cover-client {
    font-size: 15pt; font-weight: 700; line-height: 1.2; color: ${INK};
    text-transform: uppercase; letter-spacing: .02em; margin: 0 0 1pt;
  }
  .cover-contact { font-size: 11pt; color: ${INK_SOFT}; margin: 1pt 0 0; }
  .cover-domain { font-size: 8.5pt; color: ${SKYBOOK_MID}; margin: 3pt 0 0; }
  .cover-redirect { font-size: 8pt; color: ${INK_FAINT}; margin: 3pt 0 0; }

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
    margin: 0 0 8pt;
  }

  /*
   * The report title, the strongest element on the page. A bold uppercase sans
   * in dark navy, in two lines, pushed to the lower middle by the auto margin so
   * the mark sits alone at the top and the information block reads beneath it.
   */
  .cover-titleblock { margin-top: auto; }
  .cover-title {
    font-family: ${SANS};
    font-size: 33pt; font-weight: 700; line-height: 1.03;
    text-transform: uppercase; letter-spacing: .005em;
    color: ${INK}; margin: 0;
  }
  /* The short accent under the title, a cyan-to-blue bar. */
  .cover-accent {
    display: block; width: 36mm; height: 1.8mm; margin-top: 7mm;
    border-radius: 1mm;
    background: linear-gradient(90deg, ${CYAN} 0%, ${SKYBOOK_MID} 100%);
  }

  /*
   * The one information block, grouped beneath the title: who the report is for
   * and the site, then when it was measured, the two divided by a hairline so
   * they read as one considered block rather than three stray lines.
   */
  .cover-info { margin-top: 9mm; }
  .cover-info-group + .cover-info-group {
    margin-top: 6mm;
    padding-top: 6mm;
    border-top: .75pt solid ${RULE};
  }
  .cover-date { font-size: 10pt; color: ${INK_SOFT}; margin: 0; font-variant-numeric: tabular-nums; }
  .cover-status { font-size: 8pt; color: ${INK_FAINT}; margin: 3pt 0 0; }

  /* The signature, pinned to the baseline of the white panel by the auto margin. */
  .cover-sign { margin-top: auto; padding-top: 9mm; }
  .cover-sign-line { font-size: 9pt; color: ${INK_SOFT}; margin: 0 0 1pt; }
  .cover-sign-brand {
    font-family: ${SANS}; font-size: 13pt; font-weight: 700;
    color: ${SKYBOOK_DEEP}; letter-spacing: .02em; margin: 0;
  }

  /*
   * The navy panel is a clean dark ground with nothing drawn on it: the
   * concentric ring motif that used to sit here was removed for a plainer
   * composition. Its gradient is set on the .cover-right rule above.
   */

  /* The seam: a thin cyan-to-navy strip standing on the white/navy boundary. */
  .cover-seam {
    position: absolute;
    top: 0; bottom: 0;
    left: 45%;
    width: 3mm;
    transform: translateX(-50%);
    background: linear-gradient(180deg, ${CYAN} 0%, ${SKYBOOK_MID} 45%, ${SKYBOOK_DEEP} 100%);
  }

  /* ---------- sections ---------- */

  section { margin: 0 0 10pt; }
  .lead { max-width: 68ch; }
  h2 { margin-top: 0; }
  .group + .group { margin-top: 12pt; }
  .group h3 { margin-top: 0; }

  /* ---------- the severity split ---------- */

  .tiles { display: flex; gap: 8pt; margin: 0 0 12pt; }
  /*
   * The dashboard's compact summary cards: a white surface with a subtle
   * outline and lift, and the severity's colour carried on a left accent and
   * the count. The word is still there, so the colour is never the only cue.
   */
  .tile {
    flex: 1;
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-left: 3pt solid currentColor;
    border-radius: 6pt;
    padding: 8pt 10pt;
    box-shadow: ${CARD_SHADOW};
  }
  /* The count takes the severity's colour by inheriting the tile's currentColor. */
  .tile-count {
    display: block;
    font-size: 20pt;
    font-weight: 600;
    line-height: 1.1;
  }
  /* The word, always, so the colour is never the only carrier. 7A §24. */
  .tile-label {
    display: block;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    margin-top: 2pt;
    color: ${INK_FAINT};
  }
  .tile-critical { color: ${SEVERITY.critical}; }
  .tile-high { color: ${SEVERITY.high}; }
  .tile-medium { color: ${SEVERITY.medium}; }
  .tile-good { color: ${SEVERITY.good}; }

  /* ---------- the overall score ----------
     The grade's colour comes from the reused .tile-* class, so no colour is set
     on the base rules here; the letter and band word carry the meaning in words
     and the tint is only an accent. 7A §24. */

  .score-grade {
    display: flex; gap: 14pt; align-items: center; margin: 0 0 10pt;
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-radius: 9pt;
    padding: 13pt 16pt;
    box-shadow: ${CARD_SHADOW};
  }
  .score-letter { flex-shrink: 0; font-size: 34pt; font-weight: 600; line-height: 1; }
  .score-letter-none { font-size: 13pt; color: ${INK_SOFT}; }
  .score-lines p { margin: 0 0 1pt; }
  .score-band { font-size: 11pt; font-weight: 600; color: ${INK}; }
  .score-health { font-size: 10pt; color: ${INK}; font-variant-numeric: tabular-nums; }
  .score-coverage { font-size: 8.5pt; color: ${INK_SOFT}; font-variant-numeric: tabular-nums; }
  .score-status { font-size: 9pt; color: ${INK}; max-width: 68ch; margin: 0 0 6pt; }
  .score-caveat { font-size: 8.5pt; color: ${INK_SOFT}; max-width: 68ch; margin: 0 0 6pt; }

  .score-cats { display: flex; gap: 8pt; margin: 10pt 0 0; }
  .score-cat {
    flex: 1;
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-radius: 7pt;
    padding: 7pt 9pt;
    box-shadow: ${CARD_SHADOW};
  }
  .score-cat-label {
    display: block; font-size: 8pt; font-weight: 600; letter-spacing: .05em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 2pt;
  }
  .score-cat-value { display: block; }
  .score-cat-grade { font-size: 13pt; font-weight: 600; }
  .score-cat-rate { font-size: 11pt; color: ${INK}; margin-left: 4pt; font-variant-numeric: tabular-nums; }
  .score-cat-cover { display: block; font-size: 7.5pt; color: ${INK_SOFT}; margin-top: 1pt; }
  /* Not a zero: a pillar no rule could run for is stated in words. */
  .score-cat-na { font-size: 9pt; font-weight: 600; color: ${INK_SOFT}; }

  .score-gate { border-left: 2pt solid ${RULE}; padding-left: 8pt; margin: 8pt 0 0; }
  .score-gate-heading {
    font-size: 8pt; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 3pt;
  }
  .score-gate-list { margin: 0 0 4pt; padding-left: 14pt; }
  .score-gate-list li { margin: 0 0 1pt; }
  .score-gate-note { font-size: 8pt; color: ${INK_FAINT}; max-width: 68ch; margin: 0; }

  /* ---------- AI text, always subordinate ---------- */

  /*
   * AI text sits on a pale blue surface with a brand-blue accent, so a reader
   * can tell commentary from measured fact at a glance -- and it is still
   * labelled in words, so the distinction survives greyscale. It stays visually
   * subordinate: lighter ground, smaller type, never a card lift of its own.
   */
  .ai {
    background: ${AI_BG};
    border: .75pt solid ${PANEL_BORDER};
    border-left: 3pt solid ${SKYBOOK_MID};
    border-radius: 7pt;
    padding: 9pt 11pt;
    margin: 0 0 10pt;
  }
  .ai-summary { max-width: 68ch; }
  .ai-label {
    font-size: 8pt; font-weight: 600; letter-spacing: .07em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 3pt;
  }
  .ai-sub {
    font-size: 8.5pt; font-weight: 600; color: ${INK_SOFT}; margin: 6pt 0 2pt;
  }
  .ai-note { font-size: 8pt; color: ${INK_FAINT}; max-width: 68ch; margin: 6pt 0 0; }

  /* ---------- the client-facing AI summary ----------
     One panel, five plain-English parts. It is allowed to break across pages,
     because it can be long, while each key-finding and recommendation card is
     kept whole. Same blue AI ground and provenance label as the commentary, so
     a reader still reads it as written-from-measured. */
  .client-ai {
    background: ${AI_BG};
    border: .75pt solid ${PANEL_BORDER};
    border-left: 3pt solid ${SKYBOOK_MID};
    border-radius: 7pt;
    padding: 9pt 11pt;
    margin: 0 0 10pt;
  }
  .client-ai-summary { font-size: 9.5pt; line-height: 1.5; color: ${INK}; max-width: 68ch; margin: 4pt 0 0; }
  .client-ai-subhead {
    font-size: 8.5pt; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
    color: ${SKYBOOK_DEEP}; margin: 10pt 0 4pt;
  }
  .client-ai-list { margin: 0 0 4pt; padding-left: 14pt; max-width: 68ch; }
  .client-ai-list li { font-size: 9pt; line-height: 1.45; color: ${INK_SOFT}; margin: 0 0 2pt; }
  .client-ai-item { break-inside: avoid; margin: 0 0 6pt; max-width: 68ch; }
  .client-ai-item-title { font-size: 9.5pt; font-weight: 600; color: ${INK}; margin: 0 0 1pt; }
  .client-ai-item-text { font-size: 9pt; line-height: 1.45; color: ${INK_SOFT}; margin: 0 0 1pt; }
  .client-ai-item-impact { font-size: 8.5pt; line-height: 1.45; color: ${INK_FAINT}; margin: 0; }
  .client-ai-steps { margin: 0 0 4pt; padding-left: 14pt; max-width: 68ch; }
  .client-ai-steps li { font-size: 9pt; line-height: 1.45; color: ${INK}; margin: 0 0 2pt; }

  /* ---------- a finding ---------- */

  .finding {
    display: block;
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-left: 3pt solid ${RULE};
    border-radius: 8pt;
    padding: 11pt 13pt;
    margin: 0 0 8pt;
    box-shadow: ${CARD_SHADOW};
  }
  /*
   * The severity's colour as a restrained left accent, echoing the chip. The
   * word in the chip still carries the severity, so this is emphasis, never the
   * message -- a greyscale print keeps every accent as the same grey and loses
   * nothing. 7A §24.
   */
  .finding-critical { border-left-color: ${SEVERITY.critical}; }
  .finding-high { border-left-color: ${SEVERITY.high}; }
  .finding-medium { border-left-color: ${SEVERITY.medium}; }
  .finding-good { border-left-color: ${SEVERITY.good}; }
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
  /* The "Measured" label above the evidence, in the same key as the remediation
     and AI labels so a finding reads as three named parts. */
  .finding-eyebrow {
    font-size: 8pt; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 2pt;
  }
  .evidence { max-width: 68ch; margin: 0 0 6pt; }

  /*
   * WHAT TO DO: the soft light-blue panel from the dashboard. A tinted surface
   * and a label set the advice apart from the measured evidence above it, so a
   * reader never mistakes what to do for what was found. 7A §17.
   */
  .remediation {
    background: ${PANEL_BG};
    border: .75pt solid ${PANEL_BORDER};
    border-radius: 6pt;
    padding: 7pt 9pt;
    margin: 6pt 0;
  }
  .remediation-label {
    font-size: 8pt; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: ${SKYBOOK_DEEP}; margin: 0 0 2pt;
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

  /* One finding's AI note: the same pale blue surface as the summary panel, so
     commentary reads as commentary wherever it appears. Subordinate by ground
     and by type, labelled in words. */
  .commentary {
    background: ${AI_BG};
    border: .75pt solid ${PANEL_BORDER};
    border-left: 3pt solid ${SKYBOOK_MID};
    border-radius: 6pt;
    padding: 8pt 10pt;
    margin: 6pt 0 0;
  }
  .commentary p:last-child { margin-bottom: 0; }
  .commentary p { max-width: 68ch; }

  /* ---------- fact tables ---------- */

  .facts { width: 100%; border-collapse: collapse; margin: 0 0 8pt; }
  .facts th, .facts td { text-align: left; vertical-align: top; padding: 4pt 8pt 4pt 0; }
  .facts thead th {
    font-size: 7.5pt; font-weight: 600; letter-spacing: .07em;
    text-transform: uppercase; color: ${INK_FAINT};
    border-bottom: .75pt solid ${RULE};
  }
  .facts tbody th { font-weight: 400; color: ${INK_SOFT}; width: 40%; }
  .facts tbody td { color: ${INK}; }
  .facts tbody tr + tr th, .facts tbody tr + tr td { border-top: .5pt solid ${LINE_SOFT}; }
  .fact-note { display: block; font-size: 8pt; color: ${INK_FAINT}; }

  /* ---------- speed ---------- */

  .speed-block {
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-radius: 7pt;
    padding: 9pt 12pt;
    margin: 0 0 8pt;
    box-shadow: ${CARD_SHADOW};
  }
  .speed-block h3 { margin-top: 0; }
  .speed-block .facts { margin-bottom: 0; }
  .speed-score {
    font-family: ${SERIF};
    font-size: 22pt;
    font-weight: 600;
    line-height: 1.1;
    margin: 2pt 0 5pt;
  }
  .speed-score-of { font-family: ${SANS}; font-size: 10pt; font-weight: 400; color: ${INK_FAINT}; }
  .speed-limits { margin: 0 0 8pt; }

  /* ---------- checks that did not run ---------- */

  /*
   * No badge and no colour. 7A §14: a check that could not run is not a
   * finding, and giving it the visual language of one would turn our own gap
   * into an accusation about the client's website.
   */
  .skipped-group { margin: 0 0 8pt; }
  .skipped-checks { list-style: none; margin: 0; padding: 0; }
  .skipped-checks li { display: inline; }
  .skipped-checks li + li::before { content: ", "; }
  .skipped-group .note { margin: 1pt 0 0; }

  /* ---------- caveats, and about this report ---------- */

  .caveat { margin: 0 0 10pt; }
  .caveat-label {
    font-size: 8pt; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: ${INK_FAINT}; margin: 0 0 3pt;
  }
  .caveat-list { margin: 0; padding-left: 12pt; max-width: 68ch; }
  .caveat-list li { margin: 0 0 3pt; }

  /*
   * Reference tables in a compact information card, so a reader turning to
   * check a number meets a clean labelled surface rather than a bare grid. The
   * card holds together on the page (see the break rules below); a group longer
   * than a page is the one case Chromium splits anyway, and its table header
   * repeats when it does.
   */
  .fact-group {
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-radius: 7pt;
    padding: 9pt 12pt;
    margin: 0 0 8pt;
    box-shadow: ${CARD_SHADOW};
  }
  .fact-group h3 { margin-top: 0; }
  .fact-group .facts { margin-bottom: 0; }

  /* ---------- the editorial section header ----------
     A short cyan-to-blue rule above every section title, the cover's accent
     carried through the report so each section opens the same considered way.
     It is decorative and sits outside the heading text, so the outline a screen
     reader follows is untouched. */
  section > h2::before {
    content: "";
    display: block;
    width: 22pt;
    height: 2pt;
    margin: 0 0 5pt;
    border-radius: 1pt;
    background: linear-gradient(90deg, ${CYAN} 0%, ${SKYBOOK_MID} 100%);
  }

  /* ---------- executive summary ----------
     A navy hero that echoes the cover: the grade in white, the band in cyan, the
     measured stats beside it. Word before colour -- the grade's letter and band
     carry the meaning, so the dark ground costs a greyscale reader nothing. */
  .exec-panel {
    display: flex;
    gap: 18pt;
    align-items: center;
    flex-wrap: wrap;
    background: linear-gradient(150deg, ${NAVY_DEEP} 0%, ${NAVY} 55%, #121a27 100%);
    border-radius: 9pt;
    padding: 14pt 18pt;
    margin: 0 0 8pt;
  }
  .exec-grade-col { display: flex; align-items: baseline; gap: 8pt; flex-shrink: 0; }
  .exec-grade { font-family: ${SERIF}; font-size: 40pt; font-weight: 600; line-height: 1; color: #ffffff; }
  .exec-grade-none { font-family: ${SANS}; font-size: 15pt; font-weight: 600; color: #c4cedd; }
  .exec-band { font-size: 13pt; font-weight: 600; color: ${CYAN}; }
  .exec-stats { display: flex; flex-wrap: wrap; gap: 8pt 20pt; }
  .exec-stat { display: flex; flex-direction: column; }
  .exec-stat-label {
    font-size: 7.5pt; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: #93a6c2; margin: 0 0 1pt;
  }
  .exec-stat-value { font-size: 11pt; font-weight: 600; color: #ffffff; font-variant-numeric: tabular-nums; }
  .exec-note { font-size: 8.5pt; color: ${INK_SOFT}; max-width: 68ch; margin: 4pt 0 0; }

  /* ---------- recommended actions ----------
     The findings' own remediations, gathered as a checklist. A card each: the
     severity chip, the finding it addresses, the measured action, then the
     model's suggested step on the same pale blue ground the commentary uses. */
  .recommend-list { list-style: none; margin: 0; padding: 0; }
  .recommend-item {
    background: ${PAPER};
    border: .75pt solid ${CARD_BORDER};
    border-radius: 8pt;
    padding: 9pt 12pt;
    margin: 0 0 7pt;
    box-shadow: ${CARD_SHADOW};
  }
  .recommend-head { display: flex; gap: 6pt; align-items: baseline; margin: 0 0 4pt; }
  .recommend-title { font-family: ${SERIF}; font-size: 11pt; font-weight: 600; color: ${INK}; line-height: 1.3; }
  .recommend-action { font-size: 9.5pt; line-height: 1.5; color: ${INK}; margin: 0; max-width: 68ch; }
  .recommend-ai {
    font-size: 8.5pt; line-height: 1.5; color: ${INK_SOFT};
    margin: 5pt 0 0; padding: 6pt 8pt; max-width: 68ch;
    background: ${AI_BG}; border: .75pt solid ${PANEL_BORDER};
    border-left: 3pt solid ${SKYBOOK_MID}; border-radius: 5pt;
  }
  .recommend-ai-label {
    font-size: 7.5pt; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: ${INK_FAINT}; margin-right: 4pt;
  }

  /* ---------- final assessment ----------
     A closing recap of the measured grade and the findings the gate named as
     holding it back. Restated, never re-decided. */
  .final-head { display: flex; gap: 12pt; align-items: center; margin: 0 0 6pt; }
  .final-grade { font-family: ${SERIF}; font-size: 30pt; font-weight: 600; line-height: 1; color: ${INK}; flex-shrink: 0; }
  .final-grade-none { font-family: ${SANS}; font-size: 13pt; font-weight: 600; color: ${INK_SOFT}; }
  .final-lines p { margin: 0 0 1pt; }
  .final-band { font-size: 12pt; font-weight: 600; color: ${INK}; }
  .final-health { font-size: 9.5pt; color: ${INK_SOFT}; font-variant-numeric: tabular-nums; }
  .final-note { font-size: 9pt; color: ${INK_SOFT}; max-width: 68ch; margin: 0 0 5pt; }
  .final-priorities { margin: 6pt 0 0; }
  .final-list { margin: 3pt 0 4pt; padding-left: 14pt; max-width: 68ch; }
  .final-list li { margin: 0 0 1pt; }

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
  .score-grade,
  .score-cats,
  .score-cat,
  .score-gate,
  .remediation,
  .exec-panel,
  .recommend-item,
  .final-head,
  .ai { break-inside: avoid; }

  /*
   * A HEADING NEVER SITS ALONE AT THE FOOT. §18 names this too. The break-after rule
   * moves the heading down with the content it introduces rather than leaving
   * it stranded as the last line on a page.
   */
  h1, h2, h3, .finding-title, .ai-label, .caveat-label, .remediation-label, .finding-eyebrow {
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
   * to avoid for content that reads as one thing. Every other section flows.
   */
  .measured,
  .about { break-before: page; }
`;
