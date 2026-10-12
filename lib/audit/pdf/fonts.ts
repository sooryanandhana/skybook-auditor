/**
 * The faces, embedded in the document rather than fetched.
 *
 * WHY EMBEDDED AND NOT LINKED. 7A §16 requires the fonts to travel inside the
 * PDF: a document that renders differently on the prospect's machine is a
 * document that can be wrong on their machine. There is a second reason here
 * that is structural rather than editorial, and it is the stronger one. The
 * renderer aborts every network request the page makes, so a linked font would
 * not merely be slow to arrive, it would never arrive at all, and the page
 * would silently fall back to whatever the machine happened to have.
 *
 * READ ONCE, AT MODULE LOAD. Turning roughly 700KB of font into base64 is not
 * work to repeat per render. `FONT_FACE_CSS` is built when this module is
 * first imported and the same string is reused for every document afterwards.
 *
 * THE FILESYSTEM READ IS THE BUNDLED-ASSET ONE. 7A §25 forbids the renderer
 * reaching the filesystem "beyond its own bundled assets"; these are those
 * assets, they sit beside this file, and nothing here takes a path from a
 * document, an audit, or anywhere else a caller could influence.
 *
 * LICENSING. Every face is IBM Plex, under the SIL Open Font Licence 1.1,
 * which permits embedding in a document; the licence sits beside them in
 * `assets/fonts`. That was a selection criterion, not a happy accident: a face
 * that cannot be redistributed cannot be embedded in something a client keeps.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the committed faces live. Fixed, and never taken from a caller.
 *
 * DERIVED FROM `import.meta.url`, NOT `import.meta.dirname`, and the
 * difference is the difference between a route that builds and one that does
 * not. Under plain Node the two produce byte-identical strings, which is why
 * every test passed while this was broken. Inside the production bundle
 * `import.meta.dirname` is undefined, so `path.join` threw the moment the
 * module was evaluated -- which is when Next reads a route's configuration, so
 * any route importing the renderer failed to build at all.
 *
 * `import.meta.url` survives bundling and still names this file's real
 * location, so the assets stay exactly where they are and are still found
 * beside the module that reads them.
 */
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "fonts");

interface Face {
  /** The family name the stylesheet refers to. */
  readonly family: string;
  readonly file: string;
  /**
   * The single weight this file draws.
   *
   * ONE FILE PER WEIGHT, and never a range. See the note below on why every
   * face here is a static instance; a range would be a promise this set cannot
   * keep, and would invite the browser to synthesise the weights in between.
   */
  readonly weight: 400 | 600;
}

/**
 * STATIC INSTANCES, NOT VARIABLE FONTS, and this was learned the hard way.
 *
 * The first version of this file embedded two variable faces. They loaded
 * perfectly: the browser reported them as loaded, `document.fonts.check`
 * agreed, and every element resolved to the right family. The PDF that came
 * out contained no font program for either of them. Chrome 152 does not embed
 * variable fonts on its print path -- a page using one produces zero
 * `FontFile2` entries and no `BaseFont` name, so the document falls back to
 * whatever the reader's machine has, which is exactly what 7A §16 exists to
 * prevent.
 *
 * The static face in that same set embedded correctly, which is what made the
 * cause findable. Every face here is now a static instance, and a test renders
 * a real PDF and asserts each one is embedded in it, because the stylesheet
 * looked completely right while this was broken.
 *
 * ONE SUPERFAMILY. IBM Plex Sans, Serif and Mono are designed together, so the
 * three roles share proportions and colour rather than merely coexisting. It
 * also means one licence and one upstream to check.
 */
const FACES: readonly Face[] = [
  { family: "Skybook Sans", file: "IBMPlexSans-Regular.ttf", weight: 400 },
  { family: "Skybook Sans", file: "IBMPlexSans-SemiBold.ttf", weight: 600 },
  { family: "Skybook Serif", file: "IBMPlexSerif-SemiBold.ttf", weight: 600 },
  { family: "Skybook Mono", file: "IBMPlexMono-Regular.ttf", weight: 400 },
];

/**
 * The weights the document may ask for.
 *
 * Only these two exist as files. Asking for anything else gets a synthesised
 * approximation, which prints badly and is the sort of thing nobody notices
 * until a client is holding it, so the scale stays inside this set.
 */
export const WEIGHTS = { regular: 400, semibold: 600 } as const;

/*
 * THE FAMILIES ARE RENAMED ON THE WAY IN, and the rename is deliberate. The
 * document asks for "Skybook Sans", so a machine that happens to have IBM Plex
 * Sans installed cannot quietly satisfy the request with its own copy of a
 * different version. What the reader sees is the file in this directory or the
 * declared fallback, never a third thing.
 */

function faceCss(face: Face): string {
  const data = fs.readFileSync(path.join(FONT_DIR, face.file)).toString("base64");

  return (
    "@font-face{" +
    `font-family:"${face.family}";` +
    `src:url(data:font/ttf;base64,${data}) format("truetype");` +
    `font-weight:${face.weight};` +
    "font-style:normal;" +
    "font-display:block;" +
    "}"
  );
}

/** Every face, as one stylesheet fragment. Built once. */
export const FONT_FACE_CSS: string = FACES.map(faceCss).join("");

/**
 * THE RUNNING HEAD AND FOOT USE THESE FACES TOO, and for a long time they could
 * not.
 *
 * They were Chromium's header and footer templates, which render in a context
 * of their own that does not inherit the page's stylesheet. Declaring the face
 * inside the template, as a `<style>` block carrying the same base64 the
 * document uses, did not work either: the face did not load there, and the text
 * fell back to whatever the machine running the renderer had installed. A file
 * produced on a Windows machine embedded a system face in the running head
 * while the body was IBM Plex throughout.
 *
 * They are page-margin boxes now, declared in the document's own stylesheet, so
 * they are set in the embedded sans and "page n of m" comes from CSS's page
 * counters. See `runningHeadFoot.ts`.
 */

/**
 * The families, in the order a fallback stack should try them.
 *
 * EVERY STACK ENDS SOMEWHERE REAL. If a face ever fails to load, the document
 * degrades to a generic that exists everywhere rather than to whatever the
 * browser picks first. It should not happen, and a stack that assumes it will
 * not is a stack that has no answer when it does.
 */
export const SANS = '"Skybook Sans",-apple-system,"Segoe UI",Arial,sans-serif';
export const SERIF = '"Skybook Serif",Georgia,"Times New Roman",serif';
export const MONO = '"Skybook Mono",ui-monospace,"Courier New",monospace';

/** Every family the document may name. */
export const FAMILIES: readonly string[] = [...new Set(FACES.map((face) => face.family))];

/** What was embedded, for tests and for anyone counting bytes. */
export const EMBEDDED_FACES: readonly string[] = FACES.map((face) => face.file);
