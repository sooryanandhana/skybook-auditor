/**
 * Who a request is from, for the rate limiters — and when that may be believed.
 *
 * ONE READING FOR THE WHOLE APPLICATION. The login limiter, the audit limiter
 * and the report-send limiter all have to answer "which caller is this?", and
 * they must answer it the same way. Three copies of the reading drifted once
 * already: a change to how one of them trusted a header would silently leave
 * the others open. So the reading lives here, and each limiter asks it.
 *
 * THE HEADERS ARE NOT BELIEVED BY DEFAULT. Reached directly, the only source of
 * `X-Forwarded-For` and `X-Real-IP` is the client itself, and a client that
 * rewrites them on every request would otherwise be a new caller each time and
 * never reach a limit. They are read only when the operator has declared, with
 * `SKYBOOK_TRUST_PROXY`, that a proxy in front really does set them.
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
 * Whether the forwarded client-address headers may be believed.
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

/**
 * The caller key for one request, given whether a proxy is trusted.
 *
 * Untrusted (the default): every request is `UNATTRIBUTED`, so a rotated header
 * cannot escape a limit by pretending to be a new caller. Trusted: the first
 * forwarded hop, normalised, so alternate spellings of one machine share a key
 * and a non-address falls back to `UNATTRIBUTED` rather than minting a bucket.
 */
export function trustedCaller(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return UNATTRIBUTED;

  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const raw = first || request.headers.get("x-real-ip")?.trim() || "";

  return normaliseCaller(raw) ?? UNATTRIBUTED;
}
