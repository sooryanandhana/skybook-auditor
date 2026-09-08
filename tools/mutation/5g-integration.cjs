/*
 * Mutation check for the 5G integration.
 *
 * Three files carry the new invariants: the composition point, the store's
 * claim, and the route's whitelist projection. Every patch is verified to have
 * reached disk, and everything is restored whatever happens.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const JOB = "lib/audit/explainJob.ts";
const STORE = "lib/jobs/jobStore.ts";
const ROUTE = "lib/api/auditRoutes.ts";

const TESTS =
  '"lib/audit/explainJob.test.mts" "lib/jobs/jobStore.test.mts" "lib/api/auditRoutes.test.mts"';

const originals = Object.fromEntries(
  [JOB, STORE, ROUTE].map((f) => [f, fs.readFileSync(f, "utf8")]),
);

const mutations = [
  // ---- the composition point --------------------------------------------
  {
    file: JOB,
    name: "a stored answer is ignored, so every ask asks again",
    from: "  if (job.explanation !== null) {\n    return { ok: true, stored: true, result: job.explanation };\n  }",
    to: "",
  },
  {
    file: JOB,
    name: "the claim is not taken, so two callers both ask",
    from: '  if (!store.claimExplanation(jobId)) {\n    return { ok: false, reason: "in-progress" };\n  }',
    to: "  store.claimExplanation(jobId);",
  },
  {
    file: JOB,
    name: "the answer is never stored, so the next ask pays again",
    from: "  store.setExplanation(jobId, result);",
    to: "",
  },
  {
    file: JOB,
    name: "only successes are stored, so a failure is asked about forever",
    from: "  store.setExplanation(jobId, result);",
    to: '  if (result.state === "explained") store.setExplanation(jobId, result);',
  },
  {
    file: JOB,
    name: "the speed check is dropped on the way to the model",
    from: "  const whole = withSpeed(job.result, job.attached);",
    to: "  const whole = withSpeed(job.result, null);",
  },
  {
    file: JOB,
    name: "the model is shown the raw audit rather than the projection",
    from: "  const input = buildAIReportInput(whole);",
    to: "  const input = whole as unknown as ReturnType<typeof buildAIReportInput>;",
  },
  {
    file: JOB,
    name: "an unfinished or failed audit is written about anyway",
    from: '  if (!finished || job.result === null) {\n    return { ok: false, reason: "not-finished" };\n  }',
    to: "",
  },
  {
    file: JOB,
    name: "an unknown job is composed from nothing",
    from: '  if (job === null) return { ok: false, reason: "unknown-job" };',
    to: "  if (job === null) return { ok: false, reason: \"not-finished\" };",
  },

  // ---- the store ---------------------------------------------------------
  {
    file: STORE,
    name: "every caller wins the claim",
    from: "      if (job.explanationClaimed) return false;",
    to: "",
  },
  {
    file: STORE,
    name: "a claim is granted before the audit has finished",
    from: "      if (!isTerminal(job.status) || job.result === null) return false;\n      if (job.explanationClaimed) return false;",
    to: "      if (job.explanationClaimed) return false;",
  },
  {
    file: STORE,
    name: "a later explanation overwrites the first",
    from: "      if (job.explanation !== null) return;",
    to: "",
  },
  {
    file: STORE,
    name: "an explanation is stored against an unfinished job",
    from: "      if (!isTerminal(job.status) || job.result === null) return;\n      if (job.explanation !== null) return;",
    to: "      if (job.explanation !== null) return;",
  },
  {
    file: STORE,
    name: "storing an explanation clears the audit result",
    from: "      job.explanation = value;\n      touch(job);",
    to: "      job.explanation = value;\n      job.result = null;\n      touch(job);",
  },

  // ---- the route ---------------------------------------------------------
  {
    file: ROUTE,
    name: "the adapter's whole result is spread onto the wire",
    from: `      executiveSummary: result.explanations.executiveSummary,
      explanations: result.explanations.explanations.map((entry) => ({
        ruleId: entry.ruleId,
        explanation: entry.explanation,
        businessImpact: entry.businessImpact,
        recommendation: entry.recommendation,
      })),
      partial: result.partial,
      rejectedCount: result.rejected.length,`,
    to: `      executiveSummary: result.explanations.executiveSummary,
      explanations: result.explanations.explanations.map((entry) => ({ ...entry })),
      partial: result.partial,
      rejectedCount: result.rejected.length,
      ...({ rejected: result.rejected } as Record<string, never>),`,
  },
  {
    file: ROUTE,
    name: "the count of dropped explanations is always zero",
    from: "      rejectedCount: result.rejected.length,",
    to: "      rejectedCount: 0,",
  },
  {
    file: ROUTE,
    name: "a partial answer is reported as a whole one",
    from: "      partial: result.partial,",
    to: "      partial: false,",
  },
  {
    file: ROUTE,
    name: "a model that could not be reached reads as a broken endpoint",
    from: `    return {
      status: 200,
      body: { ok: true, jobId, state: "not-explained", reason: result.reason, message: result.message },
    };`,
    to: `    return {
      status: 500,
      body: { ok: false, jobId, error: result.message },
    };`,
  },
  {
    file: ROUTE,
    name: "a missing job id is answered rather than refused",
    from: '  if (jobId === "") return { status: 400, body: { ok: false, error: NO_JOB_ID } };\n\n  const outcome = await explainJob(jobId, store, deps);',
    to: "  const outcome = await explainJob(jobId, store, deps);",
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

  const mutated = original.replace(m.from, m.to);
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
    execSync(
      `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test-timeout=20000 --test ${TESTS}`,
      { stdio: "pipe", timeout: 180_000 },
    );
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
