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
import { COVER_ADDRESS, COVER_COLUMN_MM, COVER_REDIRECT, coverHtml } from "./cover.ts";
import { sansWidthMm } from "./textWidth.ts";
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
  assert.ok(out.includes('<p class="cover-sign-line">Soorya</p>'), "the preparer, on a line of their own");
});

test("with no client details at all the cover names the audited site", () => {
  // 7A §19. This is the case that has to be right, because it is the default:
  // every field is optional and a salesperson in a hurry fills in none.
  const out = coverHtml(cover({}, EMPTY_CLIENT));

  assert.ok(out.includes("Website audit for"));
  assert.ok(out.includes("https://example.com/"));
  assert.ok(!out.includes("Prepared for"), "no heading with nothing under it");
  assert.ok(!out.includes("cover-sign-line"), "and no author line either");
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
  assert.ok(out.includes('<p class="cover-sign-line">Soorya</p>'));
});

test("the cover is always signed: the label, then the brand", () => {
  /*
   * THE LABEL IS NEVER LEFT HEADING NOTHING. Skybook prepared every report, so
   * "Prepared by" always has the brand beneath it, whether or not an individual
   * is named above the brand.
   */
  for (const preparedBy of [null, "Soorya"]) {
    const out = coverHtml(cover({}, { preparedBy }));
    const sign = out.split('<div class="cover-sign">')[1]?.split("</div>")[0] ?? "";

    assert.ok(sign.includes(">Prepared by</p>"), "the label");
    assert.ok(sign.endsWith('<p class="cover-sign-brand">Skybook</p>'), "and the brand last");
  }
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

test("a complete audit carries no partial marker, and no status line (CP1 F7)", () => {
  const out = coverHtml(cover({ partial: false, statusLine: "Website audit complete" }));

  assert.ok(!out.includes("Partial"));
  assert.ok(!out.includes("Website audit complete"), "the internal complete-status line is not printed");
  assert.ok(!out.includes(`class="cover-status"`), "no status line at all");
});

test("a partial audit's status line is the model's own text, in its place on the cover (CP1 F7)", () => {
  const out = coverHtml(cover({ partial: true, statusLine: "Partial website audit" }));

  assert.equal(out.split(`<p class="cover-status">Partial website audit</p>`).length - 1, 1, "printed once");
  assert.ok(out.indexOf(`class="cover-status"`) > out.indexOf(`class="cover-date"`), "after the audit date");
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
// The title, and the figure beside it
// ---------------------------------------------------------------------------

test("the title is two lines and is the cover's only heading", () => {
  const out = coverHtml(cover());

  assert.ok(out.includes('<h1 class="cover-title">Website<br>Audit Report</h1>'));
  assert.equal((out.match(/<h[1-6]/g) ?? []).length, 1, "nothing else on the cover is a heading");
});

test("the figure is four empty shapes, hidden from a screen reader", () => {
  const out = coverHtml(cover());
  const figure = out.split('<div class="cover-figure" aria-hidden="true">')[1]?.split("</div>")[0];

  assert.ok(figure !== undefined, "the figure is there and marked as decoration");
  for (const shape of ["cover-strip", "cover-ring", "cover-outline", "cover-disc"]) {
    assert.ok(figure.includes(`<span class="${shape}"></span>`), `${shape} is drawn`);
  }
  assert.equal(figure.replace(/<[^>]+>/g, "").trim(), "", "and it carries no words");
});

test("the figure is drawn before the panel, so the panel can cover its left half", () => {
  const out = coverHtml(cover());

  assert.ok(out.indexOf('class="cover-figure"') < out.indexOf('class="cover-left"'));
});

test("the cover draws nothing it was not given: no grade, no score, no picture but the mark", () => {
  // The artwork has none of these, and none of them is the cover's to state.
  const out = coverHtml(cover());

  assert.ok(!/grade|score/i.test(out));
  assert.ok(!out.includes("/ 100"));
  assert.equal((out.match(/<img/g) ?? []).length, 1, "the mark is the only image");
});

test("the order down the panel is the artwork's", () => {
  const out = coverHtml(cover({}, { companyName: "Acme Ltd", contactName: null, preparedBy: null }));
  const at = (needle: string) => out.indexOf(needle);

  assert.ok(at('class="logo"') < at("Prepared for"), "the mark, then who it is for");
  assert.ok(at("Prepared for") < at("<h1"), "then the title");
  assert.ok(at("<h1") < at('class="cover-accent"'), "then the rule");
  assert.ok(at('class="cover-accent"') < at("Audit date"), "then the date");
  assert.ok(at("Audit date") < at("Prepared by"), "and the signature last");
});

// ---------------------------------------------------------------------------
// It is a page, not a block
// ---------------------------------------------------------------------------

test("the cover is one element the stylesheet can put on its own page", () => {
  assert.ok(coverHtml(cover()).startsWith('<div class="cover">'));
});

// ---------------------------------------------------------------------------
// A long address keeps to its lines
// ---------------------------------------------------------------------------

/*
 * THE DEFECT THIS WAS WRITTEN FOR. The cover's blocks are placed at fixed
 * heights, and the address had no limit. A 344-character address wrapped to
 * thirteen lines and ran through the report title beneath it, and a
 * 566-character one did the same, leaving both the address and the title
 * unreadable. These are those two addresses.
 */
const WIDE_ADDRESS = "https://www.example.com/" + "WWWWMMMM".repeat(40);
const LONG_ADDRESS =
  "https://www.example.com/" + Array.from({ length: 24 }, (_value, index) => `a-long-path-segment-${index}`).join("/") + "/";

/** The text of the first element carrying the given class, as the reader sees it. */
function shown(out: string, className: string): string {
  const start = out.indexOf(`class="${className}">`);
  assert.ok(start > -1, `${className} is on the cover`);
  const from = start + className.length + 9;
  return out
    .slice(from, out.indexOf("<", from))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** How many lines a text takes in the cover's column, filled a character at a time. */
function coverLines(text: string, sizePt: number, letterSpacingEm: number): number {
  let lines = 1;
  let used = 0;
  for (const character of text) {
    const width = sansWidthMm(character, sizePt, letterSpacingEm);
    if (used + width > COVER_COLUMN_MM && used > 0) {
      lines += 1;
      used = 0;
    }
    used += width;
  }
  return lines;
}

test("an ordinary address is on the cover whole", () => {
  for (const auditedUrl of ["https://example.com/", "https://www.ademstravel.com/", "https://www.a-rather-long-company-name-holdings.example.co.uk/en-gb/"]) {
    const address = shown(coverHtml(cover({ auditedUrl })), "url cover-domain");

    assert.equal(address, auditedUrl, "exactly as it was measured");
    assert.ok(!address.includes("…"));
  }
});

test("the two addresses that ran through the title now keep to their lines", () => {
  for (const auditedUrl of [WIDE_ADDRESS, LONG_ADDRESS]) {
    const address = shown(coverHtml(cover({ auditedUrl })), "url cover-domain");
    const lines = coverLines(address, COVER_ADDRESS.sizePt, COVER_ADDRESS.spacingEm);

    assert.ok(lines <= COVER_ADDRESS.lines, `${[...auditedUrl].length} characters take ${lines} line(s)`);
    assert.ok(address.endsWith("…"), "and the cut is marked");
    assert.ok(auditedUrl.startsWith(address.slice(0, -1)), "what is kept is the address's own beginning");
    assert.ok(address.startsWith("https://www.example.com/"), "so it still says which site");
  }
});

test("no address, however it is made, takes more than its lines", () => {
  const addresses = [
    "W".repeat(1000),
    "i".repeat(5000),
    "https://example.com/" + "漢字".repeat(300),
    "https://example.com/?" + "q=%20&".repeat(400),
    "https://example.com/" + "😀".repeat(300),
  ];

  for (const auditedUrl of addresses) {
    const address = shown(coverHtml(cover({ auditedUrl })), "url cover-domain");

    assert.ok(coverLines(address, COVER_ADDRESS.sizePt, COVER_ADDRESS.spacingEm) <= COVER_ADDRESS.lines);
    assert.ok(address.endsWith("…"));
  }
});

test("a wide address is cut shorter than a narrow one, because it is measured", () => {
  const wide = shown(coverHtml(cover({ auditedUrl: "W".repeat(1000) })), "url cover-domain");
  const narrow = shown(coverHtml(cover({ auditedUrl: "i".repeat(5000) })), "url cover-domain");

  assert.ok([...narrow].length > [...wide].length * 2, "a count of characters would have got one of them wrong");
});

test("a long address a redirect started from is cut too, and the sentence around it survives", () => {
  const out = coverHtml(cover({ requestedUrl: WIDE_ADDRESS }));
  const requested = shown(out, "cover-redirect-url");
  const sentence = `Requested ${requested}, which redirected here`;

  assert.ok(requested.endsWith("…"), "the cut is marked");
  assert.ok(WIDE_ADDRESS.startsWith(requested.slice(0, -1)));
  assert.ok(out.includes("</span>, which redirected here</p>"), "the sentence still ends as it should");
  assert.ok(
    sansWidthMm(sentence, COVER_REDIRECT.sizePt) <= COVER_COLUMN_MM * COVER_REDIRECT.lines,
    "and the whole note is no longer than its lines",
  );
});

test("a short address a redirect started from is shown whole", () => {
  const out = coverHtml(cover({ requestedUrl: "http://example.com" }));

  assert.equal(shown(out, "cover-redirect-url"), "http://example.com");
  assert.ok(out.includes("Requested "));
});

test("cutting an address takes nothing else off the cover", () => {
  const out = coverHtml(
    cover(
      { auditedUrl: LONG_ADDRESS, requestedUrl: WIDE_ADDRESS, partial: true, statusLine: "Partial website audit" },
      { companyName: "Acme Ltd", contactName: "Dana Okafor", preparedBy: "Soorya" },
    ),
  );

  for (const needle of ["Partial audit", "Partial website audit", "Prepared for", "Acme Ltd", "Dana Okafor", "Audit date", "Measured 8 September 2026 at 10:00 UTC", "Prepared by", "Soorya", '<h1 class="cover-title">Website<br>Audit Report</h1>']) {
    assert.ok(out.includes(needle), `${needle} is still there`);
  }
});

test("a cut address is still text, never markup", () => {
  const hostile = '<script>fetch("https://evil.example")</script>'.repeat(40);
  const out = coverHtml(cover({ auditedUrl: hostile, requestedUrl: hostile }));

  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});
