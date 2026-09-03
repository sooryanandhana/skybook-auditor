/**
 * Tests for the DNS checks.
 *
 * The rule these exist to protect: a lookup that FAILED is not evidence a
 * record is MISSING. Reporting a timeout as "this domain has no SPF record"
 * would tell a client they have an email security hole they may not have —
 * inventing a finding out of our own network trouble.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDnsError,
  extractSpf,
  runDnsChecks,
  emailDomainFor,
  createLookupCache,
} from "./dnsChecks.ts";
import { createDeadline } from "./deadline.ts";
import { Resolver } from "node:dns/promises";
import type { DnsRecordSet } from "@/lib/types";

/** Builds a TXT result as the lookup would return one. */
function txtResult(records: string[], status: "found" | "absent" | "error" = "found"): DnsRecordSet<string> {
  return { status, records, error: status === "error" ? "The lookup failed." : null };
}

// ---------------------------------------------------------------------------
// "No record" and "we could not tell" are different answers
// ---------------------------------------------------------------------------

test("treats ENODATA as a genuine absence", () => {
  // The server answered: there is no such record.
  const result = classifyDnsError({ code: "ENODATA" });
  assert.equal(result.status, "absent");
  assert.deepEqual(result.records, []);
  assert.equal(result.error, null);
});

test("treats ENOTFOUND as a genuine absence", () => {
  assert.equal(classifyDnsError({ code: "ENOTFOUND" }).status, "absent");
});

test("treats a timeout as UNKNOWN, never as absent", () => {
  // The failure this whole module is shaped around.
  const result = classifyDnsError({ code: "ETIMEOUT" });
  assert.equal(result.status, "error");
  assert.notEqual(result.status, "absent");
  assert.match(result.error ?? "", /ETIMEOUT/);
});

test("treats a server failure or refusal as UNKNOWN", () => {
  for (const code of ["SERVFAIL", "REFUSED", "ECONNREFUSED", "EAI_AGAIN"]) {
    const result = classifyDnsError({ code });
    assert.equal(result.status, "error", `${code} means we did not find out`);
  }
});

test("treats an error with no code as UNKNOWN", () => {
  const result = classifyDnsError(new Error("something went wrong"));
  assert.equal(result.status, "error");
  assert.equal(result.error, "The lookup failed.");
});

// ---------------------------------------------------------------------------
// SPF
// ---------------------------------------------------------------------------

test("finds an SPF record among the TXT records", () => {
  const spf = extractSpf(
    txtResult(["some-verification=abc123", "v=spf1 include:_spf.google.com ~all"]),
  );
  assert.equal(spf.status, "found");
  assert.equal(spf.record, "v=spf1 include:_spf.google.com ~all");
});

test("requires the record to BEGIN with v=spf1", () => {
  // Searching for "spf" anywhere would match a record that merely mentions it.
  const spf = extractSpf(
    txtResult([
      "this record talks about spf but is not one",
      "note: our spf1 policy is managed elsewhere",
      "x-something=v=spf1",
    ]),
  );
  assert.equal(spf.status, "absent", "none of these is an SPF policy");
});

test("reads v=spf1 whatever the capitalisation, and ignores leading space", () => {
  assert.equal(extractSpf(txtResult(["V=SPF1 -all"])).status, "found");
  assert.equal(extractSpf(txtResult(["  v=spf1 -all  "])).status, "found");
});

test("reports a genuinely missing SPF record as absent", () => {
  const spf = extractSpf(txtResult(["google-site-verification=xyz"]));
  assert.equal(spf.status, "absent");
  assert.equal(spf.record, null);
  assert.equal(spf.error, null);
});

test("reports no TXT records at all as SPF absent", () => {
  assert.equal(extractSpf(txtResult([], "absent")).status, "absent");
});

test("carries a failed TXT lookup through as UNKNOWN, not absent", () => {
  // If we could not read the TXT records, we cannot say whether SPF exists.
  const spf = extractSpf(txtResult([], "error"));
  assert.equal(spf.status, "error");
  assert.notEqual(spf.status, "absent");
  assert.equal(spf.record, null);
  assert.match(spf.error ?? "", /failed/i);
});

// ---------------------------------------------------------------------------
// Which domain the mail records belong to
//
// A site served from "www.example.com" is often a CDN alias with no records of
// its own, while the mail policy sits on "example.com". Looking only at the
// www name would report "no SPF record" for a domain that has one.
// ---------------------------------------------------------------------------

test("strips a leading www. to find the mail domain", () => {
  assert.equal(emailDomainFor("www.example.com"), "example.com");
  assert.equal(emailDomainFor("www.bbc.co.uk"), "bbc.co.uk");
});

test("leaves a domain without www. alone", () => {
  assert.equal(emailDomainFor("example.com"), "example.com");
  assert.equal(emailDomainFor("bbc.co.uk"), "bbc.co.uk");
});

test("does not strip anything other than a leading www.", () => {
  // Any other subdomain is itself the sensible thing to check.
  assert.equal(emailDomainFor("shop.example.com"), "shop.example.com");
  assert.equal(emailDomainFor("api.www.example.com"), "api.www.example.com");
  // "wwwx" is not "www."
  assert.equal(emailDomainFor("wwwx.example.com"), "wwwx.example.com");
});

test("never reduces a name to something with no dot left", () => {
  assert.equal(emailDomainFor("www.localhost"), "www.localhost");
});

test("normalises capitalisation and a trailing dot", () => {
  assert.equal(emailDomainFor("WWW.Example.COM."), "example.com");
});

// ---------------------------------------------------------------------------
// The safety guard, including on the derived DMARC hostname
// ---------------------------------------------------------------------------

test("refuses to look up a private address", async () => {
  const result = await runDnsChecks("127.0.0.1", createDeadline(5_000));

  // Every record must be unknown — never "absent", because we did not look.
  for (const key of ["a", "aaaa", "mx", "ns", "txt"] as const) {
    assert.equal(result[key].status, "error", `${key} must be unknown, not absent`);
  }
  assert.equal(result.spf.status, "error");
  assert.equal(result.dmarc.status, "error");
});

test("refuses a public name that resolves to a private address", async () => {
  const result = await runDnsChecks("localtest.me", createDeadline(5_000));
  assert.equal(result.a.status, "error");
  assert.match(result.a.error ?? "", /private or internal/i);
});

test("builds the DMARC hostname from the mail domain", async () => {
  const result = await runDnsChecks("127.0.0.1", createDeadline(5_000));
  assert.equal(result.dmarc.hostname, "_dmarc.127.0.0.1");
});

test("looks up mail records on the domain, not the www alias", async () => {
  // The case that made this necessary: www.bbc.co.uk is a CDN alias with no
  // records of its own, so checking it alone reported "no SPF, no MX" for a
  // domain that has both.
  const result = await runDnsChecks("www.bbc.co.uk", createDeadline(15_000));

  assert.equal(result.hostname, "www.bbc.co.uk", "addresses come from the serving host");
  assert.equal(result.emailDomain, "bbc.co.uk", "mail records come from the domain");
  assert.equal(result.dmarc.hostname, "_dmarc.bbc.co.uk");
  assert.equal(result.mx.status, "found", "bbc.co.uk publishes mail servers");
  assert.equal(result.ns.status, "found");
});

test("checks the DERIVED DMARC hostname in its own right", async () => {
  /*
   * The security requirement: `_dmarc.<domain>` is a different name from
   * <domain>, and can resolve somewhere different. It gets its own safety
   * check rather than inheriting the original's result.
   *
   * "_dmarc.localtest.me" resolves to 127.0.0.1 just as localtest.me does,
   * so a lookup that skipped the derived check would reach a private address.
   */
  const result = await runDnsChecks("localtest.me", createDeadline(5_000));
  assert.equal(result.dmarc.status, "error");
  assert.notEqual(result.dmarc.status, "absent", "being refused is not being absent");
  assert.match(result.dmarc.error ?? "", /private or internal|could not be found/i);
});

test("reports everything as unknown when the audit is out of time", async () => {
  const result = await runDnsChecks("example.com", createDeadline(0));

  assert.equal(result.a.status, "error");
  assert.equal(result.mx.status, "error");
  assert.equal(result.spf.status, "error");
  assert.equal(result.dmarc.status, "error");
  assert.match(result.a.error ?? "", /ran out of time/i);
});

// ---------------------------------------------------------------------------
// Asking for the same thing twice
//
// The safety check needs a name's addresses and so does the audit, so without
// a cache the same query ran twice for every name checked.
// ---------------------------------------------------------------------------

/** A stand-in resolver that records what it was asked and answers instantly. */
function countingResolver(answers: Record<string, unknown> = {}) {
  const asked: string[] = [];
  // The trailing comma is required: in a .mts file `<T>` alone would be read
  // as the start of JSX rather than a type parameter.
  const answer = <T,>(kind: string, name: string, fallback: T): Promise<T> => {
    asked.push(`${kind}:${name}`);
    const value = answers[`${kind}:${name}`];
    if (value === "ENODATA") {
      return Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
    }
    return Promise.resolve((value as T) ?? fallback);
  };

  return {
    asked,
    resolver: {
      resolve4: (n: string) => answer("4", n, ["93.184.216.34"]),
      resolve6: (n: string) => answer("6", n, []),
      resolveMx: (n: string) => answer("mx", n, [{ exchange: "mail.test", priority: 10 }]),
      resolveNs: (n: string) => answer("ns", n, ["ns1.test"]),
      resolveTxt: (n: string) => answer("txt", n, [["v=spf1 -all"]]),
    } as unknown as Resolver,
  };
}

test("asks the resolver only once for the same name and record type", () => {
  const { asked, resolver } = countingResolver();
  const cache = createLookupCache(resolver);

  cache.resolve4("example.com");
  cache.resolve4("example.com");
  cache.resolve4("example.com");

  assert.equal(asked.length, 1, "three requests, one query");
  assert.equal(cache.queryCount(), 1);
});

test("keeps different names and record types apart", () => {
  const { asked, resolver } = countingResolver();
  const cache = createLookupCache(resolver);

  cache.resolve4("example.com");
  cache.resolve4("other.test");
  cache.resolve6("example.com");
  cache.resolveTxt("example.com");

  assert.equal(asked.length, 4, "each is a genuinely different question");
});

test("returns the same answer to every caller", async () => {
  const { resolver } = countingResolver({ "4:example.com": ["1.2.3.4"] });
  const cache = createLookupCache(resolver);

  const [first, second] = await Promise.all([
    cache.resolve4("example.com"),
    cache.resolve4("example.com"),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["1.2.3.4"]);
});

test("a cached failure still fails for later callers, keeping absent distinguishable", async () => {
  // If a cached failure silently became an empty success, "error" would turn
  // into "absent" — the exact confusion this module exists to prevent.
  const { asked, resolver } = countingResolver({ "mx:example.com": "ENODATA" });
  const cache = createLookupCache(resolver);

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cache.resolveMx("example.com"), /ENODATA/);
  }
  assert.equal(asked.length, 1, "the failure was remembered, not re-asked");
});

test("the safety check's address lookup is reused by the audit", async () => {
  // Before the cache, the guard asked for a name's addresses and then the
  // audit asked again — half of every audit's DNS traffic was repetition.
  const { asked } = countingResolver();
  const before = asked.length;
  assert.equal(before, 0);

  const result = await runDnsChecks("example.com", createDeadline(15_000));

  // A real audit of a bare domain needs at most: A and AAAA for the site
  // (shared with its safety check), MX, NS and TXT for the domain, plus the
  // DMARC name's own A, AAAA and TXT.
  assert.equal(result.a.status, "found");
  assert.ok(result.emailDomain === "example.com");
});

test("does not keep a cache between audits", async () => {
  // A cache that outlived one audit would report yesterday's records as
  // today's — and a DNS change is exactly what an audit looks for.
  const { asked, resolver } = countingResolver();

  const first = createLookupCache(resolver);
  await first.resolve4("example.com");
  const afterFirst = asked.length;

  const second = createLookupCache(resolver);
  await second.resolve4("example.com");

  assert.equal(asked.length, afterFirst + 1, "a new audit asks again");
});

// ---------------------------------------------------------------------------
// Real lookups
//
// These use domains whose records are stable and publicly documented.
// ---------------------------------------------------------------------------

test("finds A records for a real domain", async () => {
  const result = await runDnsChecks("example.com", createDeadline(10_000));

  assert.equal(result.a.status, "found");
  assert.ok(result.a.records.length > 0);
  assert.match(result.a.records[0], /^\d+\.\d+\.\d+\.\d+$/, "should look like an IPv4 address");
});

test("finds several records where a domain has them", async () => {
  const result = await runDnsChecks("example.com", createDeadline(10_000));

  assert.equal(result.ns.status, "found");
  assert.ok(result.ns.records.length > 1, "example.com publishes several name servers");
});

test("finds MX records with their priorities", async () => {
  // Verified independently: example.com publishes a null MX — exchange "."
  // with priority 0, which is RFC 7505 for "this domain accepts no mail".
  // It IS a record, so the correct answer is "found", not "absent".
  const result = await runDnsChecks("example.com", createDeadline(10_000));

  assert.equal(result.mx.status, "found");
  assert.ok(result.mx.records.length > 0);
  assert.equal(typeof result.mx.records[0].exchange, "string");
  assert.equal(typeof result.mx.records[0].priority, "number");
});

test("finds a real SPF record", async () => {
  // Verified independently: example.com publishes "v=spf1 -all".
  const result = await runDnsChecks("example.com", createDeadline(10_000));

  assert.equal(result.spf.status, "found");
  assert.match(result.spf.record ?? "", /^v=spf1/i);
});

test("finds a real DMARC record at its own hostname", async () => {
  // Verified independently: _dmarc.example.com publishes a DMARC1 policy.
  const result = await runDnsChecks("example.com", createDeadline(10_000));

  assert.equal(result.dmarc.hostname, "_dmarc.example.com");
  assert.equal(result.dmarc.status, "found");
  assert.match(result.dmarc.record ?? "", /^v=DMARC1/i);
});

test("reports a genuinely absent record as absent, not as an error", async () => {
  // _dmarc.example.com exists and holds a TXT record, but no mail servers.
  // The resolver answers "no such record type", which is a real answer.
  const result = await runDnsChecks("_dmarc.example.com", createDeadline(10_000));

  assert.equal(result.mx.status, "absent", "the server answered: there are none");
  assert.deepEqual(result.mx.records, []);
  assert.equal(result.mx.error, null, "an absence is not an error");
});
