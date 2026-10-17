/**
 * Tests for what a PDF download writes to the reliability log.
 *
 * WHAT IS BEING PROVED. That a render leaves one line saying whether it worked;
 * that a failure is named by its category and never by the error; that the line
 * says truthfully whether the file carries written commentary and where the
 * commentary stood WHEN THE DOCUMENT WAS BUILT; and that the download answers
 * exactly as it did before there was a log.
 *
 * No browser is launched and no model is asked: the renderer and every answer
 * below are handed in.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { pdfExportRoute as exportAs } from "./pdfExportRoute.ts";

/** The account every request in this file is signed in as, and the owner of its jobs. */
const OWNER = "owner-account";
/** The export as the owner asks for it. */
const pdfExportRoute = (request: Request, deps: Partial<Parameters<typeof exportAs>[1]> = {}) =>
  exportAs(request, { userId: OWNER, ...deps });
import { PDF_RENDER_MESSAGES, PdfRenderError, type PdfRenderFailure } from "../audit/pdf/render.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { runRealAudit, runRealCertificateFailure } from "../audit/pdf/realAudit.fixture.mts";
import { AI_CONTRACT_VERSION } from "../ai/contract.ts";
import { APPROVED_FIELDS, captureLog, linesFor } from "../log/captureLog.fixture.mts";
import type { ExplainResult } from "../ai/gemini/explain.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

const ENTRY = "https://example.com/";
const FAKE_PDF = Buffer.from("%PDF-1.4\nfake\n%%EOF\n", "latin1");

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

const AI_TEXT = "SENTINEL-MODEL-PROSE about the audit";

const EXPLAINED = {
  state: "explained",
  explanations: { version: AI_CONTRACT_VERSION, executiveSummary: AI_TEXT, explanations: [] },
  rejected: [],
  partial: false,
} as unknown as ExplainResult;

const NOT_EXPLAINED = {
  state: "not-explained",
  reason: "timeout",
  message: "SENTINEL-MESSAGE the service did not answer",
} as unknown as ExplainResult;

type Commentary = "not-requested" | "pending" | "explained" | "not-explained";

function finishedJob(commentary: Commentary = "not-requested", audit: unknown = REAL_AUDIT) {
  const store = createJobStore() as unknown as AuditJobStore;
  const job = store.create(ENTRY, OWNER);
  store.finish(job.id, "completed", audit as never);

  if (commentary !== "not-requested") store.claimExplanation(job.id);
  if (commentary === "explained") store.setExplanation(job.id, EXPLAINED);
  if (commentary === "not-explained") store.setExplanation(job.id, NOT_EXPLAINED);

  return { store, jobId: job.id };
}

const CLIENT = { companyName: "Harbour Dental Ltd", contactName: "Ana Okafor", preparedBy: "Sam Reyes" };

const request = (jobId: string, body: unknown = CLIENT) =>
  new Request(`https://skybook.test/api/audit/pdf?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const rendering = async () => FAKE_PDF;
const failing = (error: unknown) => async () => {
  throw error;
};

function assertSafe(entries: readonly string[]) {
  for (const entry of entries) {
    for (const forbidden of ["SENTINEL", "Harbour", "Okafor", "Reyes", "example.com", "https://", "@", "%PDF"]) {
      assert.ok(!entry.includes(forbidden), `"${forbidden}" reached the console: ${entry}`);
    }
  }
}

// ---------------------------------------------------------------------------
// A render that worked
// ---------------------------------------------------------------------------

test("a download is logged once, with its size and how long it took", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() => pdfExportRoute(request(jobId), { store, render: rendering }));
  const lines = linesFor(captured, "pdf.render");

  assert.equal(captured.result.ok, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "succeeded");
  assert.equal(lines[0].via, "download");
  assert.equal(lines[0].bytes, FAKE_PDF.length);
  assert.equal(lines[0].job, jobId.slice(0, 8));
  assert.equal(typeof lines[0].ms, "number");
  assert.ok(!("reason" in lines[0]));
});

test("nothing about the client, the website or the document is in the log", async () => {
  const { store, jobId } = finishedJob("explained");

  const captured = await captureLog(() => pdfExportRoute(request(jobId), { store, render: rendering }));

  assert.equal(captured.all.length, 1);
  assertSafe(captured.all);
  for (const name of Object.keys(captured.lines[0])) {
    assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is an approved field`);
  }
});

// ---------------------------------------------------------------------------
// Whether the file carries commentary, and why
// ---------------------------------------------------------------------------

const CASES: readonly [Commentary, string][] = [
  ["not-requested", "absent"],
  ["pending", "absent"],
  ["not-explained", "absent"],
  ["explained", "included"],
];

for (const [state, text] of CASES) {
  test(`commentary that is ${state} is logged as ${state}, and the file's text as ${text}`, async () => {
    const { store, jobId } = finishedJob(state);
    let document: { summary: { ai: unknown } } | null = null;

    const captured = await captureLog(() =>
      pdfExportRoute(request(jobId), {
        store,
        render: async (rendered) => {
          document = rendered as never;
          return FAKE_PDF;
        },
      }),
    );
    const [line] = linesFor(captured, "pdf.render");

    assert.equal(line.aiState, state);
    assert.equal(line.aiText, text);

    // The log agrees with the document that was actually rendered.
    assert.ok(document !== null);
    assert.equal((document as { summary: { ai: unknown } }).summary.ai !== null, text === "included");
  });
}

test("commentary that arrives while the file is being rendered does not change what the log says about that file", async () => {
  /*
   * The file was built without the commentary, so it does not carry it. An
   * answer landing a moment later is true of the audit and false of this file,
   * and the log is about the file.
   */
  const { store, jobId } = finishedJob("pending");

  const captured = await captureLog(() =>
    pdfExportRoute(request(jobId), {
      store,
      render: async () => {
        store.setExplanation(jobId, EXPLAINED);
        return FAKE_PDF;
      },
    }),
  );
  const [line] = linesFor(captured, "pdf.render");

  assert.equal(store.get(jobId)?.explanation?.state, "explained", "the answer did arrive");
  assert.equal(line.aiState, "pending");
  assert.equal(line.aiText, "absent");
});

test("an audit that read no page is logged with no commentary, never asked for", async () => {
  const { store, jobId } = finishedJob("not-requested", NO_PAGE_AUDIT);

  const captured = await captureLog(() => pdfExportRoute(request(jobId), { store, render: rendering }));
  const [line] = linesFor(captured, "pdf.render");

  assert.equal(captured.result.ok, true);
  assert.equal(line.aiText, "absent");
  assert.equal(line.aiState, "not-requested");
});

// ---------------------------------------------------------------------------
// A render that failed
// ---------------------------------------------------------------------------

for (const failure of Object.keys(PDF_RENDER_MESSAGES) as PdfRenderFailure[]) {
  test(`a render that failed as "${failure}" is logged by that category`, async () => {
    const { store, jobId } = finishedJob("explained");

    const captured = await captureLog(() =>
      pdfExportRoute(request(jobId), { store, render: failing(new PdfRenderError(failure)) }),
    );
    const lines = linesFor(captured, "pdf.render");

    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "failed");
    assert.equal(lines[0].reason, failure);
    assert.equal(lines[0].aiState, "explained");
    assert.ok(!("bytes" in lines[0]), "there is no file to measure");
    assertSafe(captured.all);
  });
}

test("an unexpected error is logged as an internal error, and nothing it said is logged", async () => {
  const { store, jobId } = finishedJob();
  const error = new Error("SENTINEL chromium --user-data-dir=/tmp/x could not open https://client.example/?key=abc");

  const captured = await captureLog(() => pdfExportRoute(request(jobId), { store, render: failing(error) }));
  const [line] = linesFor(captured, "pdf.render");

  assert.equal(line.outcome, "failed");
  assert.equal(line.reason, "internal-error");
  assert.equal(captured.all.length, 1);
  assertSafe(captured.all);
  for (const forbidden of ["chromium", "user-data-dir", "client.example", "key=abc"]) {
    assert.ok(!captured.all[0].includes(forbidden), `${forbidden} is not in the log`);
  }
});

test("something thrown that is not an error is logged as an internal error", async () => {
  const { store, jobId } = finishedJob();

  const captured = await captureLog(() =>
    pdfExportRoute(request(jobId), { store, render: failing("SENTINEL https://client.example/") }),
  );

  assert.equal(linesFor(captured, "pdf.render")[0].reason, "internal-error");
  assertSafe(captured.all);
});

// ---------------------------------------------------------------------------
// A request that never reached the renderer
// ---------------------------------------------------------------------------

test("a request that is refused before rendering writes nothing", async () => {
  const store = createJobStore() as unknown as AuditJobStore;
  const queued = store.create(ENTRY, OWNER);
  const failed = store.create(ENTRY, OWNER);
  store.fail(failed.id, "The website could not be reached.");

  const captured = await captureLog(async () => {
    await pdfExportRoute(request(""), { store, render: rendering });
    await pdfExportRoute(request("no-such-job"), { store, render: rendering });
    await pdfExportRoute(request(queued.id), { store, render: rendering });
    await pdfExportRoute(request(failed.id), { store, render: rendering });
  });

  assert.equal(captured.all.length, 0);
});

// ---------------------------------------------------------------------------
// The log cannot change what the download answers
// ---------------------------------------------------------------------------

async function withBrokenConsole<T>(work: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = () => {
    throw new Error("the console is closed");
  };
  try {
    return await work();
  } finally {
    console.log = real;
  }
}

test("a download answers the same when the console cannot be written to", async () => {
  const quiet = finishedJob("explained");
  const broken = finishedJob("explained");

  const expected = await captureLog(() => pdfExportRoute(request(quiet.jobId), { store: quiet.store, render: rendering }));
  const actual = await withBrokenConsole(() =>
    pdfExportRoute(request(broken.jobId), { store: broken.store, render: rendering }),
  );

  assert.deepEqual(actual, expected.result);
  assert.equal(actual.ok && actual.pdf, FAKE_PDF, "the very bytes the renderer returned");
});

test("a failed download answers the same when the console cannot be written to", async () => {
  const quiet = finishedJob();
  const broken = finishedJob();
  const error = new PdfRenderError("timed-out");

  const expected = await captureLog(() =>
    pdfExportRoute(request(quiet.jobId), { store: quiet.store, render: failing(error) }),
  );
  const actual = await withBrokenConsole(() =>
    pdfExportRoute(request(broken.jobId), { store: broken.store, render: failing(error) }),
  );

  assert.deepEqual(actual, expected.result);
  assert.deepEqual(actual, { ok: false, status: 500, error: PDF_RENDER_MESSAGES["timed-out"] });
});

test("logging a download changes nothing about the job", async () => {
  const { store, jobId } = finishedJob("pending");
  const before = JSON.stringify(store.get(jobId));

  await captureLog(() => pdfExportRoute(request(jobId), { store, render: rendering }));

  const after = store.get(jobId);
  assert.equal(JSON.stringify({ ...after, updatedAt: 0, expiresAt: 0 }), JSON.stringify({ ...JSON.parse(before), updatedAt: 0, expiresAt: 0 }));
  assert.equal(after?.explanationClaimed, true);
  assert.equal(after?.explanation, null);
});
