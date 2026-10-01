/**
 * Tests for the management console's decisions.
 *
 * NO REAL DATABASE. A fake holds a tiny table keyed by id and mutates in place,
 * so a status change made by one call is visible to the next — enough to drive
 * the whole lifecycle, and the authorization in front of it, without PostgreSQL.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { SESSION_COOKIE, signSession } from "./session.ts";
import { checkPassword } from "./credentials.ts";
import {
  FORBIDDEN,
  LAST_MANAGER,
  NO_SUCH_USER,
  SELF_FORBIDDEN,
  UNKNOWN_ACTION,
  WRONG_STATE,
  listUsersRoute,
  manageUserRoute,
} from "./manageUsersRoute.ts";
import { WEAK_PASSWORD } from "./registerRoute.ts";

const SECRET = "test-secret-that-is-long-enough-to-be-accepted-0123456789";
const NOW = 1_757_000_000_000;
const STRONG_PASSWORD = "a-long-enough-password";

type Row = Record<string, unknown> & { id: string; email: string };

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    email: `${id}@shop.com`,
    password_hash: "scrypt:aa:bb",
    role: "SALES",
    status: "PENDING",
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    approved_by: null,
    approved_at: null,
    last_login_at: null,
    must_change_password: false,
    ...overrides,
  };
}

/** A fake, mutable table keyed by id. */
function fakeDb(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/SELECT COUNT\(\*\)/i.test(sql)) {
        const n = [...byId.values()].filter((u) => u.role === "MANAGEMENT" && u.status === "ACTIVE").length;
        return { rows: [{ count: n }] };
      }
      if (/SELECT[\s\S]*WHERE id = \$1/i.test(sql)) {
        const r = byId.get(String(params[0]));
        return { rows: r ? [r] : [] };
      }
      if (/SELECT[\s\S]*ORDER BY created_at DESC/i.test(sql)) {
        return { rows: [...byId.values()] };
      }
      if (/UPDATE users[\s\S]*SET status = \$2/i.test(sql)) {
        const [id, status, approvedBy] = params as [string, string, string | null];
        const r = byId.get(String(id));
        if (r === undefined) return { rows: [] };
        r.status = status;
        if (approvedBy !== null && approvedBy !== undefined) {
          r.approved_by = approvedBy;
          r.approved_at = new Date(NOW);
        }
        return { rows: [r] };
      }
      if (/UPDATE users[\s\S]*SET password_hash = \$2/i.test(sql)) {
        const [id, passwordHash, mustChange] = params as [string, string, boolean];
        const r = byId.get(String(id));
        if (r === undefined) return { rows: [] };
        r.password_hash = passwordHash;
        r.must_change_password = mustChange;
        return { rows: [r] };
      }
      return { rows: [] };
    },
  };
  return { db, byId };
}

/** A request from the given account (its cookie), optionally with an action body. */
function req(userId: string, role: "MANAGEMENT" | "SALES", body?: unknown) {
  const cookie = `${SESSION_COOKIE}=${signSession(userId, role, { secret: SECRET }, NOW)}`;
  return new Request("https://skybook.example/api/users", {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A standard world: a manager plus a salesperson in each status. */
function world() {
  const rows = [
    row("mgr", { email: "boss@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
    row("sales", { role: "SALES", status: "ACTIVE" }),
    row("pend", { status: "PENDING" }),
    row("act", { status: "ACTIVE" }),
    row("inact", { status: "INACTIVE" }),
    row("rej", { status: "REJECTED" }),
  ];
  const { db, byId } = fakeDb(rows);
  return { db, byId, deps: { secret: SECRET, db, now: NOW } };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("a SALES account cannot list users", async () => {
  const { deps } = world();
  const result = await listUsersRoute(req("sales", "SALES"), deps);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 403);
  assert.equal(result.ok === false && result.error, FORBIDDEN);
});

test("an unauthenticated request cannot list users", async () => {
  const { deps } = world();
  const bare = new Request("https://skybook.example/api/users");
  const result = await listUsersRoute(bare, deps);
  assert.equal(result.ok === false && result.status, 403);
});

test("a SALES account cannot perform a management action", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(req("sales", "SALES", { action: "approve", userId: "pend" }), deps);
  assert.equal(result.ok === false && result.status, 403);
  assert.equal(byId.get("pend")!.status, "PENDING", "and nothing changed");
});

test("a manager whose own account was deactivated is refused — the role guard re-reads status", async () => {
  const { deps, byId } = world();
  byId.get("mgr")!.status = "INACTIVE";
  const result = await listUsersRoute(req("mgr", "MANAGEMENT"), deps);
  assert.equal(result.ok === false && result.status, 403);
});

test("a MANAGEMENT account can list users, and no password hash is ever in the response", async () => {
  const { deps } = world();
  const result = await listUsersRoute(req("mgr", "MANAGEMENT"), deps);

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.users?.length, 6);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes("scrypt:"), "no hash value");
  assert.ok(!serialised.includes("password_hash"), "no raw column");
  assert.ok(!serialised.includes("passwordHash"), "no mapped field either");
});

// ---------------------------------------------------------------------------
// Every status transition
// ---------------------------------------------------------------------------

test("approve: PENDING → ACTIVE, recording the acting manager", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "approve", userId: "pend" }), deps);

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.user?.status, "ACTIVE");
  assert.equal(byId.get("pend")!.status, "ACTIVE");
  assert.equal(byId.get("pend")!.approved_by, "mgr", "the manager is recorded");
  assert.ok(byId.get("pend")!.approved_at !== null, "and when");
});

test("reject: PENDING → REJECTED", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "reject", userId: "pend" }), deps);
  assert.equal(result.ok === true && result.user?.status, "REJECTED");
  assert.equal(byId.get("pend")!.status, "REJECTED");
  assert.equal(byId.get("pend")!.approved_by, "mgr");
});

test("deactivate: ACTIVE → INACTIVE", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "deactivate", userId: "act" }), deps);
  assert.equal(result.ok === true && result.user?.status, "INACTIVE");
  assert.equal(byId.get("act")!.status, "INACTIVE");
});

test("reactivate: INACTIVE → ACTIVE", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "reactivate", userId: "inact" }), deps);
  assert.equal(result.ok === true && result.user?.status, "ACTIVE");
  assert.equal(byId.get("inact")!.status, "ACTIVE");
});

test("an action on the wrong starting state is refused with 409 and changes nothing", async () => {
  const { deps, byId } = world();
  // approve only applies to a PENDING account; "act" is ACTIVE.
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "approve", userId: "act" }), deps);
  assert.equal(result.ok === false && result.status, 409);
  assert.equal(result.ok === false && result.error, WRONG_STATE);
  assert.equal(byId.get("act")!.status, "ACTIVE", "unchanged");
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test("set-password: hashes the new password, stores only the hash, flags a change", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(
    req("mgr", "MANAGEMENT", { action: "set-password", userId: "act", password: STRONG_PASSWORD }),
    deps,
  );

  assert.equal(result.ok, true);
  const stored = byId.get("act")!.password_hash as string;
  assert.match(stored, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "a salted scrypt hash");
  assert.ok(!stored.includes(STRONG_PASSWORD), "never the plaintext");
  assert.equal(checkPassword(STRONG_PASSWORD, stored), true, "and it verifies the new password");
  assert.equal(byId.get("act")!.must_change_password, true, "flagged to be changed");
});

test("set-password with a weak password is refused with 400", async () => {
  const { deps, byId } = world();
  const result = await manageUserRoute(
    req("mgr", "MANAGEMENT", { action: "set-password", userId: "act", password: "short" }),
    deps,
  );
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(result.ok === false && result.error, WEAK_PASSWORD);
  assert.equal(byId.get("act")!.password_hash, "scrypt:aa:bb", "the old hash is untouched");
});

// ---------------------------------------------------------------------------
// Role cannot be changed; accounts cannot be deleted; self-protection
// ---------------------------------------------------------------------------

test("a role is never changed, however the body tries to smuggle one in", async () => {
  const { deps, byId } = world();
  await manageUserRoute(
    req("mgr", "MANAGEMENT", { action: "approve", userId: "pend", role: "MANAGEMENT", status: "ACTIVE" }),
    deps,
  );
  assert.equal(byId.get("pend")!.role, "SALES", "the role stays SALES; the smuggled fields are ignored");
});

test("a manager cannot change their own status here (self-protection)", async () => {
  // TWO active managers, so the last-manager guard does NOT apply; what stops a
  // manager deactivating themselves is self-protection alone. (With a single
  // manager it is the last-manager guard that fires — see below.)
  const { db, byId } = fakeDb([
    row("mgr", { email: "boss@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
    row("mgr2", { email: "boss2@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
  ]);
  const deps = { secret: SECRET, db, now: NOW };

  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "deactivate", userId: "mgr" }), deps);
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(result.ok === false && result.error, SELF_FORBIDDEN);
  assert.equal(byId.get("mgr")!.status, "ACTIVE", "the console stays reachable");
});

// ---------------------------------------------------------------------------
// Last-active-manager protection: the system must never be left unmanageable
// ---------------------------------------------------------------------------

test("the last active manager cannot be deactivated", async () => {
  // One active manager — the actor. Deactivating them (the only way to target the
  // last active manager, since the actor must themselves be an active manager) is
  // refused by the last-manager guard, which is checked before self-protection.
  const { db, byId } = fakeDb([
    row("mgr", { email: "boss@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
    row("sales", { role: "SALES", status: "ACTIVE" }),
  ]);
  const deps = { secret: SECRET, db, now: NOW };

  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "deactivate", userId: "mgr" }), deps);
  assert.equal(result.ok === false && result.status, 409);
  assert.equal(result.ok === false && result.error, LAST_MANAGER);
  assert.equal(byId.get("mgr")!.status, "ACTIVE", "still the active manager");
});

test("the last active manager cannot be rejected", async () => {
  // reject only applies to a PENDING account; the last active manager is ACTIVE,
  // so the transition rule itself refuses it and the manager is never moved to
  // REJECTED. Either way the invariant — an active manager remains — holds.
  const { db, byId } = fakeDb([row("mgr", { email: "boss@shop.com", role: "MANAGEMENT", status: "ACTIVE" })]);
  const deps = { secret: SECRET, db, now: NOW };

  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "reject", userId: "mgr" }), deps);
  assert.equal(result.ok, false);
  assert.equal(byId.get("mgr")!.status, "ACTIVE", "not rejected");
});

test("deactivating another manager is allowed while an active manager remains", async () => {
  // Two active managers: deactivating one leaves the other, so it is permitted.
  const { db, byId } = fakeDb([
    row("mgr", { email: "boss@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
    row("mgr2", { email: "boss2@shop.com", role: "MANAGEMENT", status: "ACTIVE" }),
  ]);
  const deps = { secret: SECRET, db, now: NOW };

  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "deactivate", userId: "mgr2" }), deps);
  assert.equal(result.ok, true);
  assert.equal(byId.get("mgr2")!.status, "INACTIVE");
  assert.equal(byId.get("mgr")!.status, "ACTIVE", "the actor remains, so the system keeps a manager");
});

test("there is no delete action", async () => {
  const { deps, byId } = world();
  const before = byId.size;
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "delete", userId: "act" }), deps);
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(result.ok === false && result.error, UNKNOWN_ACTION);
  assert.equal(byId.size, before, "no account was removed");
});

// ---------------------------------------------------------------------------
// Missing targets and unknown actions
// ---------------------------------------------------------------------------

test("an action on a non-existent user is a 404", async () => {
  const { deps } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "approve", userId: "ghost" }), deps);
  assert.equal(result.ok === false && result.status, 404);
  assert.equal(result.ok === false && result.error, NO_SUCH_USER);
});

test("an unknown action is a 400", async () => {
  const { deps } = world();
  const result = await manageUserRoute(req("mgr", "MANAGEMENT", { action: "frobnicate", userId: "pend" }), deps);
  assert.equal(result.ok === false && result.status, 400);
  assert.equal(result.ok === false && result.error, UNKNOWN_ACTION);
});
