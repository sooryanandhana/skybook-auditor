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
