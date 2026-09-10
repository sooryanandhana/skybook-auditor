/**
 * Asking the server for the report, and handing the file to the browser.
 *
 * SEPARATED FROM THE PAGE for the reason every decision in this project is:
 * the results page is a client component and cannot be imported by the unit
 * tests without a bundler, and the judgements worth testing are which sentence
 * a refusal produces, whether a second click can start a second export, and
 * what the saved file is called.
 *
 * IT IMPORTS NOTHING FROM THE RENDERER, and that is load-bearing rather than
 * tidy. This module ends up in the browser bundle. The renderer imports
 * Puppeteer and reads a megabyte of fonts at module load, so a single import
 * from here would try to drag a headless browser into a web page. A test
 * asserts the absence.
 *
 * IT STARTS NOTHING. One request, to one endpoint, carrying a job id that
 * already exists. No audit, no crawl, no speed check, no model. The endpoint
 * on the other end is built the same way and asserts the same thing about
 * itself.
 */

/** What a download attempt produced. */
export type PdfDownload =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly message: string };

/** The three optional fields 7A §15 defines. The report is correct without any. */
export interface PdfClientFields {
  readonly companyName?: string;
  readonly contactName?: string;
  readonly preparedBy?: string;
}

/**
 * The three fields, in one list: what each is called and what it is called on
 * screen.
 *
 * ONE LIST, because the form that collects them and the request that sends
 * them are two places that must agree about which three fields exist. A fourth
 * box added to the form without a matching key here would be typed into and
 * silently dropped, which is the kind of failure nobody reports.
 */
export const CLIENT_FIELDS = [
  { key: "companyName", label: "Client company" },
  { key: "contactName", label: "Contact name" },
  { key: "preparedBy", label: "Prepared by" },
] as const satisfies readonly { key: keyof PdfClientFields; label: string }[];

/**
 * When this server cannot be reached at all.
 *
 * ITS OWN SENTENCE, because it is the one case where no answer came back to
 * quote. It says what happened -- we could not reach the server -- and nothing
 * about the audit, which is already on screen and unaffected.
 */
export const DOWNLOAD_UNREACHABLE =
  "Could not reach this server to make the report. The audit above is unaffected.";

/**
 * When an answer came back that carried no sentence of its own.
 *
 * A refusal from the endpoint always carries wording written for a person, so
 * this is the fallback for a response that is not one -- a proxy's error page,
 * say. Fixed, because whatever that body contains is not something to show a
 * client.
 */
export const DOWNLOAD_FAILED = "The report could not be produced.";

/** Saves bytes as a file. Replaced by tests, which have no browser. */
export type SaveFile = (data: Blob, filename: string) => void;

export interface PdfDownloadDeps {
  readonly fetchImpl?: typeof fetch;
  readonly save?: SaveFile;
}

/**
 * The default save: an object URL and a click, then the URL is released.
 *
 * A DOWNLOAD, NOT A NAVIGATION. Pointing the page at the endpoint would work
 * and would take the salesperson away from the audit they are reading, and
 * back would re-post. An anchor with a download attribute keeps them where
 * they are.
 */
const saveToDisk: SaveFile = (data, filename) => {
  const href = URL.createObjectURL(data);
  const link = document.createElement("a");

  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  /*
   * Released on the next turn of the loop rather than immediately: revoking
   * while the click is still being handled cancels the download in some
   * browsers.
   */
  setTimeout(() => URL.revokeObjectURL(href), 0);
};

/**
 * The file name the server chose, out of the header it sent.
 *
 * THE SERVER'S NAME, NOT ONE BUILT HERE. It is derived there from the audited
 * address, with anything awkward already removed, and building a second one in
 * the browser would be a second answer that could disagree. The fallback is
 * used only when the header is missing entirely.
 */
export function filenameFrom(disposition: string | null): string {
  const quoted = /filename="([^"]+)"/.exec(disposition ?? "");
  const bare = /filename=([^;]+)/.exec(disposition ?? "");
  const name = (quoted?.[1] ?? bare?.[1] ?? "").trim();

  return name === "" ? "skybook-audit.pdf" : name;
}

/** Only the fields that carry something, so an empty box is never sent. */
function filled(fields: PdfClientFields): Record<string, string> {
  const body: Record<string, string> = {};

  for (const { key } of CLIENT_FIELDS) {
    const value = fields[key]?.trim() ?? "";
    if (value !== "") body[key] = value;
  }

  return body;
}

/**
 * Ask for the report and save it.
 *
 * ONE REQUEST, AND NO RETRY. The endpoint does not retry a failed render
 * either, for the same reason: a second attempt at a deterministic render of
 * the same data fails the same way.
 *
 * A REFUSAL IS QUOTED, NEVER REWRITTEN. Every sentence the endpoint sends was
 * written for a person to read -- the audit is still running, that audit could
 * not be found, the report took too long -- and it already guarantees that
 * nothing internal is in them. Wording them again here would be a second copy
 * that drifts.
 */
export async function downloadPdf(
  jobId: string,
  fields: PdfClientFields = {},
  deps: PdfDownloadDeps = {},
): Promise<PdfDownload> {
  const request = deps.fetchImpl ?? fetch;
  const save = deps.save ?? saveToDisk;

  let response: Response;
  try {
    response = await request(`/api/audit/pdf?jobId=${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filled(fields)),
    });
  } catch {
    return { ok: false, message: DOWNLOAD_UNREACHABLE };
  }

  if (!response.ok) {
    /*
     * The endpoint's own sentence when there is one. A body that is not its
     * JSON gets the fixed sentence instead, because whatever it is was not
     * written for a client to read.
     */
    try {
      const payload: unknown = await response.json();
      const message =
        typeof payload === "object" && payload !== null
          ? (payload as { error?: unknown }).error
          : undefined;

      return { ok: false, message: typeof message === "string" && message !== "" ? message : DOWNLOAD_FAILED };
    } catch {
      return { ok: false, message: DOWNLOAD_FAILED };
    }
  }

  const filename = filenameFrom(response.headers.get("Content-Disposition"));

  try {
    save(await response.blob(), filename);
  } catch {
    return { ok: false, message: DOWNLOAD_FAILED };
  }

  return { ok: true, filename };
}

/* ---------------------------------------------------------------------------
   What the page shows, and when it is allowed to ask

   BELOW THE REQUEST ON PURPOSE. Everything above answers "what happened"; this
   answers "what does a person see, and may they press it again". Both live
   here rather than in the component because the component cannot be tested
   without a browser, and these are the judgements worth pinning down.
   --------------------------------------------------------------------------- */

/** Where the export has got to. Four states, told apart. */
export type ExportState =
  | { readonly kind: "ready" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly filename: string }
  | { readonly kind: "failed"; readonly message: string };

/** Before anything has been asked for. */
export const EXPORT_READY: ExportState = { kind: "ready" };

export const REPORT_HEADING = "Client report";

/**
 * What pressing the button does, and what it does not do.
 *
 * THE SECOND SENTENCE IS THE POINT. This page has three buttons that go to a
 * server and two of them start work that costs time or money. This one asks
 * for a document to be typeset out of an audit that has already finished, and
 * a salesperson about to hand a laptop to a client should not have to wonder
 * whether it will re-crawl their site.
 */
export const REPORT_INTRO =
  "A PDF of this audit to give the client. It is typeset from the results above — nothing is checked again.";

export const DOWNLOAD_LABEL = "Download PDF report";

/** Present tense, because it is happening, and it takes a few seconds. */
export const DOWNLOAD_BUSY_LABEL = "Preparing report…";

export const CLIENT_DETAILS_LABEL = "Add client details (optional)";

export const CLIENT_DETAILS_HINT =
  "These appear on the cover page. The report is complete without them.";

/**
 * What is said once the file has been handed over.
 *
 * "SENT TO YOUR BROWSER" RATHER THAN "SAVED", because where it went is the
 * browser's decision -- straight to a downloads folder, or a dialogue that is
 * still open, or nowhere because the person cancelled it. Naming the file is
 * the useful part and is the part we actually know.
 */
export const downloadedNote = (filename: string) =>
  `Report ready — sent to your browser as ${filename}.`;

/**
 * Which audit a report may be asked for, or null when none may be.
 *
 * BOTH CONDITIONS, NOT EITHER. A job id exists from the moment an audit is
 * accepted, which is minutes before there is anything to typeset, and a job id
 * outlives an audit that then failed. So the id alone is not permission: there
 * must also be a finished result on screen. An audit that is still running, or
 * that failed, has no result and therefore no button -- it is not a disabled
 * button, there is nothing there to press.
 *
 * It hands back the id rather than a yes, so that a caller cannot be given
 * permission and then reach for an id that is null.
 */
export function exportableJobId(jobId: string | null, resultShown: boolean): string | null {
  if (!resultShown || jobId === null || jobId.trim() === "") return null;

  return jobId;
}

/** What the button says, and whether it can be pressed. */
export function downloadButton(state: ExportState): {
  readonly label: string;
  readonly disabled: boolean;
} {
  const working = state.kind === "working";
  return { label: working ? DOWNLOAD_BUSY_LABEL : DOWNLOAD_LABEL, disabled: working };
}

/**
 * One press of the button, from the click to the file.
 *
 * THE WHOLE HANDLER LIVES HERE so that a test drives the same code the button
 * does. The component holds the state and the markup and decides nothing.
 *
 * A SECOND PRESS WHILE ONE IS IN FLIGHT DOES NOTHING. The button is disabled
 * while it works, which is what a person sees; this is the guarantee behind
 * it, because a disabled button is a rendering and a render can lag a click.
 * Two requests would mean two renders of the same document, which is wasted
 * work on the server and two files in the client's downloads folder.
 *
 * IT DOES NOT CLEAR A PREVIOUS ANSWER AND STOP. The state moves straight from
 * whatever it was to "working", so the error from the last attempt disappears
 * as the new one starts rather than sitting under a running button.
 */
export async function runExport(
  state: ExportState,
  jobId: string,
  fields: PdfClientFields,
  onState: (next: ExportState) => void,
  deps: PdfDownloadDeps = {},
): Promise<void> {
  if (state.kind === "working") return;

  onState({ kind: "working" });

  const outcome = await downloadPdf(jobId, fields, deps);

  onState(
    outcome.ok
      ? { kind: "done", filename: outcome.filename }
      : { kind: "failed", message: outcome.message },
  );
}
