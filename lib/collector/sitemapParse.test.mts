/**
 * Tests for reading a sitemap without building a tree of it.
 *
 * WHY. Sitemaps are downloaded up to 5 MB, and the parser used to turn each one
 * into a full tree of objects plus an array of every element -- for a dense
 * sitemap, enough to run a small server out of memory before any page was
 * crawled. It is now a single pass that keeps only a short stack of element
 * names and the text of the one <loc> being read.
 *
 * WHAT IS PROVED:
 *
 *   - it reads the same addresses the tree-based parser did, for every
 *     well-formed shape a sitemap comes in -- checked against that parser,
 *     rebuilt here from cheerio, which is still a dependency for HTML;
 *   - it understands what real sitemaps contain: namespaces, entities, CDATA,
 *     comments, declarations, attributes with ">" in them;
 *   - every limit holds at its boundary, and a limit reached is reported;
 *   - malformed, oversized and strangely encoded input gives controlled,
 *     partial answers and never throws;
 *   - the source builds no tree.
 *
 * No network.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import * as cheerio from "cheerio";
import {
  DEFAULT_SITEMAP_LIMITS,
  MAX_LOC_LENGTH,
  discoverSitemapUrls,
  parseSitemap,
  type SitemapFetcher,
  type SitemapLimits,
} from "./sitemap.ts";
import { createDeadline } from "./deadline.ts";

const limits = (overrides: Partial<SitemapLimits> = {}): SitemapLimits => ({ ...DEFAULT_SITEMAP_LIMITS, ...overrides });

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  locs.map((loc) => `<url><loc>${loc}</loc><lastmod>2026-01-01</lastmod><changefreq>weekly</changefreq><priority>0.5</priority></url>`).join("") +
  `</urlset>`;

const sitemapindex = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  locs.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>2026-01-01</lastmod></sitemap>`).join("") +
  `</sitemapindex>`;

// ---------------------------------------------------------------------------
// The parser this replaced, rebuilt as the reference
// ---------------------------------------------------------------------------

/** The tree-based parser exactly as it was, without its limits, for comparison. */
function referenceParse(xml: string): { urls: string[]; sitemaps: string[] } {
  const local = (name: string) => (name.includes(":") ? name.slice(name.indexOf(":") + 1) : name).toLowerCase();
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const $ = cheerio.load(xml, { xmlMode: true });
  for (const node of $("*").toArray()) {
    if (node.type !== "tag" || local(node.name) !== "loc") continue;
    const address = $(node).text().trim();
    if (address === "") continue;
    const parent = node.parent;
    const container = parent !== null && parent.type === "tag" ? local(parent.name) : "";
    if (container === "sitemap") sitemaps.push(address);
    else if (container === "url") urls.push(address);
  }
  return { urls, sitemaps };
}

const WELL_FORMED: Record<string, string> = {
  "a plain url set": urlset("https://example.com/a", "https://example.com/b?x=1&amp;y=2"),
  "a sitemap index": sitemapindex("https://example.com/s1.xml", "https://example.com/s2.xml"),
  "a mixed file": `<urlset><url><loc>https://example.com/page</loc></url><sitemap><loc>https://example.com/nested.xml</loc></sitemap></urlset>`,
  "namespace prefixes": `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/a</sm:loc></sm:url></sm:urlset>`,
  "image and news extensions alongside": `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://example.com/a</loc><image:image><image:loc>https://example.com/a.jpg</image:loc></image:image></url></urlset>`,
  "hreflang alternates": `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://example.com/en</loc><xhtml:link rel="alternate" hreflang="de" href="https://example.com/de"/></url></urlset>`,
  "whitespace and line breaks": `<urlset>\n  <url>\n    <loc>\n      https://example.com/a\n    </loc>\n  </url>\n</urlset>`,
  "entities and numeric references": `<urlset><url><loc>https://example.com/?a=1&amp;b=&#50;&amp;c=&#x33;</loc></url></urlset>`,
  "CDATA sections": `<urlset><url><loc><![CDATA[https://example.com/?a=1&b=2]]></loc></url></urlset>`,
  "comments, including one that looks like an entry": `<urlset><!-- <url><loc>https://example.com/hidden</loc></url> --><url><loc>https://example.com/a</loc></url></urlset>`,
  "a doctype and a processing instruction": `<?xml version="1.0"?><!DOCTYPE urlset><?xml-stylesheet href="s.xsl"?><urlset><url><loc>https://example.com/a</loc></url></urlset>`,
  "attributes holding a >": `<urlset note="a > b"><url data-x='>'><loc>https://example.com/a</loc></url></urlset>`,
  "upper-case element names": `<URLSET><URL><LOC>https://example.com/a</LOC></URL></URLSET>`,
  "empty and blank locs": `<urlset><url><loc></loc></url><url><loc>   </loc></url><url><loc/></url><url><loc>https://example.com/a</loc></url></urlset>`,
  "a loc outside any url or sitemap": `<urlset><loc>https://example.com/orphan</loc><url><loc>https://example.com/a</loc></url></urlset>`,
  "duplicate entries": urlset("https://example.com/a", "https://example.com/a", "https://example.com/b"),
  "text nested inside a loc": `<urlset><url><loc>https://example.com/<b>bold</b>/x</loc></url></urlset>`,
  "a byte-order mark": `﻿${urlset("https://example.com/a")}`,
  "non-ASCII addresses": urlset("https://example.com/café", "https://example.com/日本"),
  "an HTML page": "<html><body><p>See our loc pages</p><a href='/x'>x</a></body></html>",
  "an empty document": "",
};

for (const [name, xml] of Object.entries(WELL_FORMED)) {
  test(`reads exactly what the tree-based parser read: ${name}`, () => {
    const scanned = parseSitemap(xml, limits());
    const reference = referenceParse(xml);

    assert.deepEqual(scanned.urls, reference.urls, "page addresses");
    assert.deepEqual(scanned.sitemaps, reference.sitemaps, "sitemap addresses");
  });
}

test("the comparison above is not vacuous: the cases do contain addresses", () => {
  const total = Object.values(WELL_FORMED).reduce((sum, xml) => {
    const parsed = parseSitemap(xml, limits());
    return sum + parsed.urls.length + parsed.sitemaps.length;
  }, 0);
  assert.ok(total >= 25, `only ${total} addresses across the cases`);
});

// ---------------------------------------------------------------------------
// What real sitemaps contain
// ---------------------------------------------------------------------------

test("entities are decoded, and unknown ones are left as written", () => {
  const parsed = parseSitemap(urlset("https://example.com/?a=1&amp;b=&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;"), limits());

  assert.deepEqual(parsed.urls, [`https://example.com/?a=1&b=<>"'AB&nbsp;`]);
});

test("a reference to an impossible character is left as written", () => {
  const parsed = parseSitemap(urlset("https://example.com/&#0;&#xD800;&#x110000;"), limits());

  assert.deepEqual(parsed.urls, ["https://example.com/&#0;&#xD800;&#x110000;"]);
});

test("CDATA is taken exactly as written, entities and all", () => {
  const parsed = parseSitemap(`<urlset><url><loc><![CDATA[https://example.com/?a=1&amp;b=<2>]]></loc></url></urlset>`, limits());

  assert.deepEqual(parsed.urls, ["https://example.com/?a=1&amp;b=<2>"]);
});

test("a sitemap index and a url set are told apart by what contains each loc", () => {
  const index = parseSitemap(sitemapindex("https://example.com/s1.xml"), limits());
  const set = parseSitemap(urlset("https://example.com/a"), limits());

  assert.deepEqual([index.urls, index.sitemaps], [[], ["https://example.com/s1.xml"]]);
  assert.deepEqual([set.urls, set.sitemaps], [["https://example.com/a"], []]);
});

test("duplicate locations are returned as found, for the frontier to fold", () => {
  assert.deepEqual(parseSitemap(urlset("https://example.com/a", "https://example.com/a"), limits()).urls, [
    "https://example.com/a",
    "https://example.com/a",
  ]);
});

// ---------------------------------------------------------------------------
// Limits, at their boundaries
// ---------------------------------------------------------------------------

test("exactly maxUrls page addresses are all kept and nothing is reported missing", () => {
  const locs = Array.from({ length: 25 }, (_, i) => `https://example.com/p${i}`);

  const exact = parseSitemap(urlset(...locs), limits({ maxUrls: 25 }));
  const over = parseSitemap(urlset(...locs), limits({ maxUrls: 24 }));

  assert.equal(exact.urls.length, 25);
  assert.equal(exact.truncated, false);
  assert.equal(over.urls.length, 24);
  assert.equal(over.truncated, true);
  assert.equal(over.urls[0], "https://example.com/p0", "the first are kept, in order");
});

test("sitemap addresses are bounded the same way, and reported when cut", () => {
  const locs = Array.from({ length: 25 }, (_, i) => `https://example.com/s${i}.xml`);

  const exact = parseSitemap(sitemapindex(...locs), limits({ maxUrls: 25 }));
  const over = parseSitemap(sitemapindex(...locs), limits({ maxUrls: 24 }));

  assert.equal(exact.sitemaps.length, 25);
  assert.equal(exact.sitemapsTruncated, false);
  assert.equal(over.sitemaps.length, 24);
  assert.equal(over.sitemapsTruncated, true);
});

test("an address of exactly the protocol's maximum length is kept; one character more is not", () => {
  const base = "https://example.com/";
  const exact = base + "a".repeat(MAX_LOC_LENGTH - base.length);
  const tooLong = exact + "a";

  assert.equal(MAX_LOC_LENGTH, 2_048);
  assert.deepEqual(parseSitemap(urlset(exact), limits()).urls, [exact]);
  assert.deepEqual(parseSitemap(urlset(`\n      ${exact}\n    `), limits()).urls, [exact], "whitespace around it does not count");
  assert.deepEqual(parseSitemap(urlset(tooLong, "https://example.com/next"), limits()).urls, ["https://example.com/next"]);
});

test("a single enormous loc is skipped without holding its text", () => {
  const huge = "https://example.com/" + "a".repeat(4_000_000);

  const parsed = parseSitemap(urlset(huge, "https://example.com/after"), limits());

  assert.deepEqual(parsed.urls, ["https://example.com/after"], "the entry after it is still read");
});

// ---------------------------------------------------------------------------
// Large and dense input
// ---------------------------------------------------------------------------

test("a dense sitemap at the 5 MB download limit is read in one pass, keeping only what the limits allow", () => {
  // About 45,000 entries with every optional child element: the shape that
  // made the tree-based parser expensive.
  const entry = (i: number) =>
    `<url><loc>https://example.com/products/item-${i}</loc><lastmod>2026-01-01T00:00:00+00:00</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`;
  const parts: string[] = [`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`];
  let size = parts[0].length;
  let count = 0;
  while (size < DEFAULT_SITEMAP_LIMITS.maxBytes - 200) {
    const next = entry(count);
    parts.push(next);
    size += next.length;
    count += 1;
  }
  parts.push("</urlset>");
  const xml = parts.join("");
  assert.ok(xml.length <= DEFAULT_SITEMAP_LIMITS.maxBytes, "the fixture is within the download limit");
  assert.ok(count > DEFAULT_SITEMAP_LIMITS.maxUrls, "and lists more pages than may be kept");

  const started = Date.now();
  const parsed = parseSitemap(xml, limits());
  const elapsed = Date.now() - started;

  assert.equal(parsed.urls.length, DEFAULT_SITEMAP_LIMITS.maxUrls);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.urls[0], "https://example.com/products/item-0");
  assert.equal(parsed.urls[parsed.urls.length - 1], `https://example.com/products/item-${DEFAULT_SITEMAP_LIMITS.maxUrls - 1}`);
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
});

test("a document nested far deeper than any sitemap stops quietly, keeping what came before", () => {
  const deep = `<urlset><url><loc>https://example.com/a</loc></url>${"<x>".repeat(10_000)}<url><loc>https://example.com/never</loc></url>`;

  const parsed = parseSitemap(deep, limits());

  assert.deepEqual(parsed.urls, ["https://example.com/a"]);
});

// ---------------------------------------------------------------------------
// Malformed and unexpected input
// ---------------------------------------------------------------------------

test("malformed input yields the complete entries before the problem, and never throws", () => {
  const cases: Record<string, string[]> = {
    "a tag cut off": [`<urlset><url><loc>https://example.com/a</loc></url><url`, "https://example.com/a"],
    "a comment that never closes": [`<urlset><url><loc>https://example.com/a</loc></url><!-- <url><loc>https://example.com/b</loc>`, "https://example.com/a"],
    "a CDATA that never closes": [`<urlset><url><loc>https://example.com/a</loc></url><url><loc><![CDATA[https://example.com/b`, "https://example.com/a"],
    "a quote that never closes": [`<urlset><url><loc>https://example.com/a</loc></url><url x="><loc>https://example.com/b</loc></url>`, "https://example.com/a"],
    "a closing tag with no opening": [`</nothing><urlset></url><url><loc>https://example.com/a</loc></url></urlset>`, "https://example.com/a"],
  } as never;

  for (const [name, [xml, expected]] of Object.entries(cases)) {
    let parsed;
    assert.doesNotThrow(() => (parsed = parseSitemap(xml, limits())), name);
    assert.deepEqual(parsed!.urls, [expected], name);
  }
});

test("a loc still open when the document ends is read as far as it goes, as before", () => {
  // The project's decision, kept: half a sitemap is still a list of real pages.
  const cut = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b`;

  assert.deepEqual(parseSitemap(cut, limits()).urls, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(parseSitemap(cut, limits()).urls, referenceParse(cut).urls, "and it agrees with the parser it replaced");
});

test("non-XML and wrongly decoded input yields nothing and does not throw", () => {
  const utf16AsUtf8 = Buffer.from(urlset("https://example.com/a"), "utf16le").toString("utf8");

  for (const body of ["not xml at all", '{"json":"instead"}', "<<<>>>", "<", "&&&;", "\u0000\u0000", utf16AsUtf8]) {
    let parsed;
    assert.doesNotThrow(() => (parsed = parseSitemap(body, limits())));
    assert.deepEqual(parsed!.urls, [], JSON.stringify(body.slice(0, 20)));
  }
});

// ---------------------------------------------------------------------------
// Discovery is told what was cut
// ---------------------------------------------------------------------------

test("an index naming more sitemaps than may be kept makes discovery incomplete", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://example.com/s${i}.xml`);
  const fetchImpl: SitemapFetcher = async (url) => {
    if (url === "https://example.com/robots.txt") return { ok: false, reason: "absent" };
    if (url === "https://example.com/sitemap.xml") return { ok: true, body: sitemapindex(...many) };
    return { ok: true, body: urlset(`${url}#page`) };
  };

  const result = await discoverSitemapUrls({
    site: new URL("https://example.com/"),
    deadline: createDeadline(30_000),
    limits: { maxUrls: 10, maxFiles: 50 },
    fetchImpl,
  });

  assert.equal(result.discovery.complete, false);
  assert.equal(result.discovery.stoppedBecause, "max-files");
});

test("an index within the limit is read completely", async () => {
  const fetchImpl: SitemapFetcher = async (url) => {
    if (url === "https://example.com/robots.txt") return { ok: false, reason: "absent" };
    if (url === "https://example.com/sitemap.xml") return { ok: true, body: sitemapindex("https://example.com/s1.xml") };
    if (url === "https://example.com/s1.xml") return { ok: true, body: urlset("https://example.com/a", "https://example.com/b") };
    return { ok: false, reason: "absent" };
  };

  const result = await discoverSitemapUrls({ site: new URL("https://example.com/"), deadline: createDeadline(30_000), fetchImpl });

  assert.deepEqual(result.urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(result.discovery.complete, true);
});

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

test("the sitemap reader builds no tree and logs nothing", () => {
  const code = fs
    .readFileSync(new URL("./sitemap.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  for (const forbidden of ["cheerio", "toArray", '$("*")', "DOMParser", "parseDocument", "console.", "logOutcome"]) {
    assert.ok(!code.includes(forbidden), `sitemap.ts must not contain ${forbidden}`);
  }
});
