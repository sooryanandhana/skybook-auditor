/*
 * Mutation check for the deterministic AI response validator.
 *
 * Each mutation removes or weakens one safety check. Every patch is verified to
 * have reached disk before its run is trusted, because a pattern that silently
 * fails to match reports "survived" and looks exactly like a test gap.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const TARGET = "lib/ai/validateExplanations.ts";
const original = fs.readFileSync(TARGET, "utf8");

const mutations = [
  // --- version --------------------------------------------------------------
  {
    name: "the contract version is not checked",
    from: "  if (candidate.version !== AI_CONTRACT_VERSION || candidate.version !== input.version) {",
    to: "  if (false) {",
  },
  {
    name: "only our own version is checked, not the input's",
    from: "  if (candidate.version !== AI_CONTRACT_VERSION || candidate.version !== input.version) {",
    to: "  if (typeof candidate.version !== \"string\") {",
  },

  // --- shape ----------------------------------------------------------------
  {
    name: "anything at all is accepted as an answer",
    from: '  if (!isPlainObject(candidate)) return { ok: false, reason: "the answer is not an object" };',
    to: '  if (false) return { ok: false, reason: "the answer is not an object" };',
  },
  {
    name: "an array counts as an object",
    from: '  return typeof value === "object" && value !== null && !Array.isArray(value);',
    to: '  return typeof value === "object" && value !== null;',
  },
  {
    name: "extra fields on an entry are ignored instead of refused",
    from: "  const extra = unexpectedKey(entry, ALLOWED_EXPLANATION_KEYS);\n  if (extra !== null) {",
    to: "  const extra = unexpectedKey(entry, ALLOWED_EXPLANATION_KEYS);\n  if (false) {",
  },
  {
    name: "extra fields on the answer are ignored instead of refused",
    from: "  const extra = unexpectedKey(candidate, ALLOWED_SET_KEYS);\n  if (extra !== null) return",
    to: "  const extra = unexpectedKey(candidate, ALLOWED_SET_KEYS);\n  if (false) return",
  },
  {
    name: "the explanations need not be a list",
    from: "  if (!Array.isArray(candidate.explanations)) {",
    to: "  if (false) {",
  },
  {
    name: "an answer of any size is walked",
    from: "  if (candidate.explanations.length > MAX_CANDIDATE_EXPLANATIONS) {",
    to: "  if (false) {",
  },

  // --- strings --------------------------------------------------------------
  {
    name: "empty writing is accepted",
    from: '  if (trimmed === "") return null;',
    to: '  if (false) return null;',
  },
  {
    name: "writing of any length is accepted",
    from: "  if (value.length > limit) return null;",
    to: "  if (false) return null;",
  },
  {
    name: "a non-string is accepted as writing",
    from: '  if (typeof value !== "string") return null;',
    to: '  if (typeof value === "number") return null;',
  },
  {
    name: "the summary is not required",
    from: "  if (executiveSummary === null) {",
    to: "  if (false) {",
  },
  {
    name: "only one of the three pieces of writing is checked",
    from: "  for (const field of PROSE_FIELDS) {\n    if (readableText(entry[field], MAX_EXPLANATION_LENGTH) === null) {",
    to: "  for (const field of PROSE_FIELDS.slice(0, 1)) {\n    if (readableText(entry[field], MAX_EXPLANATION_LENGTH) === null) {",
  },
  {
    name: "the rule id may be blank",
    from: "  const ruleId = readableText(entry.ruleId, 200);\n  if (ruleId === null)",
    to: "  const ruleId = String(entry.ruleId ?? \"\");\n  if (false)",
  },

  // --- rule identity --------------------------------------------------------
  {
    name: "any rule id is accepted",
    from: "  if (!gradedRules.has(ruleId)) {",
    to: "  if (false) {",
  },
  {
    name: "a check that did not run may be explained",
    from: "  const gradedRules = new Set(input.findings.map((finding) => finding.ruleId));",
    to: "  const gradedRules = new Set([\n    ...input.findings.map((finding) => finding.ruleId),\n    ...input.notEvaluated.map((check) => check.ruleId),\n  ]);",
  },

  // --- duplicates -----------------------------------------------------------
  {
    name: "a rule explained twice keeps both",
    from: "    if (claimedId !== null && (seen.get(claimedId) ?? 0) > 1) {",
    to: "    if (false) {",
  },
  {
    name: "a rule explained twice keeps the first",
    from: "    if (claimedId !== null && (seen.get(claimedId) ?? 0) > 1) {",
    to: "    if (claimedId !== null && (seen.get(claimedId) ?? 0) > 1 && accepted.some((e) => e.ruleId === claimedId)) {",
  },

  // --- addresses ------------------------------------------------------------
  {
    name: "addresses in an explanation are not checked",
    from: "  for (const field of PROSE_FIELDS) {\n    const stray = unmeasuredAddress(String(entry[field]), allowedAddresses);",
    to: "  for (const field of [] as string[]) {\n    const stray = unmeasuredAddress(String(entry[field]), allowedAddresses);",
  },
  {
    name: "addresses in the summary are not checked",
    from: "  if (summaryStray !== null) {",
    to: "  if (false) {",
  },
  {
    name: "any address on a measured hostname is trusted",
    from: "  return addressesIn(text).find((url) => !allowed.has(url)) ?? null;",
    to: "  return addressesIn(text).find((url) => ![...allowed].some((a) => { try { return new URL(a).hostname === new URL(url).hostname; } catch { return false; } })) ?? null;",
  },
  {
    name: "the sampled pages are not part of the trusted set",
    from: "  for (const finding of input.findings) {\n    for (const sample of finding.reach?.samples ?? []) add(sample.url);\n  }",
    to: "",
  },
  {
    name: "trailing punctuation is left on, so a real address is refused",
    from: "  return tokens.map((token) => token.replace(/[.,;:!?]+$/, \"\"));",
    to: "  return tokens;",
  },

  // --- immutability and output ----------------------------------------------
  {
    name: "the accepted entry is the candidate's own object",
    from: "    const valid = entry as Record<string, string>;\n    accepted.push({",
    to: "    const valid = entry as Record<string, string>;\n    accepted.push(entry as never); if (false) accepted.push({",
  },
  {
    name: "an unusable answer returns an empty set instead of a refusal",
    from: '  if (!Array.isArray(candidate.explanations)) {\n    return { ok: false, reason: "the answer must carry a list of explanations" };',
    to: '  if (!Array.isArray(candidate.explanations)) {\n    return { ok: true, accepted: { version: AI_CONTRACT_VERSION, executiveSummary, explanations: [] }, rejected: [] };',
  },
  {
    name: "an invalid entry takes the whole answer with it",
    from: "    if (reason !== null) {\n      rejected.push({ ruleId: claimedId, reason });\n      continue;\n    }",
    to: '    if (reason !== null) {\n      return { ok: false, reason };\n    }',
  },
  {
    name: "a throwing candidate escapes instead of being refused",
    from: '    return { ok: false, reason: "the answer could not be read" };',
    to: '    throw new Error("unreadable");',
  },
  {
    name: "the site's own two addresses are not trusted",
    from: "  add(input.site.requestedUrl);\n  add(input.site.finalUrl);",
    to: "",
  },
  {
    name: "a rejection reason quotes the candidate's text in full",
    from: "  return value.length <= MAX_REASON_QUOTE ? value : `${value.slice(0, MAX_REASON_QUOTE)}...`;",
    to: "  return value;",
  },
  {
    name: "the duplicated rule id is reported in full",
    from: "        ruleId: forReason(claimedId),",
    to: "        ruleId: claimedId,",
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
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "lib/ai/validateExplanations.test.mts"',
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
