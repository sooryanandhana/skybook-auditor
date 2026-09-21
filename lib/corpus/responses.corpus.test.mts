/**
 * Corpus A and C — what the page fetcher and the audit make of ordinary HTTP
 * answers and of redirects.
 *
 * The real `fetchPage`, `safeFetch` address check and `runSiteAudit` run; only
 * the socket is scripted. The yardstick for these verdicts is the fetcher's own
 * documented invariant ("The server answered, so the site IS online — whatever
 * the status code"), the project rule that a page we could not read is never a
 * finding about the site, and the per-hop address check.
 */
import assert from "node:assert/strict";

import { EntryPageUnavailableError, runSiteAudit } from "../audit/siteAudit.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import { createDeadline } from "../collector/deadline.ts";
import { fetchPage, NOT_A_WEB_PAGE, UNDECLARED_CONTENT_TYPE } from "../collector/fetchPage.ts";
import {
  auditFixtureSite,
  correct,
  decision,
  findingsOf,
  HTML,
  noSiteFiles,
  OTHER_PUBLIC_HOST,
  page,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  quietSiteChecks,
  installOfflineCorpus,
  withServer,
  type Script,
} from "./corpus.fixture.mts";

const offline = installOfflineCorpus();
const ROOT = `https://${PUBLIC_HOST}/`;

/** One fetch through the real fetcher against a scripted server. */
function fetchWith(start: string, script: Script) {
  return withServer(script, async (server) => ({ result: await fetchPage(start, createDeadline(20_000)), server }));
}

/** A whole audit through the real fetcher (not the fixture fetcher), so redirects and failures are real. */
async function auditWith(requestedUrl: string, script: Script) {
  return withServer(script, async (server) => {
    try {
      const result = await runSiteAudit({
        requestedUrl,
        crawl: { useSitemaps: false, sitemapFetchImpl: noSiteFiles, sleepImpl: async () => {} },
        siteChecksImpl: async (_entry, servedOverHttps) => quietSiteChecks(servedOverHttps),
      });
      /*
       * These cases are about answers a page fetch received. An audit that
       * could not read a page at all is B10's subject, not theirs, so it is
       * refused here rather than quietly read as one of these.
       */
      if (isCertificateFailureAudit(result)) {
        throw new Error("responses corpus: the entry page was not read");
      }
      return { result, error: null, server };
    } catch (error) {
      return { result: null, error, server };
    }
  });
}

// ---------------------------------------------------------------------------
// A. Ordinary answers
// ---------------------------------------------------------------------------

correct("A1 an HTTPS page answering 200 with HTML is read, over HTTPS, with no redirect", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) => server.respond("page", { headers: HTML }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.servedOverHttps, true);
  assert.deepEqual(result.page.redirectChain, [ROOT]);
  assert.equal(result.page.uptime.statusCode, 200);
});

correct("A2 a 404 is not read, and the server is still recorded as online with its status", async () => {
  // A server that answers is up; the page is missing. Calling it offline would be false.
  const { result } = await fetchWith(ROOT, (_url, server) => server.respond("404", { status: 404, headers: HTML }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "The website responded with an error (404).");
  assert.equal(result.uptime?.isOnline, true);
  assert.equal(result.uptime?.statusCode, 404);
});

correct("A3 a 500 is described as the server's problem, and the server is still recorded as online", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) => server.respond("500", { status: 500, headers: HTML }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "The website's server reported a problem (500).");
  assert.equal(result.uptime?.isOnline, true);
});

correct("A4 a PDF and a plain-text answer are 'not a web page', not a fault", async () => {
  for (const type of ["application/pdf", "text/plain"]) {
    const { result } = await fetchWith(ROOT, (_url, server) => server.respond(type, { headers: { "content-type": type } }));
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason, NOT_A_WEB_PAGE);
  }
});

correct("A5 an answer with no Content-Type says we could not tell what it is, not that it is not a page", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) => server.respond("untyped"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, UNDECLARED_CONTENT_TYPE);
});

correct("A6 an XHTML page (application/xhtml+xml) is read as a web page", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) =>
    server.respond("xhtml", { headers: { "content-type": "application/xhtml+xml" } }),
  );
  assert.equal(result.ok, true);
});

correct("A7 an entry page answering 404 fails the audit with the fetcher's sentence and produces no findings", async () => {
  const { result, error } = await auditWith(ROOT, (_url, server) => server.respond("404", { status: 404, headers: HTML }));
  assert.equal(result, null);
  assert.ok(error instanceof EntryPageUnavailableError);
  assert.equal(error.reason, "The website responded with an error (404).");
});

correct("A8 an inner page answering 500 is listed as unreadable with its reason, and is not a finding", async () => {
  const result = await auditFixtureSite({
    [ROOT]: { html: page({ body: '<a href="/broken">b</a><a href="/doc.pdf">d</a>' }), headers: PROTECTED_HEADERS },
    [`${ROOT}broken`]: { html: "", unreadable: "The website's server reported a problem (500)." },
  });
  assert.equal(result.crawl.evaluated, 1);
  assert.deepEqual(
    result.crawl.unavailable.map((entry) => entry.reason).sort(),
    ["Not found.", "The website's server reported a problem (500)."],
  );
  assert.deepEqual(findingsOf(result).ids, []);
});

decision("A9 an internal link that leads to an error page produces no 'broken link' finding", async () => {
  // Not measured by any rule today. Whether it should be, and at what severity,
  // is a new grading requirement and needs approval first.
  const result = await auditFixtureSite({
    [ROOT]: { html: page({ body: '<a href="/does-not-exist">dead</a>' }), headers: PROTECTED_HEADERS },
  });
  assert.equal(result.crawl.unavailable.length, 1);
  assert.equal(result.site.findings.some((finding) => /link/i.test(finding.id)), false);
});

// ---------------------------------------------------------------------------
// C. Redirects
// ---------------------------------------------------------------------------

correct("C1 HTTPS → HTTPS on another public host is followed and the chain is recorded", async () => {
  const { result } = await fetchWith(ROOT, (url, server) =>
    url.hostname === PUBLIC_HOST
      ? server.respond("hop", { status: 301, headers: { location: `https://${OTHER_PUBLIC_HOST}/new` } })
      : server.respond("page", { headers: HTML }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.page.redirectChain, [ROOT, `https://${OTHER_PUBLIC_HOST}/new`]);
});

correct("C2 HTTP → HTTPS is followed and the page counts as served over HTTPS", async () => {
  const start = `http://${PUBLIC_HOST}/`;
  const { result } = await fetchWith(start, (url, server) =>
    url.protocol === "http:"
      ? server.respond("upgrade", { status: 301, headers: { location: ROOT } })
      : server.respond("page", { headers: HTML }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.servedOverHttps, true);
  assert.deepEqual(result.page.redirectChain, [start, ROOT]);
});

correct("C3 HTTPS → HTTP is followed, graded on the scheme finally served, and reported as not HTTPS", async () => {
  const { result } = await auditWith(ROOT, (url, server) =>
    url.protocol === "https:"
      ? server.respond("downgrade", { status: 301, headers: { location: `http://${PUBLIC_HOST}/` } })
      : server.respond("page", { headers: { ...HTML, ...PROTECTED_HEADERS }, body: page() }),
  );
  assert.ok(result);
  assert.equal(result.data.fetch.servedOverHttps, false);
  assert.deepEqual(result.data.fetch.redirectChain, [ROOT, `http://${PUBLIC_HOST}/`]);
  assert.equal(findingsOf(result).get("security.https")?.severity, "critical");
});

decision("C4 HTTPS → HTTP → HTTPS ends on HTTPS and nothing flags the plain-HTTP hop in between", async () => {
  // Tracked as i13. The chain is measured; no rule reads it. A downgrade finding
  // and its severity need approval.
  const { result } = await fetchWith(`${ROOT}a`, (url, server) => {
    if (url.pathname === "/a") return server.respond("a", { status: 301, headers: { location: `http://${PUBLIC_HOST}/b` } });
    if (url.pathname === "/b") return server.respond("b", { status: 301, headers: { location: `${ROOT}c` } });
    return server.respond("page", { headers: HTML });
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.servedOverHttps, true);
  assert.deepEqual(result.page.redirectChain, [`${ROOT}a`, `http://${PUBLIC_HOST}/b`, `${ROOT}c`]);
});

correct("C5 a redirect loop is abandoned after six requests with a plain sentence", async () => {
  const { result, server } = await fetchWith(`${ROOT}loop`, (_url, s) =>
    s.respond("loop", { status: 302, headers: { location: "/loop" } }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "That website redirected too many times.");
  assert.equal(server.requests.length, 6);
});

correct("C6 a redirect loop that answered every hop is recorded as online, keeping the chain it walked", async () => {
  // The fetcher's own rule: any HTTP answer means the server is online. Six 302s
  // arrived before the limit was reached, so uptime must say online -- not null,
  // which reads as "nothing responded" -- and the walked chain is kept so a
  // report can show where it looped.
  const { result } = await fetchWith(`${ROOT}loop`, (_url, s) => s.respond("loop", { status: 302, headers: { location: "/loop" } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.uptime?.isOnline, true);
  assert.equal(result.uptime?.statusCode, 302);
  assert.equal(result.redirectChain?.[0], `${ROOT}loop`);
  assert.equal(result.redirectChain?.length, 7); // the requested address plus six hops
});

decision("C7 six distinct redirect hops are refused as 'too many', though browsers follow about twenty", async () => {
  // The limit is 5 hops. A browser would load this page. Raising or keeping the
  // limit is a decision; a loop and a long chain currently share one sentence.
  const { result } = await fetchWith(`${ROOT}r0`, (url, server) => {
    const hop = Number(url.pathname.slice(2));
    return hop < 6
      ? server.respond(`hop${hop}`, { status: 301, headers: { location: `/r${hop + 1}` } })
      : server.respond("page", { headers: HTML });
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "That website redirected too many times.");
});

correct("C8 five redirect hops are followed to the page", async () => {
  const { result } = await fetchWith(`${ROOT}r1`, (url, server) => {
    const hop = Number(url.pathname.slice(2));
    return hop < 6
      ? server.respond(`hop${hop}`, { status: 301, headers: { location: `/r${hop + 1}` } })
      : server.respond("page", { headers: HTML });
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.redirectChain.length, 6);
});

correct("C9 redirects to a private address, to localhost and to the cloud metadata address are refused before any request reaches them", async () => {
  offline.hosts.set("localhost", ["127.0.0.1", "::1"]);
  for (const target of ["http://10.0.0.5/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data/"]) {
    const { result, server } = await fetchWith(ROOT, (_url, s) => s.respond("hop", { status: 302, headers: { location: target } }));
    assert.equal(result.ok, false, target);
    if (result.ok) continue;
    assert.equal(result.reason, "That address points to a private or internal network, so it can't be audited.", target);
    assert.deepEqual(server.requests, [ROOT], target);
  }
  offline.hosts.delete("localhost");
});

correct("C10 a redirect to a non-web scheme is refused", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) =>
    server.respond("hop", { status: 302, headers: { location: "file:///etc/passwd" } }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "The website redirected somewhere that isn't a web page.");
});

correct("C11 a redirect with no Location is reported as incomplete, with the server still online", async () => {
  const { result } = await fetchWith(ROOT, (_url, server) => server.respond("hop", { status: 302 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "The website sent an incomplete redirect.");
  assert.equal(result.uptime?.statusCode, 302);
});

correct("C12 a fetch that fails after following a redirect keeps the redirect chain it followed", async () => {
  // The failure came after a real response was received and processed, so the
  // chain that was walked is kept -- a report can say where the redirects led
  // before the 404.
  const { result, server } = await fetchWith(`${ROOT}old`, (url, s) =>
    url.pathname === "/old" ? s.respond("hop", { status: 301, headers: { location: "/gone" } }) : s.respond("404", { status: 404, headers: HTML }),
  );
  assert.equal(server.requests.length, 2);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("redirectChain" in result, true);
  assert.deepEqual(result.redirectChain, [`${ROOT}old`, `${ROOT}gone`]);
});
