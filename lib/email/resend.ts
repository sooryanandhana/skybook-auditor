/**
 * The one implementation of the seam that actually puts a message on the wire.
 *
 * NO SDK, AND THAT WAS A DECISION RATHER THAN AN OMISSION. Sending one
 * transactional email is a single POST carrying a JSON body and a bearer
 * token. A client library for that would be a dependency to keep current in
 * exchange for a function this file already has, and everything else such a
 * library offers -- batching, retries, queues, contact lists -- is precisely
 * what the seam above deliberately refuses to expose. The model client is a
 * dependency because a model API is large and moves; this endpoint is one URL.
 *
 * THE WIRE FORMAT WAS READ, NOT REMEMBERED. Endpoint, header, field names,
 * attachment encoding and the status codes below were taken from the service's
 * own reference rather than from memory, because this project has already been
 * caught once by an API that moved after training data was written.
 *
 * NOTHING THE SERVICE SAYS IS QUOTED UPWARD. Its error bodies carry codes,
 * messages and sometimes the request that produced them. This file reads a
 * status, maps it into the five failures the seam defines, and throws the rest
 * away. The key never appears in a return value, an error or a log, because
 * nothing here builds a string out of it.
 *
 * ONE CALL. No retry, no backoff, no loop, and a timeout so a hung connection
 * cannot hold a request open for ever. A second attempt at sending an email is
 * how one report becomes two in a client's inbox.
 */
import type { EmailProvider, OutgoingEmail, SendFailure, SendOutcome } from "./provider.ts";

/** Where the key is read from. Never prefixed `NEXT_PUBLIC_`. */
export const RESEND_API_KEY_VARIABLE = "RESEND_API_KEY";

/** The service's single transactional endpoint. */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * How long one attempt may take.
 *
 * A BOUND, NOT A RETRY. An email with a small attachment is a fast request;
 * thirty seconds is generous for it and short enough that a hung connection
 * does not hold the salesperson's browser open indefinitely. When it expires
 * the send is reported as a network failure and nothing is tried again.
 */
export const SEND_TIMEOUT_MS = 30_000;

export interface ResendOptions {
  /** Overrides the environment. Supplied by tests, so none depends on a key. */
  readonly apiKey?: string;
  /** Swapped by tests so that no test reaches the network. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * What a status code means, in the seam's own vocabulary.
 *
 * 401 AND 403 ARE "NOT CONFIGURED" RATHER THAN "REJECTED", deliberately. A
 * missing, restricted or suspended key is this server's problem and no amount
 * of editing the message will fix it, so it must not read to a salesperson as
 * something wrong with what they wrote.
 *
 * 400 and 422 are the message itself being refused: a malformed address, an
 * attachment the service would not take. Those are "rejected", which is the
 * one failure that points at the request.
 *
 * Everything else the service can return is its own problem.
 */
export function failureFor(status: number): SendFailure {
  if (status === 401 || status === 403) return "not-configured";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 422) return "rejected";
  return "provider-error";
}

/** The identifier a successful reply carries, or null when it carries none. */
function receiptFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The request body, built field by field.
 *
 * AN EXPLICIT SHAPE, not a spread of the outgoing email. The seam's type and
 * the service's field names are two different vocabularies that happen to
 * overlap, and spreading one into the other is how a field nobody chose ends
 * up on the wire.
 *
 * THE ATTACHMENT IS BASE64. The service accepts a buffer through its own
 * client library and a base64 string over raw HTTP, and this is raw HTTP.
 */
function payload(email: OutgoingEmail) {
  return {
    from: email.from,
    to: email.to,
    subject: email.subject,
    text: email.text,
    attachments: [
      {
        filename: email.attachment.filename,
        content: email.attachment.content.toString("base64"),
        content_type: "application/pdf",
      },
    ],
  };
}

/**
 * A provider that sends through Resend.
 *
 * RETURNS A PROVIDER RATHER THAN BEING ONE, so the key and the fetch are
 * resolved once when it is built rather than read on every send. A server with
 * no key still produces a provider; it simply refuses, which keeps the
 * "configured or not" question out of every caller.
 */
export function resendProvider(options: ResendOptions = {}): EmailProvider {
  const key = (options.apiKey ?? process.env[RESEND_API_KEY_VARIABLE] ?? "").trim();
  const request = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;

  return {
    async send(email: OutgoingEmail): Promise<SendOutcome> {
      /*
       * NO KEY MEANS NO REQUEST. Answered before anything is built, so a
       * server that is not set up never opens a connection and never has an
       * attachment serialised for it.
       */
      if (key === "") return { ok: false, failure: "not-configured" };

      let response: Response;
      try {
        response = await request(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload(email)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        /*
         * A REFUSED CONNECTION, A DNS FAILURE OR THE TIMEOUT ABOVE. The error
         * is not read for text: fetch's own errors quote the address and
         * sometimes the request, and neither belongs above this line.
         */
        return { ok: false, failure: "network" };
      }

      if (!response.ok) return { ok: false, failure: failureFor(response.status) };

      /*
       * A 2xx MEANS IT WENT, WHATEVER THE BODY LOOKS LIKE.
       *
       * The receipt is useful and not essential. Reporting failure because a
       * success came back in an unexpected shape would tell a salesperson
       * nothing had been sent when something had, and this project has no
       * unsend to correct that with. A missing receipt is a null.
       */
      try {
        return { ok: true, id: receiptFrom(await response.json()) };
      } catch {
        return { ok: true, id: null };
      }
    },
  };
}
