/**
 * Tests for the SEO and technical rules.
 *
 * The case that matters most is a client-rendered page. This scan does not run
 * JavaScript, so such a page serves an almost empty body — and without the
 * body gate every heading and image rule would fire at once, reporting five
 * problems on a site that has none of them.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { assertUniqueRuleIds, runRules } from "./runner.ts";
import { ALL_RULES, AUDIT_RULES } from "./all.ts";
import { SEO_RULES } from "./seo.ts";
import { TECHNICAL_RULES } from "./technical.ts";
import { SECURITY_RULES } from "./security.ts";
import { runSeoChecks } from "../collector/seoChecks.ts";
import type { AuditFacts } from "./types.ts";
import type { PerformanceData, SeoData, SslData, TechnicalData } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A page with nothing wrong with it. */
const HEALTHY_HTML = `<html lang="en"><head>
<title>Kettles compared</title>
<meta name="description" content="Every kettle we sell, compared on speed and noise.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://shop.test/kettles">
</head><body>
<h1>Kettles compared</h1>
<h2>How we test</h2>
<p>We compare every kettle we sell on speed, noise and how long the handle stays cool. Prices are checked weekly and include delivery to mainland addresses.</p>
<img src="a.png" alt="A stainless steel kettle">
<img src="divider.png" alt="">
</body></html>`;

/** A client-rendered shell: a full head, and a body with nothing in it. */
const SPA_HTML = `<html lang="en"><head>
<title>Shop</title>
<meta name="description" content="Our shop.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://shop.test/">
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

function technical(overrides: Partial<TechnicalData> = {}): TechnicalData {
  return { robotsTxtStatus: "found", sitemapStatus: "found", robotsBlocksEverything: false, sitemapUrl: "https://shop.test/sitemap.xml", ...overrides };
}

function notCheckedPerformance(): PerformanceData {
  const message = "Speed was not measured.";
  return {
    status: "not-requested",
    strategy: "mobile",
    requestedUrl: "https://shop.test/",
    failureReason: null,
    field: { status: "error", measuredUrl: null, scope: null, overall: null, lcp: null, inp: null, cls: null, fcp: null, ttfb: null, error: message },
    lab: { status: "error", measuredUrl: null, score: null, lcpMs: null, fcpMs: null, tbtMs: null, speedIndexMs: null, cls: null, error: message },
    notInspected: [],
    message,
  };
}

function facts(overrides: Partial<AuditFacts> = {}): AuditFacts {
  return {
    website: { requestedUrl: "https://shop.test/", checkedAt: "2026-09-03T00:00:00.000Z" },
    fetch: {
      finalUrl: "https://shop.test/",
      redirectChain: ["https://shop.test/"],
      wasRedirected: false,
      servedOverHttps: true,
      httpsUnavailable: false,
      certificateProblem: null,
      contentType: "text/html",
    },
    uptime: { isOnline: true, statusCode: 200, serverResponseTimeMs: 100 },
    seo: runSeoChecks(HEALTHY_HTML, "https://shop.test/kettles"),
    technical: technical(),
    performance: notCheckedPerformance(),
    security: {} as AuditFacts["security"],
    ssl: { status: "unreachable", hostname: "shop.test", certificate: null, trusted: null, problem: null, failure: "timeout", message: "no TLS" } as SslData,
    dns: {} as AuditFacts["dns"],
    hosting: null,
    timedOut: false,
    ...overrides,
  };
}

/** Runs only the 6c rules, so security findings do not clutter the assertions. */
const SIX_C_RULES = [...SEO_RULES, ...TECHNICAL_RULES];

function run(overrides: Partial<AuditFacts> = {}) {
  return runRules(facts(overrides), SIX_C_RULES);
}

function firedIds(overrides: Partial<AuditFacts> = {}): string[] {
  return run(overrides).findings.map((f) => f.id);
}

function findingFor(id: string, overrides: Partial<AuditFacts> = {}) {
  return run(overrides).findings.find((f) => f.id === id);
}

function skipReason(id: string, overrides: Partial<AuditFacts> = {}) {
  return run(overrides).skipped.find((s) => s.ruleId === id)?.reason;
}

/** The healthy page with one fact changed. */
function seoWith(overrides: Partial<SeoData>): SeoData {
  return { ...runSeoChecks(HEALTHY_HTML, "https://shop.test/kettles"), ...overrides };
}

// ---------------------------------------------------------------------------
// The rule set
// ---------------------------------------------------------------------------

const SEVERITY_POLICY: Record<string, "critical" | "high" | "medium"> = {
  "technical.robots.blocks-all": "critical",
  "seo.viewport.missing": "high",
  "seo.title.missing": "high",
  "seo.meta-description.missing": "medium",
  "seo.canonical.missing": "medium",
  "seo.lang.missing": "medium",
  "seo.h1.missing": "medium",
  "seo.h1.multiple": "medium",
  "seo.h1.empty": "medium",
  "seo.headings.order": "medium",
  "seo.images.alt": "medium",
};

test("exactly eleven rules were added", () => {
  assert.equal(SEO_RULES.length, 10);
  assert.equal(TECHNICAL_RULES.length, 1);
  assert.equal(SIX_C_RULES.length, 11);
});

test("every rule declares the approved severity", () => {
  for (const rule of SIX_C_RULES) {
    const expected = SEVERITY_POLICY[rule.id];
    assert.ok(expected, `${rule.id} is not in the approved policy table`);
    assert.equal(rule.severity, expected, `${rule.id} must be ${expected}`);
  }
});

test("the policy table and the rule set describe the same eleven rules", () => {
  assert.deepEqual(SIX_C_RULES.map((r) => r.id).sort(), Object.keys(SEVERITY_POLICY).sort());
});

test("no length rules were added — the numbers are reported, not graded", () => {
  // Google truncates by pixel width, so a character threshold would be our
  // opinion presented as a measurement.
  for (const rule of SIX_C_RULES) {
    assert.ok(!/length/.test(rule.id), `${rule.id} grades a length, which was ruled out`);
  }
  // The measurements themselves are still collected.
  const seo = runSeoChecks(HEALTHY_HTML);
  assert.equal(typeof seo.titleLength, "number");
  assert.equal(typeof seo.metaDescriptionLength, "number");
});

test("robots.txt and sitemap presence were left out of this set", () => {
  const ids = SIX_C_RULES.map((r) => r.id);
  assert.ok(!ids.includes("technical.robots.missing"));
  assert.ok(!ids.includes("technical.sitemap.missing"));
});

test("categories are correct and no rule declares good", () => {
  for (const rule of SEO_RULES) assert.equal(rule.category, "seo");
  for (const rule of TECHNICAL_RULES) assert.equal(rule.category, "technical");
  for (const rule of SIX_C_RULES) assert.notEqual(rule.severity as string, "good");
});

test("ids stay unique across every rule set in the audit", () => {
  assert.doesNotThrow(() => assertUniqueRuleIds(ALL_RULES));

  // AUDIT_RULES is what POST /api/audit can grade: the speed rules read
  // measurements that only exist in the other request, so they are not in it.
  assert.equal(AUDIT_RULES.length, SECURITY_RULES.length + 11);
  assert.ok(
    !AUDIT_RULES.some((r) => r.id.startsWith("speed.")),
    "the audit request has no speed measurements to grade",
  );
  // ALL_RULES is the complete inventory, used for the uniqueness check.
  assert.ok(ALL_RULES.length > AUDIT_RULES.length);
});

test("a healthy page produces nothing", () => {
  assert.deepEqual(firedIds(), []);
});

// ---------------------------------------------------------------------------
// Technical
// ---------------------------------------------------------------------------

test("robots.txt blocking every crawler: critical", () => {
  const finding = findingFor("technical.robots.blocks-all", {
    technical: technical({ robotsBlocksEverything: true }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.equal(finding.category, "technical");
  assert.match(finding.evidence, /disallows all crawlers/);
  assert.match(finding.remediation, /Disallow/);
});

test("an audit that ran out of time never claims robots.txt blocks search", () => {
  // technical: null is the timeout marker. Reporting a critical finding from
  // it would be an alarming claim about something we never measured.
  const overrides = { technical: null };

  assert.equal(findingFor("technical.robots.blocks-all", overrides), undefined);
  assert.match(skipReason("technical.robots.blocks-all", overrides) ?? "", /ran out of time/);
});

// ---------------------------------------------------------------------------
// Head-based rules
// ---------------------------------------------------------------------------

test("missing title: high", () => {
  const finding = findingFor("seo.title.missing", {
    seo: seoWith({ titleText: null, titleLength: 0 }),
  });

  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.match(finding.evidence, /no <title>/);
});

test("missing viewport: high", () => {
  const finding = findingFor("seo.viewport.missing", { seo: seoWith({ hasViewportMeta: false }) });

  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.match(finding.evidence, /desktop width/);
});

test("missing meta description, canonical and lang: medium each", () => {
  const cases: Array<[string, Partial<SeoData>]> = [
    ["seo.meta-description.missing", { metaDescriptionText: null, metaDescriptionLength: 0 }],
    ["seo.canonical.missing", { canonicalUrl: null }],
    ["seo.lang.missing", { langAttribute: null }],
  ];

  for (const [id, override] of cases) {
    const finding = findingFor(id, { seo: seoWith(override) });
    assert.ok(finding, `${id} should fire`);
    assert.equal(finding.severity, "medium");
    assert.ok(finding.evidence.length > 0);
    assert.ok(finding.remediation.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Body-based rules
// ---------------------------------------------------------------------------

test("no h1: medium", () => {
  const finding = findingFor("seo.h1.missing", { seo: seoWith({ h1Count: 0, h1Texts: [] }) });

  assert.ok(finding);
  assert.equal(finding.severity, "medium");
});

test("several h1s: medium, listing them", () => {
  const finding = findingFor("seo.h1.multiple", {
    seo: seoWith({ h1Count: 3, h1Texts: ["Shop", "Kettles", "Offers"] }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /3 <h1> elements/);
  assert.match(finding.evidence, /Kettles/);
});

test("an h1 with no text is caught by neither missing nor multiple", () => {
  // One element, so not missing and not a duplicate — but empty, and invisible
  // in exactly the way that lets it survive for years.
  const fired = firedIds({ seo: seoWith({ h1Count: 1, h1Texts: [] }) });

  assert.ok(!fired.includes("seo.h1.missing"));
  assert.ok(!fired.includes("seo.h1.multiple"));
  assert.ok(fired.includes("seo.h1.empty"));
});

test("h1.empty reports how many are empty, and stays quiet when none are", () => {
  const finding = findingFor("seo.h1.empty", { seo: seoWith({ h1Count: 3, h1Texts: ["Only one"] }) });
  assert.ok(finding);
  assert.match(finding.evidence, /2 of 3/);

  assert.equal(findingFor("seo.h1.empty", { seo: seoWith({ h1Count: 0, h1Texts: [] }) }), undefined);
  assert.equal(findingFor("seo.h1.empty"), undefined);
});

test("heading level skips: medium, quoting the skips measured", () => {
  const finding = findingFor("seo.headings.order", {
    seo: seoWith({ headingSkips: ["h2 followed by h4"] }),
  });

  assert.ok(finding);
  assert.match(finding.evidence, /h2 followed by h4/);
});

test("images without alt: medium, and decorative ones are not counted", () => {
  // The healthy fixture has one described image and one alt="" divider.
  const seo = runSeoChecks(HEALTHY_HTML);
  assert.equal(seo.imageCount, 2);
  assert.equal(seo.imagesMissingAlt, 0, 'alt="" is correct, not a fault');
  assert.equal(findingFor("seo.images.alt"), undefined);

  const finding = findingFor("seo.images.alt", { seo: seoWith({ imageCount: 5, imagesMissingAlt: 2 }) });
  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /2 of 5/);
  assert.match(finding.evidence, /Decorative images marked/);
});

// ===========================================================================
// THE CASE THIS STEP WAS DESIGNED AROUND
// ===========================================================================

test("a client-rendered page produces no body-based findings", () => {
  // Its headings and images are absent from the HTML and perfectly present for
  // a visitor. Five findings here would all be false.
  const fired = firedIds({ seo: runSeoChecks(SPA_HTML, "https://shop.test/") });

  for (const id of [
    "seo.h1.missing",
    "seo.h1.multiple",
    "seo.h1.empty",
    "seo.headings.order",
    "seo.images.alt",
  ]) {
    assert.ok(!fired.includes(id), `${id} must not fire on a client-rendered page`);
  }
});

test("those checks are recorded as skipped, with our limitation as the reason", () => {
  const { skipped } = run({ seo: runSeoChecks(SPA_HTML, "https://shop.test/") });
  const ids = skipped.map((s) => s.ruleId);

  assert.equal(ids.filter((id) => id.startsWith("seo.h1") || id.includes("headings") || id.includes("images")).length, 5);

  const reason = skipped.find((s) => s.ruleId === "seo.h1.missing")?.reason ?? "";
  assert.match(reason, /does not run JavaScript/);
  // It blames our scan, not the site.
  assert.ok(!/poor|bad|broken|thin/i.test(reason));
});

test("but its head-based facts are still judged", () => {
  // This is the half that must stay independent: a client-rendered page with a
  // good head passes those rules on merit.
  const fired = firedIds({ seo: runSeoChecks(SPA_HTML, "https://shop.test/") });

  assert.deepEqual(fired, [], "the shell's head is complete, so nothing should fire");
});

/*
 * THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS WRONG.
 *
 * It required all five head rules to fire on a shell with an empty head and an
 * empty body, on the reasoning that an empty body "must not excuse a genuinely
 * missing title". The flaw is in the word genuinely: on a page that builds
 * itself in the browser we have no way to know the title is missing. We know
 * it was not in the markup we were sent, and that is a different statement.
 *
 * Such a page commonly sets its own title, description and canonical at
 * runtime. Reporting them as missing tells the client about problems their
 * visitors and Google never see. The test below now holds the correct
 * behaviour, and the one after it keeps the protection this one was reaching
 * for — on a page where absence really is measurable.
 */
test("a client-rendered page's missing head tags are NOT called missing", () => {
  const bare = runSeoChecks(
    `<html><head></head><body><div id="root"></div><script src="/b.js"></script></body></html>`,
    "https://shop.test/",
  );
  assert.equal(bare.bodyTextLength, 0, "nothing readable was served");

  const outcome = runRules(facts({ seo: bare }), SIX_C_RULES);
  const fired = outcome.findings.filter((f) => f.severity !== "good").map((f) => f.id);
  const skipped = outcome.skipped.map((s) => s.ruleId);

  for (const id of [
    "seo.title.missing",
    "seo.meta-description.missing",
    "seo.viewport.missing",
    "seo.canonical.missing",
    "seo.lang.missing",
  ]) {
    assert.ok(!fired.includes(id), `${id} must not claim the tag is missing`);
    assert.ok(skipped.includes(id), `${id} must say it could not be judged`);
  }

  // Unchanged: still nothing about its body either.
  assert.ok(!fired.some((id) => id.startsWith("seo.h1")));
  assert.ok(!fired.includes("seo.images.alt"));
});

test("the skip says what was measured and why it decided nothing", () => {
  const bare = runSeoChecks(`<html><head></head><body><div id="root"></div></body></html>`);
  const { skipped } = runRules(facts({ seo: bare }), SIX_C_RULES);
  const reason = skipped.find((s) => s.ruleId === "seo.canonical.missing")?.reason ?? "";

  assert.match(reason, /0 characters of visible text/);
  assert.match(reason, /does not run JavaScript/);
  // It must state a limit of the scan, never a fault in the website.
  assert.match(reason, /not evidence/);
  assert.doesNotMatch(reason, /broken|error|invalid/i);
});

test("a page with a real body and a bad head reports every one of them", () => {
  /*
   * The other direction, and the reason the original test existed. Once the
   * served HTML carries a page, an absent head tag really is absent, and every
   * one of these rules must still say so.
   */
  const served = runSeoChecks(
    `<html><head></head><body><h1>Kettles</h1>
     <p>We compare every kettle we sell on speed, noise and how long the handle stays cool.
     Prices are checked weekly and include delivery to any UK address.</p></body></html>`,
    "https://shop.test/",
  );
  assert.ok(served.bodyTextLength >= 50, "this page was readable");

  const fired = firedIds({ seo: served });

  assert.ok(fired.includes("seo.title.missing"));
  assert.ok(fired.includes("seo.meta-description.missing"));
  assert.ok(fired.includes("seo.viewport.missing"));
  assert.ok(fired.includes("seo.canonical.missing"));
  assert.ok(fired.includes("seo.lang.missing"));
});

test("a tag that IS served is judged however thin the body is", () => {
  /*
   * Presence is certain. Nothing a script does later makes a tag we can see
   * stop having been there, so a shell that DOES carry its head tags gets a
   * clean pass rather than a skip — and its absent ones stay unjudged.
   */
  const shell = runSeoChecks(
    `<html lang="en"><head><title>App</title>
     <meta name="description" content="A client-rendered application.">
     <meta name="viewport" content="width=device-width">
     </head><body><div id="root"></div></body></html>`,
    "https://app.test/",
  );

  const { findings, skipped } = runRules(facts({ seo: shell }), SIX_C_RULES);
  const fired = findings.filter((f) => f.severity !== "good").map((f) => f.id);
  const skippedIds = skipped.map((s) => s.ruleId);

  for (const id of ["seo.title.missing", "seo.meta-description.missing", "seo.viewport.missing", "seo.lang.missing"]) {
    assert.ok(!fired.includes(id), `${id} is satisfied by the served markup`);
    assert.ok(!skippedIds.includes(id), `${id} had everything it needed`);
  }

  // The one tag the shell does not carry is the one we cannot judge.
  assert.ok(!fired.includes("seo.canonical.missing"));
  assert.ok(skippedIds.includes("seo.canonical.missing"));
});

// ===========================================================================
// Determinism
// ===========================================================================

test("findings come back worst first, whatever order the rules are in", () => {
  const broken = {
    seo: seoWith({ titleText: null, hasViewportMeta: false, canonicalUrl: null, h1Count: 0, h1Texts: [] }),
    technical: technical({ robotsBlocksEverything: true }),
  };

  const forward = runRules(facts(broken), SIX_C_RULES);
  const reversed = runRules(facts(broken), [...SIX_C_RULES].reverse());

  assert.deepEqual(forward.findings, reversed.findings);
  assert.equal(forward.findings[0].severity, "critical");
  assert.equal(forward.findings[1].severity, "high");
});

test("the same facts always produce the same result", () => {
  const broken = { seo: seoWith({ titleText: null }) };

  assert.deepEqual(runRules(facts(broken), SIX_C_RULES), runRules(facts(broken), SIX_C_RULES));
});

test("every finding carries id, category, severity, evidence and remediation", () => {
  const { findings } = run({
    seo: seoWith({ titleText: null }),
    technical: technical({ robotsBlocksEverything: true }),
  });

  assert.ok(findings.length >= 2);
  for (const finding of findings) {
    assert.ok(finding.id.length > 0);
    assert.ok(["seo", "technical"].includes(finding.category));
    assert.ok(finding.title.length > 0);
    assert.ok(finding.evidence.length > 0);
    assert.ok(finding.remediation.length > 0);
  }
});

test("evidence states the measurement rather than dramatising it", () => {
  const { findings } = run({
    seo: seoWith({ titleText: null, hasViewportMeta: false, h1Count: 0, h1Texts: [] }),
    technical: technical({ robotsBlocksEverything: true }),
  });

  for (const finding of findings) {
    for (const word of ["disaster", "terrible", "catastrophic", "dangerous", "urgent"]) {
      assert.ok(
        !finding.evidence.toLowerCase().includes(word),
        `evidence must be factual (found "${word}" in ${finding.id})`,
      );
    }
  }
});
