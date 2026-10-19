/**
 * Tests for the two request-level protections on signing in and out:
 *
 *   - a sign-in must be declared as JSON. Anything else -- including `text/plain`
 *     whose text happens to be JSON, which a form on any other site can post --
 *     is refused with 415 before a caller is read, a database is touched, a
 *     password is checked or a failure is counted;
 *   - a sign-out a browser marks as coming from another site is refused, and the
 *     session cookie is left alone. Same-origin requests, and requests without
 *     the header at all, still sign out.
 *
 * The functions are tested directly, and the two route files are run for real
 * through a resolve hook (the same one `routeOwnership.test.mts` uses), so the
 * status codes and the presence or absence of a Set-Cookie header are what a
 * browser would actually receive. Fake accounts and passwords only; no network.
 */
import { register } from "node:module";
import { strict as assert } from "node:assert";
import test, { beforeEach } from "node:test";

const ROOT = new URL("../../", import.meta.url).href;
const HOOKS = `
  const ROOT = ${JSON.stringify(ROOT)};
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) return { url: ROOT + specifier.slice(2) + ".ts", shortCircuit: true };
    if (specifier === "next/server") return next("next/server.js", context);
    return next(specifier, context);
  }
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

const {
  CROSS_SITE_LOGOUT,
  UNSUPPORTED_MEDIA_TYPE,
  isJsonRequest,
  loginRoute,
  logoutRoute,
} = await import("./loginRoute.ts");
const { hashPassword, resetAttempts, trackedFailureCounts, verificationLoad } = await import("./credentials.ts");
const { SESSION_COOKIE } = await import("./session.ts");
const { captureLog } = await import("../log/captureLog.fixture.mts");
const { resetLoggedOnce } = await import("../log/reliabilityLog.ts");
const loginAdapter = await import("../../app/api/auth/login/route.ts");
const logoutAdapter = await import("../../app/api/auth/logout/route.ts");

const NOW = 1_757_000_000_000;
const PASSWORD = "a-fake-password-for-this-test-only";
const EMAIL = "sam@skybook.example";
const ACTIVE_USER = {
  id: "c0ffee00-0000-4000-8000-00000000c0de",
  email: EMAIL,
  password_hash: await hashPassword(PASSWORD),
  role: "SALES",
  status: "ACTIVE",
  created_at: new Date(NOW),
  updated_at: new Date(NOW),
  approved_by: null,
  approved_at: null,
  last_login_at: null,
  must_change_password: false,
};

/** A fake database that counts every query, so "no lookup happened" can be asserted. */
function countingDb() {
  const state = { queries: 0 };
  return {
    state,
    db: {
      async query(sql: string, params: unknown[] = []) {
        state.queries += 1;
        if (/^\s*SELECT/i.test(sql)) return { rows: String(params[0] ?? "") === EMAIL ? [ACTIVE_USER] : [] };
        return { rows: [] };
      },
    },
  };
}

const optionsWith = (db: unknown) => ({
  db: db as never,
  secret: "test-secret-that-is-long-enough-to-be-accepted-0123456789",
  sleep: async () => {},
  trustProxy: true,
});

const jsonBody = (password = PASSWORD) => JSON.stringify({ email: EMAIL, password });

function loginRequest(contentType: string | null, body: string) {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.7", origin: "https://attacker.example" });
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request("https://skybook.example/api/auth/login", { method: "POST", headers, body });
}

beforeEach(() => {
  resetAttempts();
  resetLoggedOnce();
});

/* ---------------------------------------------------------------------------
   Sign-in must be JSON
   --------------------------------------------------------------------------- */

test("the media type check accepts application/json in any case, with parameters", () => {
  for (const type of [
    "application/json",
    "application/json; charset=utf-8",
    "Application/JSON",
    "APPLICATION/JSON ; charset=UTF-8",
    "  application/json  ",
  ]) {
    assert.equal(isJsonRequest(loginRequest(type, "{}")), true, type);
  }
});

test("the media type check refuses everything else, including a missing header", () => {
  for (const type of [
    null,
    "text/plain",
    "text/plain; charset=utf-8",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=b",
    "text/json",
    "application/jsonx",
    "application/json-patch+json",
    "application/ld+json",
    "",
  ]) {
    assert.equal(isJsonRequest(loginRequest(type, "{}")), false, String(type));
  }
});

test("a sign-in not declared as JSON is refused with 415 before any authentication work", async () => {
  const { state, db } = countingDb();
  const textPlainJson = `{"email":"${EMAIL}","password":"${PASSWORD}","x":"="}`;
  const refused: Array<[string | null, string]> = [
    ["text/plain", textPlainJson],
    ["application/x-www-form-urlencoded", `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`],
    ["multipart/form-data; boundary=b", `--b\r\nContent-Disposition: form-data; name="email"\r\n\r\n${EMAIL}\r\n--b--`],
    [null, jsonBody()],
  ];

  const captured = await captureLog(async () => {
    for (const [type, body] of refused) {
      const outcome = await loginRoute(loginRequest(type, body), optionsWith(db), NOW);
      assert.deepEqual(outcome, { ok: false, status: 415, error: UNSUPPORTED_MEDIA_TYPE }, String(type));
    }
  });

  assert.equal(state.queries, 0, "no account was looked up, so no password was checked");
  assert.deepEqual(trackedFailureCounts(), { callers: 0, accounts: 0, spray: 0 }, "no failure was counted");
  assert.deepEqual(verificationLoad(), { active: 0, waiting: 0 }, "no verification place was taken");
  assert.equal(captured.all.length, 0, "nothing was logged");
});

test("JSON with a charset or different capitals still signs in", async () => {
  for (const type of ["application/json; charset=utf-8", "Application/JSON", "APPLICATION/JSON ; charset=UTF-8"]) {
    resetAttempts();
    const outcome = await loginRoute(loginRequest(type, jsonBody()), optionsWith(countingDb().db), NOW);
    assert.equal(outcome.ok, true, type);
  }
});

test("declared-JSON requests keep their existing answers", async () => {
  const { db } = countingDb();

  const wrong = await loginRoute(loginRequest("application/json", jsonBody("wrong-password")), optionsWith(db), NOW);
  assert.equal(wrong.ok === false && wrong.status, 401, "a wrong password is still 401");

  const malformed = await loginRoute(loginRequest("application/json", "{not json"), optionsWith(db), NOW);
  assert.equal(malformed.ok === false && malformed.status, 401, "malformed JSON is still refused as a failed sign-in");

  resetAttempts();
  for (let i = 0; i < 10; i += 1) {
    await loginRoute(loginRequest("application/json", jsonBody("wrong-password")), optionsWith(db), NOW);
  }
  const locked = await loginRoute(loginRequest("application/json", jsonBody()), optionsWith(db), NOW);
  assert.equal(locked.ok === false && locked.status, 429, "the per-caller lock is still 429");

  const broken = { async query() { throw new Error("connection refused"); } };
  resetAttempts();
  const outage = await loginRoute(loginRequest("application/json", jsonBody()), optionsWith(broken), NOW);
  assert.equal(outage.ok === false && outage.status, 503, "a database failure is still 503");
});

test("the login route file answers 415 and sets no cookie for a non-JSON sign-in", async () => {
  const response = await loginAdapter.POST(loginRequest("text/plain", `{"email":"${EMAIL}","password":"${PASSWORD}"}`));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { ok: false, error: UNSUPPORTED_MEDIA_TYPE });
  assert.equal(response.headers.get("set-cookie"), null);
});

/* ---------------------------------------------------------------------------
   Sign-out from this application only
   --------------------------------------------------------------------------- */

const logoutRequest = (site: string | null) => {
  const headers = new Headers();
  if (site !== null) headers.set("sec-fetch-site", site);
  return new Request("https://skybook.example/api/auth/logout", { method: "POST", headers });
};

test("a sign-out from another site is refused", () => {
  for (const site of ["cross-site", "same-site", "something-else"]) {
    assert.deepEqual(logoutRoute(logoutRequest(site)), { ok: false, status: 403, error: CROSS_SITE_LOGOUT }, site);
  }
});

test("a same-origin sign-out, a user-initiated one, and one without the header all sign out", () => {
  for (const site of ["same-origin", "none", null]) {
    assert.deepEqual(logoutRoute(logoutRequest(site)), { ok: true, cookie: "", maxAgeSeconds: 0 }, String(site));
  }
});

test("the logout route file leaves the cookie alone when it refuses, and clears it when it does not", async () => {
  const refused = await logoutAdapter.POST(logoutRequest("cross-site"));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { ok: false, error: CROSS_SITE_LOGOUT });
  assert.equal(refused.headers.get("set-cookie"), null, "no Set-Cookie: the session is untouched");

  for (const site of ["same-origin", null]) {
    const allowed = await logoutAdapter.POST(logoutRequest(site));
    assert.equal(allowed.status, 200, String(site));
    assert.deepEqual(await allowed.json(), { ok: true, next: "/login" });
    const cookie = allowed.headers.get("set-cookie") ?? "";
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=;`), `the session cookie is emptied (${String(site)})`);
    assert.match(cookie, /Max-Age=0/i, "and expires at once");
  }
});
