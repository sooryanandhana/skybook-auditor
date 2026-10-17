/**
 * Sending a finished report to a client, and every reason not to.
 *
 * WHAT THIS FUNCTION IS. The join between four things that already exist and
 * are already tested: the sign-in guard, the confirmation gate, the document
 * projection and the renderer. It adds no judgement of its own about what a
 * report says, who may see it, or what an email reads like. It decides only
 * the order those are asked in and what happens when one of them says no.
 *
 * IT DUPLICATES NOTHING. The refusal sentences for an unknown or unfinished
 * job are the job layer's own, the same ones the export endpoint returns. The
 * document comes from `buildPdfDocument`, which is the single source of truth
 * for what a report contains; calling it is not copying it, and composing a
 * second document here would be a second report that could disagree with the
 * one the salesperson downloaded and read.
 *
 * IT STARTS NOTHING. No audit, no crawl, no speed check, no model. It reads a
 * job that already finished, typesets it with the same renderer the download
 * button uses, and hands the result to a provider seam.
 *
 * ONE REQUEST, AND NO RETRY. There is no unsend. A failed send is reported and
 * not quietly attempted again, for the same reason the renderer and the model
 * adapter do not retry, only more so.
 */
import { auditJobs, type AuditJobStore } from "../jobs/auditJobs.ts";
import { JOB_NOT_FOUND, NO_JOB_ID, NOT_READY, UNKNOWN_FAILURE } from "../jobs/jobResponses.ts";
import { buildPdfDocument } from "../audit/pdfDocument.ts";
import { renderPdf, PDF_RENDER_MESSAGES, PdfRenderError } from "../audit/pdf/render.ts";
import { commentaryAt, exportFilename, renderFailureReason, type PdfExportFields } from "./pdfExportRoute.ts";
import { logOutcome } from "../log/reliabilityLog.ts";
import { requireSession, UNAUTHORISED, type GuardOptions } from "../auth/guard.ts";
import {
  contentFingerprint,
  previewFor,
  usableRecipient,
  type SendContent,
} from "../report/sendGate.ts";
import {
  SEND_FAILURE_MESSAGES,
  type EmailProvider,
  type OutgoingEmail,
} from "../email/provider.ts";
import { SEND_RATE_LIMITED, recordSend, sendAllowance } from "../email/sendLimit.ts";
import { accountLimitKey } from "../accountLimitKey.ts";
import { resendConfigured, resendProvider } from "../email/resend.ts";

/** Where the verified sending address is read from. Never anything a caller typed. */
export const FROM_VARIABLE = "SKYBOOK_MAIL_FROM";

export const NO_RECIPIENT = "Enter the client's email address before sending.";

/**
 * Said when the browser's confirmation does not describe what is being sent.
 *
 * THE ONE REFUSAL THAT IS ABOUT CONSENT RATHER THAN CAPABILITY. A person
 * confirmed a particular email to a particular address carrying a particular
 * report; if any of that has changed since, what they agreed to no longer
 * exists. It is worded so a salesperson knows what to do rather than
 * suspecting a bug.
 */
export const NOT_CONFIRMED =
  "This report was changed after it was confirmed. Read it again and confirm before sending.";

export const NO_RESULT = "The audit finished but its result could not be read.";

const NO_SENDER =
  "No sending address is configured on this server, so nothing was sent.";

/** What the endpoint answers. Never bytes: a send succeeds or it does not. */
export type SendReportResult =
  | { readonly ok: true; readonly recipient: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface SendReportDeps extends GuardOptions {
  readonly store?: AuditJobStore;
  /** Swapped by tests so no test launches a browser it does not need. */
  readonly render?: typeof renderPdf;
  /**
   * The seam.
   *
   * PRODUCTION LEAVES THIS UNSET and gets the real adapter. Tests pass a fake,
   * which is the whole reason the parameter exists: no test needs a key, and
   * none can reach the service by forgetting one.
   */
  readonly provider?: EmailProvider;
  /** Overrides the configured sending address. */
  readonly from?: string;
  readonly now?: number;
}

/** Only the fields a send may carry. Anything else in the body is ignored. */
interface SendRequest {
  readonly jobId: string;
  readonly recipient: string;
  readonly confirmedFor: string;
  readonly fields: PdfExportFields;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The body, read field by field.
 *
 * AN EXPLICIT WHITELIST, like every other boundary in this project. A body
 * carrying a subject, a sender or an attachment is a body trying to compose
 * its own email, and none of those are read.
 */
async function submitted(request: Request): Promise<SendRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const shape = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const field = (key: string) => {
    const value = text(shape[key]);
    return value === "" ? undefined : value;
  };

  return {
    jobId: text(shape.jobId),
    recipient: text(shape.recipient),
    confirmedFor: text(shape.confirmedFor),
    fields: {
      companyName: field("companyName"),
      contactName: field("contactName"),
      preparedBy: field("preparedBy"),
    },
  };
}



/**
 * POST /api/report/send — one finished report, to one client.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN. Cheap and total refusals come before
 * expensive ones, and nothing irreversible happens until every refusal has had
 * its chance:
 *
 *   1. signed in          a stranger never gets further
 *   2. a job id           nothing to look up without one
 *   3. an address         nowhere to send it
 *   4. within the limit   before any work is done for a request that is refused
 *   5. the job is usable  the job layer's own sentences
 *   6. the document       cheap, and it is what the fingerprint is about
 *   7. the confirmation   checked BEFORE the renderer runs, because rendering
 *                         drives a headless browser and an unconfirmed send
 *                         must not cost that
 *   8. the renderer       the same document the download produces
 *   9. one send
 */
export async function sendReportRoute(
  request: Request,
  deps: SendReportDeps = {},
): Promise<SendReportResult> {
  const store = deps.store ?? auditJobs();
  const render = deps.render ?? renderPdf;
  const now = deps.now ?? Date.now();

  // 1. Signed in. The page redirect is a courtesy; this is the boundary.
  const user = await requireSession(request, deps, now);
  if (user === null) {
    return { ok: false, status: 401, error: UNAUTHORISED };
  }

  const sent = await submitted(request);

  if (sent.jobId === "") return { ok: false, status: 400, error: NO_JOB_ID };
  if (!usableRecipient(sent.recipient)) {
    return { ok: false, status: 400, error: NO_RECIPIENT };
  }

  const from = (deps.from ?? process.env[FROM_VARIABLE] ?? "").trim();
  if (from === "") return { ok: false, status: 503, error: NO_SENDER };

  /*
   * THE REAL ADAPTER UNLESS A TEST HANDED ONE IN.
   *
   * ASKED HERE RATHER THAN LEFT TO THE PROVIDER, and the reason is the line
   * further down that drives a headless browser. The adapter refuses without
   * a key perfectly well, but it would refuse AFTER a report had been
   * typeset for a client who was never going to receive it. A server that
   * cannot send should cost nothing to ask.
   *
   * FAILS CLOSED EITHER WAY. A route that quietly did nothing and reported
   * success would be the worst possible version of this feature.
   */
  const provider = deps.provider ?? resendProvider();
  if (deps.provider === undefined && !resendConfigured()) {
    return { ok: false, status: 503, error: SEND_FAILURE_MESSAGES["not-configured"] };
  }

  /*
   * 4. Before any work, so a refused request costs this server nothing.
   *
   * ASKED, NOT SPENT. Eight of this function's refusals happen after this
   * line, and a request that ends in one of them sends nothing. Consuming an
   * allowance here meant five failed renders locked somebody out for ten
   * minutes and told them they had sent too much. The allowance is spent at
   * the end, once a provider has actually taken a message.
   *
   * COUNTED AGAINST THE SIGNED-IN ACCOUNT, not a client address: each
   * salesperson has their own allowance, and the server-wide ceiling inside
   * `sendAllowance` still bounds them all together.
   */
  const caller = accountLimitKey(user.id);
  if (!sendAllowance(caller, now).allowed) {
    return { ok: false, status: 429, error: SEND_RATE_LIMITED };
  }

  /*
   * 5. The job layer's own sentences, exactly as the export endpoint returns
   * them. Unknown and expired are one answer because an expired job is deleted
   * and the two cannot be told apart.
   */
  const job = store.get(sent.jobId);
  if (job === null) return { ok: false, status: 404, error: JOB_NOT_FOUND };
  if (job.status === "queued" || job.status === "running") {
    return { ok: false, status: 409, error: NOT_READY };
  }
  if (job.status === "failed") {
    return { ok: false, status: 409, error: job.error ?? UNKNOWN_FAILURE };
  }

  // 6. The same projection the download uses. It re-checks the job itself.
  const outcome = buildPdfDocument(sent.jobId, store, sent.fields);
  if (!outcome.ok) {
    if (outcome.reason === "unknown-job") return { ok: false, status: 404, error: JOB_NOT_FOUND };
    if (outcome.reason === "not-finished") return { ok: false, status: 409, error: NOT_READY };
    return { ok: false, status: 409, error: NO_RESULT };
  }

  // Read here, straight after the document was built. See `commentaryAt`.
  const commentary = commentaryAt(outcome.document, store, sent.jobId);

  /*
   * 7. THE CONFIRMATION, RECOMPUTED HERE RATHER THAN BELIEVED.
   *
   * The browser sends the fingerprint it holds; this rebuilds one from the job
   * and the fields actually being used and requires them to match. It cannot
   * prove a person ticked a box -- nothing without a second channel could --
   * and it is not pretending to. What it proves is that the content being sent
   * is the content that was confirmed, which is the failure this catches: a
   * stale page, an edited field, a doubled request carrying an old body.
   *
   * The audited address comes from the DOCUMENT rather than from the request,
   * so a caller cannot supply one that makes their fingerprint fit.
   */
  const content: SendContent = {
    jobId: sent.jobId,
    recipient: sent.recipient,
    auditedUrl: outcome.document.cover.auditedUrl,
    ...sent.fields,
  };

  if (sent.confirmedFor === "" || sent.confirmedFor !== contentFingerprint(content)) {
    return { ok: false, status: 409, error: NOT_CONFIRMED };
  }

  // 8. The same renderer the download button uses, and no retry on failure.
  let pdf: Buffer;
  const rendering = { op: "pdf.render", job: sent.jobId, via: "email" } as const;
  const renderedAt = Date.now();
  try {
    pdf = await render(outcome.document);
    logOutcome({
      ...rendering,
      outcome: "succeeded",
      ms: Date.now() - renderedAt,
      bytes: Buffer.isBuffer(pdf) ? pdf.length : undefined,
      ...commentary,
    });
  } catch (error) {
    // The category only. The error is not handed to the log at all.
    logOutcome({
      ...rendering,
      outcome: "failed",
      reason: renderFailureReason(error),
      ms: Date.now() - renderedAt,
      ...commentary,
    });

    const message =
      error instanceof PdfRenderError ? error.message : PDF_RENDER_MESSAGES["internal-error"];
    return { ok: false, status: 500, error: message };
  }

  const preview = previewFor(content);
  const email: OutgoingEmail = {
    to: preview.recipient,
    from,
    subject: preview.subject,
    /*
     * THE SAME WORDS THE PERSON READ. The preview is not a mock-up of the
     * email; it is the email, composed by the one function that composes it.
     */
    text: preview.body,
    attachment: {
      filename: exportFilename(outcome.document.cover.auditedUrl),
      content: pdf,
    },
  };

  // 9. One send. No loop, nothing calls this again, and the seam offers no retry.
  const sentAt = Date.now();
  const delivery = await provider.send(email);

  /*
   * WHETHER THE EMAIL SERVICE TOOK THE REQUEST, and nothing about the message:
   * not who it was for, not who it was from, not its subject, and not the
   * receipt the service handed back. "Accepted" is all that is known here --
   * whether it arrived is the service's to say.
   */
  logOutcome({
    op: "email.send",
    job: sent.jobId,
    outcome: delivery.ok ? "accepted" : "not-accepted",
    reason: delivery.ok ? undefined : delivery.failure,
    ms: Date.now() - sentAt,
  });

  if (!delivery.ok) {
    /*
     * 502 for the service's problems and 429 for its limit. Never the
     * provider's own message: it carries request ids, account ids and
     * sometimes the message itself, and none of that belongs in front of a
     * person or in a log.
     */
    /*
     * 503 for "this server is not set up", which is what a missing,
     * restricted or suspended key becomes. It is the same answer the early
     * check gives, so a key that disappears between the two does not change
     * what a person is told. 429 for the service's limit, 502 for its
     * problems and for a message it would not accept.
     */
    const status =
      delivery.failure === "not-configured" ? 503 : delivery.failure === "rate-limited" ? 429 : 502;
    return { ok: false, status, error: SEND_FAILURE_MESSAGES[delivery.failure] };
  }

  /*
   * THE ONE PLACE AN ALLOWANCE IS SPENT, and it is after the only line that
   * can put a message in front of a client. Nothing above here consumes one,
   * so the count means what its name says.
   */
  recordSend(caller, now);

  return { ok: true, recipient: preview.recipient };
}
