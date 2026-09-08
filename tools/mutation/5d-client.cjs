/*
 * Mutation check for the Gemini key handling.
 *
 * Every patch is verified to have reached disk before its run is trusted.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const TARGET = "lib/ai/gemini/client.ts";
const original = fs.readFileSync(TARGET, "utf8");

const mutations = [
  {
    name: "a missing key is treated as configured",
    from: '  if (resolveKey(options) === "") return { configured: false, reason: NOT_CONFIGURED };',
    to: "  if (false) return { configured: false, reason: NOT_CONFIGURED };",
  },
  {
    name: "a missing key builds a client anyway",
    from: '  if (apiKey === "") return null;',
    to: "  if (false) return null;",
  },
  {
    name: "a blank key is not trimmed, so whitespace counts as configured",
    from: '  return (options.apiKey ?? process.env[GEMINI_API_KEY_VARIABLE] ?? "").trim();',
    to: '  return options.apiKey ?? process.env[GEMINI_API_KEY_VARIABLE] ?? "";',
  },
  {
    name: "the caller's own key is ignored in favour of the environment",
    from: "  return (options.apiKey ?? process.env[GEMINI_API_KEY_VARIABLE] ?? \"\").trim();",
    to: '  return (process.env[GEMINI_API_KEY_VARIABLE] ?? options.apiKey ?? "").trim();',
  },
  {
    name: "the loggable state carries the client",
    from: "  return { configured: true, model: GEMINI_MODEL };",
    to: "  return { configured: true, model: GEMINI_MODEL, client: geminiClient(options) } as GeminiAvailability;",
  },
  {
    name: "a blank key is handed to the SDK, which then prints about it",
    from: '  if (apiKey === "") return null;',
    to: '  if (apiKey === "NEVER-MATCHES") return null;',
  },
  {
    name: "a client is rebuilt for every call instead of reused",
    from: "  const existing = clients.get(apiKey);\n  if (existing !== undefined) return existing;",
    to: "",
  },
  {
    name: "every key shares one cached client",
    from: "  const existing = clients.get(apiKey);\n  if (existing !== undefined) return existing;",
    to: '  const existing = clients.get("any");\n  if (existing !== undefined) return existing;',
  },
  {
    name: "the missing-key reason stops saying the key is missing",
    from: "const NOT_CONFIGURED =\n  `No ${GEMINI_API_KEY_VARIABLE} is configured",
    to: "const NOT_CONFIGURED =\n  `Something about ${GEMINI_API_KEY_VARIABLE} went wrong",
  },
  {
    name: "the model reported is not the one configured",
    from: "  return { configured: true, model: GEMINI_MODEL };",
    to: '    : { configured: true, model: "gemini-something-else" };',
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
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "lib/ai/gemini/client.test.mts"',
      { stdio: "pipe" },
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
