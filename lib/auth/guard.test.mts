/**
 * Tests for the one guard every API route calls.
 *
 * WHY THIS IS TESTED HERE AND NOT SIX TIMES OVER. The adapters call this in
 * one line each; what a missing session means is decided once, so it is
 * checked once. A separate test asserts that all six really do call it, which
 * is the part that could silently stop being true.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { SESSION_COOKIE, signSession } from "./session.ts";
import {
  UNAUTHORISED,
  UNAUTHORISED_STATUS,
  requireSession,
  sessionCookie,
  unauthorised,
} from "./guard.ts";

const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const options = { secret: SECRET };
const NOW = 1_757_000_000_000;

const withCookie = (value: string) =>
  new Request("https://skybook.example/api/audit", { headers: { cookie: value } });

const signedIn = () =>
  withCookie(`${SESSION_COOKIE}=${signSession("ana@skybook.example", options, NOW)}`);

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

test("a request carrying a valid session is let through, and names the person", () => {
  const session = requireSession(signedIn(), options, NOW);

  assert.equal(session?.email, "ana@skybook.example");
});

test("every way of not being signed in is refused, and refused identically", () => {
  /*
   * ONE ANSWER FOR ALL OF THEM. Telling a forged cookie apart from an expired
   * one tells somebody probing the application which guess was closer.
   */
  const cookie = signSession("ana@skybook.example", options, NOW);

  const refused = [
    new Request("https://skybook.example/api/audit"),
    withCookie(""),
    withCookie(`${SESSION_COOKIE}=`),
    withCookie(`${SESSION_COOKIE}=not-a-cookie`),
    withCookie(`${SESSION_COOKIE}=${cookie}x`),
    withCookie(`theme=dark`),
  ];

  for (const request of refused) {
    assert.equal(requireSession(request, options, NOW), null, request.headers.get("cookie") ?? "none");
  }
});

test("an expired session is refused like any other", () => {
  const request = signedIn();

  assert.ok(requireSession(request, options, NOW) !== null);
  assert.equal(requireSession(request, options, NOW + 9 * 60 * 60 * 1000), null);
});

test("a server with no signing secret lets nobody through", () => {
  // Fails closed. The wrong outcome is an application where everybody is in.
  assert.equal(requireSession(signedIn(), { secret: "" }, NOW), null);
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
  for (const route of ROUTES) {
    const source = read(route);
    const body = source.slice(source.indexOf("export async function"));

    const guard = body.indexOf("requireSession(request)");
    const work = body.indexOf("await ") === -1 ? body.indexOf("Route(request)") : body.indexOf("await ");

    assert.ok(guard > 0, `${route} guards`);
    assert.ok(guard < work || work === -1, `${route} guards before it works`);
  }
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
   * The two sign-in routes are deliberately not guarded: requiring a session
   * to obtain one is a locked door with the key inside, and refusing to sign
   * somebody out because their session already expired leaves a stale cookie
   * in their browser.
   */
  const audit = found.filter((path) => !path.includes("/api/auth/"));

  assert.equal(audit.length, ROUTES.length, `found ${audit.length} audit routes: ${audit.join(", ")}`);
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
