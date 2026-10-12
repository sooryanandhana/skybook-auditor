/**
 * How wide a line of the embedded sans is, measured from the font itself.
 *
 * WHAT IT IS FOR. The running head is one line in a page margin, and a margin
 * has nowhere to wrap to. Whether an address fits beside the mark cannot be
 * judged by counting characters -- eighty of "i" and eighty of "W" differ by a
 * factor of four -- so it is measured, with the widths the typeface declares.
 *
 * READ FROM THE SAME FILE THE DOCUMENT EMBEDS. The widths come out of
 * `IBMPlexSans-Regular.ttf`, the file `fonts.ts` puts into every document, so
 * what is measured here is the face the browser will set the line in. Nothing
 * is installed, downloaded or asked of the machine.
 *
 * THE FILESYSTEM READ IS THE BUNDLED-ASSET ONE, as in `fonts.ts`: 7A §25 lets
 * the renderer read its own bundled assets and nothing else. It happens once,
 * when this module loads.
 *
 * A LITTLE WIDE, ON PURPOSE. This adds up each character's own advance and
 * ignores kerning, which only ever draws letters closer, so the answer is the
 * line's width or slightly more. A character the face does not contain is set
 * by the browser in some other face nobody can measure from here, so it is
 * counted as a full em, which is as wide as a character of running text gets.
 * Erring wide is the safe direction: the cost is an address cut a character
 * early, and the cost of erring narrow is an address printed across the mark.
 *
 * JUST ENOUGH OF THE FORMAT. A TrueType file is a directory of tables. Three
 * numbers and two tables are read: the units per em, how many glyphs carry
 * their own width, the widths, and the map from character to glyph. Nothing is
 * shaped, and no other part of the file is interpreted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The face the running head is set in. The regular weight of the embedded sans. */
const FACE_FILE = "IBMPlexSans-Regular.ttf";

/** One point, in millimetres. */
const MM_PER_POINT = 25.4 / 72;

interface Metrics {
  readonly unitsPerEm: number;
  /** A character's advance in font units, or undefined when the face lacks it. */
  readonly advanceOf: (codePoint: number) => number | undefined;
}

/** Reads the tables named above. Throws if the file is not the font expected. */
function readMetrics(file: Buffer): Metrics {
  const tables = new Map<string, number>();
  const count = file.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    tables.set(file.toString("latin1", record, record + 4), file.readUInt32BE(record + 8));
  }

  const at = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`the embedded face has no ${tag} table`);
    return offset;
  };

  const unitsPerEm = file.readUInt16BE(at("head") + 18);
  const widthCount = file.readUInt16BE(at("hhea") + 34);
  const widths = at("hmtx");

  /* A glyph past the last listed width shares that last width. */
  const advanceOfGlyph = (glyph: number): number =>
    file.readUInt16BE(widths + Math.min(glyph, widthCount - 1) * 4);

  /*
   * The character map. Of the encodings a file may carry, the Unicode one for
   * the Basic Multilingual Plane is the one every face has, in "format 4": runs
   * of consecutive characters, each run mapped by an offset or by a small table.
   */
  const cmap = at("cmap");
  let segments = -1;
  for (let index = 0; index < file.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = file.readUInt16BE(record);
    const encoding = file.readUInt16BE(record + 2);
    const table = cmap + file.readUInt32BE(record + 4);
    const unicode = (platform === 3 && encoding === 1) || platform === 0;
    if (unicode && file.readUInt16BE(table) === 4) segments = table;
  }
  if (segments === -1) throw new Error("the embedded face has no character map this reader understands");

  const segmentCount = file.readUInt16BE(segments + 6) / 2;
  const ends = segments + 14;
  const starts = ends + segmentCount * 2 + 2;
  const deltas = starts + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;

  const glyphOf = (codePoint: number): number => {
    if (codePoint > 0xffff) return 0;
    for (let index = 0; index < segmentCount; index += 1) {
      if (file.readUInt16BE(ends + index * 2) < codePoint) continue;
      const start = file.readUInt16BE(starts + index * 2);
      if (start > codePoint) return 0;

      const delta = file.readUInt16BE(deltas + index * 2);
      const rangeOffset = file.readUInt16BE(rangeOffsets + index * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;

      const listed = file.readUInt16BE(rangeOffsets + index * 2 + rangeOffset + (codePoint - start) * 2);
      return listed === 0 ? 0 : (listed + delta) & 0xffff;
    }
    return 0;
  };

  return {
    unitsPerEm,
    advanceOf: (codePoint) => {
      const glyph = glyphOf(codePoint);
      /* Glyph zero is the face's "missing" box: the character is not in it. */
      return glyph === 0 ? undefined : advanceOfGlyph(glyph);
    },
  };
}

const METRICS: Metrics = readMetrics(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "fonts", FACE_FILE)),
);

/**
 * The width of `text` set in the embedded sans at `sizePt`, in millimetres.
 *
 * `letterSpacingEm` is the extra space CSS `letter-spacing` puts after every
 * character, for the one line that uses it.
 */
export function sansWidthMm(text: string, sizePt: number, letterSpacingEm = 0): number {
  let ems = 0;
  for (const character of text) {
    const advance = METRICS.advanceOf(character.codePointAt(0)!);
    ems += (advance === undefined ? METRICS.unitsPerEm : advance) / METRICS.unitsPerEm + letterSpacingEm;
  }
  return ems * sizePt * MM_PER_POINT;
}

/**
 * `text` if it fits in `widthMm`, or as much of its beginning as fits with an
 * ellipsis after it.
 *
 * NEVER SILENTLY. Whatever is cut is marked as cut, so a shortened value cannot
 * be taken for the whole one. The ellipsis's own width is part of the sum.
 */
export function fitSans(text: string, sizePt: number, widthMm: number): string {
  if (sansWidthMm(text, sizePt) <= widthMm) return text;

  const ellipsis = "…";
  const room = widthMm - sansWidthMm(ellipsis, sizePt);
  let kept = "";
  let width = 0;
  for (const character of text) {
    width += sansWidthMm(character, sizePt);
    if (width > room) break;
    kept += character;
  }
  return kept + ellipsis;
}

/**
 * `text` if it fits in `maxLines` lines of `widthMm`, or as much of its
 * beginning as fits in them with an ellipsis at the end of the last.
 *
 * FOR TEXT THAT BREAKS ANYWHERE, which is how an address is set: with no spaces
 * to break at, the browser fills each line with as many characters as fit and
 * carries on with the next. This fills lines the same way, one character at a
 * time, so the number of lines it counts is the number the browser draws -- as
 * long as the element is styled to break between any two characters.
 *
 * NEVER SILENTLY, as with `fitSans`: what is cut is marked as cut, and the
 * ellipsis's own width is part of the last line's sum.
 */
export function fitSansLines(
  text: string,
  sizePt: number,
  widthMm: number,
  maxLines: number,
  letterSpacingEm = 0,
): string {
  const widthOf = (character: string) => sansWidthMm(character, sizePt, letterSpacingEm);
  const characters = [...text];

  /* Fill lines until the text runs out or the lines do. */
  const lineStarts = [0];
  let used = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const width = widthOf(characters[index]);
    if (used + width > widthMm && used > 0) {
      lineStarts.push(index);
      used = 0;
    }
    used += width;
  }
  if (lineStarts.length <= maxLines) return text;

  /* Too long. Keep the lines that fit whole, and cut the last to leave room. */
  const lastStart = lineStarts[maxLines - 1];
  const room = widthMm - widthOf("…");
  let end = lastStart;
  let width = 0;
  while (end < characters.length) {
    width += widthOf(characters[end]);
    if (width > room) break;
    end += 1;
  }
  return characters.slice(0, end).join("") + "…";
}
