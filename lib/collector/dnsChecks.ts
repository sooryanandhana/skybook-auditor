import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "./safety.ts";
import type { Deadline } from "./deadline.ts";
import type { DnsData, DnsRecordSet, EmailPolicyRecord, MxRecord } from "@/lib/types";

/**
 * Looks up a domain's DNS records.
 *
 * DNS is the internet's address book: it turns a name people type into the
 * address a computer connects to. Because it is invisible when working, it is
 * a common place for quiet, expensive mistakes.
 *
 * This is a SITE-level check — a domain's records do not change between its
 * pages — so Phase 4 runs it once and shares the result across every page.
 *
 * THE RULE THAT MATTERS MOST: a lookup that failed is not evidence a record is
 * missing. Reporting a timeout as "this domain has no SPF record" would invent
 * a security finding out of our own network trouble.
 */

/** How long any single lookup may take. */
const LOOKUP_TIMEOUT_MS = 4_000;

/**
 * Error codes that mean the answer is genuinely "there is no such record".
 *
 * Everything else — a timeout, a refused query, a server failure — means we
 * did not find out, which is a different thing entirely.
 */
const MEANS_NO_RECORD = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * The domain that mail and zone records belong to.
 *
 * A site served from "www.example.com" is very often just a CDN alias with no
 * records of its own, while the mail policy sits on "example.com". Looking
 * only at the www name would report "no SPF record" for a domain that has one
 * — a false security finding, which is worse than no finding at all.
 *
 * Only a leading "www." is removed. Going further would need the public
 * suffix list to know that "bbc.co.uk" is a domain while "co.uk" is not, and
 * for any other subdomain the subdomain itself is the sensible thing to check.
 */
export function emailDomainFor(hostname: string): string {
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  const withoutWww = name.replace(/^www\./, "");
  // Never reduce a name to something with no dot left in it.
  return withoutWww.includes(".") ? withoutWww : name;
}

export async function runDnsChecks(hostname: string, deadline: Deadline): Promise<DnsData> {
  const emailDomain = emailDomainFor(hostname);
  const dmarcHostname = `_dmarc.${emailDomain}`;

  if (deadline.expired()) {
    return allUnknown(hostname, emailDomain, dmarcHostname, "The audit ran out of time.");
  }

  const resolver = makeResolver();

  /*
   * The hostname came from whoever submitted the audit. It has already passed
   * the safety check before the page was fetched, but that check is repeated
   * here rather than assumed: this module can be called on its own, and Phase 4
   * will call it independently of any page fetch.
   */
  const safety = await checkDnsNameIsSafe(hostname, resolver);
  if (!safety.safe) {
    return allUnknown(hostname, emailDomain, dmarcHostname, safety.reason);
  }

  /*
   * The email domain is a DIFFERENT name derived from user input, so it gets
   * its own safety check rather than inheriting the site hostname's result.
   */
  const emailSafety =
    emailDomain === hostname ? safety : await checkDnsNameIsSafe(emailDomain, resolver);
  if (!emailSafety.safe) {
    return allUnknown(hostname, emailDomain, dmarcHostname, emailSafety.reason);
  }

  // Read TXT chunks back into whole records; a long record is split across
  // several strings on the wire.
  const readTxt = (name: string) => async () =>
    (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));

  // Run the lookups together: they are independent, and doing them one after
  // another would spend the budget several times over.
  const [a, aaaa, mx, ns, txt] = await Promise.all([
    // Address records belong to the host actually serving the site.
    lookup(() => resolver.resolve4(hostname), deadline),
    lookup(() => resolver.resolve6(hostname), deadline),
    // Mail and zone records belong to the domain, not the www alias.
    lookup<MxRecord>(
      async () =>
        (await resolver.resolveMx(emailDomain)).map((entry) => ({
          exchange: entry.exchange,
          priority: entry.priority,
        })),
      deadline,
    ),
    lookup(() => resolver.resolveNs(emailDomain), deadline),
    lookup(readTxt(emailDomain), deadline),
  ]);

  return {
    hostname,
    emailDomain,
    a,
    aaaa,
    mx,
    ns,
    txt,
    spf: extractSpf(txt),
    dmarc: await checkDmarc(dmarcHostname, resolver, deadline),
  };
}

/** A resolver with its own timeout, so a silent DNS server cannot hang us. */
function makeResolver(): Resolver {
  return new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 });
}

// ---------------------------------------------------------------------------
// Safety, for a DNS query rather than a connection
// ---------------------------------------------------------------------------

/** The most a DNS name may be, per the protocol. */
const MAX_NAME_LENGTH = 253;

/**
 * Characters a DNS name may contain.
 *
 * Underscores are allowed because service names legitimately use them —
 * `_dmarc` is exactly such a name. Anything outside this set is refused rather
 * than passed to a resolver.
 */
const VALID_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i;

/**
 * Whether a name is safe to ASK DNS about.
 *
 * This is deliberately not the same check the page fetch uses, because the
 * operations differ. Fetching opens a socket to the address a name resolves
 * to, so an address that turns out to be private is the danger. A DNS query
 * opens no socket to the name at all — it asks a resolver about it.
 *
 * That distinction matters in practice: a DMARC name holds only a TXT record
 * and has NO address, so requiring one would refuse every DMARC lookup ever
 * made. The rules that do apply:
 *
 *   1. The name must be a well-formed DNS name of sane length. It is built
 *      from user input and is about to be handed to a resolver.
 *   2. If the name DOES resolve to addresses, those must be public — so a
 *      name deliberately pointed at a private host is still refused.
 *   3. A name with no address is fine, because nothing will connect to it.
 */
export async function checkDnsNameIsSafe(
  hostname: string,
  resolver: Resolver,
): Promise<{ safe: true } | { safe: false; reason: string }> {
  const name = hostname.trim();

  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { safe: false, reason: "That address is not a usable domain name." };
  }

  if (!VALID_NAME.test(name)) {
    return { safe: false, reason: "That address is not a usable domain name." };
  }

  // An address written directly is checked as an address.
  if (isIP(name)) {
    return isPublicAddress(name)
      ? { safe: true }
      : {
          safe: false,
          reason: "That address points to a private or internal network, so it can't be audited.",
        };
  }

  // Where the name does have addresses, every one must be public.
  const addresses = [
    ...(await resolver.resolve4(name).catch(() => [])),
    ...(await resolver.resolve6(name).catch(() => [])),
  ];

  const privateAddress = addresses.find((address) => !isPublicAddress(address));
  if (privateAddress) {
    return {
      safe: false,
      reason: "That address points to a private or internal network, so it can't be audited.",
    };
  }

  return { safe: true };
}

// ---------------------------------------------------------------------------
// Running one lookup
// ---------------------------------------------------------------------------

/**
 * Runs one lookup and classifies the outcome.
 *
 * Three outcomes, deliberately distinct:
 *   found  — records came back
 *   absent — the server answered, and there are none
 *   error  — we did not find out
 */
async function lookup<T>(
  run: () => Promise<T[]>,
  deadline: Deadline,
): Promise<DnsRecordSet<T>> {
  if (deadline.expired()) {
    return { status: "error", records: [], error: "The audit ran out of time." };
  }

  try {
    const records = await run();
    // An empty answer is the same as no record: the server replied, and there
    // is nothing there.
    if (records.length === 0) return { status: "absent", records: [], error: null };
    return { status: "found", records, error: null };
  } catch (error) {
    return classifyDnsError(error);
  }
}

/**
 * Decides whether a failed lookup means "no record" or "we could not tell".
 *
 * Getting this backwards is the failure this module exists to avoid: a
 * timeout reported as "no SPF record" would tell a client they have an email
 * security hole they may not have.
 */
export function classifyDnsError<T>(error: unknown): DnsRecordSet<T> {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  if (MEANS_NO_RECORD.has(code)) {
    return { status: "absent", records: [], error: null };
  }

  return {
    status: "error",
    records: [],
    error: code ? `The lookup failed (${code}).` : "The lookup failed.",
  };
}

// ---------------------------------------------------------------------------
// SPF
// ---------------------------------------------------------------------------

/**
 * Finds the SPF record among a domain's TXT records.
 *
 * An SPF record BEGINS with "v=spf1". Searching for "spf" anywhere in the text
 * would match unrelated records that merely mention it — a note about SPF is
 * not an SPF policy.
 *
 * When the TXT lookup itself failed we cannot say whether SPF exists, so that
 * uncertainty is carried through rather than being flattened into "absent".
 */
export function extractSpf(txt: DnsRecordSet<string>): EmailPolicyRecord {
  if (txt.status === "error") {
    return { status: "error", record: null, error: txt.error };
  }

  const spf = txt.records.find((record) => record.trim().toLowerCase().startsWith("v=spf1"));

  return spf
    ? { status: "found", record: spf.trim(), error: null }
    : { status: "absent", record: null, error: null };
}

// ---------------------------------------------------------------------------
// DMARC
// ---------------------------------------------------------------------------

/**
 * Looks up DMARC, which lives at its own hostname rather than in the domain's
 * TXT records.
 *
 * SECURITY: `_dmarc.<domain>` is a NEW hostname built from user input, so it
 * gets its own safety check. The original domain passing does not make the
 * derived one safe — they are different names and can resolve to different
 * addresses entirely.
 */
async function checkDmarc(
  dmarcHostname: string,
  resolver: Resolver,
  deadline: Deadline,
): Promise<DnsData["dmarc"]> {
  const safety = await checkDnsNameIsSafe(dmarcHostname, resolver);
  if (!safety.safe) {
    return { hostname: dmarcHostname, status: "error", record: null, error: safety.reason };
  }

  const txt = await lookup(
    async () => (await resolver.resolveTxt(dmarcHostname)).map((chunks) => chunks.join("")),
    deadline,
  );

  if (txt.status === "error") {
    return { hostname: dmarcHostname, status: "error", record: null, error: txt.error };
  }

  // Same rule as SPF: a DMARC record begins with "v=DMARC1".
  const dmarc = txt.records.find((record) => record.trim().toLowerCase().startsWith("v=dmarc1"));

  return dmarc
    ? { hostname: dmarcHostname, status: "found", record: dmarc.trim(), error: null }
    : { hostname: dmarcHostname, status: "absent", record: null, error: null };
}

// ---------------------------------------------------------------------------
// When nothing could be looked up
// ---------------------------------------------------------------------------

/**
 * Every record marked as unknown.
 *
 * Used when the domain was refused or there was no time — never "absent",
 * because we did not look.
 */
function allUnknown(
  hostname: string,
  emailDomain: string,
  dmarcHostname: string,
  reason: string,
): DnsData {
  const unknown = <T>(): DnsRecordSet<T> => ({ status: "error", records: [], error: reason });

  return {
    hostname,
    emailDomain,
    a: unknown(),
    aaaa: unknown(),
    mx: unknown(),
    ns: unknown(),
    txt: unknown(),
    spf: { status: "error", record: null, error: reason },
    dmarc: { hostname: dmarcHostname, status: "error", record: null, error: reason },
  };
}
