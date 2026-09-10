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
 * THE MARK IS THE REAL ARTWORK. 7A §27 forbids recreating it from what is on
 * screen, and until the asset was supplied this page carried a wordmark set in
 * type instead. It now carries the supplied image, embedded and unaltered; see
 * `logo.ts` for how it is measured and cropped.
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
 * Who the report is for.
 *
 * THE FALLBACK IS THE SITE, NOT A GUESS. 7A §19 fixes this: with no client
 * name the cover names the audited site. The heading above it changes with it,
 * because "Prepared for" followed by a web address reads as though somebody
 * forgot to fill in a form.
 */
function addressee(cover: PdfCover): string {
  const { companyName, contactName } = cover.client;

  /*
   * A LABEL, NOT A HEADING, and the distinction is structural rather than
   * visual. These words introduce the client's name; they do not open a
   * section. Marked up as a heading they became an H3 sitting directly under
   * the cover's H1, which is a skipped level: a reader navigating by heading
   * would be told the document jumps from its title to a third-level section
   * called "Prepared for". It looks exactly the same and now says what it is.
   */
  if (companyName === null && contactName === null) {
    return html`<p class="eyebrow">Website audit for</p><p class="client">${cover.auditedUrl}</p>`;
  }

  return (
    `<p class="eyebrow">Prepared for</p>` +
    (companyName === null ? "" : html`<p class="client">${companyName}</p>`) +
    (contactName === null ? "" : html`<p class="contact">${contactName}</p>`)
  );
}

/**
 * The audited address, and where it started when that differed.
 *
 * Shown only when the audit actually redirected, because "Requested" and
 * "Audited" carrying the same address twice invites a reader to look for a
 * difference that is not there.
 */
function site(cover: PdfCover): string {
  const audited = html`<p class="url site">${cover.auditedUrl}</p>`;

  return cover.requestedUrl === null
    ? audited
    : audited + html`<p class="note redirect">Requested ${cover.requestedUrl}, which redirected here</p>`;
}

/**
 * The cover, as one page.
 *
 * The status line and the partial marker say the same thing twice on purpose.
 * 7A §13 requires a partial crawl never to be presented as a whole-site audit,
 * and the marker repeats in the running head on every page after this one, so
 * a page read on its own cannot be mistaken either.
 */
export function coverHtml(cover: PdfCover): string {
  const partial = cover.partial ? `<p class="partial">Partial audit</p>` : "";

  return (
    `<div class="cover">` +
    mark() +
    `<div class="cover-main">` +
    partial +
    html`<h1>${cover.statusLine}</h1>` +
    addressee(cover) +
    site(cover) +
    `</div>` +
    coverFoot(cover) +
    `</div>`
  );
}

/**
 * The foot of the cover: when the site was measured, and who prepared it.
 *
 * THE AUDIT DATE, NEVER THE GENERATION DATE. 7A §20 is explicit about which
 * one matters, and it is the same value the running foot carries on every
 * later page. Null when the stored timestamp could not be read, in which case
 * the line is left out rather than labelled and left blank.
 */
function coverFoot(cover: PdfCover): string {
  const measured =
    cover.checkedAt === null ? "" : html`<p class="note">Measured ${cover.checkedAt}</p>`;
  const preparedBy =
    cover.client.preparedBy === null
      ? ""
      : html`<p class="note">Prepared by ${cover.client.preparedBy}</p>`;

  return `<div class="cover-foot">` + measured + preparedBy + `</div>`;
}
