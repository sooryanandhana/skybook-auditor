/**
 * Tests for the served-HTML text measurement and the gate built on it.
 *
 * Two separate things are being protected here:
 *
 *   1. The measurement stays a measurement. It counts characters. It does not
 *      decide anything, and there is deliberately no boolean anywhere saying a
 *      page is client-rendered — that would be a guess with a confident name.
 *
 *   2. The gate applies to BODY-dependent facts only. Head-based facts are
 *      served in the markup whether or not a page builds its body in the
 *      browser, so they must keep being judged on their own.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import * as cheerio from "cheerio";
import { measureBodyText, runSeoChecks } from "../collector/seoChecks.ts";
import { MIN_BODY_TEXT_FOR_SEO, fromRenderedBody } from "./selectors.ts";
import type { SeoData } from "../types.ts";

const SPA_SHELL = `<html><head><title>App</title>
<meta name="description" content="A client-rendered application.">
<link rel="canonical" href="https://app.test/">
<meta name="viewport" content="width=device-width">
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

const REAL_PAGE = `<html lang="en"><head><title>Kettles</title>
<meta name="description" content="Every kettle we sell, compared.">
</head><body>
<h1>Kettles</h1>
<p>We compare every kettle we sell on speed, noise and how long the handle stays cool. Prices are checked weekly and include delivery.</p>
</body></html>`;

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

test("counts the visible text the served HTML actually carried", () => {
  assert.equal(measureBodyText(cheerio.load("<body></body>")), 0);
  assert.equal(measureBodyText(cheerio.load("<body>Hello there</body>")), 11);
  assert.ok(measureBodyText(cheerio.load(REAL_PAGE)) > 100);
});

test("a client-rendered shell measures zero", () => {
  // The whole reason this exists: nothing here is visible to a reader, so
  // there is nothing to judge the page's headings by.
  assert.equal(measureBodyText(cheerio.load(SPA_SHELL)), 0);
});

test("script, style, noscript and template contents are not visible text", () => {
  const cases = [
    `<body><script>var a = "${"x".repeat(500)}";</script></body>`,
    `<body><style>.a{content:"${"y".repeat(500)}"}</style></body>`,
    `<body><noscript>You need to enable JavaScript to run this app.</noscript></body>`,
    `<body><template><p>${"z".repeat(500)}</p></template></body>`,
  ];

  for (const html of cases) {
    assert.equal(
      measureBodyText(cheerio.load(html)),
      0,
      `none of this is shown to a visitor: ${html.slice(0, 40)}`,
    );
  }
});

test("a long noscript banner does not push a JS shell over the coverage gate", () => {
  // The realistic false positive: a client-rendered shell whose only body text is
  // a lengthy "please enable JavaScript" notice — well over the threshold in raw
  // characters. If noscript were counted, the shell would read as a real page and
  // its body rules would fire on content that no visitor sees. Measured through
  // runSeoChecks, the production path, so the stripping is proven where it counts.
  const banner =
    "This application requires JavaScript to run. Please enable JavaScript in your " +
    "browser settings and reload the page to continue using our online shop.";
  assert.ok(banner.length > MIN_BODY_TEXT_FOR_SEO, "the banner alone would clear the gate if counted");

  const shell = `<html><head><title>App</title></head><body>` +
    `<div id="root"></div><noscript>${banner}</noscript><script src="/b.js"></script></body>`;

  const seo = runSeoChecks(shell, "https://app.test/");
  assert.equal(seo.bodyTextLength, 0, "the noscript notice is not visible body text");
  assert.equal(fromRenderedBody(seo).measured, false, "so body rules stay skipped, not passed");
});

test("measuring does not disturb the rest of the parse", () => {
  // It works on a clone. If it did not, removing script tags would change the
  // facts every other check reads afterwards.
  const seo = runSeoChecks(
    `<html><head><title>T</title></head><body><h1>Head</h1><script>1</script><img src="a.png"></body></html>`,
  );

  assert.equal(seo.h1Count, 1);
  assert.equal(seo.imageCount, 1);
  assert.equal(seo.titleText, "T");
});

test("the measurement is on SeoData as a plain number", () => {
  const seo = runSeoChecks(REAL_PAGE);

  assert.equal(typeof seo.bodyTextLength, "number");
  assert.ok(seo.bodyTextLength > 0);
});

test("there is no boolean verdict about rendering anywhere in the facts", () => {
  // A field like `isClientRendered` would be a guess with a confident name.
  // The facts carry a count; conclusions belong to a rule, with a documented
  // threshold that can be argued with.
  const seo = runSeoChecks(SPA_SHELL) as unknown as Record<string, unknown>;

  for (const key of Object.keys(seo)) {
    assert.ok(
      !/clientRendered|isSpa|javascriptRendered|renderedByJs/i.test(key),
      `SeoData must carry measurements, not verdicts (found "${key}")`,
    );
  }
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("a real page passes the gate", () => {
  const result = fromRenderedBody(runSeoChecks(REAL_PAGE));

  assert.equal(result.measured, true);
});

test("a shell does not, and says why in words a report can print", () => {
  const result = fromRenderedBody(runSeoChecks(SPA_SHELL));

  assert.equal(result.measured, false);
  if (!result.measured) {
    assert.match(result.reason, /0 characters of visible text/);
    assert.match(result.reason, /does not run JavaScript/);
    // It reports our limitation, not a fault in the site.
    assert.ok(!/poor|bad|broken|missing headings/i.test(result.reason));
  }
});

test("the threshold sits between a shell and the smallest real page", () => {
  // Measured: shells 0, example.com 125, info.cern.ch 271.
  assert.ok(MIN_BODY_TEXT_FOR_SEO > 0, "must exclude an empty shell");
  assert.ok(MIN_BODY_TEXT_FOR_SEO < 125, "must still grade a page as small as example.com");
});

test("the boundary is inclusive, so a page exactly at the threshold is graded", () => {
  const at: SeoData = { ...runSeoChecks(REAL_PAGE), bodyTextLength: MIN_BODY_TEXT_FOR_SEO };
  const below: SeoData = { ...at, bodyTextLength: MIN_BODY_TEXT_FOR_SEO - 1 };

  assert.equal(fromRenderedBody(at).measured, true);
  assert.equal(fromRenderedBody(below).measured, false);
});

test("the gate never invents a value — it only withholds", () => {
  const seo = runSeoChecks(REAL_PAGE);
  const result = fromRenderedBody(seo);

  // What comes through is the same object, untouched.
  assert.equal(result.measured, true);
  if (result.measured) assert.equal(result.value, seo);
});

// ---------------------------------------------------------------------------
// Head-based facts stay independently evaluable
// ---------------------------------------------------------------------------

test("a shell still yields its head-based facts", () => {
  // These are served in the markup either way, so a body-based gate must not
  // stop them being judged.
  const seo = runSeoChecks(SPA_SHELL);

  assert.equal(seo.titleText, "App");
  assert.equal(seo.metaDescriptionText, "A client-rendered application.");
  assert.equal(seo.canonicalUrl, "https://app.test/");
  assert.equal(seo.hasViewportMeta, true);
});

test("a shell missing its head facts still reports them as missing", () => {
  // The point of keeping head rules ungated: a client-rendered page with no
  // title has a real, reportable problem, and the empty body must not excuse
  // it.
  const seo = runSeoChecks(`<html><head></head><body><div id="root"></div></body></html>`);

  assert.equal(seo.titleText, null);
  assert.equal(seo.metaDescriptionText, null);
  assert.equal(seo.hasViewportMeta, false);

  // And the body-dependent facts are the ones withheld.
  assert.equal(fromRenderedBody(seo).measured, false);
});

test("the gate reads only the body measurement, never the head facts", () => {
  // Same body length, wildly different heads. The gate must not care.
  const withHead = { ...runSeoChecks(REAL_PAGE), bodyTextLength: 10 };
  const withoutHead: SeoData = {
    ...withHead,
    titleText: null,
    titleLength: 0,
    metaDescriptionText: null,
    metaDescriptionLength: 0,
    canonicalUrl: null,
  };

  assert.equal(fromRenderedBody(withHead).measured, false);
  assert.equal(fromRenderedBody(withoutHead).measured, false);
});
