/**
 * Turning what a person typed into a URL we can actually fetch.
 *
 * People type "example.com", "www.example.com/", "HTTPS://Example.com" —
 * all meaning the same site. This file makes them consistent.
 */

/** A cleaned-up address, or an explanation of why it can't be used. */
export type NormalizeResult =
  | {
      ok: true;
      url: URL;
      /**
       * True when the user typed a bare domain and we added https:// ourselves.
       *
       * This matters: if we guessed https and the site only supports http, we
       * may retry over http. But if the user explicitly typed https://, a
       * failure must stay a failure — silently downgrading someone's explicit
       * security choice would be wrong.
       */
      schemeWasAssumed: boolean;
    }
  | { ok: false; reason: string };

/**
 * Cleans up a user-typed address.
 *
 * - Adds https:// if no protocol was given (most sites use it, and a site
 *   that only supports http will redirect us there anyway)
 * - Rejects anything that isn't a normal web address
 */
export function normalizeUrl(input: string): NormalizeResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, reason: "Please enter a website address." };
  }

  // Reject spaces early — a URL can't contain them, and their presence
  // usually means someone typed a sentence rather than an address.
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "That doesn't look like a website address." };
  }

  // If there's no "scheme" (the http:// part), assume https.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That doesn't look like a website address." };
  }

  // Only real web pages. This blocks file:, ftp:, data:, javascript: and
  // anything else that isn't a website — some of which could read local files.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https addresses can be audited." };
  }

  // A hostname with no dot (like "localhost" or "intranet") isn't a public
  // website. The safety check catches these too, but rejecting them here
  // gives a clearer message.
  if (!url.hostname.includes(".")) {
    return { ok: false, reason: "Please enter a full website address, like example.com." };
  }

  // Strip the #fragment — it only means something inside a browser and is
  // never sent to the server, so keeping it would be misleading.
  url.hash = "";

  return { ok: true, url, schemeWasAssumed: !hasScheme };
}
