/**
 * The seam an email goes through, and the only thing that knows it is an email.
 *
 * NO PROVIDER IS NAMED HERE AND NONE IS IMPORTED. This file describes what
 * leaving the building looks like; which service does it is a later decision
 * that plugs in behind this and changes nothing above it. That is the same
 * arrangement the model client has, and it exists for the same reason: the
 * orchestration is worth testing and a network call is not.
 *
 * NOTHING IN THIS FILE SENDS ANYTHING. There is no request, no key and no
 * address book. A fake provider lives beside it for tests, and today the fake
 * is the only implementation there is.
 */

/** One message, fully composed, with nothing left to decide. */
export interface OutgoingEmail {
  readonly to: string;
  /** The verified sending address. Configuration, never anything a caller typed. */
  readonly from: string;
  readonly subject: string;
  /** Plain text. No markup, so nothing a client's mail reader has to interpret. */
  readonly text: string;
  readonly attachment: {
    readonly filename: string;
    readonly content: Buffer;
  };
}

/**
 * Why a send did not happen.
 *
 * OURS, NOT A PROVIDER'S. Whatever a service returns is its own vocabulary and
 * often carries a request id, an account id or the message itself; none of
 * that may reach a person or a log here. An adapter maps into this list and
 * the list is all anything above ever sees.
 */
export type SendFailure =
  | "not-configured"
  | "rejected"
  | "rate-limited"
  | "network"
  | "provider-error";

/**
 * What one attempt produced.
 *
 * THE IDENTIFIER IS THE PROVIDER'S RECEIPT and is carried only so a send can
 * be traced afterwards. It is not shown to anybody and not stored, because
 * Phase 7 stores nothing.
 */
export type SendOutcome =
  | { readonly ok: true; readonly id: string | null }
  | { readonly ok: false; readonly failure: SendFailure };

/**
 * Anything that can put a message on the wire.
 *
 * ONE METHOD, AND IT IS CALLED ONCE. There is no unsend, so this interface
 * deliberately offers no retry, no batching and no queue: each of those would
 * be a way for one intention to become two messages.
 */
export interface EmailProvider {
  send(email: OutgoingEmail): Promise<SendOutcome>;
}

/**
 * What a person is told, for each way it can fail.
 *
 * FIXED SENTENCES, LIKE THE RENDERER'S. Every one says what happened and
 * nothing about the client, the audit or the provider's internals. "Rejected"
 * is the only one that points at the request rather than the service, and even
 * it does not repeat what the service said about it.
 */
export const SEND_FAILURE_MESSAGES: Record<SendFailure, string> = {
  "not-configured": "Email sending is not configured on this server, so nothing was sent.",
  rejected: "The email service would not accept this message, so nothing was sent.",
  "rate-limited": "The email service is over its limit right now, so nothing was sent.",
  network: "The email service could not be reached, so nothing was sent.",
  "provider-error": "The email service had a problem, so nothing was sent.",
};

/**
 * A provider that sends nothing and remembers everything.
 *
 * NOT A TEST HELPER HIDDEN IN A TEST FILE. It lives here because it is the
 * only implementation this project currently has, and because the orchestration
 * above must be exercised by something that behaves like a provider rather
 * than by a stub written fresh in each test.
 */
export function fakeProvider(answer: SendOutcome = { ok: true, id: "fake-1" }) {
  const sent: OutgoingEmail[] = [];

  return {
    sent,
    provider: {
      send: async (email: OutgoingEmail) => {
        sent.push(email);
        return answer;
      },
    } satisfies EmailProvider,
  };
}
