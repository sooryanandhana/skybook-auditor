/**
 * Reading the words back out of a produced PDF.
 *
 * NOT A TEST FILE AND NOT PRODUCTION. Only `*.test.mts` imports it, the
 * renderer never does, and nothing here ships. It exists so 7C-6 can ask the
 * one question every other test has had to work around: not "is the forbidden
 * string absent from the markup" but "is it absent from the document a client
 * would actually be holding".
 *
 * NO DEPENDENCY, AND THAT WAS CHECKED RATHER THAN ASSUMED. Chromium embeds a
 * `ToUnicode` map for every font it subsets, in the standard CMap form, which
 * is what makes this possible in about a hundred lines. A prototype read 3,816
 * characters out of the fixture document and found every heading, every
 * finding title and the reach line, so a parser was written rather than a
 * dependency added.
 *
 * TWO THINGS IT DOES TO THE TEXT, both because of how the document is set:
 *
 *   Ligatures are expanded. The embedded faces substitute a single glyph for
 *   "fi", so the raw extraction of "findings" is "ﬁndings" and a search for
 *   "find" misses it.
 *
 *   Case is left alone, and callers should remember that several labels are
 *   uppercased by the stylesheet. What is drawn is "WHAT TO DO", so that is
 *   what comes back.
 *
 * IT IS A VERIFICATION TOOL, NOT A PDF LIBRARY. It reads what this renderer
 * produces. It makes no attempt at PDFs in general, and a test that depends on
 * it should be a test where reading the file is the point.
 */
import zlib from "node:zlib";

/** Every object in the file, keyed "number generation", inflated where needed. */
function objects(pdf: Buffer): Map<string, string> {
  const found = new Map<string, string>();
  const text = pdf.toString("latin1");

  for (const match of text.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end === -1) continue;

    let body = text.slice(start, end);
    const streamAt = body.indexOf("stream");

    if (streamAt !== -1 && /\/FlateDecode/.test(body.slice(0, streamAt))) {
      let from = start + streamAt + "stream".length;
      if (pdf[from] === 0x0d) from += 1;
      if (pdf[from] === 0x0a) from += 1;
      const streamEnd = pdf.indexOf("endstream", from);
      try {
        body =
          body.slice(0, streamAt) +
          zlib.inflateSync(pdf.subarray(from, streamEnd)).toString("latin1");
      } catch {
        // Not every stream inflates; leave the raw body in place.
      }
    }
    found.set(`${match[1]} ${match[2]}`, body);
  }
  return found;
}

/** Hex digits, four at a time, as characters. */
function hexToText(hex: string): string {
  let out = "";
  for (let i = 0; i + 3 < hex.length; i += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

/** One ToUnicode CMap, as glyph code to the characters it draws. */
function readCMap(source: string): Map<number, string> {
  const map = new Map<number, string>();

  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(pair[1], 16), hexToText(pair[2]));
    }
  }

  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = Number.parseInt(row[1], 16);
      const to = Number.parseInt(row[2], 16);
      const base = Number.parseInt(row[3], 16);
      for (let code = from; code <= to && code - from < 4096; code += 1) {
        map.set(code, String.fromCharCode(base + (code - from)));
      }
    }
  }

  return map;
}

/** The ligatures the embedded faces substitute, expanded back. */
const LIGATURES: readonly (readonly [RegExp, string])[] = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
];

/**
 * Every word drawn in the document, in the order the content streams draw it.
 *
 * NOT A LAYOUT. Words from different blocks run together, because the content
 * stream has no notion of a paragraph. That is fine for what this is for:
 * asking whether something is present or absent.
 */
export function extractText(pdf: Buffer): string {
  const all = objects(pdf);

  /* Font resource name to its map, gathered from every page's resources. */
  const byName = new Map<string, Map<number, string>>();
  for (const [, body] of all) {
    for (const resource of body.matchAll(/\/(F\d+)\s+(\d+)\s+(\d+)\s+R/g)) {
      const font = all.get(`${resource[2]} ${resource[3]}`);
      if (font === undefined) continue;

      const toUnicode = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(font);
      if (toUnicode === null) continue;

      const cmap = all.get(`${toUnicode[1]} ${toUnicode[2]}`);
      if (cmap !== undefined) byName.set(resource[1], readCMap(cmap));
    }
  }

  let out = "";
  for (const [, body] of all) {
    if (!body.includes("Tj") && !body.includes("TJ")) continue;
    let current: Map<number, string> | undefined;

    for (const token of body.matchAll(
      /\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g,
    )) {
      if (token[1] !== undefined) {
        current = byName.get(token[1]);
        continue;
      }

      const pieces =
        token[3] === undefined
          ? [token[2] ?? ""]
          : [...token[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((piece) => piece[1]);

      for (const piece of pieces) {
        for (let i = 0; i + 3 < piece.length; i += 4) {
          out += current?.get(Number.parseInt(piece.slice(i, i + 4), 16)) ?? "";
        }
      }
    }
    out += "\n";
  }

  for (const [ligature, expansion] of LIGATURES) out = out.replace(ligature, expansion);
  return out;
}
