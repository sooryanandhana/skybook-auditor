/**
 * The shape the model is allowed to answer in.
 *
 * A JSON Schema, built per audit, describing exactly `AIExplanationSet` and
 * nothing else. It is handed to the provider as the `config.responseJsonSchema`
 * of a single request, so the answer arrives already shaped rather than being
 * parsed out of prose.
 *
 * THIS IS A CONSTRAINT, NOT A CHECK. Everything here is enforced by somebody
 * else's server, on the other side of the network, on a code path this project
 * does not own and cannot test. The deterministic validator in
 * `../validateExplanations.ts` remains mandatory and unconditional: it runs on
 * every answer whether or not the provider claims to have enforced this. If
 * the two ever disagree the validator wins, because the validator is the one
 * that runs here.
 *
 * So the schema exists to make the good answer easy, not to make the bad one
 * impossible. Read every rule below as "this saves a round trip", never as
 * "this cannot happen".
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * The schema has no place to put a severity, a category, a score, a count, a
 * denominator, a measurement, a URL, a piece of evidence or a remediation.
 * That is the whole architecture in one object: deterministic code measures
 * and grades, and the model writes prose about what deterministic code already
 * decided. A field here would be an invitation to grade, and the invitation is
 * what has to be missing — a test asserts that none of those twelve names
 * appears anywhere in the generated schema, at any depth.
 */
import { AI_CONTRACT_VERSION, type AIReportInput } from "../contract.ts";

/**
 * A JSON Schema document, as the provider takes it.
 *
 * Loosely typed on purpose. The SDK's own parameter accepts `{[k: string]:
 * any}`, and inventing a precise TypeScript model of JSON Schema here would
 * describe our beliefs about the dialect rather than the dialect. What the
 * schema actually contains is asserted by tests against the built object.
 */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * The rule ids the model may write about, in the order they were found, with
 * repeats removed.
 *
 * FROM `findings` ONLY, NEVER FROM `notEvaluated`. A skipped rule is a rule
 * whose answer is not known; letting the model write about one would be asking
 * it to explain a measurement nobody took. The validator draws the same line,
 * and the two must not drift — a test pins them together.
 *
 * Duplicates are removed because a repeated id in an `enum` is meaningless to
 * the provider and misleading to a reader, and because the count of distinct
 * ids is what bounds the array below.
 */
export function explainableRuleIds(input: AIReportInput): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const finding of input.findings) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    ids.push(finding.ruleId);
  }
  return ids;
}

/**
 * The response schema for one audit.
 *
 * THE RULE IDS ARE THIS AUDIT'S, NOT THE REPOSITORY'S. The enum is built from
 * the findings actually present in this input. Listing every rule the project
 * can produce would hand the model a menu of plausible ids for checks that
 * were never run on this site, which is precisely the fabrication the
 * validator spends its time rejecting. Constraining it here means the common
 * case never reaches that rejection.
 *
 * WHEN THERE ARE NO FINDINGS the array is capped at zero items and the enum is
 * omitted entirely. An empty `enum` is not something the provider documents,
 * and JSON Schema itself only says such an array *should* be non-empty, so it
 * is a construct whose handling would be a guess. `maxItems: 0` needs no guess:
 * it says there is nothing to explain, using a keyword the provider documents.
 * A clean site still gets an executive summary, which is the honest answer.
 */
export function explanationSchema(input: AIReportInput): JsonSchema {
  const ruleIds = explainableRuleIds(input);

  /*
   * `enum` is documented for strings; `const` is not in the provider's list of
   * supported keywords, so the version is pinned as an enum of one.
   */
  const ruleIdSchema: JsonSchema =
    ruleIds.length === 0
      ? {
          type: "string",
          description: "Unused: this audit produced no findings to explain.",
        }
      : {
          type: "string",
          enum: [...ruleIds],
          description:
            "Identifies which of the supplied findings this entry is about. " +
            "Only the values listed here exist.",
        };

  const explanationItem: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["ruleId", "explanation", "businessImpact", "recommendation"],
    properties: {
      ruleId: ruleIdSchema,
      explanation: {
        type: "string",
        description:
          "Plain English, for a business owner who is not technical: what was " +
          "found.",
      },
      businessImpact: {
        type: "string",
        description: "Why it matters to the business.",
      },
      recommendation: {
        type: "string",
        description: "What to do about it, phrased for that same reader.",
      },
    },
  };

  /*
   * NO `minItems`. The model is not required to explain every finding, because
   * a floor on the count is a reason to invent one. Missing explanations are a
   * quality question answered by reading the report; invented ones are a
   * correctness question, and this is the side to err on.
   */
  return {
    type: "object",
    additionalProperties: false,
    required: ["version", "executiveSummary", "explanations"],
    properties: {
      version: {
        type: "string",
        enum: [AI_CONTRACT_VERSION],
        description: "Must be exactly this value.",
      },
      executiveSummary: {
        type: "string",
        description:
          "A short summary of the audit for the site owner, drawn only from " +
          "the supplied audit data.",
      },
      explanations: {
        type: "array",
        maxItems: ruleIds.length,
        items: explanationItem,
        description:
          ruleIds.length === 0
            ? "This audit produced no findings, so this array must be empty."
            : "At most one entry per finding. Never more than one per ruleId.",
      },
    },
  };
}
