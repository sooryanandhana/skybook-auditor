import tls from "node:tls";
import type { PeerCertificate } from "node:tls";
import { checkHostnameIsPublic } from "./safety.ts";
import type { Deadline } from "./deadline.ts";
import type {
  CertificateProblem,
  HostnameMatch,
  SslCertificate,
  SslData,
  SslFailure,
} from "@/lib/types";

/**
 * Reads the certificate a website presents.
 *
 * This is a SITE-level check: a certificate does not change between the
 * homepage and the contact page, so it is run once per site rather than once
 * per page.
 *
 * The most useful thing it produces is days until expiry. When a certificate
 * expires, every visitor gets a full-page browser warning saying the site is
 * unsafe — and it is entirely preventable, usually happening because automatic
 * renewal broke quietly months earlier.
 */

/** The longest a single TLS connection may take. */
const CONNECT_TIMEOUT_MS = 8_000;

const HTTPS_PORT = 443;

export async function runSslChecks(
  hostname: string,
  servedOverHttps: boolean,
  deadline: Deadline,
): Promise<SslData> {
  const base = { hostname, certificate: null, trusted: null, problem: null } as const;

  if (!servedOverHttps) {
    return {
      ...base,
      status: "not-applicable",
      failure: null,
      message: "The site is not served over HTTPS, so it presents no certificate.",
    };
  }

  /*
   * The hostname came from whoever submitted the audit, and it is about to be
   * handed to a raw network socket. The same guard that protects the page
   * fetch applies here — a TLS connection to an internal address is the same
   * SSRF problem as an HTTP one.
   */
  const safety = await checkHostnameIsPublic(hostname);
  if (!safety.safe) {
    return {
      ...base,
      status: "blocked",
      failure: null,
      message: safety.reason,
    };
  }

  if (deadline.expired()) {
    return {
      ...base,
      status: "unreachable",
      failure: "timeout",
      message: "The audit ran out of time before the certificate could be checked.",
    };
  }

  const outcome = await connectAndRead(hostname, deadline);

  if (!outcome.ok) {
    return {
      ...base,
      status: "unreachable",
      failure: outcome.failure,
      message: outcome.message,
    };
  }

  const certificate = describeCertificate(outcome.certificate, hostname, outcome.protocol);

  return {
    hostname,
    status: "checked",
    certificate,
    trusted: outcome.authorized,
    problem: outcome.problem,
    failure: null,
    message: summarise(certificate, outcome.authorized, outcome.problem),
  };
}

// ---------------------------------------------------------------------------
// The TLS connection
// ---------------------------------------------------------------------------

type ConnectOutcome =
  | {
      ok: true;
      certificate: PeerCertificate;
      protocol: string | null;
      /** Whether the platform's own chain validation accepted it. */
      authorized: boolean;
      /** Why validation failed, if it did. */
      problem: CertificateProblem | null;
    }
  | { ok: false; failure: SslFailure; message: string };

function connectAndRead(hostname: string, deadline: Deadline): Promise<ConnectOutcome> {
  // Whichever is shorter: this connection's own cap, or what is left of the
  // audit's shared budget. A dead server must never hold the audit open.
  const timeout = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline.remainingMs()));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ConnectOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    const socket = tls.connect({
      host: hostname,
      port: HTTPS_PORT,
      // Send the hostname so the server presents the right certificate.
      // Without this a shared host returns its default one.
      servername: hostname,
      /*
       * DELIBERATE: we do not reject an invalid certificate, because an
       * invalid certificate is precisely what we want to be able to describe.
       * Rejecting would leave us saying "connection failed" instead of "it
       * expired three weeks ago".
       *
       * This is safe here because we only READ the certificate: no request is
       * sent, no data is received, and nothing about the connection is
       * trusted. The platform still tells us whether validation passed, via
       * `authorized` below, so we report the verdict without relying on it.
       */
      rejectUnauthorized: false,
      timeout,
    });

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate(false);
      const authorized = socket.authorized;
      const authError = socket.authorizationError as unknown;

      finish({
        ok: true,
        certificate,
        protocol: socket.getProtocol(),
        authorized,
        problem: authorized ? null : classifyAuthorizationError(authError),
      });
    });

    socket.once("timeout", () => {
      finish({
        ok: false,
        failure: "timeout",
        message: "The server took too long to complete a secure connection.",
      });
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(classifyConnectionFailure(error));
    });
  });
}

/** Turns a socket error into a machine-readable failure plus a sentence. */
export function classifyConnectionFailure(error: NodeJS.ErrnoException): {
  ok: false;
  failure: SslFailure;
  message: string;
} {
  switch (error?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return {
        ok: false,
        failure: "host-not-found",
        message: "That address could not be found.",
      };
    case "ECONNREFUSED":
      return {
        ok: false,
        failure: "connection-refused",
        message: "The server refused a secure connection on port 443.",
      };
    case "ETIMEDOUT":
      return {
        ok: false,
        failure: "timeout",
        message: "The server took too long to complete a secure connection.",
      };
    default:
      return {
        ok: false,
        failure: "handshake-failed",
        message: "A secure connection could not be established.",
      };
  }
}

/**
 * Names the reason chain validation failed.
 *
 * The same values the page fetch uses, so a certificate problem means the
 * same thing wherever it is reported.
 */
export function classifyAuthorizationError(error: unknown): CertificateProblem | null {
  const code =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";

  switch (code) {
    case "CERT_HAS_EXPIRED":
      return "expired";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "self-signed";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "HOSTNAME_MISMATCH":
      return "wrong-hostname";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_GET_ISSUER_CERT":
      return "untrusted";
    default:
      // Validation failed for a reason we do not have a name for. "untrusted"
      // is the honest umbrella: the chain was not accepted.
      return code ? "untrusted" : null;
  }
}

// ---------------------------------------------------------------------------
// Reading the certificate
// ---------------------------------------------------------------------------

/**
 * Turns the platform's certificate object into our own facts.
 *
 * Pure, so every case a real website will not conveniently provide — expiring
 * in three days, already expired, a wildcard that does not cover the domain —
 * can be tested directly.
 */
export function describeCertificate(
  certificate: Partial<PeerCertificate>,
  hostname: string,
  protocol: string | null,
  now: Date = new Date(),
): SslCertificate {
  const validFrom = parseCertificateDate(certificate.valid_from);
  const validTo = parseCertificateDate(certificate.valid_to);
  const subjectAltNames = parseSubjectAltNames(certificate.subjectaltname);

  // A certificate without SANs is old but legal; the subject name still counts.
  const names =
    subjectAltNames.length > 0 ? subjectAltNames : toNameList(certificate.subject?.CN);

  const match = matchHostname(hostname, names);

  return {
    validFrom: validFrom ? validFrom.toISOString() : null,
    validTo: validTo ? validTo.toISOString() : null,
    daysUntilExpiry: validTo ? daysBetween(now, validTo) : null,
    issuer: describeName(certificate.issuer),
    subject: describeName(certificate.subject),
    subjectAltNames,
    coversHostname: match !== "none",
    hostnameMatch: match,
    protocol,
  };
}

/** Certificate dates look like "Jan  1 00:00:00 2026 GMT". */
function parseCertificateDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Pulls the hostnames out of a Subject Alternative Name field.
 *
 * The field looks like "DNS:example.com, DNS:*.example.com, IP Address:1.2.3.4".
 * Only the DNS entries name hostnames.
 */
export function parseSubjectAltNames(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.toLowerCase().startsWith("dns:"))
    .map((entry) => entry.slice(4).trim())
    .filter((name) => name.length > 0);
}

/**
 * A certificate field may legally hold several values, so the platform types
 * these as string-or-array. Both are normalised to a plain list.
 */
function toNameList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry.length > 0);
}

/** A readable name from a certificate's subject or issuer fields. */
function describeName(name: PeerCertificate["subject"] | undefined): string | null {
  if (!name) return null;
  // Prefer the common name; fall back to the organisation.
  return toNameList(name.CN)[0] ?? toNameList(name.O)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Hostname matching
// ---------------------------------------------------------------------------

/**
 * Decides whether a certificate covers the hostname we audited.
 *
 * The rules are exact, never substring. A certificate for "notexample.com"
 * must not be treated as covering "example.com" just because one contains the
 * other — that would report a mismatched certificate as valid.
 *
 * A wildcard replaces EXACTLY ONE label:
 *   *.example.com  covers  www.example.com  and  api.example.com
 *   *.example.com  does NOT cover  example.com          (no label to replace)
 *   *.example.com  does NOT cover  a.b.example.com      (two labels)
 */
export function matchHostname(hostname: string, names: string[]): HostnameMatch {
  const target = normaliseHost(hostname);
  if (!target) return "none";

  let wildcardMatched = false;

  for (const name of names) {
    const candidate = normaliseHost(name);
    if (!candidate) continue;

    // An exact match is the strongest answer, so return as soon as one appears.
    if (candidate === target) return "exact";

    if (matchesWildcard(target, candidate)) wildcardMatched = true;
  }

  return wildcardMatched ? "wildcard" : "none";
}

function matchesWildcard(target: string, candidate: string): boolean {
  if (!candidate.startsWith("*.")) return false;

  const suffix = candidate.slice(2);
  // "*." on its own, or "*.com", covers nothing we should accept.
  if (suffix.length === 0 || !suffix.includes(".")) return false;

  // The target must end with ".suffix" — the leading dot matters, so that
  // "*.example.com" does not match "notexample.com".
  const tail = `.${suffix}`;
  if (!target.endsWith(tail)) return false;

  const label = target.slice(0, target.length - tail.length);

  // Exactly one label: not empty (that would be the bare domain), and with no
  // further dots (that would be a deeper subdomain).
  return label.length > 0 && !label.includes(".");
}

/** Lower-cases and drops a trailing dot, so comparisons are like-for-like. */
function normaliseHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** One sentence a person can read, derived only from what was measured. */
export function summarise(
  certificate: SslCertificate,
  trusted: boolean,
  problem: CertificateProblem | null,
): string {
  const parts: string[] = [];

  if (certificate.daysUntilExpiry === null) {
    parts.push("The certificate's expiry date could not be read.");
  } else if (certificate.daysUntilExpiry < 0) {
    const days = Math.abs(certificate.daysUntilExpiry);
    parts.push(`The certificate expired ${days} day${days === 1 ? "" : "s"} ago.`);
  } else {
    const days = certificate.daysUntilExpiry;
    parts.push(`The certificate expires in ${days} day${days === 1 ? "" : "s"}.`);
  }

  if (!certificate.coversHostname) {
    parts.push("It does not cover this address.");
  }

  if (!trusted && problem !== null) {
    parts.push(`Browsers will not trust it (${problem.replace(/-/g, " ")}).`);
  } else if (!trusted) {
    parts.push("Browsers will not trust it.");
  }

  return parts.join(" ");
}
