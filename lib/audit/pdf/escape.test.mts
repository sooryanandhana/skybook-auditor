/**
 * Tests for the one thing that choosing a browser cost this project.
 *
 * Every other renderer in the 7C evaluation drew glyphs and had no markup to
 * get wrong. This one builds HTML out of strings written by an audited website
 * and by a language model, so the escaping is not a detail of the renderer --
 * it is the renderer's security boundary, and it is tested on its own before
 * any browser is launched.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { attribute, escapeHtml, html } from "./escape.ts";

test("the five characters that can end an element or an attribute are escaped", () => {
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml('"'), "&quot;");
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml("&"), "&amp;");
});

test("a script tag becomes text and stops being an element", () => {
  const escaped = escapeHtml('<script>alert("x")</script>');

  assert.equal(escaped, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.ok(!escaped.includes("<"), "no angle bracket survives");
});

test("the ampersand is escaped first, so escaping is not applied twice", () => {
  // Escaping "&" after "<" would turn the "&" of "&lt;" into "&amp;lt;", and
  // the reader would see the escape rather than the character.
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("an already-escaped string escapes again rather than being recognised", () => {
  // Not a defect, and worth pinning: this function has no idea what its input
  // has been through, and guessing would be how a real tag slipped past.
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
});

test("ordinary text is returned untouched", () => {
  const plain = "No SPF record was found for example.com.";
  assert.equal(escapeHtml(plain), plain);
});

test("an event handler cannot be closed out of an attribute", () => {
  const value = attribute('x" onload="steal()');

  assert.equal(value, '"x&quot; onload=&quot;steal()"');
  assert.equal(value.split('"').length, 3, "exactly the two quotes this function wrote");
});

test("an attribute brings its own quotes, so it cannot be written unquoted", () => {
  assert.ok(attribute("plain").startsWith('"'));
  assert.ok(attribute("plain").endsWith('"'));
});

test("the html tag escapes every interpolation without being asked", () => {
  const evil = '<img src=x onerror="steal()">';
  const out = html`<p>${evil}</p>`;

  assert.equal(out, "<p>&lt;img src=x onerror=&quot;steal()&quot;&gt;</p>");
});

test("the literal parts of a template are markup and are not escaped", () => {
  // This is the whole point of the tag: the author's own markup passes through
  // and only the holes are treated as data.
  assert.equal(html`<b>${"x"}</b>`, "<b>x</b>");
});

test("several interpolations are each escaped, not just the first", () => {
  assert.equal(html`${"<"}|${"<"}|${"<"}`, "&lt;|&lt;|&lt;");
});

test("a number interpolates as digits", () => {
  assert.equal(html`<span>${128}</span>`, "<span>128</span>");
});

test("a template with no interpolation is returned as written", () => {
  assert.equal(html`<hr>`, "<hr>");
});
