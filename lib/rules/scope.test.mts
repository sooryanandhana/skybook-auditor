/**
 * Tests for rule scope.
 *
 * The bug this exists to prevent: reporting a single SPF record as "128 of 128
 * pages affected". That is not a display slip to be tidied up in the report —
 * it is a false statement about what was measured, because there is one SPF
 * record for a domain however many pages were crawled.
 *
 * Scope is therefore declared by the rule, from what it actually measures, and
 * decides how the finding is aggregated.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { ALL_RULES, AUDIT_RULES, PAGE_RULES, SITE_RULES, SPEED_RULES } from "./all.ts";

/** What each rule reads, established by inspection of its `select`. */
const SITE_MEASUREMENTS = ["ssl", "dns", "technical"];

test("every rule declares a scope explicitly", () => {
  // Required by the type, so this cannot regress silently — but stated as a
  // test too, because it is the property the whole stage rests on.
  for (const rule of ALL_RULES) {
    assert.ok(
      rule.scope === "page" || rule.scope === "site",
      `${rule.id} must declare scope`,
    );
  }
  assert.equal(ALL_RULES.length, 30);
});

test("scope is never inferred from a rule's id at runtime", () => {
  // Two rules whose ids start the same way may have different scopes, and a
  // rule's name is not evidence about its measurement.
  const dns = AUDIT_RULES.find((r) => r.id === "security.dns.spf");
  const https = AUDIT_RULES.find((r) => r.id === "security.https");

  assert.equal(dns?.scope, "site");
  assert.equal(https?.scope, "page", "both begin security. and differ");
});

test("the site rules are exactly the ones whose measurement is site-level", () => {
  assert.deepEqual(
    SITE_RULES.map((r) => r.id).sort(),
    [
      "security.dns.dmarc",
      "security.dns.spf",
      "security.ssl.expired",
      "security.ssl.hostname",
      "security.ssl.untrusted",
      "technical.robots.blocks-all",
    ],
    "certificate, DNS records and robots.txt are one fact per domain",
  );
});

test("security.https is PAGE-scoped, because it varies between pages", () => {
  /*
   * It reads `security.servedOverHttps`, which comes from the fetch of THAT
   * page. A live crawl of a real site reported it firing on 127 of 128 pages:
   * one page was HTTPS and the rest were not. A site-scoped rule cannot vary
   * like that, so this one is page-scoped whatever its name suggests.
   */
  const rule = AUDIT_RULES.find((r) => r.id === "security.https");
  assert.equal(rule?.scope, "page");
});

test("the two sets partition the audit rules, with no overlap and nothing lost", () => {
  assert.equal(PAGE_RULES.length + SITE_RULES.length, AUDIT_RULES.length);

  const pageIds = new Set(PAGE_RULES.map((r) => r.id));
  for (const rule of SITE_RULES) {
    assert.ok(!pageIds.has(rule.id), `${rule.id} is in both sets`);
  }
  assert.equal(SITE_RULES.length, 6);
  assert.equal(PAGE_RULES.length, 17);
});

test("the speed rules are page-scoped: PageSpeed measures one address", () => {
  for (const rule of SPEED_RULES) {
    assert.equal(rule.scope, "page", rule.id);
  }
});

test("no site rule reads a page-only measurement, and no page rule a site-only one", () => {
  // Guards the classification against drifting away from the facts. A rule's
  // scope is a claim about its `select`, and this checks the claim.
  for (const rule of SITE_RULES) {
    const source = ruleSource(rule.id);
    assert.ok(
      SITE_MEASUREMENTS.some((fact) => source.includes(`data.${fact}`)),
      `${rule.id} claims site scope but reads no site-level fact`,
    );
    assert.ok(
      !/data\.(seo|security)\b/.test(source),
      `${rule.id} claims site scope but reads a page-level fact`,
    );
  }

  for (const rule of PAGE_RULES) {
    const source = ruleSource(rule.id);
    for (const fact of SITE_MEASUREMENTS) {
      assert.ok(
        !source.includes(`data.${fact}`),
        `${rule.id} claims page scope but reads data.${fact}`,
      );
    }
  }
});

test("scope does not touch severity", () => {
  // Two independent properties. Marking a rule site-scoped must not make it
  // more or less serious — severity still comes from the rule alone.
  for (const rule of ALL_RULES) {
    assert.ok(["critical", "high", "medium"].includes(rule.severity), rule.id);
  }
  assert.equal(AUDIT_RULES.find((r) => r.id === "security.dns.spf")?.severity, "medium");
  assert.equal(AUDIT_RULES.find((r) => r.id === "security.ssl.expired")?.severity, "critical");
});

/** The `select` line of one rule, read from its own source file. */
function ruleSource(id: string): string {
  const file = id.startsWith("seo.")
    ? "seo"
    : id.startsWith("technical.")
      ? "technical"
      : id.startsWith("speed.")
        ? "speed"
        : "security";

  const source = fs.readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8");

  const start = source.indexOf(`id: "${id}"`);
  assert.notEqual(start, -1, `${id} not found in ${file}.ts`);
  const end = source.indexOf("});", start);
  return source.slice(start, end === -1 ? undefined : end);
}

test("no site rule reads a page measurement, even when one is there to read", () => {
  /*
   * The property that lets these rules be graded for a site whose entry page
   * could not be fetched at all: they read the certificate, the domain records
   * and robots.txt, and nothing else. Their fact type says so and the compiler
   * holds them to it — this is the same claim made at runtime, so a rule that
   * reached for a page through a cast or an `any` would be caught here too.
   *
   * Every page-level key is present and answers by throwing, so a rule that
   * touches one fails loudly instead of quietly reading undefined.
   */
  const facts = {
    ssl: { status: "unreachable", hostname: "example.com", certificate: null, trusted: null, problem: null, failure: "timeout", message: "No certificate was read." },
    dns: { hostname: "example.com", status: "error", a: { status: "error", records: [], error: "x" }, aaaa: { status: "error", records: [], error: "x" }, mx: { status: "error", records: [], error: "x" }, ns: { status: "error", records: [], error: "x" }, spf: { status: "error", record: null, error: "x" }, dmarc: { status: "error", record: null, error: "x" }, message: "Nothing was looked up." },
    technical: null,
  };

  const pageKeys = ["website", "fetch", "uptime", "responseTime", "seo", "performance", "security", "hosting", "timedOut"];
  const guarded = new Proxy(facts as Record<string, unknown>, {
    get(target, key) {
      if (typeof key === "string" && pageKeys.includes(key)) {
        throw new Error(`a site rule read the page measurement "${key}"`);
      }
      return target[key as string];
    },
  });

  for (const rule of SITE_RULES) {
    assert.doesNotThrow(
      () => rule.run(guarded as unknown as Parameters<typeof rule.run>[0]),
      `${rule.id} must read only site measurements`,
    );
  }
});
