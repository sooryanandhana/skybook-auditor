/**
 * Tests for parsing a page once in `runSecurityChecks`.
 *
 * WHY. The security checks used to parse the same page four times -- once each
 * for the meta Content-Security-Policy, the upgrade-insecure-requests decision,
 * the mixed-content scan and the form actions. They now share one parse.
 *
 * THE PROPERTY: NOTHING THEY FIND CHANGES. Every result here is compared with
 * the checks EXACTLY AS THEY WERE, kept verbatim in
 * `securityChecks.baseline.fixture.mts` -- not with a re-implementation, and
 * not with the refactored helpers, which share code with the new path and so
 * could not catch a mistake in it. Deep equality covers every field, the order
 * of mixed-content items, and where the list is cut.
 *
 * And the page really is parsed once: asserted against the source, because an
 * ES module's import cannot be replaced at run time to count calls.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import * as current from "./securityChecks.ts";
import * as baseline from "./securityChecks.baseline.fixture.mts";

const NOW = new Date("2026-10-14T12:00:00.000Z");

const page = (head: string, body: string) => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

/** More insecure resources than the report keeps, of every kind, in a deliberate order. */
function manyMixed(): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    parts.push(
      `<script src="http://cdn.example/a${i}.js"></script>`,
      `<img src="http://img.example/p${i}.png" srcset="http://img.example/p${i}@2x.png 2x, https://ok.example/p${i}.png 1x">`,
      `<iframe src="http://frame.example/${i}"></iframe>`,
      `<div style="background:url('http://bg.example/${i}.png')"></div>`,
      `<video src="http://v.example/${i}.mp4" poster="http://v.example/${i}.jpg"></video>`,
    );
  }
  return page(
    `<link rel="stylesheet" href="http://css.example/site.css"><link rel="icon" href="http://icons.example/fav.ico"><style>@import url("http://css.example/import.css"); .x{background:url(http://bg.example/style.png)}</style>`,
    parts.join("") +
      `<svg><image href="http://svg.example/i.png"/><use xlink:href="http://svg.example/u.svg#a"/></svg>` +
      `<table background="http://legacy.example/bg.gif"></table><input type="image" src="http://btn.example/go.png">`,
  );
}

const nested = (depth: number): string =>
  depth === 0
    ? `<img src="http://deep.example/bottom.png">`
    : `<img src="http://deep.example/level-${depth}.png"><iframe srcdoc="${nested(depth - 1).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;

const FIXTURES: Record<string, string> = {
  "an empty string": "",
  "not HTML at all": '{"json":"instead"}',
  "a clean page": page(`<title>Clean</title>`, `<p>Nothing insecure.</p><img src="https://ok.example/a.png"><form action="https://ok.example/send"></form>`),
  "more mixed content than the report keeps": manyMixed(),
  "one resource of each element kind": page(
    "",
    `<object data="http://o.example/x"></object><embed src="http://e.example/x"><audio src="http://a.example/x"></audio>` +
      `<video><source src="http://s.example/x.mp4"><source srcset="http://s.example/x.webp"><track src="http://t.example/x.vtt"></video>` +
      `<link rel="preload" as="image" imagesrcset="http://pre.example/x.png 1x" href="https://ok.example/x.png">`,
  ),
  "link relations of every classification": page(
    `<link rel="stylesheet" href="http://l.example/s.css"><link rel="modulepreload" href="http://l.example/m.js"><link rel="manifest" href="http://l.example/m.json">` +
      `<link rel="prefetch" href="http://l.example/p"><link rel="canonical" href="http://l.example/c"><link rel="preload" as="script" href="http://l.example/pre.js"><link rel="preload" as="font" href="http://l.example/f.woff2">`,
    "",
  ),
  "CSS with comments, quotes and @import": page(
    `<style>/* url(http://commented.example/x.png) */ @import "http://i.example/a.css"; @import url('http://i.example/b.css'); .a{background:url( "http://u.example/c.png" )}</style>`,
    `<p style="background-image: url(http://inline.example/d.png); color: red">x</p>`,
  ),
  "srcdoc nested one level": page("", nested(1)),
  "srcdoc nested two levels": page("", nested(2)),
  "srcdoc nested beyond the limit": page("", nested(4)),
  "a meta CSP with upgrade-insecure-requests": page(`<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests; default-src https:">`, `<img src="http://img.example/a.png">`),
  "a meta CSP without it": page(`<meta http-equiv="content-security-policy" content="default-src 'self' upgrade-insecure-requests">`, `<img src="http://img.example/a.png">`),
  "an empty meta CSP, which is not a policy": page(`<meta http-equiv="Content-Security-Policy" content="   ">`, ""),
  "several meta CSPs, one upgrading": page(
    `<meta http-equiv="Content-Security-Policy" content="default-src https:"><meta http-equiv="CONTENT-SECURITY-POLICY" content="upgrade-insecure-requests">`,
    `<script src="http://cdn.example/x.js"></script>`,
  ),
  "a lookalike directive": page(`<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests-foo">`, `<img src="http://img.example/a.png">`),
  "form actions of every kind": page(
    "",
    `<form action="http://forms.example/a"></form><form action="HTTP://forms.example/b"></form><form action="https://ok.example/c"></form>` +
      `<form action="/relative"></form><form action=""></form><form action="  http://forms.example/padded  "></form><form></form>`,
  ),
  "malformed markup": `<html><head><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"<body><img src="http://img.example/a.png"<form action="http://f.example/x">`,
  "entities and upper-case attributes": page(`<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src https:">`, `<IMG SRC="http://img.example/a.png?a=1&amp;b=2"><FORM ACTION="http://f.example/?x=1&amp;y=2"></FORM>`),
  "a large article-like page": page(
    `<title>Article</title><link rel="stylesheet" href="/load.php"><style>.a{color:red}</style>`,
    Array.from(
      { length: 400 },
      (_, i) =>
        `<p>Text <a href="/wiki/T${i}">link</a><sup><a href="#c${i}">[${i}]</a></sup><span style="white-space:nowrap">more</span></p>` +
        (i % 50 === 0 ? `<img src="${i % 100 === 0 ? "http" : "https"}://upload.example/${i}.jpg">` : ""),
    ).join(""),
  ),
};

const HEADER_SETS: Record<string, Record<string, string>> = {
  "no security headers": { "content-type": "text/html" },
  "a CSP header that upgrades": { "content-security-policy": "upgrade-insecure-requests" },
  "a report-only CSP that would upgrade, which must not count": { "content-security-policy-report-only": "upgrade-insecure-requests" },
  "every header present": {
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "content-security-policy": "default-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=()",
    server: "nginx",
    "x-powered-by": "PHP",
  },
};

const COOKIES = ["session=abc; Path=/; Secure; HttpOnly; SameSite=Lax", "tracking=1; Expires=Wed, 21 Oct 2020 07:28:00 GMT"];

// ---------------------------------------------------------------------------
// The whole result, against the checks as they were
// ---------------------------------------------------------------------------

for (const [fixture, html] of Object.entries(FIXTURES)) {
  test(`runSecurityChecks gives exactly the old result: ${fixture}`, () => {
    for (const [headerName, headers] of Object.entries(HEADER_SETS)) {
      for (const servedOverHttps of [true, false]) {
        const now = current.runSecurityChecks(headers, html, servedOverHttps, COOKIES, NOW);
        const before = baseline.runSecurityChecks(headers, html, servedOverHttps, COOKIES, NOW);
        assert.deepEqual(now, before, `${headerName}, ${servedOverHttps ? "HTTPS" : "HTTP"}`);
      }
    }
  });
}

test("the comparison is not vacuous: the fixtures exercise every check", () => {
  const results = Object.values(FIXTURES).map((html) =>
    baseline.runSecurityChecks({ "content-type": "text/html" }, html, true, COOKIES, NOW),
  );

  assert.ok(results.some((r) => r.mixedContent.truncated), "a result whose mixed content is cut");
  assert.ok(results.some((r) => r.mixedContent.upgradeInsecureRequests), "a meta CSP that upgrades");
  assert.ok(results.some((r) => r.contentSecurityPolicyMeta), "a meta CSP");
  assert.ok(results.some((r) => r.insecureFormActions.length >= 3), "insecure form actions");
  assert.ok(results.some((r) => r.mixedContent.items.some((item) => item.via.startsWith("iframe srcdoc"))), "srcdoc content");
  assert.ok(results.some((r) => r.mixedContent.items.some((item) => item.via.includes("style attribute"))), "style attributes");
});

test("the order of mixed-content items, and where the list is cut, are unchanged", () => {
  const html = FIXTURES["more mixed content than the report keeps"];

  const now = current.runSecurityChecks({}, html, true, [], NOW).mixedContent;
  const before = baseline.runSecurityChecks({}, html, true, [], NOW).mixedContent;

  assert.ok(before.total > before.items.length, "the fixture is longer than the report keeps");
  assert.equal(now.items.length, before.items.length);
  assert.equal(now.total, before.total);
  assert.equal(now.truncated, true);
  assert.deepEqual(
    now.items.map((item) => `${item.element}:${item.via}:${item.url}`),
    before.items.map((item) => `${item.element}:${item.via}:${item.url}`),
  );
});

// ---------------------------------------------------------------------------
// The exported helpers, for their other callers
// ---------------------------------------------------------------------------

for (const [fixture, html] of Object.entries(FIXTURES)) {
  test(`each exported helper gives exactly the old answer: ${fixture}`, () => {
    assert.equal(current.hasMetaContentSecurityPolicy(html), baseline.hasMetaContentSecurityPolicy(html));
    assert.deepEqual(current.findInsecureFormActions(html), baseline.findInsecureFormActions(html));
    for (const headers of Object.values(HEADER_SETS)) {
      assert.equal(current.hasEnforcedUpgradeInsecureRequests(headers, html), baseline.hasEnforcedUpgradeInsecureRequests(headers, html));
    }
    for (const servedOverHttps of [true, false]) {
      for (const upgrade of [true, false, undefined]) {
        assert.deepEqual(
          current.findMixedContent(html, servedOverHttps, upgrade),
          baseline.findMixedContent(html, servedOverHttps, upgrade),
        );
      }
    }
  });
}

test("running the checks twice on the same page gives the same result, so the shared parse is only read", () => {
  const html = FIXTURES["more mixed content than the report keeps"];

  const first = current.runSecurityChecks(HEADER_SETS["every header present"], html, true, COOKIES, NOW);
  const second = current.runSecurityChecks(HEADER_SETS["every header present"], html, true, COOKIES, NOW);

  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// One parse
// ---------------------------------------------------------------------------

const source = () =>
  fs
    .readFileSync(new URL("./securityChecks.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** The text of one top-level function, from its declaration to the next one. */
function functionBody(code: string, name: string): string {
  const start = code.search(new RegExp(`function ${name}\\(`));
  assert.ok(start !== -1, `${name} exists`);
  const next = code.slice(start + 1).search(/\n(export )?function /);
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

test("runSecurityChecks parses the page once, and hands that parse to every check", () => {
  const code = source();
  const body = functionBody(code, "runSecurityChecks");

  assert.equal(body.split("cheerio.load(").length - 1, 1, "one parse in runSecurityChecks");
  for (const helper of ["hasMetaContentSecurityPolicy(", "hasEnforcedUpgradeInsecureRequests(", "findMixedContent(", "findInsecureFormActions(", "collectInsecureResources("]) {
    assert.ok(!body.includes(helper), `runSecurityChecks must not call the string helper ${helper.slice(0, -1)}, which parses again`);
  }
  for (const shared of ["hasMetaContentSecurityPolicyIn($)", "hasEnforcedUpgradeInsecureRequestsIn(headers, $)", "collectInsecureResourcesIn($, 0)", "findInsecureFormActionsIn($)"]) {
    assert.ok(body.includes(shared), `runSecurityChecks hands its parse to ${shared}`);
  }
});

test("the checks that take a parsed page never parse it again", () => {
  const code = source();

  for (const name of ["hasMetaContentSecurityPolicyIn", "metaContentSecurityPoliciesIn", "hasEnforcedUpgradeInsecureRequestsIn", "findInsecureFormActionsIn", "mixedContentResult"]) {
    assert.ok(!functionBody(code, name).includes("cheerio.load("), `${name} must not parse`);
  }

  // The walk parses only the separate documents embedded in srcdoc, through
  // the string form, and never the page it was handed.
  const walk = functionBody(code, "collectInsecureResourcesIn");
  assert.ok(!walk.includes("cheerio.load("), "the walk itself does not parse");
  assert.ok(walk.includes("collectInsecureResources(inner, depth + 1)"), "srcdoc documents are still parsed on their own");
});

test("the file parses in exactly five places: the shared parse and the four string helpers", () => {
  assert.equal(source().split("cheerio.load(").length - 1, 5);
});
