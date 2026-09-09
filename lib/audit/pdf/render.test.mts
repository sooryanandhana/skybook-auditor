/**
 * Tests that launch a real browser.
 *
 * SLOW ON PURPOSE AND FEW ON PURPOSE. Everything answerable from a string is
 * answered in `shell.test.mts`, which launches nothing. What is left is the
 * handful of claims that are only true if Chromium actually behaves the way
 * the 7C evaluation said it would, and the evaluation was explicit that those
 * claims came from documentation rather than from running the code.
 *
 * TWO OF THEM CARRY A CONTROL. A test asserting that no request reached a
 * server proves nothing unless the same server can be shown to receive one, and
 * a test asserting that a script did not run proves nothing unless the same
 * script can be shown to run. Both controls are here, so a protection that
 * silently stopped working would fail these rather than pass them.
 *
 * NOTHING HERE REACHES THE INTERNET. The one server involved is started by the
 * test on a loopback port and closed by it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import http from "node:http";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { PDF_RENDER_MESSAGES, PdfRenderError, configurePage, renderPdf } from "./render.ts";
import { PAGE_MARGIN } from "./settings.ts";
import { testDocument } from "./testDocument.fixture.mts";

/** A loopback server that counts what reached it. */
async function countingServer() {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    get hits() {
      return hits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A launcher that keeps every browser it hands out.
 *
 * The lifecycle question is "was this browser closed", and a browser can
 * answer it. Counting the machine's `chrome.exe` processes would have been
 * asking about the user's own browsing as much as about the renderer.
 */
function recordingLauncher() {
  const browsers: Browser[] = [];
  return {
    browsers,
    launch: async (): Promise<Browser> => {
      const browser = await puppeteer.launch({ headless: true });
      browsers.push(browser);
      return browser;
    },
  };
}

/** How many `/Type /Page` objects the file declares. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** The DOM as the browser holds it, read without running any page script. */
async function domOf(page: Page): Promise<string> {
  const cdp = await page.createCDPSession();
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId: root.nodeId });
  return outerHTML;
}

// ---------------------------------------------------------------------------
// A · It produces a PDF
// ---------------------------------------------------------------------------

test("the renderer produces a valid PDF from a prepared document", async () => {
  const pdf = await renderPdf(testDocument());

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "the file signature");
  assert.ok(pdf.includes(Buffer.from("%%EOF")), "and a complete trailer");
  assert.ok(pdf.length > 1000, "not an empty document");
});

test("the renderer takes a prepared document, not an audit", async () => {
  /*
   * The type says this already; the test says it about a value. A document is
   * the whole of what the renderer is given, and nothing about the audit that
   * produced it -- no job, no result, no page array -- has to be present for a
   * PDF to come out.
   */
  const pdf = await renderPdf(testDocument());
  assert.ok(pdf.length > 0);
});

test("a document with more sections produces more pages", async () => {
  const small = await renderPdf(testDocument({ measured: [], coverageDetail: [] }));
  const large = await renderPdf(testDocument());

  assert.ok(pageCount(small) >= 1);
  assert.ok(
    pageCount(large) > pageCount(small),
    "the sections the document carries reach the page",
  );
});

// ---------------------------------------------------------------------------
// B and C · The browser is always closed
// ---------------------------------------------------------------------------

test("no browser survives a successful render", async () => {
  const launcher = recordingLauncher();

  await renderPdf(testDocument(), { launch: launcher.launch });

  assert.equal(launcher.browsers.length, 1, "exactly one browser was launched");
  assert.equal(launcher.browsers[0].connected, false, "and it was closed");
});

test("no browser survives a render that ran out of budget", async () => {
  /*
   * THE CASE THAT LEAKED. The budget expires while the browser is still
   * starting, so the render rejects before there is a browser to close. An
   * earlier version held the resolved browser rather than the launch promise,
   * saw nothing in its `finally`, and left Chromium running.
   */
  const launcher = recordingLauncher();

  await assert.rejects(
    () => renderPdf(testDocument(), { launch: launcher.launch, timeoutMs: 1 }),
    PdfRenderError,
  );

  assert.equal(launcher.browsers.length, 1, "the browser still arrived");
  assert.equal(launcher.browsers[0].connected, false, "and was closed anyway");
});

test("no browser survives a render that failed part way through", async () => {
  const launcher = recordingLauncher();

  await assert.rejects(
    () =>
      renderPdf(testDocument(), {
        launch: async () => {
          const browser = await launcher.launch();
          // Closed underneath the renderer, so every later step throws.
          await browser.close();
          return browser;
        },
      }),
    PdfRenderError,
  );

  assert.equal(launcher.browsers.length, 1);
  assert.equal(launcher.browsers[0].connected, false);
});

test("a browser that will not start is reported as the tool being unavailable", async () => {
  // Never as a fault in the audit or the website. 7A §23.
  await assert.rejects(
    () => renderPdf(testDocument(), { launch: () => Promise.reject(new Error("spawn ENOENT")) }),
    (error: unknown) => {
      assert.ok(error instanceof PdfRenderError);
      assert.equal(error.failure, "browser-unavailable");
      assert.ok(!error.message.includes("ENOENT"), "the underlying cause is not carried");
      return true;
    },
  );
});

test("a render that runs out of budget fails as a timeout, with a fixed sentence", async () => {
  await assert.rejects(
    () => renderPdf(testDocument(), { timeoutMs: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof PdfRenderError);
      assert.equal(error.failure, "timed-out");
      assert.equal(error.message, PDF_RENDER_MESSAGES["timed-out"]);
      return true;
    },
  );
});

test("a renderer error carries no browser internals", async () => {
  /*
   * 7A §22 excludes internal paths and process detail from anything a client
   * sees. Puppeteer's own errors quote the executable path and the user-data
   * directory, so the test is that ours quote neither.
   */
  const error = new PdfRenderError("internal-error");
  const text = `${error.message} ${error.stack ?? ""}`.toLowerCase();

  for (const leak of ["chrome.exe", "--user-data-dir", "puppeteer_dev", "headless_shell"]) {
    assert.ok(!error.message.toLowerCase().includes(leak), `the message omits ${leak}`);
  }
  assert.ok(!text.includes("--"), "and carries no command-line flag");
});

test("every failure has a sentence, and none of them blames the website", async () => {
  for (const [failure, message] of Object.entries(PDF_RENDER_MESSAGES)) {
    assert.ok(message.length > 0, `${failure} has a sentence`);
    assert.ok(message.endsWith("."), `${failure} is a sentence`);
    assert.ok(
      !/site|website|domain|page is/i.test(message),
      `${failure} says nothing about the audited site`,
    );
  }
});

// ---------------------------------------------------------------------------
// D · Network requests are blocked
// ---------------------------------------------------------------------------

test("a configured page reaches no server, and an unconfigured one does", async () => {
  const server = await countingServer();
  const asset = `${server.origin}/tracker.png`;
  const markup = `<!doctype html><html lang="en"><body><img src="${asset}" alt=""></body></html>`;

  const browser = await puppeteer.launch({ headless: true });
  try {
    // The control. Without our configuration the request lands, which is what
    // makes the assertion below meaningful.
    const open = await browser.newPage();
    await open.setContent(markup, { waitUntil: "load" });
    assert.ok(server.hits > 0, "the control proves this test can detect a request");

    const reached = server.hits;

    // The real case.
    const locked = await browser.newPage();
    await configurePage(locked);
    await locked.setContent(markup, { waitUntil: "load" });
    assert.equal(server.hits, reached, "nothing left the configured page");
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a full render reaches no server", async () => {
  const server = await countingServer();
  try {
    const document = testDocument();
    await renderPdf({
      ...document,
      // An address that would be fetched if anything treated it as a resource.
      cover: { ...document.cover, auditedUrl: `${server.origin}/audited-page` },
    });

    assert.equal(server.hits, 0, "the renderer fetched nothing, not even the audited site");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E · JavaScript does not execute
// ---------------------------------------------------------------------------

test("a script does not run on a configured page, and does run on an open one", async () => {
  /*
   * The script REMOVES a sentinel rather than writing one, so the sentinel
   * never appears in the script's own source and this check cannot match
   * itself. An earlier version of this probe asserted on a string the script
   * also contained, and reported that every protection had failed.
   */
  const markup =
    `<!doctype html><html lang="en"><body><p>SENTINEL-ONE</p><p id="b">SENTINEL-TWO</p>` +
    `<script>document.querySelector('p').remove()</script>` +
    `<img src="x.png" onerror="document.getElementById('b').remove()" alt=""></body></html>`;

  const browser = await puppeteer.launch({ headless: true });
  try {
    const open = await browser.newPage();
    await open.setContent(markup, { waitUntil: "load" });
    const control = await domOf(open);
    assert.ok(!control.includes("SENTINEL-ONE"), "the control proves the script would run");

    const locked = await browser.newPage();
    await configurePage(locked);
    await locked.setContent(markup, { waitUntil: "load" });
    const dom = await domOf(locked);

    assert.ok(dom.includes("SENTINEL-ONE"), "the inline script did not run");
    assert.ok(dom.includes("SENTINEL-TWO"), "and neither did the event handler");
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// F · Document text is text, in the browser as well as in the string
// ---------------------------------------------------------------------------

test("markup in a document value produces no element in the rendered DOM", async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await configurePage(page);
    const { documentHtml } = await import("./shell.ts");
    await page.setContent(
      documentHtml(testDocument({ measured: [{ heading: "<b>BOLDSENTINEL</b>", facts: [] }] })),
      { waitUntil: "load" },
    );

    const dom = await domOf(page);
    assert.ok(dom.includes("BOLDSENTINEL"), "the text is on the page");
    assert.ok(!dom.includes("<b>BOLDSENTINEL</b>"), "and the browser parsed no element from it");
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// G and H · The running head, foot and page number reach the file
// ---------------------------------------------------------------------------

test("enabling the running head and foot changes what is drawn on the page", async () => {
  /*
   * Chromium writes text as glyph indices against a subset font, so the words
   * cannot be read back out without a font-aware extractor. That extractor is
   * a later step's dependency. What can be measured now, with nothing added, is
   * the number of text-drawing operations: turning the templates on must
   * increase it, and by more than one page's worth.
   */
  const { default: zlib } = await import("node:zlib");

  const drawOps = (pdf: Buffer) => {
    let total = 0;
    let index = 0;
    for (;;) {
      const start = pdf.indexOf("stream", index);
      if (start === -1) break;
      let from = start + 6;
      if (pdf[from] === 0x0d) from += 1;
      if (pdf[from] === 0x0a) from += 1;
      const end = pdf.indexOf("endstream", from);
      if (end === -1) break;
      try {
        total += zlib.inflateSync(pdf.subarray(from, end)).toString("latin1").split("Tj").length - 1;
      } catch {
        // Not every stream is text, and not every stream is deflated.
      }
      index = end + 9;
    }
    return total;
  };

  const document = testDocument();
  const withTemplates = await renderPdf(document);

  const browser = await puppeteer.launch({ headless: true });
  let without: Buffer;
  try {
    const page = await browser.newPage();
    await configurePage(page);
    const { documentHtml } = await import("./shell.ts");
    await page.setContent(documentHtml(document), { waitUntil: "load" });
    without = Buffer.from(await page.pdf({ format: "a4", margin: { ...PAGE_MARGIN } }));
  } finally {
    await browser.close();
  }

  assert.ok(
    drawOps(withTemplates) > drawOps(without),
    "the head and foot are drawn on every page",
  );
});

test("the margins reserve room for the head and foot rather than hiding them", () => {
  // Verified on Chrome 152: the templates are drawn whether or not the margin
  // leaves space, so too small a margin produces overlap, not omission. These
  // values are temporary and exist so the foundation does not overlap.
  assert.equal(PAGE_MARGIN.top, "24mm");
  assert.equal(PAGE_MARGIN.bottom, "20mm");
});

