/**
 * A prepared document, and the browser that turns it into PDF bytes.
 *
 * THE ONLY THING THIS MODULE KNOWS IS `PdfDocument`. It has no job store, no
 * job identifier, no audit result, no rule, no collector and no model client.
 * It cannot fetch the audited site, because it is never told what the audited
 * site was in a form it could fetch, and because the browser it drives has had
 * its network taken away. 7A §25 asks for a renderer that receives one prepared
 * object and reads nothing else; this receives one and can reach nothing else.
 *
 * THREE ISOLATION RULES, and each is tested rather than asserted:
 *
 *   No network. Every request the page makes is aborted, so no font, image,
 *   stylesheet, tracker or audited page can be fetched, and nothing the
 *   document carries can be sent anywhere.
 *
 *   No JavaScript. The document needs none. With scripting off, a script that
 *   survived the escaping in `escape.ts` still cannot run -- two independent
 *   failures would be needed rather than one.
 *
 *   No filesystem. The page is set from a string. Nothing is read from disk
 *   and nothing is written to it, so a crash leaves nothing behind.
 *
 * ONE BROWSER PER RENDER, deliberately, for now. Reusing an instance across
 * requests is the right shape eventually and is the wrong thing to build
 * first: a shared browser needs a lifecycle, a health check and a concurrency
 * bound, and none of those can be designed before there is a renderer to
 * measure. This launches, renders and closes, and it closes in a `finally` so
 * a failure leaves no process behind.
 */
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { PdfDocument } from "../pdfDocument.ts";
import { documentHtml, documentTitle, footOf, headOf } from "./shell.ts";
import { SKYBOOK_NAME } from "./logo.ts";
import { withMetadata } from "./metadata.ts";
import { footerTemplate, headerTemplate } from "./runningHeadFoot.ts";
import { PAGE_FORMAT, PAGE_MARGIN, PDF_RENDER_BUDGET_MS } from "./settings.ts";

/**
 * Why a render produced nothing.
 *
 * A closed set, like every other failure in this project, so a caller can
 * answer without reading a message. `internal-error` is the default for
 * anything unrecognised, and it is deliberately the vaguest of the three: a
 * renderer that guessed would be making a confident claim about a cause it does
 * not know.
 */
export type PdfRenderFailure = "timed-out" | "browser-unavailable" | "internal-error";

/**
 * What a caller may show. 7A §23 requires a fixed sentence for each case, and
 * nothing about the website in any of them -- a PDF that could not be produced
 * is a failure of the download, never of the audit.
 */
export const PDF_RENDER_MESSAGES: Record<PdfRenderFailure, string> = {
  "timed-out": "The report took too long to produce, so no file was created.",
  "browser-unavailable": "The report tool is not available on this server right now.",
  "internal-error": "The report could not be produced.",
};

/**
 * The error a failed render throws.
 *
 * IT CARRIES NO CAUSE. Puppeteer's own errors quote the browser's command
 * line, its user-data directory and its executable path, and 7A §22 excludes
 * all three from anything a client can see. The original is not attached, not
 * re-thrown and not logged here -- there is nowhere for it to leak from,
 * because it is never carried.
 */
export class PdfRenderError extends Error {
  readonly failure: PdfRenderFailure;

  constructor(failure: PdfRenderFailure) {
    super(PDF_RENDER_MESSAGES[failure]);
    this.name = "PdfRenderError";
    this.failure = failure;
  }
}

/**
 * How a browser is obtained.
 *
 * INJECTED SO THE LIFECYCLE CAN BE TESTED. Asking the operating system how
 * many browser processes exist proves nothing on a machine where a person is
 * also using one: an earlier version of these tests counted every `chrome.exe`
 * and would have been answering a question about the user's own browsing.
 * Given the launcher, a test can hold the browsers this function created and
 * ask each of them directly whether it was closed.
 */
export type BrowserLauncher = () => Promise<Browser>;

export interface RenderOptions {
  /** The whole call's budget, launch included. 7A §23. Never retried. */
  readonly timeoutMs?: number;
  /** Defaults to a real headless Chromium. Replaced only by tests. */
  readonly launch?: BrowserLauncher;
}

/**
 * Everything that makes a page safe, in one place.
 *
 * EXPORTED SO IT CAN BE TESTED DIRECTLY. A test that drove `renderPdf` could
 * only inspect the PDF afterwards, and a PDF is a poor place to ask whether a
 * script ran. Given the page itself, a test can ask the browser directly. This
 * is the same function the render path uses, not a copy of it.
 *
 * Order matters. Both settings are applied before any content is set, so there
 * is no window in which a document exists on an unconfigured page.
 */
export async function configurePage(page: Page): Promise<void> {
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    /*
     * `abort` rejects if the request is already gone, which is a race rather
     * than a problem: a request that no longer exists is not one that reached
     * the network. Swallowed so an unhandled rejection cannot fail a render
     * that actually succeeded.
     */
    void request.abort().catch(() => {});
  });
}

/**
 * The document, as PDF bytes.
 *
 * Deterministic in everything it controls: the same `PdfDocument` produces the
 * same content, in the same order, every time. Byte equality is a different
 * claim and not one this makes -- every PDF carries a creation date, which 7A
 * §3 and §25 already exempt.
 */
export async function renderPdf(
  document: PdfDocument,
  options: RenderOptions = {},
): Promise<Buffer> {
  const budgetMs = options.timeoutMs ?? PDF_RENDER_BUDGET_MS;
  const launcher = options.launch ?? (() => puppeteer.launch({ headless: true }));

  /*
   * THE PROMISE, NOT THE BROWSER. Held as a promise and assigned before the
   * first await inside the work, so the `finally` below has something to close
   * even when the budget expires while the browser is still starting.
   *
   * Holding the resolved browser instead was a real leak, found by a test
   * rather than by reading: a render that ran out of budget rejected before
   * the launch resolved, the `finally` saw nothing to close, and Chromium
   * outlived the request. Awaiting the promise here means a browser that
   * arrives late is still closed, and the call does not settle until it is.
   */
  const held: { browser: Promise<Browser> | null } = { browser: null };

  try {
    return await withBudget(budgetMs, async () => {
      let browser: Browser;
      try {
        held.browser = launcher();
        browser = await held.browser;
      } catch {
        /*
         * A browser that will not start is its own answer. It is the one
         * failure a person can act on -- the download is not installed on this
         * machine -- and it must not be reported as a fault in the report.
         */
        throw new PdfRenderError("browser-unavailable");
      }

      const page = await browser.newPage();
      await configurePage(page);
      await page.setContent(documentHtml(document), { waitUntil: "load" });

      const pdf = Buffer.from(
        await page.pdf({
          format: PAGE_FORMAT,
          printBackground: true,
          margin: { ...PAGE_MARGIN },
          displayHeaderFooter: true,
          headerTemplate: headerTemplate(headOf(document)),
          footerTemplate: footerTemplate(footOf(document)),
          /*
           * STATED, NOT INHERITED. Puppeteer 25 already defaults this to true,
           * and a file rendered without it is byte-identical to one rendered
           * with it. It is written down anyway, because 7A §24 asks for a
           * tagged document and a requirement met by somebody else's default
           * is a requirement that can disappear in a minor version without
           * anything here failing.
           *
           * What it buys, measured on Chrome 152: a marked-content flag, a
           * structure tree, the document language, and real H1 to H4, P,
           * Table, TR, TH, TD, L, LI and Figure elements. Turning it off
           * loses every one of them.
           *
           * NOT A CONFORMANCE CLAIM. See the note on artifacts in
           * `runningHeadFoot.ts`: this is a tagged, navigable document, and it
           * is not a PDF/UA document.
           */
          tagged: true,
        }),
      );

      /*
       * THE TITLE CHROMIUM WOULD NOT WRITE. Its print interface takes no
       * metadata, so the file arrives with no title at all, while already
       * carrying the viewer preference asking a reader to display one. This
       * appends it without touching a byte of what Chromium produced; see
       * `metadata.ts` for why it is an append rather than a rewrite.
       */
      return withMetadata(pdf, {
        title: documentTitle(document),
        author: SKYBOOK_NAME,
        subject: `Website audit for ${document.cover.auditedUrl}`,
      });
    });
  } catch (error) {
    if (error instanceof PdfRenderError) throw error;
    throw new PdfRenderError("internal-error");
  } finally {
    /*
     * THE PROCESS IS CLOSED WHATEVER HAPPENED. A leaked Chromium survives the
     * request, the test run and in principle the working day. The whole chain
     * is given a catch because a launch that failed and a browser that has
     * already died both throw here, and throwing from a `finally` would
     * replace the real failure with a meaningless one.
     */
    if (held.browser !== null) await held.browser.then((b) => b.close()).catch(() => {});
  }
}

/**
 * A hard bound on the whole call.
 *
 * Puppeteer's own timeouts are per operation, so a launch that hangs and a
 * navigation that hangs each get the full allowance and the total is
 * unbounded. This bounds the total, which is what 7A §23 asks for. The work is
 * not cancelled -- it cannot be -- but the `finally` above still closes the
 * browser, so nothing outlives the call.
 */
async function withBudget<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PdfRenderError("timed-out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
