/**
 * Tests for what sending a report writes to the reliability log.
 *
 * THESE STAND BESIDE `sendReportRoute.test.mts` AND REPLACE NOTHING IN IT. That
 * file still asserts the route's source contains no `console.` call, and it
 * still passes untouched. What it could not assert is what the route's one new
 * helper writes, so that is asserted here, three ways:
 *
 *   - the route imports the reliability log and no other way of writing;
 *   - a full send, with a recognisable value planted in every field a person
 *     or a website supplies, leaves none of them on the console;
 *   - every line it writes carries the approved fields and nothing else.
 *
 * AND WHAT IT SAYS IS TRUE: "accepted" when the email service took the request
 * and never "delivered", a category when it did not, and nothing at all when no
 * send was attempted.
 *
 * No message is sent and no browser is launched. The provider and the renderer
 * are handed in, and the network is a tripwire.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { sendReportRoute } from "./sendReportRoute.ts";
import { PDF_RENDER_MESSAGES, PdfRenderError } from "../audit/pdf/render.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { buildPdfDocument } from "../audit/pdfDocument.ts";
import { runRealAudit } from "../audit/pdf/realAudit.fixture.mts";
import { SEND_FAILURE_MESSAGES, fakeProvider, type SendFailure } from "../email/provider.ts";
import { resetSendLimit } from "../email/sendLimit.ts";
import { contentFingerprint } from "../report/sendGate.ts";
import { SESSION_COOKIE, signSession } from "../auth/session.ts";
import { AI_CONTRACT_VERSION } from "../ai/contract.ts";
import { APPROVED_FIELDS, captureLog, linesFor } from "../log/captureLog.fixture.mts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

// ---------------------------------------------------------------------------
// Recognisable values, planted wherever a person or a website supplies one
// ---------------------------------------------------------------------------

const ENTRY = "https://harbour-dental-sentinel.example/";
const FAKE_PDF = Buffer.from("%PDF-1.4\nSENTINEL-PDF-BYTES\n%%EOF\n", "latin1");
const SECRET = "sentinel-session-secret-that-is-long-enough-0123456789";
const FROM = "reports-sentinel@skybook.example";
const RECIPIENT = "ana-sentinel@harbourdental.example";
const RECEIPT = "re_SENTINEL_receipt_0123456789";
const FIELDS = { companyName: "Sentinel Dental Ltd", contactName: "Ana Sentinel", preparedBy: "Sam Sentinel" };
const AI_TEXT = "SENTINEL-MODEL-PROSE";
const NOW = 1_757_000_000_000;
const USER_ID = "11111111-1111-1111-1111-111111111111";

const ACTIVE_USER = {
  id: USER_ID,
  email: "sam-sentinel@skybook.example",
  password_hash: "scrypt:aa:bb",
  role: "SALES",
  status: "ACTIVE",
  created_at: new Date(NOW),
  updated_at: new Date(NOW),
  approved_by: null,
  approved_at: null,
  last_login_at: null,
  must_change_password: false,
};

const FORBIDDEN = [
  "sentinel",
  "SENTINEL",
  "Sentinel",
  "harbour",
  "example",
  "https://",
  "@",
  "re_",
  "%PDF",
  "Bearer",
  SECRET,
  USER_ID,
];

function assertSafe(entries: readonly string[]) {
  for (const entry of entries) {
    for (const forbidden of FORBIDDEN) {
      assert.ok(!entry.includes(forbidden), `"${forbidden}" reached the console: ${entry}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Nothing in this file may reach the network
// ---------------------------------------------------------------------------

const reachedNetwork: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  reachedNetwork.push(String(input));
  throw new Error("a test reached the network");
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REAL_AUDIT = await runRealAudit({
  requestedUrl: ENTRY,
  site: {
    [ENTRY]: {
      html:
        '<!doctype html><html lang="en"><head><title>Sentinel Dental</title></head><body>' +
        "<h1>Welcome</h1><p>We look after teeth across the county and have done so since 1994.</p></body></html>",
    },
  },
  checks: { spfMissing: true },
});

const EXPLAINED = {
  state: "explained",
  explanations: { version: AI_CONTRACT_VERSION, executiveSummary: AI_TEXT, explanations: [] },
  rejected: [],
  partial: false,
} as unknown as ExplainResult;

function finishedJob(explained = false) {
  const store = createJobStore() as unknown as AuditJobStore;
  const job = store.create(ENTRY);
  store.finish(job.id, "completed", REAL_AUDIT);
  if (explained) {
    store.claimExplanation(job.id);
    store.setExplanation(job.id, EXPLAINED);
  }
  return { store, jobId: job.id };
}

function dbReturning(user: Record<string, unknown>) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*SELECT/i.test(sql)) {
        const id = String(params[0] ?? "");
        return { rows: id === user.id ? [user] : [] };
      }
      return { rows: [] };
    },
  };
}

function confirmationFor(store: AuditJobStore, jobId: string, recipient = RECIPIENT) {
  const outcome = buildPdfDocument(jobId, store, FIELDS);
  if (!outcome.ok) assert.fail("the fixture audit did not produce a document");

  return contentFingerprint({ jobId, recipient, auditedUrl: outcome.document.cover.auditedUrl, ...FIELDS });
}

const request = (body: unknown, signedIn = true) =>
  new Request("https://skybook.test/api/report/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "1.2.3.4",
      ...(signedIn
        ? { cookie: `${SESSION_COOKIE}=${signSession(USER_ID, "SALES", { secret: SECRET }, NOW)}` }
        : {}),
    },
    body: JSON.stringify(body),
  });

const deps = (extra: Record<string, unknown> = {}) => ({
  secret: SECRET,
  from: FROM,
  now: NOW,
  db: dbReturning(ACTIVE_USER),
  render: async () => FAKE_PDF,
  ...extra,
});

/** One confirmed send, with everything planted. */
function confirmedSend(store: AuditJobStore, jobId: string, extra: Record<string, unknown> = {}) {
  resetSendLimit();
  return sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId), ...FIELDS }),
    deps({ store, provider: fakeProvider({ ok: true, id: RECEIPT }).provider, ...extra }),
  );
}

// ---------------------------------------------------------------------------
// The protection the route's own tests rely on, stated for the log
// ---------------------------------------------------------------------------

const routeSource = () =>
  fs
    .readFileSync(new URL("./sendReportRoute.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

test("the send route writes through the reliability log and has no other way of writing", () => {
  const source = routeSource();

  assert.ok(source.includes('from "../log/reliabilityLog.ts"'), "the approved logger is what it imports");
  assert.ok(!source.includes("console"), "the console is not named at all");
  for (const forbidden of ["process.stdout", "process.stderr", "node:util", "node:console", "node:fs", "debug(", "inspect("]) {
    assert.ok(!source.includes(forbidden), `the send route must not reach ${forbidden}`);
  }

  const logImports = [...source.matchAll(/from "([^"]*)"/g)].map((match) => match[1]).filter((path) => /log/i.test(path));
  assert.deepEqual(logImports, ["../log/reliabilityLog.ts"], "and it is the only logging import");
});

test("the route hands the log no recipient, sender, subject, address, receipt or error", () => {
  /*
   * Every call to the log in this file, read as written. The log would drop a
   * field it does not know, so this is a second lock on the same door: the
   * values are not even offered.
   */
  // The fixed word that names the operation is set aside, so that "email" below
  // means the message being sent and never that label.
  const calls = [...routeSource().matchAll(/logOutcome\(\{[\s\S]*?\}\);/g)].map((match) =>
    match[0].replace('op: "email.send"', "op: OPERATION"),
  );

  assert.equal(calls.length, 3, "a render that worked, a render that failed, and the send");
  for (const call of calls) {
    for (const forbidden of ["recipient", "from", "subject", "preview", "auditedUrl", "email", "delivery.id", ".id", "error.", "message", "pdf.toString"]) {
      assert.ok(!call.includes(forbidden), `a log call mentions ${forbidden}: ${call}`);
    }
  }
});

// ---------------------------------------------------------------------------
// A send the service accepted
// ---------------------------------------------------------------------------

test("an accepted send is logged as accepted, and never as delivered", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => confirmedSend(store, jobId));
  const lines = linesFor(captured, "email.send");

  assert.equal(captured.result.ok, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "accepted");
  assert.equal(lines[0].job, jobId.slice(0, 8));
  assert.equal(typeof lines[0].ms, "number");
  assert.ok(!("reason" in lines[0]));
  assert.ok(!captured.all.some((entry) => /deliver/i.test(entry)), "nothing claims delivery");
});

test("the render behind a send is logged too, as an email's", async () => {
  const { store, jobId } = finishedJob(true);

  const captured = await captureLog(() => confirmedSend(store, jobId));
  const lines = linesFor(captured, "pdf.render");

  assert.equal(lines.length, 1);
  assert.equal(lines[0].via, "email");
  assert.equal(lines[0].outcome, "succeeded");
  assert.equal(lines[0].bytes, FAKE_PDF.length);
  assert.equal(lines[0].aiText, "included");
  assert.equal(lines[0].aiState, "explained");
});

test("a full send leaves nothing about the client, the message or the session on the console", async () => {
  const { store, jobId } = finishedJob(true);

  const captured = await captureLog(() => confirmedSend(store, jobId));

  assert.equal(captured.all.length, 2, "the render and the send, and nothing else");
  assertSafe(captured.all);
});

test("every line a send writes carries approved fields only", async () => {
  const { store, jobId } = finishedJob(true);

  const captured = await captureLog(() => confirmedSend(store, jobId));

  assert.equal(captured.lines.length, captured.all.length, "everything written is a log line");
  for (const line of captured.lines) {
    for (const name of Object.keys(line)) {
      assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is an approved field`);
    }
    assert.ok(!("receipt" in line) && !("id" in line), "the service's receipt is not logged");
  }
});

test("the service's receipt is not logged even when it is the only thing it returned", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => confirmedSend(store, jobId));

  assert.ok(!captured.all.some((entry) => entry.includes(RECEIPT)));
});

// ---------------------------------------------------------------------------
// A send the service did not accept
// ---------------------------------------------------------------------------

for (const failure of Object.keys(SEND_FAILURE_MESSAGES) as SendFailure[]) {
  test(`a send that failed as "${failure}" is logged as not accepted, by that category`, async () => {
    const { store, jobId } = finishedJob();

    const captured = await captureLog(() =>
      confirmedSend(store, jobId, { provider: fakeProvider({ ok: false, failure }).provider }),
    );
    const lines = linesFor(captured, "email.send");

    assert.equal(captured.result.ok, false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "not-accepted");
    assert.equal(lines[0].reason, failure);
    assertSafe(captured.all);
  });
}

// ---------------------------------------------------------------------------
// A render that failed before anything was sent
// ---------------------------------------------------------------------------

test("a render that fails is logged, and no send is logged because none was attempted", async () => {
  const { store, jobId } = finishedJob();
  const mail = fakeProvider();

  const captured = await captureLog(() =>
    confirmedSend(store, jobId, {
      provider: mail.provider,
      render: async () => {
        throw new PdfRenderError("browser-unavailable");
      },
    }),
  );

  assert.deepEqual(captured.result, { ok: false, status: 500, error: PDF_RENDER_MESSAGES["browser-unavailable"] });
  assert.equal(mail.sent.length, 0);
  assert.equal(linesFor(captured, "email.send").length, 0);

  const [line] = linesFor(captured, "pdf.render");
  assert.equal(line.outcome, "failed");
  assert.equal(line.reason, "browser-unavailable");
  assert.equal(line.via, "email");
});

test("an unexpected render error is logged by category and nothing it said is logged", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() =>
    confirmedSend(store, jobId, {
      render: async () => {
        throw new Error("SENTINEL could not open https://client-sentinel.example/?key=abc");
      },
    }),
  );

  assert.equal(linesFor(captured, "pdf.render")[0].reason, "internal-error");
  assertSafe(captured.all);
});

// ---------------------------------------------------------------------------
// A request that never reached the renderer or the service
// ---------------------------------------------------------------------------

test("a request refused before anything is rendered or sent writes nothing", async () => {
  const { store, jobId } = finishedJob();
  const provider = fakeProvider().provider;
  const confirmedFor = confirmationFor(store, jobId);

  const captured = await captureLog(async () => {
    resetSendLimit();
    const refusals = [
      // not signed in
      await sendReportRoute(request({ jobId, recipient: RECIPIENT, confirmedFor, ...FIELDS }, false), deps({ store, provider })),
      // no job id
      await sendReportRoute(request({ recipient: RECIPIENT, confirmedFor }), deps({ store, provider })),
      // no usable recipient
      await sendReportRoute(request({ jobId, recipient: "not-an-address", confirmedFor }), deps({ store, provider })),
      // no such job
      await sendReportRoute(request({ jobId: "no-such-job", recipient: RECIPIENT, confirmedFor }), deps({ store, provider })),
      // not confirmed
      await sendReportRoute(request({ jobId, recipient: RECIPIENT, confirmedFor: "wrong", ...FIELDS }), deps({ store, provider })),
    ];
    return refusals;
  });

  for (const refusal of captured.result) assert.equal(refusal.ok, false);
  assert.equal(captured.all.length, 0);
});

// ---------------------------------------------------------------------------
// The log cannot change what sending does
// ---------------------------------------------------------------------------

test("a send answers the same, and still sends once, when the console cannot be written to", async () => {
  const quiet = finishedJob(true);
  const broken = finishedJob(true);
  const quietMail = fakeProvider({ ok: true, id: RECEIPT });
  const brokenMail = fakeProvider({ ok: true, id: RECEIPT });

  const expected = await captureLog(() => confirmedSend(quiet.store, quiet.jobId, { provider: quietMail.provider }));

  const real = console.log;
  console.log = () => {
    throw new Error("the console is closed");
  };
  let actual;
  try {
    actual = await confirmedSend(broken.store, broken.jobId, { provider: brokenMail.provider });
  } finally {
    console.log = real;
  }

  assert.deepEqual(actual, expected.result);
  assert.equal(brokenMail.sent.length, 1, "one message, as before");
  assert.equal(brokenMail.sent[0].to, quietMail.sent[0].to);
  assert.equal(brokenMail.sent[0].subject, quietMail.sent[0].subject);
  assert.equal(brokenMail.sent[0].text, quietMail.sent[0].text);
});

test("no test in this file reached the network", () => {
  assert.deepEqual(reachedNetwork, []);
});
