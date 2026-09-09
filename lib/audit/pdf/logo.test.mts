/**
 * Tests for the mark's geometry.
 *
 * THE NUMBERS HERE DESCRIBE A FILE. They were measured from the supplied
 * artwork by reading every pixel, so they are only true of that artwork. The
 * first test is therefore the important one: it checks the file has not been
 * replaced underneath the measurements, because a swapped logo with different
 * padding would be cropped wrongly and nothing else would notice.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { LOGO_BOX, LOGO_BYTES, LOGO_DATA_URI, LOGO_FILE, LOGO_WIDTH_MM } from "./logo.ts";

const ASSET = path.join(import.meta.dirname, "assets", LOGO_FILE);

test("the artwork is present and is the file the measurements describe", () => {
  const bytes = fs.readFileSync(ASSET);

  assert.equal(bytes.length, LOGO_BYTES, "a replaced logo would need remeasuring");
  assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff", "it is a JPEG");
});

test("the artwork is embedded whole, and never referenced by path", () => {
  const onDisk = fs.statSync(ASSET).size;

  assert.ok(LOGO_DATA_URI.startsWith("data:image/jpeg;base64,"));
  // Base64 is four characters for every three bytes, so a truncated asset
  // would fail here rather than render as half a logo.
  assert.ok(LOGO_DATA_URI.length > onDisk * 1.3, "the whole file is carried");
});

test("the box is the artwork's ink, with the padding cropped away", () => {
  // The supplied square carries roughly an eighth of white on every side. Laid
  // out whole, the mark would float in from the margin while the text below it
  // sat flush.
  assert.equal(LOGO_BOX.width, LOGO_WIDTH_MM);
  assert.ok(LOGO_BOX.imageWidth > LOGO_BOX.width, "the artwork is wider than the box it shows");
  assert.ok(LOGO_BOX.offsetLeft > 0, "and is pulled left to hide the padding");
  assert.ok(LOGO_BOX.offsetTop > 0, "and up");
});

test("the aspect ratio is the artwork's own, to three decimals", () => {
  // Measured ink is 2605 x 2790, so the mark is very slightly taller than wide.
  // Both dimensions are derived from one width, so nothing can stretch.
  const measured = 2790 / 2605;
  assert.ok(
    Math.abs(LOGO_BOX.height / LOGO_BOX.width - measured) < 0.001,
    `${LOGO_BOX.height}mm by ${LOGO_BOX.width}mm keeps the artwork's proportions`,
  );
});

test("the offsets fall inside the artwork, so the crop can only show the mark", () => {
  // An offset larger than the image would slide the artwork out of its box and
  // leave a blank square, which is exactly the failure a reader would notice
  // and a string test would not.
  assert.ok(LOGO_BOX.offsetLeft < LOGO_BOX.imageWidth);
  assert.ok(LOGO_BOX.offsetTop < LOGO_BOX.imageWidth);
  assert.ok(LOGO_BOX.offsetLeft + LOGO_BOX.width < LOGO_BOX.imageWidth, "the ink fits inside");
});

test("the printed mark is large enough to read and small enough to be a mark", () => {
  // 7A sets no size for it. Thirty millimetres reads as a masthead without
  // dominating a page whose subject is the audited site's name.
  assert.ok(LOGO_WIDTH_MM >= 20 && LOGO_WIDTH_MM <= 60);
});

test("the artwork is far finer than print needs, so it cannot look soft", () => {
  // 2605 ink pixels across 30mm is about 2,200 pixels per inch. Three hundred
  // would be enough.
  const inches = LOGO_WIDTH_MM / 25.4;
  assert.ok(2605 / inches > 300, "well above print resolution at the size used");
});
