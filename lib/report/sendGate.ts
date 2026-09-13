/**
 * The gate between a finished report and sending it to a client.
 *
 * WHY A GATE EXISTS AT ALL. There is no unsend. Every other mistake this
 * project can make is recoverable by running the audit again; an email to a
 * prospect is not, and the thing being sent is a document about somebody
 * else's business. So the last step before a client sees anything is a person
 * saying they have read it.
 *
 * NOTHING HERE SENDS ANYTHING, AND THAT IS STILL TRUE NOW THAT SENDING WORKS.
 * This module decides when a send would be permitted and composes what a
 * person reads before agreeing to one. Asking the server is `sendRequest`
 * beside it, which calls `canSend` rather than deciding again, and the server
 * recomputes the same fingerprint a third time before anything leaves.
 *
 * SEPARATED FROM THE PAGE for the reason every decision in this project is:
 * the panel is a client component and cannot be imported by the unit tests
 * without a bundler, and the judgements worth testing are which content a
 * preview shows, what counts as a confirmation, and what silently voids one.
 */

/**
 * Everything the eventual send would use.
 *
 * ONE OBJECT, because it is also what a confirmation is ABOUT. A person
 * confirms a particular email to a particular address carrying a particular
 * report, and confirming is not a mood they are in afterwards.
 */
export interface SendContent {
  /** The audit the report is made from. */
  readonly jobId: string;
  /** Where it would go. Typed by the salesperson; the application holds none. */
  readonly recipient: string;
  /** The address that was audited, as the report's cover states it. */
  readonly auditedUrl: string;
  /** The three optional fields the report itself already carries. */
  readonly companyName?: string;
  readonly contactName?: string;
  readonly preparedBy?: string;
}

/** What a person is shown before they are allowed to confirm. */
export interface EmailPreview {
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  /** What would be attached, described rather than rebuilt. */
  readonly attachment: string;
}

export const SEND_HEADING = "Send to the client";

/**
 * What this panel does, said before it is used rather than after.
 *
 * IT NOW SENDS. This sentence used to say that email delivery was not
 * connected, which was the honest thing to say while the button did nothing.
 * Saying it now would be worse than saying nothing: a person who believes the
 * button is inert will press it to find out.
 *
 * THE SECOND CLAUSE IS THE POINT. Every other mistake this project can make is
 * recoverable by running the audit again. This one reaches somebody else's
 * inbox, and a salesperson about to press it should read that here rather than
 * learn it afterwards.
 */
export const SEND_INTRO =
  "Read what the client would receive, then confirm. Pressing send emails the " +
  "report to the address below — there is no unsend.";

/** The attestation. Its wording is the whole safeguard, so a test pins it. */
export const CONFIRM_LABEL =
  "I have reviewed this report and confirm it is ready to send.";

export const PREVIEW_LABEL = "Preview the email";
export const SEND_LABEL = "Send to the client";

/** Said when there is no address to send to. */
export const NO_RECIPIENT = "Enter the client's email address to continue.";

/**
 * Whether an address is usable enough to put in front of a person.
 *
 * A TYPO GUARD, NOT A VALIDATOR. Deciding what is a deliverable address is the
 * mail system's job and every attempt to do it with a pattern is famously
 * wrong at the edges. This catches the empty box and the obviously unfinished
 * entry, and leaves the rest to the person reading the preview -- who is, after
 * all, the point of the whole gate.
 */
export function usableRecipient(recipient: string): boolean {
  const trimmed = recipient.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return false;

  const at = trimmed.indexOf("@");
  return at > 0 && at === trimmed.lastIndexOf("@") && at < trimmed.length - 1;
}

const trimmed = (value: string | undefined) => (value ?? "").trim();

/**
 * The email a client would receive, composed from what actually exists.
 *
 * NOTHING HERE IS INVENTED. The address is the one that was typed, the site is
 * the one that was audited, and the greeting uses the contact's name only when
 * there is one. A preview that filled its gaps with plausible-looking
 * placeholders would be a preview of a different email.
 *
 * THE ATTACHMENT IS DESCRIBED, NOT REBUILT. There is one report and one path
 * that produces it, the same one the download button uses. Composing a second
 * version here so the preview had something to show would be a second document
 * that could disagree with the first.
 */
export function previewFor(content: SendContent): EmailPreview {
  const company = trimmed(content.companyName);
  const contact = trimmed(content.contactName);
  const preparedBy = trimmed(content.preparedBy);

  const subject = `Website audit for ${company === "" ? content.auditedUrl : company}`;

  const body = [
    contact === "" ? "Hello," : `Hello ${contact},`,
    "",
    `Please find attached the website audit we ran for ${content.auditedUrl}.`,
    "",
    "It sets out what was measured, what was found, and what we suggest doing " +
      "about it. Every finding came from an automated check against the site, " +
      "and the report names the pages each one was found on.",
    "",
    "Happy to talk any of it through.",
    "",
    preparedBy === "" ? "Kind regards" : `Kind regards,\n${preparedBy}`,
  ].join("\n");

  return {
    recipient: content.recipient.trim(),
    subject,
    body,
    attachment: `The PDF audit report for ${content.auditedUrl}, exactly as the download button produces it.`,
  };
}

/**
 * What a confirmation was about, as one string.
 *
 * WHY A CONFIRMATION IS BOUND TO CONTENT RATHER THAN KEPT AS A FLAG. A flag
 * says "this person clicked something once". This says "this person read THIS
 * email to THIS address carrying THIS report". Change any of it -- correct a
 * typo in the address, add the company name, run a new audit -- and what they
 * agreed to no longer exists, so the agreement does not either.
 *
 * That property is the whole safety argument for the eventual send, and it is
 * why it is computed rather than remembered.
 *
 * THE CLIENT FIELDS ARE INCLUDED RAW AS WELL AS THROUGH THE PREVIEW, and this
 * was not always so. The preview is a projection, and a projection can collide:
 * a company name typed as exactly the audited address produces a byte-identical
 * email to one with no company name at all. The attached report is not
 * identical, because its cover says "Prepared for" the client rather than
 * naming the site. So a confirmation given before the name was typed used to
 * stand after it, for a document that had changed.
 *
 * Trimmed, because the endpoint that builds the report trims them too: padding
 * a box with spaces changes nothing a client sees, and voiding a confirmation
 * over it would be an invalidation nobody could explain.
 */
export function contentFingerprint(content: SendContent): string {
  const preview = previewFor(content);

  return JSON.stringify([
    content.jobId,
    trimmed(content.companyName),
    trimmed(content.contactName),
    trimmed(content.preparedBy),
    preview.recipient,
    preview.subject,
    preview.body,
    preview.attachment,
  ]);
}

/**
 * Whether the person has confirmed, and what they confirmed.
 *
 * Null means no confirmation stands. There is no other state: a gate that
 * remembered having once been open is a gate.
 */
export interface SendGate {
  readonly confirmedFor: string | null;
}

/** Where every report starts. Nothing is confirmed by a report existing. */
export const UNCONFIRMED: SendGate = { confirmedFor: null };

/**
 * Whether there is enough to put in front of a person to confirm.
 *
 * A PRECONDITION FOR CONFIRMING, NEVER FOR SENDING. Having somewhere to send
 * it does not mean anyone has agreed to send it, and the two must not be
 * allowed to blur: `canSend` below does not consult this.
 */
export function canConfirm(content: SendContent): boolean {
  return content.jobId.trim() !== "" && usableRecipient(content.recipient);
}

/** Records a confirmation of exactly this content. */
export function confirm(content: SendContent): SendGate {
  return canConfirm(content) ? { confirmedFor: contentFingerprint(content) } : UNCONFIRMED;
}

/** Withdraws it. Unticking the box is as deliberate as ticking it. */
export function withdraw(): SendGate {
  return UNCONFIRMED;
}

/**
 * Whether a send would be permitted, and the only function that may say so.
 *
 * THE LIST OF THINGS THAT DO NOT UNLOCK IT is longer than the thing that does,
 * and that is deliberate. A finished report does not. Opening the preview does
 * not -- reading is not agreeing, and this function is not told whether the
 * preview was ever open. Loading the page does not, because the gate starts
 * shut and is never restored from anywhere. Typing an address does not. Time
 * passing does not.
 *
 * Exactly one thing does: a standing confirmation of the content being sent.
 */
export function canSend(gate: SendGate, content: SendContent): boolean {
  return gate.confirmedFor !== null && gate.confirmedFor === contentFingerprint(content);
}
