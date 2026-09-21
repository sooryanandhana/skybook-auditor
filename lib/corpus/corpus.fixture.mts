/**
 * THE ACCURACY CORPUS — shared harness.
 *
 * WHAT THE CORPUS IS FOR
 *
 * A standing record of what this audit does with real-world website situations,
 * measured against the application's own code rather than described from
 * memory. It exists so that the hardening work which follows can prove what it
 * changed, and prove it changed nothing else.
 *
 * Every case carries one of three verdicts, and the verdict is part of the
 * test's name so a test run reads as a report:
 *
 *   [correct]   What the code does is right, and the reason is written beside
 *               the case: a specification, a security invariant, or the
 *               project's own documented rule. Pinned, so an unintended change
 *               fails.
 *
 *   [defect]    What the code does is wrong, and the reason is equally written
 *               down. The case pins the CURRENT behaviour, so the suite stays
 *               green and nobody changes it by accident. Where the correct
 *               behaviour is not itself a decision, a second test states what
 *               the fix must produce; it runs as a node:test TODO, which is
 *               reported but never fails the run. When a fix lands the pinned
 *               test fails (delete it) and the TODO passes (drop the todo).
 *
 *   [decision]  What the code does is neither clearly right nor clearly wrong:
 *               changing it needs a product or security decision first.
 *               Pinned, nothing more.
 *
 * NOTHING HERE TOUCHES THE NETWORK, AND THAT IS ENFORCED, NOT HOPED FOR.
 *
 * `installOfflineCorpus()` replaces DNS resolution with a stub and `fetch` with a
 * tripwire for the whole test file. An IP literal answers itself, exactly as
 * Node's own resolver does without sending a query. A hostname answers only if
 * the test registered it. Anything else fails as "not found" and is recorded,
 * so a test can assert that no lookup happened at all.
 *
 * The stub reaches the production modules because they import `lookup` from
 * `node:dns/promises`, and Node keeps those named ESM bindings in step with the
 * builtin module after `syncBuiltinESMExports()`.
 *
 * WHY THE SHARED `realAudit.fixture.mts` IS NOT USED WHOLE
 *
 * Its page fetcher is used — it is the project's socket seam. `runRealAudit`
 * and `siteChecksFor` are not, for reasons of purpose rather than defect: the
 * corpus needs site-level facts describing a HEALTHY HTTPS site (a valid
 * certificate, SPF and an enforced DMARC policy) so a page-level case reports
 * only what its page caused, it needs to drive the real page fetcher and
 * address check rather than only the fixture's fetcher, and it removes crawl
 * pacing so every case stays fast. Its site-level facts are typed and built
 * through the real `describeCertificate`, exactly as the shared fixture's are.
 *
 * (The shared fixture once read robots.txt over the real network and built its
 * certificate behind an `as unknown as` cast. Both were fixed there; see
 * realAudit.fixture.test.mts.)
 */
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";
import type { PeerCertificate } from "node:tls";
import { after, before, test } from "node:test";

import { runSiteAudit, type SiteChecks } from "../audit/siteAudit.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import { fetcherFor, type FakeSite } from "../audit/pdf/realAudit.fixture.mts";
import type { CrawlOptions } from "../collector/crawlSite.ts";
import { describeCertificate } from "../collector/sslChecks.ts";
import type { SitemapFetcher } from "../collector/sitemap.ts";
import type {
  CertificateProblem,
  DnsData,
  Finding,
  SiteAuditResult,
  SkippedCheck,
  SslData,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type CorpusTest = () => void | Promise<void>;

/** Verified as right. The reason belongs in the case's own comment. */
export function correct(name: string, fn: CorpusTest): void {
  test(`[correct] ${name}`, fn);
}

/** Verified as wrong. `now` pins today's behaviour; `afterFix` is the fix's acceptance test. */
export function defect(name: string, cases: { now: CorpusTest; afterFix?: CorpusTest }): void {
  test(`[defect] ${name} — current behaviour`, cases.now);
  if (cases.afterFix) {
    test(`[defect] ${name} — required after the fix`, { todo: "known defect, not fixed yet" }, cases.afterFix);
  }
}

/** Needs a product or security decision before anyone changes it. */
export function decision(name: string, fn: CorpusTest): void {
  test(`[decision] ${name}`, fn);
}

// ---------------------------------------------------------------------------
// Offline guarantees
// ---------------------------------------------------------------------------

/** A public address literal: the address check classifies it without a DNS query. */
export const PUBLIC_HOST = "93.184.216.34";
/** A second public literal, for redirects that leave the first host. */
export const OTHER_PUBLIC_HOST = "1.1.1.1";

export interface OfflineGuard {
  /** Every name the code under test tried to resolve, in order. */
  readonly lookups: string[];
  /** Names a test has chosen to answer, and the addresses they resolve to. */
  readonly hosts: Map<string, readonly string[]>;
}

/** Why a tripwire fired, kept so a test can prove nothing escaped. */
export const escapedRequests: string[] = [];

const tripwire = (async (input: RequestInfo | URL) => {
  escapedRequests.push(String(input));
  throw new Error(`corpus: a request escaped to the network: ${String(input)}`);
}) as typeof fetch;

/**
 * Installs the DNS stub and the fetch tripwire for the whole test file.
 *
 * Node runs each test file in its own process, so nothing installed here can
 * leak into another file, and `after` restores both anyway.
 */
export function installOfflineCorpus(): OfflineGuard {
  const guard: OfflineGuard = { lookups: [], hosts: new Map() };
  const originalLookup = dns.promises.lookup;
  const originalFetch = globalThis.fetch;

  const stubLookup = (hostname: string, options?: unknown) => {
    guard.lookups.push(hostname);
    const all = typeof options === "object" && options !== null && (options as { all?: unknown }).all === true;
    const answers = isIP(hostname) !== 0 ? [hostname] : guard.hosts.get(hostname);
    if (!answers || answers.length === 0) {
      return Promise.reject(
        Object.assign(new Error(`corpus: no DNS answer registered for ${hostname}`), { code: "ENOTFOUND" }),
      );
    }
    const records = answers.map((address) => ({ address, family: isIP(address) }));
    return Promise.resolve(all ? records : records[0]);
  };

  before(() => {
    Reflect.set(dns.promises, "lookup", stubLookup);
    syncBuiltinESMExports();
    globalThis.fetch = tripwire;
  });

  after(() => {
    Reflect.set(dns.promises, "lookup", originalLookup);
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    // Production code catches fetch failures and turns them into "unavailable",
    // so a tripped wire could otherwise pass unnoticed. It fails the file here.
    if (escapedRequests.length > 0) {
      throw new Error(`corpus: requests escaped to the network: ${escapedRequests.join(", ")}`);
    }
  });

  return guard;
}

// ---------------------------------------------------------------------------
// A scripted server behind `fetch`
// ---------------------------------------------------------------------------

export interface ScriptedServer {
  /** Every address the code under test requested, in order. */
  readonly requests: string[];
  /** Labels of response bodies whose stream was cancelled by the code under test. */
  readonly cancelled: string[];
  /** A response whose body records whether anyone released it. */
  respond(label: string, init?: { status?: number; headers?: Record<string, string>; body?: string }): Response;
}

export type Script = (url: URL, server: ScriptedServer) => Response | Promise<Response>;

/** How much of a scripted body is handed over per read. */
const BODY_CHUNK_BYTES = 64_000;

/**
 * Runs `body` with `fetch` answered by `script`, then puts the tripwire back.
 *
 * BODIES ARRIVE IN CHUNKS AND CLOSE ONLY ON THE READ AFTER THE LAST ONE, the way
 * a real server's do. That detail is what makes `cancelled` trustworthy: a
 * stream that has already closed ignores `cancel()` and never tells its source,
 * so a single pre-closed chunk would report "never released" even for code that
 * did release it. Chunked, a response the code reads completes normally, one it
 * abandons stays open, and one it cancels is recorded.
 */
export async function withServer<T>(script: Script, body: (server: ScriptedServer) => Promise<T>): Promise<T> {
  const server: ScriptedServer = {
    requests: [],
    cancelled: [],
    respond(label, init = {}) {
      const text = init.body ?? "<!doctype html><html><head><title>t</title></head><body>ok</body></html>";
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + BODY_CHUNK_BYTES));
          offset += BODY_CHUNK_BYTES;
        },
        cancel() {
          server.cancelled.push(label);
        },
      });
      return new Response(stream, { status: init.status ?? 200, headers: init.headers ?? {} });
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    server.requests.push(url.toString());
    return script(url, server);
  }) as typeof fetch;
  try {
    return await body(server);
  } finally {
    globalThis.fetch = tripwire;
  }
}

/** The error shape Node's fetch throws for a failed connection: the code is on `cause`. */
export function connectionError(code: string): TypeError {
  const error = new TypeError("fetch failed");
  Object.assign(error, { cause: Object.assign(new Error(code), { code }) });
  return error;
}

export const HTML = { "content-type": "text/html; charset=utf-8" } as const;

// ---------------------------------------------------------------------------
// Typed site-level facts
// ---------------------------------------------------------------------------

/** The instant every certificate in the corpus is judged at. */
export const CORPUS_NOW = new Date("2026-09-15T12:00:00.000Z");

/** A peer certificate as Node's TLS layer describes one, with only the fields the collector reads. */
export function peerCertificate(fields: {
  validFrom: string;
  validTo: string;
  names: readonly string[];
  issuer?: string;
}): Partial<PeerCertificate> {
  return {
    valid_from: fields.validFrom,
    valid_to: fields.validTo,
    subjectaltname: fields.names.map((name) => `DNS:${name}`).join(", "),
    subject: { CN: fields.names[0] ?? "" } as PeerCertificate["subject"],
    issuer: { CN: fields.issuer ?? "Corpus Test CA" } as PeerCertificate["issuer"],
  };
}

/** What the TLS collector reports for a certificate it read, built by the collector's own function. */
export function checkedSsl(
  hostname: string,
  certificate: Partial<PeerCertificate>,
  verdict: { trusted: boolean; problem: CertificateProblem | null },
): SslData {
  return {
    status: "checked",
    hostname,
    certificate: describeCertificate(certificate, hostname, "TLSv1.3", CORPUS_NOW),
    trusted: verdict.trusted,
    problem: verdict.problem,
    failure: null,
    message: "The certificate was read.",
  };
}

/** A healthy certificate for `example.com`, valid for another 107 days at CORPUS_NOW. */
export function validCertificate(names: readonly string[] = ["example.com"]): Partial<PeerCertificate> {
  return peerCertificate({ validFrom: "Jan  1 00:00:00 2026 GMT", validTo: "Dec 31 23:59:59 2026 GMT", names });
}

/** DNS facts for a domain that publishes SPF and an enforced DMARC policy. */
export function healthyDns(hostname: string): DnsData {
  return {
    hostname,
    emailDomain: hostname,
    a: { status: "found", records: [PUBLIC_HOST], error: null },
    aaaa: { status: "absent", records: [], error: null },
    mx: { status: "found", records: [{ exchange: `mail.${hostname}`, priority: 10 }], error: null },
    ns: { status: "found", records: [`ns1.${hostname}`], error: null },
    txt: { status: "found", records: ["v=spf1 -all"], error: null },
    spf: { status: "found", record: "v=spf1 -all", error: null },
    dmarc: {
      status: "found",
      record: "v=DMARC1; p=reject",
      error: null,
      hostname: `_dmarc.${hostname}`,
      appliesTo: hostname,
      policyDomain: hostname,
      inherited: false,
      effectivePolicy: "reject",
    },
  };
}

/**
 * Site-level facts that produce no findings of their own, so a page-level case
 * reports only what its page caused. `servedOverHttps` decides whether a
 * certificate exists to describe, exactly as the real TLS collector does.
 */
export function quietSiteChecks(servedOverHttps: boolean, overrides: Partial<SiteChecks> = {}): SiteChecks {
  return {
    technical: {
      robotsTxtStatus: "absent",
      robotsBlocksEverything: false,
      sitemapStatus: "absent",
      sitemapUrl: null,
    },
    ssl: servedOverHttps
      ? checkedSsl("example.com", validCertificate(), { trusted: true, problem: null })
      : {
          status: "not-applicable",
          hostname: "example.com",
          certificate: null,
          trusted: null,
          problem: null,
          failure: null,
          message: "The site is not served over HTTPS, so it presents no certificate.",
        },
    dns: healthyDns("example.com"),
    responseTime: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Running the real audit on a fixture site
// ---------------------------------------------------------------------------

/** robots.txt and sitemaps: none published. A real answer, reached without a request. */
export const noSiteFiles: SitemapFetcher = async () => ({ ok: false, reason: "absent" });

const noPause = async () => {};

export interface CorpusAuditOptions {
  /** The address the audit starts from. Defaults to the first page's address. */
  readonly entry?: string;
  /** Site-level facts in place of the quiet defaults. */
  readonly siteChecks?: SiteChecks;
  /** Extra crawl options, applied last. */
  readonly crawl?: Partial<CrawlOptions>;
  /** Filled with every page address the crawler fetched. */
  readonly asked?: string[];
}

/**
 * The real pipeline — crawler, collectors, rules and aggregation — on a fixture
 * site. Only the socket is replaced, pacing is removed, and robots.txt and
 * sitemaps answer "absent" without a request.
 */
export async function auditFixtureSite(site: FakeSite, options: CorpusAuditOptions = {}): Promise<SiteAuditResult> {
  const entry = options.entry ?? Object.keys(site)[0];
  const audit = await runSiteAudit({
    requestedUrl: entry,
    crawl: {
      fetchImpl: fetcherFor(site, options.asked),
      useSitemaps: false,
      sitemapFetchImpl: noSiteFiles,
      sleepImpl: noPause,
      ...options.crawl,
    },
    siteChecksImpl: async (_entryUrl, servedOverHttps) => options.siteChecks ?? quietSiteChecks(servedOverHttps),
  });

  /*
   * These cases are about sites whose entry page was read. An audit that
   * could not read one is a different shape with different questions, and
   * B10 in the certificate corpus is where those are asked -- so meeting one
   * here means the case is not testing what it says it is.
   */
  if (isCertificateFailureAudit(audit)) {
    throw new Error(`corpus fixture: ${entry} produced a certificate-failure audit, not a site audit`);
  }
  return audit;
}

/** A page with enough visible text that body-based checks are judged rather than skipped. */
export function page(options: { head?: string; body?: string; lang?: boolean } = {}): string {
  const text =
    "<p>Harbour Dental has served the town for twenty years, offering check-ups, hygiene visits, " +
    "whitening and emergency appointments for patients of every age, with early and Saturday clinics.</p>";
  return (
    `<!doctype html><html${options.lang === false ? "" : ' lang="en"'}><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbour Dental</title>' +
    '<meta name="description" content="A family dental practice.">' +
    `<link rel="canonical" href="https://example.com/">${options.head ?? ""}</head>` +
    `<body><h1>Harbour Dental</h1>${options.body ?? ""}${text}</body></html>`
  );
}

/** Headers a well-configured HTTPS page sends, so a case can remove or change one thing. */
export const PROTECTED_HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'",
} as const;

/** The findings from one audit, readable by rule id. */
export function findingsOf(result: SiteAuditResult) {
  const findings = result.site.findings;
  return {
    ids: findings.map((finding) => finding.id).sort(),
    get: (id: string): Finding | undefined => findings.find((finding) => finding.id === id),
    skipped: (id: string): SkippedCheck[] => result.site.skippedChecks.filter((check) => check.ruleId === id),
  };
}
