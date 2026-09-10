/**
 * Tests for the export endpoint's decisions.
 *
 * WHAT THIS ENDPOINT MUST NEVER DO is most of what these check. It reads a
 * finished audit. It starts nothing, crawls nothing, measures no speed, asks
 * no model anything and stores nothing. Every one of those would be a
 * different endpoint wearing this one's name, and each is asserted rather than
 * assumed.
 *
 * THE RENDERER IS INJECTED IN ALL BUT ONE TEST. Launching a browser to find
 * out which sentence a 404 carries would be twenty seconds spent on a question
 * the browser has no part in. One test renders for real, so the path from a
 * finished job to actual PDF bytes is covered end to end.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { pdfExportRoute, exportFilename, NO_RESULT } from "./pdfExportRoute.ts";
import { JOB_NOT_FOUND, NO_JOB_ID, NOT_READY } from "../jobs/jobResponses.ts";
import { PDF_RENDER_MESSAGES, PdfRenderError } from "../audit/pdf/render.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import { runRealAudit } from "../audit/pdf/realAudit.fixture.mts";
import type { AuditJobStore } from "../jobs/auditJobs.ts";

const FAKE_PDF = Buffer.from("%PDF-1.4\nfake\n%%EOF\n", "latin1");

/**
 * ONE REAL AUDIT, BUILT ONCE AND SHARED.
 *
 * An earlier version of this file hand-built a minimal audit and the
 * projection threw on it, because a projection that reads twenty measurement
 * blocks needs twenty measurement blocks. Rather than grow a fixture until it
 * stopped throwing, this uses the 7C-6 harness: a genuine audit from the
 * production crawler and the production rules, with only the socket replaced.
 *
 * Built at module load so the crawl happens once rather than per test.
 */
const REAL_AUDIT = await runRealAudit({
  site: {
    "https://example.com/": {
      html:
        '<!doctype html><html lang="en"><head><title>Example Company</title></head><body>' +
        "<h1>Welcome</h1><p>We sell widgets to businesses across the country and have done so since 1994.</p>" +
        '<a href="/about">About</a></body></html>',
    },
    "https://example.com/about": {
      html:
        '<!doctype html><html lang="en"><head><title>About</title></head><body>' +
        "<h1>About us</h1><p>Founded in 1994, we make things well and deliver them on time.</p>" +
        "</body></html>",
    },
  },
  checks: { spfMissing: true },
});

/** A store holding one job in whichever state a test needs. */
function storeWith(state: "completed" | "partial" | "queued" | "running" | "failed") {
  const store = createJobStore() as unknown as AuditJobStore;
  const job = store.create("https://example.com/");

  if (state === "running") store.markRunning(job.id);
  if (state === "failed") store.fail(job.id, "The website could not be reached.");
  if (state === "completed" || state === "partial") {
    store.finish(job.id, state === "partial" ? "partial" : "completed", REAL_AUDIT);
  }
  return { store, jobId: job.id };
}

const request = (jobId: string | null, body?: unknown) =>
  new Request(`https://skybook.test/api/audit/pdf${jobId === null ? "" : `?jobId=${jobId}`}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

/** A renderer that records what it was handed and returns bytes. */
function recordingRenderer() {
  const seen: unknown[] = [];
  return {
    seen,
    render: async (document: unknown) => {
      seen.push(document);
      return FAKE_PDF;
    },
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a finished audit becomes a PDF", async () => {
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();

  const result = await pdfExportRoute(request(jobId), { store, render: renderer.render });

  assert.ok(result.ok, "the export succeeded");
  assert.ok(result.pdf.equals(FAKE_PDF));
  assert.equal(renderer.seen.length, 1, "the renderer was called exactly once");
});

test("a partial audit exports too, because it is still a finished audit", async () => {
  const { store, jobId } = storeWith("partial");
  const result = await pdfExportRoute(request(jobId), { store, render: recordingRenderer().render });

  assert.ok(result.ok);
});

test("the filename names the audited site and nothing a caller typed", async () => {
  const { store, jobId } = storeWith("completed");
  const result = await pdfExportRoute(request(jobId, { companyName: "../../etc/passwd" }), {
    store,
    render: recordingRenderer().render,
  });

  assert.ok(result.ok);
  assert.equal(result.filename, "skybook-audit-example.com.pdf");
  assert.ok(!result.filename.includes("passwd"), "the client's own text is not in it");
});

test("a filename is safe whatever the address was", () => {
  assert.equal(exportFilename("https://example.com/a/b"), "skybook-audit-example.com.pdf");
  assert.equal(exportFilename("not a url"), "skybook-audit-website.pdf");
  assert.equal(exportFilename(""), "skybook-audit-website.pdf");
  assert.ok(!exportFilename('https://a"b.com/').includes('"'), "no quote can end the header early");
  assert.ok(!/[\\/]/.test(exportFilename("https://a/b\\c.com/")), "and no path separator");
});

// ---------------------------------------------------------------------------
// The client's own details
// ---------------------------------------------------------------------------

test("the optional client fields reach the document", async () => {
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();

  await pdfExportRoute(
    request(jobId, { companyName: "Acme Widgets Ltd", contactName: "Dana Okafor", preparedBy: "Soorya" }),
    { store, render: renderer.render },
  );

  const cover = (renderer.seen[0] as { cover: { client: Record<string, string | null> } }).cover;
  assert.equal(cover.client.companyName, "Acme Widgets Ltd");
  assert.equal(cover.client.contactName, "Dana Okafor");
  assert.equal(cover.client.preparedBy, "Soorya");
});

test("no body at all is fine, because every field is optional", async () => {
  // 7A §15: the document must be correct with none of them. Refusing here
  // would fail an export for the sake of three fields it does not need.
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();

  const result = await pdfExportRoute(request(jobId), { store, render: renderer.render });

  assert.ok(result.ok);
  const cover = (renderer.seen[0] as { cover: { client: Record<string, string | null> } }).cover;
  assert.equal(cover.client.companyName, null);
});

test("a malformed body is treated as no details rather than as a refusal", async () => {
  const { store, jobId } = storeWith("completed");
  const broken = new Request(`https://skybook.test/api/audit/pdf?jobId=${jobId}`, {
    method: "POST",
    body: "{not json",
    headers: { "content-type": "application/json" },
  });

  const result = await pdfExportRoute(broken, { store, render: recordingRenderer().render });
  assert.ok(result.ok);
});

test("nothing else in the body reaches the projection", async () => {
  // Only the three defined fields are read, so a body cannot become a way to
  // reach the projection's other options.
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();

  await pdfExportRoute(request(jobId, { companyName: 42, somethingElse: "x", preparedBy: ["a"] }), {
    store,
    render: renderer.render,
  });

  const cover = (renderer.seen[0] as { cover: { client: Record<string, string | null> } }).cover;
  assert.equal(cover.client.companyName, null, "a number is not a name");
  assert.equal(cover.client.preparedBy, null, "and neither is an array");
});

// ---------------------------------------------------------------------------
// The refusals, from 7A §23
// ---------------------------------------------------------------------------

test("no job id is a bad request", async () => {
  const { store } = storeWith("completed");
  const result = await pdfExportRoute(request(null), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 400);
  assert.equal(result.error, NO_JOB_ID);
});

test("an unknown job is refused with the sentence the project already uses", async () => {
  const { store } = storeWith("completed");
  const result = await pdfExportRoute(request("nosuchjob"), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 404);
  assert.equal(result.error, JOB_NOT_FOUND);
});

test("an expired job is refused exactly as an unknown one is", async () => {
  /*
   * THEY CANNOT BE TOLD APART, because an expired job is deleted. Guessing
   * would mean telling someone their audit expired when they had mistyped an
   * id. The sentence already mentions the half-hour window.
   */
  const store = createJobStore({ ttlMs: 1, now: () => Date.now() }) as unknown as AuditJobStore;
  const job = store.create("https://example.com/");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const result = await pdfExportRoute(request(job.id), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 404);
  assert.equal(result.error, JOB_NOT_FOUND);
});

test("a running audit is refused, and says so rather than half-rendering", async () => {
  const { store, jobId } = storeWith("running");
  const result = await pdfExportRoute(request(jobId), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  assert.equal(result.error, NOT_READY);
});

test("a queued audit is refused for the same reason", async () => {
  const { store, jobId } = storeWith("queued");
  const result = await pdfExportRoute(request(jobId), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 409);
});

test("a failed audit is refused with the audit's own reason", async () => {
  // There is no report to render, and inventing one would be inventing
  // measurements. The reason is one a collector wrote for a person.
  const { store, jobId } = storeWith("failed");
  const result = await pdfExportRoute(request(jobId), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  assert.equal(result.error, "The website could not be reached.");
});

test("a finished job with no result is refused rather than rendered empty", async () => {
  /*
   * A STATE THE REAL STORE CANNOT REACH, which is the point of testing it. The
   * store writes the result in the same step that sets a successful status, so
   * this is unreachable today and is guarded anyway: a blind non-null there
   * would print an empty report as though it were an audit. Reaching it needs
   * a store that hands back exactly that, and nothing else here does.
   */
  const store = {
    get: () => ({ id: "job-1", status: "completed", result: null }),
  } as unknown as AuditJobStore;

  const result = await pdfExportRoute(request("job-1"), { store, render: recordingRenderer().render });

  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  assert.equal(result.error, NO_RESULT);
});

// ---------------------------------------------------------------------------
// When the renderer fails
// ---------------------------------------------------------------------------

test("a renderer failure gives a fixed sentence and nothing about the site", async () => {
  const { store, jobId } = storeWith("completed");
  const result = await pdfExportRoute(request(jobId), {
    store,
    render: async () => {
      throw new PdfRenderError("internal-error");
    },
  });

  assert.ok(!result.ok);
  assert.equal(result.status, 500);
  assert.equal(result.error, PDF_RENDER_MESSAGES["internal-error"]);
  assert.ok(!/site|website|domain/i.test(result.error));
});

test("a renderer timeout says it timed out, and says nothing else", async () => {
  const { store, jobId } = storeWith("completed");
  const result = await pdfExportRoute(request(jobId), {
    store,
    render: async () => {
      throw new PdfRenderError("timed-out");
    },
  });

  assert.ok(!result.ok);
  assert.equal(result.status, 500);
  assert.equal(result.error, PDF_RENDER_MESSAGES["timed-out"]);
});

test("an unexpected exception never reaches the caller", async () => {
  /*
   * 7A §23: no exception message, no stack trace, no file path. Anything that
   * is not the renderer's own error gets the generic sentence, because
   * anything else could be carrying a browser command line or an internal
   * address.
   */
  const { store, jobId } = storeWith("completed");
  const result = await pdfExportRoute(request(jobId), {
    store,
    render: async () => {
      throw new Error("C:\\Users\\pc\\secret\\path --user-data-dir=/tmp/x KEY=abc123");
    },
  });

  assert.ok(!result.ok);
  assert.equal(result.error, PDF_RENDER_MESSAGES["internal-error"]);
  assert.ok(!result.error.includes("secret"));
  assert.ok(!result.error.includes("abc123"));
  assert.ok(!result.error.includes("--user-data-dir"));
});

test("a failed render is not retried", async () => {
  // 7A §23: a second attempt at a deterministic render of the same data fails
  // the same way, and would double a slow render's cost for nothing.
  const { store, jobId } = storeWith("completed");
  let attempts = 0;

  await pdfExportRoute(request(jobId), {
    store,
    render: async () => {
      attempts += 1;
      throw new PdfRenderError("internal-error");
    },
  });

  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// What it must never do
// ---------------------------------------------------------------------------

test("exporting starts no audit, crawls nothing and measures no speed", async () => {
  /*
   * ASSERTED AGAINST THE SOURCE, because the strongest form of this is that
   * the code has no way to do it. A test that watched for a network call would
   * only prove this one path did not take it today.
   */
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./pdfExportRoute.ts", import.meta.url), "utf8");

  for (const forbidden of ["startAudit", "runSiteAudit", "crawlSite", "runPerformanceChecks", "explainJob", "fetch("]) {
    assert.ok(!source.includes(forbidden), `the export route must not reach ${forbidden}`);
  }
});

test("exporting asks no model anything", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./pdfExportRoute.ts", import.meta.url), "utf8");

  for (const forbidden of ["gemini", "genai", "explainAudit", "GEMINI"]) {
    assert.ok(!source.includes(forbidden), `the export route must not reach ${forbidden}`);
  }
});

test("exporting does not consume the audit rate limit", async () => {
  /*
   * 7A §21 settled this. That bucket bounds how many audits a caller can start
   * and how much paid speed quota they can spend; exporting reads a job that
   * already exists. Sharing it would let downloading reports block running
   * them.
   *
   * Proven by exporting far more times than the limit allows and seeing every
   * one succeed.
   */
  const { store, jobId } = storeWith("completed");
  const renderer = recordingRenderer();

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await pdfExportRoute(request(jobId), { store, render: renderer.render });
    assert.ok(result.ok, `export ${attempt + 1} succeeded`);
  }

  assert.equal(renderer.seen.length, 25);
});

test("the export route holds no rate limiter of its own either", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./pdfExportRoute.ts", import.meta.url), "utf8");

  assert.ok(!source.includes("checkRateLimit"), "no limiter is consulted");
});

test("exporting stores nothing", async () => {
  // 7A §4: Phase 7 is database-free and there is no saved copy of a report.
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("./pdfExportRoute.ts", import.meta.url), "utf8");

  for (const forbidden of ["writeFile", "createWriteStream", "setExplanation", "attach("]) {
    assert.ok(!source.includes(forbidden), `the export route must not ${forbidden}`);
  }
});

test("exporting leaves the stored job exactly as it found it", async () => {
  const { store, jobId } = storeWith("completed");
  const before = JSON.stringify(store.get(jobId));

  await pdfExportRoute(request(jobId), { store, render: recordingRenderer().render });

  assert.equal(JSON.stringify(store.get(jobId)), before);
});

// ---------------------------------------------------------------------------
// One real render, end to end
// ---------------------------------------------------------------------------

test("the real renderer produces real PDF bytes through this route", async () => {
  /*
   * The one test here that launches a browser. Everything above injects the
   * renderer, because a 404's wording has nothing to do with Chromium. This
   * covers the join: a finished job in a store, through the projection, to a
   * file that opens.
   */
  const { store, jobId } = storeWith("completed");
  const result = await pdfExportRoute(request(jobId, { companyName: "Acme Widgets Ltd" }), { store });

  assert.ok(result.ok, "a finished audit rendered");
  assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(result.pdf.includes(Buffer.from("%%EOF")));
  assert.ok(result.pdf.length > 100_000, "the fonts and the mark are embedded");
  assert.equal(result.filename, "skybook-audit-example.com.pdf");
});

// ---------------------------------------------------------------------------
// The adapter's own headers
// ---------------------------------------------------------------------------

test("the route file sends the headers a download needs", async () => {
  /*
   * The adapter is three lines of framework glue and cannot be imported by a
   * unit test without a bundler, which is why every other route is tested this
   * way too: the decisions live in the function above, and this checks the
   * glue says what it should.
   */
  const fs = await import("node:fs");
  const route = fs.readFileSync(
    new URL("../../app/api/audit/pdf/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /"Content-Type": "application\/pdf"/);
  assert.match(route, /attachment; filename=/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /runtime = "nodejs"/, "the renderer needs a browser and a filesystem");
  assert.ok(route.includes("export async function POST"), "and it is a POST");
  assert.ok(!route.includes("export async function GET"), "never a GET on the polling path");
});
