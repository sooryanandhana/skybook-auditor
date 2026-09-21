/**
 * Corpus F — mixed content: what an HTTPS page's own HTML asks a browser to
 * load over plain HTTP.
 *
 * Yardsticks: the W3C Mixed Content and Upgrade Insecure Requests
 * specifications, and the approved policy that mixed content is High ("a real
 * exposure with no warning shown to the visitor").
 *
 * An `upgrade-insecure-requests` directive in an ENFORCED policy — a header, or
 * a <meta http-equiv> element — makes a conforming browser rewrite http:// to
 * https:// before the request is made, so the insecure load the finding
 * describes does not happen. The same directive in a report-only policy is
 * ignored by browsers.
 */
import assert from "node:assert/strict";

import type { SiteAuditResult } from "../types.ts";
import {
  auditFixtureSite,
  correct,
  findingsOf,
  page,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  installOfflineCorpus,
} from "./corpus.fixture.mts";

installOfflineCorpus();

function auditPage(html: string, options: { headers?: Record<string, string>; http?: boolean } = {}): Promise<SiteAuditResult> {
  const root = `${options.http ? "http" : "https"}://${PUBLIC_HOST}/`;
  return auditFixtureSite({ [root]: { html, headers: options.headers ?? { ...PROTECTED_HEADERS } } });
}

const mixed = (result: SiteAuditResult) => findingsOf(result).get("security.mixed-content");
const HTTP_IMAGE = `<img src="http://cdn.example.net/photo.png" alt="Surgery">`;

correct("F1 an HTTPS page with no insecure references: nothing measured, no finding", async () => {
  const result = await auditPage(page());
  assert.equal(result.data.security.mixedContent.total, 0);
  assert.equal(mixed(result), undefined);
});

correct("F2 an http:// image is passive mixed content: High, counted, not called blockable", async () => {
  const result = await auditPage(page({ body: HTTP_IMAGE }));
  assert.deepEqual(result.data.security.mixedContent.items.map((item) => `${item.element}:${item.kind}`), ["img:passive"]);
  assert.equal(mixed(result)?.severity, "high");
  assert.equal(mixed(result)?.evidence, "1 insecure resource(s) were found in the page's HTML.");
});

correct("F3 an http:// script, stylesheet or iframe is active mixed content, which the evidence says browsers block", async () => {
  const cases = {
    script: page({ body: `<script src="http://cdn.example.net/app.js"></script>` }),
    link: page({ head: `<link rel="stylesheet" href="http://cdn.example.net/site.css">` }),
    iframe: page({ body: `<iframe src="http://cdn.example.net/map"></iframe>` }),
  };
  for (const [element, html] of Object.entries(cases)) {
    const result = await auditPage(html);
    assert.deepEqual(result.data.security.mixedContent.items.map((item) => `${item.element}:${item.kind}`), [`${element}:active`], element);
    assert.match(mixed(result)?.evidence ?? "", /1 of them are scripts or stylesheets a browser will block\./, element);
  }
});

correct("F4 passive and active together are counted separately", async () => {
  const result = await auditPage(page({ body: `${HTTP_IMAGE}<script src="http://cdn.example.net/app.js"></script>` }));
  assert.equal(result.data.security.mixedContent.total, 2);
  assert.equal(result.data.security.mixedContent.activeCount, 1);
});

correct("F5 a form posting to http:// is its own Critical finding, not mixed content", async () => {
  const result = await auditPage(page({ body: `<form method="post" action="http://example.com/login"><input name="u"></form>` }));
  assert.deepEqual(result.data.security.insecureFormActions, ["http://example.com/login"]);
  assert.equal(findingsOf(result).get("security.form.insecure")?.severity, "critical");
  assert.equal(mixed(result), undefined);
});

correct("F6 protocol-relative references and ordinary http:// links are not mixed content", async () => {
  const result = await auditPage(page({ body: `<img src="//cdn.example.net/photo.png" alt="x"><a href="http://other.example/">x</a>` }));
  assert.equal(result.data.security.mixedContent.total, 0);
});

correct("F7 on a plain-HTTP page mixed content does not apply, and the rule is skipped with a reason", async () => {
  const result = await auditPage(page({ body: HTTP_IMAGE }), { http: true, headers: {} });
  assert.equal(result.data.security.mixedContent.applicable, false);
  assert.equal(mixed(result), undefined);
  assert.equal(findingsOf(result).skipped("security.mixed-content").length, 1);
});

correct("F8 an enforced upgrade-insecure-requests header suppresses the mixed-content finding: the browser upgrades the reference before it loads", async () => {
  const headers = { ...PROTECTED_HEADERS, "content-security-policy": "default-src 'self'; upgrade-insecure-requests" };
  const result = await auditPage(page({ body: HTTP_IMAGE }), { headers });
  // The reference is still measured and listed truthfully -- only the finding
  // is suppressed, because the browser rewrites it to https:// before loading.
  assert.equal(result.data.security.mixedContent.total, 1);
  assert.equal(result.data.security.mixedContent.upgradeInsecureRequests, true);
  assert.equal(mixed(result), undefined);
});

correct("F9 upgrade-insecure-requests delivered in an enforcing <meta http-equiv> suppresses the mixed-content finding", async () => {
  const html = page({ head: `<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">`, body: HTTP_IMAGE });
  const result = await auditPage(html);
  assert.equal(result.data.security.mixedContent.total, 1);
  assert.equal(result.data.security.mixedContent.upgradeInsecureRequests, true);
  assert.equal(mixed(result), undefined);
});

correct("F10 upgrade-insecure-requests in a report-only policy upgrades nothing, so the finding stands", async () => {
  const headers = { ...PROTECTED_HEADERS, "content-security-policy-report-only": "upgrade-insecure-requests" };
  assert.equal(mixed(await auditPage(page({ body: HTTP_IMAGE }), { headers }))?.severity, "high");
});
