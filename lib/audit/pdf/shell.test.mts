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
import { footerTemplate, headerTemplate } from "./runningHeadFoot.ts";
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

  assert.ok(out.includes("Checks not evaluated"));
  assert.ok(out.includes("2 checks"));
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
  const withoutTags = documentHtml(testDocument({ measured: [{ heading: "x", facts: [] }] }));

  assert.equal(
    (withTags.match(/</g) ?? []).length,
    (withoutTags.match(/</g) ?? []).length,
    "adding markup to a document value adds no elements to the page",
  );
});

// ---------------------------------------------------------------------------
// The running head and foot
// ---------------------------------------------------------------------------

test("the head carries the mark and the audited site on every page", () => {
  const head = headerTemplate({ auditedUrl: "https://example.com/", partial: false });

  assert.ok(head.includes("Skybook"));
  assert.ok(head.includes("https://example.com/"));
});

test("a partial audit says so in the head, in words", () => {
  // 7A §20: a page read on its own must not be mistaken for a whole-site
  // result, and 7A §24 forbids carrying that state by colour alone.
  const head = headerTemplate({ auditedUrl: "https://example.com/", partial: true });

  assert.ok(head.includes("Partial audit"));
});

test("a complete audit says nothing about being partial", () => {
  assert.ok(!headerTemplate({ auditedUrl: "https://example.com/", partial: false }).includes("Partial"));
});

test("a hostile address cannot inject markup into the head", () => {
  const head = headerTemplate({ auditedUrl: '"><script>steal()</script>', partial: false });

  assert.ok(!head.includes("<script>"));
  assert.ok(head.includes("&lt;script&gt;"));
});

test("the foot carries the audit date and the page number spans", () => {
  const foot = footerTemplate({ auditDate: "2026-09-08T10:00:00.000Z" });

  assert.ok(foot.includes("2026-09-08T10:00:00.000Z"));
  assert.ok(foot.includes('class="pageNumber"'), "Chromium fills this in");
  assert.ok(foot.includes('class="totalPages"'), "so a missing page is noticeable");
});

test("the foot takes the audit date, never a generation date", () => {
  // 7A §20 is explicit: what matters is when the site was measured.
  const document = testDocument();
  assert.equal(footOf(document).auditDate, document.cover.checkedAt);
});

test("the foot carries the page number alone when there is no audit date", () => {
  const foot = footerTemplate({ auditDate: null });

  assert.ok(foot.includes('class="pageNumber"'), "the page number still appears");
  assert.ok(!foot.includes("null"), "and nothing stands in for the missing date");
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

test("the templates carry their own styling, because Chromium gives them none", () => {
  // Verified on Chrome 152: header and footer templates inherit nothing from
  // the page, and default to a size too small to read.
  for (const template of [
    headerTemplate({ auditedUrl: "https://example.com/", partial: false }),
    footerTemplate({ auditDate: "2026-09-08" }),
  ]) {
    assert.ok(template.includes("font-size:"), "a size is always stated");
    assert.ok(template.includes("font-family:"), "and a face");
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
