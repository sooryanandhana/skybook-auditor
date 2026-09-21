/**
 * Inline text for the client report: escaped first, then lightly marked up.
 *
 * ESCAPE, THEN MARK UP, IN THAT ORDER. The text is escaped with the audit
 * renderer's own `escapeHtml` before anything else happens, so every `<`, `>`
 * and quote the report carries is already inert. Only then are the two
 * conventions `verifiedReport.ts` allows turned into tags this file writes
 * itself. No tag in the output came from the input.
 *
 *   `value`      → <code>, for addresses and code-like values
 *   **text**     → <strong>, for emphasis
 *
 * Anything else stays literal text.
 */
import { escapeHtml } from "../audit/pdf/escape.ts";

export function rich(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Plain escaped text, for places that take no emphasis at all. */
export function plain(text: string): string {
  return escapeHtml(text);
}
