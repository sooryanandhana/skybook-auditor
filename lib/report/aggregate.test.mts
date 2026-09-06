/**
 * Tests for site-wide finding aggregation.
 *
 * The one thing being defended above all others: THIS LAYER COUNTS, IT DOES
 * NOT GRADE. Severity arrives already decided by the rule and must leave
 * untouched, however many pages a problem appears on. Several tests below
 * exist only to prove the aggregator has no way to reach a severity value at
 * all — including one that reads its own source.
 *
 * The second thing: a page where a rule could not run is not a page where the
 * rule passed. Keeping those out of the denominator is what stops "we could
 * not check this" quietly becoming "this page was fine".
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { aggregateFindings, MAX_AFFECTED_PAGES, type PageRuleResult } from "./aggregate.ts";
import { runRules, defineRule } from "../rules/runner.ts";
import { AUDIT_RULES } from "../rules/all.ts";
import type { Finding, Severity } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MISSING_DESCRIPTION = {
  id: "seo.meta-description.missing",
  scope: "page",
  title: "Meta description missing",
  category: "seo",
  severity: "medium",
  remediation: "Add a meta description of 50 to 160 characters.",
} as const;

/** One page's finding for a rule, with page-specific evidence. */
function finding(
  template: { id: string; title: string; category: string; severity: string; remediation: string },
  evidence: string,
): Finding {
  return {
    id: template.id,
    title: template.title,
    category: template.category as Finding["category"],
    severity: template.severity as Severity,
    evidence,
    remediation: template.remediation,
  };
}

function pageWith(url: string, findings: Finding[], skipped: PageRuleResult["skipped"] = []) {
  return { url, findings, skipped };
}

const url = (n: number) => `https://example.com/page-${String(n).padStart(3, "0")}`;

function sourceOf(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// One finding per rule outcome
// ---------------------------------------------------------------------------

test("one page with one finding produces one finding", () => {
  const result = aggregateFindings([
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "No meta description tag found")]),
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "seo.meta-description.missing");
  assert.equal(result.findings[0].affectedCount, 1);
  assert.equal(result.findings[0].evaluatedPages, 1);
  assert.deepEqual(result.findings[0].affected, [
    { url: url(1), evidence: "No meta description tag found" },
  ]);
});

test("the same rule across eight pages is ONE finding, not eight copies", () => {
  const pages = Array.from({ length: 8 }, (_, i) =>
    pageWith(url(i), [finding(MISSING_DESCRIPTION, `page ${i} has none`)]),
  );

  const result = aggregateFindings(pages);

  assert.equal(result.findings.length, 1, "a report is not a log");
  assert.equal(result.findings[0].affectedCount, 8);
  assert.equal(result.findings[0].affected?.length, 8);
});

test("different rule ids stay separate even when their titles match", () => {
  const twinA = { ...MISSING_DESCRIPTION, id: "seo.a" };
  const twinB = { ...MISSING_DESCRIPTION, id: "seo.b" };

  const result = aggregateFindings([
    pageWith(url(1), [finding(twinA, "x"), finding(twinB, "y")]),
  ]);

  // The id is the identity. A matching title is a coincidence.
  assert.deepEqual(result.findings.map((f) => f.id).sort(), ["seo.a", "seo.b"]);
});

test("a rule that fires on some pages and passes on others gives one of each", () => {
  const fired = MISSING_DESCRIPTION;
  const passed = { ...MISSING_DESCRIPTION, title: "Meta description present", severity: "good" };

  const result = aggregateFindings([
    pageWith(url(1), [finding(fired, "none")]),
    pageWith(url(2), [finding(passed, "120 characters")]),
    pageWith(url(3), [finding(passed, "98 characters")]),
  ]);

  // Merging them would force something to pick one severity to describe both,
  // and there is no honest way to make that choice.
  assert.equal(result.findings.length, 2);
  const problem = result.findings.find((f) => f.severity === "medium");
  const good = result.findings.find((f) => f.severity === "good");
  assert.equal(problem?.affectedCount, 1);
  assert.equal(good?.affectedCount, 2);
  // One rule, one denominator, shared by both.
  assert.equal(problem?.evaluatedPages, 3);
  assert.equal(good?.evaluatedPages, 3);
});

test("a rule that never fires produces no finding at all", () => {
  const result = aggregateFindings([pageWith(url(1), []), pageWith(url(2), [])]);

  assert.deepEqual(result.findings, []);
  assert.equal(result.evaluatedPages, 2);
});

// ---------------------------------------------------------------------------
// Severity is the rule's, and only the rule's
// ---------------------------------------------------------------------------

test("severity is copied from the rule, whatever the count", () => {
  for (const count of [1, 2, 50, 400]) {
    const pages = Array.from({ length: count }, (_, i) =>
      pageWith(url(i), [finding(MISSING_DESCRIPTION, "none")]),
    );

    const [aggregated] = aggregateFindings(pages).findings;

    // Four hundred pages missing a description is exactly as severe as one
    // page missing it. Severity describes the KIND of problem, not how much.
    assert.equal(aggregated.severity, "medium", `${count} pages`);
  }
});

test("every constant on the finding survives untouched", () => {
  const [aggregated] = aggregateFindings([
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "measured here")]),
  ]).findings;

  assert.equal(aggregated.id, MISSING_DESCRIPTION.id);
  assert.equal(aggregated.title, MISSING_DESCRIPTION.title);
  assert.equal(aggregated.category, MISSING_DESCRIPTION.category);
  assert.equal(aggregated.severity, MISSING_DESCRIPTION.severity);
  assert.equal(aggregated.remediation, MISSING_DESCRIPTION.remediation);
});

test("the aggregator names no severity value anywhere in its source", () => {
  // It has no way to reach for a worse word, because it never writes one.
  const code = codeOf("./aggregate.ts");
  const withoutOrdering = code.replace(/const SEVERITY_ORDER[\s\S]*?\};/, "");

  for (const word of ['"critical"', '"high"', '"medium"', '"good"']) {
    assert.ok(!withoutOrdering.includes(word), `${word} must not appear`);
  }
});

test("the aggregator never inspects one finding to decide another", () => {
  const code = codeOf("./aggregate.ts");

  // No cross-referencing, no promotion, no suppression.
  assert.ok(!/findings\.(some|every|filter|find)\s*\(/.test(code));
  assert.ok(!/Claude|anthropic|prompt/i.test(code));
});

test("two findings aggregate identically whether or not the other exists", () => {
  const other = { ...MISSING_DESCRIPTION, id: "seo.title.missing", severity: "high" };

  const alone = aggregateFindings([pageWith(url(1), [finding(MISSING_DESCRIPTION, "e")])]);
  const together = aggregateFindings([
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "e"), finding(other, "f")]),
  ]);

  const fromTogether = together.findings.find((f) => f.id === MISSING_DESCRIPTION.id);
  assert.deepEqual(fromTogether, alone.findings[0]);
});

// ---------------------------------------------------------------------------
// The denominator
// ---------------------------------------------------------------------------

test("evaluatedPages counts the pages the rule ran on", () => {
  const ruleIds = [MISSING_DESCRIPTION.id];
  const pages = [
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]),
    pageWith(url(2), []),
    pageWith(url(3), []),
  ];

  const [aggregated] = aggregateFindings(pages, { ruleIds }).findings;

  assert.equal(aggregated.affectedCount, 1);
  assert.equal(aggregated.evaluatedPages, 3, "it ran on all three, firing on one");
});

test("a page where the rule was skipped is NOT in the denominator", () => {
  // The example from the specification: 100 evaluated, 20 skipped, 30 fired.
  const ruleIds = [MISSING_DESCRIPTION.id];
  const pages: PageRuleResult[] = [];

  for (let i = 0; i < 30; i += 1) {
    pages.push(pageWith(url(i), [finding(MISSING_DESCRIPTION, "none")]));
  }
  for (let i = 30; i < 80; i += 1) pages.push(pageWith(url(i), []));
  for (let i = 80; i < 100; i += 1) {
    pages.push(
      pageWith(url(i), [], [{ ruleId: MISSING_DESCRIPTION.id, reason: "The page could not be parsed." }]),
    );
  }

  const result = aggregateFindings(pages, { ruleIds });
  const [aggregated] = result.findings;

  assert.equal(aggregated.affectedCount, 30);
  assert.equal(aggregated.evaluatedPages, 80, "the twenty skipped pages are not clean pages");
  assert.equal(result.evaluatedPages, 100, "but a hundred pages were still read");
});

test("a skipped page is never counted as a page that passed", () => {
  const ruleIds = [MISSING_DESCRIPTION.id];
  const skipped = [{ ruleId: MISSING_DESCRIPTION.id, reason: "No HTML was returned." }];

  const result = aggregateFindings(
    [pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]), pageWith(url(2), [], skipped)],
    { ruleIds },
  );

  assert.equal(result.findings[0].evaluatedPages, 1);
  assert.equal(result.findings[0].affectedCount, 1);
  // Not 1-of-2, which would imply the second page was fine.
});

test("skipped checks are kept, de-duplicated, and never become findings", () => {
  const pages = [
    pageWith(url(1), [], [{ ruleId: "a", reason: "same reason" }]),
    pageWith(url(2), [], [{ ruleId: "a", reason: "same reason" }]),
    pageWith(url(3), [], [{ ruleId: "a", reason: "a different reason" }]),
    pageWith(url(4), [], [{ ruleId: "b", reason: "same reason" }]),
  ];

  const result = aggregateFindings(pages);

  assert.deepEqual(result.findings, [], "a skip is not a finding");
  assert.deepEqual(result.skipped, [
    { ruleId: "a", reason: "a different reason" },
    { ruleId: "a", reason: "same reason" },
    { ruleId: "b", reason: "same reason" },
  ]);
});

test("a rule skipped on every page has no finding and no denominator entry", () => {
  const result = aggregateFindings(
    [
      pageWith(url(1), [], [{ ruleId: "seo.x", reason: "not measured" }]),
      pageWith(url(2), [], [{ ruleId: "seo.x", reason: "not measured" }]),
    ],
    { ruleIds: ["seo.x"] },
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.skipped.length, 1);
});

// ---------------------------------------------------------------------------
// Affected pages
// ---------------------------------------------------------------------------

test("each page's own evidence is preserved", () => {
  const result = aggregateFindings([
    pageWith(url(2), [finding(MISSING_DESCRIPTION, "second page evidence")]),
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "first page evidence")]),
  ]);

  assert.deepEqual(result.findings[0].affected, [
    { url: url(1), evidence: "first page evidence" },
    { url: url(2), evidence: "second page evidence" },
  ]);
});

test("affected pages are sorted by address, whatever order they arrived in", () => {
  const shuffled = [5, 2, 9, 1, 7].map((n) =>
    pageWith(url(n), [finding(MISSING_DESCRIPTION, `e${n}`)]),
  );

  const result = aggregateFindings(shuffled);

  assert.deepEqual(
    result.findings[0].affected?.map((a) => a.url),
    [1, 2, 5, 7, 9].map(url),
  );
});

test("aggregation does not depend on the order pages finished in", () => {
  // Stage 4D's workers finish in whatever order the network allows. The report
  // must not.
  const pages = [3, 1, 4, 1, 5, 9, 2, 6].map((n, i) =>
    pageWith(url(n * 10 + i), [finding(MISSING_DESCRIPTION, `e${n}`)]),
  );

  const forwards = aggregateFindings(pages);
  const backwards = aggregateFindings([...pages].reverse());
  const shuffled = aggregateFindings([...pages].sort(() => 0.5 - Math.random()));

  assert.deepEqual(JSON.stringify(forwards), JSON.stringify(backwards));
  assert.deepEqual(JSON.stringify(forwards), JSON.stringify(shuffled));
});

test("the same page cannot appear twice in one finding", () => {
  const duplicated = pageWith(url(1), [
    finding(MISSING_DESCRIPTION, "first"),
    finding(MISSING_DESCRIPTION, "second"),
  ]);

  const [aggregated] = aggregateFindings([duplicated]).findings;

  assert.equal(aggregated.affectedCount, 1);
  assert.deepEqual(aggregated.affected, [{ url: url(1), evidence: "first" }]);
});

test("affected pages are capped, and the true total is still reported", () => {
  const pages = Array.from({ length: 400 }, (_, i) =>
    pageWith(url(i), [finding(MISSING_DESCRIPTION, `e${i}`)]),
  );

  const [aggregated] = aggregateFindings(pages).findings;

  assert.equal(aggregated.affected?.length, MAX_AFFECTED_PAGES);
  // Without this, four hundred pages would silently read as fifty.
  assert.equal(aggregated.affectedCount, 400);
  assert.equal(aggregated.evaluatedPages, 400);
});

test("the capped sample is the first pages by address, not the first to finish", () => {
  const pages = Array.from({ length: 120 }, (_, i) =>
    pageWith(url(i), [finding(MISSING_DESCRIPTION, `e${i}`)]),
  );

  const forwards = aggregateFindings(pages).findings[0];
  const backwards = aggregateFindings([...pages].reverse()).findings[0];

  assert.deepEqual(forwards.affected, backwards.affected);
  assert.equal(forwards.affected?.[0].url, url(0));
});

test("the cap is a documented, explicit number", () => {
  assert.equal(MAX_AFFECTED_PAGES, 50);
  assert.ok(sourceOf("./aggregate.ts").includes("MAX_AFFECTED_PAGES = 50"));
});

// ---------------------------------------------------------------------------
// Ordering of the findings themselves
// ---------------------------------------------------------------------------

test("findings come back worst first, then by rule id", () => {
  const make = (id: string, severity: string) =>
    finding({ ...MISSING_DESCRIPTION, id, severity }, "e");

  const result = aggregateFindings([
    pageWith(url(1), [
      make("z.medium", "medium"),
      make("a.good", "good"),
      make("m.critical", "critical"),
      make("b.high", "high"),
      make("a.critical", "critical"),
    ]),
  ]);

  assert.deepEqual(result.findings.map((f) => f.id), [
    "a.critical",
    "m.critical",
    "b.high",
    "z.medium",
    "a.good",
  ]);
});

// ---------------------------------------------------------------------------
// Whole-crawl shapes
// ---------------------------------------------------------------------------

test("an empty crawl aggregates to nothing, without failing", () => {
  const result = aggregateFindings([]);

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.evaluatedPages, 0);
});

test("a large crawl stays bounded", () => {
  const pages: PageRuleResult[] = [];
  for (let i = 0; i < 150; i += 1) {
    pages.push(
      pageWith(
        url(i),
        Array.from({ length: 20 }, (_, r) =>
          finding({ ...MISSING_DESCRIPTION, id: `rule.${r}` }, `page ${i} rule ${r}`),
        ),
      ),
    );
  }

  const result = aggregateFindings(pages);

  assert.equal(result.findings.length, 20, "twenty rules, not three thousand findings");
  for (const found of result.findings) {
    assert.equal(found.affectedCount, 150);
    assert.equal(found.affected?.length, MAX_AFFECTED_PAGES);
  }
  // 20 rules x 50 entries, rather than 20 x 150.
  const entries = result.findings.reduce((n, f) => n + (f.affected?.length ?? 0), 0);
  assert.equal(entries, 1000);
});

test("a partial crawl aggregates only what was read", () => {
  // The crawl stopped at a limit. Aggregation says nothing about the pages it
  // never reached — they are simply absent, not clean.
  const result = aggregateFindings(
    [
      pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]),
      pageWith(url(2), [finding(MISSING_DESCRIPTION, "none")]),
    ],
    { ruleIds: [MISSING_DESCRIPTION.id] },
  );

  assert.equal(result.evaluatedPages, 2);
  assert.equal(result.findings[0].evaluatedPages, 2);
  assert.equal(result.findings[0].affectedCount, 2);
});

// ---------------------------------------------------------------------------
// Only evaluated pages ever reach here
// ---------------------------------------------------------------------------

test("pages that could not be read contribute nothing, because they never arrive", () => {
  /*
   * The exclusion is structural rather than a filter: the input is a list of
   * pages the rules RAN on. A page that timed out, returned a PDF, or was kept
   * away by robots.txt produced no rule results, so it cannot be passed in and
   * cannot be counted as clean by accident.
   */
  const evaluatedOnly = [
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]),
    pageWith(url(2), []),
  ];

  const result = aggregateFindings(evaluatedOnly, { ruleIds: [MISSING_DESCRIPTION.id] });

  assert.equal(result.evaluatedPages, 2);
  assert.equal(result.findings[0].evaluatedPages, 2);
});

test("a sitemap-discovered page is indistinguishable from a link-discovered one", () => {
  // Aggregation is told what the rules found, never where the address came
  // from. There is no field it could branch on even if it wanted to.
  const fromSitemap = pageWith(url(1), [finding(MISSING_DESCRIPTION, "e")]);
  const fromMarkup = pageWith(url(2), [finding(MISSING_DESCRIPTION, "e")]);

  const result = aggregateFindings([fromSitemap, fromMarkup]);

  assert.equal(result.findings[0].affectedCount, 2);
  assert.deepEqual(Object.keys(fromSitemap).sort(), ["findings", "skipped", "url"]);
});

// ---------------------------------------------------------------------------
// Compatibility with what came before
// ---------------------------------------------------------------------------

test("a single-page audit's findings are unchanged by the new fields", () => {
  // The Phase 3 shape: no affected, no counts, nothing added.
  const single = runRules(
    {
      fetch: null,
      uptime: { isOnline: false, statusCode: null, serverResponseTimeMs: null },
    } as never,
    AUDIT_RULES,
  );

  for (const found of single.findings) {
    assert.equal(found.affected, undefined);
    assert.equal(found.affectedCount, undefined);
    assert.equal(found.evaluatedPages, undefined);
  }
});

test("an aggregated finding is still a valid Finding for the existing frontend", () => {
  const [aggregated] = aggregateFindings([
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]),
  ]).findings;

  // The five fields every existing consumer reads are all present and are
  // exactly what a single-page finding would carry.
  for (const field of ["id", "title", "category", "severity", "evidence", "remediation"]) {
    assert.notEqual(
      (aggregated as unknown as Record<string, unknown>)[field],
      undefined,
      field,
    );
  }
  assert.equal(typeof aggregated.evidence, "string");
});

test("real rules aggregate the way hand-made findings do", () => {
  // Guards against the fixtures above drifting from what the engine emits.
  const rule = defineRule<string, { value: string }>({
    id: "test.example",
    scope: "page",
    title: "Example problem",
    category: "seo",
    severity: "high",
    remediation: "Fix it.",
    select: (data) => ({ measured: true, value: data.value }),
    evaluate: (value) =>
      value === "bad" ? { fires: true, evidence: `saw ${value}` } : { fires: false },
  });

  const pages = [
    { url: url(1), ...runRules({ value: "bad" }, [rule]) },
    { url: url(2), ...runRules({ value: "fine" }, [rule]) },
    { url: url(3), ...runRules({ value: "bad" }, [rule]) },
  ];

  const [aggregated] = aggregateFindings(pages, { ruleIds: ["test.example"] }).findings;

  assert.equal(aggregated.severity, "high", "the rule's own constant");
  assert.equal(aggregated.affectedCount, 2);
  assert.equal(aggregated.evaluatedPages, 3);
  assert.deepEqual(aggregated.affected?.map((a) => a.url), [url(1), url(3)]);
});

test("a rule that could not run on a page becomes a skipped check, not a pass", () => {
  const rule = defineRule<string, { value: string | null }>({
    id: "test.unmeasured",
    scope: "page",
    title: "Example",
    category: "seo",
    severity: "high",
    remediation: "Fix it.",
    select: (data) =>
      data.value === null
        ? { measured: false, reason: "Nothing was measured here." }
        : { measured: true, value: data.value },
    evaluate: () => ({ fires: true, evidence: "fired" }),
  });

  const pages = [
    { url: url(1), ...runRules({ value: "x" }, [rule]) },
    { url: url(2), ...runRules({ value: null }, [rule]) },
  ];

  const result = aggregateFindings(pages, { ruleIds: ["test.unmeasured"] });

  assert.equal(result.findings[0].evaluatedPages, 1, "one page, not two");
  assert.equal(result.findings[0].affectedCount, 1);
  assert.deepEqual(result.skipped, [
    { ruleId: "test.unmeasured", reason: "Nothing was measured here." },
  ]);
});

// ---------------------------------------------------------------------------
// Scope: a site fact is not multiplied by the page count
//
// The bug this section exists for: one SPF record reported as "128 of 128
// pages affected". A domain has one SPF record however many pages were read.
// ---------------------------------------------------------------------------

const SPF_MISSING = {
  id: "security.dns.spf",
  title: "No SPF record",
  category: "security",
  severity: "medium",
  remediation: "Publish an SPF record listing the servers allowed to send mail.",
} as const;

const siteInput = (findings: Finding[], skipped: PageRuleResult["skipped"] = []) => ({
  siteUrl: "https://example.com",
  findings,
  skipped,
});

test("a site-scoped finding is one finding, whatever the page count", () => {
  const pages = Array.from({ length: 128 }, (_, i) =>
    pageWith(url(i), [finding(MISSING_DESCRIPTION, "none")]),
  );

  const result = aggregateFindings(pages, {
    ruleIds: [MISSING_DESCRIPTION.id],
    site: siteInput([finding(SPF_MISSING, "No SPF record was found for example.com.")]),
  });

  const spf = result.findings.find((f) => f.id === "security.dns.spf");
  assert.ok(spf !== undefined);
  assert.equal(spf.scope, "site");
  assert.equal(spf.affectedCount, 1, "one domain, one SPF record");
  assert.equal(spf.affected?.length, 1);
  assert.equal(spf.affected?.[0].url, "https://example.com");
  // The claim that started all this must be impossible to make.
  assert.notEqual(spf.affectedCount, 128);
});

test("a site-scoped finding is given NO page denominator", () => {
  const pages = Array.from({ length: 40 }, (_, i) => pageWith(url(i), []));

  const result = aggregateFindings(pages, {
    ruleIds: [MISSING_DESCRIPTION.id],
    site: siteInput([finding(SPF_MISSING, "No SPF record.")]),
  });

  const spf = result.findings.find((f) => f.id === "security.dns.spf");
  // Absent, not zero and not forty: a DNS record has no page denominator, and
  // supplying one invites a reader to quote a proportion never measured.
  assert.equal(spf?.evaluatedPages, undefined);
});

test("a page-scoped finding still carries its page counts", () => {
  const pages = [
    pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")]),
    pageWith(url(2), []),
    pageWith(url(3), []),
  ];

  const result = aggregateFindings(pages, {
    ruleIds: [MISSING_DESCRIPTION.id],
    site: siteInput([finding(SPF_MISSING, "No SPF record.")]),
  });

  const page = result.findings.find((f) => f.id === MISSING_DESCRIPTION.id);
  assert.equal(page?.scope, "page");
  assert.equal(page?.affectedCount, 1);
  assert.equal(page?.evaluatedPages, 3);
});

test("MIXED: page rules keep page counts while the site rule stays singular", () => {
  /*
   * The scenario from the specification, with one addition that matters: a
   * page rule that is genuinely QUIET on some pages. Without it, a mutation
   * that mixed the two scopes could survive because every fixture produced
   * identical numbers.
   */
  const TITLE_MISSING = { ...MISSING_DESCRIPTION, id: "seo.title.missing", severity: "high" };

  const pages = [
    // Missing a title AND a description.
    pageWith(url(1), [finding(TITLE_MISSING, "no title"), finding(MISSING_DESCRIPTION, "none")]),
    // Missing only a description. The title rule ran here and stayed silent.
    pageWith(url(2), [finding(MISSING_DESCRIPTION, "none")]),
    // Nothing wrong at all. Both rules ran; neither said anything.
    pageWith(url(3), []),
  ];

  const result = aggregateFindings(pages, {
    ruleIds: [TITLE_MISSING.id, MISSING_DESCRIPTION.id],
    site: siteInput([finding(SPF_MISSING, "No SPF record was found for example.com.")]),
  });

  const title = result.findings.find((f) => f.id === "seo.title.missing");
  const description = result.findings.find((f) => f.id === MISSING_DESCRIPTION.id);
  const spf = result.findings.find((f) => f.id === "security.dns.spf");

  assert.equal(title?.affectedCount, 1);
  assert.equal(title?.evaluatedPages, 3, "quiet on two pages, but it ran on them");

  assert.equal(description?.affectedCount, 2);
  assert.equal(description?.evaluatedPages, 3);

  assert.equal(spf?.affectedCount, 1);
  assert.equal(spf?.evaluatedPages, undefined);
  // Not 3, which is what mixing the scopes would produce here.
  assert.notEqual(spf?.affectedCount, 3);
});

test("a site finding keeps the rule's own severity and evidence", () => {
  const evidence = "No SPF record was found for example.com.";

  const result = aggregateFindings([pageWith(url(1), [])], {
    site: siteInput([finding(SPF_MISSING, evidence)]),
  });

  const spf = result.findings[0];
  assert.equal(spf.severity, "medium", "the rule's constant, not recomputed");
  assert.equal(spf.title, SPF_MISSING.title);
  assert.equal(spf.remediation, SPF_MISSING.remediation);
  // Deterministic and unrewritten: the collector's sentence, character for
  // character, in both the top-level field and the affected entry.
  assert.equal(spf.evidence, evidence);
  assert.equal(spf.affected?.[0].evidence, evidence);
});

test("site findings sort into the same worst-first order as page findings", () => {
  const CRITICAL_SITE = { ...SPF_MISSING, id: "security.ssl.expired", severity: "critical" };

  const result = aggregateFindings([pageWith(url(1), [finding(MISSING_DESCRIPTION, "x")])], {
    site: siteInput([finding(CRITICAL_SITE, "expired"), finding(SPF_MISSING, "no spf")]),
  });

  assert.deepEqual(result.findings.map((f) => f.id), [
    "security.ssl.expired",
    "security.dns.spf",
    "seo.meta-description.missing",
  ]);
});

test("site rules that could not run become skipped checks, not findings", () => {
  const result = aggregateFindings([pageWith(url(1), [])], {
    site: siteInput([], [{ ruleId: "security.dns.spf", reason: "The DNS lookup failed." }]),
  });

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.skipped, [
    { ruleId: "security.dns.spf", reason: "The DNS lookup failed." },
  ]);
});

test("no site input at all leaves page aggregation exactly as it was", () => {
  const pages = [pageWith(url(1), [finding(MISSING_DESCRIPTION, "none")])];

  const without = aggregateFindings(pages, { ruleIds: [MISSING_DESCRIPTION.id] });
  const withEmpty = aggregateFindings(pages, {
    ruleIds: [MISSING_DESCRIPTION.id],
    site: siteInput([]),
  });

  assert.deepEqual(without.findings, withEmpty.findings);
  assert.equal(without.findings[0].scope, "page");
});
