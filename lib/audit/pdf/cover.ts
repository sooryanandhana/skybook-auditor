/**
 * The cover page.
 *
 * WHAT IT IS FOR. A salesperson hands this to a prospect, and the cover is the
 * whole of what most people will read carefully. It has to name the right
 * company, name the right website, say when the site was measured, and say
 * plainly when the audit did not cover the whole site.
 *
 * IT READS `PdfCover` AND NOTHING ELSE. Every value is a string 7B prepared,
 * including the date. This file formats nothing, decides nothing and knows
 * nothing about the audit; if a value is absent it renders no line rather than
 * an empty one.
 *
 * EVERY CLIENT FIELD IS OPTIONAL, and 7A §15 requires the document to be
 * correct without any of them. With no client name the cover names the audited
 * site instead, and it never invents a company name from the domain -- a
 * prospect whose company is called something other than their domain would
 * notice immediately, and being wrong on the cover is the worst place to be
 * wrong.
 *
 * THE LAYOUT IS A CORPORATE SPLIT, taken from the approved cover artwork. A
 * white panel on the left carries the mark, the client, the report title, the
 * audit date and the signature. The right is a navy ground, with a blue strip
 * standing on the boundary from the top of the sheet to the bottom and one
 * circular figure centred on it: a broad blue ring, a dark outline, and a white
 * disc the title runs out onto. The figure is built from CSS shapes (never an
 * image or an <svg>, so the document stays self-contained and the accessibility
 * tree stays clean).
 *
 * IT RUNS TO THE PAPER EDGE. The stylesheet lifts the page margins for the first
 * page only. The renderer still draws its running head and foot on every page,
 * this one included, so they sit over the cover in small type.
 *
 * THE MARK IS THE REAL ARTWORK. 7A §27 forbids recreating it from what is on
 * screen. It is the supplied image, embedded and unaltered; see `logo.ts`. The
 * mark keeps a white surround, which is why it sits on the white panel.
 */
import type { PdfCover } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { LOGO_DATA_URI, SKYBOOK_NAME } from "./logo.ts";
import { fitSans, fitSansLines, sansWidthMm } from "./textWidth.ts";

/**
 * How wide the column of text on the white panel is, in millimetres.
 *
 * The stylesheet sets the "prepared for" block to this width, and the addresses
 * in it are fitted to this width, so the two are one number.
 */
export const COVER_COLUMN_MM = 66;

/**
 * How the audited address is set on the cover, and how many lines it may take.
 *
 * The stylesheet reads the size and spacing from here, so what is measured
 * below is what is drawn.
 */
export const COVER_ADDRESS = { sizePt: 8, spacingEm: 0.17, lines: 2 } as const;

/** The same, for the smaller note that names where a redirect started. */
export const COVER_REDIRECT = { sizePt: 7, lines: 2 } as const;

/**
 * How much of the measured room a fitted address may use. The widths are read
 * from the font file and agree with the browser to within half a percent; two
 * percent is held back so that difference can never be what adds a line.
 */
const COVER_FILL = 0.98;

/**
 * The audited address, as the cover shows it: whole, or cut to its lines.
 *
 * THE COVER'S BLOCKS ARE PLACED, NOT STACKED. The title sits at a fixed height
 * below this block, so an address allowed to run to as many lines as it likes
 * ran straight through the title, and a long one made both unreadable. It gets
 * two lines, which every ordinary address fits in with room to spare.
 *
 * MEASURED IN THE FACE IT IS SET IN, never counted in characters: two lines of
 * wide letters hold far fewer than two lines of narrow ones. An address too
 * long for its lines is cut and ends in an ellipsis, so it cannot be taken for
 * the whole one. The full address is still in the document's title, and it is
 * the address every finding in the report lists.
 */
function coverAddress(url: string): string {
  return fitSansLines(
    url,
    COVER_ADDRESS.sizePt,
    COVER_COLUMN_MM * COVER_FILL,
    COVER_ADDRESS.lines,
    COVER_ADDRESS.spacingEm,
  );
}

/** The words around the address a redirect started from. */
const REDIRECT_BEFORE = "Requested ";
const REDIRECT_AFTER = ", which redirected here";

/**
 * The address a redirect started from, cut so the whole note keeps to its lines.
 *
 * The note is a sentence with an address inside it. The words wrap at spaces as
 * words do, so the room left for the address is the note's lines, less the
 * words, less one more word's width for the space a wrapped line can waste.
 */
function redirectAddress(url: string): string {
  const size = COVER_REDIRECT.sizePt;
  const words = sansWidthMm(REDIRECT_BEFORE + REDIRECT_AFTER, size) + sansWidthMm("redirected ", size);
  const room = COVER_COLUMN_MM * COVER_REDIRECT.lines * COVER_FILL - words;
  return fitSans(url, size, room);
}

/**
 * The Skybook mark.
 *
 * The alternative text names the company rather than describing the drawing,
 * because that is what a reader who cannot see it needs to know. 7A §24 asks
 * for a document a screen reader can follow, and an unlabelled graphic at the
 * top of the first page is the worst place to leave one.
 */
function mark(): string {
  return (
    `<div class="logo">` +
    `<img src="${LOGO_DATA_URI}" alt="${SKYBOOK_NAME}">` +
    `</div>`
  );
}

/**
 * Who the report is for, with the audited address beneath.
 *
 * THE FALLBACK IS THE SITE, NOT A GUESS. 7A §19 fixes this: with no client
 * name the cover names the audited site. The label above it changes with it,
 * because "Prepared for" followed by a web address reads as though somebody
 * forgot to fill in a form.
 *
 * THE ADDRESS IS ALWAYS SHOWN, credential-stripped by 7B. A redirect is
 * explained only when the audit actually redirected, because "Requested" and
 * "Audited" carrying the same address twice invites a reader to look for a
 * difference that is not there.
 */
function addressee(cover: PdfCover): string {
  const { companyName, contactName } = cover.client;

  /*
   * A LABEL, NOT A HEADING, and the distinction is structural. These words
   * introduce the client's name; they do not open a section. Marked up as a
   * heading they became an H3 under the cover's H1, which is a skipped level.
   */
  const lead =
    companyName === null && contactName === null
      ? `<p class="eyebrow cover-eyebrow">Website audit for</p>`
      : `<p class="eyebrow cover-eyebrow">Prepared for</p>` +
        (companyName === null ? "" : html`<p class="client cover-client">${companyName}</p>`) +
        (contactName === null ? "" : html`<p class="contact cover-contact">${contactName}</p>`);

  const domain = html`<p class="url cover-domain">${coverAddress(cover.auditedUrl)}</p>`;

  const redirect =
    cover.requestedUrl === null
      ? ""
      : `<p class="note cover-redirect">${REDIRECT_BEFORE}` +
        html`<span class="cover-redirect-url">${redirectAddress(cover.requestedUrl)}</span>` +
        `${REDIRECT_AFTER}</p>`;

  return `<div class="cover-for">` + lead + domain + redirect + `</div>`;
}

/**
 * When the site was measured, and the audit's own status line.
 *
 * THE AUDIT DATE, NEVER THE GENERATION DATE. 7A §20 is explicit about which one
 * matters. The value keeps its "Measured …" wording, which is the same string
 * the running foot and the rest of the report use; the label above it names the
 * slot. Null when the stored timestamp could not be read, in which case the
 * whole block is left out rather than labelled and left blank.
 *
 * THE STATUS LINE repeats on the cover deliberately. 7A §13 requires a partial
 * crawl never to be presented as a whole-site audit, and this line, the partial
 * marker and the running head all say it, so a page read on its own cannot be
 * mistaken.
 *
 * ONLY FOR A PARTIAL AUDIT (CP1 F7, CP3 step 3c-i). The internal "complete"
 * status line is no longer printed: a complete audit needs no marker, and the
 * line read as an internal state rather than something a client needs. The
 * text, when printed, is still the model's own `statusLine`.
 */
function auditInfo(cover: PdfCover): string {
  const date =
    cover.checkedAt === null
      ? ""
      : `<p class="eyebrow cover-eyebrow">Audit date</p>` +
        html`<p class="cover-date">Measured ${cover.checkedAt}</p>`;

  const status = cover.partial ? html`<p class="cover-status">${cover.statusLine}</p>` : "";

  return `<div class="cover-when">` + date + status + `</div>`;
}

/**
 * The signature, bottom-left of the white panel.
 *
 * THE BRAND IS ALWAYS NAMED, because Skybook is always who prepared the report,
 * and so the "Prepared by" label is always there to introduce it. The individual
 * preparer is optional, from `preparedBy`, and is named on a line of their own
 * above the brand. With no individual named, only the brand shows.
 */
function signature(cover: PdfCover): string {
  const preparer =
    cover.client.preparedBy === null
      ? ""
      : html`<p class="cover-sign-line">${cover.client.preparedBy}</p>`;

  return (
    `<div class="cover-sign">` +
    `<p class="eyebrow cover-eyebrow">Prepared by</p>` +
    preparer +
    `<p class="cover-sign-brand">Skybook</p>` +
    `</div>`
  );
}

/**
 * The figure on the navy ground: the strip, the ring, the outline and the disc.
 *
 * DECORATION, AND MARKED AS SUCH. Four empty elements the stylesheet turns into
 * shapes. They carry no text and no meaning, so they are hidden from a screen
 * reader, and none of them is an image or an <svg>.
 */
function figure(): string {
  return (
    `<div class="cover-figure" aria-hidden="true">` +
    `<span class="cover-strip"></span>` +
    `<span class="cover-ring"></span>` +
    `<span class="cover-outline"></span>` +
    `<span class="cover-disc"></span>` +
    `</div>`
  );
}

/**
 * The cover, as one page.
 *
 * The figure is drawn first and the white panel over it, so the panel hides the
 * left half of the circles. On the panel, top to bottom: the mark, the partial
 * marker when the audit was partial, who the report is for, the title with its rule and the audit date beneath, and the
 * signature low on the page.
 */
export function coverHtml(cover: PdfCover): string {
  const partial = cover.partial ? `<p class="partial">Partial audit</p>` : "";

  return (
    `<div class="cover">` +
    figure() +
    `<div class="cover-left">` +
    mark() +
    partial +
    addressee(cover) +
    `<div class="cover-titleblock">` +
    `<h1 class="cover-title">Website<br>Audit Report</h1>` +
    `<span class="cover-accent"></span>` +
    auditInfo(cover) +
    `</div>` +
    signature(cover) +
    `</div>` +
    `</div>`
  );
}
