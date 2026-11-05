/**
 * Tests for what a reader who cannot see the document gets from it.
 *
 * THREE THINGS ARE CHECKED HERE AND NOWHERE ELSE. That the produced file is
 * genuinely tagged, which is a property of the bytes and not of the markup.
 * That the heading outline a reader navigates by is sound. And that the
 * colours clear the contrast 7A §24 asks for, computed rather than judged.
 *
 * NO CONFORMANCE CLAIM IS MADE OR TESTED. This is a tagged, navigable
 * document. It is not a PDF/UA document, for the reason recorded beside the
 * running head and foot, and asserting otherwise would be asserting something
 * this project cannot check.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import zlib from "node:zlib";
import puppeteer from "puppeteer";
import { renderPdf } from "./render.ts";
import { documentHtml } from "./shell.ts";
import { PAGE_FORMAT, PAGE_MARGIN } from "./settings.ts";
import { PAPER, TEXT_COLOURS } from "./styles.ts";
import { testDocument } from "./testDocument.fixture.mts";

/** The whole file as text, compressed object streams included. */
function contents(pdf: Buffer): string {
  const chunks: string[] = [pdf.toString("latin1")];
  let index = 0;
  for (;;) {
    const start = pdf.indexOf("stream", index);
    if (start === -1) break;
    let from = start + 6;
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;
    const end = pdf.indexOf("endstream", from);
    if (end === -1) break;
    try {
      chunks.push(zlib.inflateSync(pdf.subarray(from, end)).toString("latin1"));
    } catch {
      // Not every stream is deflated.
    }
    index = end + 9;
  }
  return chunks.join("");
}

const countOf = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

// ---------------------------------------------------------------------------
// The file is tagged, and the assertion is not vacuous
// ---------------------------------------------------------------------------

test("the produced PDF carries a structure tree and says it is marked", async () => {
  const file = contents(await renderPdf(testDocument()));

  assert.match(file, /\/MarkInfo/, "the catalogue declares marked content");
  assert.match(file, /\/Marked\s+true/, "and declares it true");
  assert.match(file, /\/StructTreeRoot/, "there is a structure tree to read");
});

test("the document declares its language", async () => {
  // 7A §24. Without it a screen reader guesses, and guesses wrong on a
  // document full of proper nouns and web addresses.
  const file = contents(await renderPdf(testDocument()));

  assert.match(file, /\/Lang\s*\(en\)/);
});

test("the reader is told to show the document title rather than the filename", async () => {
  const file = contents(await renderPdf(testDocument()));

  assert.match(file, /\/ViewerPreferences/);
  assert.match(file, /\/DisplayDocTitle/);
});

test("the structure tree carries the elements the document is built from", async () => {
  /*
   * Not a token presence check. Every element type below is one the document
   * actually uses, so a missing one means a section stopped being marked up
   * as what it is.
   */
  const file = contents(await renderPdf(testDocument()));

  for (const element of ["Document", "H1", "H2", "H3", "H4", "P", "Table", "TR", "TH", "TD", "L", "LI", "Figure"]) {
    assert.ok(
      countOf(file, new RegExp(`/S\\s*/${element}[^A-Za-z0-9]`, "g")) > 0,
      `the tree carries ${element}`,
    );
  }
});

test("turning tagging off loses all of it, so the tests above mean something", async () => {
  /*
   * THE CONTROL. Every assertion above would pass on a file that was tagged by
   * somebody else's default, and would go on passing if that default changed
   * and something else put a structure tree there. This renders the same page
   * with tagging off and shows the tree is gone, which is what makes the
   * explicit setting in `render.ts` load-bearing rather than decorative.
   */
  const document = testDocument();
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setContent(documentHtml(document), { waitUntil: "load" });

    const untagged = contents(
      Buffer.from(
        await page.pdf({
          format: PAGE_FORMAT,
          printBackground: true,
          margin: { ...PAGE_MARGIN },
          displayHeaderFooter: false,
          tagged: false,
        }),
      ),
    );

    assert.ok(!/\/StructTreeRoot/.test(untagged), "no tree without tagging");
    assert.ok(!/\/Lang\s*\(en\)/.test(untagged), "and no language either");
    assert.equal(countOf(untagged, /\/S\s*\/H1[^A-Za-z0-9]/g), 0, "and no headings");
  } finally {
    await browser.close();
  }
});

test("the logo reaches the tree as a figure with alternative text", async () => {
  // The one graphic in the document. Unlabelled it would be announced as an
  // image and nothing more, at the top of the first page.
  const file = contents(await renderPdf(testDocument()));

  assert.ok(countOf(file, /\/S\s*\/Figure[^A-Za-z0-9]/g) > 0);
  assert.match(file, /\/Alt/);
});

// ---------------------------------------------------------------------------
// The heading outline
// ---------------------------------------------------------------------------

/** Every heading in the document, in order, as its level. */
function outline(html: string): { level: number; text: string }[] {
  return [...html.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => ({
    level: Number(match[1][1]),
    text: match[2].replace(/<[^>]*>/g, ""),
  }));
}

test("the document has exactly one first-level heading", () => {
  const first = outline(documentHtml(testDocument())).filter((heading) => heading.level === 1);

  assert.equal(first.length, 1, "one document, one title");
});

test("no heading level is ever skipped", () => {
  /*
   * THE DEFECT THIS WAS WRITTEN FOR. The cover once ran h1 then h3: a reader
   * navigating by heading was told the document jumped from its title to a
   * third-level section called "Prepared for", which was a label rather than a
   * section at all.
   */
  const headings = outline(documentHtml(testDocument()));
  let previous = headings[0].level;

  for (const heading of headings) {
    assert.ok(
      heading.level <= previous + 1,
      `"${heading.text}" is an h${heading.level} after an h${previous}`,
    );
    previous = heading.level;
  }
});

test("the outline starts at the document title", () => {
  assert.equal(outline(documentHtml(testDocument()))[0].level, 1);
});

test("every section that a reader would navigate to is a second-level heading", () => {
  const levels = outline(documentHtml(testDocument()));

  // The redesigned report's sections (CP3 step 4b, F1). The fixture has page findings, so Page-Level Issues is there.
  for (const section of [
    "Executive Summary",
    "Page-Level Issues",
    "SEO Audit",
    "Security Audit",
    "Speed",
    "Technical Audit",
    "Let&#39;s Make Your Website Work Better for Your Business", // as escaped in the markup the outline reads
    "Limitations and About This Audit",
  ]) {
    const heading = levels.find((one) => one.text === section);
    assert.ok(heading, `${section} is a heading`);
    assert.equal(heading.level, 2, `${section} is a section`);
  }
});

// ---------------------------------------------------------------------------
// Contrast, computed rather than judged
// ---------------------------------------------------------------------------

/** One channel, linearised. The WCAG definition, not an approximation of it. */
function channel(value: number): number {
  const proportion = value / 255;
  return proportion <= 0.04045 ? proportion / 12.92 : ((proportion + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = channel((value >> 16) & 0xff);
  const green = channel((value >> 8) & 0xff);
  const blue = channel(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The WCAG contrast ratio between two colours, lighter over darker. */
function ratio(one: string, two: string): number {
  const first = luminance(one);
  const second = luminance(two);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("the ratio is computed correctly, checked against known values", () => {
  // Black on white is 21 to 1, and any colour against itself is 1 to 1. If
  // these are wrong every assertion below is meaningless.
  assert.ok(Math.abs(ratio("#000000", "#ffffff") - 21) < 0.01);
  assert.ok(Math.abs(ratio("#ffffff", "#ffffff") - 1) < 0.001);
  assert.ok(Math.abs(ratio("#767676", "#ffffff") - 4.54) < 0.05, "the classic 4.5:1 grey");
});

test("every colour set on text clears 4.5 to 1 against the paper", () => {
  // 7A §24. Computed, because these were chosen by eye and eyes are wrong
  // about exactly one value in a palette.
  for (const [role, colour] of Object.entries(TEXT_COLOURS)) {
    const measured = ratio(colour, PAPER);
    assert.ok(measured >= 4.5, `${role} (${colour}) is ${measured.toFixed(2)}:1, below 4.5:1`);
  }
});

test("the severity colours are legible as well as distinct", () => {
  // A severity chip's own text takes its severity's colour, so these are read
  // rather than merely seen.
  for (const severity of ["critical", "high", "medium", "good"]) {
    assert.ok(ratio(TEXT_COLOURS[severity], PAPER) >= 4.5);
  }
});

test("the brightest brand blue is never used as a text colour", () => {
  /*
   * IT CANNOT BE READ, AND THAT IS MEASURED. 2.88:1 on white, well under the
   * 4.5 7A §24 asks for, so it belongs on rules and accents and nowhere a
   * reader has to take words from.
   *
   * The mid blue is deliberately not asserted here. An earlier version of this
   * test claimed it failed too, and it does not: it is 4.56:1 and would pass.
   * It is still kept off text, because 4.56 leaves nothing spare, but that is
   * a design choice rather than a contrast failure and the test should not
   * pretend otherwise.
   */
  const bright = "#05a2e4";

  assert.ok(ratio(bright, PAPER) < 4.5, `${bright} cannot be read at body size`);
  assert.ok(
    !Object.values(TEXT_COLOURS).includes(bright),
    `${bright} must not appear among the text colours`,
  );
});

test("the caption colour clears the ratio it used to fail", () => {
  /*
   * THE DEFECT THIS FILE FOUND. The caption colour was #7c89a3, which is
   * 3.52:1, and it carries every label, caption and column heading in the
   * document. It looked right and it was wrong, which is the whole argument
   * for computing the number rather than judging it.
   */
  assert.ok(ratio(TEXT_COLOURS.caption, PAPER) >= 4.5);
  assert.notEqual(TEXT_COLOURS.caption, "#7c89a3", "the failing value is gone");
});
