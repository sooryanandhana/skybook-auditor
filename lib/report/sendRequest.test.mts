/**
 * Tests for the results page's send button.
 *
 * WHAT IS ACTUALLY BEING TESTED. The button is a few lines of JSX and this
 * project has no browser to render it in. Everything the button DECIDES was
 * put in `sendRequest.ts` for exactly that reason -- which fields cross to the
 * server, whether a second click may start a second send, which sentence a
 * refusal produces, what becomes of a confirmation afterwards -- so these
 * drive the same functions the component calls, with a fetch that answers from
 * memory.
 *
 * NOTHING HERE REACHES THE NETWORK OR AN EMAIL SERVICE. Every request is
 * answered by a function, and the endpoint these would post to is our own; the
 * provider, its key and the sending address exist only on the far side of it
 * and are asserted absent from everything in the browser's half.
 *
 * The claims that cannot be driven, because they are about what the code has
 * no way to do, are asserted against the source at the bottom.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  SEND_BUSY_LABEL,
  SEND_ENDPOINT,
  SEND_FAILED,
  SEND_READY,
  SEND_UNCONFIRMED,
  SEND_UNREACHABLE,
  confirmBox,
  runSend,
  sendBody,
  sendButton,
  sendReport,
  sentNote,
  type SendState,
} from "./sendRequest.ts";
import { codeOnly } from "../email/provider.test.mts";
import { withoutCredentials } from "../collector/url.ts";
import { UNAUTHORISED } from "../auth/guard.ts";
import { SEND_FAILURE_MESSAGES } from "../email/provider.ts";
import { SEND_RATE_LIMITED } from "../email/sendLimit.ts";
import {
  SEND_LABEL,
  UNCONFIRMED,
  confirm,
  contentFingerprint,
  type SendContent,
  type SendGate,
} from "./sendGate.ts";

const AUDITED = "https://harbourdental.example/";
const RECIPIENT = "ana@harbourdental.example";

const content = (over: Partial<SendContent> = {}): SendContent => ({
  jobId: "job-abc",
  recipient: RECIPIENT,
  auditedUrl: AUDITED,
  ...over,
});

/** One request, remembered rather than sent. */
interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: Record<string, unknown>;
}

/** A fetch that answers with whatever is handed to it, and keeps the asking. */
function recordingFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return answer();
  }) as unknown as typeof fetch;

  return { sent, fetchImpl };
}

const accepted = (recipient = RECIPIENT) =>
  new Response(JSON.stringify({ ok: true, recipient }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const refusal = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The gate a person leaves behind by ticking the box on this content. */
const confirmed = (over: Partial<SendContent> = {}) => confirm(content(over));

/** A recorder for the two setters the component hands in. */
function panel(state: SendState = SEND_READY, gate: SendGate = UNCONFIRMED) {
  const states: SendState[] = [];
  const gates: SendGate[] = [];

  return {
    get state() {
      return states.length === 0 ? state : states[states.length - 1];
    },
    get gate() {
      return gates.length === 0 ? gate : gates[gates.length - 1];
    },
    states,
    gates,
    handlers: {
      onState: (next: SendState) => states.push(next),
      onGate: (next: SendGate) => gates.push(next),
    },
  };
}

/* ---------------------------------------------------------------------------
   What crosses to the server
   --------------------------------------------------------------------------- */

test("the request carries exactly the fields the send contract reads", () => {
  /*
   * THE LIST IS THE TEST. A field added here without the endpoint reading it
   * would be typed into and silently dropped; a field the endpoint reads and
   * this omits would be a send that can never be confirmed.
   */
  const body = sendBody(
    content({ companyName: "Harbour Dental", contactName: "Ana", preparedBy: "Sam" }),
    "a-fingerprint",
  );

  assert.deepEqual(Object.keys(body).sort(), [
    "companyName",
    "confirmedFor",
    "contactName",
    "jobId",
    "preparedBy",
    "recipient",
  ]);
});

test("the audited address is never sent, so no caller can supply its own", () => {
  /*
   * THE PROTECTION THIS PROTECTS. The server takes the audited address from
   * the document it built, precisely so a request cannot carry one that makes
   * its own fingerprint fit. Spreading `SendContent` into the body would hand
   * that address over by accident, which is why the body is built field by
   * field.
   */
  const body = sendBody(content(), "a-fingerprint");

  assert.equal("auditedUrl" in body, false);
  assert.ok(!JSON.stringify(body).includes(AUDITED), "not under any other name either");
});

test("the browser sends no sender, no key and no provider configuration", () => {
  const body = sendBody(
    content({ companyName: "Harbour Dental", contactName: "Ana", preparedBy: "Sam" }),
    "a-fingerprint",
  );

  for (const forbidden of ["from", "sender", "apiKey", "key", "provider", "subject", "attachment", "text"]) {
    assert.equal(forbidden in body, false, `the browser must not supply ${forbidden}`);
  }
});

test("an empty client field is left out rather than sent as nothing", () => {
  const body = sendBody(content({ companyName: "   ", contactName: undefined }), "f");

  assert.equal("companyName" in body, false);
  assert.equal("contactName" in body, false);
});

test("a padded address is trimmed the way the server trims it", () => {
  // Otherwise the fingerprint the browser computed and the one the server
  // recomputes would differ over whitespace nobody can see.
  const body = sendBody(content({ recipient: `  ${RECIPIENT}  ` }), "f");

  assert.equal(body.recipient, RECIPIENT);
});

test("one POST, to our own endpoint and nowhere else", async () => {
  const { sent, fetchImpl } = recordingFetch(() => accepted());

  await sendReport(content(), contentFingerprint(content()), { fetchImpl });

  assert.equal(sent.length, 1, "one request, not two");
  assert.equal(sent[0].url, SEND_ENDPOINT);
  assert.equal(sent[0].method, "POST");
  assert.ok(SEND_ENDPOINT.startsWith("/api/"), "our own server, relative");
});

/* ---------------------------------------------------------------------------
   What comes back
   --------------------------------------------------------------------------- */

test("an accepted send reports the address the server says it used", async () => {
  const { fetchImpl } = recordingFetch(() => accepted("ana@harbourdental.example"));

  const outcome = await sendReport(content(), "f", { fetchImpl });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.recipient, "ana@harbourdental.example");
});

test("every refusal is quoted in the endpoint's own words", async () => {
  /*
   * Each of these was written for a person to read, and the server already
   * guarantees that nothing internal is in them. Wording them again here
   * would be a second copy that drifts from the first.
   */
  for (const [status, sentence] of [
    [401, UNAUTHORISED],
    [400, "Enter the client's email address before sending."],
    [409, "This report was changed after it was confirmed. Read it again and confirm before sending."],
    [503, SEND_FAILURE_MESSAGES["not-configured"]],
    [502, SEND_FAILURE_MESSAGES["provider-error"]],
    [429, SEND_RATE_LIMITED],
  ] as const) {
    const { fetchImpl } = recordingFetch(() => refusal(status, sentence));

    const outcome = await sendReport(content(), "f", { fetchImpl });

    assert.equal(outcome.ok, false, String(status));
    assert.equal(outcome.ok === false && outcome.message, sentence, String(status));
  }
});

test("an answer that is not ours gets our own sentence, never its body", async () => {
  /*
   * A proxy's error page, a gateway's HTML, a body carrying a request id.
   * None of it was written to be read by anybody here.
   */
  for (const body of ["<html>502 Bad Gateway</html>", JSON.stringify({ request_id: "req_abc123" })]) {
    const { fetchImpl } = recordingFetch(() => new Response(body, { status: 502 }));

    const outcome = await sendReport(content(), "f", { fetchImpl });

    assert.equal(outcome.ok === false && outcome.message, SEND_FAILED);
    assert.ok(!JSON.stringify(outcome).includes("req_abc123"));
    assert.ok(!JSON.stringify(outcome).includes("Bad Gateway"));
  }
});

test("a server that cannot be reached says so, and says nothing was sent", async () => {
  const refused = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  const outcome = await sendReport(content(), "f", { fetchImpl: refused });

  assert.equal(outcome.ok === false && outcome.message, SEND_UNREACHABLE);
  assert.match(SEND_UNREACHABLE, /nothing was sent/);
});

test("a sentence claims nothing was sent only when nothing was sent", () => {
  /*
   * THREE STATES, NOT TWO, and this test used to assert two. The two where
   * the request never got past this browser say so outright. The third is the
   * one where we genuinely do not know -- our own server answered, and the
   * answer could not be read -- and it must not claim either way.
   */
  assert.match(SEND_FAILED, /Nothing reached the client/);
  assert.match(SEND_UNREACHABLE, /nothing was sent/);

  assert.match(SEND_UNCONFIRMED, /unknown/);
  assert.ok(!/nothing was sent/i.test(SEND_UNCONFIRMED), "it does not claim nothing went");
  assert.ok(!/\bsent to\b/i.test(SEND_UNCONFIRMED), "and does not claim anything did");
  assert.match(SEND_UNCONFIRMED, /before sending it again/, "it says what to do");
});

test("a 2xx that is not our own answer is never reported as a send", async () => {
  /*
   * THE DEFECT A REVIEW MEASURED, PINNED SO IT CANNOT COME BACK.
   *
   * `response.ok` alone was the whole test for success, and the recipient fell
   * back to the address in the box when the body carried none. Together those
   * turned ANY 2xx -- a captive portal's HTML, a proxy's JSON, an empty 204 --
   * into "Sent to ana@harbourdental.example. There is no unsend." A send this
   * application cannot evidence is not a send it may claim.
   */
  const notOurs = [
    new Response("<html>Sign in to the wifi</html>", { status: 200 }),
    new Response(JSON.stringify({ status: "queued" }), { status: 200 }),
    new Response(JSON.stringify({ ok: false, error: "our shape, wrong status" }), { status: 200 }),
    new Response(null, { status: 204 }),
  ];

  for (const answer of notOurs) {
    const { fetchImpl } = recordingFetch(() => answer.clone());

    const outcome = await sendReport(content(), "f", { fetchImpl });

    assert.equal(outcome.ok, false, "a 2xx we cannot read is not a success");
    assert.equal(outcome.ok === false && outcome.message, SEND_UNCONFIRMED);
    assert.ok(!JSON.stringify(outcome).includes(RECIPIENT), "and names nobody");
  }
});

test("a refusal is quoted only when it is ours to quote", async () => {
  /*
   * THE SECOND HALF OF THE SAME DEFECT. A bare `error` field was quoted from
   * whatever came back, so a gateway answering 502 with its own JSON printed
   * an internal address and port onto the page. Our endpoint always sends
   * `ok` beside its sentence; nothing else does.
   */
  const { fetchImpl } = recordingFetch(
    () => new Response(JSON.stringify({ error: "upstream connect error to 10.0.0.5:443" }), { status: 502 }),
  );

  const outcome = await sendReport(content(), "f", { fetchImpl });

  assert.equal(outcome.ok === false && outcome.message, SEND_FAILED);
  assert.ok(!JSON.stringify(outcome).includes("10.0.0.5"), "no internal address reaches the page");
});

test("our own answers are still believed, both of them", async () => {
  // The fix must not have made the endpoint's real answers unreadable.
  const sent = await sendReport(content(), "f", {
    fetchImpl: recordingFetch(() => accepted()).fetchImpl,
  });
  assert.equal(sent.ok === true && sent.recipient, RECIPIENT);

  const refused = await sendReport(content(), "f", {
    fetchImpl: recordingFetch(() => refusal(409, "This report was changed.")).fetchImpl,
  });
  assert.equal(refused.ok === false && refused.message, "This report was changed.");
});

/* ---------------------------------------------------------------------------
   One press of the button
   --------------------------------------------------------------------------- */

test("a confirmed press asks the server and reports what happened", async () => {
  const { sent, fetchImpl } = recordingFetch(() => accepted());
  const ui = panel();

  await runSend(SEND_READY, confirmed(), content(), ui.handlers, { fetchImpl });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.confirmedFor, contentFingerprint(content()));
  assert.deepEqual(ui.states.map((s) => s.kind), ["sending", "sent"]);
  assert.equal(ui.state.kind === "sent" && ui.state.recipient, RECIPIENT);
});

test("an unconfirmed press asks nothing at all", async () => {
  /*
   * THE GATE, ASKED AGAIN AT THE MOMENT OF THE PRESS rather than trusted from
   * the render. The disabled attribute is a rendering and a render can lag a
   * click.
   */
  const { sent, fetchImpl } = recordingFetch(() => accepted());
  const ui = panel();

  await runSend(SEND_READY, UNCONFIRMED, content(), ui.handlers, { fetchImpl });

  assert.equal(sent.length, 0, "nothing was asked");
  assert.deepEqual(ui.states, [], "and nothing moved");
});

test("a confirmation for different content does not carry over to a press", async () => {
  // Somebody confirms, then edits the address. What they agreed to is gone.
  const { sent, fetchImpl } = recordingFetch(() => accepted());
  const ui = panel();

  await runSend(
    SEND_READY,
    confirmed(),
    content({ recipient: "someone@else.example" }),
    ui.handlers,
    { fetchImpl },
  );

  assert.equal(sent.length, 0);
});

test("a second press while one is in flight cannot start a second send", async () => {
  /*
   * THE DOUBLE CLICK. Two requests would be two emails in a client's inbox,
   * and there is no unsend for either of them.
   */
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sent, fetchImpl } = recordingFetch(async () => {
    await held;
    return accepted();
  });

  const ui = panel();
  const gate = confirmed();

  const first = runSend(SEND_READY, gate, content(), ui.handlers, { fetchImpl });
  const second = runSend(ui.state, gate, content(), ui.handlers, { fetchImpl });

  assert.equal(ui.state.kind, "sending", "the button is busy before the answer arrives");

  release();
  await Promise.all([first, second]);

  assert.equal(sent.length, 1, "one request, not two");
});

test("a press after a successful send cannot send the same report again", async () => {
  const { sent, fetchImpl } = recordingFetch(() => accepted());
  const ui = panel();
  const gate = confirmed();

  await runSend(SEND_READY, gate, content(), ui.handlers, { fetchImpl });
  await runSend(ui.state, gate, content(), ui.handlers, { fetchImpl });

  assert.equal(sent.length, 1, "the second press did nothing");
});

test("a send that succeeded spends the confirmation", async () => {
  /*
   * A standing agreement after the email has gone would be an agreement to
   * send it again, which is not what anybody ticked a box for.
   */
  const { fetchImpl } = recordingFetch(() => accepted());
  const ui = panel();

  await runSend(SEND_READY, confirmed(), content(), ui.handlers, { fetchImpl });

  assert.equal(ui.gates.length, 1);
  assert.equal(ui.gate.confirmedFor, null, "the box unticks");
});

test("a send that failed leaves the confirmation standing, and may be pressed again", async () => {
  /*
   * Nothing reached the client and the content has not changed. Making
   * somebody re-read an unchanged report to retry a rate-limited send is how
   * people learn to tick without reading.
   */
  const answers = [refusal(429, "Too many reports have been sent from here."), accepted()];
  const { sent, fetchImpl } = recordingFetch(() => answers.shift()!);
  const ui = panel();
  const gate = confirmed();

  await runSend(SEND_READY, gate, content(), ui.handlers, { fetchImpl });
  const refused = ui.state;

  assert.equal(refused.kind, "failed");
  assert.deepEqual(ui.gates, [], "the confirmation was not withdrawn");

  await runSend(refused, gate, content(), ui.handlers, { fetchImpl });

  assert.equal(sent.length, 2, "the second press was allowed");
  assert.equal(ui.state.kind, "sent");
});

/* ---------------------------------------------------------------------------
   What the button says
   --------------------------------------------------------------------------- */

test("the button is shut until somebody has confirmed", () => {
  assert.equal(sendButton(SEND_READY, false).disabled, true);
  assert.equal(sendButton(SEND_READY, true).disabled, false);
});

test("the button says what it is doing while it does it", () => {
  const busy = sendButton({ kind: "sending" }, true);

  assert.equal(busy.label, SEND_BUSY_LABEL);
  assert.equal(busy.disabled, true);
  assert.equal(sendButton(SEND_READY, true).label, SEND_LABEL);
});

test("the button stays shut after the report has gone", () => {
  // Even with a confirmation still standing, which it will not be.
  assert.equal(sendButton({ kind: "sent", recipient: RECIPIENT }, true).disabled, true);
});

test("a failure does not lock the button", () => {
  assert.equal(sendButton({ kind: "failed", message: SEND_FAILED }, true).disabled, false);
});

test("what is said afterwards names the address and warns there is no unsend", () => {
  const note = sentNote(RECIPIENT);

  assert.match(note, /ana@harbourdental\.example/);
  assert.match(note, /no unsend/);
});

/* ---------------------------------------------------------------------------
   What the browser's half cannot do, asserted against the source

   Code rather than prose: a comment explaining an absence is not the thing.
   --------------------------------------------------------------------------- */

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

const raw = () => read("./sendRequest.ts") + read("../../app/ReportSend.tsx");

/*
 * COMMENTS STRIPPED BEFORE ASKING WHAT THE CODE CONTAINS, because this project
 * has been caught by the difference five times. A file that explains at length
 * why it does not retry contains the word "retry"; a comment saying no request
 * id is returned contains "id:". Both are the opposite of the defect.
 */
const browserHalf = () => codeOnly(raw());

test("nothing in the browser knows a provider, a key or a sending address", () => {
  /*
   * THE WHOLE POINT OF THE SPLIT. The server is the only place that knows how
   * mail is sent or whether it can be; the browser learns even "this server
   * is not set up" as a sentence, not as a fact about configuration.
   */
  const source = browserHalf();

  for (const forbidden of [
    "resend",
    "Resend",
    "RESEND",
    "api.resend.com",
    "apiKey",
    "Authorization",
    "Bearer",
    "SKYBOOK_MAIL_FROM",
    "process.env",
    "smtp",
  ]) {
    assert.ok(!source.includes(forbidden), `the browser must not know ${forbidden}`);
  }
});

test("the only address the browser can post to is our own", () => {
  /*
   * ASKED OF THE RAW SOURCE, comments and all. `codeOnly` strips from a `//`
   * to the end of the line, which would turn every `https://x` into `https:`
   * and make this assertion pass by erasing what it looks for.
   */
  assert.equal((raw().match(/https?:\/\//g) || []).length, 0, "no absolute address anywhere");
  assert.equal((browserHalf().match(/await request\(/g) || []).length, 1, "one call site");
});

test("there is no retry, no queue and no timer behind the button", () => {
  /*
   * A second attempt at sending an email is how one report becomes two in a
   * client's inbox. The adapter on the server refuses to retry for the same
   * reason, only more so.
   */
  const source = browserHalf();

  for (const forbidden of ["retry", "retries", "backoff", "setInterval", "setTimeout", "queue"]) {
    assert.ok(!source.includes(forbidden), `the browser must not ${forbidden}`);
  }
});

test("the panel starts nothing: no audit, crawl, speed check or model", () => {
  const source = browserHalf();

  for (const forbidden of [
    "/api/audit",
    "startAudit",
    "runSiteAudit",
    "explainAudit",
    "gemini",
    "Gemini",
    "pagespeed",
    "PageSpeed",
  ]) {
    assert.ok(!source.includes(forbidden), `the send panel must not reach ${forbidden}`);
  }
});

test("nothing in the browser stores a client's address anywhere", () => {
  // An address book is the one thing this application has deliberately never
  // had. The address is typed, used once, and forgotten with the page.
  const source = browserHalf();

  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden), `the send panel must not use ${forbidden}`);
  }
});

test("nothing here writes to the console", () => {
  const source = browserHalf();

  for (const forbidden of ["console.log", "console.warn", "console.error"]) {
    assert.ok(!source.includes(forbidden), `must not ${forbidden}`);
  }
});

test("the panel decides nothing: every judgement comes from a tested module", () => {
  /*
   * The component holds state and renders it. If a decision ever moves into
   * the JSX it stops being reachable by any test in this project.
   */
  const panelSource = codeOnly(read("../../app/ReportSend.tsx"));

  for (const forbidden of ["fetch(", "JSON.stringify", "contentFingerprint("]) {
    assert.ok(!panelSource.includes(forbidden), `the panel must not do ${forbidden} itself`);
  }
});

/* ---------------------------------------------------------------------------
   The endpoint the browser posts to
   --------------------------------------------------------------------------- */

const endpoint = () => codeOnly(read("../../app/api/report/send/route.ts"));

test("the endpoint delegates to the tested orchestration and composes nothing", () => {
  /*
   * A second implementation of the send order -- the guard, the allowance, the
   * fingerprint, the render -- is a second implementation that can disagree
   * with the tested one. The adapter's whole job is translation.
   */
  const source = endpoint();

  assert.ok(source.includes("sendReportRoute(request)"), "it calls the tested function");

  for (const forbidden of [
    "buildPdfDocument",
    "renderPdf",
    "previewFor",
    "contentFingerprint",
    "recordSend",
    "sendAllowance",
    "resendProvider",
    "RESEND_API_KEY",
    "SKYBOOK_MAIL_FROM",
    "process.env",
  ]) {
    assert.ok(!source.includes(forbidden), `the endpoint must not reach ${forbidden}`);
  }
});

test("the endpoint answers with the address and nothing else", () => {
  const source = endpoint();

  for (const forbidden of ["id:", "receipt", "request_id", "console.log", "console.error"]) {
    assert.ok(!source.includes(forbidden), `the endpoint must not return or log ${forbidden}`);
  }
});

test("the endpoint runs where the renderer can run", () => {
  // A send drives the same headless browser the download does, which the edge
  // runtime cannot do. Next.js would otherwise be free to choose.
  assert.match(endpoint(), /export const runtime = "nodejs"/);
});

/* ---------------------------------------------------------------------------
   The address both sides fingerprint
   --------------------------------------------------------------------------- */

test("the page hands the panel the same address the report's cover carries", async () => {
  /*
   * THE TWO SIDES OF THE CONFIRMATION MUST AGREE ABOUT ONE STRING.
   *
   * The browser fingerprints the address it was given; the server rebuilds the
   * fingerprint from the address the DOCUMENT carries, which is the whole
   * reason a caller cannot supply one of their own. If those two differ, every
   * send of that report is refused as unconfirmed, and nothing on screen
   * explains why -- the preview looks right, the box is ticked, and the server
   * says the report was changed.
   *
   * They differ for exactly one input: a site reached through a URL carrying
   * credentials. The projection strips them; `data.fetch.finalUrl` as measured
   * does not. So the page strips them too, with the same function, and this
   * pins that rather than trusting that such a URL never reaches here.
   */
  const source = read("../../app/AuditPage.tsx");

  assert.ok(
    source.includes("auditedUrl={withoutCredentials(data.fetch.finalUrl)}"),
    "the page strips credentials the way the document does",
  );

  // And the same helper, not a second implementation of it.
  const projection = read("../audit/pdfDocument.ts");
  assert.ok(
    projection.includes("auditedUrl: withoutCredentials(data.fetch.finalUrl)"),
    "which is exactly what the projection does",
  );
});

test("stripping credentials is not a no-op, which is why it must be on both sides", () => {
  // Measured rather than assumed: this was checked before the call site was
  // changed, because "it probably never differs" is how the bug survives.
  assert.equal(withoutCredentials("https://example.com/"), "https://example.com/");
  assert.equal(withoutCredentials("https://user:pass@example.com/"), "https://example.com/");
});

/* ---------------------------------------------------------------------------
   Whether the box may still be ticked
   --------------------------------------------------------------------------- */

test("the confirmation cannot be given again once the report has gone", () => {
  /*
   * THE ATTESTATION IS SPENT BY THE SEND. Leaving the box tickable afterwards
   * offered an agreement that could authorise nothing: the press it would
   * unlock is shut, and the tick would sit there meaning nothing beside a
   * "Sent to…" line. A box that cannot confirm is the same mistake as a Send
   * that cannot send.
   */
  assert.equal(confirmBox({ kind: "sent", recipient: RECIPIENT }, true).disabled, true);
});

test("a failed send leaves the confirmation there to act on", () => {
  /*
   * Nothing reached the client and the content has not changed, so the
   * standing confirmation is still about what is still being sent. The person
   * must be able to withdraw it, or leave it and press again.
   */
  assert.equal(confirmBox({ kind: "failed", message: SEND_FAILED }, true).disabled, false);
});

test("before and during a send the box behaves exactly as it did", () => {
  // The change was meant to add one state, not to alter the other three.
  assert.equal(confirmBox(SEND_READY, true).disabled, false, "there is something to confirm");
  assert.equal(confirmBox(SEND_READY, false).disabled, true, "no address yet, no email to read");
  assert.equal(confirmBox({ kind: "sending" }, true).disabled, true, "what is going is decided");
  assert.equal(confirmBox({ kind: "sending" }, false).disabled, true);
});

test("the box and the button shut together once the report has gone", () => {
  /*
   * The pair is the point. A live box beside a dead button, or the reverse,
   * reads as a fault rather than as a finished send.
   */
  const sent: SendState = { kind: "sent", recipient: RECIPIENT };

  assert.equal(confirmBox(sent, true).disabled, true);
  assert.equal(sendButton(sent, true).disabled, true);
});

test("the panel asks for the box's state rather than working it out", () => {
  // The component holds state and renders it; this is the judgement, and it
  // lives where a test can reach it without a browser.
  const panelSource = codeOnly(read("../../app/ReportSend.tsx"));

  assert.ok(panelSource.includes("confirmBox(state, ready)"), "it asks");
  assert.ok(
    !/disabled=\{!ready/.test(panelSource),
    "and does not decide the box's state inline",
  );
});
