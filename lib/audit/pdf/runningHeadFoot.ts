/**
 * The running head and foot, and the page number.
 *
 * 7A §20 fixes what these carry. The head is the Skybook mark, the audited
 * site, and "Partial audit" when the crawl was incomplete -- repeated on every
 * page, so a page read on its own cannot be mistaken for a whole-site result.
 * The foot is the audit date and "page n of m". The audit date, not the
 * generation date: what matters is when the site was measured.
 *
 * THREE THINGS ABOUT CHROMIUM'S TEMPLATES, all verified on Chrome 152 rather
 * than taken from documentation:
 *
 *   1. They render in their own context and inherit nothing from the page --
 *      not the stylesheet, not the fonts, not even a sensible default size.
 *      Every rule they need is inline, which is why this file is full of style
 *      attributes and the shell is not.
 *
 *   2. `pageNumber` and `totalPages` are filled in by the browser from spans
 *      carrying those class names. There is no second layout pass and no
 *      counting on our side.
 *
 *   3. They are drawn whether or not the page margin leaves room. A margin set
 *      too small produces overlap, not omission. See `PAGE_MARGIN`.
 *
 * THE MARK IS TYPESET, NOT DRAWN. The dark-text vector logo is still
 * outstanding, and 7A §27 is explicit that it is not to be recreated from what
 * is on screen. A wordmark in type is honest in the meantime and is replaced
 * when the approved asset arrives.
 */
import { escapeHtml } from "./escape.ts";

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

/*
 * Shared inline styling. Chromium's own default for these templates is around
 * 8px, which is unreadably small, so a size is always stated.
 */
const BAR = [
  "width:100%",
  "box-sizing:border-box",
  "padding:0 18mm",
  "font-family:-apple-system,'Segoe UI',sans-serif",
  "font-size:8pt",
  "line-height:1.3",
  "color:#4a5872",
  "display:flex",
  "justify-content:space-between",
].join(";");

/**
 * The head. Mark on the left, site on the right, partial marker beside it.
 *
 * The marker is words rather than a colour, because 7A §24 requires every
 * state to survive greyscale printing, and because a coloured bar at the top
 * of a page tells a reader nothing they can act on.
 */
export function headerTemplate(head: RunningHead): string {
  const right = head.partial
    ? `${escapeHtml(head.auditedUrl)} &middot; Partial audit`
    : escapeHtml(head.auditedUrl);

  return (
    `<div style="${BAR}">` +
    `<span style="font-weight:600;color:#264a9a;">Skybook</span>` +
    `<span>${right}</span>` +
    `</div>`
  );
}

/**
 * The foot. Audit date on the left, page number on the right.
 *
 * "n of m" rather than a bare number, so a missing page is noticeable.
 */
export function footerTemplate(foot: RunningFoot): string {
  return (
    `<div style="${BAR}">` +
    `<span>${foot.auditDate === null ? "" : escapeHtml(foot.auditDate)}</span>` +
    `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
    `</div>`
  );
}
