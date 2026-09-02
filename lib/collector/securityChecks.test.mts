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
  classifyLink,
  findCssResources,
  stripCssComments,
  parseCookies,
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

test("does NOT count an http:// address written inside a script block", () => {
  // A regex over the raw HTML would wrongly count this. Cheerio parses
  // properly, so script contents are text, not markup.
  const result = findMixedContent(
    `<html><body><script>var s = '<img src="http://x.com/fake.png">';</script></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("covers the less common resource elements", () => {
  const result = findMixedContent(
    `<html><body>
       <object data="http://x.com/a.swf"></object>
       <embed src="http://x.com/b.swf">
       <track src="http://x.com/c.vtt">
       <video poster="http://x.com/p.jpg"></video>
       <audio src="http://x.com/d.mp3"></audio>
       <source src="http://x.com/e.mp4">
     </body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 6);
  assert.equal(result.activeCount, 2, "object and embed are blocked; media is not");
});

test("survives malformed HTML without crashing", () => {
  const cases: Array<[string, number]> = [
    ['<IMG SRC="HTTP://X.COM/A.PNG">', 1], // uppercase tag and address
    ["<img src='http://x.com/a.png'>", 1], // single quotes
    ["<img src=http://x.com/a.png>", 1], // no quotes at all
    ['<body><img src="http://x.com/a.png"></body>', 1], // no <html> wrapper
    ["", 0], // empty document
    ["not html at all", 0], // plain text
  ];
  for (const [html, expected] of cases) {
    assert.equal(findMixedContent(html, HTTPS).total, expected, `for ${JSON.stringify(html)}`);
  }
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
// <link> elements — not all of them load anything
// ---------------------------------------------------------------------------

test("finds an insecure favicon", () => {
  const result = findMixedContent(
    '<html><head><link rel="icon" href="http://x.com/f.ico"></head><body></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].kind, "passive");
  assert.equal(result.items[0].element, "link");
});

test("finds an insecure apple-touch-icon", () => {
  const result = findMixedContent(
    '<html><head><link rel="apple-touch-icon" href="http://x.com/t.png"></head><body></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].kind, "passive");
});

test('handles the legacy rel="shortcut icon" pair', () => {
  const result = findMixedContent(
    '<html><head><link rel="shortcut icon" href="http://x.com/f.ico"></head><body></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
});

test("finds an insecure web manifest", () => {
  const result = findMixedContent(
    '<html><head><link rel="manifest" href="http://x.com/m.json"></head><body></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
});

test("classifies a preload by what it is preloading", () => {
  // The `as` attribute is the only thing that says whether a browser blocks it.
  assert.equal(classifyLink("preload", "script"), "active");
  assert.equal(classifyLink("preload", "style"), "active");
  assert.equal(classifyLink("preload", "font"), "active");
  assert.equal(classifyLink("preload", "image"), "passive");
});

test("reports a preload with no `as` as undetermined rather than guessing", () => {
  assert.equal(classifyLink("preload", undefined), "unknown");
  assert.equal(classifyLink("preload", "something-new"), "unknown");
});

test("finds an insecure preload in a page", () => {
  const result = findMixedContent(
    '<html><head><link rel="preload" as="script" href="http://x.com/a.js"></head><body></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].kind, "active");
});

test("ignores link types that fetch nothing", () => {
  // preconnect only opens a connection; canonical and alternate are
  // references, not loads. Counting them would invent problems.
  for (const rel of ["preconnect", "dns-prefetch", "canonical", "alternate", "author"]) {
    assert.equal(classifyLink(rel, undefined), null, `rel="${rel}" loads nothing`);
  }

  const result = findMixedContent(
    `<html><head>
       <link rel="preconnect" href="http://x.com">
       <link rel="canonical" href="http://x.com/page">
       <link rel="dns-prefetch" href="http://x.com">
     </head><body></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("reads the rel value whatever its capitalisation", () => {
  assert.equal(classifyLink("STYLESHEET", undefined), "active");
  assert.equal(classifyLink("Icon", undefined), "passive");
});

test("treats a link with no rel as loading nothing", () => {
  assert.equal(classifyLink(undefined, undefined), null);
  assert.equal(classifyLink("", undefined), null);
});

// ---------------------------------------------------------------------------
// CSS written inside the page
// ---------------------------------------------------------------------------

test("finds an insecure image named in a style attribute", () => {
  const result = findMixedContent(
    `<html><body><div style="background: url(http://x.com/bg.png)">x</div></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].element, "div", "the element carrying the style");
  assert.match(result.items[0].via, /style attribute/);
});

test("finds an insecure image named in a <style> block", () => {
  const result = findMixedContent(
    `<html><head><style>body{background:url(http://x.com/bg.png)}</style></head><body></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].element, "style");
});

test("reads url() with any quoting style", () => {
  for (const css of [
    'url(http://x.com/a.png)',
    'url("http://x.com/a.png")',
    "url('http://x.com/a.png')",
    'url(  http://x.com/a.png  )',
    'URL(http://x.com/a.png)',
  ]) {
    const found = findCssResources(css);
    assert.equal(found.length, 1, `for ${css}`);
    assert.equal(found[0].url, "http://x.com/a.png", `for ${css}`);
  }
});

test("reports a plain CSS url() as undetermined, not guessed", () => {
  // A url() could be an image (browsers warn) or a font (browsers block).
  // The CSS does not say, so neither do we.
  const found = findCssResources("background:url(http://x.com/thing)");
  assert.equal(found[0].kind, "unknown");
});

test("knows a CSS @import is a stylesheet, which browsers block", () => {
  for (const css of ['@import "http://x.com/a.css";', "@import url(http://x.com/a.css);"]) {
    const found = findCssResources(css);
    assert.equal(found.length, 1, `for ${css}`);
    assert.equal(found[0].kind, "active", `for ${css}`);
    assert.match(found[0].via, /@import/);
  }
});

test("does not count an @import twice when written as url()", () => {
  // "@import url(...)" matches both patterns; it must be reported once.
  const found = findCssResources("@import url(http://x.com/a.css);");
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "active");
});

test("ignores secure and relative addresses in CSS", () => {
  const css = `
    a{background:url(https://x.com/a.png)}
    b{background:url(//x.com/b.png)}
    c{background:url(/local.png)}
    d{background:url(data:image/gif;base64,AAA)}
  `;
  assert.deepEqual(findCssResources(css), []);
});

test("finds several insecure addresses in one block of CSS", () => {
  const found = findCssResources(
    "a{background:url(http://x.com/1.png)} b{background:url(http://x.com/2.png)}",
  );
  assert.equal(found.length, 2);
});

test("counts CSS resources alongside ordinary ones", () => {
  const result = findMixedContent(
    `<html><head>
       <style>body{background:url(http://x.com/bg.png)}</style>
       <link rel="icon" href="http://x.com/f.ico">
     </head><body>
       <img src="http://x.com/a.png">
       <script src="http://x.com/a.js"></script>
     </body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 4);
  assert.equal(result.activeCount, 1, "only the script is definitely blocked");
});

// ---------------------------------------------------------------------------
// CSS comments — a commented-out rule is not loaded, so it is not a finding
// ---------------------------------------------------------------------------

test("ignores a url() that is commented out", () => {
  // Reporting this would invent a problem the site does not have. A false
  // alarm in a client's report costs more than a missed finding: they check,
  // find nothing, and stop trusting the rest.
  assert.deepEqual(findCssResources("/* url(http://x.com/dead.png) */"), []);
});

test("ignores a commented-out rule inside a block", () => {
  assert.deepEqual(
    findCssResources("a{/*background:url(http://x.com/dead.png)*/ color:red}"),
    [],
  );
});

test("keeps a live url() while ignoring a commented one beside it", () => {
  const found = findCssResources(
    "a{background:url(http://x.com/real.png)} /* url(http://x.com/dead.png) */",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].url, "http://x.com/real.png");
});

test("ignores a commented-out @import", () => {
  assert.deepEqual(findCssResources('/* @import "http://x.com/dead.css"; */'), []);
});

test("treats an unterminated comment as running to the end", () => {
  // A browser does the same, so everything after it is not live CSS.
  assert.deepEqual(findCssResources("a{color:red} /* url(http://x.com/dead.png)"), []);
});

test("strips comments without joining the text either side", () => {
  // Replacing a comment with nothing could weld two tokens together.
  assert.match(stripCssComments("a/*x*/b"), /a\s+b/);
});

test("ignores commented-out CSS through the full scan", () => {
  const result = findMixedContent(
    `<html><head><style>/* url(http://x.com/dead.png) */</style></head>
     <body><div style="/* url(http://x.com/also-dead.png) */"></div></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("counts a repeated url() once per occurrence", () => {
  // Repeats are no longer de-duplicated, matching how repeated elements are
  // counted — two <img> tags with the same address count twice.
  const found = findCssResources(
    "a{background:url(http://x.com/s.png)} b{background:url(http://x.com/s.png)}",
  );
  assert.equal(found.length, 2);
});

// ---------------------------------------------------------------------------
// Link rel values that load nothing
// ---------------------------------------------------------------------------

test('rel="shortcut" on its own loads nothing', () => {
  // Only the legacy pair rel="shortcut icon" is a favicon; "shortcut" alone
  // is not a resource-loading type.
  assert.equal(classifyLink("shortcut", undefined), null);
  // The legacy pair still works, via its "icon" token.
  assert.equal(classifyLink("shortcut icon", undefined), "passive");
});

test("an alternate stylesheet is not fetched, so is not counted", () => {
  // Alternate stylesheets are optional themes a visitor can switch to.
  // Browsers do not load them on an ordinary visit.
  assert.equal(classifyLink("alternate stylesheet", undefined), null);
  assert.equal(classifyLink("stylesheet alternate", undefined), null);
  // A plain stylesheet is still active.
  assert.equal(classifyLink("stylesheet", undefined), "active");
});

// ---------------------------------------------------------------------------
// Resource types that were previously missed
// ---------------------------------------------------------------------------

test("finds an insecure image button", () => {
  const result = findMixedContent(
    '<html><body><input type="image" src="http://x.com/btn.png"></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].element, "input");
});

test("does not treat an ordinary text input as a resource", () => {
  const result = findMixedContent(
    '<html><body><input type="text" src="http://x.com/nope.png"></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 0);
});

test("finds the deprecated background attribute", () => {
  // Long deprecated, still fetched by browsers, and common on exactly the
  // older sites this tool is aimed at.
  const result = findMixedContent(
    `<html><body background="http://x.com/page.png">
       <table background="http://x.com/table.png"></table>
     </body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((i) => i.element).sort(),
    ["body", "table"],
  );
});

test("finds insecure SVG images using href and the older xlink:href", () => {
  const result = findMixedContent(
    `<html><body><svg>
       <image href="http://x.com/a.png"/>
       <image xlink:href="http://x.com/b.png"/>
     </svg></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 2);
});

test("finds an insecure SVG use reference", () => {
  const result = findMixedContent(
    '<html><body><svg><use href="http://x.com/sprite.svg#icon"/></svg></body></html>',
    HTTPS,
  );
  assert.equal(result.total, 1);
});

test("finds an insecure preload imagesrcset", () => {
  const result = findMixedContent(
    `<html><head><link rel="preload" as="image"
       imagesrcset="http://x.com/small.png 480w, https://x.com/large.png 1024w"></head>
     <body></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.equal(result.items[0].url, "http://x.com/small.png");
});

test("finds insecure resources inside an iframe srcdoc", () => {
  // srcdoc holds a whole document, and its resources are fetched too.
  const result = findMixedContent(
    `<html><body><iframe srcdoc='<img src="http://x.com/inner.png">'></iframe></body></html>`,
    HTTPS,
  );
  assert.equal(result.total, 1);
  assert.match(result.items[0].via, /srcdoc/);
});

test("stops rather than following srcdoc forever", () => {
  // Deeply nested srcdocs must not loop; the scan simply stops descending.
  const deep = `<html><body><iframe srcdoc='<iframe srcdoc="<iframe srcdoc=&quot;&quot;></iframe>"></iframe>'></iframe></body></html>`;
  assert.doesNotThrow(() => findMixedContent(deep, HTTPS));
});

// ---------------------------------------------------------------------------
// Cookies — flags only, never values
// ---------------------------------------------------------------------------

test("reads the protective flags off a cookie", () => {
  const result = parseCookies(["session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax"]);
  assert.equal(result.total, 1);
  assert.equal(result.cookies[0].name, "session");
  assert.equal(result.cookies[0].secure, true);
  assert.equal(result.cookies[0].httpOnly, true);
  assert.equal(result.cookies[0].sameSite, "lax");
});

test("NEVER stores a cookie's value", () => {
  // A cookie value is often a live session token. Capturing one would put a
  // working key to someone's account into our data and into client reports.
  const result = parseCookies(["session=SUPER_SECRET_TOKEN; Path=/; Secure"]);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes("SUPER_SECRET_TOKEN"), "the value must not be kept anywhere");
  assert.equal(result.cookies[0].name, "session");
});

test("reports a cookie with no protective flags", () => {
  const result = parseCookies(["tracking=xyz; Path=/"]);
  assert.equal(result.cookies[0].secure, false);
  assert.equal(result.cookies[0].httpOnly, false);
  assert.equal(result.cookies[0].sameSite, null);
});

test("reads EVERY cookie, not just one", () => {
  // The whole reason cookies are collected separately: flattening headers
  // into an object keeps only one, and the dropped one may be the insecure one.
  const result = parseCookies([
    "a=1; Path=/",
    "b=2; Secure; HttpOnly",
    "c=3; SameSite=Strict",
  ]);
  assert.equal(result.total, 3);
  assert.deepEqual(result.cookies.map((c) => c.name), ["a", "b", "c"]);
  assert.deepEqual(result.cookies.map((c) => c.secure), [false, true, false]);
});

test("reads cookie attributes whatever their capitalisation", () => {
  const result = parseCookies(["x=1; secure; httponly; samesite=STRICT"]);
  assert.equal(result.cookies[0].secure, true);
  assert.equal(result.cookies[0].httpOnly, true);
  assert.equal(result.cookies[0].sameSite, "strict");
});

test("handles a value that itself contains an equals sign", () => {
  const result = parseCookies(["token=abc=def=ghi; Secure"]);
  assert.equal(result.cookies[0].name, "token");
  assert.equal(result.cookies[0].secure, true);
});

test("skips a malformed Set-Cookie without crashing", () => {
  const result = parseCookies(["", "   ", "; Secure", "ok=1; Secure"]);
  assert.equal(result.total, 1);
  assert.equal(result.cookies[0].name, "ok");
});

test("records what the cookie check cannot see", () => {
  const result = parseCookies([]);
  assert.equal(result.total, 0);
  assert.ok(result.notInspected.length > 0, "an empty list is not proof there are no cookies");
});

// ---------------------------------------------------------------------------
// A report-only policy is monitored, not enforced
// ---------------------------------------------------------------------------

test("keeps a report-only CSP separate from an enforced one", () => {
  const result = runSecurityChecks(
    { "content-security-policy-report-only": "default-src 'self'" },
    "<html></html>",
    HTTPS,
  );
  // Report-only enforces nothing, so the enforced policy is genuinely absent.
  assert.equal(result.contentSecurityPolicy.present, false);
  // But "being trialled" is not the same as "none at all".
  assert.equal(result.contentSecurityPolicyReportOnly.present, true);
  assert.equal(result.contentSecurityPolicyReportOnly.value, "default-src 'self'");
});

test("a site can have both an enforced and a report-only policy", () => {
  const result = runSecurityChecks(
    {
      "content-security-policy": "default-src 'self'",
      "content-security-policy-report-only": "default-src 'none'",
    },
    "<html></html>",
    HTTPS,
  );
  assert.equal(result.contentSecurityPolicy.value, "default-src 'self'");
  assert.equal(result.contentSecurityPolicyReportOnly.value, "default-src 'none'");
});

// ---------------------------------------------------------------------------
// Being honest about what a static scan cannot see
// ---------------------------------------------------------------------------

test("always records what was not inspected, even on a clean page", () => {
  // A count of zero must never be presented as "the whole site is clean".
  const clean = findMixedContent('<html><body><img src="https://x.com/a.png"></body></html>', HTTPS);
  assert.equal(clean.total, 0);
  assert.ok(clean.notInspected.length > 0, "the limits must travel with the result");
  assert.ok(
    clean.notInspected.some((limit) => /CSS files/i.test(limit)),
    "external stylesheets are not downloaded",
  );
  assert.ok(
    clean.notInspected.some((limit) => /JavaScript/i.test(limit)),
    "the page is not run",
  );
});

test("records the same limits on an HTTP page and on a page with findings", () => {
  const onHttp = findMixedContent("<html></html>", HTTP);
  const withFindings = findMixedContent(
    '<html><body><img src="http://x.com/a.png"></body></html>',
    HTTPS,
  );
  assert.ok(onHttp.notInspected.length > 0);
  assert.deepEqual(withFindings.notInspected, onHttp.notInspected);
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
