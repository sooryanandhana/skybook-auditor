/**
 * Tests for the page a prospect actually reads.
 *
 * THE CLIENT FIELDS ARE ALL OPTIONAL, and 7A §15 requires the document to be
 * correct without any of them. Most of this file is the eight combinations
 * that produces, because the cover is the worst place in the document to be
 * wrong and "we never tried it empty" is how a cover ends up saying
 * "Prepared for" followed by nothing.
 *
 * No browser is launched here. Everything asserted is a property of a string.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { coverHtml } from "./cover.ts";
import { testDocument } from "./testDocument.fixture.mts";
import type { PdfCover } from "../pdfDocument.ts";

/** The fixture's cover, with the named fields replaced. */
function cover(over: Partial<PdfCover> = {}, client: Partial<PdfCover["client"]> = {}): PdfCover {
  const base = testDocument().cover;
  return { ...base, ...over, client: { ...base.client, ...client } };
}

const EMPTY_CLIENT = { companyName: null, contactName: null, preparedBy: null };

// ---------------------------------------------------------------------------
// Who the report is for
// ---------------------------------------------------------------------------

test("a full set of client details is shown, each on its own line", () => {
  const out = coverHtml(
    cover({}, { companyName: "Acme Ltd", contactName: "Dana Okafor", preparedBy: "Soorya" }),
  );

  assert.ok(out.includes("Prepared for"));
  assert.ok(out.includes("Acme Ltd"));
  assert.ok(out.includes("Dana Okafor"));
  assert.ok(out.includes("Prepared by Soorya"));
});

test("with no client details at all the cover names the audited site", () => {
  // 7A §19. This is the case that has to be right, because it is the default:
  // every field is optional and a salesperson in a hurry fills in none.
  const out = coverHtml(cover({}, EMPTY_CLIENT));

  assert.ok(out.includes("Website audit for"));
  assert.ok(out.includes("https://example.com/"));
  assert.ok(!out.includes("Prepared for"), "no heading with nothing under it");
  assert.ok(!out.includes("Prepared by"), "and no author line either");
});

test("the cover never invents a company name from the domain", () => {
  // 7A §15 says so outright. A prospect whose company is not named after their
  // domain would notice immediately, and the cover is where they would look.
  const out = coverHtml(cover({ auditedUrl: "https://acme-widgets.co.uk/" }, EMPTY_CLIENT));

  assert.ok(out.includes("https://acme-widgets.co.uk/"), "the address, verbatim");
  assert.ok(!/Acme Widgets/i.test(out), "and nothing derived from it");
});

test("a company with no contact shows the company alone", () => {
  const out = coverHtml(cover({}, { companyName: "Acme Ltd", contactName: null, preparedBy: null }));

  assert.ok(out.includes("Prepared for"));
  assert.ok(out.includes("Acme Ltd"));
  assert.ok(!out.includes("Website audit for"), "the fallback heading is not used");
});

test("a contact with no company shows the contact alone", () => {
  const out = coverHtml(cover({}, { companyName: null, contactName: "Dana Okafor", preparedBy: null }));

  assert.ok(out.includes("Prepared for"));
  assert.ok(out.includes("Dana Okafor"));
});

test("an author with no client still falls back to the site", () => {
  // "Prepared by" says who wrote it, not who it is for, so it must not stop
  // the addressee falling back.
  const out = coverHtml(cover({}, { companyName: null, contactName: null, preparedBy: "Soorya" }));

  assert.ok(out.includes("Website audit for"));
  assert.ok(out.includes("Prepared by Soorya"));
});

// ---------------------------------------------------------------------------
// The site, and where it started
// ---------------------------------------------------------------------------

test("the audited address is always on the cover", () => {
  assert.ok(coverHtml(cover()).includes("https://example.com/"));
});

test("a redirect is explained; an audit that did not redirect says nothing", () => {
  const redirected = coverHtml(cover({ requestedUrl: "http://example.com" }));
  assert.ok(redirected.includes("http://example.com"));
  assert.ok(redirected.includes("redirected here"));

  assert.ok(!coverHtml(cover({ requestedUrl: null })).includes("redirected here"));
});

// ---------------------------------------------------------------------------
// A partial crawl, said in words
// ---------------------------------------------------------------------------

test("a partial audit is marked on the cover, in words", () => {
  // 7A §13 forbids presenting a partial crawl as a whole-site audit, and 7A
  // §24 forbids carrying a state by colour alone.
  const out = coverHtml(cover({ partial: true, statusLine: "Partial website audit" }));

  assert.ok(out.includes("Partial audit"), "the marker");
  assert.ok(out.includes("Partial website audit"), "and the status line");
});

test("a complete audit carries no partial marker", () => {
  const out = coverHtml(cover({ partial: false, statusLine: "Website audit complete" }));

  assert.ok(!out.includes("Partial"));
  assert.ok(out.includes("Website audit complete"));
});

// ---------------------------------------------------------------------------
// When the site was measured
// ---------------------------------------------------------------------------

test("the audit time is printed as the projection phrased it", () => {
  assert.ok(coverHtml(cover()).includes("Measured 8 September 2026 at 10:00 UTC"));
});

test("an absent audit time removes the line rather than labelling nothing", () => {
  const out = coverHtml(cover({ checkedAt: null }));

  assert.ok(!out.includes("Measured"));
  assert.ok(!out.includes("null"));
});

// ---------------------------------------------------------------------------
// The mark, until the real one exists
// ---------------------------------------------------------------------------

test("the cover carries the supplied artwork, not a drawing of it", () => {
  // 7A §27 forbids recreating the mark from what is on screen. This is the
  // asset itself, and nothing here draws a substitute for it.
  const out = coverHtml(cover());

  assert.ok(out.includes("<img"), "the artwork is placed");
  assert.ok(!out.includes("<svg"), "nothing is drawn from memory");
  assert.ok(!out.includes("wordmark"), "and the typeset stand-in is gone");
});

test("the mark travels inside the document rather than being fetched", () => {
  // The renderer aborts every request the page makes, so an asset referenced
  // by path would fail silently and leave a gap on the cover.
  const out = coverHtml(cover());

  assert.ok(out.includes('src="data:image/jpeg;base64,'), "embedded as data");
  assert.ok(!/src="[^"]*\.(jpe?g|png|svg)"/i.test(out), "and never as a path");
  assert.ok(!/src="https?:/.test(out), "and never as an address");
});

test("the mark is labelled for a reader who cannot see it", () => {
  // 7A §24. An unlabelled graphic at the top of the first page is the worst
  // place to leave one.
  assert.match(coverHtml(cover()), /alt="Skybook Digital"/);
});

test("the mark is on every cover, whatever the client fields say", () => {
  const everyCase = [
    cover({}, EMPTY_CLIENT),
    cover({}, { companyName: "Acme Ltd" }),
    cover({ partial: true }, EMPTY_CLIENT),
    cover({ checkedAt: null, requestedUrl: "http://example.com" }, { preparedBy: "Soorya" }),
  ];

  for (const one of everyCase) {
    assert.ok(coverHtml(one).includes('alt="Skybook Digital"'));
  }
});

// ---------------------------------------------------------------------------
// Nothing on the cover becomes markup
// ---------------------------------------------------------------------------

test("a client name carrying markup is rendered as text", () => {
  // These fields are typed by a Skybook employee rather than by the audited
  // site, and 7A §15 still requires them rendered as plain text.
  const out = coverHtml(cover({}, { companyName: '<script>steal()</script>' }));

  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("a hostile audited address cannot add an element to the cover", () => {
  const plain = coverHtml(cover({ auditedUrl: "https://example.com/" }, EMPTY_CLIENT));
  const hostile = coverHtml(
    cover({ auditedUrl: '"><b>x</b><img src=x onerror=steal()>' }, EMPTY_CLIENT),
  );

  assert.equal(
    (hostile.match(/</g) ?? []).length,
    (plain.match(/</g) ?? []).length,
    "markup in a document value adds no elements",
  );
});

// ---------------------------------------------------------------------------
// It is a page, not a block
// ---------------------------------------------------------------------------

test("the cover is one element the stylesheet can put on its own page", () => {
  assert.ok(coverHtml(cover()).startsWith('<div class="cover">'));
});
