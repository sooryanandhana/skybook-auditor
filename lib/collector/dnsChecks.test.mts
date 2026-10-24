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
  checkDmarc,
  organisationalDomainFor,
  readPolicyTag,
} from "./dnsChecks.ts";
import { createDeadline } from "./deadline.ts";
import dns from "node:dns";
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

/**
 * Answers the collector's own Resolver from a table, for the length of `work`.
 *
 * `runDnsChecks` builds its resolver internally, so the stand-in goes on the
 * shared prototype — the same door `realAudit.fixture.mts` closes — and is put
 * back in `finally`. A name missing from the table gets ENOTFOUND, which reads
 * as "absent": a stub that failed to install would fail these tests, not pass.
 */
async function withStubbedResolver<T>(
  answers: Record<string, unknown>,
  work: (asked: string[]) => Promise<T>,
): Promise<T> {
  const asked: string[] = [];
  const prototype = dns.promises.Resolver.prototype;
  const kinds = { resolve4: "4", resolve6: "6", resolveMx: "mx", resolveNs: "ns", resolveTxt: "txt" };
  const originals = new Map<string, unknown>();

  for (const [method, kind] of Object.entries(kinds)) {
    originals.set(method, Reflect.get(prototype, method));
    Reflect.set(prototype, method, (name: string) => {
      asked.push(`${kind}:${name}`);
      const value = answers[`${kind}:${name}`];
      if (value === undefined) {
        return Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
      }
      return Promise.resolve(value);
    });
  }

  try {
    return await work(asked);
  } finally {
    for (const [method, original] of originals) Reflect.set(prototype, method, original);
  }
}

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
  // An ordinary-looking name whose A record is 127.0.0.1. Stubbed, because a
  // reserved .example name never resolves publicly.
  await withStubbedResolver({ "4:points-private.example": ["127.0.0.1"] }, async (asked) => {
    const result = await runDnsChecks("points-private.example", createDeadline(5_000));

    assert.ok(asked.includes("4:points-private.example"), "the refusal came from a DNS answer");
    assert.equal(result.a.status, "error");
    assert.match(result.a.error ?? "", /private or internal/i);
  });
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
   * Here the site's own name is public and passes; only "_dmarc.mail.example"
   * points at 127.0.0.1. So the refusal can only come from the derived name's
   * own check — a site name refused as a whole never reaches the DMARC lookup.
   */
  const answers = {
    "4:mail.example": ["93.184.216.34"],
    "mx:mail.example": [{ exchange: "mx.mail.example", priority: 10 }],
    "ns:mail.example": ["ns1.mail.example"],
    "txt:mail.example": [["v=spf1 -all"]],
    "4:_dmarc.mail.example": ["127.0.0.1"],
  };

  await withStubbedResolver(answers, async (asked) => {
    const result = await runDnsChecks("mail.example", createDeadline(5_000));

    assert.equal(result.a.status, "found", "the site's own name passed its check");
    assert.deepEqual(result.a.records, ["93.184.216.34"]);
    assert.ok(asked.includes("4:_dmarc.mail.example"), "the derived name was checked itself");
    assert.equal(result.dmarc.hostname, "_dmarc.mail.example");
    assert.equal(result.dmarc.status, "error");
    assert.notEqual(result.dmarc.status, "absent", "being refused is not being absent");
    assert.match(result.dmarc.error ?? "", /private or internal/i);
    assert.ok(!asked.includes("txt:_dmarc.mail.example"), "refused before any TXT query");
  });
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

test("joins a TXT record split into several chunks before SPF is read", async () => {
  // DNS splits a string longer than 255 bytes into several chunks on the wire,
  // and Node hands them back as an array. They MUST be re-joined: a long SPF
  // record arriving as ["v=spf1 include:… ", "…~all"] would otherwise be read as
  // two fragments, and the whole audit downstream expects one record beginning
  // v=spf1. A single-chunk fixture would pass while a real long record broke.
  const part1 = "v=spf1 include:_spf.a.example include:_spf.b.example ";
  const part2 = "include:_spf.c.example include:_spf.d.example ~all";
  const whole = part1 + part2;

  const resolver = {
    resolve4: () => Promise.resolve([]),
    resolve6: () => Promise.resolve([]),
    resolveMx: () => Promise.resolve([]),
    resolveNs: () => Promise.resolve([]),
    resolveTxt: () => Promise.resolve([[part1, part2]]),
  } as unknown as Resolver;

  const joined = await createLookupCache(resolver).resolveTxt("example.com");
  assert.deepEqual(joined, [whole], "the chunks are re-joined with no separator");

  // And the reader sees the whole record, so it is recognised and kept intact.
  const spf = extractSpf(txtResult(joined));
  assert.equal(spf.status, "found");
  assert.equal(spf.record, whole);
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

// ---------------------------------------------------------------------------
// DMARC INHERITS. SPF DOES NOT.
//
// A subdomain with no DMARC record of its own is covered by its organisational
// domain's record. Checking only the audited name reported "this domain
// publishes no DMARC record" about domains that are protected — confirmed
// against a real site, where the audited host had nothing and its parent
// published `v=DMARC1; p=quarantine; sp=none`.
//
// Every test here drives a stubbed resolver, so none of them touches DNS.
// ---------------------------------------------------------------------------

/**
 * A resolver that answers TXT from a table and nothing else from the network.
 *
 * A name missing from the table genuinely has no record — that is ENOTFOUND,
 * the answer a server gives, and it must stay distinguishable from a failure.
 */
function dmarcResolver(txt: Record<string, string[] | "FAIL">) {
  const asked: string[] = [];

  const answerTxt = (name: string) => {
    asked.push(name);
    const entry = txt[name];
    if (entry === "FAIL") {
      return Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }));
    }
    if (entry === undefined) {
      return Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    }
    return Promise.resolve(entry.map((line) => [line]));
  };

  const resolver = {
    // A _dmarc name holds only TXT and has no address. Answering ENODATA is
    // what a real server does, and the safety check allows it.
    resolve4: () => Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" })),
    resolve6: () => Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" })),
    resolveMx: () => Promise.resolve([]),
    resolveNs: () => Promise.resolve([]),
    resolveTxt: answerTxt,
  } as unknown as Resolver;

  return { asked, cache: createLookupCache(resolver) };
}

const dmarcFor = (domain: string, txt: Record<string, string[] | "FAIL">) =>
  checkDmarc(domain, dmarcResolver(txt).cache, createDeadline(5_000));

// --- the record the domain publishes itself --------------------------------

test("a record on the audited domain is its own, not inherited", async () => {
  const result = await dmarcFor("example.com", {
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  assert.equal(result.status, "found");
  assert.equal(result.record, "v=DMARC1; p=reject");
  assert.equal(result.policyDomain, "example.com");
  assert.equal(result.inherited, false);
  assert.equal(result.effectivePolicy, "reject");
  assert.equal(result.hostname, "_dmarc.example.com");
});

test("a domain with its own record is never asked about its parent", async () => {
  const { asked, cache } = dmarcResolver({
    "_dmarc.shop.example.com": ["v=DMARC1; p=none"],
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  const result = await checkDmarc("shop.example.com", cache, createDeadline(5_000));

  // Its own record governs it. The parent's is irrelevant and must not be read.
  assert.equal(result.policyDomain, "shop.example.com");
  assert.equal(result.effectivePolicy, "none");
  assert.deepEqual(asked, ["_dmarc.shop.example.com"]);
});

// --- THE REGRESSION: a subdomain covered from above ------------------------

test("a subdomain with no record of its own inherits its parent's", async () => {
  // The bug, stated as a test. This used to come back "absent", which became
  // a finding telling the client they had no DMARC at all.
  const result = await dmarcFor("shop.example.com", {
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  assert.equal(result.status, "found", "a policy applies here");
  assert.notEqual(result.status, "absent");
  assert.equal(result.record, "v=DMARC1; p=reject");
  assert.equal(result.policyDomain, "example.com");
  assert.equal(result.inherited, true);
  assert.equal(result.hostname, "_dmarc.example.com", "names where it was read from");
});

test("sp= governs the subdomain when the inherited record sets one", async () => {
  // The real record that exposed this: strict for the domain itself, nothing
  // for its subdomains. Reporting `p=quarantine` here would overstate the
  // protection this subdomain actually has.
  const result = await dmarcFor("info.example.com", {
    "_dmarc.example.com": ["v=DMARC1; p=quarantine; sp=none; pct=100"],
  });

  assert.equal(result.status, "found");
  assert.equal(result.inherited, true);
  assert.equal(result.effectivePolicy, "none", "sp= wins for a subdomain");
});

test("p= governs the subdomain when the inherited record sets no sp=", async () => {
  const result = await dmarcFor("shop.example.com", {
    "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
  });

  assert.equal(result.effectivePolicy, "quarantine");
});

test("a multi-level subdomain still reaches one level up, and only one", async () => {
  const { asked, cache } = dmarcResolver({
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  const result = await checkDmarc("eu.shop.example.com", cache, createDeadline(5_000));

  /*
   * DMARC defines ONE fallback, to the organisational domain. Walking all the
   * way up would be inventing a lookup the specification does not describe, so
   * this stops after the first parent and reports honestly.
   */
  assert.deepEqual(asked, ["_dmarc.eu.shop.example.com", "_dmarc.shop.example.com"]);
  assert.equal(result.status, "absent");
});

// --- the opposite direction: absence must stay absence ---------------------

test("no record anywhere is ABSENT, and stays a finding", async () => {
  const result = await dmarcFor("example.com", {});

  assert.equal(result.status, "absent");
  assert.equal(result.record, null);
  assert.equal(result.policyDomain, null);
  assert.equal(result.inherited, false);
  assert.equal(result.effectivePolicy, null);
});

test("a subdomain whose parent also has nothing is ABSENT", async () => {
  const result = await dmarcFor("shop.example.com", {});

  assert.equal(result.status, "absent");
  assert.notEqual(result.status, "found");
  assert.equal(result.inherited, false);
});

test("a two-label domain has no parent worth asking about", async () => {
  const { asked } = dmarcResolver({});
  const probe = dmarcResolver({});
  await checkDmarc("example.com", probe.cache, createDeadline(5_000));

  // Never `_dmarc.com`: a bare TLD is not an organisational domain.
  assert.deepEqual(probe.asked, ["_dmarc.example.com"]);
  assert.equal(asked.length, 0);
});

test("a www host is reduced before any of this, so it behaves like the domain", async () => {
  // emailDomainFor strips the www; this confirms the two agree.
  assert.equal(emailDomainFor("www.example.com"), "example.com");

  const probe = dmarcResolver({ "_dmarc.example.com": ["v=DMARC1; p=none"] });
  const result = await checkDmarc(
    emailDomainFor("www.example.com"),
    probe.cache,
    createDeadline(5_000),
  );

  assert.equal(result.status, "found");
  assert.equal(result.inherited, false, "the domain's own record, not a parent's");
  assert.deepEqual(probe.asked, ["_dmarc.example.com"]);
});

// --- the opposite direction: a failure must stay a failure -----------------

test("a failed lookup on the domain is UNAVAILABLE, never absent", async () => {
  const result = await dmarcFor("example.com", { "_dmarc.example.com": "FAIL" });

  assert.equal(result.status, "error");
  assert.notEqual(result.status, "absent");
  assert.equal(result.record, null);
  assert.match(result.error ?? "", /ETIMEOUT/);
});

test("a failed lookup on the PARENT is UNAVAILABLE, never absent", async () => {
  /*
   * The subtle one. We established the subdomain has no record of its own, and
   * then failed to find out whether one above it applies. That is "we do not
   * know" — and it must not collapse into the sentence that becomes a finding.
   */
  const result = await dmarcFor("shop.example.com", { "_dmarc.example.com": "FAIL" });

  assert.equal(result.status, "error");
  assert.notEqual(result.status, "absent");
  assert.equal(result.policyDomain, null, "no source can be named for a record never read");
  assert.equal(result.inherited, false);
});

test("a failed domain lookup never causes a parent lookup", async () => {
  const { asked, cache } = dmarcResolver({
    "_dmarc.shop.example.com": "FAIL",
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  const result = await checkDmarc("shop.example.com", cache, createDeadline(5_000));

  // We do not know whether the subdomain has its own record, so a parent's
  // record cannot be said to apply — it only applies in the absence of one.
  assert.equal(result.status, "error");
  assert.deepEqual(asked, ["_dmarc.shop.example.com"]);
});

test("no time left means unavailable, not absent", async () => {
  const probe = dmarcResolver({ "_dmarc.example.com": ["v=DMARC1; p=reject"] });
  const result = await checkDmarc("example.com", probe.cache, createDeadline(0));

  assert.equal(result.status, "error");
  assert.notEqual(result.status, "absent");
});

// --- reading the policy tag ------------------------------------------------

test("policy tags are read from the record, and only the defined ones", () => {
  assert.equal(readPolicyTag("v=DMARC1; p=reject", "p"), "reject");
  assert.equal(readPolicyTag("v=DMARC1; p=quarantine; sp=none", "sp"), "none");
  assert.equal(readPolicyTag("v=DMARC1;p=none;", "p"), "none");
  assert.equal(readPolicyTag("v=DMARC1; P=Reject", "p"), "reject", "tags are case-insensitive");
  assert.equal(readPolicyTag("v=DMARC1; p=reject", "sp"), null, "no sp= means no sp=");

  // An unrecognised value is NOT "none". Reading it as none would report that
  // the record permits forged mail through, on the strength of a value we did
  // not understand.
  assert.equal(readPolicyTag("v=DMARC1; p=banana", "p"), null);
  assert.equal(readPolicyTag("v=DMARC1; p=", "p"), null);
  assert.equal(readPolicyTag("not a dmarc record", "p"), null);
});

test("a record with no readable policy is still a record", async () => {
  const result = await dmarcFor("example.com", { "_dmarc.example.com": ["v=DMARC1; p=banana"] });

  assert.equal(result.status, "found", "the record exists and we read it");
  assert.equal(result.effectivePolicy, null, "but it states no policy we recognise");
});

// --- the organisational domain, and what it cannot know --------------------

test("the parent is one level up, and never a bare TLD", () => {
  assert.equal(organisationalDomainFor("shop.example.com"), "example.com");
  assert.equal(organisationalDomainFor("eu.shop.example.com"), "shop.example.com");
  assert.equal(organisationalDomainFor("example.com"), null);
  assert.equal(organisationalDomainFor("com"), null);
  assert.equal(organisationalDomainFor(""), null);
});

test("a public-suffix boundary is asked about but cannot answer wrongly", async () => {
  /*
   * `example.co.uk` is an organisational domain, but knowing that needs the
   * Public Suffix List, which this project has not taken on. So the parent
   * computed here is `co.uk` — a public suffix.
   *
   * Harmless in the direction that matters: public suffixes do not publish
   * DMARC records, so the lookup finds nothing and the answer stays exactly
   * what it was before. Verified against co.uk, com.au, org.uk and github.io.
   */
  const probe = dmarcResolver({});
  const result = await checkDmarc("example.co.uk", probe.cache, createDeadline(5_000));

  assert.deepEqual(probe.asked, ["_dmarc.example.co.uk", "_dmarc.co.uk"]);
  assert.equal(result.status, "absent");
});

test("a deeper name under a public suffix still finds the right parent", async () => {
  // shop.example.co.uk -> example.co.uk, which IS the organisational domain.
  const result = await dmarcFor("shop.example.co.uk", {
    "_dmarc.example.co.uk": ["v=DMARC1; p=reject"],
  });

  assert.equal(result.status, "found");
  assert.equal(result.policyDomain, "example.co.uk");
  assert.notEqual(result.policyDomain, "co.uk");
  assert.equal(result.inherited, true);
});

// ---------------------------------------------------------------------------
// WHICH DOMAIN IS THE POLICY ABOUT?
//
// Four different names are in play and it used to take knowledge of the code
// to tell them apart:
//
//   the audited hostname     www.example.com   the website's address
//   the mail domain          example.com       where email comes from
//   where the record was     example.com       or a parent, when inherited
//   the policy tag           p= or sp=         depending on which of those
//
// `appliesTo` names the second one outright, so nothing has to be inferred and
// `effectivePolicy` can never be read as being about a domain it is not.
// ---------------------------------------------------------------------------

test("the record says which domain it is about", async () => {
  const result = await dmarcFor("example.com", { "_dmarc.example.com": ["v=DMARC1; p=reject"] });

  assert.equal(result.appliesTo, "example.com");
  assert.equal(result.policyDomain, "example.com");
  assert.equal(result.inherited, false, "read from the very domain it governs");
});

test("appliesTo and policyDomain differ exactly when the policy is inherited", async () => {
  const inheritedCase = await dmarcFor("shop.example.com", {
    "_dmarc.example.com": ["v=DMARC1; p=reject"],
  });

  assert.equal(inheritedCase.appliesTo, "shop.example.com", "the domain being described");
  assert.equal(inheritedCase.policyDomain, "example.com", "the domain it was read from");
  assert.equal(inheritedCase.inherited, true);
  assert.notEqual(inheritedCase.appliesTo, inheritedCase.policyDomain);

  const directCase = await dmarcFor("shop.example.com", {
    "_dmarc.shop.example.com": ["v=DMARC1; p=none"],
  });

  assert.equal(directCase.appliesTo, directCase.policyDomain);
  assert.equal(directCase.inherited, false);
});

test("a www website reports the DMARC position of its MAIL domain", async () => {
  /*
   * The case this field exists for. `www.example.com` is a website address;
   * nobody sends email from it. `emailDomainFor` drops the label before any
   * lookup, so what is reported is `example.com`'s position — which is the one
   * the client actually has — and `appliesTo` says so rather than leaving a
   * reader to assume the hostname they typed.
   */
  const mailDomain = emailDomainFor("www.example.com");
  assert.equal(mailDomain, "example.com");

  const probe = dmarcResolver({ "_dmarc.example.com": ["v=DMARC1; p=quarantine; sp=none"] });
  const result = await checkDmarc(mailDomain, probe.cache, createDeadline(5_000));

  assert.equal(result.appliesTo, "example.com", "not www.example.com");
  assert.equal(result.policyDomain, "example.com");
  assert.equal(result.inherited, false, "example.com publishes this itself");
  // p=, because the record belongs to the domain being described. sp= governs
  // that domain's subdomains, which this is not one of.
  assert.equal(result.effectivePolicy, "quarantine");
  assert.deepEqual(probe.asked, ["_dmarc.example.com"], "the www name is never queried");
});

test("a www host under a subdomain still resolves to that subdomain", async () => {
  // www.shop.example.com -> shop.example.com, which has no record of its own,
  // so example.com's sp= governs it.
  const mailDomain = emailDomainFor("www.shop.example.com");
  assert.equal(mailDomain, "shop.example.com");

  const result = await dmarcFor(mailDomain, {
    "_dmarc.example.com": ["v=DMARC1; p=reject; sp=quarantine"],
  });

  assert.equal(result.appliesTo, "shop.example.com");
  assert.equal(result.policyDomain, "example.com");
  assert.equal(result.inherited, true);
  assert.equal(result.effectivePolicy, "quarantine", "sp= governs a subdomain");
});

test("effectivePolicy follows where the record was found, not what it says first", async () => {
  const record = ["v=DMARC1; p=reject; sp=none"];

  // Read from the domain itself: p= governs it.
  const direct = await dmarcFor("example.com", { "_dmarc.example.com": record });
  assert.equal(direct.effectivePolicy, "reject");

  // The very same record, inherited by a subdomain: sp= governs that.
  const inherited = await dmarcFor("shop.example.com", { "_dmarc.example.com": record });
  assert.equal(inherited.effectivePolicy, "none");

  assert.equal(direct.record, inherited.record, "one record, two different policies");
});

test("the info.cern.ch shape still behaves as the audit found it", async () => {
  /*
   * The real case that exposed the original bug, as a fixture: the audited
   * host publishes nothing and its parent publishes p=quarantine with sp=none.
   * It must be a found policy, inherited, and honestly reported as giving the
   * subdomain no enforcement at all.
   */
  const result = await dmarcFor("info.cern.ch", {
    "_dmarc.cern.ch": ["v=DMARC1; p=quarantine; sp=none; pct=100; fo=1"],
  });

  assert.equal(result.status, "found");
  assert.notEqual(result.status, "absent", "the bug was reporting this as absent");
  assert.equal(result.appliesTo, "info.cern.ch");
  assert.equal(result.policyDomain, "cern.ch");
  assert.equal(result.inherited, true);
  assert.equal(result.effectivePolicy, "none");
  assert.equal(result.hostname, "_dmarc.cern.ch");
});

test("a domain with nothing anywhere still names itself", async () => {
  const result = await dmarcFor("example.com", {});

  assert.equal(result.status, "absent");
  assert.equal(result.appliesTo, "example.com", "we know who we asked about");
  assert.equal(result.policyDomain, null, "but there is no record to point at");
  assert.equal(result.effectivePolicy, null);
});

test("a failed lookup names the domain but claims no policy", async () => {
  const result = await dmarcFor("example.com", { "_dmarc.example.com": "FAIL" });

  assert.equal(result.status, "error");
  assert.equal(result.appliesTo, "example.com");
  assert.equal(result.policyDomain, null);
  assert.equal(result.inherited, false);
  assert.equal(result.effectivePolicy, null);
});

test("a malformed record is read as far as it goes and no further", async () => {
  const cases: Array<[string, string | null]> = [
    ["v=DMARC1; p=banana", null],
    ["v=DMARC1", null],
    ["v=DMARC1; p=", null],
    ["v=DMARC1; sp=reject", null],
  ];

  for (const [record, expected] of cases) {
    const result = await dmarcFor("example.com", { "_dmarc.example.com": [record] });
    assert.equal(result.status, "found", `${record} is still a record`);
    assert.equal(result.effectivePolicy, expected, record);
  }
});

test("every DMARC answer names the domain it describes", async () => {
  // No shape may leave appliesTo out, whatever happened during the lookup.
  const shapes = [
    await dmarcFor("example.com", { "_dmarc.example.com": ["v=DMARC1; p=reject"] }),
    await dmarcFor("shop.example.com", { "_dmarc.example.com": ["v=DMARC1; p=reject"] }),
    await dmarcFor("example.com", {}),
    await dmarcFor("example.com", { "_dmarc.example.com": "FAIL" }),
    await dmarcFor("shop.example.com", { "_dmarc.example.com": "FAIL" }),
    await checkDmarc("example.com", dmarcResolver({}).cache, createDeadline(0)),
  ];

  for (const shape of shapes) {
    assert.equal(typeof shape.appliesTo, "string");
    assert.ok(shape.appliesTo.length > 0);
    assert.equal(shape.inherited, shape.policyDomain !== null && shape.policyDomain !== shape.appliesTo);
  }
});
