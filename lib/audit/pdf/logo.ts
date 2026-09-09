/**
 * The Skybook mark, embedded in the cover.
 *
 * THE REAL BRAND ASSET, NOT A DRAWING OF ONE. 7A §27 is explicit that the mark
 * is not to be recreated from what is on screen, and until this file existed
 * the cover carried a wordmark set in type instead. What is embedded here is
 * the supplied artwork, byte for byte, at its full resolution: nothing is
 * resampled, re-encoded, recoloured or redrawn.
 *
 * EMBEDDED, LIKE THE FONTS, AND FOR THE SAME REASON. The renderer aborts every
 * request the page makes, so an asset referenced by path would not merely fail
 * to load, it would fail silently and leave a gap on the cover. It is read
 * once at module load and carried as a data URI.
 *
 * WHY IT IS CROPPED RATHER THAN PLACED WHOLE. The artwork is a 3630 square
 * with the mark sitting inside roughly an eighth of white on every side. Laid
 * out as-is, the mark would float about six millimetres in from the margin
 * while every line of text below it sat flush, which reads as a mistake rather
 * than as clear space. The measurements below let the layout use a box that is
 * exactly the artwork's ink, with the padding cropped away.
 *
 * THE COVER MUST STAY WHITE. The artwork's own background is pure white and
 * the white between its letters is part of the image, so a tinted cover would
 * show it as a pale block. That is a constraint on the cover, not a defect
 * here, and it is the trade for using the supplied raster rather than a vector
 * the project does not have.
 */
import fs from "node:fs";
import path from "node:path";

/** The supplied artwork, in the renderer's own asset directory. */
export const LOGO_FILE = "skybook-logo.jpg";

/**
 * Where the artwork's ink actually sits inside its square, as fractions.
 *
 * MEASURED, NOT ESTIMATED. Every pixel of the 3630 square was read and the
 * bounding box of everything meaningfully darker than paper was taken. The ink
 * runs x 555 to 3159 and y 357 to 3146, so the mark is very slightly taller
 * than it is wide.
 *
 * These describe the file. If the artwork is ever replaced, they have to be
 * measured again, and a test checks the file has not changed underneath them.
 */
const INK = {
  left: 555 / 3630,
  top: 357 / 3630,
  width: 2605 / 3630,
  height: 2790 / 3630,
} as const;

/** The bytes these measurements describe, so a swapped file cannot pass unnoticed. */
export const LOGO_BYTES = 706_804;

/**
 * TEMPORARY. How wide the mark's ink is on the cover.
 *
 * 7A does not specify a size for it. Thirty millimetres reads as a masthead
 * without dominating a page whose real subject is the audited site's name.
 */
export const LOGO_WIDTH_MM = 30;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The geometry the stylesheet needs, in millimetres.
 *
 * The image is scaled uniformly and then offset inside a box the size of its
 * ink, so the aspect ratio is preserved exactly and nothing is stretched. The
 * box is what the layout sees.
 */
export const LOGO_BOX = {
  /** The visible box: the ink, and nothing else. */
  width: round(LOGO_WIDTH_MM),
  height: round(LOGO_WIDTH_MM * (INK.height / INK.width)),
  /** The whole artwork, scaled so its ink is `width` across. */
  imageWidth: round(LOGO_WIDTH_MM / INK.width),
  /** How far the artwork sits up and left of the box, hiding the padding. */
  offsetLeft: round((LOGO_WIDTH_MM / INK.width) * INK.left),
  offsetTop: round((LOGO_WIDTH_MM / INK.width) * INK.top),
} as const;

/** The artwork as a data URI. Read once, when this module is first imported. */
export const LOGO_DATA_URI: string = (() => {
  const bytes = fs.readFileSync(path.join(import.meta.dirname, "assets", LOGO_FILE));
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
})();
