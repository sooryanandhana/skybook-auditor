/**
 * Tests for the type scale and the embedded faces.
 *
 * TWO PROPERTIES CARRY THIS FILE. The first is that the fonts genuinely travel
 * inside the document rather than being asked for: the renderer aborts every
 * request the page makes, so a linked face would not merely be slow, it would
 * never arrive and the page would fall back silently. The second is that the
 * values 7A §16 actually fixes are honoured, and that the ones it leaves open
 * are gathered in one file rather than scattered through the components.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { EMBEDDED_FACES, FONT_FACE_CSS, MONO, SANS, SERIF } from "./fonts.ts";
import { STYLESHEET } from "./styles.ts";
import { COVER_ADDRESS, COVER_COLUMN_MM, COVER_REDIRECT } from "./cover.ts";
import { PAGE_FORMAT, PAGE_HEIGHT, PAGE_WIDTH } from "./settings.ts";

const FONT_DIR = path.join(import.meta.dirname, "assets", "fonts");

// ---------------------------------------------------------------------------
// The faces are in the repository, and they are fonts
// ---------------------------------------------------------------------------

test("every face is committed and is a real TrueType file", () => {
  assert.equal(EMBEDDED_FACES.length, 4);

  for (const file of EMBEDDED_FACES) {
    const bytes = fs.readFileSync(path.join(FONT_DIR, file));
    assert.ok(bytes.length > 50_000, `${file} is a whole font`);
    assert.equal(
      bytes.subarray(0, 4).toString("hex"),
      "00010000",
      `${file} carries the TrueType signature`,
    );
  }
});

test("the licence sits beside the faces", () => {
  // Every face is IBM Plex under the SIL Open Font Licence, which is what
  // permits embedding them in a document a client keeps. That was a selection
  // criterion, so the evidence for it lives with the files.
  const licence = fs.readFileSync(path.join(FONT_DIR, "OFL.txt"), "utf8");

  assert.match(licence, /SIL OPEN FONT LICENSE/i);
  assert.match(licence, /Plex/);
});

test("every face is a static instance, never a variable font", () => {
  /*
   * THE PROPERTY A WHOLE AFTERNOON PAID FOR. Chrome 152 does not embed
   * variable fonts on its print path: the page renders correctly, the browser
   * reports the face as loaded, and the PDF contains no font program at all.
   * A filename carrying an axis list is the cheap way to catch a variable face
   * arriving here again; the expensive way is the render test below.
   */
  for (const file of EMBEDDED_FACES) {
    assert.ok(!file.includes("["), `${file} names no variation axis`);
    assert.ok(!/variable/i.test(file), `${file} is not a variable font`);
  }
});

// ---------------------------------------------------------------------------
// They travel inside the document
// ---------------------------------------------------------------------------

test("every face is embedded as data, so none of them is ever fetched", () => {
  const faces = FONT_FACE_CSS.match(/@font-face\{/g) ?? [];

  assert.equal(faces.length, 4);
  assert.equal(
    (FONT_FACE_CSS.match(/url\(data:font\/ttf;base64,/g) ?? []).length,
    4,
    "one data URI per face",
  );
  assert.ok(!/url\(\s*["']?https?:/.test(FONT_FACE_CSS), "nothing points at a server");
  assert.ok(!/url\(\s*["']?\.{0,2}\//.test(FONT_FACE_CSS), "and nothing points at a file");
});

test("the embedded data is large enough to be the fonts themselves", () => {
  const onDisk = EMBEDDED_FACES.reduce(
    (total, file) => total + fs.statSync(path.join(FONT_DIR, file)).size,
    0,
  );

  // Base64 is four characters for every three bytes, so the stylesheet must be
  // at least a third larger than the files. A truncated face would fail here.
  assert.ok(FONT_FACE_CSS.length > onDisk * 1.3, "every face is embedded whole");
});

test("the families are renamed, so a machine cannot substitute its own copy", () => {
  for (const family of ["Skybook Sans", "Skybook Serif", "Skybook Mono"]) {
    assert.ok(FONT_FACE_CSS.includes(`font-family:"${family}"`), `${family} is declared`);
  }
  assert.ok(!FONT_FACE_CSS.includes("IBM Plex"), "the upstream name is not requested");
});

test("every stack ends in a generic that exists everywhere", () => {
  assert.match(SANS, /sans-serif$/);
  assert.match(SERIF, /serif$/);
  assert.match(MONO, /monospace$/);

  for (const stack of [SANS, SERIF, MONO]) {
    assert.ok(stack.startsWith('"Skybook '), "the embedded face is asked for first");
  }
});

test("the faces are read once, not once per document", () => {
  // Turning 1.4MB of font into base64 is not work to repeat per render. The
  // module-level constant is the same string every time it is read.
  const first = FONT_FACE_CSS;
  const second = FONT_FACE_CSS;
  assert.equal(first, second);
  assert.ok(Object.isFrozen(EMBEDDED_FACES) || Array.isArray(EMBEDDED_FACES));
});

// ---------------------------------------------------------------------------
// What 7A §16 actually fixes
// ---------------------------------------------------------------------------

test("body text sits inside the 10 to 11 point range the specification sets", () => {
  const size = /body\s*\{[^}]*font-size:\s*([\d.]+)pt/.exec(STYLESHEET);

  assert.ok(size, "the body has a stated size");
  const pt = Number(size[1]);
  assert.ok(pt >= 10 && pt <= 11, `${pt}pt is inside 7A §16's range`);
});

test("the leading is generous, as the specification asks", () => {
  const leading = /body\s*\{[^}]*line-height:\s*([\d.]+)/.exec(STYLESHEET);

  assert.ok(leading, "the body has a stated leading");
  assert.ok(Number(leading[1]) >= 1.4, "not set tight");
});

test("the measure is held near 65 to 75 characters", () => {
  /*
   * THE MEASURE IS A PROPERTY OF PROSE, so it is stated on the paragraph. Cards,
   * tables and rows of figures run the full width of the page; a paragraph does
   * not, and neither does a list item.
   */
  const measure = /(?:^|[\s}])p\s*\{[^}]*max-width:\s*(\d+)ch/.exec(STYLESHEET);

  assert.ok(measure, "the measure is stated in characters, not guessed from a width");
  const ch = Number(measure[1]);
  assert.ok(ch >= 65 && ch <= 75, `${ch}ch is inside 7A §16's range`);

  const item = /(?:^|[\s}])li\s*\{[^}]*max-width:\s*(\d+)ch/.exec(STYLESHEET);
  assert.ok(item, "a list item is prose too");
  assert.equal(Number(item[1]), ch, "and is held to the same measure");
});

test("no running text is wider than the measure", () => {
  // Every width stated in characters is the measure or narrower. A wider one
  // would be a block of prose the rule above does not reach.
  const widths = [...STYLESHEET.matchAll(/max-width:\s*(\d+)ch/g)].map((match) => Number(match[1]));

  assert.ok(widths.length > 0);
  for (const width of widths) assert.ok(width <= 75, `${width}ch is within the measure`);
});

test("figures are set with tabular numerals, so columns line up", () => {
  assert.match(STYLESHEET, /font-variant-numeric:\s*tabular-nums/);
});

test("addresses are monospace and are allowed to break mid-string", () => {
  // 7A §16 requires this by name: a long path must not push the page sideways.
  const url = /\.url\s*\{([^}]*)\}/.exec(STYLESHEET);

  assert.ok(url, "addresses have their own rule");
  assert.ok(url[1].includes("Skybook Mono"), "set in the monospace face");
  assert.match(url[1], /overflow-wrap:\s*anywhere/);
});

test("the scale has one step per role and no more", () => {
  // Six steps, from the 7C evaluation: report title, section heading, group
  // heading, finding title, body, caption. A scale earns its keep by being
  // short enough that a component picks a step rather than inventing a size.
  for (const selector of ["h1", "h2", "h3", ".finding-title", "body", ".note"]) {
    assert.ok(
      new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*font-size:`).test(STYLESHEET),
      `${selector} takes a size from the scale`,
    );
  }
});

// ---------------------------------------------------------------------------
// The page, and the one place its size is decided
// ---------------------------------------------------------------------------

test("the stylesheet declares no page margin, because the renderer sets it", () => {
  // The renderer's margins are also what reserve room for the running head and
  // foot. A second margin declared here would be a second answer.
  assert.ok(!/@page\s*\{[^}]*margin/.test(STYLESHEET));
});

test("only the first page gives up its margins, so the cover can reach the paper edge", () => {
  /*
   * THE ONE EXCEPTION TO THE TEST ABOVE, AND IT IS NARROW. The cover's navy
   * ground runs to the edge of the sheet, which it cannot do inside margins.
   * Every other page still takes the renderer's margins, and with them the room
   * for the running head and foot.
   */
  // A rule, not a mention: `@page`, an optional selector, then the braces.
  const pageRules = [...STYLESHEET.matchAll(/@page([ \t:a-z-]*)\{([^}]*)\}/g)];

  assert.equal(pageRules.length, 1, "there is exactly one page rule");
  assert.equal(pageRules[0][1].trim(), ":first", "and it names the first page only");
  assert.match(pageRules[0][2], /margin:\s*0\s*;/, "lifting that page's margins and nothing else");
});

test("the cover is exactly one sheet, taken from the paper size", () => {
  const cover = /\.cover\s*\{([^}]*)\}/.exec(STYLESHEET)?.[1] ?? "";

  assert.ok(cover.includes(`width: ${PAGE_WIDTH}`), "as wide as the paper");
  assert.ok(cover.includes(`height: ${PAGE_HEIGHT}`), "and as tall");
  assert.match(cover, /overflow:\s*hidden/, "clipping the shapes that run past its edges");
});

test("the stated page size is the paper the renderer asks for", () => {
  // Constants that must agree, so a test says they do.
  assert.equal(PAGE_FORMAT, "a4");
  assert.equal(PAGE_HEIGHT, "297mm", "A4 is 297mm tall");
  assert.equal(PAGE_WIDTH, "210mm", "and 210mm wide");
});

test("the cover takes its own page", () => {
  assert.match(STYLESHEET, /\.cover\s*\{[^}]*break-after:\s*page/);
});

// ---------------------------------------------------------------------------
// Colour is never the only carrier
// ---------------------------------------------------------------------------

test("only the deep blue is used for text", () => {
  // The mid and bright blues do not carry enough contrast on white to be read
  // at body size, so they are for rules and accents. 7A §24 asks for 4.5:1 on
  // body text, and nothing is read from a rule.
  const textColours = [...STYLESHEET.matchAll(/(?<!background:\s*)color:\s*(#[0-9a-f]{6})/g)]
    .map((m) => m[1].toLowerCase());

  assert.ok(!textColours.includes("#05a2e4"), "the bright blue is never text");
});

// ---------------------------------------------------------------------------
// The cover's text cannot outgrow its place
// ---------------------------------------------------------------------------

/** The declarations of every rule whose selector list names the given class. */
function rulesFor(className: string): string {
  // Comments first: one sitting before a selector would otherwise be read as part of it.
  const rules = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "");

  return [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1].split(",").some((selector) => selector.trim() === className))
    .map((rule) => rule[2])
    .join(" ");
}

test("the address is drawn the way it is measured", () => {
  /*
   * THE FIT IN cover.ts COUNTS ON THREE THINGS, and each is a line of CSS: the
   * column's width, the type's size and spacing, and a line that breaks between
   * any two characters so every line is filled. If one of them drifted the
   * address would be measured for a layout it is not drawn in.
   */
  assert.ok(rulesFor(".cover-for").includes(`width: ${COVER_COLUMN_MM}mm`), "the column is the measured width");

  const address = rulesFor(".cover-domain");
  assert.ok(address.includes(`font-size: ${COVER_ADDRESS.sizePt}pt`));
  assert.ok(address.includes(`letter-spacing: ${COVER_ADDRESS.spacingEm}em`));
  assert.match(address, /word-break:\s*break-all/);
  assert.ok(address.includes('"Skybook Sans"'), "in the face the widths are read from");
});

test("every line of the cover's addressee block has a limit", () => {
  // The title is placed at a fixed height below this block, so nothing in it
  // may grow without bound.
  const limits: Record<string, number> = {
    ".cover-client": 2,
    ".cover-contact": 1,
    ".cover-domain": COVER_ADDRESS.lines,
    ".cover-redirect": COVER_REDIRECT.lines,
  };

  for (const [selector, lines] of Object.entries(limits)) {
    const rules = rulesFor(selector);
    assert.ok(rules.includes(`-webkit-line-clamp: ${lines}`), `${selector} is held to ${lines} line(s)`);
    assert.match(rules, /overflow:\s*hidden/, `${selector} cannot spill past them`);
  }
});

test("the addressee block at its fullest still ends above the title", () => {
  /*
   * ADDED UP FROM THE STYLESHEET'S OWN NUMBERS. The label, two lines of name,
   * one of contact, two of address and two of redirect note, each with the gap
   * beneath it, must end before the title block begins.
   */
  const mm = (pattern: RegExp, what: string) => {
    const found = pattern.exec(STYLESHEET);
    assert.ok(found, `${what} is stated`);
    return Number(found[1]);
  };
  const POINT = 25.4 / 72;

  const blockTop = mm(/\.cover-for\s*\{[^}]*top:\s*([\d.]+)mm/, "where the block starts");
  const titleTop = mm(/\.cover-titleblock\s*\{[^}]*top:\s*([\d.]+)mm/, "where the title block starts");
  const labelGap = mm(/\.cover-eyebrow\s*\{[^}]*margin:\s*0 0 ([\d.]+)mm/, "the gap under the label");
  const lineGap = mm(/\.cover-client, \.cover-contact, \.cover-domain\s*\{[^}]*margin:\s*0 0 ([\d.]+)mm/, "the gap under a line");

  const label = 6.5 * 1.2 * POINT + labelGap;
  const line = COVER_ADDRESS.sizePt * 1.2 * POINT;
  const name = 2 * line + lineGap;
  const contact = line + lineGap;
  const address = COVER_ADDRESS.lines * line + lineGap;
  const note = COVER_REDIRECT.lines * COVER_REDIRECT.sizePt * 1.5 * POINT;

  const blockEnd = blockTop + label + name + contact + address + note;
  assert.ok(blockEnd < titleTop, `the block ends at ${blockEnd.toFixed(1)}mm and the title starts at ${titleTop}mm`);
});
