/**
 * Controlled Gemini diagnostics, run by hand and never by the suite.
 *
 * NOT A TEST, AND DELIBERATELY OUTSIDE THE TEST GLOB. `npm test` runs
 * `lib/**\/*.test.mts`; this is `.diagnostic.mts` so a full suite run can never
 * spend a free-tier request by accident. It is run by hand, and a mode is
 * REQUIRED, so an invocation with no argument spends nothing:
 *
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts models
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts size-count
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts latency
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts boundary
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts schema-isolation 22
 *   node --env-file=.env.local lib/ai/gemini/modelComparison.diagnostic.mts schema-split
 *   node                       lib/ai/gemini/modelComparison.diagnostic.mts rehearse-split
 *   node                       lib/ai/gemini/modelComparison.diagnostic.mts sizes
 *
 * WHAT IS HELD CONSTANT IN EVERY MODE. The same `AIReportInput` shape, the same
 * system instruction, the same schema, the same single request with retries
 * off, and the same validator -- because all of that is reached through
 * `explainAudit`, exactly as production reaches it. No production file is
 * touched, and nothing here can change what production asks.
 *
 * THE BUDGET HERE IS NOT THE PRODUCTION BUDGET, and production is not changed
 * by this file or anything it does. A diagnostic that stopped where production
 * stops could only ever report "longer than 45 seconds", which is the thing
 * already known. This waits longer so a slow answer is TIMED rather than cut
 * off, and the measured time is then compared against 45.
 *
 * NOTHING FROM THE PROVIDER IS PRINTED. Not the key, not the prompt, not the
 * request, not an error object. `explainAudit` already reduces every failure to
 * one of our own named reasons, and that name is all this records.
 */
import { performance } from "node:perf_hooks";
import { ALL_RULES } from "../../rules/all.ts";
import { MAX_EVIDENCE_LENGTH, type AIReportInput } from "../contract.ts";
import { explainAudit, type GeminiRequestClient } from "./explain.ts";
import { geminiClient } from "./client.ts";
import { explanationSchema, type JsonSchema } from "./schema.ts";
import { reportInput } from "./testInput.fixture.mts";

/** The model in production. Read from config so this cannot drift from it. */
import { GEMINI_MODEL } from "./config.ts";

/** The lighter comparator. Used only by the `models` mode. Never written to config. */
const FLASH_LITE = "gemini-3.5-flash-lite";

/**
 * How long one request is allowed, for measurement only.
 *
 * The same 120 seconds every earlier diagnostic used, which is what makes a new
 * reading comparable with an old one. Production is unchanged at 45.
 */
const DIAGNOSTIC_TIMEOUT_MS = 120_000;

/** The production budget, quoted here only to judge a measured time against it. */
const PRODUCTION_BUDGET_MS = 45_000;

// ---------------------------------------------------------------------------
// The inputs
// ---------------------------------------------------------------------------

/**
 * The evidence sentence every earlier run used, at its natural length.
 *
 * ITS LENGTH IS LOAD-BEARING. 215 characters is what produced the recorded
 * 20,261 / 24,540 / 29,241 byte inputs, and the size experiments below are
 * defined as departures from it. Changing this string changes every baseline
 * this file can be compared against.
 */
const EVIDENCE = {
  base:
    "Measured on the audited pages: the check named by this rule did not pass. " +
    "The value read from the page was recorded and compared against the fixed " +
    "threshold this rule declares, and it fell on the failing side of it.",
  /** Appended when a longer payload is wanted. Says nothing new; it is bulk. */
  filler:
    " The measurement is reproducible and was taken during the crawl that " +
    "produced this report, on each page the rule applies to, and it is " +
    "recorded beside the page it came from.",
} as const;

/**
 * Evidence text of an exact length, by trimming or padding the same sentence.
 *
 * ONLY THE LENGTH CHANGES. Rule ids, titles, categories, severities and scopes
 * are untouched by this, which is the whole point of the size experiments: one
 * variable moves and everything that carries meaning stays put.
 *
 * Capped at the contract's own limit, so a padded input is still one production
 * could actually produce. Beyond it, `buildReportInput` would have clamped the
 * text and marked it truncated, and this would be measuring a request the
 * application cannot send.
 */
function evidenceOf(length: number): string {
  if (length > MAX_EVIDENCE_LENGTH) {
    throw new Error(`evidence of ${length} exceeds the contract's ${MAX_EVIDENCE_LENGTH}`);
  }

  const grown =
    EVIDENCE.base +
    EVIDENCE.filler.repeat(
      Math.ceil(Math.max(0, length - EVIDENCE.base.length) / EVIDENCE.filler.length),
    );

  return grown.slice(0, length);
}

/**
 * Findings built from the real compiled rules.
 *
 * REAL IDS, TITLES, CATEGORIES AND SEVERITIES, taken from the rules engine
 * rather than invented, because the schema's enum is built from the ids and the
 * validator checks every explanation against them. Made-up ids would be a
 * different request from the one production sends.
 *
 * The evidence and the remediation are written here, because a rule's wording
 * for those is produced by running it against a measurement this file does not
 * have.
 *
 * SOME OF THESE CANNOT CO-OCCUR on a real site -- a metric cannot be both slow
 * and merely needing improvement. That is stated rather than hidden. The
 * question being asked is how many findings a request may carry, not whether
 * this particular website is plausible.
 */
function findingsFor(count: number, evidenceLength: number): AIReportInput["findings"] {
  const rules = ALL_RULES.slice(0, count);
  if (rules.length < count) {
    throw new Error(`only ${rules.length} rules exist; ${count} were asked for`);
  }

  const text = evidenceOf(evidenceLength);
  const evidence = { text, truncated: false, originalLength: text.length };

  return rules.map((rule, index) => ({
    ruleId: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    evidence,
    remediation:
      "Correct the condition this rule describes, then re-run the audit to " +
      "confirm the finding no longer fires.",
    scope: rule.scope,
    reach:
      rule.scope === "page"
        ? {
            affectedCount: 2 + (index % 9),
            evaluatedPages: 12,
            samples: [{ url: `https://example.com/page-${index + 1}`, evidence }],
            sampleTruncated: true,
          }
        : null,
  })) as AIReportInput["findings"];
}

/** One audit input. Identical for every model it is sent to. */
function inputFor(count: number, evidenceLength = EVIDENCE.base.length): AIReportInput {
  return reportInput({ findings: findingsFor(count, evidenceLength) });
}

const inputBytes = (input: AIReportInput) => JSON.stringify(input).length;
const schemaBytes = (input: AIReportInput) => JSON.stringify(explanationSchema(input)).length;

/**
 * The evidence length that brings a given finding count nearest a byte target.
 *
 * SEARCHED LOCALLY AND SPENDS NOTHING. It serialises candidate inputs in
 * memory; no request is made until a case is actually run.
 */
function evidenceLengthFor(count: number, targetBytes: number): number {
  let low = 1;
  let high = MAX_EVIDENCE_LENGTH;
  let best = { length: EVIDENCE.base.length, bytes: Number.MAX_SAFE_INTEGER };

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const bytes = inputBytes(inputFor(count, middle));

    if (Math.abs(bytes - targetBytes) < Math.abs(best.bytes - targetBytes)) {
      best = { length: middle, bytes };
    }
    if (bytes < targetBytes) low = middle + 1;
    else high = middle - 1;
  }

  return best.length;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * The real client, with the model rewritten on the way past.
 *
 * THIS IS THE WHOLE OF THE SUBSTITUTION. `explainAudit` builds its request
 * through the production prompt builder, which stamps the production model on
 * it; this replaces that one string immediately before the SDK sees it and
 * changes nothing else. It exists here rather than as a parameter on the
 * production builder so that production has no way to ask for a model other
 * than the configured one.
 */
function asModel(real: GeminiRequestClient, model: string): GeminiRequestClient {
  return {
    models: {
      generateContent: (params) => real.models.generateContent({ ...params, model }),
    },
  };
}

/**
 * The same client again, with the response schema swapped for another input's.
 *
 * WHY THIS IS THE ONLY HONEST WAY TO ASK THE QUESTION. The schema is built from
 * the findings, so every experiment so far has moved the finding count and the
 * schema's list of rule ids together and cannot tell them apart. This sends the
 * model twenty real findings while asking it to answer against a schema listing
 * more ids than that, which is a combination production can never produce and
 * is exactly why it belongs here and nowhere else.
 *
 * PRODUCTION'S OWN SCHEMA BUILDER MAKES BOTH. Nothing about how a schema is
 * constructed is changed or re-implemented; a schema built for one input is
 * simply attached to a request carrying another.
 */
function withSchema(
  real: GeminiRequestClient,
  model: string,
  schema: JsonSchema,
): GeminiRequestClient {
  return {
    models: {
      generateContent: (params) =>
        real.models.generateContent({
          ...params,
          model,
          config: { ...params.config, responseJsonSchema: schema },
        }),
    },
  };
}

/** The schema production would build for another input, attached unaltered. */
function withSchemaOf(
  real: GeminiRequestClient,
  model: string,
  donor: AIReportInput,
): GeminiRequestClient {
  return withSchema(real, model, explanationSchema(donor));
}

/**
 * The failing schema with its item cap put back to the passing one's.
 *
 * TWO PROPERTIES MOVE TOGETHER in everything the production builder produces,
 * because it derives both from one list: the cap on how many explanations may
 * be returned, and the enumeration of ids one may name. This takes the schema
 * that is refused and lowers only the cap, leaving the longer enumeration in
 * place, which is the single request that tells them apart.
 *
 * THE BUILDER IS NOT CHANGED OR RE-IMPLEMENTED. Its output is copied and one
 * number in the copy is overwritten. Production has no path to this object.
 */
function cappedAt(donor: AIReportInput, maxItems: number): JsonSchema {
  const copy = structuredClone(explanationSchema(donor)) as {
    properties: { explanations: { maxItems: number } };
  };

  copy.properties.explanations.maxItems = maxItems;
  return copy as JsonSchema;
}

/** What a schema actually declares, read back off the object that will be sent. */
function schemaShape(schema: JsonSchema): { maxItems: number; enumEntries: number } {
  const read = schema as {
    properties: {
      explanations: {
        maxItems: number;
        items: { properties: { ruleId: { enum?: readonly string[] } } };
      };
    };
  };

  return {
    maxItems: read.properties.explanations.maxItems,
    enumEntries: read.properties.explanations.items.properties.ruleId.enum?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

interface CaseResult {
  readonly test: string;
  readonly model: string;
  readonly findings: number;
  readonly inputBytes: number;
  readonly schemaBytes: number;
  /** Read back off the object that was actually sent, never from what was meant. */
  readonly maxItems: number;
  readonly enumEntries: number;
  readonly responded: boolean;
  readonly elapsedMs: number;
  readonly validatorPassed: boolean;
  readonly accepted: number;
  readonly rejected: number;
  /** One of our own failure names, never a provider message. */
  readonly category: string;
}

async function runCase(
  client: GeminiRequestClient,
  test: string,
  model: string,
  input: AIReportInput,
  /**
   * The input whose schema is attached, when it is not this one's.
   *
   * Only the schema-isolation mode passes this. Everywhere else the request is
   * exactly what production would build.
   */
  schemaDonor?: AIReportInput,
  /** A schema built here rather than from an input. Only the split mode passes one. */
  schemaOverride?: JsonSchema,
  /**
   * A stand-in key, so a rehearsal against a fake client needs no real one.
   *
   * `explainAudit` answers "is a key configured?" before it builds anything, so
   * a rehearsal with no key would return `no-api-key` without ever reaching the
   * client -- and would prove nothing about the request. Every live mode leaves
   * this undefined and the environment's key is used.
   */
  apiKey?: string,
): Promise<CaseResult> {
  const attached =
    schemaOverride ?? explanationSchema(schemaDonor ?? input);
  const shape = schemaShape(attached);

  const shared = {
    test,
    model,
    findings: input.findings.length,
    inputBytes: inputBytes(input),
    schemaBytes: JSON.stringify(attached).length,
    maxItems: shape.maxItems,
    enumEntries: shape.enumEntries,
  };

  const startedAt = performance.now();
  const outcome = await explainAudit(input, {
    apiKey,
    client:
      schemaOverride !== undefined
        ? withSchema(client, model, schemaOverride)
        : schemaDonor === undefined
          ? asModel(client, model)
          : withSchemaOf(client, model, schemaDonor),
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (outcome.state === "explained") {
    return {
      ...shared,
      responded: true,
      elapsedMs,
      validatorPassed: true,
      accepted: outcome.explanations.explanations.length,
      rejected: outcome.rejected.length,
      category: outcome.partial ? "partial" : "complete",
    };
  }

  /*
   * A provider refusal and a reply our own validator threw out are different
   * failures and are reported as different failures. "unreadable-response" and
   * "refused" mean an answer arrived; the rest mean one did not.
   */
  const answered = outcome.reason === "unreadable-response" || outcome.reason === "refused";

  return {
    ...shared,
    responded: answered,
    elapsedMs,
    validatorPassed: false,
    accepted: 0,
    rejected: 0,
    category: outcome.reason,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const cell = (value: string | number, width: number) => String(value).padEnd(width);

const HEAD = [
  cell("test", 14),
  cell("model", 22),
  cell("findings", 9),
  cell("input", 8),
  cell("schema", 7),
  cell("maxItems", 9),
  cell("enum", 6),
  cell("response", 9),
  cell("time", 8),
  cell("validator", 10),
  cell("accepted", 9),
  cell("rejected", 9),
  "result",
].join(" ");

function row(result: CaseResult): string {
  return [
    cell(result.test, 14),
    cell(result.model, 22),
    cell(result.findings, 9),
    cell(result.inputBytes, 8),
    cell(result.schemaBytes, 7),
    cell(result.maxItems, 9),
    cell(result.enumEntries, 6),
    cell(result.responded ? "yes" : "no", 9),
    cell(`${(result.elapsedMs / 1000).toFixed(1)}s`, 8),
    cell(result.validatorPassed ? "passed" : "-", 10),
    cell(result.accepted, 9),
    cell(result.rejected, 9),
    result.category,
  ].join(" ");
}

/** Min, max, mean and median of a set of readings, in seconds. */
function spread(secondsList: readonly number[]): string {
  const sorted = [...secondsList].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];

  return (
    `n=${sorted.length}  min ${sorted[0].toFixed(1)}s  max ${sorted[sorted.length - 1].toFixed(1)}s  ` +
    `mean ${mean.toFixed(1)}s  median ${median.toFixed(1)}s`
  );
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** Sizes only. Spends nothing, and says so. */
function printSizes(): void {
  console.log("No request is made in this mode.");
  console.log("");
  for (const count of [20, 25, 30]) {
    const input = inputFor(count);
    console.log(
      `${cell(count, 4)} findings   input ${cell(inputBytes(input), 8)} schema ${schemaBytes(input)}`,
    );
  }
  console.log("");
  const shrunk = evidenceLengthFor(25, 20_261);
  const grown = evidenceLengthFor(20, 24_540);
  console.log(`A: 25 findings at evidence ${shrunk} chars -> ${inputBytes(inputFor(25, shrunk))} bytes`);
  console.log(`B: 20 findings at evidence ${grown} chars -> ${inputBytes(inputFor(20, grown))} bytes`);
}

/**
 * Two models, three finding counts. Six requests.
 *
 * ALREADY ANSWERED on 10 September: both models were refused at 25 and 30 on
 * identical inputs, so the refusal boundary is not the model's. Kept because a
 * result is only worth as much as the ability to reproduce it, not because it
 * needs running again.
 */
async function runModels(client: GeminiRequestClient): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (const count of [20, 25, 30]) {
    for (const model of [GEMINI_MODEL, FLASH_LITE]) {
      const result = await runCase(client, "models", model, inputFor(count));
      results.push(result);
      console.log(row(result));
    }
  }

  return results;
}

/**
 * Size against count. Two requests, production model only.
 *
 * THE ONE VARIABLE THAT MOVES IS SIZE. Both cases carry real rules with their
 * real ids, titles, categories, severities and scopes; only the length of the
 * evidence text differs, and it stays inside the contract's own cap in both.
 *
 *   A  25 findings shrunk to the byte size of the request that SUCCEEDED
 *   B  20 findings grown to the byte size of the request that was REFUSED
 *
 * A succeeding and B failing points at size. A failing and B succeeding points
 * at the count or the schema. Both failing or both succeeding means size alone
 * does not explain it.
 */
async function runSizeCount(client: GeminiRequestClient): Promise<CaseResult[]> {
  const smallEvidence = evidenceLengthFor(25, 20_261);
  const largeEvidence = evidenceLengthFor(20, 24_540);

  const cases = [
    { test: "A small-25", input: inputFor(25, smallEvidence) },
    { test: "B large-20", input: inputFor(20, largeEvidence) },
  ];

  const results: CaseResult[] = [];
  for (const one of cases) {
    const result = await runCase(client, one.test, GEMINI_MODEL, one.input);
    results.push(result);
    console.log(row(result));
  }

  return results;
}

/**
 * The 20-finding case again, three times, on the production model.
 *
 * THE PAYLOAD IS NOT TOUCHED. It is the same input that produced 36.6 seconds
 * on 10 September, byte for byte at 20,261, so the readings form one set rather
 * than four unrelated numbers.
 */
async function runLatency(client: GeminiRequestClient): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runCase(client, `latency ${attempt}`, GEMINI_MODEL, inputFor(20));
    results.push(result);
    console.log(row(result));
  }

  /*
   * Combined with the reading already taken on the SAME input. September's
   * 50.7 seconds is deliberately not folded in here: its payload is not known
   * to have been this one, and averaging it in would state a precision the
   * evidence does not have.
   */
  const sameInput = [36.6, ...results.map((r) => r.elapsedMs / 1000)];
  console.log("");
  console.log(`20-finding readings on the identical ${results[0]?.inputBytes ?? 0}-byte input:`);
  console.log(`  ${spread(sameInput)}`);
  console.log(`  production budget ${PRODUCTION_BUDGET_MS / 1000}s`);
  console.log(`  readings over the budget: ${sameInput.filter((s) => s * 1000 > PRODUCTION_BUDGET_MS).length} of ${sameInput.length}`);

  return results;
}

/**
 * Where the refusal starts, by halving the gap rather than walking it.
 *
 * 20 IS KNOWN TO SUCCEED AND 25 IS KNOWN TO FAIL, both reproducibly and at two
 * different payload sizes, so only 21 to 24 is unknown. Halving that settles it
 * in at most three requests where walking it takes four, and a refusal comes
 * back in under two seconds so the cost sits almost entirely in the successes.
 *
 * EVERY OTHER VARIABLE IS PINNED. Production model, production prompt,
 * production schema construction, retries off, and the same 215-character
 * evidence every earlier run used.
 */
async function runBoundary(client: GeminiRequestClient): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  let low = 21;
  let high = 24;
  /** 25 until something smaller is shown to fail. */
  let firstFailing = 25;

  while (low <= high && results.length < 4) {
    const count = Math.floor((low + high) / 2);
    const result = await runCase(client, `boundary ${count}`, GEMINI_MODEL, inputFor(count));
    results.push(result);
    console.log(row(result));

    if (result.responded) low = count + 1;
    else {
      firstFailing = count;
      high = count - 1;
    }
  }

  console.log("");
  console.log(`last succeeding finding count: ${firstFailing - 1}`);
  console.log(`first failing finding count:   ${firstFailing}`);

  return results;
}

/**
 * Twenty findings, asked against a schema listing more rule ids than that.
 *
 * THE ONE SPLIT NOTHING ELSE CAN MAKE. Up to here the finding count and the
 * schema's id list have moved together in every request, so "too many findings"
 * and "too many ids in the schema" fit the evidence equally well. This holds the
 * findings at twenty and moves only the schema.
 *
 * A REFUSAL means the schema, or something scaling with it, is the constraint.
 * AN ANSWER means the schema is not, and the finding count or the size of the
 * answer being asked for is.
 *
 * THE VALIDATOR RESULT IS SECONDARY HERE. The schema offers ids this audit does
 * not contain, so an answer naming one would be dropped -- correctly, and by
 * the production validator. What is being measured is whether the request is
 * accepted at all.
 */
async function runSchemaIsolation(client: GeminiRequestClient, ids: number): Promise<CaseResult[]> {
  const result = await runCase(
    client,
    `schema-${ids}`,
    GEMINI_MODEL,
    inputFor(20),
    inputFor(ids),
  );

  console.log(row(result));
  console.log("");
  console.log(`findings presented: 20   rule ids in the schema: ${ids}`);

  return [result];
}

/**
 * The last pair, split: twenty-one ids offered, twenty explanations allowed.
 *
 * WHAT THIS SEPARATES. Every request so far has moved the item cap and the id
 * enumeration together, so "at most twenty explanations" and "at most twenty
 * ids" fit the evidence identically. This lowers the cap alone and leaves the
 * longer enumeration standing.
 *
 * ACCEPTED means the cap was the limit. REFUSED means the enumeration was.
 *
 * THE INPUT IS THE ONE THAT SUCCEEDS, byte for byte, so nothing about the audit
 * being described has changed between this request and the accepted one.
 */
async function runSchemaSplit(client: GeminiRequestClient): Promise<CaseResult[]> {
  const result = await runCase(
    client,
    "split-21/20",
    GEMINI_MODEL,
    inputFor(20),
    undefined,
    cappedAt(inputFor(21), 20),
  );

  console.log(row(result));
  console.log("");
  console.log("findings presented: 20   ids offered: 21   explanations allowed: 20");

  return [result];
}

/**
 * The split request, sent to a client that answers from memory.
 *
 * SPENDS NOTHING AND PROVES THE THING WORTH PROVING: that the object reaching
 * the wire is the one intended. A substitution that silently failed would spend
 * a request to measure the request it was meant to replace.
 */
async function rehearseSplit(): Promise<void> {
  interface Sent {
    readonly model?: string;
    readonly contents?: string;
    readonly config?: { readonly responseJsonSchema?: JsonSchema };
  }

  /* An array rather than a variable: a `let` written only inside a callback is
     narrowed to `never` by the compiler, which is not what is happening. */
  const seen: Sent[] = [];

  const fake: GeminiRequestClient = {
    models: {
      generateContent: async (params) => {
        seen.push(params as Sent);
        return { text: "{}" };
      },
    },
  };

  await runCase(
    fake,
    "rehearsal",
    GEMINI_MODEL,
    inputFor(20),
    undefined,
    cappedAt(inputFor(21), 20),
    "rehearsal-not-a-real-key",
  );

  const sent = seen[0];
  if (sent === undefined) throw new Error("the request never reached the client");

  const shape = schemaShape(sent.config?.responseJsonSchema ?? {});
  const findings = (JSON.parse(sent.contents ?? "{}") as AIReportInput).findings.length;

  console.log("No request was made in this mode.");
  console.log("");
  console.log(`model on the request:        ${sent.model}`);
  console.log(`findings in the request:     ${findings}`);
  console.log(`schema maxItems:             ${shape.maxItems}`);
  console.log(`schema enum entries:         ${shape.enumEntries}`);
  console.log("");
  console.log(
    shape.maxItems === 20 && shape.enumEntries === 21 && findings === 20
      ? "The intended schema is what reaches the request."
      : "MISMATCH — do not spend a request on this.",
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const MODES = [
  "models",
  "size-count",
  "latency",
  "boundary",
  "schema-isolation",
  "schema-split",
  "rehearse-split",
  "sizes",
] as const;
type Mode = (typeof MODES)[number];

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;

  /*
   * A MODE IS REQUIRED. Every live mode spends free-tier requests, and a
   * default that ran one would be a default that spends them by accident.
   */
  if (mode === undefined || !MODES.includes(mode)) {
    console.log(`Give a mode: ${MODES.join(", ")}. Nothing was asked and nothing was spent.`);
    process.exitCode = 1;
    return;
  }

  if (mode === "sizes") {
    printSizes();
    return;
  }

  if (mode === "rehearse-split") {
    await rehearseSplit();
    return;
  }

  const client = geminiClient();
  if (client === null) {
    console.log("No key is configured, so nothing was asked. Nothing was spent.");
    process.exitCode = 1;
    return;
  }

  console.log(`mode:             ${mode}`);
  console.log(`production model: ${GEMINI_MODEL}`);
  console.log(`diagnostic wait:  ${DIAGNOSTIC_TIMEOUT_MS / 1000}s (production stays at ${PRODUCTION_BUDGET_MS / 1000}s)`);
  console.log("");
  console.log(HEAD);

  let results: CaseResult[];
  if (mode === "models") results = await runModels(client);
  else if (mode === "size-count") results = await runSizeCount(client);
  else if (mode === "latency") results = await runLatency(client);
  else if (mode === "boundary") results = await runBoundary(client);
  else if (mode === "schema-split") results = await runSchemaSplit(client);
  else {
    /*
     * The id count is given on the command line rather than assumed, so this
     * mode cannot silently keep testing a number that stopped being the
     * boundary.
     */
    const ids = Number(process.argv[3]);
    if (!Number.isInteger(ids) || ids < 21 || ids > ALL_RULES.length) {
      console.log(`Give the schema id count, 21 to ${ALL_RULES.length}. Nothing was spent.`);
      process.exitCode = 1;
      return;
    }
    results = await runSchemaIsolation(client, ids);
  }

  console.log("");
  console.log(`requests spent: ${results.length}`);
}

await main();
