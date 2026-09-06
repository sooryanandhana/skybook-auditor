/**
 * Tests for reading links out of HTML.
 *
 * This file tests ONLY the extraction. Whether a link is safe, on-site, already
 * seen, or worth queueing is decided elsewhere and tested elsewhere — the
 * crawler's tests cover that end. What matters here is that the markup is read
 * the way a browser reads it, and that nothing is invented or lost.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { extractLinks, MAX_LINKS_PER_PAGE } from "./extractLinks.ts";

const wrap = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

/** Just the anchors, for the many tests that do not care about <base>. */
const links = (html: string) => extractLinks(html).hrefs;

test("every anchor's href is returned, in document order", () => {
  const html = wrap(`
    <a href="/first">1</a>
    <nav><a href="/second">2</a><a href="/third">3</a></nav>
  `);

  // Order is load-bearing: the frontier is FIFO, so this is the crawl order.
  assert.deepEqual(links(html), ["/first", "/second", "/third"]);
});

test("hrefs are trimmed of the whitespace markup allows around them", () => {
  assert.deepEqual(links(wrap(`<a href="  /spaced  ">x</a>`)), ["/spaced"]);
  assert.deepEqual(links(wrap(`<a href="\n\t/newline\n">x</a>`)), ["/newline"]);
});

test("an empty or whitespace-only href names no address and is dropped", () => {
  assert.deepEqual(links(wrap(`<a href="">x</a>`)), []);
  assert.deepEqual(links(wrap(`<a href="   ">x</a>`)), []);
  assert.deepEqual(links(wrap(`<a href="\t\n">x</a>`)), []);
});

test("an anchor with no href at all is not a link", () => {
  assert.deepEqual(links(wrap(`<a name="top">x</a><a>y</a>`)), []);
});

test("unsafe and non-web schemes are passed through, not filtered here", () => {
  // Refusing these is normalizeCrawlUrl's job. Doing it here as well would
  // mean two lists of unsafe schemes, and one of them would drift.
  const html = wrap(`
    <a href="javascript:alert(1)">a</a>
    <a href="mailto:x@y.com">b</a>
    <a href="tel:+441234">c</a>
    <a href="data:text/html,x">d</a>
    <a href="file:///etc/passwd">e</a>
  `);

  assert.deepEqual(links(html), [
    "javascript:alert(1)",
    "mailto:x@y.com",
    "tel:+441234",
    "data:text/html,x",
    "file:///etc/passwd",
  ]);
});

test("a canonical tag is not a link", () => {
  // A page may name any canonical address it likes, including someone else's
  // domain. It is a claim about identity, never permission to crawl.
  const html = `<html><head>
    <link rel="canonical" href="https://elsewhere.example/other">
    <link rel="alternate" href="https://elsewhere.example/feed">
  </head><body><a href="/real">r</a></body></html>`;

  assert.deepEqual(links(html), ["/real"]);
});

test("only anchors are read — not areas, iframes or forms", () => {
  const html = wrap(`
    <area href="/imagemap">
    <iframe src="/frame"></iframe>
    <form action="/submit"></form>
    <a href="/anchor">a</a>
  `);

  assert.deepEqual(links(html), ["/anchor"]);
});

test("a link inside a comment is not a link", () => {
  // The single clearest reason this uses a parser rather than a pattern: a
  // regular expression sees an address here, and a browser sees nothing.
  const html = wrap(`<!-- <a href="/commented-out">no</a> --><a href="/real">yes</a>`);

  assert.deepEqual(links(html), ["/real"]);
});

test("markup a regular expression would misread is parsed correctly", () => {
  const html = wrap(`
    <a href='/single-quoted'>a</a>
    <a href=/unquoted>b</a>
    <a
       href="/across-lines"
       class="x">c</a>
    <a href="/with-%3E-escaped">d</a>
  `);

  assert.deepEqual(links(html), [
    "/single-quoted",
    "/unquoted",
    "/across-lines",
    "/with-%3E-escaped",
  ]);
});

test("HTML entities in an href are decoded, as a browser would decode them", () => {
  // &amp; in markup is a single & in the address. Leaving it encoded would
  // request a different page from the one the site linked to.
  assert.deepEqual(links(wrap(`<a href="/search?a=1&amp;b=2">x</a>`)), [
    "/search?a=1&b=2",
  ]);
});

test("unclosed and malformed markup still yields its links", () => {
  const html = `<html><body><div><a href="/one">one<a href="/two">two</body>`;

  assert.deepEqual(links(html), ["/one", "/two"]);
});

test("a page with no links, or no HTML at all, yields nothing", () => {
  assert.deepEqual(links(wrap("<p>nothing here</p>")), []);
  assert.deepEqual(links(""), []);
  assert.deepEqual(links("not html at all"), []);
});

test("duplicate hrefs are returned as they appear, not de-duplicated here", () => {
  // De-duplication belongs to the frontier, which compares canonical keys and
  // so catches pairs a string comparison here would miss.
  const html = wrap(`<a href="/same">1</a><a href="/same">2</a>`);

  assert.deepEqual(links(html), ["/same", "/same"]);
});

test("one pathological page cannot return unbounded links", () => {
  const many = Array.from({ length: MAX_LINKS_PER_PAGE + 500 }, (_, i) => `<a href="/p${i}">x</a>`);

  const found = links(wrap(many.join("")));

  assert.equal(found.length, MAX_LINKS_PER_PAGE);
  assert.equal(found[0], "/p0", "and it keeps the first ones, in order");
});

// ---------------------------------------------------------------------------
// <base href> — reported, never applied
// ---------------------------------------------------------------------------

test("a base href is reported exactly as written", () => {
  for (const written of [
    "https://example.com/shop/",
    "/shop/",
    "shop/",
    "../",
    "https://other.example/",
    "javascript:alert(1)",
    "not a url",
  ]) {
    const html = `<html><head><base href="${written}"></head><body></body></html>`;
    assert.equal(extractLinks(html).baseHref, written, written);
  }
});

test("a page with no base href reports null", () => {
  assert.equal(extractLinks(wrap(`<a href="/a">a</a>`)).baseHref, null);
  // A <base> carrying only a target is not a base address.
  assert.equal(extractLinks(`<html><head><base target="_blank"></head></html>`).baseHref, null);
});

test("an empty or whitespace base href is reported as none", () => {
  assert.equal(extractLinks(`<html><head><base href=""></head></html>`).baseHref, null);
  assert.equal(extractLinks(`<html><head><base href="   "></head></html>`).baseHref, null);
});

test("a base href is trimmed", () => {
  const html = `<html><head><base href="  /shop/  "></head></html>`;
  assert.equal(extractLinks(html).baseHref, "/shop/");
});

test("the first base wins, as it does in a browser", () => {
  const html = `<html><head>
    <base href="/first/">
    <base href="/second/">
  </head></html>`;

  assert.equal(extractLinks(html).baseHref, "/first/");
});

test("the base is reported alongside the links, not applied to them", () => {
  const html = `<html><head><base href="https://example.com/shop/"></head>
    <body><a href="widgets">w</a><a href="/root">r</a></body></html>`;

  const result = extractLinks(html);

  assert.equal(result.baseHref, "https://example.com/shop/");
  // Untouched: resolving is the crawler's job, against rules that live there.
  assert.deepEqual(result.hrefs, ["widgets", "/root"]);
});

test("the extractor reaches no network and holds no state", () => {
  const html = wrap(`<a href="/a">a</a>`);

  // Called twice, the same input gives the same output: nothing is remembered.
  assert.deepEqual(links(html), links(html));
});

// ---------------------------------------------------------------------------
// A <template> IS NOT PART OF THE PAGE
//
// Nothing inside one is rendered, clickable, or followed by a search engine.
// What it usually holds is a pattern waiting to be filled in — `/product/{{id}}`
// — which is not an address at all. Discovering those queued them, spent page
// budget on addresses that cannot exist, and then listed the failures in the
// report as pages of the CLIENT'S site that could not be read.
//
// The SEO checks already strip templates before counting headings and images,
// after a template placeholder was once quoted back to a client as their own
// heading. This is the same remedy at the other end of the same document.
// ---------------------------------------------------------------------------

const PLACEHOLDER = "/product/{{id}}";

test("an anchor inside a template is not a link", () => {
  const { hrefs } = extractLinks(
    `<body><a href="/real">r</a><template><a href="${PLACEHOLDER}">p</a></template></body>`,
  );

  assert.deepEqual(hrefs, ["/real"]);
});

test("every anchor inside a template is excluded, however many", () => {
  const { hrefs } = extractLinks(
    `<body><template>
       <a href="/product/{{id}}">p</a>
       <a href="/product/{{id}}/reviews">p</a>
       <a href="/user/:id">p</a>
     </template></body>`,
  );

  assert.deepEqual(hrefs, []);
});

test("a template holding a real-looking address still leaks nothing", () => {
  /*
   * The dangerous case: a template whose links look perfectly ordinary. There
   * is no way to tell those from placeholders by reading the address, which is
   * why the element is dropped rather than the URLs filtered.
   */
  const { hrefs } = extractLinks(
    `<body><a href="/shop">s</a>
     <template><a href="/shop/kettles">k</a><a href="/product/{{id}}">p</a></template></body>`,
  );

  assert.deepEqual(hrefs, ["/shop"]);
});

test("a template nested inside another template is excluded with it", () => {
  const { hrefs } = extractLinks(
    `<body><a href="/real">r</a>
     <template><a href="/outer">o</a>
       <template><a href="/inner">i</a></template>
     </template></body>`,
  );

  assert.deepEqual(hrefs, ["/real"]);
});

test("anchors on both sides of a template are kept, in order", () => {
  const { hrefs } = extractLinks(
    `<body><a href="/before">b</a>
     <template><a href="/hidden">h</a></template>
     <a href="/after">a</a></body>`,
  );

  assert.deepEqual(hrefs, ["/before", "/after"], "order is unchanged");
});

test("several templates are all removed, not just the first", () => {
  const { hrefs } = extractLinks(
    `<body><template><a href="/one">1</a></template>
     <a href="/real">r</a>
     <template><a href="/two">2</a></template></body>`,
  );

  assert.deepEqual(hrefs, ["/real"]);
});

test("a page with no template is completely unaffected", () => {
  const { hrefs } = extractLinks(
    `<body><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></body>`,
  );

  assert.deepEqual(hrefs, ["/a", "/b", "/c"]);
});

test("base href still works alongside a template", () => {
  const { baseHref, hrefs } = extractLinks(
    `<html><head><base href="https://example.com/other/"></head>
     <body><template><a href="/hidden">h</a></template><a href="thing">t</a></body></html>`,
  );

  assert.equal(baseHref, "https://example.com/other/", "removing templates left the base alone");
  assert.deepEqual(hrefs, ["thing"]);
});

test("the first base still wins when a template sits between them", () => {
  const { baseHref } = extractLinks(
    `<html><head><base href="/one/"></head>
     <body><template><a href="/x">x</a></template><base href="/two/"></body></html>`,
  );

  assert.equal(baseHref, "/one/");
});
