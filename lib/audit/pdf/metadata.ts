/**
 * The document's title, author and subject, written after Chromium is done.
 *
 * WHY THIS EXISTS AT ALL. Chromium's print interface accepts no metadata, so
 * the file it produces has no title. 7A §24 requires one, and the omission is
 * worse than it sounds: Chromium already sets the viewer preference asking a
 * reader to display the document's title, so a reader is being told to show a
 * title that is not there and falls back to the filename. A screen-reader user
 * meets the document as "skybook-audit-2.pdf".
 *
 * WHY IT IS AN APPEND AND NOT A REWRITE. The obvious approach is a PDF library
 * that loads the file and saves it again, and it was rejected on the evidence.
 * Chromium's output is already tagged: a structure tree, a marked-content
 * flag, a declared language, and real heading, table and list elements. Every
 * one of those is worth more than a title, and any tool that reparses and
 * reserialises the file might quietly drop them.
 *
 * PDF allows an incremental update instead: a new object, a new
 * cross-reference section and a new trailer, appended to the end. Nothing
 * already written is touched, so the structure tree cannot be damaged, and a
 * test asserts the original bytes are still there unchanged. That is a
 * stronger guarantee than any amount of testing a rewriting library, and it
 * needs no dependency.
 *
 * IT FAILS BY DOING NOTHING. Every branch that cannot proceed returns the file
 * exactly as it arrived. A report with no title is a small loss; a report this
 * function corrupted would not open at all.
 */

/** What goes in the Info dictionary. Three fields, and no more. */
export interface PdfMetadata {
  /** What a reader announces and shows in its title bar. */
  readonly title: string;
  /** Who produced the document. Never the salesperson: see the note below. */
  readonly author: string;
  /** What it is about. The audited address. */
  readonly subject: string;
}

/**
 * THE SALESPERSON'S NAME IS NOT IN HERE, deliberately. `preparedBy` is a real
 * person, the document gets forwarded, and metadata is the part of a file
 * people forget is there. It appears on the cover, where whoever wrote it can
 * see it, and nowhere else.
 */

/**
 * One PDF string, encoded so it survives whatever is in it.
 *
 * A literal string for plain ASCII, escaping the three characters that would
 * end it early. Anything else becomes a UTF-16 hex string with a byte-order
 * mark, which is how PDF carries text outside its own limited character set.
 *
 * The prototype for this function silently dropped every non-ASCII character,
 * which turned the em dash in the title into a gap. A title is the one string
 * in the file a reader is guaranteed to see.
 */
function pdfText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/([\\()])/g, "\\$1")})`;
  }

  let hex = "FEFF";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const above = code - 0x10000;
      hex += (0xd800 + (above >> 10)).toString(16).padStart(4, "0").toUpperCase();
      hex += (0xdc00 + (above & 0x3ff)).toString(16).padStart(4, "0").toUpperCase();
    } else {
      hex += code.toString(16).padStart(4, "0").toUpperCase();
    }
  }
  return `<${hex}>`;
}

/**
 * The same file, with an Info dictionary appended.
 *
 * Returns the input unchanged whenever the file is not the shape this
 * understands: a classic cross-reference table with a trailer, which is what
 * Chromium writes. A cross-reference stream would need different handling, and
 * guessing at it is how a working document becomes an unopenable one.
 */
export function withMetadata(pdf: Buffer, metadata: PdfMetadata): Buffer {
  try {
    const text = pdf.toString("latin1");

    /*
     * The trailer dictionary, and only it. An earlier version searched the
     * whole file for the last `/Size`, which can match inside a font
     * descriptor and would have produced an object number already in use.
     */
    const trailerAt = text.lastIndexOf("trailer");
    if (trailerAt === -1) return pdf;
    const trailer = text.slice(trailerAt, trailerAt + 1024);

    const size = /\/Size\s+(\d+)/.exec(trailer);
    const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
    if (size === null || root === null) return pdf;

    const startxrefAt = text.lastIndexOf("startxref");
    if (startxrefAt === -1) return pdf;
    const previousXref = Number.parseInt(text.slice(startxrefAt + "startxref".length).trim(), 10);
    if (!Number.isFinite(previousXref)) return pdf;

    /* The next free object number, taken from the trailer's own count. */
    const infoNumber = Number.parseInt(size[1], 10);
    if (!Number.isFinite(infoNumber) || infoNumber < 1) return pdf;

    const object =
      `${infoNumber} 0 obj\n<< /Title ${pdfText(metadata.title)}` +
      ` /Author ${pdfText(metadata.author)}` +
      ` /Subject ${pdfText(metadata.subject)} >>\nendobj\n`;

    const objectAt = pdf.length;
    const xrefAt = objectAt + Buffer.byteLength(object, "latin1");

    /*
     * `/Prev` is what makes this an update rather than a replacement: a reader
     * follows it back to the cross-reference table Chromium wrote, so every
     * object in the original file is still found exactly where it was.
     */
    const update =
      `xref\n${infoNumber} 1\n${String(objectAt).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size ${infoNumber + 1} /Root ${root[1]} ${root[2]} R` +
      ` /Info ${infoNumber} 0 R /Prev ${previousXref} >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`;

    return Buffer.concat([pdf, Buffer.from(object + update, "latin1")]);
  } catch {
    /*
     * Anything unexpected leaves the document alone. This runs on a file a
     * client is about to be handed, and a missing title is survivable in a way
     * that a broken file is not.
     */
    return pdf;
  }
}
