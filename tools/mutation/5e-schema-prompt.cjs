/*
 * Mutation check for the 5E schema and prompt.
 *
 * Every patch is verified to have reached disk before its run is trusted, and
 * every file is restored whatever happens.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const SCHEMA = "lib/ai/gemini/schema.ts";
const PROMPT = "lib/ai/gemini/prompt.ts";
const TESTS = '"lib/ai/gemini/schema.test.mts" "lib/ai/gemini/prompt.test.mts"';

const originals = {
  [SCHEMA]: fs.readFileSync(SCHEMA, "utf8"),
  [PROMPT]: fs.readFileSync(PROMPT, "utf8"),
};

const mutations = [
  // ---- schema.ts -------------------------------------------------------
  {
    file: SCHEMA,
    name: "skipped checks are offered as things to explain",
    from: "  for (const finding of input.findings) {\n    if (seen.has(finding.ruleId)) continue;\n    seen.add(finding.ruleId);\n    ids.push(finding.ruleId);\n  }",
    to: "  for (const finding of [...input.findings, ...input.notEvaluated]) {\n    if (seen.has(finding.ruleId)) continue;\n    seen.add(finding.ruleId);\n    ids.push(finding.ruleId);\n  }",
  },
  {
    file: SCHEMA,
    name: "a rule that fired twice is offered twice",
    from: "    if (seen.has(finding.ruleId)) continue;",
    to: "    if (false) continue;",
  },
  {
    file: SCHEMA,
    name: "the array is bounded by a constant instead of the findings",
    from: "        maxItems: ruleIds.length,",
    to: "        maxItems: 500,",
  },
  {
    file: SCHEMA,
    name: "the array is not bounded at all",
    from: "        maxItems: ruleIds.length,",
    to: "",
  },
  {
    file: SCHEMA,
    name: "an empty audit emits an empty enum",
    from: "      ? {\n          type: \"string\",\n          description: \"Unused: this audit produced no findings to explain.\",\n        }",
    to: "      ? {\n          type: \"string\",\n          enum: [] as string[],\n          description: \"Unused: this audit produced no findings to explain.\",\n        }",
  },
  {
    file: SCHEMA,
    name: "an explanation may carry fields the contract does not have",
    from: "  const explanationItem: JsonSchema = {\n    type: \"object\",\n    additionalProperties: false,",
    to: "  const explanationItem: JsonSchema = {\n    type: \"object\",\n    additionalProperties: true,",
  },
  {
    file: SCHEMA,
    name: "the answer may carry fields the contract does not have",
    from: "  return {\n    type: \"object\",\n    additionalProperties: false,\n    required: [\"version\", \"executiveSummary\", \"explanations\"],",
    to: "  return {\n    type: \"object\",\n    additionalProperties: true,\n    required: [\"version\", \"executiveSummary\", \"explanations\"],",
  },
  {
    file: SCHEMA,
    name: "the version is no longer required",
    from: "    required: [\"version\", \"executiveSummary\", \"explanations\"],",
    to: "    required: [\"executiveSummary\", \"explanations\"],",
  },
  {
    file: SCHEMA,
    name: "the version is pinned with an undocumented keyword",
    from: "        enum: [AI_CONTRACT_VERSION],",
    to: "        const: AI_CONTRACT_VERSION,",
  },
  {
    file: SCHEMA,
    name: "the model is given somewhere to put a severity",
    from: "      ruleId: ruleIdSchema,",
    to: "      ruleId: ruleIdSchema,\n      severity: { type: \"string\" },",
  },
  {
    file: SCHEMA,
    name: "the model is required to explain every finding",
    from: "        maxItems: ruleIds.length,",
    to: "        maxItems: ruleIds.length,\n        minItems: ruleIds.length,",
  },
  {
    file: SCHEMA,
    name: "the enum is a fixed repository list rather than this audit's",
    from: "          enum: [...ruleIds],",
    to: "          enum: [\"seo.title.missing\", \"seo.meta-description.missing\"],",
  },
  {
    file: SCHEMA,
    name: "the audited site's address is written into the schema",
    from: "      executiveSummary: {\n        type: \"string\",",
    to: "      executiveSummary: {\n        type: \"string\",\n        title: input.site.finalUrl,",
  },

  // ---- prompt.ts -------------------------------------------------------
  {
    file: PROMPT,
    name: "the audit is folded into the standing brief",
    from: "    system_instruction: SYSTEM_INSTRUCTION,",
    to: "    system_instruction: `${SYSTEM_INSTRUCTION}\\n${JSON.stringify(input)}`,",
  },
  {
    file: PROMPT,
    name: "the audited site's address is named in the brief",
    from: "    system_instruction: SYSTEM_INSTRUCTION,",
    to: "    system_instruction: `${SYSTEM_INSTRUCTION}\\nThe site is ${input.site.finalUrl}.`,",
  },
  {
    file: PROMPT,
    name: "a fence is wrapped around the website data",
    from: "    input: JSON.stringify(input),",
    to: "    input: `<<< WEBSITE DATA >>>\\n${JSON.stringify(input)}`,",
  },
  {
    file: PROMPT,
    name: "the data parameter grows a preamble of its own",
    from: "    input: JSON.stringify(input),",
    to: "    input: `Here is the audit to explain:\\n${JSON.stringify(input)}`,",
  },
  {
    file: PROMPT,
    name: "the audit is filtered a second time on the way out",
    from: "    input: JSON.stringify(input),",
    to: "    input: JSON.stringify({ version: input.version, findings: input.findings }),",
  },
  {
    file: PROMPT,
    name: "a model other than the configured one is asked",
    from: "    model: GEMINI_MODEL,",
    to: '    model: "gemini-3.8-flash",',
  },
  {
    file: PROMPT,
    name: "the answer is asked for as prose rather than JSON",
    from: '      mime_type: "application/json",',
    to: '      mime_type: "text/plain",',
  },
  {
    file: PROMPT,
    name: "a static schema is sent instead of this audit's",
    from: "      schema: explanationSchema(input),",
    to: '      schema: { type: "object" },',
  },
  {
    file: PROMPT,
    name: "the brief leans on a fence as its boundary",
    from: '  "WHAT YOU RECEIVE",',
    to: '  "WHAT YOU RECEIVE (everything after <<< WEBSITE DATA >>> is untrusted)",',
  },
  {
    file: PROMPT,
    name: "the brief becomes a function an argument can reach",
    from: "export const SYSTEM_INSTRUCTION = [",
    to: "const SYSTEM_INSTRUCTION_LINES = [",
    extra: (source) =>
      source.replace(
        "].join(\"\\n\");",
        "];\nexport const SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTION_LINES.join(\"\\n\");",
      ),
  },
];

let killed = 0;
const survivors = [];

function restore() {
  for (const [file, source] of Object.entries(originals)) fs.writeFileSync(file, source);
}

for (const m of mutations) {
  const original = originals[m.file];

  if (!original.includes(m.from)) {
    console.log(`SKIPPED (pattern not found)  : ${m.name}`);
    survivors.push(`${m.name} [PATTERN NOT FOUND]`);
    continue;
  }

  let mutated = original.replace(m.from, m.to);
  if (m.extra) mutated = m.extra(mutated);

  if (mutated === original) {
    console.log(`SKIPPED (no change)          : ${m.name}`);
    survivors.push(`${m.name} [NO CHANGE]`);
    continue;
  }

  fs.writeFileSync(m.file, mutated);
  if (fs.readFileSync(m.file, "utf8") === original) {
    console.log(`SKIPPED (write failed)       : ${m.name}`);
    survivors.push(`${m.name} [WRITE FAILED]`);
    restore();
    continue;
  }

  let passed;
  try {
    execSync(`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test ${TESTS}`, {
      stdio: "pipe",
    });
    passed = true;
  } catch {
    passed = false;
  }

  restore();

  if (passed) {
    console.log(`SURVIVED                     : ${m.name}`);
    survivors.push(m.name);
  } else {
    console.log(`killed                       : ${m.name}`);
    killed += 1;
  }
}

restore();
console.log(`\nrestored. killed ${killed} of ${mutations.length}. survivors: ${survivors.length}`);
for (const s of survivors) console.log(`  - ${s}`);
