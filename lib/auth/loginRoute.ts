/**
 * What the sign-in and sign-out endpoints decide.
 *
 * THE DECISIONS, NOT THE PLUMBING, exactly like every other route in this
 * project. `app/api/auth/login/route.ts` is glue: it reads a body, calls this,
 * and turns the answer into a response. Everything worth arguing about is
 * here, where a test can drive it with a plain `Request` and no server.
 *
 * NOTHING IN THIS FILE KNOWS HOW A PASSWORD IS CHECKED OR HOW A COOKIE IS
 * SIGNED. Those are `credentials.ts` and `session.ts`, and they stay separate
 * because the whole point of the design is that swapping the first for Google
 * Workspace later leaves the second, and this, untouched.
 */
import { signIn, VERIFICATION_RETRY_AFTER_SECONDS, type CredentialOptions } from "./credentials.ts";
import { callerAttribution, trustedCaller, trustsProxy as trustsProxyFlag } from "../callerAddress.ts";
import { logCallerReadOnce } from "../log/reliabilityLog.ts";
import { sessionCookieOptions, signSession, type SessionOptions } from "./session.ts";

/** Where a person goes after signing in, and where they are sent to sign in. */
export const AFTER_LOGIN = "/";
export const LOGIN_PATH = "/login";

/**
 * Said when the server cannot sign a session at all.
 *
 * DISTINCT FROM A WRONG PASSWORD, because it is not the person's fault and
 * nothing they type will fix it. It names no variable and no value; the server
 * knows which one is missing and the person at the keyboard does not need to.
 */
export const CANNOT_SIGN_IN =
  "Sign-in is not configured on this server. Nothing you typed was wrong.";

export interface LoginOptions extends SessionOptions, CredentialOptions {
  /**
   * Whether a trusted proxy sits in front, so its client-address header,
   * `CF-Connecting-IP`, may be believed. `X-Forwarded-For` and `X-Real-IP`
   * never are; see callerAddress.ts.
   *
   * FALSE BY DEFAULT, and that is the safe posture: reached directly, the only
   * source of that header is the client itself, and a client that rewrites it
   * on every request would otherwise be a new caller each time and never reach
   * a limit. Set the SKYBOOK_TRUST_PROXY environment variable only when the
   * deployment really does sit behind Cloudflare, which sets it.
   */
  readonly trustProxy?: boolean;
  /**
   * How the account slow-down waits. Injected by tests so none of them spends
   * real seconds; production waits with a timer.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

export { TRUST_PROXY_VARIABLE, normaliseCaller } from "../callerAddress.ts";

/** This route's own trust reading, from its options or the environment. */
function trustsProxy(options: LoginOptions): boolean {
  return trustsProxyFlag(options.trustProxy);
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What one sign-in attempt produced.
 *
 * THE COOKIE TRAVELS AS A VALUE RATHER THAN BEING SET HERE. Setting it needs
 * the framework's own cookie API, which is the adapter's business, and keeping
 * it out of this file is what lets the decision be tested without one.
 */
export type LoginOutcome =
  | { readonly ok: true; readonly email: string; readonly cookie: string; readonly maxAgeSeconds: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      /** Set only on a 503 for capacity: when the caller may try again, in seconds. */
      readonly retryAfterSeconds?: number;
    };

/** Only the two fields a sign-in form may send. Anything else is ignored. */
function submitted(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null) return { email: "", password: "" };

  const { email, password } = body as { email?: unknown; password?: unknown };
  return {
    email: typeof email === "string" ? email : "",
    password: typeof password === "string" ? password : "",
  };
}

/**
 * One attempt to sign in.
 *
 * THE PASSWORD IS READ ONCE AND NEVER LEAVES. It is not echoed in any answer,
 * not attached to any error, and not written anywhere. The only thing that
 * crosses back out of this function on success is the address and a cookie.
 *
 * A MALFORMED BODY IS A REFUSAL, NOT A CRASH. Something posting nonsense to
 * this endpoint gets the same sentence as somebody with the wrong password,
 * because it is the same amount of "no".
 */
export async function loginRoute(
  request: Request,
  options: LoginOptions = {},
  now: number = Date.now(),
): Promise<LoginOutcome> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const { email, password } = submitted(body);
  const caller = callerAddress(request, trustsProxy(options));

  const attempt = await signIn(email, password, caller, options, now);

  /*
   * THE SLOW-DOWN IS SPENT HERE, once, whatever the outcome. `signIn` decided
   * the number from the account's own recent failures and stays synchronous;
   * this is the only place a real wait happens, and it is injectable so a test
   * never sleeps. A right password waits exactly as a wrong one would during
   * an attack, so the pause reveals nothing about the guess.
   */
  await (options.sleep ?? realSleep)(attempt.delayMs);

  if (!attempt.ok) {
    /*
     * 429 for too many attempts, 401 for a wrong one, and 503 when the server
     * has no account configured. The last is genuinely the server's problem
     * and reporting it as a wrong password would send somebody hunting for a
     * typo that is not there.
     */
    /*
     * And 503 with a wait when the server has no room to check a password right
     * now: temporary, the same for every address, and nothing was checked.
     */
    if (attempt.reason === "busy") {
      return { ok: false, status: 503, error: attempt.message, retryAfterSeconds: VERIFICATION_RETRY_AFTER_SECONDS };
    }
    const status = attempt.reason === "rate-limited" ? 429 : attempt.reason === "not-configured" ? 503 : 401;
    return { ok: false, status, error: attempt.message };
  }

  const cookie = signSession(attempt.user.id, attempt.user.role, options, now);
  if (cookie === null) {
    /*
     * The password was right and this server still cannot issue a session. Not
     * the person's fault, and it must not read as one.
     */
    return { ok: false, status: 503, error: CANNOT_SIGN_IN };
  }

  /*
   * WAS THIS SIGN-IN ATTRIBUTED TO A CLIENT ADDRESS? Written only here, after a
   * correct password, so nobody without one can make a line appear; at most once
   * per answer per process; and as fixed words only -- never the address, the
   * header, the account or anything else this request carried.
   */
  const attribution = callerAttribution(request, trustsProxy(options));
  logCallerReadOnce(attribution.outcome, attribution.outcome === "unattributed" ? attribution.reason : undefined);

  return { ok: true, email: attempt.user.email, cookie, maxAgeSeconds: sessionCookieOptions().maxAge };
}

/**
 * Who is asking, for the failed-attempt counter only.
 *
 * THE SAME READING THE RATE LIMITER USES, and duplicated rather than imported
 * on purpose: importing it would tie the authentication module to the audit
 * limiter's file, and a later change to how audits identify a caller would
 * silently change how sign-in attempts are counted. Two small copies of four
 * lines is the cheaper mistake here than one shared one that couples them.
 *
 * A header the client sets cannot identify anybody honestly. It does not have
 * to: somebody who changes it on every request is a new caller every time and
 * never reaches the limit, which is why the limit is not the only defence. The
 * slow hash is, and it applies to every attempt regardless.
 */
/** Who is asking, read once for the whole application. See callerAddress.ts. */
export function callerAddress(request: Request, trustProxy: boolean): string {
  return trustedCaller(request, trustProxy);
}

/**
 * Signing out.
 *
 * THE COOKIE IS OVERWRITTEN WITH NOTHING AND AN IMMEDIATE EXPIRY, rather than
 * merely being forgotten by the server. There is no session store to delete a
 * row from, so the cookie IS the session, and the only way to end one early is
 * to replace it in the browser that holds it.
 *
 * IT TOUCHES NOTHING ELSE. No audit job, no stored result, no report. Somebody
 * signing out and back in finds their audits exactly where they left them,
 * because this never had anything to do with them.
 */
export function logoutRoute(): { readonly cookie: string; readonly maxAgeSeconds: number } {
  return { cookie: "", maxAgeSeconds: 0 };
}
