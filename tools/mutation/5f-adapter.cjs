/*
 * Mutation check for the Gemini adapter.
 *
 * Every patch is verified to have reached disk before its run is trusted, and
 * the file is restored whatever happens. A test timeout counts as a kill: a
 * mutant that makes the suite hang has been detected by it.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const TARGET = "lib/ai/gemini/explain.ts";
const original = fs.readFileSync(TARGET, "utf8");
const TESTS = '"lib/ai/gemini/explain.test.mts"';

const mutations = [
  {
    name: "the SDK is allowed to retry, so one call becomes five",
    from: '        retries: { strategy: "none" },',
    to: "",
  },
  {
    name: "the request is given no deadline",
    from: "        timeout_ms: options.timeoutMs ?? AI_EXPLANATION_BUDGET_MS,",
    to: "",
  },
  {
    name: "the AI request spends the audit's budget instead of its own",
    from: "        timeout_ms: options.timeoutMs ?? AI_EXPLANATION_BUDGET_MS,",
    to: "        timeout_ms: 30_000,",
  },
  {
    name: "a missing key no longer stops the request",
    from: "    if (!availability.configured || client === null) {",
    to: "    if (false) {",
  },
  {
    name: "the key check looks only at the client, so an injected one bypasses it",
    from: "    if (!availability.configured || client === null) {",
    to: "    if (client === null) {",
  },
  {
    name: "the validator is skipped and the model's own object is returned",
    from: "    const checked = validateExplanations(input, candidate);\n    if (!checked.ok) return notExplained(\"refused\", checked.reason);",
    to: "    const checked = { ok: true, accepted: candidate, rejected: [] } as unknown as ReturnType<typeof validateExplanations> & { ok: true };",
  },
  {
    name: "the answer is validated against an audit it did not come from",
    from: "    const checked = validateExplanations(input, candidate);",
    to: "    const checked = validateExplanations({ ...input, findings: [] }, candidate);",
  },
  {
    name: "dropped explanations are hidden rather than reported",
    from: "      rejected: checked.rejected,",
    to: "      rejected: [],",
  },
  {
    name: "a partial answer is reported as a whole one",
    from: "      partial: checked.rejected.length > 0,",
    to: "      partial: false,",
  },
  {
    name: "every answer is reported as partial",
    from: "      partial: checked.rejected.length > 0,",
    to: "      partial: true,",
  },
  {
    name: "unparseable text is retried instead of refused",
    from: '      return notExplained("unreadable-response");',
    to: "      response = await client.interactions.create(request, { retries: { strategy: \"none\" } });\n      return notExplained(\"unreadable-response\");",
  },
  {
    name: "a failed request is tried a second time",
    from: "      return notExplained(classify(error));",
    to: "      try {\n        response = await client.interactions.create(request, { retries: { strategy: \"none\" } });\n      } catch {\n        return notExplained(classify(error));\n      }",
  },
  {
    name: "an empty answer is treated as text",
    from: '  if (typeof text !== "string" || text.trim() === "") return null;',
    to: '  if (typeof text !== "string") return null;',
  },
  {
    name: "a non-string output is stringified rather than refused",
    from: '  if (typeof text !== "string" || text.trim() === "") return null;',
    to: "  if (text === undefined || text === null) return null;\n  return String(text);",
  },
  {
    name: "every provider error is called a network failure",
    from: '  if (name.includes("Timeout") || name === "AbortError" || name === "TimeoutError") return "timeout";',
    to: '  if (true) return "network";',
  },
  {
    name: "a rate limit is reported as a fault of the provider's",
    from: '  if (status === 429) return "rate-limited";',
    to: "",
  },
  {
    name: "a rejected key is reported as a bad request",
    from: '  if (status === 401 || status === 403) return "not-authorised";',
    to: "",
  },
  {
    name: "a timeout is reported as a network failure",
    from: '  if (name.includes("Timeout") || name === "AbortError" || name === "TimeoutError") return "timeout";',
    to: "",
  },
  {
    name: "an unreadable body is reported as a bad request",
    from: '  if (status === 200) return "unreadable-response";',
    to: "",
  },
  {
    name: "an unrecognised error is confidently blamed on the network",
    from: '  return "internal-error";\n}',
    to: '  return "network";\n}',
  },
  {
    name: "the audit is edited on its way to the model",
    from: "    const request = buildExplanationRequest(input);",
    to: "    const request = buildExplanationRequest({ ...input, findings: [...input.findings].reverse() });",
  },
  {
    name: "a fault in this code escapes as an exception",
    from: "  } catch {\n    /*",
    to: "  } catch (thrown) {\n    if (thrown) throw thrown;\n    /*",
  },
];

let killed = 0;
const survivors = [];

for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`SKIPPED (pattern not found)  : ${m.name}`);
    survivors.push(`${m.name} [PATTERN NOT FOUND]`);
    continue;
  }

  const mutated = original.replace(m.from, m.to);
  if (mutated === original) {
    console.log(`SKIPPED (no change)          : ${m.name}`);
    survivors.push(`${m.name} [NO CHANGE]`);
    continue;
  }

  fs.writeFileSync(TARGET, mutated);
  if (fs.readFileSync(TARGET, "utf8") === original) {
    console.log(`SKIPPED (write failed)       : ${m.name}`);
    survivors.push(`${m.name} [WRITE FAILED]`);
    fs.writeFileSync(TARGET, original);
    continue;
  }

  let passed;
  try {
    execSync(
      `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test-timeout=20000 --test ${TESTS}`,
      { stdio: "pipe", timeout: 120_000 },
    );
    passed = true;
  } catch {
    passed = false;
  }

  fs.writeFileSync(TARGET, original);

  if (passed) {
    console.log(`SURVIVED                     : ${m.name}`);
    survivors.push(m.name);
  } else {
    console.log(`killed                       : ${m.name}`);
    killed += 1;
  }
}

fs.writeFileSync(TARGET, original);
console.log(`\nrestored. killed ${killed} of ${mutations.length}. survivors: ${survivors.length}`);
for (const s of survivors) console.log(`  - ${s}`);
