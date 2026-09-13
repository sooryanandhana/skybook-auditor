/**
 * Tests for the signed session cookie.
 *
 * THE INTERESTING TESTS ARE THE FORGERIES. Proving that a cookie this module
 * signed is a cookie this module believes takes one line and says almost
 * nothing. What is worth writing is every way a browser might try to promote
 * itself: editing the address inside, keeping the signature and swapping the
 * payload, keeping the payload and swapping the signature, replaying an old
 * one, and presenting a cookie signed with a different key.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  SESSION_SECRET_VARIABLE,
  readSession,
  sessionAvailability,
  sessionCookieOptions,
  signSession,
} from "./session.ts";

/** Long enough to be accepted, and obviously not a real key. */
const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const OTHER = "another-secret-that-is-long-enough-to-be-accepted-98765432";

const options = { secret: SECRET };
const NOW = 1_757_000_000_000;

/* ---------------------------------------------------------------------------
   The happy path, briefly
   --------------------------------------------------------------------------- */

test("a cookie this server signed carries the address back", () => {
  const cookie = signSession("ana@skybook.example", options, NOW);

  assert.ok(cookie !== null);
  assert.deepEqual(readSession(cookie, options, NOW), {
    email: "ana@skybook.example",
    expiresAt: NOW + SESSION_MAX_AGE_MS,
  });
});

test("it carries an address rather than a yes", () => {
  /*
   * The property that makes roles and a later move to Google possible without
   * a rewrite. A cookie meaning only "signed in" would be the same size and
   * would name nobody.
   */
  const session = readSession(signSession("sam@skybook.example", options, NOW), options, NOW);

  assert.equal(session?.email, "sam@skybook.example");
});

/* ---------------------------------------------------------------------------
   Forgeries
   --------------------------------------------------------------------------- */

test("an edited address is refused", () => {
  const cookie = signSession("ana@skybook.example", options, NOW) ?? "";
  const [payload, signature] = cookie.split(".");

  const forged = Buffer.from(
    JSON.stringify({ email: "attacker@example.com", expiresAt: NOW + SESSION_MAX_AGE_MS }),
    "utf8",
  ).toString("base64url");

  assert.equal(readSession(`${forged}.${signature}`, options, NOW), null);
  assert.notEqual(payload, forged, "the test is only meaningful if the payload really differs");
});

test("an extended expiry is refused", () => {
  // The most tempting edit of all: keep the address, move the clock.
  const forged = Buffer.from(
    JSON.stringify({ email: "ana@skybook.example", expiresAt: NOW + 10 * SESSION_MAX_AGE_MS }),
    "utf8",
  ).toString("base64url");
  const signature = (signSession("ana@skybook.example", options, NOW) ?? "").split(".")[1];

  assert.equal(readSession(`${forged}.${signature}`, options, NOW), null);
});

test("a cookie signed with another key is refused", () => {
  // What a stolen copy of this source buys somebody without the secret.
  const elsewhere = signSession("ana@skybook.example", { secret: OTHER }, NOW);

  assert.equal(readSession(elsewhere, options, NOW), null);
});

test("nonsense in the cookie is refused rather than parsed", () => {
  for (const cookie of [
    "",
    ".",
    "..",
    "not-a-cookie",
    "eyJhIjoxfQ",
    "eyJhIjoxfQ.",
    ".signature",
    "%%%.%%%",
  ]) {
    assert.equal(readSession(cookie, options, NOW), null, JSON.stringify(cookie));
  }
});

test("a correctly signed cookie carrying the wrong shape is refused", async () => {
  /*
   * The case that matters if this server ever signs something else with the
   * same key: a valid signature is not a valid session.
   */
  for (const payload of [
    { email: "", expiresAt: NOW + 1000 },
    { email: "ana@skybook.example" },
    { email: "ana@skybook.example", expiresAt: "soon" },
    { email: 42, expiresAt: NOW + 1000 },
    { expiresAt: NOW + 1000 },
  ]) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");

    assert.equal(readSession(`${encoded}.${signature}`, options, NOW), null, JSON.stringify(payload));
  }
});

test("no cookie at all is refused", () => {
  assert.equal(readSession(undefined, options, NOW), null);
  assert.equal(readSession(null, options, NOW), null);
});

/* ---------------------------------------------------------------------------
   Expiry
   --------------------------------------------------------------------------- */

test("a session stops working the moment it expires", () => {
  const cookie = signSession("ana@skybook.example", options, NOW);

  assert.ok(readSession(cookie, options, NOW + SESSION_MAX_AGE_MS - 1) !== null, "valid just before");
  assert.equal(readSession(cookie, options, NOW + SESSION_MAX_AGE_MS), null, "and not on the moment");
  assert.equal(readSession(cookie, options, NOW + SESSION_MAX_AGE_MS + 1), null);
});

test("a session lasts a working day rather than a month", () => {
  // Expiry is the only revocation this application has: there is no session
  // store to delete from. A long one would be a laptop left in a client's
  // reception signed in for a fortnight.
  assert.equal(SESSION_MAX_AGE_MS, 8 * 60 * 60 * 1000);
});

/* ---------------------------------------------------------------------------
   A server with no key
   --------------------------------------------------------------------------- */

test("a server with no secret signs nothing and believes nothing", () => {
  /*
   * FAILS CLOSED. The wrong behaviour here is not an error, it is an
   * application where everybody is signed in because nothing can be checked.
   */
  for (const missing of [{ secret: "" }, { secret: "   " }]) {
    assert.equal(sessionAvailability(missing).configured, false);
    assert.equal(signSession("ana@skybook.example", missing, NOW), null);
    assert.equal(readSession(signSession("ana@skybook.example", options, NOW), missing, NOW), null);
  }
});

test("a short secret is treated as no secret", () => {
  // "changeme" signs perfectly well and forges just as easily, and nothing
  // would have said so.
  const availability = sessionAvailability({ secret: "changeme" });

  assert.equal(availability.configured, false);
  assert.equal(signSession("ana@skybook.example", { secret: "changeme" }, NOW), null);
});

test("the sentence about a missing secret names the variable and never a value", () => {
  const availability = sessionAvailability({ secret: "" });

  assert.equal(availability.configured, false);
  if (availability.configured) return;

  assert.match(availability.reason, new RegExp(SESSION_SECRET_VARIABLE));
  assert.match(availability.reason, /audit engine is unaffected/);
  assert.ok(!availability.reason.includes(SECRET), "and never the secret itself");
});

/* ---------------------------------------------------------------------------
   The cookie itself
   --------------------------------------------------------------------------- */

test("the cookie is set the way the framework's guide says to set it", () => {
  const set = sessionCookieOptions();

  assert.equal(set.httpOnly, true, "no script on the page may read it");
  assert.equal(set.sameSite, "lax", "another site may not make a request carrying it");
  assert.equal(set.path, "/");
  assert.equal(set.maxAge, SESSION_MAX_AGE_MS / 1000);
});

test("the secure flag follows the environment rather than the request", () => {
  /*
   * A secure cookie is never sent over plain http, and local development is
   * http, so a hard true would set a cookie nobody ever saw again. The switch
   * reads NODE_ENV, which a request cannot influence.
   */
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  try {
    env.NODE_ENV = "production";
    assert.equal(sessionCookieOptions().secure, true);

    env.NODE_ENV = "development";
    assert.equal(sessionCookieOptions().secure, false);
  } finally {
    env.NODE_ENV = before;
  }
});

test("the cookie has one name, and nothing builds a second one", () => {
  assert.equal(SESSION_COOKIE, "skybook_session");
  assert.ok(!SESSION_COOKIE.startsWith("NEXT_PUBLIC"), "not a browser-readable name");
});

/* ---------------------------------------------------------------------------
   What this module cannot do, asserted against the source
   --------------------------------------------------------------------------- */

test("the session is signed rather than encrypted, and says so", () => {
  /*
   * Worth pinning because the difference decides what may be put inside. The
   * address is readable by anyone holding the cookie, which is fine; a secret
   * placed in there later would not be.
   */
  const cookie = signSession("ana@skybook.example", options, NOW) ?? "";
  const payload = Buffer.from(cookie.split(".")[0], "base64url").toString("utf8");

  assert.match(payload, /ana@skybook\.example/, "readable, as a signed payload is");
});

test("nothing here reaches a store, a provider or the audit engine", () => {
  const source = fs.readFileSync(new URL("./session.ts", import.meta.url), "utf8");

  /*
   * NAMED AS IMPORTS RATHER THAN AS WORDS. An earlier version of this list
   * forbade "gemini" and failed on a comment saying this module is shaped like
   * the Gemini client. A design parallel described in prose is not a
   * dependency, and a test that cannot tell them apart is a test that punishes
   * explaining yourself.
   */
  for (const forbidden of [
    "fetch(",
    "localStorage",
    "sessionStorage",
    "postgres",
    "prisma",
    "../ai/",
    "resend",
    "../audit/",
    "../collector/",
    "../rules/",
  ]) {
    assert.ok(!source.includes(forbidden), `the session module must not reach ${forbidden}`);
  }
});
