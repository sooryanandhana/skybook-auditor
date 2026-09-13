/**
 * Tests for the adapter that actually sends.
 *
 * NOT ONE OF THESE REACHES THE NETWORK. Every test that sends passes its own
 * `fetch`, which records what it was handed and answers from memory, so the
 * suite can exercise a service that would otherwise cost money and deliver
 * mail to somebody. The rest ask about configuration, which is a question and
 * not a request. The real `fetch` is never called and no key is needed.
 *
 * WHAT IS WORTH TESTING HERE. Not that a POST can be made -- that is one line.
 * What matters is the mapping: which status becomes which of the five failures
 * the seam defines, that nothing the service says travels upward, and that one
 * intention produces exactly one request.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { codeOnly } from "./provider.test.mts";
import {
  RESEND_API_KEY_VARIABLE,
  RESEND_ENDPOINT,
  failureFor,
  resendConfigured,
  resendProvider,
} from "./resend.ts";
import type { OutgoingEmail } from "./provider.ts";

const KEY = "re_test_key_that_is_not_real_0123456789";

const EMAIL: OutgoingEmail = {
  to: "ana@harbourdental.example",
  from: "reports@skybook.example",
  subject: "Website audit for Harbour Dental",
  text: "Hello Ana,\n\nPlease find attached the website audit.",
  attachment: {
    filename: "skybook-audit-harbourdental-example.pdf",
    content: Buffer.from("%PDF-1.4 fake bytes"),
  },
};

/** A fetch that answers from memory and remembers every call. */
function recordingFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments: { filename: string; content: string; content_type: string }[];
  };

/* ---------------------------------------------------------------------------
   What goes on the wire
   --------------------------------------------------------------------------- */

test("a send is one POST to the service's own endpoint", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

  const outcome = await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1, "one request, not two");
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  assert.equal(calls[0].init?.method, "POST");
});

test("the message is carried field by field, not spread", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

  await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);
  const sent = bodyOf(calls[0].init);

  assert.equal(sent.from, EMAIL.from);
  assert.equal(sent.to, EMAIL.to);
  assert.equal(sent.subject, EMAIL.subject);
  assert.equal(sent.text, EMAIL.text);
  assert.deepEqual(Object.keys(sent).sort(), ["attachments", "from", "subject", "text", "to"]);
});

test("the report travels as base64 and arrives unchanged", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

  await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);
  const [attachment] = bodyOf(calls[0].init).attachments;

  assert.equal(attachment.filename, EMAIL.attachment.filename);
  assert.equal(attachment.content_type, "application/pdf");
  assert.deepEqual(
    Buffer.from(attachment.content, "base64"),
    EMAIL.attachment.content,
    "the exact bytes the renderer produced",
  );
});

test("the key travels in the header and nowhere else", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

  await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!String(calls[0].init?.body).includes(KEY), "never in the body");
  assert.ok(!calls[0].url.includes(KEY), "never in the address");
});

test("the receipt is carried back when there is one, and null when there is not", async () => {
  const withId = await resendProvider({
    apiKey: KEY,
    fetchImpl: recordingFetch(() => json({ id: "abc-123" })).fetchImpl,
  }).send(EMAIL);

  assert.equal(withId.ok === true && withId.id, "abc-123");

  for (const body of [{}, { id: "" }, { id: 42 }]) {
    const outcome = await resendProvider({
      apiKey: KEY,
      fetchImpl: recordingFetch(() => json(body)).fetchImpl,
    }).send(EMAIL);

    assert.equal(outcome.ok, true, JSON.stringify(body));
    assert.equal(outcome.ok === true && outcome.id, null, JSON.stringify(body));
  }
});

test("a success in an unreadable shape is still a success", async () => {
  /*
   * A 2xx MEANS IT WENT. Reporting failure because the body surprised us would
   * tell a salesperson nothing had been sent when something had, and there is
   * no unsend to correct that with.
   */
  const { fetchImpl } = recordingFetch(() => new Response("not json at all", { status: 200 }));

  const outcome = await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.id, null);
});

/* ---------------------------------------------------------------------------
   Every way it can fail
   --------------------------------------------------------------------------- */

test("each status the service documents maps to one of the seam's failures", () => {
  /*
   * Taken from the service's own error reference rather than from memory. A
   * credential problem is "not configured" rather than "rejected", because no
   * amount of editing the message fixes a suspended key and it must not read
   * to a salesperson as something they wrote.
   */
  assert.equal(failureFor(401), "not-configured", "missing or restricted key");
  assert.equal(failureFor(403), "not-configured", "suspended or inactive key");
  assert.equal(failureFor(429), "rate-limited", "quota or too many requests");
  assert.equal(failureFor(400), "rejected", "validation error");
  assert.equal(failureFor(422), "rejected", "invalid attachment or parameter");

  for (const status of [404, 405, 409, 500, 503]) {
    assert.equal(failureFor(status), "provider-error", String(status));
  }
});

test("a refused request becomes a failure and never a success", async () => {
  for (const [status, failure] of [
    [401, "not-configured"],
    [422, "rejected"],
    [429, "rate-limited"],
    [500, "provider-error"],
    [503, "provider-error"],
  ] as const) {
    const { fetchImpl } = recordingFetch(() =>
      json({ name: "validation_error", message: "Something the service said" }, status),
    );

    const outcome = await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

    assert.equal(outcome.ok, false, String(status));
    assert.equal(outcome.ok === false && outcome.failure, failure, String(status));
  }
});

test("nothing the service says travels upward", async () => {
  /*
   * Its error bodies carry codes, messages and sometimes the request that
   * produced them. The outcome this adapter returns has room for none of it.
   */
  const { fetchImpl } = recordingFetch(() =>
    json(
      {
        name: "validation_error",
        message: "The from address reports@skybook.example is not verified",
        request_id: "req_abc123",
      },
      422,
    ),
  );

  const outcome = await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);
  const serialised = JSON.stringify(outcome);

  for (const leak of ["validation_error", "not verified", "req_abc123", KEY]) {
    assert.ok(!serialised.includes(leak), `must not carry ${leak}`);
  }
  assert.deepEqual(Object.keys(outcome).sort(), ["failure", "ok"]);
});

test("a connection that fails or hangs is a network failure, with nothing quoted", async () => {
  const refused = (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED 1.2.3.4:443");
  }) as unknown as typeof fetch;

  const outcome = await resendProvider({ apiKey: KEY, fetchImpl: refused }).send(EMAIL);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, "network");
  assert.ok(!JSON.stringify(outcome).includes("ECONNREFUSED"), "the address is not quoted");
});

test("a request that times out is a network failure rather than a hang", async () => {
  const hangs = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  const outcome = await resendProvider({ apiKey: KEY, fetchImpl: hangs, timeoutMs: 20 }).send(EMAIL);

  assert.equal(outcome.ok === false && outcome.failure, "network");
});

test("the request carries an abort signal, so nothing can hang for ever", async () => {
  const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

  await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

/* ---------------------------------------------------------------------------
   A server with no key
   --------------------------------------------------------------------------- */

test("no key means no request at all", async () => {
  /*
   * FAILS CLOSED, AND FAILS EARLY. A server that is not set up never opens a
   * connection and never serialises an attachment for one.
   */
  for (const apiKey of ["", "   "]) {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: "abc-123" }));

    const outcome = await resendProvider({ apiKey, fetchImpl }).send(EMAIL);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.failure, "not-configured");
    assert.equal(calls.length, 0, "nothing was sent anywhere");
  }
});

/* ---------------------------------------------------------------------------
   What this adapter cannot do, asserted against the source
   --------------------------------------------------------------------------- */

const source = () => codeOnly(fs.readFileSync(new URL("./resend.ts", import.meta.url), "utf8"));

test("there is one call site and no retry, backoff or loop", async () => {
  const code = source();

  assert.equal((code.match(/await request\(/g) || []).length, 1, "one call site");
  for (const forbidden of ["retry", "retries", "backoff", "for (", "while (", "setTimeout"]) {
    assert.ok(!code.includes(forbidden), `must not use ${forbidden}`);
  }
});

test("the adapter reaches nothing but the endpoint", async () => {
  const code = source();

  for (const forbidden of [
    "../audit/",
    "../collector/",
    "../rules/",
    "../ai/",
    "../jobs/",
    "postgres",
    "prisma",
    "localStorage",
  ]) {
    assert.ok(!code.includes(forbidden), `must not reach ${forbidden}`);
  }
});

test("nothing here writes to the console", async () => {
  const code = source();

  for (const forbidden of ["console.log", "console.warn", "console.error"]) {
    assert.ok(!code.includes(forbidden), `must not ${forbidden}`);
  }
});

test("the key is read from a variable no bundler will publish", () => {
  assert.ok(!RESEND_API_KEY_VARIABLE.startsWith("NEXT_PUBLIC"), RESEND_API_KEY_VARIABLE);
});

test("the seam is implemented rather than redesigned", async () => {
  /*
   * The adapter's whole surface is the one method the seam declares. A second
   * one would be a capability the orchestration above could start depending
   * on, and the seam exists precisely to stop that.
   */
  const provider = resendProvider({ apiKey: KEY, fetchImpl: recordingFetch(() => json({})).fetchImpl });

  assert.deepEqual(Object.keys(provider), ["send"]);
  assert.equal(typeof provider.send, "function");
});

/* ---------------------------------------------------------------------------
   Whether this server can send at all

   ASKED BEFORE ANYTHING IS BUILT. The adapter refuses without a key perfectly
   well, but it refuses at the end -- after a headless browser has typeset a
   report for a client who was never going to receive it. This is the cheap
   question that stops that, and the only thing it may ever answer is yes or no.
   --------------------------------------------------------------------------- */

test("a key makes this server configured and a blank one does not", () => {
  assert.equal(resendConfigured({ apiKey: KEY }), true);

  for (const apiKey of ["", "   ", "\t\n"]) {
    assert.equal(resendConfigured({ apiKey }), false, JSON.stringify(apiKey));
  }
});

test("with no option given it reads the environment", () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env[RESEND_API_KEY_VARIABLE];

  try {
    delete env[RESEND_API_KEY_VARIABLE];
    assert.equal(resendConfigured(), false, "no variable at all");

    env[RESEND_API_KEY_VARIABLE] = "   ";
    assert.equal(resendConfigured(), false, "a variable holding nothing");

    env[RESEND_API_KEY_VARIABLE] = KEY;
    assert.equal(resendConfigured(), true);
  } finally {
    if (previous === undefined) delete env[RESEND_API_KEY_VARIABLE];
    else env[RESEND_API_KEY_VARIABLE] = previous;
  }
});

test("asking carries no key back", () => {
  /*
   * A BOOLEAN, DELIBERATELY. Returning the key, a masked key, its length or a
   * built client would each be a way for a caller to end up holding one, and
   * the only caller is a route that must never see it.
   */
  const answer = resendConfigured({ apiKey: KEY });

  assert.equal(typeof answer, "boolean");
  assert.ok(!String(answer).includes(KEY));
});

test("it is the same reading the send itself does, so the two cannot disagree", () => {
  /*
   * Two separate readings of the key would let a route be told it was
   * configured and then be refused by its own provider. There is one
   * resolver: whatever makes this predicate false makes a send refuse without
   * opening anything, and that is asserted rather than assumed.
   */
  const code = source();
  assert.equal(
    (code.match(/process\.env\[RESEND_API_KEY_VARIABLE\]/g) || []).length,
    1,
    "the environment is read in exactly one place",
  );

  for (const apiKey of ["", "   "]) {
    assert.equal(resendConfigured({ apiKey }), false);
  }
});

test("a configured server still refuses a send its own provider cannot make", async () => {
  // The predicate answers "is there a key", never "will the next send work".
  const { calls, fetchImpl } = recordingFetch(() => json({ message: "no" }, 500));

  assert.equal(resendConfigured({ apiKey: KEY }), true);
  const outcome = await resendProvider({ apiKey: KEY, fetchImpl }).send(EMAIL);

  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1);
});
