/**
 * Tests for the seam an email goes through.
 *
 * THERE IS ALMOST NOTHING TO TEST HERE, AND THAT IS THE POINT. This file
 * describes a shape and names five ways a send can fail; it holds no logic,
 * no request and no provider. What is worth pinning is the absence: that
 * nothing in it reaches a network, and that the sentences it hands upward say
 * nothing a service told us.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { SEND_FAILURE_MESSAGES, fakeProvider, type SendFailure } from "./provider.ts";

/**
 * A module's code, with its prose removed.
 *
 * WHY THIS EXISTS. Searching a source file for a forbidden word finds it in
 * the comment explaining why it is absent, which has now happened five times
 * in this project: a test forbidding "role" caught an ARIA attribute, one
 * forbidding "gemini" caught a design parallel, one forbidding "store" caught
 * a sentence saying there is no store, and two here caught comments saying
 * this seam offers no retry and keys on no recipient.
 *
 * A test that punishes explaining yourself is a test that makes the code
 * worse. Stripping the prose first asks the question that was actually meant.
 */
export function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const EMAIL = {
  to: "ana@harbourdental.example",
  from: "reports@skybook.example",
  subject: "Website audit for Harbour Dental",
  text: "Hello,\n\nPlease find attached the website audit.",
  attachment: { filename: "skybook-audit-example-com.pdf", content: Buffer.from("%PDF-") },
};

test("the fake remembers what it was handed and sends nothing", async () => {
  const mail = fakeProvider();

  const outcome = await mail.provider.send(EMAIL);

  assert.equal(outcome.ok, true);
  assert.deepEqual(mail.sent, [EMAIL]);
});

test("the fake can be told to fail, which is how refusals are tested", async () => {
  const mail = fakeProvider({ ok: false, failure: "network" });

  const outcome = await mail.provider.send(EMAIL);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, "network");
  assert.equal(mail.sent.length, 1, "it still records the attempt");
});

test("every failure has a sentence, so no caller can produce undefined", () => {
  const failures: SendFailure[] = [
    "not-configured",
    "rejected",
    "rate-limited",
    "network",
    "provider-error",
  ];

  for (const failure of failures) {
    assert.equal(typeof SEND_FAILURE_MESSAGES[failure], "string", failure);
    assert.ok(SEND_FAILURE_MESSAGES[failure].length > 0, failure);
  }
});

test("every sentence says nothing was sent, because nothing was", () => {
  /*
   * The thing a person most needs to know after a failure is whether the
   * client received anything. Every one of these answers it in the same words.
   */
  for (const [failure, message] of Object.entries(SEND_FAILURE_MESSAGES)) {
    assert.match(message, /nothing was sent/, failure);
  }
});

test("no sentence names a provider, an account or a request", () => {
  for (const [failure, message] of Object.entries(SEND_FAILURE_MESSAGES)) {
    for (const forbidden of ["resend", "api", "token", "key", "id ", "request id", "http"]) {
      assert.ok(!message.toLowerCase().includes(forbidden), `${failure} must not say ${forbidden}`);
    }
  }
});

test("the seam reaches no network and names no service", () => {
  /*
   * ASSERTED AGAINST THE SOURCE, because the strongest form of this is that
   * the code has no way to. Today the fake is the only implementation there
   * is, and a real one plugs in behind this without changing anything above.
   */
  const source = codeOnly(fs.readFileSync(new URL("./provider.ts", import.meta.url), "utf8"));

  for (const forbidden of ["fetch(", "http", "resend", "Resend", "smtp", "nodemailer", "process.env"]) {
    assert.ok(!source.includes(forbidden), `the seam must not reach ${forbidden}`);
  }
});

test("the seam offers one way to send and no way to retry", () => {
  // There is no unsend, so an interface with a retry, a queue or a batch would
  // be an interface offering ways for one intention to become two messages.
  const source = codeOnly(fs.readFileSync(new URL("./provider.ts", import.meta.url), "utf8"));

  for (const forbidden of ["retry", "retries", "queue", "sendBatch", "sendMany"]) {
    assert.ok(!source.includes(forbidden), `the seam must not offer ${forbidden}`);
  }
});
