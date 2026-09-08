/*
 * Mutation check for 5A: joining the speed check onto the audit.
 *
 * Each mutation is verified to have reached disk before its run is trusted.
 */
const fs = require("fs");
const { execSync } = require("child_process");

const files = {
  join: "lib/audit/withSpeed.ts",
  store: "lib/jobs/jobStore.ts",
  route: "lib/api/auditRoutes.ts",
};
const original = Object.fromEntries(
  Object.entries(files).map(([k, p]) => [k, fs.readFileSync(p, "utf8")]),
);
const restore = () => {
  for (const [k, p] of Object.entries(files)) fs.writeFileSync(p, original[k]);
};

const mutations = [
  // --- the join is honest about reach ------------------------------------
  {
    file: "join",
    name: "a speed finding borrows the crawl's denominator",
    from: "          evaluatedPages: 1,",
    to: "          evaluatedPages: 128,",
  },
  {
    file: "join",
    name: "a speed finding claims to affect more than the page measured",
    from: "          affectedCount: 1,",
    to: "          affectedCount: 99,",
  },
  {
    file: "join",
    name: "scope is assumed rather than read from the rule",
    from: '  const scope = SPEED_RULES.find((rule) => rule.id === finding.id)?.scope;',
    to: '  const scope = "page" as const;',
  },
  {
    file: "join",
    name: "the reach fields are dropped entirely",
    from: "  return { ...finding, scope, ...reach };",
    to: "  return { ...finding, scope };",
  },
  {
    file: "join",
    name: "the measured address is not the one reported",
    from: "  const measuredUrl = speed.data.requestedUrl;",
    to: '  const measuredUrl = "https://wrong.example/";',
  },

  // --- the measurement arrives -------------------------------------------
  {
    file: "join",
    name: "the placeholder performance is kept instead of the real one",
    from: "      performance: speed.data,",
    to: "      performance: result.data.performance,",
  },
  {
    file: "join",
    name: "speed findings never reach the site findings",
    from: "      findings: sortFindings([...result.site.findings, ...speedFindings]),",
    to: "      findings: result.site.findings,",
  },
  {
    file: "join",
    name: "speed skipped checks are dropped",
    from: "      skippedChecks: [...result.site.skippedChecks, ...speed.skippedChecks],",
    to: "      skippedChecks: result.site.skippedChecks,",
  },
  {
    file: "join",
    name: "the crawl's own denominator is inflated by the speed check",
    from: "      evaluatedPages: result.site.evaluatedPages,",
    to: "      evaluatedPages: result.site.evaluatedPages + 1,",
  },
  {
    file: "join",
    name: "the stored audit is mutated instead of copied",
    from: "  return {\n    ...result,\n    data: {",
    to: "  return {\n    ...result,\n    data: Object.assign(result.data, {",
  },
  {
    file: "join",
    name: "an audit with no speed check is rebuilt anyway",
    from: "  if (speed === null) return result;",
    to: "  if (false) return result;",
  },

  // --- attaching ----------------------------------------------------------
  {
    file: "store",
    name: "a job still running accepts an attachment",
    from: "      if (!isTerminal(job.status) || job.result === null) return;",
    to: "      if (job.result === null && false) return;",
  },
  {
    file: "store",
    name: "a failed job accepts an attachment",
    from: "      if (!isTerminal(job.status) || job.result === null) return;",
    to: "      if (!isTerminal(job.status)) return;",
  },
  {
    file: "store",
    name: "a second attachment overwrites the first",
    from: "      if (job.attached !== null) return;",
    to: "      if (false) return;",
  },
  {
    file: "store",
    name: "attaching also rewrites the outcome",
    from: "      job.attached = value;",
    to: '      job.attached = value;\n      job.status = "completed";\n      job.result = null;',
  },

  // --- the route files it away -------------------------------------------
  {
    file: "route",
    name: "the measured speed result is never filed away",
    from: '    if (jobId !== "") (deps.store ?? auditJobs()).attach(jobId, speed);',
    to: '    if (false) (deps.store ?? auditJobs()).attach(jobId, speed);',
  },
  {
    file: "route",
    name: "a request naming no audit is refused instead of answered",
    from: "    return { status: 200, body: { ok: true, ...speed } };",
    to: '    return jobId === "" ? { status: 400, body: { ok: false, error: "no job" } } : { status: 200, body: { ok: true, ...speed } };',
  },
];

let killed = 0;
const survivors = [];

for (const m of mutations) {
  const path = files[m.file];
  const src = original[m.file];

  if (!src.includes(m.from)) {
    console.log(`SKIPPED (pattern not found)     : ${m.name}`);
    survivors.push(`${m.name} [PATTERN NOT FOUND]`);
    continue;
  }
  const mutated = src.replace(m.from, m.to);
  if (mutated === src) {
    console.log(`SKIPPED (no change)             : ${m.name}`);
    survivors.push(`${m.name} [NO CHANGE]`);
    continue;
  }

  fs.writeFileSync(path, mutated);
  if (fs.readFileSync(path, "utf8") === src) {
    console.log(`SKIPPED (write failed)          : ${m.name}`);
    survivors.push(`${m.name} [WRITE FAILED]`);
    restore();
    continue;
  }

  let passed;
  try {
    execSync(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "lib/audit/withSpeed.test.mts" "lib/jobs/jobStore.test.mts" "lib/api/auditRoutes.test.mts"',
      { stdio: "pipe" },
    );
    passed = true;
  } catch {
    passed = false;
  }

  restore();

  if (passed) {
    console.log(`SURVIVED                        : ${m.name}`);
    survivors.push(m.name);
  } else {
    console.log(`killed                          : ${m.name}`);
    killed += 1;
  }
}

restore();
console.log(`\nrestored. killed ${killed} of ${mutations.length}. survivors: ${survivors.length}`);
for (const s of survivors) console.log(`  - ${s}`);
