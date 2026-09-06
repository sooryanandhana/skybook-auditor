/**
 * Tests for the SEO checks, using hand-written HTML where we know the answer.
 *
 * Real websites are useful for confirming we agree with reality, but they
 * can't test the cases that matter most — a page with exactly three images
 * missing alt text, or headings that skip a level. So we write those here.
 *
 * Run with:  node --test lib/collector/seoChecks.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSeoChecks } from "./seoChecks.ts";
import { classifyLink } from "./securityChecks.ts";

test("finds the title and its length", () => {
  const seo = runSeoChecks(`<html><head><title>  Hello   World  </title></head><body></body></html>`);
  // Whitespace is collapsed, so this is "Hello World" — 11 characters.
  assert.equal(seo.titleText, "Hello World");
  assert.equal(seo.titleLength, 11);
});

test("reports a missing title as null, not an empty string", () => {
  const seo = runSeoChecks(`<html><head></head><body></body></html>`);
  assert.equal(seo.titleText, null);
  assert.equal(seo.titleLength, 0);
});

test("treats a blank title the same as a missing one", () => {
  const seo = runSeoChecks(`<html><head><title>   </title></head><body></body></html>`);
  assert.equal(seo.titleText, null);
});

test("finds the meta description whatever the attribute case", () => {
  const seo = runSeoChecks(
    `<html><head><meta NAME="Description" content="A short summary."></head><body></body></html>`,
  );
  assert.equal(seo.metaDescriptionText, "A short summary.");
  assert.equal(seo.metaDescriptionLength, 16);
});

test("counts images missing alt, but NOT decorative ones with alt=''", () => {
  const seo = runSeoChecks(`
    <html><body>
      <img src="a.jpg" alt="A described image">
      <img src="b.jpg">
      <img src="c.jpg" alt="">
      <img src="d.jpg">
      <img src="e.jpg" alt="Another description">
    </body></html>
  `);
  assert.equal(seo.imageCount, 5);
  // b and d have no alt attribute at all. c has alt="" which is the correct
  // way to mark a decorative image, so it must not be flagged.
  assert.equal(seo.imagesMissingAlt, 2);
});

test("counts multiple h1 elements", () => {
  const seo = runSeoChecks(`
    <html><body><h1>First</h1><h1>Second</h1></body></html>
  `);
  assert.equal(seo.h1Count, 2);
  assert.deepEqual(seo.h1Texts, ["First", "Second"]);
});

test("reports a missing h1 as a count of zero", () => {
  const seo = runSeoChecks(`<html><body><h2>Only a subheading</h2></body></html>`);
  assert.equal(seo.h1Count, 0);
  assert.deepEqual(seo.h1Texts, []);
});

test("counts h2 and h3 elements", () => {
  const seo = runSeoChecks(`
    <html><body>
      <h1>Title</h1>
      <h2>One</h2><h2>Two</h2><h2>Three</h2>
      <h3>A</h3><h3>B</h3>
      <h4>Ignored by these counts</h4>
    </body></html>
  `);
  assert.equal(seo.h1Count, 1);
  assert.equal(seo.h2Count, 3);
  assert.equal(seo.h3Count, 2);
});

test("reports zero h2 and h3 when there are none", () => {
  const seo = runSeoChecks(`<html><body><h1>Alone</h1></body></html>`);
  assert.equal(seo.h2Count, 0);
  assert.equal(seo.h3Count, 0);
});

test("counts an empty h1 as an element but not as text", () => {
  // h1Count and h1Texts deliberately disagree here: one heading exists but
  // says nothing. Both facts are true and both are worth reporting.
  const seo = runSeoChecks(`<html><body><h1></h1><h1>Real one</h1></body></html>`);
  assert.equal(seo.h1Count, 2);
  assert.deepEqual(seo.h1Texts, ["Real one"]);
});

test("spots a skipped heading level", () => {
  const seo = runSeoChecks(`
    <html><body><h1>Title</h1><h2>Section</h2><h4>Too deep</h4></body></html>
  `);
  assert.equal(seo.headingSkips.length, 1);
  assert.match(seo.headingSkips[0], /h2 is followed by h4/);
});

test("does not flag heading levels going back up", () => {
  // h1 > h2 > h3 > h2 is a perfectly normal structure: a new section starts.
  const seo = runSeoChecks(`
    <html><body><h1>T</h1><h2>A</h2><h3>A.1</h3><h2>B</h2></body></html>
  `);
  assert.deepEqual(seo.headingSkips, []);
});

test("reads lang, canonical and viewport", () => {
  const seo = runSeoChecks(`
    <html lang="en-GB"><head>
      <link rel="canonical" href="https://example.com/page">
      <meta name="viewport" content="width=device-width">
    </head><body></body></html>
  `);
  assert.equal(seo.langAttribute, "en-GB");
  assert.equal(seo.canonicalUrl, "https://example.com/page");
  assert.equal(seo.hasViewportMeta, true);
});

test("resolves a relative canonical URL to an absolute one", () => {
  // A canonical tag may legitimately hold a relative path. Reporting "/about"
  // as if it were a URL would be showing a fragment of the truth.
  const seo = runSeoChecks(
    `<html><head><link rel="canonical" href="/about"></head><body></body></html>`,
    "https://example.com/some/page",
  );
  assert.equal(seo.canonicalUrl, "https://example.com/about");
});

test("leaves the canonical alone when there is no page URL to resolve against", () => {
  const seo = runSeoChecks(
    `<html><head><link rel="canonical" href="/about"></head><body></body></html>`,
  );
  assert.equal(seo.canonicalUrl, "/about");
});

test("reports a missing canonical as null", () => {
  const seo = runSeoChecks(`<html><head></head><body></body></html>`, "https://example.com/");
  assert.equal(seo.canonicalUrl, null);
});

test("reports absent optional elements as null/false rather than guessing", () => {
  const seo = runSeoChecks(`<html><body></body></html>`);
  assert.equal(seo.langAttribute, null);
  assert.equal(seo.canonicalUrl, null);
  assert.equal(seo.hasViewportMeta, false);
});

test("ignores <img> written inside a script, which is not a real image", () => {
  // A regex over the raw HTML would wrongly count this. Cheerio parses
  // properly, so script contents are text, not markup.
  const seo = runSeoChecks(`
    <html><body>
      <img src="real.jpg" alt="Real">
      <script>var t = '<img src="fake.jpg">';</script>
    </body></html>
  `);
  assert.equal(seo.imageCount, 1);
});

// ---------------------------------------------------------------------------
// Inert markup is not on the page
//
// Regression: a <template> is parsed by the browser but never rendered, and
// counting its contents made a correct page report three findings it did not
// deserve — including one whose evidence quoted the template's own placeholder
// back to the client as though it were their heading.
// ---------------------------------------------------------------------------

test("content inside <template> is not counted as being on the page", () => {
  const html = `<html lang="en"><head><title>Products</title></head><body>
    <h1>Products</h1>
    <h2>Featured</h2>
    <p>${"Real visible copy about our products. ".repeat(6)}</p>
    <img src="/hero.png" alt="Our storefront">
    <template id="card">
      <h1>{{ product.name }}</h1>
      <h4>{{ product.sku }}</h4>
      <img src="{{ product.image }}">
    </template>
  </body></html>`;

  const seo = runSeoChecks(html, "https://shop.test/products");

  assert.equal(seo.h1Count, 1, "the template's h1 is never rendered");
  assert.deepEqual(seo.h1Texts, ["Products"], "and its placeholder is not quoted back");
  assert.equal(seo.imageCount, 1);
  assert.equal(seo.imagesMissingAlt, 0, "a placeholder image is not a missing alt");
  assert.deepEqual(seo.headingSkips, [], "h1 to h4 inside a template is not a skip");
});

test("content inside <noscript> is not counted either", () => {
  // The usual occupant is a tracking pixel with no alt attribute, shown only
  // to visitors with scripts disabled.
  const html = `<html lang="en"><head><title>T</title></head><body>
    <p>${"Real content. ".repeat(10)}</p>
    <noscript><img height="1" width="1" src="https://tracker.test/p.gif"></noscript>
  </body></html>`;

  const seo = runSeoChecks(html, "https://x.test/");

  assert.equal(seo.imagesMissingAlt, 0);
});

test("a genuinely broken page is still detected", () => {
  // The fix must remove false positives without hiding real ones.
  const html = `<html><head></head><body>
    <h1>A</h1><h1>B</h1><h4>Deep</h4>
    <p>${"text ".repeat(30)}</p><img src="/x.png">
  </body></html>`;

  const seo = runSeoChecks(html, "https://x.test/");

  assert.equal(seo.h1Count, 2);
  assert.equal(seo.imagesMissingAlt, 1);
  assert.equal(seo.headingSkips.length, 1);
});

// ---------------------------------------------------------------------------
// `rel` IS A LIST OF TOKENS, NOT A STRING
//
// The canonical tag used to be found with an exact attribute match, so a page
// written rel="canonical alternate" — legal, and meaning exactly what
// rel="canonical" means — was read as declaring no canonical URL at all. The
// rule then told the client their page has none.
//
// The other half matters as much: "xcanonical" is its own token and must not
// be mistaken for one.
// ---------------------------------------------------------------------------

const canonicalFrom = (relAttribute: string) =>
  runSeoChecks(
    `<html><head><link rel=${relAttribute} href="/a"></head><body><p>text</p></body></html>`,
    "https://example.com/page",
  ).canonicalUrl;

test("a canonical relation is recognised however the rel is written", () => {
  const declared = [
    '"canonical"',
    '"Canonical"',
    '"CANONICAL"',
    '"canonical alternate"',
    '"alternate canonical"',
    '" canonical "',
    '"  alternate   canonical  "',
    "canonical", // unquoted
    '"nofollow canonical noopener"', // buried in the middle
  ];

  for (const rel of declared) {
    assert.equal(canonicalFrom(rel), "https://example.com/a", `rel=${rel}`);
  }
});

test("a token that merely CONTAINS canonical is not one", () => {
  for (const rel of ['"xcanonical"', '"canonicalfoo"', '"canonical-alternate"', '"canon"']) {
    assert.equal(canonicalFrom(rel), null, `rel=${rel} declares no canonical relation`);
  }
});

test("a link with no rel, or an empty one, declares nothing", () => {
  assert.equal(canonicalFrom('""'), null);
  assert.equal(canonicalFrom('"   "'), null);
  assert.equal(
    runSeoChecks(`<html><head><link href="/a"></head><body><p>t</p></body></html>`).canonicalUrl,
    null,
  );
});

test("the first canonical still wins when a page carries several", () => {
  // Unchanged behaviour, restated so the token fix cannot quietly alter it.
  const seo = runSeoChecks(
    `<html><head>
     <link rel="canonical alternate" href="/first">
     <link rel="canonical" href="/second">
     </head><body><p>text</p></body></html>`,
    "https://example.com/page",
  );

  assert.equal(seo.canonicalUrl, "https://example.com/first");
});

test("a canonical is still resolved against the page it was found on", () => {
  assert.equal(
    runSeoChecks(
      `<html><head><link rel="alternate canonical" href="../a"></head><body><p>t</p></body></html>`,
      "https://example.com/shop/kettles",
    ).canonicalUrl,
    "https://example.com/a",
  );
});

test("a rel token list does not change what OTHER link types mean", () => {
  // The same reader classifies mixed content, so a change here would show up
  // as a stylesheet that stopped counting.
  assert.equal(classifyLink("stylesheet", undefined), "active");
  assert.equal(classifyLink("shortcut icon", undefined), "passive");
  assert.equal(classifyLink("  STYLESHEET  ", undefined), "active");
  assert.equal(classifyLink("canonical", undefined), null, "a canonical fetches nothing");
  assert.equal(classifyLink("", undefined), null);
  assert.equal(classifyLink(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// A VIEWPORT TAG WITH NOTHING IN IT DOES NOTHING
//
// `<meta name="viewport" content="">` is read and ignored by a browser, so the
// phone still renders the page at desktop width. Counting the tag as present
// passed the rule and told the client their page was fine on mobile.
// ---------------------------------------------------------------------------

const viewportFrom = (tag: string) =>
  runSeoChecks(`<html><head>${tag}</head><body><p>text</p></body></html>`).hasViewportMeta;

test("a viewport declaration with content counts", () => {
  assert.equal(viewportFrom('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
  assert.equal(viewportFrom('<meta name="viewport" content="width=device-width">'), true);
  // Whether the content is any GOOD is a different question, deliberately not
  // asked here: anything non-empty is a declaration.
  assert.equal(viewportFrom('<meta name="viewport" content="nonsense">'), true);
});

test("an EMPTY viewport declaration does not count", () => {
  assert.equal(viewportFrom('<meta name="viewport" content="">'), false);
});

test("a whitespace-only viewport declaration does not count", () => {
  assert.equal(viewportFrom('<meta name="viewport" content="   ">'), false);
  assert.equal(viewportFrom('<meta name="viewport" content="\t\n ">'), false);
});

test("a viewport tag with no content attribute at all does not count", () => {
  assert.equal(viewportFrom('<meta name="viewport">'), false);
});

test("no viewport tag does not count", () => {
  assert.equal(viewportFrom(""), false);
  assert.equal(viewportFrom('<meta name="description" content="hello">'), false);
});

test("the viewport name is still matched whatever its case", () => {
  // Unchanged behaviour, kept under test alongside the content change.
  assert.equal(viewportFrom('<meta NAME="Viewport" CONTENT="width=device-width">'), true);
  assert.equal(viewportFrom('<meta NAME="VIEWPORT" CONTENT="">'), false);
});

test("one usable viewport among several is enough", () => {
  // A page with an empty tag and a real one is correctly configured by the
  // real one, so the empty one must not veto it.
  assert.equal(
    viewportFrom('<meta name="viewport" content=""><meta name="viewport" content="width=device-width">'),
    true,
  );
});
