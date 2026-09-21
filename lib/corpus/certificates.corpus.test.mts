/**
 * Corpus B — certificates, from the TLS error code a connection reports to the
 * findings a report carries, and what happens to an audit whose entry page
 * cannot be read securely.
 *
 * Yardsticks:
 *   - the untrusted-certificate rule's own documented scope: "The platform's
 *     own chain validation failed — self-signed, or issued by an authority
 *     browsers do not trust";
 *   - sslChecks.ts's statement that its codes are "The same values the page
 *     fetch uses, so a certificate problem means the same thing wherever it is
 *     reported";
 *   - the project decision that the certificate check reads an invalid
 *     certificate on purpose, "that is what lets it say 'expired three weeks
 *     ago' instead of 'connection failed'";
 *   - OpenSSL's meaning for each code.
 *
 * Certificates are described by the collector's own `describeCertificate`, so
 * every fact a rule reads was produced by production code, not typed by hand.
 */
import assert from "node:assert/strict";

import { EntryPageUnavailableError, runSiteAudit } from "../audit/siteAudit.ts";
import { classifyConnectionError, fetchPage } from "../collector/fetchPage.ts";
import { classifyAuthorizationError } from "../collector/sslChecks.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import { normalizeUrl } from "../collector/url.ts";
import { SITE_RULES } from "../rules/all.ts";
import { runRules } from "../rules/runner.ts";
import type { SslData } from "../types.ts";
import {
  auditFixtureSite,
  checkedSsl,
  connectionError,
  correct,
  decision,
  HTML,
  noSiteFiles,
  page,
  peerCertificate,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  quietSiteChecks,
  installOfflineCorpus,
  validCertificate,
  withServer,
  type Script,
} from "./corpus.fixture.mts";

installOfflineCorpus();
const ROOT = `https://${PUBLIC_HOST}/`;

/** The certificate findings the real site rules produce for these TLS facts. */
async function certificateFindings(ssl: SslData): Promise<string[]> {
  const base = await auditFixtureSite({ [ROOT]: { html: page(), headers: PROTECTED_HEADERS } });
  return runRules({ ...base.data, ssl }, SITE_RULES)
    .findings.map((finding) => finding.id)
    .filter((id) => id.startsWith("security.ssl."))
    .sort();
}

const EXPIRED = peerCertificate({ validFrom: "Jan  1 00:00:00 2025 GMT", validTo: "Sep  1 00:00:00 2026 GMT", names: ["example.com"] });
const NOT_YET_VALID = peerCertificate({ validFrom: "Oct  1 00:00:00 2026 GMT", validTo: "Dec 31 23:59:59 2027 GMT", names: ["example.com"] });

/** A whole audit through the real fetcher, recording whether the site-level checks ever ran. */
async function auditEntry(
  requestedUrl: string,
  script: Script,
  options: { schemeWasAssumed?: boolean } = {},
) {
  let siteChecksRan = 0;
  return withServer(script, async (server) => {
    try {
      const result = await runSiteAudit({
        requestedUrl,
        schemeWasAssumed: options.schemeWasAssumed,
        crawl: { useSitemaps: false, sitemapFetchImpl: noSiteFiles, sleepImpl: async () => {} },
        siteChecksImpl: async (_entry, servedOverHttps) => {
          siteChecksRan += 1;
          return quietSiteChecks(servedOverHttps);
        },
      });
      return { result, error: null as unknown, siteChecksRan, server };
    } catch (error) {
      return { result: null, error, siteChecksRan, server };
    }
  });
}

// ---------------------------------------------------------------------------
// Findings for certificates that were read
// ---------------------------------------------------------------------------

correct("B1 a valid, trusted certificate covering the host produces no certificate findings", async () => {
  assert.deepEqual(await certificateFindings(checkedSsl("example.com", validCertificate(), { trusted: true, problem: null })), []);
});

correct("B2 a self-signed leaf certificate produces exactly one finding: not trusted", async () => {
  const ssl = checkedSsl("example.com", validCertificate(), {
    trusted: false,
    problem: classifyAuthorizationError("DEPTH_ZERO_SELF_SIGNED_CERT"),
  });
  assert.equal(ssl.problem, "self-signed");
  assert.deepEqual(await certificateFindings(ssl), ["security.ssl.untrusted"]);
});

correct("B3 an expired certificate is reported as exactly one Critical finding: expired", async () => {
  // One cause, one fix — renewal — and one finding. The untrusted rule is for
  // chain-trust failures; it stays silent when the platform's reason is expiry
  // and the certificate's own facts show that expiry. (Was a defect: the
  // untrusted rule fired on any `trusted: false`, counting two Criticals.)
  const ssl = checkedSsl("example.com", EXPIRED, { trusted: false, problem: classifyAuthorizationError("CERT_HAS_EXPIRED") });
  assert.deepEqual(await certificateFindings(ssl), ["security.ssl.expired"]);
});

correct("B4 a certificate for the wrong hostname is reported as exactly one Critical finding: hostname", async () => {
  // The same rule as B3: the platform's reason is the mismatch the hostname
  // rule already reports. (Was a defect: two Criticals for one cause.)
  const ssl = checkedSsl("example.com", validCertificate(["other.example"]), {
    trusted: false,
    problem: classifyAuthorizationError("ERR_TLS_CERT_ALTNAME_INVALID"),
  });
  assert.deepEqual(await certificateFindings(ssl), ["security.ssl.hostname"]);
});

decision("B5 a not-yet-valid certificate is reported only as 'not trusted', with the generic label 'untrusted'", async () => {
  // Not false — the certificate is not trusted — but the cause is not named.
  // Whether "not yet valid" gets its own label and wording is a decision.
  const ssl = checkedSsl("example.com", NOT_YET_VALID, { trusted: false, problem: classifyAuthorizationError("CERT_NOT_YET_VALID") });
  assert.equal(ssl.problem, "untrusted");
  assert.deepEqual(await certificateFindings(ssl), ["security.ssl.untrusted"]);
});

// ---------------------------------------------------------------------------
// The two paths that classify a certificate error code
// ---------------------------------------------------------------------------

correct("B6 codes both classifiers agree on: expired, self-signed leaf, wrong hostname, unverifiable leaf", () => {
  const agreed = {
    CERT_HAS_EXPIRED: "expired",
    DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed",
    ERR_TLS_CERT_ALTNAME_INVALID: "wrong-hostname",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "untrusted",
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "untrusted",
  } as const;
  for (const [code, problem] of Object.entries(agreed)) {
    assert.equal(classifyAuthorizationError(code), problem, code);
    assert.equal(classifyConnectionError(connectionError(code)).certificateProblem, problem, code);
  }
  assert.equal(classifyConnectionError(connectionError("CERT_HAS_EXPIRED")).reason, "The website's security certificate has expired.");
});

correct("B7 an untrusted root (SELF_SIGNED_CERT_IN_CHAIN) is not called 'self-signed' by either classifier", () => {
  // OpenSSL's meaning: the chain ends in a root that is not trusted. The site's
  // own certificate was issued under that authority; it is not self-signed. (Was
  // a defect: both classifiers said "self-signed", the wrong thing to fix.)
  assert.notEqual(classifyAuthorizationError("SELF_SIGNED_CERT_IN_CHAIN"), "self-signed");
  assert.notEqual(classifyConnectionError(connectionError("SELF_SIGNED_CERT_IN_CHAIN")).certificateProblem, "self-signed");
});

correct("B8 the page fetch names the certificate failures the TLS check names, instead of 'Could not connect'", () => {
  // The two classifiers are documented as sharing one vocabulary, and now share
  // one function. (Was a defect: they had drifted, and a certificate the
  // connection rejected was described to the user as a failure to connect.)
  for (const code of ["UNABLE_TO_GET_ISSUER_CERT", "CERT_NOT_YET_VALID"]) {
    assert.notEqual(classifyConnectionError(connectionError(code)).certificateProblem, undefined, code);
  }
});

// ---------------------------------------------------------------------------
// When the entry page itself fails over HTTPS
// ---------------------------------------------------------------------------

correct("B9 the page fetch alone, given an address without a scheme, retries over HTTP and keeps the certificate problem", async () => {
  // The documented purpose of the retry: report an insecure site as insecure,
  // not as unreachable. True of `fetchPage` called directly — see B11 for the
  // audit route.
  const outcome = await withServer(
    (url, server) => {
      if (url.protocol === "https:") throw connectionError("CERT_HAS_EXPIRED");
      return server.respond("page", { headers: HTML });
    },
    async () => fetchPage(PUBLIC_HOST),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.page.servedOverHttps, false);
  assert.equal(outcome.page.httpsUnavailable, true);
  assert.equal(outcome.page.certificateProblem, "expired");
});

correct("B10 an entry page whose certificate failed still produces a report: the certificate, graded", async () => {
  // The certificate check exists to describe exactly this site, and it reads a
  // certificate the connection refused on purpose. So the audit runs the
  // site-level checks and reports what they measured, instead of failing the
  // job and throwing away the finding that stopped it. (Was a defect: no
  // report at all, and the certificate check never ran.)
  const run = await auditEntry(ROOT, () => {
    throw connectionError("CERT_HAS_EXPIRED");
  });

  assert.equal(run.error, null);
  assert.equal(run.siteChecksRan, 1);

  assert.ok(run.result !== null && isCertificateFailureAudit(run.result));
  assert.equal(run.result.certificateProblem, "expired");
  assert.equal(run.result.reason, "The website's security certificate has expired.");
  // Nothing page-shaped is claimed: no page was read.
  assert.equal(run.result.site.evaluatedPages, 0);
  assert.equal(run.result.crawl.evaluated, 0);
});
correct("B11 an assumed-https site that refuses the connection is retried over HTTP into a full audit", async () => {
  // The person typed a bare host, so WE guessed https://. HTTPS refuses the
  // connection (not a certificate failure) but HTTP serves the page, so the
  // audit falls back to HTTP and grades the site -- with the missing HTTPS as
  // its own Critical finding -- rather than reporting nothing. (Was a defect:
  // the assumed-scheme signal was dropped at the route, so no retry happened.)
  const routeForm = normalizeUrl(PUBLIC_HOST);
  assert.equal(routeForm.ok, true);
  if (!routeForm.ok) return;
  const run = await auditEntry(
    routeForm.url.toString(),
    (url, server) => {
      if (url.protocol === "https:") throw connectionError("ECONNREFUSED");
      return server.respond("page", { headers: HTML, body: page() });
    },
    { schemeWasAssumed: true },
  );

  assert.equal(run.error, null);
  assert.ok(run.result !== null && !isCertificateFailureAudit(run.result));
  assert.equal(run.result.data.fetch.servedOverHttps, false);
  // It really did read the page over HTTP after the HTTPS attempt.
  assert.deepEqual(run.server.requests, [ROOT, `http://${PUBLIC_HOST}/`]);
});

correct("B11a a certificate failure is NOT retried over HTTP, even for an assumed scheme (B12 holds)", async () => {
  // The one that must not change: a certificate failure is B12's certificate-
  // only report, made from ONE request. The assumed scheme does not open an
  // HTTP fallback for it.
  const routeForm = normalizeUrl(PUBLIC_HOST);
  if (!routeForm.ok) return;
  const run = await auditEntry(
    routeForm.url.toString(),
    (url, server) => {
      if (url.protocol === "https:") throw connectionError("CERT_HAS_EXPIRED");
      return server.respond("page", { headers: HTML, body: page() });
    },
    { schemeWasAssumed: true },
  );

  assert.equal(run.error, null);
  assert.ok(run.result !== null && isCertificateFailureAudit(run.result));
  assert.deepEqual(run.server.requests, [ROOT], "no HTTP request was made");
});

correct("B11b an explicitly typed https:// that refuses the connection is NOT downgraded to HTTP", async () => {
  // The person chose https://. A connection failure stays a failure -- the audit
  // never silently reads their site over an unencrypted connection.
  const run = await auditEntry(
    ROOT,
    (url, server) => {
      if (url.protocol === "https:") throw connectionError("ECONNREFUSED");
      return server.respond("page", { headers: HTML, body: page() });
    },
    { schemeWasAssumed: false },
  );

  assert.ok(run.error instanceof EntryPageUnavailableError);
  assert.equal(run.error.reason, "The website refused the connection.");
  assert.deepEqual(run.server.requests, [ROOT], "no HTTP fallback for an explicit https://");
});

correct("B11c when HTTP also fails, the audit stays unavailable rather than looping", async () => {
  const routeForm = normalizeUrl(PUBLIC_HOST);
  if (!routeForm.ok) return;
  const run = await auditEntry(
    routeForm.url.toString(),
    () => {
      throw connectionError("ECONNREFUSED");
    },
    { schemeWasAssumed: true },
  );

  assert.ok(run.error instanceof EntryPageUnavailableError);
  // One HTTPS attempt, one HTTP attempt, and no third: the retry does not retry.
  assert.deepEqual(run.server.requests, [ROOT, `http://${PUBLIC_HOST}/`]);
});

correct("B11d a server that ANSWERS over HTTPS with an error is not downgraded to HTTP", async () => {
  // HTTPS works -- it answered, just with a 500. Falling back to HTTP would be
  // auditing a page the site's HTTPS visitors never see. Only a connection that
  // never answered is retried.
  const routeForm = normalizeUrl(PUBLIC_HOST);
  if (!routeForm.ok) return;
  const run = await auditEntry(
    routeForm.url.toString(),
    (url, server) =>
      url.protocol === "https:"
        ? server.respond("500", { status: 500, headers: HTML })
        : server.respond("page", { headers: HTML, body: page() }),
    { schemeWasAssumed: true },
  );

  assert.ok(run.error instanceof EntryPageUnavailableError);
  assert.deepEqual(run.server.requests, [ROOT], "the answered HTTPS request is not retried over HTTP");
});

correct("B11e the HTTP fallback still refuses a host that resolves to a private address (SSRF)", async () => {
  // The fallback goes through the same fetcher and the same per-hop safety
  // check. A redirect from the HTTP entry to a private address is refused,
  // exactly as it is on the HTTPS path.
  const routeForm = normalizeUrl(PUBLIC_HOST);
  if (!routeForm.ok) return;
  const run = await auditEntry(
    routeForm.url.toString(),
    (url, server) => {
      if (url.protocol === "https:") throw connectionError("ECONNREFUSED");
      // The HTTP entry redirects into a private network; safety must refuse it.
      return server.respond("hop", { status: 302, headers: { location: "http://10.0.0.5/admin" } });
    },
    { schemeWasAssumed: true },
  );

  assert.ok(run.error instanceof EntryPageUnavailableError);
  // The HTTPS attempt and the HTTP entry were requested; the private address never was.
  assert.deepEqual(run.server.requests, [ROOT, `http://${PUBLIC_HOST}/`]);
});

decision("B12 a site whose HTTPS certificate fails but which serves HTTP is not audited over HTTP either", async () => {
  // Pinned: the report is made from the certificate alone, and no plain-HTTP
  // request is made. Whether a certificate failure should ever fall back to
  // HTTP — which would describe a page the site's visitors never see — is a
  // decision, and B10 producing a report does not settle it.
  const routeForm = normalizeUrl(PUBLIC_HOST);
  assert.equal(routeForm.ok, true);
  if (!routeForm.ok) return;
  const run = await auditEntry(routeForm.url.toString(), (url, server) => {
    if (url.protocol === "https:") throw connectionError("CERT_HAS_EXPIRED");
    return server.respond("page", { headers: HTML, body: page() });
  });
  assert.ok(run.result !== null && isCertificateFailureAudit(run.result));
  assert.deepEqual(run.server.requests, [ROOT]);
});
