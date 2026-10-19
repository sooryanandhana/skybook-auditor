/**
 * Who a request is from, for the rate limiters — and when that may be believed.
 *
 * ONE READING FOR THE WHOLE APPLICATION. The login limiter, the audit limiter
 * and the report-send limiter all have to answer "which caller is this?", and
 * they must answer it the same way. Three copies of the reading drifted once
 * already: a change to how one of them trusted a header would silently leave
 * the others open. So the reading lives here, and each limiter asks it.
 *
 * NO HEADER IS BELIEVED BY DEFAULT. Reached directly, every client-address
 * header is the client's own word, and a client that rewrites one on every
 * request would otherwise be a new caller each time and never reach a limit.
 * A header is read only when the operator has declared, with
 * `SKYBOOK_TRUST_PROXY`, that a proxy in front really does set it.
 *
 * WHICH HEADER, WHEN TRUSTED: `CF-Connecting-IP`, AND ONLY THAT ONE. Render
 * sends every request through Cloudflare, and Cloudflare documents that it
 * APPENDS to an `X-Forwarded-For` the client already sent rather than
 * replacing it -- so the first entry of that header is whatever the client
 * chose. `CF-Connecting-IP` is one address that Cloudflare sets itself.
 * `X-Forwarded-For` and `X-Real-IP` are never read, not even as a fallback,
 * because a fallback is exactly where a forged value would get back in.
 *
 * NOT YET VERIFIED ON THE LIVE SERVICE. That Cloudflare sets or refuses a
 * client-supplied `CF-Connecting-IP` on the route to this deployment comes
 * from documentation and third-party tests, not from observing production.
 * Until it is checked there, the per-caller limits are not a proven control;
 * the global ceilings are the limits that hold whatever any header says.
 */
import { isIP } from "node:net";

/**
 * The caller key used when a request cannot be attributed to a real client.
 *
 * A SINGLE SHARED BUCKET, never a fresh one per header value. Without a trusted
 * proxy the app cannot see a client address, and the headers that claim one are
 * the client's own — so every unattributed request is counted together rather
 * than being allowed to look like a thousand different callers.
 */
export const UNATTRIBUTED = "unattributed";

/** The environment's answer to "is a trusted proxy in front of us?". */
export const TRUST_PROXY_VARIABLE = "SKYBOOK_TRUST_PROXY";

/**
 * Whether the proxy's client-address header may be believed.
 *
 * An explicit boolean wins, so a caller (or a test) can force either posture;
 * otherwise the environment decides, and the safe default when it says nothing
 * is not to trust them.
 */
export function trustsProxy(trustProxy?: boolean): boolean {
  if (trustProxy !== undefined) return trustProxy;
  const value = (process.env[TRUST_PROXY_VARIABLE] ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * One address in a single canonical form, or null when it is not an address.
 *
 * WHY IT IS NORMALISED. The same machine can be written many ways --
 * `127.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1` --
 * and a limit keyed on the raw text counts each spelling as a separate caller,
 * so one attacker becomes ten. `isIP` also rejects anything that is not an
 * address, so a header full of junk strings cannot mint a fresh bucket per
 * request either; that request is treated as unattributed instead.
 */
export function normaliseCaller(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (isIP(value) === 0) return null;

  // An IPv4-mapped IPv6 address is the IPv4 address; unwrap it so the two
  // spellings share one bucket. Both dotted (::ffff:127.0.0.1) and hex
  // (::ffff:7f00:1) forms are handled by parsing the trailing 32 bits.
  const mapped = value.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return tail;
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    }
  }

  return value;
}

/** The one header read behind a trusted proxy. See the note at the top. */
export const CLIENT_ADDRESS_HEADER = "cf-connecting-ip";

/**
 * The longest header value that is even looked at.
 *
 * 45 characters is the longest textual IP address there is -- an IPv6 address
 * with an embedded IPv4 tail, `ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`
 * -- so anything longer cannot be one address and is refused before parsing.
 */
export const MAX_CLIENT_ADDRESS_LENGTH = 45;

/**
 * The caller key for one request, given whether a proxy is trusted.
 *
 * Untrusted (the default): every request is `UNATTRIBUTED`, whatever headers
 * it carries, so a rotated header cannot escape a limit by pretending to be a
 * new caller. Trusted: the single `CF-Connecting-IP` value, normalised, so
 * alternate spellings of one machine share a key. A value that is missing,
 * empty, too long, holds more than one entry (a client that sends the header
 * twice arrives here comma-joined) or is not an address falls back to
 * `UNATTRIBUTED` rather than minting a bucket -- and never to another header.
 */
export function trustedCaller(request: Request, trustProxy: boolean): string {
  const read = readCaller(request, trustProxy);
  return "caller" in read ? read.caller : UNATTRIBUTED;
}

/** Why a request was not attributed. A fixed word, never anything the request sent. */
export type UnattributedReason =
  | "proxy-not-trusted"
  | "missing"
  | "empty"
  | "multiple"
  | "too-long"
  | "not-an-address";

/**
 * Whether a request was attributed, and if not, why -- WITHOUT the address.
 *
 * FOR A DIAGNOSTIC THAT MUST NOT LEAK. It answers from the very same reading as
 * `trustedCaller`, so the two cannot disagree, but what it hands back holds only
 * fixed words: never the address, the header or anything else the request sent.
 */
export type CallerAttribution =
  | { readonly outcome: "attributed" }
  | { readonly outcome: "unattributed"; readonly reason: UnattributedReason };

export function callerAttribution(request: Request, trustProxy: boolean): CallerAttribution {
  const read = readCaller(request, trustProxy);
  return "caller" in read ? { outcome: "attributed" } : { outcome: "unattributed", reason: read.reason };
}

/**
 * The one reading behind both functions above: the normalised address, or the
 * reason there is none. Checked in the order `trustedCaller` always checked it.
 */
function readCaller(
  request: Request,
  trustProxy: boolean,
): { readonly caller: string } | { readonly reason: UnattributedReason } {
  if (!trustProxy) return { reason: "proxy-not-trusted" };

  const raw = request.headers.get(CLIENT_ADDRESS_HEADER);
  if (raw === null) return { reason: "missing" };
  if (raw.length > MAX_CLIENT_ADDRESS_LENGTH) return { reason: "too-long" };
  if (raw.includes(",")) return { reason: "multiple" };

  const caller = normaliseCaller(raw);
  if (caller !== null) return { caller };
  return { reason: raw.trim() === "" ? "empty" : "not-an-address" };
}
