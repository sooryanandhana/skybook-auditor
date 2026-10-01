/**
 * Tests for the first-manager bootstrap.
 *
 * NO REAL DATABASE. `createManagementAccount` writes through the repository,
 * which takes an injected `Db`; these drive it with fakes. The real scrypt hash
 * runs, because storing a real hash is part of what is being checked.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createManagementAccount } from "./setupManagement.ts";
import { checkPassword } from "./credentials.ts";

const PASSWORD = "a-long-enough-password";
const NOW = 1_757_000_000_000;

/** Records each INSERT and echoes a row back so create() can map it. */
function recordingDb() {
  const inserts: unknown[][] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*INSERT INTO users/i.test(sql)) {
        inserts.push(params);
        const [email, password_hash, role, status, must_change_password] = params;
        return {
          rows: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              email,
              password_hash,
              role,
              status,
              created_at: new Date(NOW),
              updated_at: new Date(NOW),
              approved_by: null,
              approved_at: null,
              last_login_at: null,
              must_change_password,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { db, inserts };
}

/** Refuses an INSERT with PostgreSQL's unique_violation code. */
const duplicateDb = {
  async query(sql: string) {
    if (/^\s*INSERT/i.test(sql)) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return { rows: [] };
  },
};

/** Simply unreachable. */
const brokenDb = {
  async query(): Promise<{ rows: unknown[] }> {
    throw new Error("could not connect to postgres://user:secret@host/db");
  },
};

test("creates a MANAGEMENT, ACTIVE account — never SALES or PENDING", async () => {
  const { db, inserts } = recordingDb();
  const result = await createManagementAccount("boss@shop.com", PASSWORD, { db });

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.email, "boss@shop.com");

  const [email, , role, status] = inserts[0] as string[];
  assert.equal(email, "boss@shop.com");
  assert.equal(role, "MANAGEMENT", "always MANAGEMENT");
  assert.equal(status, "ACTIVE", "always ACTIVE");
});

test("the password is stored as a scrypt hash, never in plaintext", async () => {
  const { db, inserts } = recordingDb();
  await createManagementAccount("boss@shop.com", PASSWORD, { db });

  const hash = (inserts[0] as string[])[1];
  assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "a salted scrypt hash");
  assert.ok(!hash.includes(PASSWORD), "the plaintext is not in the stored value");
  assert.equal(checkPassword(PASSWORD, hash), true, "and it verifies the password");
});

test("the email is normalised the same way login normalises it", async () => {
  const { db, inserts } = recordingDb();
  await createManagementAccount("  Boss@Shop.COM  ", PASSWORD, { db });
  assert.equal((inserts[0] as string[])[0], "boss@shop.com");
});

test("an existing address is refused, not duplicated or overwritten", async () => {
  const result = await createManagementAccount("taken@shop.com", PASSWORD, { db: duplicateDb });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "exists");
});

test("an invalid email is refused and writes nothing", async () => {
  const { db, inserts } = recordingDb();
  const result = await createManagementAccount("not-an-email", PASSWORD, { db });
  assert.equal(result.ok === false && result.reason, "invalid-email");
  assert.equal(inserts.length, 0, "no INSERT on a bad address");
});

test("a weak password is refused and writes nothing", async () => {
  const { db, inserts } = recordingDb();
  const result = await createManagementAccount("boss@shop.com", "short", { db });
  assert.equal(result.ok === false && result.reason, "weak-password");
  assert.equal(inserts.length, 0, "no INSERT on a weak password");
});

test("a database error is reported without surfacing the connection string", async () => {
  const result = await createManagementAccount("boss@shop.com", PASSWORD, { db: brokenDb });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "error");
  assert.ok(result.ok === false && !result.message.includes("secret"), "no connection string in the message");
});
