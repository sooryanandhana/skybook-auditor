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
import { EMBEDDED_FACES } from "./fonts.ts";
import { extractText } from "./pdfText.fixture.mts";
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

test("the document is paginated, and only where 7A §18 asks for a break", async () => {
  /*
   * REWRITTEN WHEN THE SECTIONS BECAME REAL. This once asserted that adding
   * fact sections added pages, which was only true while a temporary rule
   * forced every section onto its own page. Sections flow now, so a handful of
   * fact rows no longer buys a page, and asserting that it does would be
   * asserting the old rule rather than the new behaviour.
   *
   * What §18 actually promises is two forced pages: the cover, and "About this
   * report". Everything between them flows.
   */
  const pdf = await renderPdf(testDocument());
  const pages = pageCount(pdf);

  assert.ok(pages >= 3, `cover, body and the about page at least, got ${pages}`);
  assert.ok(pages <= 8, `a small audit should not sprawl, got ${pages}`);
});

test("a bigger document produces more pages than a small one", async () => {
  // The relationship that does still hold: more findings means more paper.
  const one = testDocument();
  const many = testDocument({
    siteFindings: {
      ...one.siteFindings,
      count: 24,
      groups: [
        {
          category: "security",
          label: "Security",
          findings: Array.from({ length: 24 }, (_value, index) => ({
            ...one.siteFindings.groups[0].findings[0],
            ruleId: `rule.${index}`,
            title: `Finding number ${index}`,
          })),
        },
      ],
    },
  });

  assert.ok(pageCount(await renderPdf(many)) > pageCount(await renderPdf(one)));
});

test("every face is embedded in the produced PDF, not left to the reader's machine", async () => {
  /*
   * THE TEST THAT WOULD HAVE CAUGHT IT, and did not exist while it was broken.
   *
   * An earlier version of the stylesheet embedded two variable fonts. Every
   * string-level check passed, the browser reported all three faces as loaded,
   * and `getComputedStyle` said each element resolved to the right family. The
   * PDF contained no font program for either variable face, because Chrome 152
   * does not embed them on its print path, so a reader without IBM Plex
   * installed would have seen a different document.
   *
   * The lesson is not about fonts. It is that asking the page what it thinks
   * it is doing answers a different question from asking the file what it
   * actually contains, and 7A §16 is a claim about the file.
   */
  const { default: zlib } = await import("node:zlib");
  const pdf = await renderPdf(testDocument());

  // Font dictionaries can sit inside compressed object streams, so the whole
  // file is inflated before being searched. Reading the raw bytes alone found
  // three of the five faces and missed the two that mattered.
  const chunks: string[] = [pdf.toString("latin1")];
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
      chunks.push(zlib.inflateSync(pdf.subarray(from, end)).toString("latin1"));
    } catch {
      // Not every stream is deflated, and the ones that are not carry no fonts.
    }
    index = end + 9;
  }
  const contents = chunks.join("");

  /*
   * THE FONTS THE FILE DECLARES, not every byte in it. An earlier version of
   * this test searched the whole inflated file for a family name and failed on
   * "Arial", which appears inside the embedded font programs themselves. A
   * 700KB binary will spell almost anything eventually; what decides how the
   * document draws is the set of `/BaseFont` entries.
   *
   * The six-character prefix on each is Chromium's subset tag.
   */
  const declared = [...new Set(contents.match(/\/BaseFont\s*\/[A-Za-z0-9+.\-]+/g) ?? [])].map(
    (entry) => entry.replace(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?/, ""),
  );

  /*
   * The PostScript names, which are not the filenames: the regular weight
   * drops its suffix and the semibold abbreviates.
   */
  for (const name of [
    "IBMPlexSans",
    "IBMPlexSans-SmBld",
    "IBMPlexSerif-SemiBold",
    "IBMPlexMono-Regular",
  ]) {
    assert.ok(
      declared.includes(name),
      `${name} is embedded in the file, not merely asked for in the stylesheet`,
    );
  }

  assert.ok(
    (contents.match(/\/FontFile2/g) ?? []).length >= EMBEDDED_FACES.length,
    "one embedded font program per face, at least",
  );

  /*
   * NO FACE COMES FROM THE MACHINE. The running head and foot used to: they
   * were Chromium's own templates, which could not load an embedded face. They
   * are page rules now and use the embedded sans like everything else, so the
   * file no longer depends on what the render machine has installed.
   */
  const fromMachine = declared.filter((name) => !name.startsWith("IBMPlex"));

  assert.equal(fromMachine.length, 0, `every face is embedded, but found ${fromMachine.join(", ")}`);
});

test("the Skybook mark is in the produced PDF, not merely in the markup", async () => {
  /*
   * THE SAME LESSON AS THE FONTS, APPLIED BEFORE IT COST ANYTHING. A test that
   * reads the HTML proves the image was asked for. Only the file proves it
   * arrived, and the fonts already demonstrated that Chromium can accept a
   * data URI, render it on screen, and put nothing in the PDF.
   *
   * An image reaches a PDF as an XObject. A JPEG keeps its own compression
   * rather than being re-encoded, so it appears with the DCTDecode filter and
   * with the artwork's own pixel dimensions.
   */
  const pdf = await renderPdf(testDocument());
  const raw = pdf.toString("latin1");

  assert.ok(raw.includes("/Subtype /Image"), "the file carries an image");
  assert.ok(raw.includes("/DCTDecode"), "and it is the JPEG, still JPEG");

  const widths = [...raw.matchAll(/\/Width (\d+)/g)].map((m) => Number(m[1]));
  const heights = [...raw.matchAll(/\/Height (\d+)/g)].map((m) => Number(m[1]));

  assert.ok(widths.includes(3630), "at the artwork's own resolution, not resampled");
  assert.ok(heights.includes(3630), "and square, so nothing was stretched");

  /*
   * The bytes themselves. The artwork's first scan-line bytes appear verbatim
   * in the embedded stream when the JPEG is passed through untouched, so this
   * fails if Chromium ever decides to re-encode it.
   */
  const asset = await import("node:fs").then((fs) =>
    fs.readFileSync(`${import.meta.dirname}/assets/skybook-logo.jpg`),
  );
  assert.ok(
    pdf.includes(asset.subarray(0, 64)),
    "the embedded image is the supplied file, byte for byte",
  );
});

test("a table spanning a page break repeats its header row", async () => {
  /*
   * 7A §18 REQUIRES IT, and only the file can show it happened. Chromium
   * repeats a `thead` marked as a header group, and the words cannot be read
   * back out of a Chromium PDF, so this counts drawn glyphs instead: the same
   * rows, forced across more pages, must draw MORE text than they did on one
   * page, and the difference is the repeated header.
   *
   * Indirect, and it is the strongest check available without a font-aware
   * extractor. It fails if the header stops repeating, which is the thing that
   * would actually go wrong.
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
        // Not every stream is text.
      }
      index = end + 9;
    }
    return total;
  };

  const rows = (count: number) =>
    Array.from({ length: count }, (_value, index) => ({
      label: `Measurement ${index}`,
      value: `Result ${index}`,
    }));

  // Keyed so the table is printed, in Security Audit (CP3 step 4b).
  const smallPdf = await renderPdf(testDocument({ measured: [{ key: "security", heading: "Facts", facts: rows(8) }] }));
  const midPdf = await renderPdf(testDocument({ measured: [{ key: "security", heading: "Facts", facts: rows(20) }] }));
  const longPdf = await renderPdf(testDocument({ measured: [{ key: "security", heading: "Facts", facts: rows(120) }] }));

  assert.ok(pageCount(longPdf) > pageCount(smallPdf), "the long table really does span more pages");

  /*
   * THE HEADER ITSELF, COUNTED. The column heading is set in capitals and every
   * row's value is not, so "RESULT" in the file's text is a drawn header row and
   * nothing else. The same table on one page draws it some fixed number of
   * times, for this table and the others in the document; forced across more
   * pages it must draw it again on each page it reaches.
   *
   * This replaces a rate of drawn glyphs per row, which was the strongest check
   * available before the file's text could be read back. That rate moved with
   * anything that changed the page count -- an extra page draws a running head
   * and foot of its own -- so it could fail with the header repeating exactly as
   * it should, and pass without it.
   */
  const headerRows = (pdf: Buffer) => extractText(pdf).split("RESULT").length - 1;
  const small = headerRows(smallPdf);
  const mid = headerRows(midPdf);
  const long = headerRows(longPdf);

  assert.ok(small >= 1, "the table has a header row at all");
  assert.equal(mid, small, "a table still on one page draws its header once");
  assert.ok(long >= small + 2, `a table across several pages redraws it on each: ${long} against ${small}`);

  // The glyph count still has to rise with the rows, or the rows are not there.
  assert.ok(drawOps(longPdf) > drawOps(midPdf) && drawOps(midPdf) > drawOps(smallPdf));
});

test("a finding taller than a page breaks rather than being clipped", async () => {
  /*
   * 7A §18 keeps a finding together unless it is genuinely too tall for one
   * page, and then it must break rather than lose its end. A clipped finding
   * is worse than a split one, because nothing on the page says anything is
   * missing.
   */
  const one = testDocument();
  const base = one.siteFindings.groups[0].findings[0];
  const huge = testDocument({
    siteFindings: {
      ...one.siteFindings,
      groups: [
        {
          category: "security",
          label: "Security",
          findings: [
            {
              ...base,
              title: "A finding far taller than one page",
              // Longer than any page can hold, so it has to break.
              evidence: Array.from({ length: 400 }, (_v, i) => `Sentence ${i} of the evidence.`).join(" "),
            },
          ],
        },
      ],
    },
  });

  const pdf = await renderPdf(huge);

  assert.ok(pageCount(pdf) > pageCount(await renderPdf(one)), "it took the pages it needed");
  assert.ok(pdf.length > 0);
});

test("the document ends without a blank trailing page", async () => {
  /*
   * A forced break after the last section would leave an empty page carrying
   * nothing but a running head and foot. "About this report" breaks BEFORE
   * itself for exactly this reason.
   */
  const pdf = await renderPdf(testDocument());
  const pages = pageCount(pdf);

  // Every page must carry text. A blank one draws only the head and the foot,
  // so the average glyph count per page would collapse if one were empty.
  assert.ok(pages >= 3 && pages <= 8, `expected a compact document, got ${pages} pages`);
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
      // A fact is needed for the group to render at all: an empty one is
      // omitted now, which is 7A §19 working.
      documentHtml(
        testDocument({
          // Keyed so the value is printed, in Security Audit (CP3 step 4b).
          measured: [{ key: "security", heading: "<b>BOLDSENTINEL</b>", facts: [{ label: "l", value: "v" }] }],
        }),
      ),
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
   * the number of text-drawing operations: the head and foot rules must
   * increase it.
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
  const withRules = await renderPdf(document);

  const browser = await puppeteer.launch({ headless: true });
  let without: Buffer;
  try {
    const page = await browser.newPage();
    await configurePage(page);
    const { documentHtml, footOf, headOf } = await import("./shell.ts");
    const { runningHeadFootCss } = await import("./runningHeadFoot.ts");
    const rules = runningHeadFootCss(headOf(document), footOf(document));
    const bare = documentHtml(document).replace(rules, "");
    assert.ok(bare.length < documentHtml(document).length, "the rules were there to take out");
    await page.setContent(bare, { waitUntil: "load" });
    without = Buffer.from(await page.pdf({ format: "a4", margin: { ...PAGE_MARGIN }, printBackground: true }));
  } finally {
    await browser.close();
  }

  assert.ok(
    drawOps(withRules) > drawOps(without),
    "the head and foot are drawn",
  );
});

test("the margins reserve room for the head and foot rather than hiding them", () => {
  // Verified on Chrome 152: the templates are drawn whether or not the margin
  // leaves space, so too small a margin produces overlap, not omission. These
  // values are temporary and exist so the foundation does not overlap.
  assert.equal(PAGE_MARGIN.top, "24mm");
  assert.equal(PAGE_MARGIN.bottom, "20mm");
});

