/**
 * Where the website's words are allowed to go.
 *
 * The fixture these run against carries an attack in its page title and its
 * first heading, because a fixture of polite data would prove only that polite
 * data stays put.
 *
 * None of this proves a model obeys the instruction. Nothing can, from here.
 * What it proves is that the standing brief and the audited site's text never
 * share a parameter, that the brief is the same text for every audit, and that
 * the request this project hands over is the shape the provider's own types
 * describe.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import type { GenerateContentParameters } from "@google/genai";
import { SYSTEM_INSTRUCTION, buildExplanationRequest } from "./prompt.ts";
import { GEMINI_MODEL } from "./config.ts";
import { type AIReportInput } from "../contract.ts";
import { FIXTURE_RULE_IDS, HOSTILE, reportInput } from "./testInput.fixture.mts";

/**
 * The request is what the SDK's own parameter type says a `generateContent`
 * call is.
 *
 * A COMPILE-TIME ASSERTION, checked by `next build` rather than by running
 * this file -- the test runner strips types and would not notice. If the SDK
 * renames `systemInstruction`, or stops taking a schema this way, this line
 * stops compiling, which is the point. It is written as an assignment because
 * assignability is the property that matters at the call site.
 */
const API_SHAPED: GenerateContentParameters = buildExplanationRequest(reportInput());

// ---------------------------------------------------------------------------
// The brief carries no website
// ---------------------------------------------------------------------------

test("the standing brief contains nothing from any audit", () => {
  for (const fragment of [
    HOSTILE,
    "example.com",
    "attacker@evil.example",
    "cloudflare",
    ...FIXTURE_RULE_IDS,
  ]) {
    assert.ok(
      !SYSTEM_INSTRUCTION.includes(fragment),
      `the brief carries "${fragment}", which came off an audited website`,
    );
  }
});

test("the brief holds no serialised audit data of any kind", () => {
  // A JSON object anywhere in the brief would mean an input had been folded in.
  assert.ok(!SYSTEM_INSTRUCTION.includes('{"'), "the brief contains serialised JSON");
  assert.ok(!SYSTEM_INSTRUCTION.includes("https://"), "the brief names an address");
});

test("the brief is one fixed text, identical for every audit ever run", () => {
  const hostile = buildExplanationRequest(reportInput());
  const clean = buildExplanationRequest(reportInput({ findings: [] } as Partial<AIReportInput>));

  assert.equal(hostile.config.systemInstruction, SYSTEM_INSTRUCTION);
  assert.equal(clean.config.systemInstruction, SYSTEM_INSTRUCTION);
});

test("no function can reach the brief, because there is no function", () => {
  const source = fs.readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");
  const declaration = source.slice(source.indexOf("export const SYSTEM_INSTRUCTION"));

  assert.ok(
    declaration.startsWith("export const SYSTEM_INSTRUCTION = ["),
    "the brief must be a module constant, so no argument can reach it",
  );
});

// ---------------------------------------------------------------------------
// The website goes in one parameter and stays there
// ---------------------------------------------------------------------------

test("the site's own words reach the data parameter and nowhere else", () => {
  const request = buildExplanationRequest(reportInput());

  assert.ok(request.contents.includes(HOSTILE), "the audit data must arrive intact");
  assert.ok(!request.config.systemInstruction.includes(HOSTILE));
  assert.ok(!JSON.stringify(request.config).includes(HOSTILE));
  assert.ok(!request.model.includes(HOSTILE));
});

test("the data parameter is the serialisation and nothing wrapped around it", () => {
  const input = reportInput();
  const request = buildExplanationRequest(input);

  // No preamble, no label, no closing sentence: nothing a page title could
  // imitate, because there is nothing there to imitate.
  assert.equal(request.contents, JSON.stringify(input));
  assert.ok(request.contents.startsWith("{"));
  assert.ok(request.contents.endsWith("}"));
});

test("no delimiter is used as the boundary", () => {
  const request = buildExplanationRequest(reportInput());
  const whole = `${request.config.systemInstruction}\n${request.contents}`;

  for (const fence of ["<<<", ">>>", "```", "###", "---BEGIN", "[SYSTEM]"]) {
    assert.ok(
      !request.config.systemInstruction.includes(fence),
      `the brief leans on "${fence}" as a fence, which a page title can type`,
    );
  }
  assert.ok(whole.length > 0);
});

test("the audit reaches the model whole, not filtered a second time", () => {
  const input = reportInput();

  assert.deepEqual(JSON.parse(buildExplanationRequest(input).contents), JSON.parse(JSON.stringify(input)));
});

test("building a request changes nothing about the audit", () => {
  const input = reportInput();
  const before = JSON.stringify(input);

  buildExplanationRequest(input);

  assert.equal(JSON.stringify(input), before);
});

// ---------------------------------------------------------------------------
// The rest of the request
// ---------------------------------------------------------------------------

test("the request names the configured model and asks for JSON", () => {
  const request = buildExplanationRequest(reportInput());

  assert.equal(request.model, GEMINI_MODEL);
  assert.equal(request.config.responseMimeType, "application/json");
});

test("the schema sent is the one built for this audit", () => {
  const request = buildExplanationRequest(reportInput());
  const explanations = (request.config.responseJsonSchema as Record<string, Record<string, Record<string, unknown>>>)
    .properties.explanations;

  assert.equal(explanations.maxItems, FIXTURE_RULE_IDS.length);
});

test("a clean audit and a failing one differ in the schema, never in the brief", () => {
  const hostile = buildExplanationRequest(reportInput());
  const clean = buildExplanationRequest(reportInput({ findings: [] } as Partial<AIReportInput>));

  assert.equal(hostile.config.systemInstruction, clean.config.systemInstruction);
  assert.notDeepEqual(hostile.config.responseJsonSchema, clean.config.responseJsonSchema);
});

test("the request is the shape the provider's own types describe", () => {
  // The assertion is the declaration above; this checks it was actually built.
  assert.equal(API_SHAPED.model, GEMINI_MODEL);
  assert.equal(typeof API_SHAPED.config?.systemInstruction, "string");
});

// ---------------------------------------------------------------------------
// Nothing here talks to anybody
// ---------------------------------------------------------------------------

test("neither module imports a client, a key or the network", () => {
  for (const file of ["./prompt.ts", "./schema.ts"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");

    assert.ok(!source.includes("GoogleGenAI"), `${file} constructs a client`);
    assert.ok(!source.includes("geminiClient"), `${file} reaches for a client`);
    assert.ok(!source.includes("GEMINI_API_KEY"), `${file} touches the key`);
    assert.ok(!/\bfetch\s*\(/.test(source), `${file} makes a request`);
    assert.ok(!source.includes("await "), `${file} does something asynchronous`);
  }
});
