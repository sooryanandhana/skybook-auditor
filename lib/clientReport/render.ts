/**
 * Renders the verified client report to PDF bytes.
 *
 * THE BROWSER STAYS IN `lib/audit/pdf`. This module prepares the document and
 * hands it to `renderHtmlDocument`, the audit renderer's own browser path, so
 * the client report gets exactly the same isolation (no JavaScript, every
 * network request aborted, a whole-call budget, the browser always closed) and
 * `lib/audit/pdf` remains the only folder in `lib` that can drive a browser.
 *
 * Page size, margins, running head and "Page n of m" come from the
 * stylesheet's `@page` rules, which is what lets the cover run full-bleed.
 */
import { renderHtmlDocument, type RenderOptions } from "../audit/pdf/render.ts";
import { SKYBOOK_NAME } from "../audit/pdf/logo.ts";
import { clientReportHtml, REPORT_TITLE } from "./document.ts";
import { CLIENT } from "./verifiedReport.ts";

/** A longer budget than the automated report: this document is ~37 pages. */
export const CLIENT_REPORT_BUDGET_MS = 60_000;

export function renderClientReport(options: RenderOptions = {}): Promise<Buffer> {
  return renderHtmlDocument(
    clientReportHtml(),
    { title: REPORT_TITLE, author: SKYBOOK_NAME, subject: `Website audit for ${CLIENT.site} — Audit Date: ${CLIENT.auditDate}` },
    { timeoutMs: CLIENT_REPORT_BUDGET_MS, ...options },
  );
}
