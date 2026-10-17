/**
 * The job route files themselves, run for real: each passes the signed-in
 * account's own id -- the one its session resolves to -- and nothing else.
 *
 * WHY THIS FILE EXISTS. The job functions are tested with an account id handed
 * straight to them, and `guard.test.mts` checks that every route asks for a
 * session. Neither proves that a route file hands the SESSION'S id on. This
 * does, by importing the actual `app/api/audit/.../route.ts` adapters and
 * calling their handlers with two different signed-in accounts.
 *
 * HOW THE ADAPTERS ARE LOADED WITHOUT A BUNDLER. A resolve hook, registered
 * before anything else is imported and private to this test process, maps the
 * `@/` alias onto the repository and points `pg` at an in-memory fake that knows
 * two ACTIVE accounts. Everything else is the real code: the session cookie,
 * the guard, the route adapter, the job function and the in-memory job store.
 * Nothing is rendered, no model is asked and no network is used: every request
 * stops at the ownership check or at a refusal made before any outside work.
 */
import { register } from "node:module";
import { strict as assert } from "node:assert";
import test, { beforeEach } from "node:test";

const ROOT = new URL("../../", import.meta.url).href;

/** Two ACTIVE accounts, read by the fake `pg` below through `findById`. */
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FAKE_PG = `
  export class Pool {
    async query(sql, params = []) {
      const accounts = globalThis.__routeOwnershipAccounts ?? [];
      if (/^\\s*SELECT/i.test(sql)) return { rows: accounts.filter((a) => a.id === String(params[0])) };
      return { rows: [] };
    }
  }
  export default { Pool };
`;
const HOOKS = `
  const ROOT = ${JSON.stringify(ROOT)};
  const FAKE_PG = ${JSON.stringify(FAKE_PG)};
  export async function resolve(specifier, context, next) {
    if (specifier === "pg") return { url: "data:text/javascript," + encodeURIComponent(FAKE_PG), shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: ROOT + specifier.slice(2) + ".ts", shortCircuit: true };
    if (specifier === "next/server") return next("next/server.js", context);
    return next(specifier, context);
  }
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

const row = (id: string, email: string) => ({
  id,
  email,
  password_hash: "scrypt:aa:bb",
  role: "SALES",
  status: "ACTIVE",
  created_at: new Date(),
  updated_at: new Date(),
  approved_by: null,
  approved_at: null,
  last_login_at: null,
  must_change_password: false,
});
(globalThis as Record<string, unknown>).__routeOwnershipAccounts = [
  row(ACCOUNT_A, "ana@skybook.example"),
  row(ACCOUNT_B, "ben@skybook.example"),
];
process.env.SESSION_SECRET = "route-ownership-secret-that-is-long-enough-0123456789";
process.env.DATABASE_URL = "postgres://fake.invalid/route-ownership";

// Imported only now, after the hook, so the guard's database is the fake.
const { SESSION_COOKIE, signSession } = await import("../auth/session.ts");
const { auditJobs } = await import("../jobs/auditJobs.ts");
const { JOB_NOT_FOUND, NOT_READY } = await import("../jobs/jobResponses.ts");
const { EXPLAIN_NOT_FINISHED } = await import("./auditRoutes.ts");
const { DEFAULT_LIMIT, checkRateLimit, resetRateLimits } = await import("../rateLimit.ts");
const { accountLimitKey } = await import("../accountLimitKey.ts");
const statusRoute = await import("../../app/api/audit/status/route.ts");
const resultRoute = await import("../../app/api/audit/result/route.ts");
const pdfRoute = await import("../../app/api/audit/pdf/route.ts");
const explainRoute = await import("../../app/api/audit/explain/route.ts");
const performanceRoute = await import("../../app/api/audit/performance/route.ts");
const startRoute = await import("../../app/api/audit/route.ts");

beforeEach(() => {
  resetRateLimits();
});

/** A signed-in request from `account`, with whatever else a test adds. */
function signedIn(account: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${SESSION_COOKIE}=${signSession(account, "SALES", {}, Date.now())}`);
  return new Request(`https://skybook.test${path}`, { ...init, headers });
}

/**
 * Every way a request could try to name an account itself: a query parameter, a
 * header and a body field, all claiming to be `account`. None may be read.
 */
const claimingToBe = (account: string) => ({
  query: `&userId=${account}&ownerId=${account}`,
  headers: { "x-user-id": account, "x-owner-id": account, "content-type": "application/json" },
  body: JSON.stringify({ userId: account, ownerId: account, url: "not a url" }),
});

/** A job started by `owner` and still running, so no route does outside work for it. */
function runningJobOwnedBy(owner: string) {
  const job = auditJobs().create("https://example.com/", owner);
  auditJobs().markRunning(job.id);
  return job.id;
}

const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

test("status: the route passes the session's own account, whatever the request claims", async () => {
  const jobId = runningJobOwnedBy(ACCOUNT_A);
  const forB = claimingToBe(ACCOUNT_B);
  const forA = claimingToBe(ACCOUNT_A);

  const owner = await statusRoute.GET(signedIn(ACCOUNT_A, `/api/audit/status?jobId=${jobId}${forB.query}`, { headers: forB.headers }));
  const other = await statusRoute.GET(signedIn(ACCOUNT_B, `/api/audit/status?jobId=${jobId}${forA.query}`, { headers: forA.headers }));

  assert.equal(owner.status, 200, "the owner's session reads its own audit, despite claiming to be B");
  assert.equal((await bodyOf(owner)).jobId, jobId);
  assert.equal(other.status, 404, "the other session is refused, despite claiming to be A");
  assert.deepEqual(await bodyOf(other), { ok: false, error: JOB_NOT_FOUND });
});

test("result: the route passes the session's own account", async () => {
  const jobId = runningJobOwnedBy(ACCOUNT_A);
  const forA = claimingToBe(ACCOUNT_A);

  const owner = await resultRoute.GET(signedIn(ACCOUNT_A, `/api/audit/result?jobId=${jobId}`));
  const other = await resultRoute.GET(signedIn(ACCOUNT_B, `/api/audit/result?jobId=${jobId}${forA.query}`, { headers: forA.headers }));

  // The owner passes the ownership check and meets the next one: not finished.
  assert.equal(owner.status, 409);
  assert.equal(other.status, 404);
  assert.deepEqual(await bodyOf(other), { ok: false, error: JOB_NOT_FOUND });
});

test("PDF: the route passes the session's own account, before anything is built", async () => {
  const jobId = runningJobOwnedBy(ACCOUNT_A);
  const forA = claimingToBe(ACCOUNT_A);

  const owner = await pdfRoute.POST(signedIn(ACCOUNT_A, `/api/audit/pdf?jobId=${jobId}`, { method: "POST" }));
  const other = await pdfRoute.POST(
    signedIn(ACCOUNT_B, `/api/audit/pdf?jobId=${jobId}${forA.query}`, { method: "POST", headers: forA.headers, body: forA.body }),
  );

  // A running job is refused as not ready, so no browser is ever launched here.
  assert.equal(owner.status, 409);
  assert.deepEqual(await bodyOf(owner), { ok: false, error: NOT_READY });
  assert.equal(other.status, 404);
  assert.deepEqual(await bodyOf(other), { ok: false, error: JOB_NOT_FOUND });
});

test("explanation: the route passes the session's own account, and nothing is claimed", async () => {
  const jobId = runningJobOwnedBy(ACCOUNT_A);
  const forA = claimingToBe(ACCOUNT_A);

  const owner = await explainRoute.POST(signedIn(ACCOUNT_A, `/api/audit/explain?jobId=${jobId}`, { method: "POST" }));
  const other = await explainRoute.POST(
    signedIn(ACCOUNT_B, `/api/audit/explain?jobId=${jobId}${forA.query}`, { method: "POST", headers: forA.headers, body: forA.body }),
  );

  assert.equal(owner.status, 409);
  assert.deepEqual(await bodyOf(owner), { ok: false, jobId, error: EXPLAIN_NOT_FINISHED });
  assert.equal(other.status, 404);
  assert.deepEqual(await bodyOf(other), { ok: false, jobId, error: JOB_NOT_FOUND });
  assert.equal(auditJobs().get(jobId)?.explanationClaimed, false, "no model was asked for either");
});

/*
 * The two routes below act on an address rather than an existing job, so their
 * account id is observed through the per-account allowance it keys: with only
 * the session account's allowance used up, that account is refused before any
 * work and every other account is not. Both requests carry a body that is not
 * an address, so the one that passes the allowance is refused for that instead
 * -- no audit is started and no speed check is measured.
 */

test("speed check: the route passes the session's own account", async () => {
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) checkRateLimit(accountLimitKey(ACCOUNT_A));
  const forB = claimingToBe(ACCOUNT_B);

  const owner = await performanceRoute.POST(
    signedIn(ACCOUNT_A, `/api/audit/performance?jobId=x${forB.query}`, { method: "POST", headers: forB.headers, body: forB.body }),
  );
  const other = await performanceRoute.POST(
    signedIn(ACCOUNT_B, "/api/audit/performance?jobId=x", { method: "POST", headers: forB.headers, body: forB.body }),
  );

  assert.equal(owner.status, 429, "A's own allowance is the one spent, despite the request claiming to be B");
  assert.equal(other.status, 400, "B is not refused by A's allowance: it reaches the address check");
});

test("audit start: the route passes the session's own account", async () => {
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) checkRateLimit(accountLimitKey(ACCOUNT_A));
  const forB = claimingToBe(ACCOUNT_B);

  const owner = await startRoute.POST(signedIn(ACCOUNT_A, "/api/audit", { method: "POST", headers: forB.headers, body: forB.body }));
  const other = await startRoute.POST(signedIn(ACCOUNT_B, "/api/audit", { method: "POST", headers: forB.headers, body: forB.body }));

  assert.equal(owner.status, 429, "A's own allowance is the one spent, despite the request claiming to be B");
  assert.equal(other.status, 400, "B reaches the address check, so no audit is started for either");
});

test("a request with no session never reaches any of them", async () => {
  const jobId = runningJobOwnedBy(ACCOUNT_A);
  const anonymous = (path: string, method = "GET") => new Request(`https://skybook.test${path}`, { method });

  for (const response of [
    await statusRoute.GET(anonymous(`/api/audit/status?jobId=${jobId}`)),
    await resultRoute.GET(anonymous(`/api/audit/result?jobId=${jobId}`)),
    await pdfRoute.POST(anonymous(`/api/audit/pdf?jobId=${jobId}`, "POST")),
    await explainRoute.POST(anonymous(`/api/audit/explain?jobId=${jobId}`, "POST")),
    await performanceRoute.POST(anonymous("/api/audit/performance", "POST")),
    await startRoute.POST(anonymous("/api/audit", "POST")),
  ]) {
    assert.equal(response.status, 401);
  }
});
