/**
 * Asking this server to send the report, and what the panel shows while it does.
 *
 * SEPARATED FROM THE PANEL for the reason every decision in this project is:
 * the results page is a client component and cannot be imported by the unit
 * tests without a bundler, and the judgements worth testing are which fields
 * cross to the server, whether a second click can start a second send, which
 * sentence a refusal produces, and what happens to a confirmation afterwards.
 *
 * IT DECIDES NOTHING ABOUT WHETHER A SEND IS PERMITTED. That is `sendGate`,
 * which this asks rather than reimplements. Two answers to "may this be sent"
 * would be one answer too many, and the server recomputes the same fingerprint
 * a third time before anything leaves.
 *
 * IT KNOWS NOTHING ABOUT HOW MAIL IS SENT. No provider, no key, no sending
 * address, no endpoint but our own. All of that is the server's, and the
 * browser is never told any of it -- not even whether it is configured, which
 * it learns only as a refusal in a sentence written for a person to read.
 *
 * IT STARTS NOTHING. One request, to one endpoint, carrying a job id that
 * already exists. No audit, no crawl, no speed check, no model, and no retry:
 * there is no unsend, so a second attempt is the one mistake this path must
 * never make on its own.
 */
import { SEND_LABEL, canSend, withdraw, type SendContent, type SendGate } from "./sendGate.ts";

/** Our own endpoint. The only address this module knows. */
export const SEND_ENDPOINT = "/api/report/send";

/**
 * When this server cannot be reached at all.
 *
 * ITS OWN SENTENCE, because it is the one case where no answer came back to
 * quote. It says what is true -- we could not reach the server, so nothing was
 * sent -- rather than guessing at why.
 */
export const SEND_UNREACHABLE =
  "Could not reach this server, so nothing was sent. The report above is unaffected.";

/**
 * When an answer came back carrying no sentence of its own.
 *
 * Every refusal the endpoint writes is wording meant for a person. This is the
 * fallback for a response that is not one -- a proxy's error page, say --
 * because whatever that body contains was not written to be read by anybody
 * here, and showing it is how a request id or a stack trace ends up on screen.
 */
export const SEND_FAILED = "The report could not be sent. Nothing reached the client.";

/**
 * When the answer came back 2xx and was not ours.
 *
 * THE THIRD STATE, and this project already has a name for it. A measurement
 * is found, absent, or unavailable; an answer that cannot be read is the third
 * one, and collapsing it into either of the others is a claim nobody can back.
 *
 * "Nothing was sent" would be false if the connection broke while our own
 * answer was being delivered -- the email had gone by then. "Sent" would be
 * false if that 2xx came from a portal or a proxy rather than from us. So this
 * says the one thing that is true in both, and tells a person what to do about
 * it: ask, rather than press again and risk a second copy.
 */
export const SEND_UNCONFIRMED =
  "This server's answer could not be read, so whether the report was sent is unknown. " +
  "Check with the client before sending it again.";

/** What one attempt produced. Never bytes, never a provider's reply. */
export type SendOutcome =
  | { readonly ok: true; readonly recipient: string }
  | { readonly ok: false; readonly message: string };

export interface SendRequestDeps {
  /** Swapped by tests, so no test reaches this server or any other. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Exactly the fields the send contract reads, and not one more.
 *
 * BUILT FIELD BY FIELD rather than spread from the content. `SendContent`
 * carries `auditedUrl` because the preview is composed from it, and that field
 * must NOT cross: the server takes the audited address from the document it
 * built, precisely so that a caller cannot supply one that makes their own
 * fingerprint fit. Spreading the object would hand it over by accident.
 *
 * EMPTY BOXES ARE OMITTED, the way the download's request omits them, because
 * the endpoint reads an empty string as absent anyway and the fingerprint
 * trims before comparing. A box padded with spaces is not a change to what a
 * client sees.
 */
export function sendBody(content: SendContent, confirmedFor: string): Record<string, string> {
  const body: Record<string, string> = {
    jobId: content.jobId,
    recipient: content.recipient.trim(),
    confirmedFor,
  };

  for (const key of ["companyName", "contactName", "preparedBy"] as const) {
    const value = content[key]?.trim() ?? "";
    if (value !== "") body[key] = value;
  }

  return body;
}

/*
 * OUR OWN CONTRACT, OR NOTHING.
 *
 * BOTH OF THESE ASK FOR `ok` AS WELL AS THE FIELD THEY WANT, and that is the
 * whole point of them. The endpoint answers `{ok:true, recipient}` or
 * `{ok:false, error}` and never anything else, so a body without the flag is
 * not our endpoint's body -- it is a proxy's error page, a captive portal, a
 * gateway's JSON. Reading a bare `error` out of one of those puts somebody
 * else's internal text in front of a salesperson; reading a 2xx out of one as
 * success tells them a client has a report that was never sent.
 *
 * Both were measured rather than argued about: before this, a 200 carrying
 * `<html>Sign in to the wifi</html>` produced "Sent to ana@…", and a 502
 * carrying a gateway's JSON printed an internal address and port to the page.
 */

/** The address our endpoint says it sent to, or null if this is not its answer. */
function acceptance(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const { ok, recipient } = payload as { ok?: unknown; recipient?: unknown };
  return ok === true && typeof recipient === "string" && recipient !== "" ? recipient : null;
}

/** Our endpoint's own sentence, or null if this is not its answer. */
function refusal(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const { ok, error } = payload as { ok?: unknown; error?: unknown };
  return ok === false && typeof error === "string" && error !== "" ? error : null;
}

/**
 * One request, and no retry.
 *
 * A REFUSAL IS QUOTED, NEVER REWRITTEN. Every sentence the endpoint sends was
 * written for a person -- this audit could not be found, this report was
 * changed after it was confirmed, no sending address is configured -- and the
 * server already guarantees that nothing internal is in them. Wording them
 * again here would be a second copy that drifts from the first.
 *
 * A FAILURE HERE MEANS NOTHING WAS SENT, and that is the server's guarantee
 * rather than this function's hope: every failure sentence it can return says
 * so in as many words.
 */
export async function sendReport(
  content: SendContent,
  confirmedFor: string,
  deps: SendRequestDeps = {},
): Promise<SendOutcome> {
  const request = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await request(SEND_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sendBody(content, confirmedFor)),
    });
  } catch {
    return { ok: false, message: SEND_UNREACHABLE };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return { ok: false, message: refusal(payload) ?? SEND_FAILED };
  }

  /*
   * THE ADDRESS THE SERVER SAYS IT USED, not the one in the box. They are the
   * same address -- the fingerprint would not have matched otherwise -- and
   * reporting the server's answer is reporting what actually happened.
   *
   * THERE IS NO FALLBACK TO THE ADDRESS IN THE BOX, and there used to be. It
   * looked harmless: if the answer carried no address, use the one we asked
   * about. What it actually did was invent a success out of any 2xx at all,
   * naming an address the server had never confirmed. A send this application
   * cannot evidence is not a send it may claim.
   */
  const recipient = acceptance(payload);
  if (recipient === null) return { ok: false, message: SEND_UNCONFIRMED };

  return { ok: true, recipient };
}

/* ---------------------------------------------------------------------------
   What the panel shows, and when it is allowed to ask

   BELOW THE REQUEST ON PURPOSE. Everything above answers "what happened"; this
   answers "what does a person see, and may they press it again". Both live
   here rather than in the component because the component cannot be tested
   without a browser, and these are the judgements worth pinning down.
   --------------------------------------------------------------------------- */

/** Where a send has got to. Four states, told apart. */
export type SendState =
  | { readonly kind: "ready" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent"; readonly recipient: string }
  | { readonly kind: "failed"; readonly message: string };

/** Before anything has been asked for, and after anything changes. */
export const SEND_READY: SendState = { kind: "ready" };

/** Present tense, because it is happening and it takes a few seconds. */
export const SEND_BUSY_LABEL = "Sending…";

/** Said once, after the only thing on this page that cannot be undone. */
export const sentNote = (recipient: string) =>
  `Sent to ${recipient}. There is no unsend — to send again, confirm again.`;

/**
 * What the button says, and whether it may be pressed.
 *
 * THREE REASONS IT IS SHUT, and they are different reasons. Nobody has
 * confirmed this content; a send is in flight; this content has already gone.
 * The third is the one the download button has no equivalent of: downloading
 * the same report twice costs a few seconds, and sending it twice puts a
 * second copy in a client's inbox with no way to take either back.
 */
export function sendButton(
  state: SendState,
  sendable: boolean,
): { readonly label: string; readonly disabled: boolean } {
  const sending = state.kind === "sending";

  return {
    label: sending ? SEND_BUSY_LABEL : SEND_LABEL,
    disabled: sending || state.kind === "sent" || !sendable,
  };
}

/**
 * Whether the attestation may still be given, and when it may not.
 *
 * A TICK THAT CANNOT AUTHORISE ANYTHING SHOULD NOT INVITE ONE. Three reasons,
 * and they are the button's three read from the other side:
 *
 *   nothing to confirm   there is no address yet, so there is no email to read
 *   a send in flight     what is being sent is already decided
 *   already sent         this content has gone; agreeing to it again agrees
 *                        to nothing, because the press it would unlock is shut
 *
 * The third is the one this was missing. The box unticks itself on success --
 * the confirmation is spent -- and it could then be re-ticked, standing next to
 * a dead button, meaning nothing. This project's own rule about a Send that
 * cannot send applies just as well to a box that cannot confirm.
 *
 * A FAILED SEND LEAVES IT ALONE. Nothing reached the client, the confirmation
 * still stands, and the person must be able to withdraw it or press again.
 */
export function confirmBox(state: SendState, ready: boolean): { readonly disabled: boolean } {
  return { disabled: !ready || state.kind === "sending" || state.kind === "sent" };
}

/** The two pieces of state a press moves. Handed in, so this owns neither. */
export interface SendHandlers {
  readonly onState: (next: SendState) => void;
  readonly onGate: (next: SendGate) => void;
}

/**
 * One press of the button, from the click to the answer.
 *
 * THE WHOLE HANDLER LIVES HERE so that a test drives the same code the button
 * does. The component holds the state and the markup and decides nothing.
 *
 * THREE GUARDS BEFORE ANYTHING IS ASKED, and none of them is the disabled
 * attribute -- that is a rendering, and a render can lag a click:
 *
 *   in flight     a second press while one is running does nothing at all
 *   already sent  the same content cannot go twice
 *   the gate      asked again, here, at the moment of the press
 *
 * The third is not a formality. The confirmation is bound to the content, so
 * anything edited between the tick and the click has already voided it, and
 * this is where that is noticed rather than at the server.
 *
 * THE CONFIRMATION IS SPENT BY A SEND THAT SUCCEEDS. A standing agreement
 * after the email has gone would be an agreement to send it again, which is
 * not what anybody ticked a box for. A send that FAILED leaves it standing:
 * nothing reached the client, the content has not changed, and making somebody
 * re-read an unchanged report to retry a rate-limited send would teach them to
 * tick without reading.
 */
export async function runSend(
  state: SendState,
  gate: SendGate,
  content: SendContent,
  handlers: SendHandlers,
  deps: SendRequestDeps = {},
): Promise<void> {
  if (state.kind === "sending" || state.kind === "sent") return;

  const confirmedFor = gate.confirmedFor;
  if (confirmedFor === null || !canSend(gate, content)) return;

  handlers.onState({ kind: "sending" });

  const outcome = await sendReport(content, confirmedFor, deps);

  if (outcome.ok) {
    handlers.onState({ kind: "sent", recipient: outcome.recipient });
    handlers.onGate(withdraw());
    return;
  }

  handlers.onState({ kind: "failed", message: outcome.message });
}
