/**
 * Tests for the results page's report download.
 *
 * WHAT IS ACTUALLY BEING TESTED. The button is three lines of JSX and this
 * project has no browser to render it in. Everything the button DECIDES was
 * put in `pdfExport.ts` for exactly that reason -- when a report may be asked
 * for, what the request carries, whether a second click may start a second
 * one, which sentence a refusal produces -- so these drive the same functions
 * the component calls, with a fetch that answers from memory.
 *
 * The claims that cannot be driven, because they are about what the code has
 * no way to do, are asserted against the source at the bottom. That is the
 * strongest form available: a test that watched for a crawl would only prove
 * this one path did not start one today.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  CLIENT_FIELDS,
  DOWNLOAD_BUSY_LABEL,
  DOWNLOAD_FAILED,
  DOWNLOAD_LABEL,
  DOWNLOAD_UNREACHABLE,
  EXPORT_READY,
  REPORT_INTRO,
  downloadButton,
  downloadPdf,
  downloadedNote,
  exportableJobId,
  filenameFrom,
  runExport,
  type ExportState,
} from "./pdfExport.ts";

/** One request, remembered rather than sent. */
interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

/** A fetch that answers with whatever is handed to it, and keeps the asking. */
function recordingFetch(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return answer();
  }) as unknown as typeof fetch;

  return { sent, fetchImpl };
}

/** A PDF coming back, named the way the endpoint names one. */
function pdfResponse(filename = "skybook-audit-example-com.pdf"): Response {
  return new Response(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** A refusal, shaped the way the endpoint shapes one. */
function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Collects what would have been written to disk. */
function collector() {
  const saved: { filename: string; bytes: number }[] = [];

  return {
    saved,
    save: (data: Blob, filename: string) => {
      saved.push({ filename, bytes: data.size });
    },
  };
}

/* ---------------------------------------------------------------------------
   When the download is offered at all
   --------------------------------------------------------------------------- */

test("a finished audit offers the report", () => {
  assert.equal(exportableJobId("job-1", true), "job-1");
});

test("an audit that is still running offers nothing to download", () => {
  /*
   * The id exists from the moment the audit is accepted, which is minutes
   * before there is anything to typeset. Offering it then would produce a
   * button whose only possible answer is the endpoint's "not ready yet".
   */
  assert.equal(exportableJobId("job-1", false), null);
});

test("an audit that failed offers nothing to download", () => {
  // A failed audit leaves its id behind and puts no result on screen.
  assert.equal(exportableJobId("job-1", false), null);
});

test("no audit at all offers nothing to download", () => {
  assert.equal(exportableJobId(null, false), null);
  assert.equal(exportableJobId(null, true), null);
  assert.equal(exportableJobId("   ", true), null);
});

/* ---------------------------------------------------------------------------
   What the request carries
   --------------------------------------------------------------------------- */

test("the request names the audit that is on screen", async () => {
  const { sent, fetchImpl } = recordingFetch(() => pdfResponse());

  await downloadPdf("job-abc", {}, { fetchImpl, save: collector().save });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/audit/pdf?jobId=job-abc");
  assert.equal(sent[0].method, "POST");
});

test("a job id with awkward characters in it survives the trip", async () => {
  const { sent, fetchImpl } = recordingFetch(() => pdfResponse());

  await downloadPdf("job a&b", {}, { fetchImpl, save: collector().save });

  assert.equal(sent[0].url, "/api/audit/pdf?jobId=job%20a%26b");
});

test("the optional client fields are sent when they carry something", async () => {
  const { sent, fetchImpl } = recordingFetch(() => pdfResponse());

  await downloadPdf(
    "job-1",
    { companyName: "Harbour Dental", contactName: "Ana Reyes", preparedBy: "Sam" },
    { fetchImpl, save: collector().save },
  );

  assert.deepEqual(sent[0].body, {
    companyName: "Harbour Dental",
    contactName: "Ana Reyes",
    preparedBy: "Sam",
  });
});

test("a box left empty is not sent as an empty field", async () => {
  /*
   * The endpoint reads a missing field and an empty one differently: missing
   * leaves the cover's generic wording alone, and empty would put a labelled
   * blank on a document going to a client.
   */
  const { sent, fetchImpl } = recordingFetch(() => pdfResponse());

  await downloadPdf(
    "job-1",
    { companyName: "  Harbour Dental  ", contactName: "", preparedBy: "   " },
    { fetchImpl, save: collector().save },
  );

  assert.deepEqual(sent[0].body, { companyName: "Harbour Dental" });
});

test("a report asked for with no client details sends an empty object, not nothing", async () => {
  // The endpoint reads a body; sending none would be a shape it has to guess at.
  const { sent, fetchImpl } = recordingFetch(() => pdfResponse());

  await downloadPdf("job-1", {}, { fetchImpl, save: collector().save });

  assert.deepEqual(sent[0].body, {});
});

test("the form collects exactly the fields the request can carry", () => {
  // One list behind both, so a fourth box cannot be typed into and dropped.
  assert.deepEqual(
    CLIENT_FIELDS.map((field) => field.key),
    ["companyName", "contactName", "preparedBy"],
  );
  for (const field of CLIENT_FIELDS) assert.ok(field.label.trim() !== "");
});

/* ---------------------------------------------------------------------------
   What comes back
   --------------------------------------------------------------------------- */

test("a successful answer hands the file to the browser", async () => {
  const saver = collector();
  const { fetchImpl } = recordingFetch(() => pdfResponse());

  const outcome = await downloadPdf("job-1", {}, { fetchImpl, save: saver.save });

  assert.equal(outcome.ok, true);
  assert.deepEqual(saver.saved, [{ filename: "skybook-audit-example-com.pdf", bytes: 4 }]);
});

test("the file keeps the name the server chose", async () => {
  const saver = collector();
  const { fetchImpl } = recordingFetch(() => pdfResponse("skybook-audit-harbour-dental-co-uk.pdf"));

  await downloadPdf("job-1", {}, { fetchImpl, save: saver.save });

  assert.equal(saver.saved[0].filename, "skybook-audit-harbour-dental-co-uk.pdf");
});

test("a missing name header still saves under something sensible", () => {
  assert.equal(filenameFrom(null), "skybook-audit.pdf");
  assert.equal(filenameFrom(""), "skybook-audit.pdf");
  assert.equal(filenameFrom("attachment"), "skybook-audit.pdf");
  assert.equal(filenameFrom("attachment; filename=plain.pdf"), "plain.pdf");
  assert.equal(filenameFrom(`attachment; filename="quoted name.pdf"`), "quoted name.pdf");
});

test("a refusal is shown in the server's own words", async () => {
  const saver = collector();
  const { fetchImpl } = recordingFetch(() =>
    refusal(404, "That audit could not be found. It may have expired — run it again."),
  );

  const outcome = await downloadPdf("gone", {}, { fetchImpl, save: saver.save });

  assert.equal(outcome.ok, false);
  assert.equal(
    outcome.ok === false ? outcome.message : "",
    "That audit could not be found. It may have expired — run it again.",
  );
  assert.deepEqual(saver.saved, [], "nothing is saved when nothing was produced");
});

test("an audit still running is refused in the server's words, not reworded here", async () => {
  const { fetchImpl } = recordingFetch(() => refusal(409, "This audit has not finished yet."));

  const outcome = await downloadPdf("job-1", {}, { fetchImpl, save: collector().save });

  assert.equal(outcome.ok === false && outcome.message, "This audit has not finished yet.");
});

test("an answer that is not the endpoint's gets the fixed sentence", async () => {
  /*
   * A proxy's HTML error page, say. Whatever is in it was not written for a
   * client to read, so none of it is shown.
   */
  const { fetchImpl } = recordingFetch(
    () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
  );

  const outcome = await downloadPdf("job-1", {}, { fetchImpl, save: collector().save });

  assert.equal(outcome.ok === false && outcome.message, DOWNLOAD_FAILED);
});

test("a refusal with no sentence in it gets the fixed one too", async () => {
  const { fetchImpl } = recordingFetch(
    () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
  );

  const outcome = await downloadPdf("job-1", {}, { fetchImpl, save: collector().save });

  assert.equal(outcome.ok === false && outcome.message, DOWNLOAD_FAILED);
});

test("a server that cannot be reached says so, and says the audit is unaffected", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("failed to fetch"))) as unknown as typeof fetch;

  const outcome = await downloadPdf("job-1", {}, { fetchImpl, save: collector().save });

  assert.equal(outcome.ok === false && outcome.message, DOWNLOAD_UNREACHABLE);
  assert.match(DOWNLOAD_UNREACHABLE, /audit above is unaffected/);
});

test("no error sentence carries anything internal", () => {
  /*
   * These two are the only wording this file invents; every other sentence a
   * person sees came from the endpoint, which guarantees the same thing about
   * its own.
   */
  for (const sentence of [DOWNLOAD_UNREACHABLE, DOWNLOAD_FAILED]) {
    assert.ok(!/\b(job|jobId|stack|Error:|puppeteer|chromium|api[_ ]?key)\b/i.test(sentence));
  }
});

/* ---------------------------------------------------------------------------
   One press, and what the button says while it works
   --------------------------------------------------------------------------- */

test("the button says what it is doing and cannot be pressed while it does it", () => {
  assert.deepEqual(downloadButton(EXPORT_READY), { label: DOWNLOAD_LABEL, disabled: false });
  assert.deepEqual(downloadButton({ kind: "working" }), {
    label: DOWNLOAD_BUSY_LABEL,
    disabled: true,
  });
  assert.deepEqual(downloadButton({ kind: "done", filename: "a.pdf" }), {
    label: DOWNLOAD_LABEL,
    disabled: false,
  });
  assert.deepEqual(downloadButton({ kind: "failed", message: "no" }), {
    label: DOWNLOAD_LABEL,
    disabled: false,
  });
});

test("a second press while one is in flight does nothing", async () => {
  /*
   * The disabled button is what a person sees; this is the guarantee behind
   * it, because a disabled button is a rendering and a render can lag a click.
   * Two requests would be two renders of the same document on the server and
   * two copies of the same file in the client's downloads folder.
   */
  const saver = collector();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sent, fetchImpl } = recordingFetch(async () => {
    await held;
    return pdfResponse();
  });

  let state: ExportState = EXPORT_READY;
  const onState = (next: ExportState) => {
    state = next;
  };

  const first = runExport(state, "job-1", {}, onState, { fetchImpl, save: saver.save });
  const second = runExport(state, "job-1", {}, onState, { fetchImpl, save: saver.save });

  assert.equal(state.kind, "working", "the button is busy before the answer arrives");

  release();
  await Promise.all([first, second]);

  assert.equal(sent.length, 1, "one request, not two");
  assert.equal(saver.saved.length, 1, "one file, not two");
});

test("a press reports the file it produced", async () => {
  const { fetchImpl } = recordingFetch(() => pdfResponse("skybook-audit-example-com.pdf"));

  let state: ExportState = EXPORT_READY;
  await runExport(state, "job-1", {}, (next) => (state = next), {
    fetchImpl,
    save: collector().save,
  });

  assert.equal(state.kind, "done");
  assert.equal(state.kind === "done" ? state.filename : "", "skybook-audit-example-com.pdf");
  assert.match(downloadedNote("skybook-audit-example-com.pdf"), /skybook-audit-example-com\.pdf/);
});

test("a press that was refused reports the refusal, and can be pressed again", async () => {
  const answers = [refusal(409, "This audit has not finished yet."), pdfResponse()];
  const { sent, fetchImpl } = recordingFetch(() => answers.shift()!);

  let state: ExportState = EXPORT_READY;
  const onState = (next: ExportState) => {
    state = next;
  };

  await runExport(state, "job-1", {}, onState, { fetchImpl, save: collector().save });

  // Snapshots rather than repeated reads: asserting on the same variable three
  // times narrows it to nothing, since the reassignment happens in a callback.
  const refused = state;
  assert.equal(refused.kind, "failed");
  assert.equal(downloadButton(refused).disabled, false, "a failure does not lock the button");

  // The second press clears the first one's message rather than stacking on it.
  const again = runExport(refused, "job-1", {}, onState, { fetchImpl, save: collector().save });
  const working = state;
  await again;
  const finished = state;

  assert.equal(working.kind, "working");
  assert.equal(finished.kind, "done");
  assert.equal(sent.length, 2);
});

/* ---------------------------------------------------------------------------
   What this cannot do, asserted against the source
   --------------------------------------------------------------------------- */

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

test("downloading a report starts no audit, crawl or speed check", () => {
  const source = read("./pdfExport.ts") + read("../../app/ReportDownload.tsx");

  for (const forbidden of [
    "/api/audit\"",
    "/api/audit/status",
    "/api/audit/result",
    "/api/audit/explain",
    "/api/audit/performance",
    "startAudit",
    "crawlSite",
    "runPerformanceChecks",
    "pollUntilDone",
  ]) {
    assert.ok(!source.includes(forbidden), `the download must not reach ${forbidden}`);
  }
});

test("downloading a report asks no model anything", () => {
  const source = read("./pdfExport.ts") + read("../../app/ReportDownload.tsx");

  for (const forbidden of ["gemini", "genai", "GEMINI", "explainAudit"]) {
    assert.ok(!source.includes(forbidden), `the download must not reach ${forbidden}`);
  }
});

test("one endpoint is named in the whole download path, and it is the export one", () => {
  const source = read("./pdfExport.ts") + read("../../app/ReportDownload.tsx");
  const endpoints = source.match(/\/api\/[a-z/]+/g) ?? [];

  assert.deepEqual([...new Set(endpoints)], ["/api/audit/pdf"]);
});

test("downloading a report stores nothing", () => {
  // 7A §4: Phase 7 is database-free, and there is no saved copy of a report.
  const source = read("./pdfExport.ts") + read("../../app/ReportDownload.tsx");

  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "writeFile"]) {
    assert.ok(!source.includes(forbidden), `the download must not use ${forbidden}`);
  }
});

test("the export module drags no renderer into the browser", () => {
  /*
   * THE REASON THIS FILE IMPORTS NOTHING. It ends up in the browser bundle,
   * and the renderer imports Puppeteer and reads a megabyte of fonts at module
   * load. A single import from `lib/audit/pdf` here would try to put a
   * headless browser in a web page.
   */
  const source = read("./pdfExport.ts");

  assert.ok(!/^\s*import\s/m.test(source), "the export module imports nothing at all");
  for (const forbidden of ["puppeteer", "node:fs", "node:path", "lib/audit", "pdfDocument"]) {
    assert.ok(!source.includes(forbidden), `the export module must not reach ${forbidden}`);
  }
});

test("the download panel decides nothing for itself", () => {
  /*
   * It may reach React, its stylesheet, this module and the panel it renders
   * underneath itself, and nothing else. The point of the split is that
   * everything a test needs to check is on this side of it, and a sibling
   * component brings its own tests rather than moving a decision in here.
   */
  const imports = [...read("../../app/ReportDownload.tsx").matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1],
  );

  assert.deepEqual([...new Set(imports)].sort(), [
    "./ReportSend",
    "./page.module.css",
    "@/lib/report/pdfExport",
    "react",
  ]);
});

test("the page shows the download only when there is a report to download", () => {
  const source = read("../../app/AuditPage.tsx");

  assert.ok(
    source.includes("exportableJobId(jobId, result !== null)"),
    "the page decides it from both facts",
  );
  assert.ok(
    source.includes("{reportJobId !== null && ("),
    "and renders nothing when the answer is null",
  );
  assert.ok(
    source.includes("<ReportDownload jobId={reportJobId}"),
    "handing the panel the audit it is allowed to export",
  );
});

test("a new audit does not leave the previous one's report on offer", () => {
  const source = read("../../app/AuditPage.tsx");
  const submit = source.slice(source.indexOf("async function handleSubmit"));

  assert.ok(
    submit.slice(0, submit.indexOf("try {")).includes("setJobId(null)"),
    "starting an audit forgets the finished one",
  );
});

test("the panel promises that nothing is checked again", () => {
  // A salesperson about to hand over a laptop must not wonder whether pressing
  // this re-crawls the client's site.
  assert.match(REPORT_INTRO, /nothing is checked again/);
});
