/**
 * Tests for sending a finished report to a client.
 *
 * ONE REAL AUDIT, ONE FAKE PROVIDER, NO NETWORK. The audit comes from the
 * 7C-6 harness with only the socket replaced, because a projection that reads
 * twenty measurement blocks needs twenty measurement blocks and a hand-built
 * fixture would be a fixture grown until it stopped throwing. The provider is
 * the fake that ships beside the seam, so nothing here can reach a service and
 * no test needs a key.
 *
 * THE INTERESTING TESTS ARE THE REFUSALS, and there are nine ways to be
 * refused. Every one of them has to leave the client's inbox untouched, which
 * is what most of this file checks: not that the answer was right, but that
 * nothing was sent.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { sendReportRoute, FROM_VARIABLE, NOT_CONFIRMED, NO_RECIPIENT } from "./sendReportRoute.ts";
import { JOB_NOT_FOUND, NO_JOB_ID, NOT_READY } from "../jobs/jobResponses.ts";
import { PDF_RENDER_MESSAGES, PdfRenderError } from "../audit/pdf/render.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { buildPdfDocument } from "../audit/pdfDocument.ts";
import { runRealAudit } from "../audit/pdf/realAudit.fixture.mts";
import { SEND_FAILURE_MESSAGES, fakeProvider } from "../email/provider.ts";
import { codeOnly } from "../email/provider.test.mts";
import { MAX_SENDS, SEND_RATE_LIMITED, resetSendLimit, sendAllowance } from "../email/sendLimit.ts";
import { contentFingerprint } from "../report/sendGate.ts";
import { SESSION_COOKIE, signSession } from "../auth/session.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

const FAKE_PDF = Buffer.from("%PDF-1.4\nfake\n%%EOF\n", "latin1");
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const FROM = "reports@skybook.example";
const RECIPIENT = "ana@harbourdental.example";
const NOW = 1_757_000_000_000;

/** One real audit, built once and shared, exactly as the export tests do. */
const REAL_AUDIT = await runRealAudit({
  site: {
    "https://example.com/": {
      html:
        '<!doctype html><html lang="en"><head><title>Example Company</title></head><body>' +
        "<h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p>" +
        '<a href="/about">About</a></body></html>',
    },
    "https://example.com/about": {
      html:
        '<!doctype html><html lang="en"><head><title>About</title></head><body>' +
        "<h1>About us</h1><p>Founded in 1994, we make things well and deliver them on time.</p>" +
        "</body></html>",
    },
  },
  checks: { spfMissing: true },
});

function storeWith(state: "completed" | "partial" | "queued" | "running" | "failed") {
  const store = createJobStore() as unknown as AuditJobStore;
  const job = store.create("https://example.com/");

  if (state === "running") store.markRunning(job.id);
  if (state === "failed") store.fail(job.id, "The website could not be reached.");
  if (state === "completed" || state === "partial") {
    store.finish(job.id, state === "partial" ? "partial" : "completed", REAL_AUDIT);
  }
  return { store, jobId: job.id };
}

/** A renderer that records what it was handed. No browser is ever launched. */
function recordingRenderer(fail?: Error) {
  const seen: unknown[] = [];
  return {
    seen,
    render: async (document: unknown) => {
      seen.push(document);
      if (fail) throw fail;
      return FAKE_PDF;
    },
  };
}

/**
 * The fingerprint the browser would be holding, built the way the browser
 * builds it: from the audited address the DOCUMENT carries, not from anything
 * a caller invented.
 */
function confirmationFor(
  store: AuditJobStore,
  jobId: string,
  recipient = RECIPIENT,
  fields: Record<string, string> = {},
) {
  const outcome = buildPdfDocument(jobId, store, fields);
  if (!outcome.ok) assert.fail("the fixture audit did not produce a document");

  return contentFingerprint({
    jobId,
    recipient,
    auditedUrl: outcome.document.cover.auditedUrl,
    ...fields,
  });
}

const request = (body: unknown, signedIn = true, caller = "1.2.3.4") =>
  new Request("https://skybook.test/api/report/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": caller,
      ...(signedIn
        ? { cookie: `${SESSION_COOKIE}=${signSession("sam@skybook.example", { secret: SECRET }, NOW)}` }
        : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const deps = (extra: Record<string, unknown> = {}) => ({
  secret: SECRET,
  from: FROM,
  now: NOW,
  ...extra,
});

/* ---------------------------------------------------------------------------
   The one path that sends
   --------------------------------------------------------------------------- */

test("a confirmed report reaches the provider, once", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const renderer = recordingRenderer();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({ store, render: renderer.render, provider: mail.provider }),
  );

  assert.equal(result.ok, true);
  assert.equal(mail.sent.length, 1, "one message, not two");
  assert.equal(mail.sent[0].to, RECIPIENT);
  assert.equal(mail.sent[0].from, FROM);
});

test("the message carries the same words the person confirmed", async () => {
  /*
   * The preview is not a mock-up of the email. It IS the email, composed by
   * the one function that composes it, so what was read and what is sent
   * cannot drift.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  await sendReportRoute(
    request({
      jobId,
      recipient: RECIPIENT,
      confirmedFor: confirmationFor(store, jobId, RECIPIENT, { companyName: "Harbour Dental" }),
      companyName: "Harbour Dental",
    }),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(mail.sent[0].subject, "Website audit for Harbour Dental");
  assert.match(mail.sent[0].text, /Please find attached the website audit/);
});

test("the attachment is the report the download button produces", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const renderer = recordingRenderer();

  await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({ store, render: renderer.render, provider: mail.provider }),
  );

  assert.equal(renderer.seen.length, 1, "the renderer ran once");
  assert.deepEqual(mail.sent[0].attachment.content, FAKE_PDF, "and its bytes were attached");
  assert.match(mail.sent[0].attachment.filename, /^skybook-audit-.*\.pdf$/);
});

/* ---------------------------------------------------------------------------
   Every way to be refused, and nothing sent by any of them
   --------------------------------------------------------------------------- */

test("a request with no session is refused before anything else happens", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const renderer = recordingRenderer();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, false),
    deps({ store, render: renderer.render, provider: mail.provider }),
  );

  assert.equal(result.ok === false && result.status, 401);
  assert.equal(mail.sent.length, 0, "nothing sent");
  assert.equal(renderer.seen.length, 0, "and nothing even rendered");
});

test("an unconfirmed send is refused, and the renderer never runs", async () => {
  /*
   * THE CHECK THAT COSTS THE MOST TO GET WRONG, and the reason it sits before
   * the renderer: rendering drives a headless browser, and a send nobody
   * agreed to must not spend that.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const renderer = recordingRenderer();

  for (const confirmedFor of ["", "not-a-fingerprint", confirmationFor(store, jobId, "someone@else.example")]) {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor }),
      deps({ store, render: renderer.render, provider: mail.provider }),
    );

    assert.equal(result.ok === false && result.status, 409, JSON.stringify(confirmedFor));
    assert.equal(result.ok === false && result.error, NOT_CONFIRMED);
  }

  assert.equal(mail.sent.length, 0);
  assert.equal(renderer.seen.length, 0, "no browser was launched for any of them");
});

test("a confirmation for different client details does not carry over", async () => {
  // Somebody confirms, then adds the company name. The report changed.
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({
      jobId,
      recipient: RECIPIENT,
      confirmedFor: confirmationFor(store, jobId),
      companyName: "Harbour Dental",
    }),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok === false && result.error, NOT_CONFIRMED);
  assert.equal(mail.sent.length, 0);
});

test("a caller cannot make their own fingerprint fit by supplying an address", async () => {
  /*
   * The audited address comes from the DOCUMENT, never from the request, so a
   * body claiming a different site does not change what is fingerprinted.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const forged = contentFingerprint({
    jobId,
    recipient: RECIPIENT,
    auditedUrl: "https://somewhere-else.example/",
  });

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: forged, auditedUrl: "https://somewhere-else.example/" }),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok === false && result.error, NOT_CONFIRMED);
  assert.equal(mail.sent.length, 0);
});

test("a missing or unusable recipient is refused", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  for (const recipient of ["", "   ", "ana", "ana@", "@example.com", "a b@example.com"]) {
    const result = await sendReportRoute(
      request({ jobId, recipient, confirmedFor: confirmationFor(store, jobId, recipient) }),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

    assert.equal(result.ok === false && result.status, 400, JSON.stringify(recipient));
    assert.equal(result.ok === false && result.error, NO_RECIPIENT);
  }

  assert.equal(mail.sent.length, 0);
});

test("a missing job id is refused in the job layer's own words", async () => {
  resetSendLimit();
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ recipient: RECIPIENT, confirmedFor: "x" }),
    deps({ store: storeWith("completed").store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok === false && result.status, 400);
  assert.equal(result.ok === false && result.error, NO_JOB_ID);
  assert.equal(mail.sent.length, 0);
});

test("an unknown, unfinished or failed audit is refused, and nothing is sent", async () => {
  const cases: [string, number, string][] = [
    ["queued", 409, NOT_READY],
    ["running", 409, NOT_READY],
    ["failed", 409, "The website could not be reached."],
  ];

  for (const [state, status, error] of cases) {
    resetSendLimit();
    const { store, jobId } = storeWith(state as "queued");
    const mail = fakeProvider();

    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: "anything" }),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

    assert.equal(result.ok === false && result.status, status, state);
    assert.equal(result.ok === false && result.error, error, state);
    assert.equal(mail.sent.length, 0, state);
  }

  resetSendLimit();
  const { store } = storeWith("completed");
  const unknown = await sendReportRoute(
    request({ jobId: "no-such-job", recipient: RECIPIENT, confirmedFor: "anything" }),
    deps({ store, render: recordingRenderer().render, provider: fakeProvider().provider }),
  );

  assert.equal(unknown.ok === false && unknown.status, 404);
  assert.equal(unknown.ok === false && unknown.error, JOB_NOT_FOUND);
});

test("a malformed body is refused rather than crashing the route", async () => {
  resetSendLimit();
  const mail = fakeProvider();

  for (const body of ["not json", "null", "[]", '{"jobId":42}']) {
    const result = await sendReportRoute(
      request(body),
      deps({ store: storeWith("completed").store, render: recordingRenderer().render, provider: mail.provider }),
    );

    assert.equal(result.ok, false, body);
    assert.equal(mail.sent.length, 0);
  }
});

test("a render that fails sends nothing and says so without a cause", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({
      store,
      render: recordingRenderer(new PdfRenderError("timed-out")).render,
      provider: mail.provider,
    }),
  );

  assert.equal(result.ok === false && result.status, 500);
  assert.equal(result.ok === false && result.error, PDF_RENDER_MESSAGES["timed-out"]);
  assert.equal(mail.sent.length, 0, "nothing was sent for a report that was never produced");
});

test("a provider failure is reported in our words, never the service's", async () => {
  for (const [failure, status] of [
    ["rejected", 502],
    ["network", 502],
    ["provider-error", 502],
    ["rate-limited", 429],
  ] as const) {
    resetSendLimit();
    const { store, jobId } = storeWith("completed");
    const mail = fakeProvider({ ok: false, failure });

    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

    assert.equal(result.ok === false && result.status, status, failure);
    assert.equal(result.ok === false && result.error, SEND_FAILURE_MESSAGES[failure], failure);
  }
});

test("a server with no sending address configured refuses", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({ store, render: recordingRenderer().render, provider: mail.provider, from: "" }),
  );

  assert.equal(result.ok === false && result.status, 503);
  assert.equal(mail.sent.length, 0);
});

test("a server with no provider refuses rather than quietly succeeding", async () => {
  /*
   * THE STATE THIS FEATURE IS IN TODAY. There is no real provider, and a route
   * that reported success while doing nothing would be the worst possible
   * version of it.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({ store, render: recordingRenderer().render }),
  );

  assert.equal(result.ok === false && result.status, 503);
  assert.equal(result.ok === false && result.error, SEND_FAILURE_MESSAGES["not-configured"]);
});

/* ---------------------------------------------------------------------------
   How many may be sent
   --------------------------------------------------------------------------- */

test("a caller is stopped after the send allowance runs out", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const send = () =>
    sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "9.9.9.9"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

  for (let n = 0; n < MAX_SENDS; n += 1) assert.equal((await send()).ok, true, `send ${n}`);

  const blocked = await send();
  assert.equal(blocked.ok === false && blocked.status, 429);
  assert.equal(blocked.ok === false && blocked.error, SEND_RATE_LIMITED);
  assert.equal(mail.sent.length, MAX_SENDS, "no message got through after the limit");
});

test("the send allowance is counted apart from the audit allowance", async () => {
  /*
   * The third time this project has kept a bucket separate. An audit that is
   * refused can be run again; an email that is sent cannot be unsent, and a
   * shared allowance would let either starve the other.
   */
  const source = codeOnly(fs.readFileSync(new URL("./sendReportRoute.ts", import.meta.url), "utf8"));

  assert.ok(!source.includes("checkRateLimit"), "the audit limiter is not consulted");
  assert.ok(!source.includes("../rateLimit"), "and it is not imported");
});

/* ---------------------------------------------------------------------------
   What this route cannot do, asserted against the source
   --------------------------------------------------------------------------- */

/* Code rather than prose: a comment explaining an absence is not the thing. */
const read = () =>
  codeOnly(fs.readFileSync(new URL("./sendReportRoute.ts", import.meta.url), "utf8"));

test("sending starts no audit, crawl, speed check or model request", async () => {
  const source = read();

  for (const forbidden of [
    "startAudit",
    "runSiteAudit",
    "crawlSite",
    "runPerformanceChecks",
    "explainAudit",
    "../ai/",
    "../collector/",
    "../rules/",
  ]) {
    assert.ok(!source.includes(forbidden), `the send route must not reach ${forbidden}`);
  }
});

test("sending stores nothing and names no provider", async () => {
  const source = read();

  for (const forbidden of ["resend", "Resend", "postgres", "prisma", "writeFile", "localStorage"]) {
    assert.ok(!source.includes(forbidden), `the send route must not reach ${forbidden}`);
  }
});

test("nothing here writes to the console", async () => {
  const source = read();

  for (const forbidden of ["console.log", "console.warn", "console.error"]) {
    assert.ok(!source.includes(forbidden), `must not ${forbidden}`);
  }
});

test("no answer carries a secret, a session or a raw header value", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  const serialised = JSON.stringify(result) + JSON.stringify(mail.sent.map((m) => ({ ...m, attachment: null })));

  for (const secret of [SECRET, SESSION_COOKIE, FROM_VARIABLE]) {
    assert.ok(!serialised.includes(secret), `must not carry ${secret.slice(0, 20)}`);
  }
});

/* ---------------------------------------------------------------------------
   What spends an allowance, and what does not

   A review measured this rather than assuming it: five refused attempts sent
   nothing and still used up the whole allowance, so the sixth attempt, this
   one correctly confirmed, was told too many reports had been sent from here.
   None had. Asking and spending are two operations now, and these pin which
   is which.
   --------------------------------------------------------------------------- */

/** How much of the allowance a caller has left, read without using any. */
const remaining = (caller: string) => sendAllowance(caller, NOW).remaining;

test("a refused confirmation spends nothing", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  for (let n = 0; n < MAX_SENDS + 3; n += 1) {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: "wrong" }, true, "7.7.7.7"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );
    assert.equal(result.ok === false && result.error, NOT_CONFIRMED, `attempt ${n}`);
  }

  assert.equal(mail.sent.length, 0, "nothing was sent");
  assert.equal(remaining("7.7.7.7"), MAX_SENDS, "and nothing was spent");
});

test("a failed render spends nothing", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  for (let n = 0; n < MAX_SENDS + 3; n += 1) {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.7.8"),
      deps({
        store,
        render: recordingRenderer(new PdfRenderError("timed-out")).render,
        provider: mail.provider,
      }),
    );
    assert.equal(result.ok === false && result.status, 500, `attempt ${n}`);
  }

  assert.equal(mail.sent.length, 0);
  assert.equal(remaining("7.7.7.8"), MAX_SENDS, "a renderer that times out is not a send");
});

test("a provider failure spends nothing", async () => {
  /*
   * The case where the message genuinely reached the wire and came back
   * refused. Nothing arrived, so nothing was sent, so nothing is counted.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider({ ok: false, failure: "provider-error" });

  for (let n = 0; n < MAX_SENDS + 3; n += 1) {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.7.9"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );
    assert.equal(result.ok === false && result.status, 502, `attempt ${n}`);
  }

  assert.equal(remaining("7.7.7.9"), MAX_SENDS);
});

test("every other refusal spends nothing either", async () => {
  // The unauthenticated, unknown-job, unfinished and bad-input paths, each run
  // past the allowance and each leaving it whole.
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const send = (body: unknown, signedIn = true) =>
    sendReportRoute(
      request(body, signedIn, "7.7.8.0"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

  for (let n = 0; n < 3; n += 1) {
    await send({ jobId, recipient: RECIPIENT, confirmedFor: "x" }, false);
    await send({ recipient: RECIPIENT, confirmedFor: "x" });
    await send({ jobId, recipient: "not-an-address", confirmedFor: "x" });
    await send({ jobId: "no-such-job", recipient: RECIPIENT, confirmedFor: "x" });
  }

  assert.equal(mail.sent.length, 0);
  assert.equal(remaining("7.7.8.0"), MAX_SENDS);
});

test("a successful send spends exactly one", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.8.1"),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok, true);
  assert.equal(mail.sent.length, 1);
  assert.equal(remaining("7.7.8.1"), MAX_SENDS - 1, "exactly one, not two and not none");
});

test("the sixth successful send inside the window is refused", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const send = () =>
    sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.8.2"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );

  for (let n = 0; n < MAX_SENDS; n += 1) assert.equal((await send()).ok, true, `send ${n}`);

  const sixth = await send();
  assert.equal(sixth.ok === false && sixth.status, 429);
  assert.equal(sixth.ok === false && sixth.error, SEND_RATE_LIMITED);
  assert.equal(mail.sent.length, MAX_SENDS, "the sixth reached no provider");
});

test("the allowance is still checked before any expensive work", async () => {
  /*
   * Moving the spend to the end must not have moved the CHECK to the end. A
   * caller who is over the limit is refused before the job is looked up, the
   * document is built or a browser is launched.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const confirmed = confirmationFor(store, jobId);

  for (let n = 0; n < MAX_SENDS; n += 1) {
    await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmed }, true, "7.7.8.3"),
      deps({ store, render: recordingRenderer().render, provider: mail.provider }),
    );
  }

  const renderer = recordingRenderer();
  const blocked = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmed }, true, "7.7.8.3"),
    deps({ store, render: renderer.render, provider: mail.provider }),
  );

  assert.equal(blocked.ok === false && blocked.status, 429);
  assert.equal(renderer.seen.length, 0, "no browser was launched for a refused caller");
});
