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
 * THE LAYOUT IS A CORPORATE SPLIT. A white panel on the left carries the mark,
 * the client, the report title and the signature; a navy panel on the right
 * carries a large ring built from CSS shapes (never an image or an <svg>, so
 * the document stays self-contained and the accessibility tree stays clean).
 * The split lives inside the printable content box rather than bleeding to the
 * paper edge, because the renderer draws the running head and foot in the page
 * margins on every page and a full bleed would sit under them.
 *
 * THE MARK IS THE REAL ARTWORK. 7A §27 forbids recreating it from what is on
 * screen. It is the supplied image, embedded and unaltered; see `logo.ts`. The
 * mark keeps a white surround, which is why it sits on the white panel.
 */
import type { PdfCover } from "../pdfDocument.ts";
import { html } from "./escape.ts";
import { LOGO_DATA_URI, SKYBOOK_NAME } from "./logo.ts";

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

  const domain = html`<p class="url cover-domain">${cover.auditedUrl}</p>`;

  const redirect =
    cover.requestedUrl === null
      ? ""
      : html`<p class="note cover-redirect">Requested ${cover.requestedUrl}, which redirected here</p>`;

  return `<div class="cover-info-group">` + lead + domain + redirect + `</div>`;
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
 */
function auditInfo(cover: PdfCover): string {
  const date =
    cover.checkedAt === null
      ? ""
      : `<p class="eyebrow cover-eyebrow">Audit date</p>` +
        html`<p class="cover-date">Measured ${cover.checkedAt}</p>`;

  const status = html`<p class="cover-status">${cover.statusLine}</p>`;

  return `<div class="cover-info-group">` + date + status + `</div>`;
}

/**
 * The one information block: who the report is for, the site, and when it was
 * measured, grouped together beneath the title rather than scattered down the
 * page. Two label-and-value groups, divided by a hairline, on a shared grid.
 */
function infoBlock(cover: PdfCover): string {
  return `<div class="cover-info">` + addressee(cover) + auditInfo(cover) + `</div>`;
}

/**
 * The signature, bottom-left of the white panel.
 *
 * THE BRAND IS ALWAYS NAMED, because Skybook is always who prepared the report.
 * The individual preparer is optional, from `preparedBy`, and its "Prepared by
 * …" wording is kept intact so the value reads as a whole rather than as a
 * relabelled fragment. With no individual named, only the brand shows.
 */
function signature(cover: PdfCover): string {
  const preparer =
    cover.client.preparedBy === null
      ? ""
      : html`<p class="cover-sign-line">Prepared by ${cover.client.preparedBy}</p>`;

  return (
    `<div class="cover-sign">` +
    preparer +
    `<p class="cover-sign-brand">Skybook</p>` +
    `</div>`
  );
}

/**
 * The navy panel: a clean dark ground, and nothing drawn on it.
 *
 * The concentric ring motif that used to sit here has been removed for a plainer
 * composition; the panel is now just the navy gradient set in the stylesheet. It
 * carries no text and no shapes, so it adds nothing a screen reader would
 * announce, and it never reaches an image or an <svg>.
 */
function navyPanel(): string {
  return `<div class="cover-right"></div>`;
}

/**
 * The cover, as one page.
 *
 * The white panel runs on a single grid: the mark at the top with room to
 * breathe, the dominant title in the lower middle with its accent, the grouped
 * information block beneath it, and the signature on the baseline. The navy
 * panel is a clean dark ground, and the seam is the thin brand strip on the
 * boundary between them.
 */
export function coverHtml(cover: PdfCover): string {
  const partial = cover.partial ? `<p class="partial">Partial audit</p>` : "";

  return (
    `<div class="cover">` +
    `<div class="cover-left">` +
    mark() +
    `<div class="cover-titleblock">` +
    partial +
    `<h1 class="cover-title">Website<br>Audit Report</h1>` +
    `<span class="cover-accent"></span>` +
    `</div>` +
    infoBlock(cover) +
    signature(cover) +
    `</div>` +
    navyPanel() +
    `<span class="cover-seam"></span>` +
    `</div>`
  );
}
