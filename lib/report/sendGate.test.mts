/**
 * Tests for the gate between a finished report and sending it.
 *
 * WHAT IS ACTUALLY BEING TESTED. Not a checkbox: a checkbox is a rendering and
 * this project has already watched a disabled button be the only thing between
 * a second click and a second request. What is tested here is the rule behind
 * it, which is the thing a later send has to ask.
 *
 * THE INTERESTING TESTS ARE THE NEGATIVE ONES. Anybody can prove that pressing
 * confirm confirms. The ones worth writing are the six or seven things that
 * look like consent and are not.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  CONFIRM_LABEL,
  SEND_INTRO,
  UNCONFIRMED,
  canConfirm,
  canSend,
  confirm,
  contentFingerprint,
  previewFor,
  usableRecipient,
  withdraw,
  type SendContent,
} from "./sendGate.ts";

const content = (over: Partial<SendContent> = {}): SendContent => ({
  jobId: "job-1",
  recipient: "ana@harbourdental.example",
  auditedUrl: "https://harbourdental.example/",
  ...over,
});

/* ---------------------------------------------------------------------------
   Where a finished report starts
   --------------------------------------------------------------------------- */

test("a completed report starts unconfirmed", () => {
  // The gate is shut by construction, not shut by something remembering to
  // shut it.
  assert.equal(UNCONFIRMED.confirmedFor, null);
  assert.equal(canSend(UNCONFIRMED, content()), false);
});

test("nothing about a report existing makes it sendable", () => {
  for (const audit of [content(), content({ companyName: "Harbour Dental" })]) {
    assert.equal(canSend(UNCONFIRMED, audit), false);
  }
});

/* ---------------------------------------------------------------------------
   The things that look like consent and are not
   --------------------------------------------------------------------------- */

test("reading the preview is not confirming it", () => {
  /*
   * THE STRONGEST FORM OF THIS TEST AVAILABLE. `canSend` is not told whether
   * the preview was ever opened, because it has no parameter for it. Reading
   * cannot count as agreeing when the rule cannot find out that anyone read.
   */
  const audit = content();
  previewFor(audit);
  previewFor(audit);

  assert.equal(canSend(UNCONFIRMED, audit), false);
});

test("entering a recipient is not confirming", () => {
  // It makes confirming POSSIBLE, which is a different thing and must stay one.
  const audit = content({ recipient: "ana@harbourdental.example" });

  assert.equal(canConfirm(audit), true, "there is now something to confirm");
  assert.equal(canSend(UNCONFIRMED, audit), false, "and it has not been confirmed");
});

test("a confirmation does not survive a change to the address", () => {
  /*
   * The case this whole design exists for. Someone confirms, then notices a
   * typo in the address and fixes it. What they read was an email to somebody
   * else, so it is not consent to this one.
   */
  const first = content({ recipient: "ana@harbourdental.example" });
  const gate = confirm(first);

  assert.equal(canSend(gate, first), true);
  assert.equal(canSend(gate, content({ recipient: "anna@harbourdental.example" })), false);
});

test("a confirmation does not survive a change to what the client would read", () => {
  const before = content();
  const gate = confirm(before);

  for (const changed of [
    content({ companyName: "Harbour Dental" }),
    content({ contactName: "Ana Reyes" }),
    content({ preparedBy: "Sam" }),
    content({ auditedUrl: "https://example.com/" }),
  ]) {
    assert.equal(canSend(gate, changed), false, JSON.stringify(changed));
  }

  assert.equal(canSend(gate, before), true, "and still stands for what was read");
});

test("a confirmation does not carry over to a different audit", () => {
  const gate = confirm(content({ jobId: "job-1" }));

  assert.equal(canSend(gate, content({ jobId: "job-2" })), false);
});

test("withdrawing a confirmation shuts the gate again", () => {
  const audit = content();
  const gate = confirm(audit);

  assert.equal(canSend(gate, audit), true);
  assert.equal(canSend(withdraw(), audit), false);
});

test("a confirmation cannot be forged from a value that is not a fingerprint", () => {
  // The gate holds what was confirmed, not that something was. A truthy value
  // is not enough.
  for (const forged of ["true", "confirmed", "job-1", ""]) {
    assert.equal(canSend({ confirmedFor: forged }, content()), false);
  }
});

/* ---------------------------------------------------------------------------
   The one thing that does open it
   --------------------------------------------------------------------------- */

test("an explicit confirmation makes exactly this content sendable", () => {
  const audit = content();

  assert.equal(canSend(confirm(audit), audit), true);
});

test("confirming without somewhere to send it confirms nothing", () => {
  for (const recipient of ["", "   ", "ana", "ana@", "@example.com", "a b@example.com"]) {
    const audit = content({ recipient });

    assert.equal(canConfirm(audit), false, recipient);
    assert.equal(canSend(confirm(audit), audit), false, recipient);
  }
});

test("an address has to look like one, without pretending to validate it", () => {
  assert.equal(usableRecipient("ana@harbourdental.example"), true);
  assert.equal(usableRecipient("  ana@harbourdental.example  "), true);
  assert.equal(usableRecipient("ana@@example.com"), false);
  assert.equal(usableRecipient("ana example@x.com"), false);
});

/* ---------------------------------------------------------------------------
   What a person is shown
   --------------------------------------------------------------------------- */

test("the preview shows the four things a send would use", () => {
  const preview = previewFor(
    content({ companyName: "Harbour Dental", contactName: "Ana Reyes", preparedBy: "Sam" }),
  );

  assert.equal(preview.recipient, "ana@harbourdental.example");
  assert.equal(preview.subject, "Website audit for Harbour Dental");
  assert.match(preview.body, /Hello Ana Reyes,/);
  assert.match(preview.body, /https:\/\/harbourdental\.example\//);
  assert.match(preview.body, /Sam$/);
  assert.match(preview.attachment, /PDF audit report/);
});

test("nothing is invented to fill a gap in the preview", () => {
  /*
   * Every optional field left empty. A preview that filled these with
   * plausible-looking placeholders would be a preview of a different email,
   * and the person reading it would be confirming something they will not send.
   */
  const preview = previewFor(content());

  assert.equal(preview.subject, "Website audit for https://harbourdental.example/");
  assert.match(preview.body, /^Hello,/);
  assert.doesNotMatch(preview.body, /Kind regards,/, "no name is signed when none was given");
  for (const placeholder of ["[", "]", "{", "}", "TODO", "example name", "Your name"]) {
    assert.ok(!preview.body.includes(placeholder), `no ${placeholder}`);
  }
});

test("the preview describes the report rather than building a second one", () => {
  // There is one report and one path that produces it. A preview that composed
  // its own would be a second document that could disagree with the first.
  const source = fs.readFileSync(new URL("./sendGate.ts", import.meta.url), "utf8");

  assert.match(previewFor(content()).attachment, /as the download button produces it/);
  for (const forbidden of ["buildPdfDocument", "renderPdf", "pdfDocument", "/api/audit/pdf"]) {
    assert.ok(!source.includes(forbidden), `the gate must not reach ${forbidden}`);
  }
});

test("two previews of the same content are the same preview", () => {
  // The fingerprint is built from the preview, so a preview that varied would
  // void a confirmation at random.
  assert.equal(contentFingerprint(content()), contentFingerprint(content()));
});

/* ---------------------------------------------------------------------------
   What this file cannot do, asserted against the source
   --------------------------------------------------------------------------- */

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

test("neither the gate nor the panel sends anything itself", () => {
  /*
   * ASSERTED AGAINST THE SOURCE, because the strongest form of this is that
   * the code has no way to. A test that watched for a request would only prove
   * this one path did not make one today.
   *
   * WHAT THIS CLAIMS NOW THAT SENDING WORKS. Not that nothing can be sent --
   * the button does send -- but that neither of these two files is where it
   * happens. The gate decides whether a send is permitted; the panel renders
   * that and calls `runSend`. The one request lives in `sendRequest.ts`, where
   * it is tested, and the provider lives on the server, where it is the only
   * thing that knows a key exists.
   */
  const source = read("./sendGate.ts") + read("../../app/ReportSend.tsx");

  for (const forbidden of ["resend", "Resend", "fetch(", "XMLHttpRequest", "sendMail", "smtp"]) {
    assert.ok(!source.includes(forbidden), `the send gate must not reach ${forbidden}`);
  }
});

test("nothing here asks a model anything", () => {
  const source = read("./sendGate.ts") + read("../../app/ReportSend.tsx");

  for (const forbidden of ["gemini", "Gemini", "genai", "explainAudit"]) {
    assert.ok(!source.includes(forbidden), `the send gate must not reach ${forbidden}`);
  }
});

test("nothing here stores anything, and no account or role is consulted", () => {
  /*
   * "Salesperson" names who owns the action, not a role the software checks.
   * There is no login in this project and this adds none.
   */
  const source = read("./sendGate.ts") + read("../../app/ReportSend.tsx");

  /*
   * "role" ON ITS OWN IS THE WRONG TOKEN, and this test asserted it until it
   * failed on `role="status"`. ARIA roles are markup that tells a screen reader
   * what an element is; they have nothing to do with who is allowed to do what.
   * The tokens below name an authorisation system rather than a word it shares
   * with the accessibility layer.
   */
  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "getSession",
    "signIn",
    "currentUser",
    "userRole",
    "hasRole",
    "requireRole",
    "rbac",
    "permission",
    "authorize",
  ]) {
    assert.ok(!source.includes(forbidden), `the send gate must not use ${forbidden}`);
  }
});

test("the wording a person agrees to says what they are agreeing to", () => {
  assert.match(CONFIRM_LABEL, /reviewed this report/);
  assert.match(CONFIRM_LABEL, /ready to send/);
});

test("the panel says outright that the button sends, and that nothing undoes it", () => {
  /*
   * THIS TEST USED TO PIN THE OPPOSITE, and rightly: while the button was
   * inert, a panel that did not say so was a trap. Now that it sends, saying
   * "not connected" would be the trap — a person who believes the button does
   * nothing will press it to find out. Both versions pin the same rule, which
   * is that this sentence must be true.
   */
  assert.ok(!SEND_INTRO.includes("not connected"), "it is connected now");
  assert.match(SEND_INTRO, /no unsend/);
  assert.match(SEND_INTRO, /emails the report/);
});

test("a confirmation does not survive a change the preview happens to hide", () => {
  /*
   * THE GAP A REVIEW FOUND, PINNED SO IT CANNOT COME BACK.
   *
   * The fingerprint was built from the rendered preview alone, and a rendering
   * can collide: a company name typed as exactly the audited address produces
   * a byte-identical email to one with no company name at all. The attached
   * report is NOT identical -- its cover names the client instead of the site --
   * so a confirmation given before the name was typed stood after it, for a
   * document that had changed.
   */
  const withoutName = content();
  const withName = content({ companyName: "https://harbourdental.example/" });

  assert.equal(
    previewFor(withoutName).subject,
    previewFor(withName).subject,
    "the emails really are identical, which is what made this hard to see",
  );
  assert.notEqual(
    contentFingerprint(withoutName),
    contentFingerprint(withName),
    "and the confirmation still knows they are different reports",
  );
  assert.equal(canSend(confirm(withoutName), withName), false);
});

test("every field the eventual send depends on voids a confirmation", () => {
  /*
   * The list, checked one field at a time rather than by inspection. A field
   * added to the send later and not added here fails this test rather than a
   * client's inbox.
   */
  const base = content();
  const gate = confirm(base);

  const moved: Record<string, ReturnType<typeof content>> = {
    recipient: content({ recipient: "someone.else@harbourdental.example" }),
    auditedUrl: content({ auditedUrl: "https://other.example/" }),
    companyName: content({ companyName: "Harbour Dental" }),
    contactName: content({ contactName: "Ana Reyes" }),
    preparedBy: content({ preparedBy: "Sam" }),
    jobId: content({ jobId: "job-2" }),
  };

  for (const [field, changed] of Object.entries(moved)) {
    assert.equal(canSend(gate, changed), false, `${field} must void the confirmation`);
  }
});

test("padding a box with spaces is not a change to what a client sees", () => {
  // The report endpoint trims these too, so the document is identical. Voiding
  // a confirmation over it would be an invalidation nobody could explain.
  const typed = content({ companyName: "Harbour Dental", preparedBy: "Sam" });
  const padded = content({ companyName: "  Harbour Dental ", preparedBy: " Sam  " });

  assert.equal(canSend(confirm(typed), padded), true);
});
