/**
 * What the response schema is allowed to contain, and what it must not.
 *
 * These are structural tests. Nothing here proves the provider honours the
 * schema -- that happens on somebody else's server and is the reason the
 * deterministic validator is not optional. What they prove is that the object
 * this project sends describes the contract and only the contract, carries no
 * field through which a model could grade anything, and contains no word the
 * audited website wrote.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { explainableRuleIds, explanationSchema } from "./schema.ts";
import { AI_CONTRACT_VERSION, type AIReportInput } from "../contract.ts";
import { FIXTURE_RULE_IDS, HOSTILE, reportInput } from "./testInput.fixture.mts";

/**
 * The twelve names the outbound contract must never grow, copied from the
 * contract's own test so the two lists are visibly the same list.
 *
 * A field named any of these would let a model state a severity, a count or a
 * measurement, which is the one thing this architecture exists to prevent.
 */
const FORBIDDEN = [
  "severity",
  "category",
  "score",
  "count",
  "affectedCount",
  "evaluatedPages",
  "denominator",
  "measurement",
  "metric",
  "url",
  "evidence",
  "remediation",
] as const;

/**
 * Every schema keyword the provider documents as supported, read from Google's
 * structured-output page on 8 September 2026.
 *
 * `const`, `$ref` and `$defs` are absent from that page and so are absent from
 * this list. That is why the contract version is pinned with an enum of one
 * rather than a `const`.
 */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "format",
  "minimum",
  "maximum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "anyOf",
]);

type Json = Record<string, unknown>;

/** Every subschema in the document, the root included. */
function subschemas(node: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(node)) {
    for (const child of node) subschemas(child, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;

  const record = node as Json;
  if (typeof record.type === "string" || record.properties !== undefined) found.push(record);

  for (const [key, value] of Object.entries(record)) {
    // Under `properties` the keys are field names, not keywords; recurse into
    // the values only, so a field called `type` is not read as a keyword.
    if (key === "properties") {
      for (const child of Object.values(value as Json)) subschemas(child, found);
    } else {
      subschemas(value, found);
    }
  }
  return found;
}

/** Every property name declared anywhere in the document. */
function propertyNames(node: unknown, names: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) propertyNames(child, names);
    return names;
  }
  if (node === null || typeof node !== "object") return names;

  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      names.push(...Object.keys(value as Json));
    }
    propertyNames(value, names);
  }
  return names;
}

const schema = () => explanationSchema(reportInput()) as Json;
const props = (node: unknown) => (node as Json).properties as Json;

// ---------------------------------------------------------------------------
// The shape it describes
// ---------------------------------------------------------------------------

test("the schema describes exactly the three fields of the outbound contract", () => {
  const root = schema();

  assert.equal(root.type, "object");
  assert.equal(root.additionalProperties, false);
  assert.deepEqual(Object.keys(props(root)).sort(), [
    "executiveSummary",
    "explanations",
    "version",
  ]);
  assert.deepEqual([...(root.required as string[])].sort(), [
    "executiveSummary",
    "explanations",
    "version",
  ]);
});

test("an explanation describes exactly its four fields and requires all of them", () => {
  const item = props(schema()).explanations as Json;
  const entry = item.items as Json;

  assert.equal(entry.type, "object");
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(Object.keys(props(entry)).sort(), [
    "businessImpact",
    "explanation",
    "recommendation",
    "ruleId",
  ]);
  assert.deepEqual([...(entry.required as string[])].sort(), [
    "businessImpact",
    "explanation",
    "recommendation",
    "ruleId",
  ]);
});

test("every object in the schema is closed to fields it did not declare", () => {
  for (const node of subschemas(schema())) {
    if (node.type !== "object") continue;
    assert.equal(
      node.additionalProperties,
      false,
      `an object in the schema accepts undeclared fields: ${JSON.stringify(node).slice(0, 120)}`,
    );
  }
});

test("the contract version is pinned to this project's version", () => {
  const version = props(schema()).version as Json;

  assert.deepEqual(version.enum, [AI_CONTRACT_VERSION]);
  assert.equal(version.const, undefined, "const is not a documented keyword");
});

// ---------------------------------------------------------------------------
// The rule ids are this audit's
// ---------------------------------------------------------------------------

test("the rule ids offered are the ones this audit actually found", () => {
  const ruleId = props((props(schema()).explanations as Json).items) as Json;

  assert.deepEqual((ruleId.ruleId as Json).enum, [...FIXTURE_RULE_IDS]);
});

test("a check that did not run is not offered as something to explain", () => {
  const input = reportInput();
  const enumerated = (
    props((props(explanationSchema(input) as Json).explanations as Json).items).ruleId as Json
  ).enum as string[];

  assert.ok(input.notEvaluated.length > 0, "the fixture must carry a skipped check");
  for (const skipped of input.notEvaluated) {
    assert.ok(
      !enumerated.includes(skipped.ruleId),
      `"${skipped.ruleId}" did not run, so it must not be offered`,
    );
  }
});

test("the ids come from the input, not from a list of every rule in the project", () => {
  const invented = reportInput({
    findings: [
      { ...reportInput().findings[0], ruleId: "rule.that.exists.nowhere.in.this.repository" },
    ],
  } as Partial<AIReportInput>);

  const enumerated = (
    props((props(explanationSchema(invented) as Json).explanations as Json).items).ruleId as Json
  ).enum as string[];

  assert.deepEqual(enumerated, ["rule.that.exists.nowhere.in.this.repository"]);
});

test("a rule that fired twice is offered once, and bounds the array once", () => {
  const first = reportInput().findings[0];
  const twice = reportInput({ findings: [first, { ...first }] } as Partial<AIReportInput>);

  assert.deepEqual(explainableRuleIds(twice), [first.ruleId]);

  const explanations = props(explanationSchema(twice) as Json).explanations as Json;
  assert.equal(explanations.maxItems, 1);
});

test("the array cannot hold more explanations than there are findings", () => {
  const input = reportInput();
  const explanations = props(explanationSchema(input) as Json).explanations as Json;

  assert.equal(explanations.maxItems, explainableRuleIds(input).length);
  assert.equal(explanations.maxItems, input.findings.length);
});

test("nothing is required to be explained, so nothing has to be invented", () => {
  const explanations = props(schema()).explanations as Json;

  assert.equal(explanations.minItems, undefined);
});

// ---------------------------------------------------------------------------
// The clean site
// ---------------------------------------------------------------------------

test("an audit with no findings permits a summary and no explanations at all", () => {
  const clean = explanationSchema(reportInput({ findings: [] } as Partial<AIReportInput>)) as Json;
  const explanations = props(clean).explanations as Json;

  assert.equal(explanations.maxItems, 0);
  assert.ok(props(clean).executiveSummary, "a clean site still gets a summary");
});

test("no empty enum is ever emitted, at any depth", () => {
  const clean = explanationSchema(reportInput({ findings: [] } as Partial<AIReportInput>));

  for (const document of [schema(), clean]) {
    for (const node of subschemas(document)) {
      if (node.enum === undefined) continue;
      assert.ok(Array.isArray(node.enum), "an enum must be an array");
      assert.ok(
        (node.enum as unknown[]).length > 0,
        "an empty enum is not documented by the provider and matches nothing",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// What must not be in there
// ---------------------------------------------------------------------------

test("no field a model could grade with appears anywhere in the schema", () => {
  const serialised = JSON.stringify(schema()).toLowerCase();

  for (const name of FORBIDDEN) {
    assert.ok(
      !serialised.includes(name.toLowerCase()),
      `"${name}" appears in the schema; a model must never state one`,
    );
  }
});

test("the same absence holds for the empty audit", () => {
  const clean = JSON.stringify(
    explanationSchema(reportInput({ findings: [] } as Partial<AIReportInput>)),
  ).toLowerCase();

  for (const name of FORBIDDEN) {
    assert.ok(!clean.includes(name.toLowerCase()), `"${name}" appears in the empty schema`);
  }
});

test("nothing the audited website wrote reaches the schema", () => {
  const serialised = JSON.stringify(schema());

  assert.ok(!serialised.includes(HOSTILE), "the site's own title reached the schema");
  assert.ok(!serialised.includes("example.com"), "a measured hostname reached the schema");
  assert.ok(!serialised.includes("attacker@evil.example"), "a measured address reached the schema");
});

test("the schema uses only keywords the provider documents", () => {
  for (const node of subschemas(schema())) {
    for (const keyword of Object.keys(node)) {
      assert.ok(
        SUPPORTED_KEYWORDS.has(keyword),
        `"${keyword}" is not in the provider's documented keyword list`,
      );
    }
  }
});

test("the schema survives the trip it is about to make", () => {
  const round = JSON.parse(JSON.stringify(schema()));

  assert.deepEqual(round, schema());
  assert.ok(!JSON.stringify(schema()).includes("undefined"));
});

// ---------------------------------------------------------------------------
// The list of forbidden names is the contract's list
// ---------------------------------------------------------------------------

test("the forbidden names here are the ones the contract's own test forbids", () => {
  const source = fs.readFileSync(new URL("../explanation.test.mts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const FORBIDDEN"));
  const listed = [...block.slice(0, block.indexOf("];")).matchAll(/"([a-zA-Z]+)"/g)].map(
    (match) => match[1],
  );

  assert.deepEqual([...listed].sort(), [...FORBIDDEN].sort());
});

test("the ids offered are drawn from findings and never from skipped checks", () => {
  const input = reportInput();
  const ids = explainableRuleIds(input);

  assert.deepEqual(ids, input.findings.map((finding) => finding.ruleId));
  assert.equal(propertyNames(explanationSchema(input)).includes("ruleId"), true);
});
