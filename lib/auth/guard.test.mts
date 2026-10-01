/**
 * Tests for the one guard every API route calls.
 *
 * WHY THIS IS TESTED HERE AND NOT SIX TIMES OVER. The adapters call this in
 * one line each; what a missing session means is decided once, so it is
 * checked once. A separate test asserts that all of them really do call it,
 * which is the part that could silently stop being true.
 *
 * NO REAL DATABASE. The guard resolves the account through the repository, which
 * takes an injected `Db`; these drive it with a fake, so the whole flow — signed
 * cookie, then a fresh status and role read — runs without PostgreSQL.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { SESSION_COOKIE, signSession } from "./session.ts";
import {
  UNAUTHORISED,
  UNAUTHORISED_STATUS,
  requireRole,
  requireSession,
  sessionCookie,
  unauthorised,
} from "./guard.ts";

const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const NOW = 1_757_000_000_000;
const USER_ID = "11111111-1111-1111-1111-111111111111";

/** One account row, as PostgreSQL returns it (snake_case). */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "ana@skybook.example",
    password_hash: "scrypt:aa:bb",
    role: "SALES",
    status: "ACTIVE",
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    approved_by: null,
    approved_at: null,
    last_login_at: null,
    must_change_password: false,
    ...overrides,
  };
}

/** A fake database returning `user` for its own id, and nothing for any other. */
function dbById(user: Record<string, unknown> | null) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*SELECT/i.test(sql)) {
        const id = String(params[0] ?? "");
        return { rows: user !== null && id === user.id ? [user] : [] };
      }
      return { rows: [] };
    },
  };
}

/** A database that cannot be reached. */
const brokenDb = {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error("database unavailable");
  },
};

/** Guard options holding the signing secret and a fake DB with the given account. */
const guardOptions = (user: Record<string, unknown> | null = userRow()) => ({ secret: SECRET, db: dbById(user) });

const withCookie = (value: string) =>
  new Request("https://skybook.example/api/audit", { headers: { cookie: value } });

/** A request carrying a valid cookie for the ACTIVE salesperson. */
const signedIn = (role: "SALES" | "MANAGEMENT" = "SALES") =>
  withCookie(`${SESSION_COOKIE}=${signSession(USER_ID, role, { secret: SECRET }, NOW)}`);

/* ---------------------------------------------------------------------------
   Reading the cookie off a request
   --------------------------------------------------------------------------- */

test("the session cookie is found among others", () => {
  const request = withCookie(`theme=dark; ${SESSION_COOKIE}=abc.def; other=1`);

  assert.equal(sessionCookie(request), "abc.def");
});

test("a value containing an equals sign survives being read", () => {
  // base64url padding produces these, and a naive split on "=" would cut one.
  const request = withCookie(`${SESSION_COOKIE}=payload==.signature==`);

  assert.equal(sessionCookie(request), "payload==.signature==");
});

test("a cookie whose name merely contains ours is not ours", () => {
  const request = withCookie(`not_${SESSION_COOKIE}=forged; ${SESSION_COOKIE}_old=stale`);

  assert.equal(sessionCookie(request), null);
});

test("no cookie header at all reads as no cookie", () => {
  assert.equal(sessionCookie(new Request("https://skybook.example/api/audit")), null);
  assert.equal(sessionCookie(withCookie("")), null);
});

/* ---------------------------------------------------------------------------
   The guard
   --------------------------------------------------------------------------- */

test("a request carrying a valid session for an ACTIVE account is let through, and names the person", async () => {
  const user = await requireSession(signedIn(), guardOptions(), NOW);

  assert.equal(user?.id, USER_ID);
  assert.equal(user?.email, "ana@skybook.example");
  assert.equal(user?.status, "ACTIVE");
});

test("every way of not being signed in is refused, and refused identically", async () => {
  /*
   * ONE ANSWER FOR ALL OF THEM. Telling a forged cookie apart from an expired
   * one tells somebody probing the application which guess was closer.
   */
  const cookie = signSession(USER_ID, "SALES", { secret: SECRET }, NOW);

  const refused = [
    new Request("https://skybook.example/api/audit"),
    withCookie(""),
    withCookie(`${SESSION_COOKIE}=`),
    withCookie(`${SESSION_COOKIE}=not-a-cookie`),
    withCookie(`${SESSION_COOKIE}=${cookie}x`),
    withCookie(`theme=dark`),
  ];

  for (const request of refused) {
    assert.equal(await requireSession(request, guardOptions(), NOW), null, request.headers.get("cookie") ?? "none");
  }
});

test("an expired session is refused like any other", async () => {
  const request = signedIn();

  assert.ok((await requireSession(request, guardOptions(), NOW)) !== null);
  assert.equal(await requireSession(request, guardOptions(), NOW + 9 * 60 * 60 * 1000), null);
});

test("a server with no signing secret lets nobody through", async () => {
  // Fails closed. The wrong outcome is an application where everybody is in.
  assert.equal(await requireSession(signedIn(), { secret: "", db: dbById(userRow()) }, NOW), null);
});

/* ---------------------------------------------------------------------------
   The account is re-read from the database every request
   --------------------------------------------------------------------------- */

test("a deactivated or not-yet-approved account is refused at once, even with a valid cookie", async () => {
  // The whole point of reading status every request: a manager switching an
  // account off ends its access on the account's very next call.
  for (const status of ["PENDING", "REJECTED", "INACTIVE"] as const) {
    const refused = await requireSession(signedIn(), guardOptions(userRow({ status })), NOW);
    assert.equal(refused, null, status);
  }
});

test("an account that no longer exists is refused", async () => {
  const refused = await requireSession(signedIn(), guardOptions(null), NOW);
  assert.equal(refused, null);
});

test("a database that cannot be reached fails closed", async () => {
  // A valid cookie, but the status cannot be confirmed, so nobody is let in.
  const refused = await requireSession(signedIn(), { secret: SECRET, db: brokenDb }, NOW);
  assert.equal(refused, null);
});

/* ---------------------------------------------------------------------------
   requireRole
   --------------------------------------------------------------------------- */

test("requireRole lets a manager through and refuses a salesperson", async () => {
  const manager = await requireRole(signedIn("MANAGEMENT"), "MANAGEMENT", guardOptions(userRow({ role: "MANAGEMENT" })), NOW);
  assert.equal(manager?.role, "MANAGEMENT");

  const salesperson = await requireRole(signedIn("SALES"), "MANAGEMENT", guardOptions(userRow({ role: "SALES" })), NOW);
  assert.equal(salesperson, null, "the wrong role is refused");
});

test("requireRole reads the role from the database, not from the cookie", async () => {
  // A cookie claiming MANAGEMENT does not grant it: the account in the database
  // is now SALES, so the management door stays shut.
  const demoted = await requireRole(signedIn("MANAGEMENT"), "MANAGEMENT", guardOptions(userRow({ role: "SALES" })), NOW);
  assert.equal(demoted, null, "a stale cookie cannot out-claim the database");

  // And the other way: the account was promoted, so the fresh role lets it in
  // even though the cookie still says SALES.
  const promoted = await requireRole(signedIn("SALES"), "MANAGEMENT", guardOptions(userRow({ role: "MANAGEMENT" })), NOW);
  assert.equal(promoted?.role, "MANAGEMENT");
});

test("requireRole still refuses everyone requireSession would", async () => {
  // Built on the same base, so a deactivated manager is refused too.
  const refused = await requireRole(signedIn("MANAGEMENT"), "MANAGEMENT", guardOptions(userRow({ role: "MANAGEMENT", status: "INACTIVE" })), NOW);
  assert.equal(refused, null);
});

/* ---------------------------------------------------------------------------
   What a refused caller is told
   --------------------------------------------------------------------------- */

test("the refusal says what to do and nothing else", () => {
  const refused = unauthorised();

  assert.equal(refused.status, UNAUTHORISED_STATUS);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.error, UNAUTHORISED);
});

test("the refusal leaks no implementation detail", () => {
  /*
   * No cookie name, no reason, no hint about which part of the check refused,
   * and nothing about the account that does exist.
   */
  for (const forbidden of [SESSION_COOKIE, "cookie", "expired", "secret", "hash", "password", "@"]) {
    assert.ok(!UNAUTHORISED.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
  }
});

/* ---------------------------------------------------------------------------
   That the routes actually call it
   --------------------------------------------------------------------------- */

const ROUTES = [
  "../../app/api/audit/route.ts",
  "../../app/api/audit/status/route.ts",
  "../../app/api/audit/result/route.ts",
  "../../app/api/audit/performance/route.ts",
  "../../app/api/audit/explain/route.ts",
  "../../app/api/audit/pdf/route.ts",
  "../../app/api/report/send/route.ts",
];

/**
 * Management-only routes. Their adapters delegate to a function in lib/auth that
 * opens with `requireRole(MANAGEMENT)` — the same guard the ordinary routes get,
 * raised to a role — so they are counted and checked here rather than expected
 * to call `requireSession` directly.
 */
const MANAGEMENT_ROUTES = ["../../app/api/users/route.ts"];

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

test("every API route in the application calls the guard", () => {
  /*
   * THE TEST THAT MATTERS MOST IN THIS FILE. The guard being correct is worth
   * nothing if a route forgets to ask it, and the seventh route somebody adds
   * next year is exactly the one that will.
   */
  for (const route of ROUTES) {
    const source = read(route);

    assert.ok(source.includes("requireSession(request)"), `${route} must call the guard`);
    assert.ok(source.includes("unauthorised()"), `${route} must refuse with the shared answer`);
  }
});

test("the guard is the first thing each route does", () => {
  // A route that authenticates after starting an audit has already started it.
  // The guard is awaited now, so this looks for delegated WORK before the guard
  // rather than for the first await (which is the guard's own).
  for (const route of ROUTES) {
    const source = read(route);
    const body = source.slice(source.indexOf("export async function"));

    const guard = body.indexOf("requireSession(request)");
    assert.ok(guard > 0, `${route} guards`);
    // Each route delegates its real work to a `...Route(` call; none of those
    // may appear before the guard.
    assert.ok(!/Route\(/.test(body.slice(0, guard)), `${route} guards before it works`);
  }
});

test("management routes are guarded by requireRole(MANAGEMENT)", () => {
  /*
   * The role guard is in the delegated logic, not the adapter, so this checks
   * both: the adapter really does delegate to the management logic, and that
   * logic really does require the MANAGEMENT role.
   */
  for (const route of MANAGEMENT_ROUTES) {
    const adapter = read(route);
    assert.ok(
      /manageUserRoute|listUsersRoute/.test(adapter),
      `${route} must delegate to the management logic`,
    );
  }

  const logic = read("./manageUsersRoute.ts");
  assert.ok(
    logic.includes('requireRole(request, "MANAGEMENT"'),
    "the management logic must require the MANAGEMENT role",
  );
});

test("no route was left behind", () => {
  /*
   * Counted against the folder rather than against the list above, so a route
   * added without a guard fails here instead of being quietly unprotected.
   */
  const apiRoot = new URL("../../app/api/", import.meta.url);

  const found: string[] = [];
  const walk = (directory: URL) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, directory));
      else if (entry.name === "route.ts") found.push(new URL(entry.name, directory).pathname);
    }
  };
  walk(apiRoot);

  /*
   * The sign-in and registration routes are deliberately not guarded: requiring
   * a session to obtain one, or to ask for an account, is a locked door with
   * the key inside. Every other route is either session-guarded (ROUTES) or
   * role-guarded (MANAGEMENT_ROUTES).
   */
  const guarded = found.filter((path) => !path.includes("/api/auth/"));

  assert.equal(
    guarded.length,
    ROUTES.length + MANAGEMENT_ROUTES.length,
    `found ${guarded.length} non-auth routes: ${guarded.join(", ")}`,
  );
});

/* ---------------------------------------------------------------------------
   What the guard does not touch
   --------------------------------------------------------------------------- */

test("authenticating never consults or spends the audit rate limiter", () => {
  /*
   * That bucket bounds how many audits a caller may start and how much metered
   * Google quota they may spend. Sharing it would let somebody guessing
   * passwords block the salesperson from running an audit.
   */
  const source = read("./guard.ts") + read("./loginRoute.ts") + read("./session.ts") + read("./credentials.ts");

  assert.ok(!source.includes("checkRateLimit"), "no call to the audit limiter");
  assert.ok(!source.includes("rateLimit"), "and no import of it");
});

test("nothing in the authentication path reaches the audit engine", () => {
  const source = read("./guard.ts") + read("./loginRoute.ts");

  for (const forbidden of ["../audit/", "../collector/", "../rules/", "../ai/", "postgres", "prisma", "resend"]) {
    assert.ok(!source.includes(forbidden), `must not reach ${forbidden}`);
  }
});
