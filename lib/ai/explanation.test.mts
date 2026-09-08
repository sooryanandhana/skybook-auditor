/**
 * Tests for the only thing an AI provider is allowed to send back.
 *
 * WHAT IS BEING PROTECTED IS AN ABSENCE, which is harder to test than a
 * presence and matters more. The safety of this boundary rests on the answer
 * having nowhere to put a severity, a count or a denominator — so the thing to
 * catch is somebody adding one, years from now, for a reason that will seem
 * good at the time.
 *
 * TWO LAYERS, AND THE FIRST IS THE REAL ONE.
 *
 * The compile-time assertions below fail `tsc`, not this suite. Adding
 * `severity` to either type makes the project stop building, which is a much
 * blunter instrument than a red test and cannot be argued with.
 *
 * The source checks that follow exist because a compile-time guard can be
 * deleted in the same commit that breaks it. They read the declaration itself,
 * the way this project already tests that the crawler performs no HTTP of its
 * own, so removing the guard and adding the field is two visible edits rather
 * than one.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import type { AIExplanation, AIExplanationSet } from "./explanation.ts";

/** The declaration itself, comments stripped, as the other structural tests read it. */
function declaration(): string {
  return fs
    .readFileSync(new URL("./explanation.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one exported interface, comments already stripped. */
function bodyOf(name: string): string {
  const body = declaration().match(
    new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(body, `${name} should be declared in explanation.ts`);
  return body[1];
}

/** The field names in one exported interface, in declaration order. */
function fieldsOf(name: string): string[] {
  return [...bodyOf(name).matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*:/gm)].map(
    (match) => match[1],
  );
}

/**
 * Every property name declared in an interface, AT ANY DEPTH.
 *
 * `fieldsOf` reads the top level, and so does `keyof`. Neither sees a name
 * buried one level down, which is how `detail: { severity: string }` slipped
 * past both guards when this file was re-checked: TypeScript accepted it
 * outright, and only the exact-field-list test objected — to the wrapper, not
 * to what was inside it. Somebody adding a legitimate field would have updated
 * that list as a matter of course and carried the forbidden name in with it.
 */
function allPropertyNames(name: string): string[] {
  return [...bodyOf(name).matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*:/g)].map(
    (match) => match[1],
  );
}

/**
 * Every name that would hand an answer authority over the audit.
 *
 * Each one is a thing the deterministic engine decided before a model was
 * asked anything. A field here would not merely duplicate it — it would create
 * a second copy that could disagree, and nothing downstream would know which
 * to believe.
 */
type ForbiddenField =
  | "severity"
  | "category"
  | "score"
  | "count"
  | "affectedCount"
  | "evaluatedPages"
  | "denominator"
  | "measurement"
  | "metric"
  | "url"
  | "evidence"
  | "remediation";

const FORBIDDEN: readonly ForbiddenField[] = [
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
];

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** True only when no forbidden name is a key of `T`. */
type CarriesNoAuthority<T> = Extract<keyof T, ForbiddenField> extends never ? true : false;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

test("an answer carries a version, an opening and one entry per finding", () => {
  assert.deepEqual(fieldsOf("AIExplanationSet"), [
    "version",
    "executiveSummary",
    "explanations",
  ]);
});

test("an explanation is four pieces of writing and a rule id", () => {
  assert.deepEqual(fieldsOf("AIExplanation"), [
    "ruleId",
    "explanation",
    "businessImpact",
    "recommendation",
  ]);
});

test("the executive summary is required, so a provider cannot quietly stop writing one", () => {
  assert.match(declaration(), /readonly executiveSummary: string;/);
  assert.doesNotMatch(declaration(), /executiveSummary\?/);
});

test("the rule id is the join, and it is a plain identifier", () => {
  // An explanation attaches to a finding by the rule that produced it, never
  // by matching on a title. A returned id naming nothing is droppable.
  assert.match(declaration(), /readonly ruleId: string;/);
});

// ---------------------------------------------------------------------------
// The absence
// ---------------------------------------------------------------------------

test("neither type has a key that would carry authority over the audit", () => {
  /*
   * THE COMPILE-TIME CHECK. These two lines are the actual guarantee: if
   * `severity` ever becomes a key of either type, `Assert<false>` is not
   * satisfiable and `tsc` refuses the project. The assertion below only
   * consumes the values so nothing is unused — it is not what proves this.
   */
  const explanationIsClean: Assert<CarriesNoAuthority<AIExplanation>> = true;
  const setIsClean: Assert<CarriesNoAuthority<AIExplanationSet>> = true;

  assert.ok(explanationIsClean && setIsClean);
});

test("no forbidden name is declared anywhere in either type, at any depth", () => {
  /*
   * The guard for the guard, and the one that reaches deeper than the type
   * system does here. Two things it catches that the compile-time check
   * cannot: an assertion deleted in the same commit that breaks it, and a
   * forbidden name nested inside an otherwise innocent field, which `keyof`
   * never sees.
   */
  const declared = new Set([
    ...allPropertyNames("AIExplanationSet"),
    ...allPropertyNames("AIExplanation"),
  ]);

  for (const name of FORBIDDEN) {
    assert.ok(!declared.has(name), `${name} is decided by the engine, never by an answer`);
  }
});

test("the forbidden list still names things the deterministic result owns", () => {
  /*
   * Guards the list itself against being quietly emptied. Each of these is a
   * real field on the deterministic side of the boundary, so a list that no
   * longer mentions them has stopped describing anything.
   */
  for (const name of ["severity", "affectedCount", "evaluatedPages", "evidence", "remediation"]) {
    assert.ok(
      (FORBIDDEN as readonly string[]).includes(name),
      `${name} must stay on the forbidden list`,
    );
  }
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test("the contract names no provider and imports no SDK", () => {
  const source = declaration();

  for (const provider of ["gemini", "@google/genai", "anthropic", "openai", "@ai-sdk"]) {
    assert.ok(!source.toLowerCase().includes(provider), `${provider} must not appear here`);
  }
  // The only import it may have is the contract's own version type.
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./contract.ts"]);
});
