/**
 * Tests for the two places that log an unexpected error.
 *
 * BOTH USED TO PRINT THE ERROR'S MESSAGE AND STACK. A message is written by
 * whatever threw it, and what throws during an audit is usually something that
 * was holding a client's address or a line of a client's page. These tests
 * throw errors carrying exactly that, and read everything that reaches the
 * console.
 *
 * What the application DOES with the error is unchanged and is asserted too:
 * the audit still fails with its fixed sentence, and the rule is still skipped.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { captureLog } from "./captureLog.fixture.mts";
import { startAudit, UNEXPECTED_FAILURE, type AuditJobStore } from "../jobs/auditJobs.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { defineRule, runRules } from "../rules/runner.ts";
import type { runSiteAudit } from "../audit/siteAudit.ts";

const SECRETS = [
  "https://client.example/checkout?token=abc123",
  "client.example",
  "ana@harbourdental.example",
  "Harbour Dental",
  "sk_live_0123456789",
];

const MESSAGE = `Could not parse ${SECRETS[0]} for Harbour Dental (contact ana@harbourdental.example, key sk_live_0123456789)`;

/**
 * The warnings among everything written. An audit also writes its own
 * reliability lines (JSON); those are checked for secrets too, but they are
 * not warnings.
 */
const warningsIn = (entries: readonly string[]) => entries.filter((entry) => !entry.startsWith("{"));

function assertNoSecrets(entries: readonly string[]) {
  for (const entry of entries) {
    for (const secret of SECRETS) {
      assert.ok(!entry.includes(secret), `"${secret}" reached the console: ${entry}`);
    }
    assert.ok(!entry.includes("Could not parse"), `the error's message reached the console: ${entry}`);
  }
}

// ---------------------------------------------------------------------------
// An audit that fails unexpectedly
// ---------------------------------------------------------------------------

async function failingAudit(thrown: unknown) {
  const store = createJobStore() as unknown as AuditJobStore;
  const runImpl = (async () => {
    throw thrown;
  }) as unknown as typeof runSiteAudit;

  const captured = await captureLog(async () => {
    const started = startAudit(SECRETS[0], { store, runImpl });
    await started.finished;
    return started.jobId;
  });

  return { store, jobId: captured.result, captured };
}

test("an audit that fails unexpectedly is logged without the error's message", async () => {
  const { captured } = await failingAudit(new TypeError(MESSAGE));

  assert.equal(warningsIn(captured.all).length, 1, "one warning");
  assertNoSecrets(captured.all);
});

test("the warning names the job by its first eight characters and the kind of error, and nothing else", async () => {
  const { captured, jobId } = await failingAudit(new TypeError(MESSAGE));

  const [warning] = warningsIn(captured.all);
  assert.match(warning, /^Audit job [A-Za-z0-9-]{8} failed unexpectedly\. TypeError$/);
  assert.ok(warning.includes(jobId.slice(0, 8)));
  assert.ok(!captured.all.some((entry) => entry.includes(jobId)), "and nothing written carries the whole id");
});

test("something thrown that is not an error is not printed either", async () => {
  const { captured } = await failingAudit(MESSAGE);

  assert.equal(warningsIn(captured.all).length, 1);
  assertNoSecrets(captured.all);
  assert.match(warningsIn(captured.all)[0], /^Audit job [A-Za-z0-9-]{8} failed unexpectedly\. Error$/);
});

test("the audit still fails with its fixed sentence", async () => {
  const { store, jobId } = await failingAudit(new Error(MESSAGE));

  const job = store.get(jobId);
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, UNEXPECTED_FAILURE);
});

// ---------------------------------------------------------------------------
// A rule that throws
// ---------------------------------------------------------------------------

const throwingRule = (thrown: unknown) =>
  defineRule<never, object>({
    id: "test.throws",
    remediation: "Fix the underlying issue.",
    title: "A rule that throws",
    category: "seo",
    scope: "page",
    severity: "medium",
    select: () => {
      throw thrown;
    },
    evaluate: () => {
      throw new Error("never reached");
    },
  } as never);

test("a rule that throws is logged without the error's message", async () => {
  const captured = await captureLog(() => runRules({}, [throwingRule(new RangeError(MESSAGE))]));

  assert.equal(captured.all.length, 1, "one warning");
  assertNoSecrets(captured.all);
  assert.equal(captured.all[0], 'Rule "test.throws" threw while running and was skipped. RangeError');
});

test("a rule that throws something that is not an error is not printed either", async () => {
  const captured = await captureLog(() => runRules({}, [throwingRule(MESSAGE)]));

  assert.equal(captured.all.length, 1);
  assertNoSecrets(captured.all);
  assert.equal(captured.all[0], 'Rule "test.throws" threw while running and was skipped. Error');
});

test("the rule is still skipped, with its fixed sentence, and nothing else is lost", async () => {
  const captured = await captureLog(() => runRules({}, [throwingRule(new Error(MESSAGE))]));

  assert.deepEqual(captured.result.findings, []);
  assert.equal(captured.result.skipped.length, 1);
  assert.equal(captured.result.skipped[0].ruleId, "test.throws");
  assert.ok(!captured.result.skipped[0].reason.includes("client.example"));
});
