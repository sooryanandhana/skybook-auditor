/**
 * Tests for what asking for commentary writes to the reliability log.
 *
 * WHAT IS BEING PROVED. That every way asking can end leaves one line saying
 * which way it was; that the line holds a reason code and counts and nothing a
 * model, a validator or a website wrote; that one audit leaves one line however
 * often it is asked about; and that none of this changes what asking returns.
 *
 * No model is called. Every answer below is handed in.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { explainJob } from "./explainJob.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { runRealAudit, runRealCertificateFailure } from "./pdf/realAudit.fixture.mts";
import { AI_CONTRACT_VERSION } from "../ai/contract.ts";
import { EXPLANATION_FAILURE_MESSAGES } from "../ai/explanationOutcome.ts";
import { resetLoggedOnce } from "../log/reliabilityLog.ts";
import { APPROVED_FIELDS, captureLog, linesFor } from "../log/captureLog.fixture.mts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

const ENTRY = "https://example.com/";

const REAL_AUDIT = await runRealAudit({
  site: {
    [ENTRY]: {
      html:
        '<!doctype html><html lang="en"><head><title>Harbour Dental</title></head><body>' +
        "<h1>Welcome</h1><p>We look after teeth across the county and have done so since 1994.</p></body></html>",
    },
  },
  checks: { spfMissing: true },
});

const NO_PAGE_AUDIT = await runRealCertificateFailure({
  site: { [ENTRY]: { html: "", unreadable: "The website's security certificate has expired.", certificateProblem: "expired" } },
  checks: { certificateExpired: true },
});

/** Words that must never be in the log, planted in everything a model or validator could say. */
const AI_TEXT = "SENTINEL-MODEL-PROSE about Harbour Dental";
const VALIDATOR_SENTENCE = 'SENTINEL-VALIDATOR the answer may not carry "client-key"';
const FAILURE_SENTENCE = "SENTINEL-MESSAGE could not reach https://client.example/";

function finishedJob(audit: unknown = REAL_AUDIT) {
  const store = createJobStore() as unknown as AuditJobStore;
  const job = store.create(ENTRY);
  store.finish(job.id, "completed", audit as never);
  return { store, jobId: job.id };
}

const explained = (kept: number, dropped = 0): ExplainResult =>
  ({
    state: "explained",
    explanations: {
      version: AI_CONTRACT_VERSION,
      executiveSummary: AI_TEXT,
      explanations: Array.from({ length: kept }, (_, index) => ({
        ruleId: `rule.${index}`,
        explanation: AI_TEXT,
        businessImpact: AI_TEXT,
        recommendation: AI_TEXT,
      })),
    },
    rejected: Array.from({ length: dropped }, () => ({ ruleId: null, reason: VALIDATOR_SENTENCE })),
    partial: dropped > 0,
  }) as unknown as ExplainResult;

const notExplained = (reason: string, message = FAILURE_SENTENCE): ExplainResult =>
  ({ state: "not-explained", reason, message }) as unknown as ExplainResult;

const answering = (answer: ExplainResult) => ({ explain: async () => answer });

function assertSafe(entries: readonly string[]) {
  for (const entry of entries) {
    for (const forbidden of ["SENTINEL", "Harbour", "example.com", "client.example", "client-key", "https://", "@"]) {
      assert.ok(!entry.includes(forbidden), `"${forbidden}" reached the console: ${entry}`);
    }
  }
}

// ---------------------------------------------------------------------------
// An answer
// ---------------------------------------------------------------------------

test("an accepted answer is logged with how many explanations were kept and dropped", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => explainJob(jobId, store, answering(explained(5))));
  const lines = linesFor(captured, "ai.explain");

  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "succeeded");
  assert.equal(lines[0].accepted, 5);
  assert.equal(lines[0].rejected, 0);
  assert.equal(lines[0].job, jobId.slice(0, 8));
  assert.equal(typeof lines[0].ms, "number");
  assert.ok(!("reason" in lines[0]), "a success has no reason");
});

test("an answer with entries dropped by the validator says how many", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => explainJob(jobId, store, answering(explained(3, 2))));
  const [line] = linesFor(captured, "ai.explain");

  assert.equal(line.outcome, "succeeded");
  assert.equal(line.accepted, 3);
  assert.equal(line.rejected, 2);
});

test("nothing a model or a validator wrote is in the log", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => explainJob(jobId, store, answering(explained(4, 3))));

  /*
   * THE LINE FIRST. An empty log contains nothing a model wrote, so "nothing
   * forbidden was found" proves something only once the line is known to be
   * there -- and to be the line for this answer, with the model's prose and the
   * validator's sentences sitting in the result it was written from.
   */
  const lines = linesFor(captured, "ai.explain");
  assert.equal(captured.all.length, 1, "exactly one thing was written");
  assert.equal(lines.length, 1, "and it is the log line for this answer");
  assert.equal(lines[0].outcome, "succeeded");
  assert.equal(lines[0].job, jobId.slice(0, 8));
  assert.equal(lines[0].accepted, 4);
  assert.equal(lines[0].rejected, 3);

  const answer = captured.result.ok ? captured.result.result : null;
  assert.ok(answer !== null && answer.state === "explained");
  assert.equal(answer.explanations.executiveSummary, AI_TEXT, "the answer did carry the model's prose");
  assert.equal(answer.rejected[0].reason, VALIDATOR_SENTENCE, "and the validator's sentence");

  assertSafe(captured.all);
  for (const forbidden of [AI_TEXT, VALIDATOR_SENTENCE, "executiveSummary", "explanation", "businessImpact", "recommendation", "rule."]) {
    assert.ok(!captured.all[0].includes(forbidden), `"${forbidden}" is not in the line`);
  }
  for (const line of captured.lines) {
    for (const name of Object.keys(line)) {
      assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is an approved field`);
    }
  }
});

// ---------------------------------------------------------------------------
// No answer
// ---------------------------------------------------------------------------

const EXPECTED: Record<string, string> = {
  timeout: "timed-out",
  refused: "rejected",
  "no-api-key": "not-started",
};

for (const reason of Object.keys(EXPLANATION_FAILURE_MESSAGES)) {
  const outcome = EXPECTED[reason] ?? "failed";

  test(`a "${reason}" answer is logged as ${outcome}, by its code and never its sentence`, async () => {
    const { store, jobId } = finishedJob();
    const sentence = reason === "refused" ? VALIDATOR_SENTENCE : FAILURE_SENTENCE;

    const captured = await captureLog(() => explainJob(jobId, store, answering(notExplained(reason, sentence))));
    const lines = linesFor(captured, "ai.explain");

    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, outcome);
    assert.equal(lines[0].reason, reason);
    assert.ok(!("accepted" in lines[0]), "nothing was accepted");
    assertSafe(captured.all);
  });
}

test("a server with no key is logged as not started, through the real adapter", async () => {
  const { store, jobId } = finishedJob();

  // An empty key is "no key" whatever this machine has in its environment, and
  // with no key the adapter returns before it builds a request.
  const captured = await captureLog(() => explainJob(jobId, store, { options: { apiKey: "" } }));
  const [line] = linesFor(captured, "ai.explain");

  assert.equal(line.outcome, "not-started");
  assert.equal(line.reason, "no-api-key");
  assert.equal(captured.result.ok && captured.result.result.state, "not-explained");
});

// ---------------------------------------------------------------------------
// An audit that read no page
// ---------------------------------------------------------------------------

test("an audit that read no page is logged as not started, once, however often it is asked about", async () => {
  resetLoggedOnce();
  const { store, jobId } = finishedJob(NO_PAGE_AUDIT);
  let asked = 0;
  const model = {
    explain: async () => {
      asked += 1;
      return explained(1);
    },
  };

  const captured = await captureLog(async () => {
    const outcomes = [];
    for (let request = 0; request < 4; request += 1) outcomes.push(await explainJob(jobId, store, model));
    return outcomes;
  });
  const lines = linesFor(captured, "ai.explain");

  assert.equal(lines.length, 1, "one line for four requests");
  assert.equal(lines[0].outcome, "not-started");
  assert.equal(lines[0].reason, "no-page-measurements");
  assert.equal(lines[0].job, jobId.slice(0, 8));

  // What asking does is exactly what it did before there was a log.
  assert.equal(asked, 0, "no model was asked");
  for (const outcome of captured.result) {
    assert.deepEqual(outcome, { ok: false, reason: "no-page-measurements" });
  }
  const job = store.get(jobId);
  assert.equal(job?.explanation, null, "nothing was stored");
  assert.equal(job?.explanationClaimed, false, "and no claim was taken");
});

test("two audits that read no page are each logged", async () => {
  resetLoggedOnce();
  const first = finishedJob(NO_PAGE_AUDIT);
  const second = finishedJob(NO_PAGE_AUDIT);

  const captured = await captureLog(async () => {
    await explainJob(first.jobId, first.store, {});
    await explainJob(second.jobId, second.store, {});
    await explainJob(first.jobId, first.store, {});
  });

  assert.equal(linesFor(captured, "ai.explain").length, 2);
});

// ---------------------------------------------------------------------------
// One audit, one line
// ---------------------------------------------------------------------------

test("asking again about an answered audit writes nothing more", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(async () => {
    await explainJob(jobId, store, answering(explained(2)));
    const again = await explainJob(jobId, store, answering(explained(9)));
    await explainJob(jobId, store, answering(notExplained("timeout")));
    return again;
  });

  assert.equal(linesFor(captured, "ai.explain").length, 1);
  assert.equal(captured.result.ok && captured.result.stored, true, "the second ask read the stored answer");
});

test("a second ask while the first is still waiting writes nothing of its own", async () => {
  const { store, jobId } = finishedJob();
  let release: (answer: ExplainResult) => void = () => {};
  const slow = { explain: () => new Promise<ExplainResult>((resolve) => (release = resolve)) };

  const captured = await captureLog(async () => {
    const first = explainJob(jobId, store, slow);
    const second = await explainJob(jobId, store, slow);
    release(explained(1));
    await first;
    return second;
  });

  assert.deepEqual(captured.result, { ok: false, reason: "in-progress" });
  assert.equal(linesFor(captured, "ai.explain").length, 1, "the one answer, logged once");
});

test("a job that does not exist, or has not finished, writes nothing", async () => {
  const store = createJobStore() as unknown as AuditJobStore;
  const queued = store.create(ENTRY);

  const captured = await captureLog(async () => {
    await explainJob("no-such-job", store, answering(explained(1)));
    await explainJob(queued.id, store, answering(explained(1)));
  });

  assert.equal(captured.all.length, 0);
});

// ---------------------------------------------------------------------------
// The log cannot change what asking does
// ---------------------------------------------------------------------------

test("asking returns and stores the same answer when the console cannot be written to", async () => {
  const quiet = finishedJob();
  const broken = finishedJob();
  const answer = explained(3, 1);

  const expected = await captureLog(() => explainJob(quiet.jobId, quiet.store, answering(answer)));

  const real = console.log;
  console.log = () => {
    throw new Error("the console is closed");
  };
  let actual;
  try {
    actual = await explainJob(broken.jobId, broken.store, answering(answer));
  } finally {
    console.log = real;
  }

  assert.deepEqual(actual, expected.result);
  assert.deepEqual(broken.store.get(broken.jobId)?.explanation, answer, "and the answer was stored");
});

test("the audit is untouched by asking, logged or not", async () => {
  const { store, jobId } = finishedJob();
  const before = JSON.stringify(store.get(jobId)?.result);

  await captureLog(() => explainJob(jobId, store, answering(explained(2))));

  assert.equal(JSON.stringify(store.get(jobId)?.result), before);
});
