import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

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
 * IPv4 ranges that are not public internet addresses.
 * Written as [first byte, matcher] for readability.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // unparseable — treat as unsafe
  }
  const [a, b] = parts;

  return (
    a === 0 || // 0.0.0.0/8      "this network"
    a === 10 || // 10.0.0.0/8     private
    a === 127 || // 127.0.0.0/8    loopback (this machine)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10  carrier-grade NAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12  private
    (a === 192 && b === 0) || // 192.0.0.0/24   protocol assignments
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15  benchmarking
    a >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  );
}

/** IPv6 equivalents of the above. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Some systems report IPv4 addresses in IPv6 form, e.g. "::ffff:127.0.0.1".
  // Unwrap those and check the IPv4 rules instead.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  if (lower === "::" || lower === "::1") return true; // unspecified / loopback

  const firstGroup = lower.split(":")[0];
  const prefix = parseInt(firstGroup || "0", 16);

  return (
    (prefix & 0xfe00) === 0xfc00 || // fc00::/7  unique local
    (prefix & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (prefix & 0xff00) === 0xff00 // ff00::/8  multicast
  );
}

/** True if this IP address belongs to the public internet. */
export function isPublicAddress(ip: string): boolean {
  return isIPv4(ip) ? !isPrivateIPv4(ip) : !isPrivateIPv6(ip);
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
