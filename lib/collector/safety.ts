import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Stops the app being used to reach places it shouldn't.
 *
 * THE PROBLEM (called SSRF — Server-Side Request Forgery):
 * Our server fetches whatever address a user types. Without a guard, someone
 * could type an address that points *inside* a private network — a router at
 * 192.168.1.1, a database on 10.0.0.5, or a cloud server's internal settings
 * at 169.254.169.254 — and our server would happily fetch it and show them
 * the result. They'd be using our server as a window into a network they
 * can't otherwise reach.
 *
 * THE FIX:
 * Before fetching, look up which actual IP address a hostname points to, and
 * refuse if that address is private, internal, or otherwise not a public
 * website. We must check the *resolved address*, not the text of the URL —
 * a domain name can be made to point anywhere, including 127.0.0.1.
 */

/** Whether an address is safe to fetch, and why not if it isn't. */
export type SafetyResult =
  | { safe: true; addresses: string[] }
  | { safe: false; reason: string };

/**
 * Releases a response body we have received but will not read.
 *
 * Node's fetch (undici) keeps a response's connection open until its body is
 * consumed or cancelled. The paths that read a body drain it; every path that
 * abandons a received response — a redirect we follow, an error status, a type
 * we will not parse — must cancel it here instead, or the socket is held open.
 *
 * Cancelling a body that was already read, already cancelled, or locked to a
 * reader is a harmless no-op, so this is always safe to call on a response the
 * code is finished with.
 */
export async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body already consumed, already cancelled, or locked to a reader cannot
    // be cancelled again — and in each case nothing is left open.
  }
}

/**
 * IPv4 ranges that are not public internet addresses.
 * Written as [first byte, matcher] for readability.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // unparseable — treat as unsafe
  }
  const [a, b, c] = parts;

  return (
    a === 0 || // 0.0.0.0/8      "this network"
    a === 10 || // 10.0.0.0/8     private
    a === 127 || // 127.0.0.0/8    loopback (this machine)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10  carrier-grade NAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12  private
    // 192.0.0.0/24 (protocol assignments) and 192.0.2.0/24 (documentation).
    // The third octet matters: IANA reserves only these two /24s inside
    // 192.0.0.0/16, so 192.0.43.x (icann.org) and the rest are ordinary,
    // routable, auditable address space. Blocking the whole /16 refused them.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15  benchmarking
    a >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  );
}

/**
 * Parses a valid IPv6 address into its eight 16-bit groups.
 *
 * WHY NUMBERS, NOT STRINGS. The same address has many spellings -- "::1" and
 * "0:0:0:0:0:0:0:1" are one address, "::ffff:127.0.0.1" and "::ffff:7f00:1"
 * are another -- and a check that compares text has to know every spelling in
 * advance. Reduced to sixteen bytes there is only one of each, so the range
 * checks below decide on what the address IS rather than how it was written.
 *
 * The input has already passed `isIP` as an IPv6 address, so this handles the
 * `::` zero-run and an optional trailing dotted-quad; anything it cannot make
 * sense of returns null, and the caller then errs towards "private".
 */
function parseIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();

  // A trailing IPv4 tail ("::ffff:127.0.0.1") is the low 32 bits. Turn it into
  // two hex groups so the whole address is groups of 16 bits.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const octets = tail[1].split(".").map(Number);
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = octets;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = text.slice(0, tail.index) + `${high}:${low}`;
  }

  // Expand the single "::" zero-run, if there is one, to the missing groups.
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] === "" ? [] : halves[0].split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : null;

  let groups: string[];
  if (rest === null) {
    groups = head; // no "::", so it must be the full eight
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  }

  if (groups.length !== 8) return null;

  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return values.some((value) => Number.isNaN(value)) ? null : values;
}

/** IPv6 equivalents of the private-IPv4 ranges, decided on the parsed bytes. */
function isPrivateIPv6(ip: string): boolean {
  const groups = parseIpv6(ip);
  if (groups === null) return true; // unparseable -- treat as unsafe

  // An IPv4 address wearing an IPv6 costume: ::ffff:0:0/96. Judge the embedded
  // IPv4 by the IPv4 rules, whatever spelling it arrived in.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] >> 8;
    const b = groups[6] & 0xff;
    const c = groups[7] >> 8;
    const d = groups[7] & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // ::   unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback

  const prefix = groups[0];
  return (
    (prefix & 0xfe00) === 0xfc00 || // fc00::/7  unique local
    (prefix & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (prefix & 0xff00) === 0xff00 // ff00::/8  multicast
  );
}

/**
 * True if this IP address belongs to the public internet.
 *
 * Anything that isn't a valid IP address at all is refused. That matters:
 * treating an unrecognised value as "not private, therefore public" would
 * mean any parsing gap becomes a way past the check. When in doubt, refuse.
 */
export function isPublicAddress(ip: string): boolean {
  switch (isIP(ip)) {
    case 4:
      return !isPrivateIPv4(ip);
    case 6:
      return !isPrivateIPv6(ip);
    default:
      return false; // not an IP address we understand
  }
}

/**
 * Checks that a hostname points somewhere on the public internet.
 *
 * A hostname can resolve to several addresses. ALL of them must be public —
 * if any one is private, we refuse, since we can't control which the network
 * would actually connect to.
 */
export async function checkHostnameIsPublic(hostname: string): Promise<SafetyResult> {
  let resolved: { address: string }[];

  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: "That website address could not be found." };
  }

  if (resolved.length === 0) {
    return { safe: false, reason: "That website address could not be found." };
  }

  const addresses = resolved.map((entry) => entry.address);
  const blocked = addresses.filter((address) => !isPublicAddress(address));

  if (blocked.length > 0) {
    return {
      safe: false,
      reason: "That address points to a private or internal network, so it can't be audited.",
    };
  }

  return { safe: true, addresses };
}

/**
 * Fetches a URL, re-checking safety at every redirect.
 *
 * WHY THIS EXISTS: passing `redirect: "follow"` to fetch lets the server
 * decide where we end up. A site can answer any request with "actually, go
 * look at http://192.168.1.1" and fetch will quietly do it. Checking only the
 * address we started with is therefore not enough — every hop needs checking.
 *
 * Use this for ANY request to an address influenced by the audited site.
 * Never call fetch directly with `redirect: "follow"` on such a URL.
 *
 * Returns null if the address is unsafe or the request fails.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response | null> {
  const { maxRedirects = 3, ...requestInit } = init;

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") return null;

    const safety = await checkHostnameIsPublic(current.hostname);
    if (!safety.safe) return null;

    let response: Response;
    try {
      response = await fetch(current, { ...requestInit, redirect: "manual" });
    } catch {
      return null;
    }

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    // This redirect's body is not returned to the caller; release it before we
    // follow or abandon the hop, so its connection is not left open.
    await releaseBody(response);

    try {
      current = new URL(location, current);
    } catch {
      return null;
    }
  }

  return null; // too many redirects
}

/*
 * A known limitation, stated honestly:
 *
 * We check the address here, then fetch a moment later — and the fetch does
 * its own lookup. A hostile DNS server could answer differently the second
 * time (a trick called "DNS rebinding") and slip past this check.
 *
 * Closing that gap means connecting to the verified IP directly instead of
 * re-resolving, which is significantly more involved. For a tool auditing
 * public websites from inside the company, this check covers the realistic
 * risk. Worth revisiting if this is ever exposed to the open internet.
 */
