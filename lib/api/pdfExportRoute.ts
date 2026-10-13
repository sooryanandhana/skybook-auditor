/**
 * The decisions behind POST /api/audit/pdf, as a plain function.
 *
 * SEPARATED FROM THE ROUTE FILE for the same reason every other endpoint's
 * decisions are: a Next.js handler cannot be imported by the unit tests
 * without a bundler, and the judgements worth testing are which status code,
 * which sentence, and whether a document may be produced at all. The route
 * becomes an adapter.
 *
 * IT READS A FINISHED AUDIT AND NOTHING ELSE. No audit is started, no page is
 * crawled, no speed check is run and no model is asked anything. Every number
 * in the document was measured before this function was called. Exporting is a
 * read of something that already exists.
 *
 * OUTSIDE THE AUDIT'S RATE LIMIT, deliberately, and 7A §21 settled it. That
 * bucket bounds how many audits a caller can start and how much paid speed
 * quota they can spend. This starts no audit, crawls nothing, measures no
 * speed and takes no audit slot; putting it in the same bucket would let
 * downloading reports block running them.
 *
 * OUTSIDE THE POLLING PATH. Nothing here is reachable from the status or
 * result endpoints the results page polls, so a page left open cannot produce
 * a document by itself. It happens because somebody asked.
 *
 * NOTHING INTERNAL LEAVES THROUGH HERE. Every refusal below is either a fixed
 * sentence or one the job layer already wrote for a person to read. A renderer
 * exception's own message never reaches a caller: 7A §23 requires a fixed
 * sentence with no exception text, no stack and no file path, and the renderer
 * already throws an error carrying none of those.
 */
import { auditJobs, type AuditJobStore } from "../jobs/auditJobs.ts";
import { JOB_NOT_FOUND, NO_JOB_ID, NOT_READY, UNKNOWN_FAILURE } from "../jobs/jobResponses.ts";
import { buildPdfDocument, type PdfDocument, type PdfDocumentOptions } from "../audit/pdfDocument.ts";
import { renderPdf, PDF_RENDER_MESSAGES, PdfRenderError } from "../audit/pdf/render.ts";
import { logOutcome, type ReliabilityEvent } from "../log/reliabilityLog.ts";

/**
 * Whether the document carries written commentary, and where the commentary
 * stood when the document was built. For the reliability log.
 *
 * TWO FACTS, READ FROM TWO PLACES, SO NEITHER HAS TO BE GUESSED.
 *
 * `aiText` is read from the document itself. It says what the file that was
 * rendered contains, and it cannot disagree with that file, because it is the
 * same value the renderer draws the section from.
 *
 * `aiState` is read from the job, and says why: the commentary was written,
 * was asked for and failed, is still being written, or was never asked for.
 *
 * CALL IT ON THE LINE AFTER THE DOCUMENT IS BUILT, WITH NOTHING AWAITED IN
 * BETWEEN. Building the document and reading the job are then one uninterrupted
 * step, and no answer can arrive between them. A job read earlier in a request
 * may be out of date by the time the document is built, which is why this does
 * not take one.
 *
 * A job that has gone by the time it is read is given no state, and is not
 * given a made-up one.
 */
export function commentaryAt(
  document: PdfDocument,
  store: AuditJobStore,
  jobId: string,
): Pick<ReliabilityEvent, "aiText" | "aiState"> {
  const aiText = document.summary.ai !== null ? "included" : "absent";

  const job = store.get(jobId);
  if (job === null) return { aiText };

  const aiState =
    job.explanation !== null
      ? job.explanation.state
      : job.explanationClaimed
        ? "pending"
        : "not-requested";

  return { aiText, aiState };
}

/** The category of a failed render, and never the error itself. */
export function renderFailureReason(error: unknown): string {
  return error instanceof PdfRenderError ? error.failure : "internal-error";
}

/** Sent when a job finished but carried no result to describe. */
export const NO_RESULT = "The audit finished but its result could not be read.";

/**
 * What the endpoint answers.
 *
 * A DISCRIMINATED UNION rather than the JSON-shaped `ApiResult` the other
 * endpoints use, because this one answers with bytes when it succeeds. Sharing
 * that type would have meant a body that is sometimes an object and sometimes
 * a buffer, which is exactly the sort of thing an adapter then gets wrong.
 */
export type PdfExportResult =
  | { readonly ok: true; readonly pdf: Buffer; readonly filename: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** The client's own details, exactly the three 7A §15 defines. Every one optional. */
export interface PdfExportFields {
  readonly companyName?: string;
  readonly contactName?: string;
  readonly preparedBy?: string;
}

/**
 * A file name a person can find again.
 *
 * Built from the audited host and nothing else, with anything awkward replaced
 * so no caller-supplied text can steer a path or a header. The client's own
 * name is deliberately not in it: it is optional, it may contain anything, and
 * a downloaded file carrying a prospect's name is the kind of thing that gets
 * forwarded to the wrong person.
 */
export function exportFilename(auditedUrl: string): string {
  let host = "website";
  try {
    host = new URL(auditedUrl).hostname || host;
  } catch {
    // An address that will not parse still gets a usable name.
  }

  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "-").replace(/^-+|-+$/g, "") || "website";
  return `skybook-audit-${safe}.pdf`;
}

/**
 * The three client fields out of a JSON body.
 *
 * A BODY THAT WILL NOT PARSE IS NOT A REFUSAL. Every field is optional, so an
 * absent or malformed body means the same thing as an empty one: no client
 * details. Refusing there would fail an export for the sake of three fields
 * the document is required to be correct without.
 *
 * Only strings are taken, and only the three that are defined. Anything else
 * in the body is ignored rather than passed on, so the body cannot become a
 * way to reach the projection's other options.
 */
async function fieldsFrom(request: Request): Promise<PdfExportFields> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return {};

    const read = (key: string): string | undefined => {
      const value = (body as Record<string, unknown>)[key];
      return typeof value === "string" ? value : undefined;
    };

    return {
      companyName: read("companyName"),
      contactName: read("contactName"),
      preparedBy: read("preparedBy"),
    };
  } catch {
    return {};
  }
}

export interface PdfExportDeps {
  readonly store?: AuditJobStore;
  /** Swapped by tests so no test launches a browser it does not need. */
  readonly render?: typeof renderPdf;
}

/**
 * POST /api/audit/pdf?jobId=... — the finished audit, as a document.
 *
 * The refusals are 7A §23's, and each says what happened without saying
 * anything about the audited website. A PDF that cannot be produced is a
 * failure of the download, never of the audit: the report stays on screen and
 * unchanged either way.
 */
export async function pdfExportRoute(
  request: Request,
  deps: PdfExportDeps = {},
): Promise<PdfExportResult> {
  const store = deps.store ?? auditJobs();
  const render = deps.render ?? renderPdf;

  const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
  if (jobId === "") return { ok: false, status: 400, error: NO_JOB_ID };

  /*
   * UNKNOWN AND EXPIRED GIVE THE SAME ANSWER, because they cannot be told
   * apart: an expired job is deleted. The job layer already owns that sentence
   * and the half-hour window it explains, so it is used rather than reworded.
   */
  const job = store.get(jobId);
  if (job === null) return { ok: false, status: 404, error: JOB_NOT_FOUND };

  if (job.status === "queued" || job.status === "running") {
    // 409: the request is fine, the resource is not in a state to answer it.
    return { ok: false, status: 409, error: NOT_READY };
  }

  if (job.status === "failed") {
    /*
     * The audit's own reason, which a collector wrote for a person to read.
     * There is no report to render, and inventing one would be inventing
     * measurements.
     */
    return { ok: false, status: 409, error: job.error ?? UNKNOWN_FAILURE };
  }

  const fields: PdfDocumentOptions = await fieldsFrom(request);

  /*
   * THE PROJECTION DECIDES WHAT THE DOCUMENT MAY SHOW, not this function. It
   * re-checks the job for itself, which is not redundant: it is the boundary,
   * and a boundary that trusted its caller to have checked would be one check
   * away from printing an empty report as though it were an audit.
   */
  const outcome = buildPdfDocument(jobId, store, fields);
  if (!outcome.ok) {
    if (outcome.reason === "unknown-job") return { ok: false, status: 404, error: JOB_NOT_FOUND };
    if (outcome.reason === "not-finished") return { ok: false, status: 409, error: NOT_READY };
    return { ok: false, status: 409, error: NO_RESULT };
  }

  // Read here, straight after the document was built. See `commentaryAt`.
  const commentary = commentaryAt(outcome.document, store, jobId);
  const renderedAt = Date.now();
  const rendering = { op: "pdf.render", job: jobId, via: "download" } as const;

  try {
    const pdf = await render(outcome.document);
    logOutcome({
      ...rendering,
      outcome: "succeeded",
      ms: Date.now() - renderedAt,
      bytes: Buffer.isBuffer(pdf) ? pdf.length : undefined,
      ...commentary,
    });
    return { ok: true, pdf, filename: exportFilename(outcome.document.cover.auditedUrl) };
  } catch (error) {
    // The category only. The error is not handed to the log at all.
    logOutcome({
      ...rendering,
      outcome: "failed",
      reason: renderFailureReason(error),
      ms: Date.now() - renderedAt,
      ...commentary,
    });

    /*
     * NO RETRY, per 7A §23: a second attempt at a deterministic render of the
     * same data fails the same way, and a retry would double a slow render's
     * cost for nothing.
     *
     * The renderer's own error carries a fixed sentence and no cause -- it is
     * built that way precisely so this line cannot leak a browser command line
     * or a file path. Anything else that reaches here gets the generic
     * sentence rather than its own message.
     */
    const message =
      error instanceof PdfRenderError ? error.message : PDF_RENDER_MESSAGES["internal-error"];

    // 500: the audit is fine and the report is fine; producing the file failed.
    return { ok: false, status: 500, error: message };
  }
}
