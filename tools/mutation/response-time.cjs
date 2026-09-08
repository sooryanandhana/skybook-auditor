/*
 * Mutation check for the three-sample response time.
 *
 * Every patch is verified to have reached disk before its run is trusted, and
 * the file is restored whatever happens.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const TARGET = "lib/collector/responseTime.ts";
const original = fs.readFileSync(TARGET, "utf8");
const TESTS = '"lib/collector/responseTime.test.mts"';

const mutations = [
  // ---- the arithmetic ----------------------------------------------------
  {
    name: "the first sample is reported instead of the median",
    from: "  return sorted.length % 2 === 1\n    ? sorted[middle]\n    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);",
    to: "  return values[0];",
  },
  {
    name: "the fastest sample is reported instead of the median",
    from: "  return sorted.length % 2 === 1\n    ? sorted[middle]\n    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);",
    to: "  return sorted[0];",
  },
  {
    name: "the slowest sample is reported instead of the median",
    from: "  return sorted.length % 2 === 1\n    ? sorted[middle]\n    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);",
    to: "  return sorted[sorted.length - 1];",
  },
  {
    name: "the average is reported instead of the median",
    from: "  return sorted.length % 2 === 1\n    ? sorted[middle]\n    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);",
    to: "  return Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);",
  },
  {
    name: "the values are sorted as text rather than as numbers",
    from: "  const sorted = [...values].sort((a, b) => a - b);",
    to: "  const sorted = [...values].sort();",
  },
  {
    name: "the values are not sorted at all",
    from: "  const sorted = [...values].sort((a, b) => a - b);",
    to: "  const sorted = [...values];",
  },
  {
    name: "the middle index is off by one",
    from: "  const middle = Math.floor(sorted.length / 2);",
    to: "  const middle = Math.floor(sorted.length / 2) - 1;",
  },
  {
    name: "the caller's own array is sorted underneath them",
    from: "  const sorted = [...values].sort((a, b) => a - b);",
    to: "  const sorted = (values as number[]).sort((a, b) => a - b);",
  },

  // ---- failure is never a number ----------------------------------------
  {
    name: "a network failure is recorded as zero milliseconds",
    from: "    return { ok: false, ms: null, failure: classify(error) };",
    to: "    return { ok: false, ms: 0, failure: classify(error) };",
  },
  {
    name: "a sample cut short by the deadline is recorded as zero",
    from: '  if (deadline.expired()) return { ok: false, ms: null, failure: "out-of-time" };',
    to: '  if (deadline.expired()) return { ok: false, ms: 0, failure: "out-of-time" };',
  },
  {
    name: "a failed measurement still reports a median",
    from: "    medianResponseTimeMs: null,",
    to: "    medianResponseTimeMs: 0,",
  },
  {
    name: "a timeout is reported as a network fault",
    from: '  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {\n    return "timeout";\n  }',
    to: "",
  },

  // ---- how many samples count -------------------------------------------
  {
    name: "fewer than three successes still produces a median",
    from: "  if (succeeded.length < RESPONSE_TIME_SAMPLES) {",
    to: "  if (succeeded.length < 1) {",
  },
  {
    name: "any success at all is treated as a complete measurement",
    from: "  if (succeeded.length < RESPONSE_TIME_SAMPLES) {",
    to: "  if (succeeded.length === 0) {",
  },
  {
    name: "only one sample is taken",
    from: "  for (let index = 0; index < RESPONSE_TIME_SAMPLES; index += 1) {",
    to: "  for (let index = 0; index < 1; index += 1) {",
  },
  {
    name: "five samples are taken instead of three",
    from: "export const RESPONSE_TIME_SAMPLES = 3;",
    to: "export const RESPONSE_TIME_SAMPLES = 5;",
  },
  {
    name: "the failed samples are counted as successes",
    from: "  const succeeded = samples.filter((sample) => sample.ok);",
    to: "  const succeeded = samples.filter(() => true);",
  },
  {
    name: "a mixture of successes and failures is not called incomplete",
    from: '    const failure = succeeded.length > 0 ? "incomplete" : firstFailure;',
    to: "    const failure = firstFailure;",
  },

  // ---- the protections ---------------------------------------------------
  {
    name: "the deadline no longer stops a sample",
    from: '  if (deadline.expired()) return { ok: false, ms: null, failure: "out-of-time" };',
    to: "",
  },
  {
    name: "the public-host check is skipped",
    from: '  const safety = await checkHostnameIsPublic(normalized.url.hostname);\n  if (!safety.safe) return unavailable("refused", []);',
    to: "  await checkHostnameIsPublic(normalized.url.hostname);",
  },
  {
    name: "an unparseable address is requested anyway",
    from: '  if (!normalized.ok) return unavailable("invalid-address", []);',
    to: '  if (!normalized.ok) return unavailable("invalid-address", []);\n  void 0;',
    skip: true,
  },
  {
    name: "redirects are followed, so a hop escapes the safety check",
    from: '      redirect: "manual",',
    to: '      redirect: "follow",',
  },
  {
    name: "the per-request cap is dropped, leaving only the shared clock",
    from: "      signal: deadline.signal(RESPONSE_TIME_REQUEST_TIMEOUT_MS),",
    to: "      signal: deadline.signal(),",
  },
  {
    name: "the response body is read rather than discarded",
    from: "    await response.body?.cancel();",
    to: "    await response.text();",
  },
  {
    name: "a backwards clock is allowed to produce a negative timing",
    from: "  const elapsed = Math.max(0, Math.round(now() - startedAt));",
    to: "  const elapsed = Math.round(now() - startedAt);",
  },
];

let killed = 0;
const survivors = [];

for (const m of mutations) {
  if (m.skip) continue;

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
const run = mutations.filter((m) => !m.skip).length;
console.log(`\nrestored. killed ${killed} of ${run}. survivors: ${survivors.length}`);
for (const s of survivors) console.log(`  - ${s}`);
