/**
 * Tests for the security checks.
 *
 * Two of these matter more than the rest, because getting them wrong would
 * put a false statement in a client's report:
 *   - `max-age=0` is an HSTS header that exists and switches protection OFF.
 *     Calling that "protected" would be reassuring a client wrongly.
 *   - A "//example.com/x.js" address is secure on an HTTPS page. Calling it
 *     insecure would be inventing a problem that isn't there.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSecurityChecks,
  parseHsts,
  findMixedContent,
  findInsecureFormActions,
} from "./securityChecks.ts";

const HTTPS = true;
const HTTP = false;

// ---------------------------------------------------------------------------
// Reading headers
// ---------------------------------------------------------------------------

test("records a header that was sent, keeping its exact value", () => {
  const result = runSecurityChecks(
    { "content-security-policy": "default-src 'self'" },
    "<html></html>",
    HTTPS,
  );
  assert.equal(result.contentSecurityPolicy.present, true);
  assert.equal(result.contentSecurityPolicy.value, "default-src 'self'");
});

test("records a header that was not sent as absent, with a null value", () => {
  const result = runSecurityChecks({}, "<html></html>", HTTPS);
  assert.equal(result.contentSecurityPolicy.present, false);
  assert.equal(result.contentSecurityPolicy.value, null);
});

test("treats an empty header value as absent", () => {
  // A header with nothing in it gives the browser nothing to act on.
  const result = runSecurityChecks({ "x-frame-options": "   " }, "<html></html>", HTTPS);
  assert.equal(result.xFrameOptions.present, false);
});

test("reads every header we check for", () => {
  const result = runSecurityChecks(
    {
      "strict-transport-security": "max-age=31536000",
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=()",
      server: "nginx",
      "x-powered-by": "PHP/8.1",
    },
    "<html></html>",
    HTTPS,
  );

  assert.equal(result.strictTransportSecurity.present, true);
  assert.equal(result.contentSecurityPolicy.present, true);
  assert.equal(result.xFrameOptions.value, "DENY");
  assert.equal(result.xContentTypeOptions.value, "nosniff");
  assert.equal(result.referrerPolicy.value, "no-referrer");
  assert.equal(result.permissionsPolicy.value, "geolocation=()");
  assert.equal(result.serverHeader.value, "nginx");
  assert.equal(result.poweredByHeader.value, "PHP/8.1");
});

// ---------------------------------------------------------------------------
// HSTS, read properly rather than just counted
// ---------------------------------------------------------------------------

test("reads a normal HSTS header", () => {
  const hsts = parseHsts("max-age=31536000; includeSubDomains; preload", HTTPS);
  assert.equal(hsts.maxAgeSeconds, 31536000);
  assert.equal(hsts.includesSubdomains, true);
  assert.equal(hsts.preload, true);
  assert.equal(hsts.disabledByZeroMaxAge, false);
});

test("spots an HSTS header that switches protection OFF", () => {
  // max-age=0 is present but tells browsers to forget the rule. A check that
  // only asked "is the header there?" would call this protected.
  const hsts = parseHsts("max-age=0", HTTPS);
  assert.equal(hsts.maxAgeSeconds, 0);
  assert.equal(hsts.disabledByZeroMaxAge, true);
});

test("reads HSTS whatever the capitalisation", () => {
  const hsts = parseHsts("MAX-AGE=600; IncludeSubDomains; PRELOAD", HTTPS);
  assert.equal(hsts.maxAgeSeconds, 600);
  assert.equal(hsts.includesSubdomains, true);
  assert.equal(hsts.preload, true);
});

test("reads a quoted max-age", () => {
  assert.equal(parseHsts('max-age="31536000"', HTTPS).maxAgeSeconds, 31536000);
});

test("reports an unreadable max-age as unknown rather than guessing", () => {
  for (const value of ["max-age=abc", "max-age=", "includeSubDomains"]) {
    const hsts = parseHsts(value, HTTPS);
    assert.equal(hsts.maxAgeSeconds, null, `for "${value}"`);
    assert.equal(hsts.disabledByZeroMaxAge, false, `for "${value}"`);
  }
});

test("does not claim subdomains or preload when they are absent", () => {
  const hsts = parseHsts("max-age=600", HTTPS);
  assert.equal(hsts.includesSubdomains, false);
  assert.equal(hsts.preload, false);
});

test("marks HSTS as not applicable on a plain HTTP page", () => {
  // Browsers ignore HSTS on an insecure page, so reporting it as "missing"
  // would be noise on top of the real problem: the site has no HTTPS.
  assert.equal(parseHsts(null, HTTP).applicable, false);
  assert.equal(parseHsts("max-age=600", HTTP).applicable, false);
  assert.equal(parseHsts(null, HTTPS).applicable, true);
});

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------

test("finds an insecure script and calls it blocking", () => {
  const result = findMixedContent(
    '<html><body><script src="http://cdn.example.com/a.js"></script></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.activeCount, 1);
  assert.equal(result.items[0].kind, "active");
  assert.equal(result.items[0].element, "script");
  assert.equal(result.items[0].url, "http://cdn.example.com/a.js");
});

test("finds an insecure image and calls it non-blocking", () => {
  const result = findMixedContent('<html><body><img src="http://x.com/a.png"></body></html>', HTTPS);
  assert.equal(result.total, 1);
  assert.equal(result.activeCount, 0);
  assert.equal(result.items[0].kind, "passive");
});

test("counts several insecure resources of different kinds", () => {
  const result = findMixedContent(
    `<html><head>
       <link rel="stylesheet" href="http://x.com/a.css">
     </head><body>
       <img src="http://x.com/1.png">
       <img src="http://x.com/2.png">
       <iframe src="http://x.com/f.html"></iframe>
       <img src="https://x.com/secure.png">
     </body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 4);
  assert.equal(result.activeCount, 2); // the stylesheet and the iframe
});

test("does NOT count protocol-relative addresses", () => {
  // "//example.com/x.js" uses whichever protocol the page uses, so on an
  // HTTPS page it is loaded securely. Flagging it would invent a problem.
  const result = findMixedContent(
    '<html><body><script src="//cdn.example.com/a.js"></script></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("does NOT count relative addresses", () => {
  const result = findMixedContent(
    '<html><body><img src="/logo.png"><script src="app.js"></script></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("does NOT count links, only loaded resources", () => {
  // A link is somewhere the visitor may choose to go. It is not something
  // this page loads, so it does not downgrade the padlock.
  const result = findMixedContent(
    '<html><body><a href="http://example.com/page">A link</a></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("does NOT count data: or blob: addresses", () => {
  const result = findMixedContent(
    '<html><body><img src="data:image/gif;base64,R0lGOD"></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("finds insecure addresses inside a srcset", () => {
  const result = findMixedContent(
    '<html><body><img srcset="http://x.com/s.jpg 480w, https://x.com/l.jpg 1024w"></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].url, "http://x.com/s.jpg");
});

test("matches http:// whatever the capitalisation", () => {
  const result = findMixedContent('<html><body><img src="HTTP://X.com/a.png"></body></html>', HTTPS);
  assert.equal(result.total, 1);
});

test("reports mixed content as not applicable on an HTTP page", () => {
  // On a plain HTTP page every resource is insecure. That is one finding —
  // the site has no HTTPS — not a separate finding per image.
  const result = findMixedContent(
    '<html><body><img src="http://x.com/a.png"><img src="http://x.com/b.png"></body></html>',
    HTTP,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.total, 0);
});

test("caps the list but keeps the true total", () => {
  const images = Array.from({ length: 25 }, (_, i) => `<img src="http://x.com/${i}.png">`).join("");
  const result = findMixedContent(`<html><body>${images}</body></html>`, HTTPS);

  assert.equal(result.total, 25, "the count must be the real one");
  assert.equal(result.items.length, 20, "only the first 20 are listed");
  assert.equal(result.truncated, true);
});

test("reports a clean HTTPS page as having no mixed content", () => {
  const result = findMixedContent(
    '<html><body><img src="https://x.com/a.png"><script src="/app.js"></script></body></html>',
    HTTPS,
  );
  assert.equal(result.applicable, true);
  assert.equal(result.total, 0);
  assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// Insecure form submission — what the visitor SENDS, not what the page loads
// ---------------------------------------------------------------------------

test("finds a form that submits over plain HTTP", () => {
  // Anything typed into this form travels unencrypted.
  const actions = findInsecureFormActions(
    '<html><body><form action="http://x.com/submit" method="post"></form></body></html>',
  );
  assert.deepEqual(actions, ["http://x.com/submit"]);
});

test("does not flag a secure or relative form action", () => {
  const actions = findInsecureFormActions(
    `<html><body>
       <form action="https://x.com/a"></form>
       <form action="/local"></form>
       <form action="//x.com/protocol-relative"></form>
       <form></form>
     </body></html>`,
  );
  assert.deepEqual(actions, []);
});

test("finds every insecure form on the page", () => {
  const actions = findInsecureFormActions(
    `<html><body>
       <form action="http://x.com/one"></form>
       <form action="https://x.com/safe"></form>
       <form action="http://x.com/two"></form>
     </body></html>`,
  );
  assert.deepEqual(actions, ["http://x.com/one", "http://x.com/two"]);
});

test("reports insecure forms on an HTTP page too", () => {
  // Unlike mixed content, the risk to whoever is typing is the same whether
  // the surrounding page is secure or not.
  const result = runSecurityChecks(
    {},
    '<html><body><form action="http://x.com/submit"></form></body></html>',
    HTTP,
  );
  assert.deepEqual(result.insecureFormActions, ["http://x.com/submit"]);
});

test("a form action is NOT counted as mixed content", () => {
  // The two are deliberately separate measurements: one is about loading,
  // the other about sending.
  const html = '<html><body><form action="http://x.com/submit"></form></body></html>';
  assert.equal(findMixedContent(html, HTTPS).total, 0);
  assert.equal(findInsecureFormActions(html).length, 1);
});
