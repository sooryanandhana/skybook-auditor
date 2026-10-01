/**
 * Tests for sending a finished report to a client.
 *
 * ONE REAL AUDIT, AND NO NETWORK ANYWHERE. The audit comes from the 7C-6
 * harness with only the socket replaced, because a projection that reads
 * twenty measurement blocks needs twenty measurement blocks and a hand-built
 * fixture would be a fixture grown until it stopped throwing.
 *
 * TWO KINDS OF TEST, AND THE DIFFERENCE MATTERS. Most hand in the fake
 * provider that ships beside the seam, which is what makes them tests of this
 * route's decisions rather than of an email service. The last section hands in
 * nothing at all, so the route builds the real adapter the way production does
 * -- against a fetch that answers from memory and a key that belongs to
 * nobody. Neither kind needs a key and neither can reach a service; a tripwire
 * installed over the global `fetch` proves the second claim rather than
 * asserting it.
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
import { RESEND_API_KEY_VARIABLE, RESEND_ENDPOINT } from "../email/resend.ts";
import { codeOnly } from "../email/provider.test.mts";
import { GLOBAL_SENDS, MAX_SENDS, SEND_RATE_LIMITED, recordSend, resetSendLimit, sendAllowance } from "../email/sendLimit.ts";
import { UNATTRIBUTED } from "../callerAddress.ts";
import { contentFingerprint, type SendContent } from "../report/sendGate.ts";
import { sendBody } from "../report/sendRequest.ts";
import { withoutCredentials } from "../collector/url.ts";
import { SESSION_COOKIE, signSession } from "../auth/session.ts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

const FAKE_PDF = Buffer.from("%PDF-1.4\nfake\n%%EOF\n", "latin1");
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const FROM = "reports@skybook.example";
const RECIPIENT = "ana@harbourdental.example";
const NOW = 1_757_000_000_000;
const USER_ID = "11111111-1111-1111-1111-111111111111";

/** The ACTIVE account whose cookie a signed-in request carries. */
const ACTIVE_USER = {
  id: USER_ID,
  email: "sam@skybook.example",
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

/** A fake database returning the account for its own id, for the guard. */
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
        ? { cookie: `${SESSION_COOKIE}=${signSession(USER_ID, "SALES", { secret: SECRET }, NOW)}` }
        : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const deps = (extra: Record<string, unknown> = {}) => ({
  secret: SECRET,
  from: FROM,
  now: NOW,
  db: dbReturning(ACTIVE_USER),
  ...extra,
});

/* ---------------------------------------------------------------------------
   Nothing in this file may reach the network

   THE ROUTE BUILDS A REAL ADAPTER when no fake is handed in -- that is what
   wiring means -- and a developer's machine may well have a key sitting in its
   environment. A convention would not survive that; a tripwire does. Every
   test below either hands in a fake provider or installs its own answering
   fetch, and anything that does neither is caught here rather than costing
   money and delivering mail to somebody.
   --------------------------------------------------------------------------- */

const env = process.env as Record<string, string | undefined>;

/** Shaped like a key and belonging to nobody. No test needs a real one. */
const FAKE_KEY = "re_not_a_real_key_0123456789";

/** Every address any test opened. Read at the end of the file; must be empty. */
const reachedNetwork: string[] = [];

const tripwire = (async (input: RequestInfo | URL) => {
  reachedNetwork.push(String(input));
  throw new Error("a test reached the network");
}) as unknown as typeof fetch;

globalThis.fetch = tripwire;

const accepted = (body: unknown = { id: "receipt-from-the-service" }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function restoreEnvironment(previousKey: string | undefined) {
  globalThis.fetch = tripwire;
  if (previousKey === undefined) delete env[RESEND_API_KEY_VARIABLE];
  else env[RESEND_API_KEY_VARIABLE] = previousKey;
}

/**
 * A server that is configured to send, whose fetch answers from memory.
 *
 * THE KEY IS SET AND THE SOCKET IS NOT. Together those let a test drive the
 * production path -- no provider handed in, the route building its own -- and
 * still see exactly what would have gone on the wire.
 */
function wiredResend(answer: () => Response | Promise<Response> = () => accepted()) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const previousKey = env[RESEND_API_KEY_VARIABLE];

  env[RESEND_API_KEY_VARIABLE] = FAKE_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as unknown as typeof fetch;

  return { calls, restore: () => restoreEnvironment(previousKey) };
}

/**
 * A server with no key, whatever this machine happens to have in its
 * environment. The fetch is left as the tripwire on purpose: a send that is
 * refused for want of configuration must not open anything at all.
 */
function unconfiguredResend() {
  const previousKey = env[RESEND_API_KEY_VARIABLE];
  delete env[RESEND_API_KEY_VARIABLE];

  return { restore: () => restoreEnvironment(previousKey) };
}

/** The request body the wired adapter put on the wire. */
const wireBody = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as {
    from: string;
    to: string;
    subject: string;
    attachments: { filename: string; content: string }[];
  };

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

test("a server that is not set up to send refuses rather than quietly succeeding", async () => {
  /*
   * NO PROVIDER HANDED IN AND NO KEY TO BUILD ONE WITH. A route that reported
   * success while doing nothing would be the worst possible version of this
   * feature.
   *
   * THE KEY IS CLEARED EXPLICITLY rather than assumed absent. This test used
   * to pass because the machine running it happened to have no key, which
   * meant it proved nothing on a machine that did -- and on that machine it
   * would have opened a real connection to find out.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const resend = unconfiguredResend();

  try {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
      deps({ store, render: recordingRenderer().render }),
    );

    assert.equal(result.ok === false && result.status, 503);
    assert.equal(result.ok === false && result.error, SEND_FAILURE_MESSAGES["not-configured"]);
  } finally {
    resend.restore();
  }
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

test("sending stores nothing, and knows the adapter's name but none of its workings", async () => {
  /*
   * THIS TEST USED TO FORBID THE ADAPTER'S NAME ENTIRELY, and that stopped
   * being the right question the moment the route was wired: naming the
   * provider it falls back to is what wiring IS. What must still hold is that
   * the route knows nothing about how that provider works. It has no endpoint,
   * no key, no header and no notion of HTTP, so swapping the adapter for
   * another service touches this file's one import and nothing else.
   */
  const source = read();

  for (const forbidden of [
    "api.resend.com",
    "RESEND_API_KEY",
    "Bearer",
    "Authorization",
    "fetch(",
    "base64",
    "postgres",
    "prisma",
    "writeFile",
    "localStorage",
  ]) {
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

  // Trusted proxy, so the caller key is the forwarded address and this test can
  // speak about "that caller's" allowance. The default posture is covered on
  // its own below.
  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.8.1"),
    deps({ store, render: recordingRenderer().render, provider: mail.provider, trustProxy: true }),
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

/* ---------------------------------------------------------------------------
   The wiring: the provider nobody passed in

   EVERY TEST ABOVE HANDS IN A FAKE, which is what makes them tests of this
   route's decisions rather than of an email service. Not one of them would
   notice if the line that builds the real adapter were deleted tomorrow.
   These would. None of them passes a provider, so what runs is the production
   path exactly as a salesperson's request runs it, with a fetch that answers
   from memory where the socket would be.
   --------------------------------------------------------------------------- */

test("a confirmed send reaches the configured provider, with no provider handed in", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();
  const resend = wiredResend();

  try {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
      deps({ store, render: renderer.render }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.recipient, RECIPIENT);

    assert.equal(resend.calls.length, 1, "one request, not two");
    assert.equal(resend.calls[0].url, RESEND_ENDPOINT);
    assert.equal(resend.calls[0].init?.method, "POST");

    /*
     * AND IT IS THE REPORT, not a second document composed on the way. The
     * bytes the renderer produced are the bytes on the wire.
     */
    const body = wireBody(resend.calls[0].init);
    assert.equal(body.to, RECIPIENT);
    assert.equal(body.from, FROM);
    assert.deepEqual(Buffer.from(body.attachments[0].content, "base64"), FAKE_PDF);
  } finally {
    resend.restore();
  }
});

test("a server with no key fails closed, before a browser is ever launched", async () => {
  /*
   * THE COST OF THE REFUSAL, not just the refusal. The adapter would refuse
   * perfectly well on its own -- but only after a headless browser had
   * typeset a report for a client who was never going to receive it.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();
  const resend = unconfiguredResend();

  try {
    const result = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
      deps({ store, render: renderer.render }),
    );

    assert.equal(result.ok === false && result.status, 503);
    assert.equal(result.ok === false && result.error, SEND_FAILURE_MESSAGES["not-configured"]);
    assert.equal(renderer.seen.length, 0, "nothing was typeset");
    assert.deepEqual(reachedNetwork, [], "and nothing was opened");
    assert.equal(remaining("1.2.3.4"), MAX_SENDS, "a server that cannot send spends nothing");
  } finally {
    resend.restore();
  }
});

test("what the service refuses comes back as our failure, never in its own words", async () => {
  /*
   * THE MAPPING IS THE ADAPTER'S AND THE STATUS IS THIS ROUTE'S, and this is
   * the only place both run together. 401 becoming 503 matters: a key that is
   * revoked between the early check and the send must not suddenly read to a
   * salesperson as something wrong with what they wrote.
   */
  for (const [serviceStatus, ourStatus, failure] of [
    [401, 503, "not-configured"],
    [422, 502, "rejected"],
    [429, 429, "rate-limited"],
    [500, 502, "provider-error"],
  ] as const) {
    resetSendLimit();
    const { store, jobId } = storeWith("completed");
    const resend = wiredResend(() =>
      accepted(
        {
          name: "validation_error",
          message: "The from address reports@skybook.example is not verified",
          request_id: "req_abc123",
        },
        serviceStatus,
      ),
    );

    try {
      const result = await sendReportRoute(
        request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }),
        deps({ store, render: recordingRenderer().render }),
      );

      assert.equal(result.ok, false, String(serviceStatus));
      assert.equal(result.ok === false && result.status, ourStatus, String(serviceStatus));
      assert.equal(
        result.ok === false && result.error,
        SEND_FAILURE_MESSAGES[failure],
        String(serviceStatus),
      );

      const serialised = JSON.stringify(result);
      for (const leak of ["validation_error", "not verified", "req_abc123", FAKE_KEY]) {
        assert.ok(!serialised.includes(leak), `must not carry ${leak}`);
      }
    } finally {
      resend.restore();
    }
  }
});

test("a send the service accepts spends exactly one allowance", async () => {
  // Trusted proxy, so the address is the caller key; see the note above.
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const resend = wiredResend();

  try {
    const result = await sendReportRoute(
      request(
        { jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) },
        true,
        "7.7.9.1",
      ),
      deps({ store, render: recordingRenderer().render, trustProxy: true }),
    );

    assert.equal(result.ok, true);
    assert.equal(resend.calls.length, 1);
    assert.equal(remaining("7.7.9.1"), MAX_SENDS - 1, "exactly one, not two and not none");
  } finally {
    resend.restore();
  }
});

test("a send the service refuses spends nothing", async () => {
  /*
   * The allowance counts what reached a client's inbox. A provider that said
   * no put nothing there, and the salesperson must be able to fix whatever it
   * objected to and try again.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const resend = wiredResend(() => accepted({ message: "the service said no" }, 500));

  try {
    const result = await sendReportRoute(
      request(
        { jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) },
        true,
        "7.7.9.2",
      ),
      deps({ store, render: recordingRenderer().render }),
    );

    assert.equal(result.ok, false);
    assert.equal(resend.calls.length, 1, "asked once, and not asked again");
    assert.equal(remaining("7.7.9.2"), MAX_SENDS, "nothing arrived, nothing was spent");
  } finally {
    resend.restore();
  }
});

test("a stranger and a stale confirmation still reach no provider once one is wired", async () => {
  /*
   * THE FAILURE THIS CATCHES is a provider reached before the guards have had
   * their say. Both refusals are already proved against a fake above; what is
   * new is that they are now proved against the line that opens connections.
   */
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const confirmed = confirmationFor(store, jobId);
  const renderer = recordingRenderer();
  const resend = wiredResend();

  try {
    const stranger = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: confirmed }, false),
      deps({ store, render: renderer.render }),
    );
    const stale = await sendReportRoute(
      request({ jobId, recipient: RECIPIENT, confirmedFor: "a-fingerprint-from-an-older-page" }),
      deps({ store, render: renderer.render }),
    );

    assert.equal(stranger.ok === false && stranger.status, 401);
    assert.equal(stale.ok === false && stale.status, 409);
    assert.equal(stale.ok === false && stale.error, NOT_CONFIRMED);

    assert.equal(resend.calls.length, 0, "the service was never asked");
    assert.equal(renderer.seen.length, 0, "and no browser was launched for either");
  } finally {
    resend.restore();
  }
});

test("no test in this file reached the network", async () => {
  /*
   * THE TRIPWIRE, READ LAST. It has been the global `fetch` since before the
   * first test ran, so any test that built a real adapter against a real key
   * -- a developer's own key, sitting in the environment -- would have opened
   * a connection and left its address here. Nothing did.
   *
   * The second assertion is the one that keeps the first honest: a test that
   * installed its own fetch and forgot to put the tripwire back would have
   * disarmed every test after it.
   */
  assert.deepEqual(reachedNetwork, [], "something opened a connection");
  assert.equal(globalThis.fetch, tripwire, "and every test put the global back");
});


/* ---------------------------------------------------------------------------
   The browser's half and this route's half, meeting

   EVERY OTHER TEST IN THIS FILE BUILDS ITS CONFIRMATION WITH `confirmationFor`,
   which reads the audited address out of the DOCUMENT -- the server's own side
   of the agreement. That proves this route is self-consistent and proves
   nothing about the page, which reads that address from the audit result and
   composes the request itself. If the two ever disagree about one string,
   every send is refused as unconfirmed, the preview looks perfectly right, and
   nothing on screen explains why.

   So these build the request the way the BROWSER builds it, out of the modules
   the browser actually imports, and hand it to the route unchanged.
   --------------------------------------------------------------------------- */

/** The address the page hands the send panel, derived as `AuditPage` derives it. */
const pageAuditedUrl = () => withoutCredentials(REAL_AUDIT.data.fetch.finalUrl);

test("a confirmation composed in the browser is accepted by this route", async () => {
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const browserContent: SendContent = {
    jobId,
    recipient: `  ${RECIPIENT}  `,
    auditedUrl: pageAuditedUrl(),
    companyName: "Harbour Dental",
    contactName: "Ana",
    preparedBy: "Sam",
  };

  const result = await sendReportRoute(
    request(sendBody(browserContent, contentFingerprint(browserContent))),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok, true, result.ok === false ? result.error : "");
  assert.equal(mail.sent.length, 1, "the report reached the provider");
  assert.equal(mail.sent[0].to, RECIPIENT, "trimmed on both sides, identically");
});

test("the address the page fingerprints is the address the cover carries", () => {
  /*
   * The same claim as a value rather than as a round trip, so a failure says
   * which string differed rather than only that a send was refused.
   */
  const { store, jobId } = storeWith("completed");
  const outcome = buildPdfDocument(jobId, store, {});

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(pageAuditedUrl(), outcome.document.cover.auditedUrl);
});

test("no client-visible confirmation can carry a credential-bearing address", () => {
  /*
   * Measured, not assumed. Stripping is not a no-op, so if the page ever
   * stopped stripping, the two sides would silently disagree for exactly the
   * sites where the address must not be shown to a client in the first place.
   */
  assert.equal(withoutCredentials("https://user:pass@example.com/"), "https://example.com/");
  assert.ok(!pageAuditedUrl().includes("@"), "and the address in play carries none");
});

/* ---------------------------------------------------------------------------
   The header-rotation bypass, closed at the send endpoint
   --------------------------------------------------------------------------- */

test("by default a send is counted against the shared bucket, not a header's address", async () => {
  // The default posture: the forwarded address is not trusted, so the send is
  // recorded against the one shared caller regardless of what the header says.
  resetSendLimit();
  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();

  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "7.7.8.1"),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok, true);
  assert.equal(remaining(UNATTRIBUTED), MAX_SENDS - 1, "spent against the shared bucket");
  assert.equal(remaining("7.7.8.1"), MAX_SENDS, "and not against the header's claimed address");
});

test("rotating the forwarded header no longer buys unlimited sends", async () => {
  // The bypass: a changing address used to look like a fresh caller each time.
  // Now the global ceiling bounds the server whatever the header says.
  resetSendLimit();
  // Fill the server-wide ceiling from other callers first.
  for (let i = 0; i < GLOBAL_SENDS; i += 1) recordSend(`203.0.113.${i}`, NOW);

  const { store, jobId } = storeWith("completed");
  const mail = fakeProvider();
  const result = await sendReportRoute(
    request({ jobId, recipient: RECIPIENT, confirmedFor: confirmationFor(store, jobId) }, true, "9.9.9.9"),
    deps({ store, render: recordingRenderer().render, provider: mail.provider }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.error, SEND_RATE_LIMITED);
  assert.equal(mail.sent.length, 0, "nothing left the building");
});
