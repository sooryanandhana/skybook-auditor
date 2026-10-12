/**
 * Tests for the document shell and the running head and foot.
 *
 * These run in milliseconds and launch no browser, because everything they
 * assert is a property of a string. That is the point of building the markup
 * separately from rendering it: the questions worth asking most often -- is
 * this escaped, is this section omitted, does this heading come from 7B -- are
 * all answerable without Chromium.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { documentHtml, footOf, headOf } from "./shell.ts";
import { HEAD_WIDTH_MM, cssString, headAddressRoomMm, runningHeadFootCss } from "./runningHeadFoot.ts";
import { sansWidthMm } from "./textWidth.ts";
import { HOSTILE, SENTINEL, testDocument } from "./testDocument.fixture.mts";

// ---------------------------------------------------------------------------
// The shell reads the document, and only the document
// ---------------------------------------------------------------------------

test("the shell renders a titled document with a declared language", () => {
  const out = documentHtml(testDocument());

  assert.ok(out.startsWith("<!doctype html>"));
  assert.ok(out.includes('<html lang="en">'), "7A §24 requires a declared language");
  assert.ok(out.includes("<title>"), "7A §24 requires a document title");
  assert.ok(out.includes("<main>"), "a main content region");
});

test("the headings on the page are the strings 7B prepared", () => {
  const document = testDocument();
  const out = documentHtml(document);

  assert.ok(out.includes(document.coverage.headline));
  assert.ok(out.includes(document.siteFindings.heading));
  assert.ok(out.includes(document.pageFindings.heading));
  assert.ok(out.includes(document.cover.statusLine));
});

test("a heading the document does not carry produces no block", () => {
  // 7A §19: an empty section is omitted, never left blank. The skipped section
  // is null in the fixture, and its heading appears nowhere.
  const out = documentHtml(testDocument());
  assert.ok(!out.includes("Checks not evaluated"));
});

test("a skipped section that exists does produce a block", () => {
  const out = documentHtml(
    testDocument({
      skipped: {
        heading: "Checks not evaluated",
        intro: "These checks did not run, so nothing is claimed about them either way.",
        count: 2,
        groups: [{ reason: "The page could not be read", checks: ["a", "b"] }],
      },
    }),
  );

  assert.ok(out.includes("Checks not evaluated"), "the heading, carried word for word");
  assert.ok(out.includes("nothing is claimed about them either way"), "and its one line of context");
  assert.ok(out.includes("The page could not be read"), "the reason");
});

test("every fact section the document carries gets a block", () => {
  const document = testDocument();
  const out = documentHtml(document);

  for (const section of [...document.measured, ...document.coverageDetail]) {
    assert.ok(out.includes(section.heading), `${section.heading} is on the page`);
  }
});

test("the sentinel proves the block came from the document, not from the shell", () => {
  assert.ok(documentHtml(testDocument()).includes(SENTINEL));
});

// ---------------------------------------------------------------------------
// Nothing from the audited site or the model becomes markup
// ---------------------------------------------------------------------------

test("a script tag in a document value is rendered as text", () => {
  const out = documentHtml(
    testDocument({
      measured: [{ heading: HOSTILE, facts: [] }],
    }),
  );

  assert.ok(out.includes("&lt;script&gt;"), "the tag appears escaped");
  assert.ok(!out.includes("<script>"), "and never as an element");
});

test("a hostile audited address cannot break out of the title", () => {
  const document = testDocument();
  const out = documentHtml({
    ...document,
    cover: { ...document.cover, auditedUrl: '</title><script>steal()</script>' },
  });

  assert.ok(!out.includes("<script>"));
  assert.equal(out.split("<title>").length, 2, "exactly one title element");
});

test("the whole shell contains no element the shell did not write", () => {
  /*
   * A sweep rather than a list. Every "<" in the output is counted, and the
   * count must equal the number of tags the shell itself opens. A document
   * value that became markup would raise it.
   */
  const withTags = documentHtml(
    testDocument({ measured: [{ heading: "<b>x</b>", facts: [{ label: "<i>", value: "<u>" }] }] }),
  );
  // Both carry one fact, because a group with none renders nothing at all now.
  const withoutTags = documentHtml(
    testDocument({ measured: [{ heading: "x", facts: [{ label: "l", value: "v" }] }] }),
  );

  assert.equal(
    (withTags.match(/</g) ?? []).length,
    (withoutTags.match(/</g) ?? []).length,
    "adding markup to a document value adds no elements to the page",
  );
});

// ---------------------------------------------------------------------------
// The running head and foot
// ---------------------------------------------------------------------------

/*
 * THE HEAD AND FOOT ARE PAGE RULES, so a value in them is a CSS string and is
 * written as escapes. These tests read it back the way CSS would, rather than
 * looking for the raw characters, which are deliberately not there.
 */

/** The text a CSS string literal stands for: each six-digit escape, as its character. */
function cssText(literal: string): string {
  return literal
    .slice(1, -1)
    .split(String.fromCharCode(92))
    .map((part, index) => (index === 0 ? part : String.fromCodePoint(Number.parseInt(part.slice(0, 6), 16)) + part.slice(6)))
    .join("");
}

/** The `content` of one margin box, in the rule for every page. */
function boxContent(css: string, box: string): string {
  const everyPage = css.slice(0, css.indexOf("@page :first"));
  const start = everyPage.indexOf(`@${box}{content:`) + `@${box}{content:`.length;
  return everyPage.slice(start, everyPage.indexOf(";", start));
}

const HEAD = { auditedUrl: "https://example.com/", partial: false };
const FOOT = { auditDate: "8 September 2026 at 10:00 UTC" };

test("the head carries the mark and the audited site on every page", () => {
  const css = runningHeadFootCss(HEAD, FOOT);

  assert.equal(boxContent(css, "top-left"), '"SKYBOOK"');
  assert.equal(cssText(boxContent(css, "top-right")), "https://example.com/");
});

test("a partial audit says so in the head, in words", () => {
  // 7A §20: a page read on its own must not be mistaken for a whole-site
  // result, and 7A §24 forbids carrying that state by colour alone.
  const css = runningHeadFootCss({ ...HEAD, partial: true }, FOOT);

  assert.ok(cssText(boxContent(css, "top-right")).endsWith("Partial audit"));
});

test("a complete audit says nothing about being partial", () => {
  assert.ok(!cssText(boxContent(runningHeadFootCss(HEAD, FOOT), "top-right")).includes("Partial"));
});

test("a very long address is cut short in the head, and says so", () => {
  /*
   * THE HEAD IS ONE LINE. Left whole, a long address ran over the mark and off
   * the sheet, and took the partial marker with it. Shortened, it ends in an
   * ellipsis so it cannot be taken for the whole address, and the marker that
   * 7A §20 requires on every page is still there after it.
   */
  const long = "https://example.com/" + "segment/".repeat(60);
  const shown = cssText(boxContent(runningHeadFootCss({ auditedUrl: long, partial: true }, FOOT), "top-right"));

  assert.ok(shown.startsWith("https://example.com/segment/"), "it still begins as the address does");
  assert.ok(shown.endsWith("… · Partial audit"), "the cut is marked, and the partial marker survives it");
  assert.ok(long.startsWith(shown.slice(0, shown.indexOf("…"))), "and what is kept is the address's own beginning");
});

test("an address that fits is shown whole", () => {
  const exact = "https://example.com/" + "a".repeat(60);
  const shown = cssText(boxContent(runningHeadFootCss({ auditedUrl: exact, partial: false }, FOOT), "top-right"));

  assert.equal(shown, exact);
  assert.ok(!shown.includes("…"));
});

/** The widest the whole head can be: mark, gap and everything in the right box, in millimetres. */
function headWidthMm(head: { auditedUrl: string; partial: boolean }): number {
  const right = cssText(boxContent(runningHeadFootCss(head, FOOT), "top-right"));
  return sansWidthMm("SKYBOOK", 8, 0.22) + sansWidthMm(right, 8);
}

test("the head fits its line whatever the address is made of", () => {
  /*
   * THE CASE A CHARACTER COUNT GOT WRONG. Eighty capital W's are more than three
   * times as wide as eighty i's, and a limit of eighty characters let them run
   * across the mark and off the sheet. Each of these is measured in the face the
   * head is set in, and the mark, the address and the partial marker must all
   * fit side by side with clear space left between the mark and the rest.
   */
  const addresses = {
    ordinary: "https://www.ademstravel.com/",
    long: "https://www.example.com/" + "a-long-path-segment/".repeat(30),
    "unusually wide": "https://www.example.com/" + "WWWWMMMM".repeat(40),
    "unusually narrow": "https://www.example.com/" + "il.i/".repeat(120),
    "not in the embedded face": "https://www.example.com/" + "漢字".repeat(80),
  };

  for (const [kind, auditedUrl] of Object.entries(addresses)) {
    for (const partial of [true, false]) {
      const used = headWidthMm({ auditedUrl, partial });
      assert.ok(
        used <= HEAD_WIDTH_MM - 5,
        `${kind}, ${partial ? "partial" : "complete"}: the head needs ${used.toFixed(1)}mm of ${HEAD_WIDTH_MM}mm`,
      );
    }
  }
});

test("a wide address is cut shorter than a narrow one, because it is measured", () => {
  const shownOf = (auditedUrl: string) =>
    cssText(boxContent(runningHeadFootCss({ auditedUrl, partial: true }, FOOT), "top-right")).replace(" · Partial audit", "");

  const wide = shownOf("W".repeat(400));
  const narrow = shownOf("i".repeat(400));

  assert.ok(wide.endsWith("…") && narrow.endsWith("…"), "both are too long, and both say so");
  assert.ok([...narrow].length > [...wide].length * 3, "the narrow letters get more than three times as many");
});

test("a wide address keeps the partial marker, which is what the head is for", () => {
  // 7A §20: the marker is on every page. It is given its room before the address is.
  const shown = cssText(
    boxContent(runningHeadFootCss({ auditedUrl: "https://www.example.com/" + "WWWWMMMM".repeat(40), partial: true }, FOOT), "top-right"),
  );

  assert.ok(shown.endsWith("… · Partial audit"));
  assert.ok(shown.startsWith("https://www.example.com/WWWW"), "and it still says which site");
});

test("an address has more room when there is no partial marker to make way for", () => {
  assert.ok(headAddressRoomMm(false) > headAddressRoomMm(true));
  assert.ok(headAddressRoomMm(true) > 100, "and plenty either way, for an ordinary address");
});

test("a value is written so that neither CSS nor HTML can act on it", () => {
  /*
   * THE ADDRESS COMES FROM THE AUDITED SITE and lands inside a stylesheet inside
   * a page. A quote could end the string; "</style>" could end the stylesheet.
   * Written as escapes it can do neither, and it still reads back unchanged.
   */
  const hostile = 'a"b' + String.fromCharCode(92) + "c</style><script>steal()</script>" + String.fromCharCode(10) + "d;}e";
  const literal = cssString(hostile);

  assert.ok(/^"[A-Za-z0-9\\]*"$/.test(literal), "nothing but letters, digits and escapes between the quotes");
  assert.equal(cssText(literal), hostile, "and it stands for exactly the text it was given");
});

test("a hostile address cannot break out of the head", () => {
  const css = runningHeadFootCss({ auditedUrl: '"></style><script>steal()</script>', partial: false }, FOOT);

  assert.ok(!css.includes("<"), "no markup can start");
  assert.ok(!css.includes("script>"));
  assert.equal(cssText(boxContent(css, "top-right")), '"></style><script>steal()</script>', "and the reader still sees it as text");
  assert.equal((css.match(/@page/g) ?? []).length, 2, "the rules are the same two, whatever the address says");
});

test("a hostile address does not reach the page as markup either", () => {
  const document = testDocument();
  const out = documentHtml({
    ...document,
    cover: { ...document.cover, auditedUrl: "</style><script>steal()</script>" },
  });

  assert.ok(!out.includes("<script>"));
  assert.equal((out.match(/<\/style>/g) ?? []).length, 1, "the one stylesheet ends once, where it should");
});

test("the foot carries the audit date and the page number", () => {
  const css = runningHeadFootCss(HEAD, { auditDate: "2026-09-08T10:00:00.000Z" });

  assert.equal(cssText(boxContent(css, "bottom-left")), "2026-09-08T10:00:00.000Z");
  assert.equal(
    boxContent(css, "bottom-right"),
    '"Page " counter(page) " of " counter(pages)',
    "CSS counts the pages, so a missing page is noticeable",
  );
});

test("the cover carries no head and no foot", () => {
  /*
   * THE REASON THESE ARE PAGE RULES. The cover runs to the paper edge and has
   * the mark, the address, the date and the partial marker in its own design.
   * Every one of the four boxes is emptied for the first page, and only there.
   */
  const css = runningHeadFootCss({ ...HEAD, partial: true }, FOOT);
  const first = css.slice(css.indexOf("@page :first"));

  for (const box of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    assert.ok(first.includes(`@${box}{content:none}`), `${box} is empty on the cover`);
  }
  assert.ok(!first.includes("margin"), "and the cover's margin is not this rule's to set");
});

test("the document carries its own head and foot rules", () => {
  const document = testDocument();

  assert.ok(documentHtml(document).includes(runningHeadFootCss(headOf(document), footOf(document))));
});

test("the foot takes the audit date, never a generation date", () => {
  // 7A §20 is explicit: what matters is when the site was measured.
  const document = testDocument();
  assert.equal(footOf(document).auditDate, document.cover.checkedAt);
});

test("the foot carries the page number alone when there is no audit date", () => {
  const css = runningHeadFootCss(HEAD, { auditDate: null });

  assert.equal(boxContent(css, "bottom-left"), "none", "nothing stands in for the missing date");
  assert.ok(boxContent(css, "bottom-right").includes("counter(page)"), "the page number still appears");
  assert.ok(!css.includes("null"));
});

// ---------------------------------------------------------------------------
// The renderer prints the time; it does not work it out
// ---------------------------------------------------------------------------

test("the audit time is printed exactly as the projection phrased it", () => {
  const out = documentHtml(testDocument());

  assert.ok(out.includes("Measured 8 September 2026 at 10:00 UTC"));
});

test("an absent audit time removes the line rather than emptying it", () => {
  const document = testDocument();
  const out = documentHtml({ ...document, cover: { ...document.cover, checkedAt: null } });

  // Narrowly, because "Measured facts" is also a section heading.
  assert.ok(!/note">Measured/.test(out), "no label without a value");
  assert.ok(!out.includes("null"));
});

test("no renderer source parses or formats a date", () => {
  /*
   * THE PROPERTY THE 7B CORRECTION BOUGHT. A renderer that phrases a date is a
   * renderer that can disagree with the screen about one, so it does not have
   * the tools to: no Date construction, no locale formatting, no month names.
   *
   * The needles are assembled rather than written out, so this test cannot
   * match its own source.
   */
  const banned = [
    ["new", "Date("].join(" "),
    ["toLocale", "DateString"].join(""),
    ["toLocale", "TimeString"].join(""),
    ["toLocale", "String"].join(""),
    ["toISO", "String"].join(""),
    ["getUTC", "Hours"].join(""),
    "January",
  ];

  for (const name of fs.readdirSync(import.meta.dirname).filter((n) => n.endsWith(".ts"))) {
    const source = fs.readFileSync(`${import.meta.dirname}/${name}`, "utf8");
    for (const needle of banned) {
      assert.ok(!source.includes(needle), `${name} must not contain ${needle}`);
    }
  }
});

test("the head is built from the cover, not from anywhere else", () => {
  const document = testDocument();
  assert.deepEqual(headOf(document), {
    auditedUrl: document.cover.auditedUrl,
    partial: document.cover.partial,
  });
});

test("every margin box states its own size and face", () => {
  // A margin box would otherwise take the root's size, and these are captions.
  const everyPage = runningHeadFootCss(HEAD, FOOT).split("@page :first")[0];

  for (const box of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const rule = everyPage.slice(everyPage.indexOf(`@${box}{`)).split("}")[0];
    assert.ok(rule.includes("font-size:8pt"), `${box} states a size`);
    assert.ok(rule.includes('font-family:"Skybook Sans"'), `${box} uses the embedded sans`);
  }
});

// ---------------------------------------------------------------------------
// The boundary, as an import rule
// ---------------------------------------------------------------------------

test("the renderer imports nothing from the audit, the rules or the model", () => {
  /*
   * 7A §25: the renderer has no access to the job store, the crawler, the
   * rules or any collector. Asserted against the source rather than trusted,
   * because an import is one line and a review can miss it.
   *
   * The needles are assembled here rather than written out, so this test
   * cannot match its own source.
   */
  const forbidden = ["collector", "rules", "jobs", "ai/", "types"].map((part) => `../${part}`);
  const sources = fs
    .readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith(".ts"));

  assert.ok(sources.length >= 4, "the renderer modules were found");

  for (const name of sources) {
    const source = fs.readFileSync(`${import.meta.dirname}/${name}`, "utf8");
    for (const needle of forbidden) {
      assert.ok(
        !source.includes(needle),
        `${name} must not import ${needle}`,
      );
    }
  }
});

test("the renderer's only import from outside this folder is the 7B projection", () => {
  /*
   * Stated as the property rather than as a list of filenames. A pinned list
   * has to be edited every time the renderer gains a component, and a list
   * edited that often stops being read.
   */
  for (const name of fs.readdirSync(import.meta.dirname).filter((n) => n.endsWith(".ts"))) {
    const source = fs.readFileSync(`${import.meta.dirname}/${name}`, "utf8");
    const outside = [...source.matchAll(/from "([^"]+)"/g)]
      .map((m) => m[1])
      .filter((path) => !path.startsWith("./") && !path.startsWith("node:") && path !== "puppeteer");

    for (const path of outside) {
      assert.equal(path, "../pdfDocument.ts", `${name} may not import ${path}`);
    }
  }
});

test("nothing outside this folder imports the browser", () => {
  /*
   * THE PROPERTY THE CRAWLER'S DEPENDENCY BAN USED TO CARRY. `puppeteer` was
   * banned outright until this step, to stop the crawler fetching pages
   * through a browser: headless Chromium runs the audited site's JavaScript,
   * which would change what the audit measures. Adding the renderer meant that
   * ban could no longer be stated as "not a dependency", so it is stated here
   * instead, as the thing it actually meant.
   *
   * Walked rather than listed, so a new collector or rule is covered on the
   * day it is written rather than on the day somebody remembers this file.
   */
  const root = new URL("../../../lib/", import.meta.url);
  const offenders: string[] = [];

  const walk = (dir: URL): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) {
        if (entry.name !== "pdf") walk(child);
        continue;
      }
      if (!/\.(ts|mts)$/.test(entry.name)) continue;
      /*
       * IMPORTS ONLY, not mentions. The two crawler guards name the package in
       * order to argue about it, and a check that could not tell an import
       * from a mention would report the guards as the breach.
       */
      if (/from\s+["']puppeteer["']/.test(fs.readFileSync(child, "utf8"))) {
        offenders.push(entry.name);
      }
    }
  };

  walk(root);
  assert.deepEqual(offenders, [], "only lib/audit/pdf may drive a browser");
});
