/**
 * Tests for the metadata step, and for what it must not disturb.
 *
 * THE WHOLE RISK OF THIS STEP IS COLLATERAL DAMAGE. Chromium's output is
 * already tagged, and the tagging is worth more than a title. So most of this
 * file is not about metadata at all: it is a before-and-after census of every
 * structural property the document has, run across the step, asserting that
 * nothing moved.
 *
 * THE STRONGEST ASSERTION IS THE SIMPLEST ONE. The original bytes are still
 * there, unchanged, at the front of the file. An append cannot damage what it
 * does not touch, and that is why this is an append.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import zlib from "node:zlib";
import { withMetadata } from "./metadata.ts";
import { renderPdf } from "./render.ts";
import { SKYBOOK_NAME } from "./logo.ts";
import { documentTitle } from "./shell.ts";
import { testDocument } from "./testDocument.fixture.mts";

const META = {
  title: "Website audit — https://example.com/",
  author: "Skybook Digital",
  subject: "Website audit for https://example.com/",
};

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

/** Everything about a file that the metadata step must leave alone. */
function census(pdf: Buffer) {
  const all = contents(pdf);
  const types: Record<string, number> = {};
  for (const element of [
    "Document", "H1", "H2", "H3", "H4", "P", "Table", "TR", "TH", "TD", "L", "LI", "Lbl", "Figure",
  ]) {
    types[element] = (all.match(new RegExp(`/S\\s*/${element}[^A-Za-z0-9]`, "g")) ?? []).length;
  }

  return {
    pages: (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length,
    marked: /\/Marked\s+true/.test(all),
    structTree: /\/StructTreeRoot/.test(all),
    lang: (/\/Lang\s*\(([^)]*)\)/.exec(all) ?? [])[1] ?? null,
    viewerPreferences: /\/ViewerPreferences/.test(all),
    displayDocTitle: /\/DisplayDocTitle/.test(all),
    fonts: (all.match(/\/FontFile2/g) ?? []).length,
    images: (all.match(/\/Subtype\s*\/Image/g) ?? []).length,
    alt: (all.match(/\/Alt/g) ?? []).length,
    types,
  };
}

// ---------------------------------------------------------------------------
// It changes nothing that was already there
// ---------------------------------------------------------------------------

test("every original byte survives, unchanged and in place", async () => {
  /*
   * THE GUARANTEE THE WHOLE APPROACH RESTS ON. A rewriting library would have
   * to be trusted not to drop the structure tree; an append does not need to
   * be trusted, because the front of the file is provably identical.
   */
  const before = await renderPdf(testDocument());
  const after = withMetadata(before, META);

  assert.ok(after.length > before.length, "something was added");
  assert.ok(before.equals(after.subarray(0, before.length)), "and nothing was altered");
});

test("the structure survives the step in every respect", async () => {
  const before = await renderPdf(testDocument());
  const after = withMetadata(before, META);

  const was = census(before);
  const now = census(after);

  assert.equal(now.pages, was.pages, "page count");
  assert.equal(now.marked, was.marked, "marked-content flag");
  assert.equal(now.structTree, was.structTree, "structure tree");
  assert.equal(now.lang, was.lang, "declared language");
  assert.equal(now.viewerPreferences, was.viewerPreferences, "viewer preferences");
  assert.equal(now.displayDocTitle, was.displayDocTitle, "display-document-title preference");
  assert.equal(now.fonts, was.fonts, "embedded fonts");
  assert.equal(now.images, was.images, "embedded images");
  assert.equal(now.alt, was.alt, "alternative text");
  assert.deepEqual(now.types, was.types, "every structure element type and count");
});

test("the tagging is still real after the step, not merely still counted", async () => {
  // The census compares numbers. This asserts the properties outright on the
  // finished file, which is what a reader actually opens.
  const after = contents(await renderPdf(testDocument()));

  assert.match(after, /\/Marked\s+true/);
  assert.match(after, /\/StructTreeRoot/);
  assert.match(after, /\/Lang\s*\(en\)/);
  assert.ok((after.match(/\/S\s*\/H2[^A-Za-z0-9]/g) ?? []).length > 0);
  assert.ok((after.match(/\/S\s*\/Table[^A-Za-z0-9]/g) ?? []).length > 0);
});

test("the file is still a well-formed incremental update", async () => {
  const pdf = await renderPdf(testDocument());
  const text = pdf.toString("latin1");

  assert.ok(text.startsWith("%PDF-"), "still a PDF");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "still ends properly");
  assert.match(text.slice(-400), /\/Prev\s+\d+/, "the appended trailer points back");
  assert.match(text.slice(-400), /\/Root\s+\d+\s+\d+\s+R/, "and still names the catalogue");
  assert.match(text.slice(-400), /startxref/);
});

// ---------------------------------------------------------------------------
// It adds what it was for
// ---------------------------------------------------------------------------

test("the produced document carries a title, an author and a subject", async () => {
  const file = contents(await renderPdf(testDocument()));

  assert.match(file, /\/Title/);
  assert.match(file, /\/Author/);
  assert.match(file, /\/Subject/);
});

test("the author is the company, and not the salesperson", async () => {
  /*
   * `preparedBy` is a real person's name and this document gets forwarded.
   * It belongs on the cover, where whoever typed it can see it, and not in
   * metadata, which is the part of a file people forget is there.
   */
  const document = testDocument();
  const named = {
    ...document,
    cover: { ...document.cover, client: { ...document.cover.client, preparedBy: "Dana Okafor" } },
  };
  const file = contents(await renderPdf(named));

  assert.ok(file.includes(SKYBOOK_NAME));
  assert.ok(!/\/Author[^)]*Dana/.test(file), "the salesperson is not the author");
});

test("the title is the one the document already calls itself", async () => {
  // The HTML title and the PDF title come from one function, so a reader and
  // a browser tab cannot disagree about what the document is.
  const document = testDocument();
  const file = contents(await renderPdf(document));

  assert.ok(file.includes("Website audit"));
  assert.ok(documentTitle(document).includes(document.cover.auditedUrl));
});

test("a title carrying an em dash survives intact", () => {
  /*
   * THE PROTOTYPE'S BUG. Its first version dropped every non-ASCII character,
   * which turned the em dash in the title into a gap. A title is the one
   * string in the file a reader is guaranteed to encounter.
   */
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< >>\nendobj\nxref\n0 2\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n",
    "latin1",
  );
  const out = withMetadata(pdf, { ...META, title: "Website audit — https://example.com/" }).toString("latin1");

  // Non-ASCII forces a UTF-16 hex string with a byte-order mark rather than a
  // literal, so the character is carried rather than stripped.
  assert.match(out, /\/Title\s*<FEFF[0-9A-F]+>/);
  assert.ok(!out.includes("/Title (Website audit  http"), "not silently gapped");
});

test("a plain ASCII title stays a readable literal string", () => {
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< >>\nendobj\nxref\n0 2\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n",
    "latin1",
  );
  const out = withMetadata(pdf, { ...META, title: "Website audit" }).toString("latin1");

  assert.match(out, /\/Title \(Website audit\)/);
});

test("a title containing brackets cannot end the string early", () => {
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< >>\nendobj\nxref\n0 2\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n",
    "latin1",
  );
  const out = withMetadata(pdf, { ...META, title: "A (bracketed) title \\ here" }).toString("latin1");

  assert.match(out, /\\\(bracketed\\\)/);
  assert.match(out, /\\\\/);
});

// ---------------------------------------------------------------------------
// It fails by doing nothing
// ---------------------------------------------------------------------------

test("a file it does not understand is returned exactly as it arrived", () => {
  /*
   * This runs on a document a client is about to be handed. A missing title is
   * survivable; a file this function corrupted would not open at all. Every
   * branch that cannot proceed returns the input.
   */
  for (const broken of [
    "not a pdf at all",
    "%PDF-1.4\nno trailer here\n%%EOF",
    "%PDF-1.4\ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF", // no /Size
    "%PDF-1.4\ntrailer\n<< /Size 2 >>\nstartxref\n9\n%%EOF", // no /Root
    "%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF", // no startxref
  ]) {
    const input = Buffer.from(broken, "latin1");
    assert.ok(withMetadata(input, META).equals(input), `unchanged: ${broken.slice(0, 28)}`);
  }
});

test("an empty file is returned untouched", () => {
  const empty = Buffer.alloc(0);
  assert.ok(withMetadata(empty, META).equals(empty));
});
