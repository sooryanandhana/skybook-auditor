/**
 * Tests for measuring a line of the embedded sans.
 *
 * ONE PROPERTY CARRIES THIS FILE: the width worked out here is the width the
 * browser will set the line at, or a little more, and never less. Everything
 * that fits a line into a margin trusts it, and an answer that came out narrow
 * would print an address across the mark beside it.
 *
 * THE EXPECTED WIDTHS BELOW WERE READ BACK FROM CHROMIUM, not copied from this
 * code's own output: the same characters laid out in the same embedded face,
 * on Chrome 152, gave these advances to four decimal places.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { EMBEDDED_FACES } from "./fonts.ts";
import { fitSans, fitSansLines, sansWidthMm } from "./textWidth.ts";

/** At 72pt an em is exactly one inch, so a width in millimetres over 25.4 is a width in ems. */
const ems = (text: string, letterSpacingEm = 0) => sansWidthMm(text, 72, letterSpacingEm) / 25.4;
const close = (actual: number, expected: number) => Math.abs(actual - expected) < 0.0001;

// ---------------------------------------------------------------------------
// The widths are the face's own
// ---------------------------------------------------------------------------

test("the face measured is one the document embeds", () => {
  assert.ok(EMBEDDED_FACES.includes("IBMPlexSans-Regular.ttf"));
});

test("each character has the advance the browser gives it", () => {
  const measured: Record<string, number> = {
    i: 0.25, I: 0.4, l: 0.272, W: 0.891, M: 0.812, A: 0.641, a: 0.534, s: 0.487,
    ":": 0.292, "/": 0.383, ".": 0.272, "-": 0.399, "0": 0.6, " ": 0.236, "·": 0.326, "…": 0.803,
  };

  for (const [character, expected] of Object.entries(measured)) {
    assert.ok(close(ems(character), expected), `"${character}" is ${ems(character).toFixed(4)}em, expected ${expected}`);
  }
});

test("a line is as wide as its characters together", () => {
  assert.ok(close(ems("https://"), ems("h") + ems("t") * 2 + ems("p") + ems("s") + ems(":") + ems("/") * 2));
  assert.equal(sansWidthMm("", 8), 0);
});

test("the width scales with the size", () => {
  assert.ok(close(sansWidthMm("Skybook", 16), sansWidthMm("Skybook", 8) * 2));
});

test("letter-spacing adds its space after every character", () => {
  assert.ok(close(ems("Skybook", 0.06), ems("Skybook") + 7 * 0.06));
});

test("the same letters are far from the same width, which is why this exists", () => {
  assert.ok(ems("W".repeat(80)) > ems("i".repeat(80)) * 3);
});

// ---------------------------------------------------------------------------
// What the face does not contain is counted wide, never narrow
// ---------------------------------------------------------------------------

test("a character the face lacks is counted as a full em", () => {
  // The browser sets it in some other face that cannot be measured from here.
  // A full em is as wide as running text gets, so the answer cannot be short.
  assert.ok(close(ems("漢"), 1));
  assert.ok(close(ems("漢字"), 2));
});

test("a character outside the basic plane is one character, and a full em", () => {
  assert.ok(close(ems("😀"), 1), "one em, not two for its two halves");
});

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

test("a text that fits is returned exactly as it was", () => {
  const text = "https://www.ademstravel.com/";
  assert.equal(fitSans(text, 8, sansWidthMm(text, 8)), text, "even when it fits with nothing to spare");
  assert.equal(fitSans(text, 8, 500), text);
});

test("a text that does not fit is cut to fit, and marked as cut", () => {
  for (const text of ["W".repeat(200), "i".repeat(900), "https://www.example.com/" + "segment/".repeat(80), "漢".repeat(200)]) {
    for (const room of [20, 60, 133.3]) {
      const fitted = fitSans(text, 8, room);

      assert.ok(fitted.endsWith("…"), "it says it was cut");
      assert.ok(sansWidthMm(fitted, 8) <= room, `${sansWidthMm(fitted, 8).toFixed(2)}mm fits in ${room}mm`);
      assert.ok(text.startsWith(fitted.slice(0, -1)), "and what is kept is its own beginning");
    }
  }
});

test("fitting keeps as much as there is room for, not merely something that fits", () => {
  const text = "i".repeat(900);
  const fitted = fitSans(text, 8, 60);
  const oneMore = fitted.slice(0, -1) + "i…";

  assert.ok(sansWidthMm(oneMore, 8) > 60, "one more character would not have fitted");
});

test("a character made of two halves is never cut in the middle", () => {
  const fitted = fitSans("😀".repeat(100), 8, 30);

  assert.ok(fitted.endsWith("…"));
  assert.equal([...fitted.slice(0, -1)].every((character) => character === "😀"), true);
});

test("with no room at all, only the mark of a cut is left", () => {
  assert.equal(fitSans("https://example.com/", 8, 0), "…");
});

// ---------------------------------------------------------------------------
// Fitting to a number of lines
// ---------------------------------------------------------------------------

/** How many lines a text takes when each line is filled a character at a time. */
function linesOf(text: string, sizePt: number, widthMm: number, letterSpacingEm = 0): number {
  let lines = 1;
  let used = 0;
  for (const character of text) {
    const width = sansWidthMm(character, sizePt, letterSpacingEm);
    if (used + width > widthMm && used > 0) {
      lines += 1;
      used = 0;
    }
    used += width;
  }
  return lines;
}

test("a text that fits its lines is returned exactly as it was", () => {
  const text = "https://www.ademstravel.com/";

  assert.equal(fitSansLines(text, 8, 66, 2, 0.17), text);
  assert.equal(fitSansLines(text, 8, 66, 1, 0.17), text, "even in one line, when one line is enough");
});

test("a text too long for its lines is cut to them, and marked as cut", () => {
  const texts = ["W".repeat(400), "i".repeat(2000), "https://www.example.com/" + "segment/".repeat(80), "漢".repeat(300)];

  for (const text of texts) {
    for (const lines of [1, 2, 3]) {
      const fitted = fitSansLines(text, 8, 66, lines, 0.17);

      assert.ok(fitted.endsWith("…"), "it says it was cut");
      assert.ok(linesOf(fitted, 8, 66, 0.17) <= lines, `it takes ${linesOf(fitted, 8, 66, 0.17)} of ${lines} line(s)`);
      assert.ok(text.startsWith(fitted.slice(0, -1)), "and what is kept is its own beginning");
    }
  }
});

test("the lines are filled, not merely kept to", () => {
  // One more character before the ellipsis would have needed another line.
  const text = "i".repeat(2000);
  const fitted = fitSansLines(text, 8, 66, 2, 0.17);

  assert.equal(linesOf(fitted, 8, 66, 0.17), 2);
  assert.ok(linesOf(fitted.slice(0, -1) + "i…", 8, 66, 0.17) > 2);
});

test("wide letters get fewer to a line than narrow ones, because they are measured", () => {
  const wide = fitSansLines("W".repeat(400), 8, 66, 2, 0.17);
  const narrow = fitSansLines("i".repeat(2000), 8, 66, 2, 0.17);

  assert.ok([...narrow].length > [...wide].length * 2);
});

test("letter-spacing counts toward the line, so spaced text is cut sooner", () => {
  const tight = fitSansLines("a".repeat(600), 8, 66, 2, 0);
  const spaced = fitSansLines("a".repeat(600), 8, 66, 2, 0.17);

  assert.ok([...spaced].length < [...tight].length);
});

test("a character made of two halves is never cut in the middle of a line fit either", () => {
  const fitted = fitSansLines("😀".repeat(200), 8, 30, 2);

  assert.ok(fitted.endsWith("…"));
  assert.ok([...fitted.slice(0, -1)].every((character) => character === "😀"));
});
