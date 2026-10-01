/**
 * Tests that the deployment is wired to migrate the database before it serves.
 *
 * These read the committed config — package.json, render.yaml, the Dockerfile —
 * and assert the chain that makes a fresh database get its `users` table on its
 * own: a migrate script, a pre-deploy step that runs it, and the migration
 * tooling present in the image that step runs in. A config file is as easy to
 * break as code, and harder to notice, so it is pinned here.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (name: string) => fs.readFileSync(new URL(name, root), "utf8");

test("package.json exposes the migrate and setup:management scripts", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  assert.match(pkg.scripts.migrate ?? "", /migrate\.cli\.mts/, "`npm run migrate` runs the migration CLI");
  assert.match(
    pkg.scripts["setup:management"] ?? "",
    /setupManagement\.cli\.mts/,
    "`npm run setup:management` runs the bootstrap CLI",
  );
});

test("the container migrates before it serves, and a failed migration never starts the server", () => {
  const dockerfile = read("Dockerfile");

  // Startup runs the migration and the server through one `&&` chain, in that
  // order: migrate first, server second. `&&` is the fail-closed property — a
  // non-zero migration short-circuits, so `node server.js` is never reached and
  // the container exits non-zero.
  const cmd = dockerfile.match(/CMD\s+\[[^\]]*"sh"[^\]]*\]/);
  assert.ok(cmd, "startup runs through a shell so the two steps can be chained");

  const startup = cmd[0];
  const migrateAt = startup.indexOf("npm run migrate");
  const serverAt = startup.indexOf("server.js");
  assert.ok(migrateAt !== -1, "startup runs `npm run migrate`");
  assert.ok(serverAt !== -1, "startup runs the server");
  assert.ok(migrateAt < serverAt, "the migration runs before the server");
  assert.match(startup, /npm run migrate\s*&&/, "a failed migration short-circuits before the server starts");
});

test("render.yaml does not rely on a paid pre-deploy hook", () => {
  const render = read("render.yaml");

  // The free plan has no preDeployCommand; the migration runs in the container
  // on startup instead (asserted above). Guard against the KEY creeping back —
  // matched at line start so the explanatory comment above doesn't count.
  assert.doesNotMatch(render, /^\s*preDeployCommand\s*:/m, "no preDeployCommand on the free plan");
});

test("the runner image carries the migration tooling the pre-deploy step needs", () => {
  const dockerfile = read("Dockerfile");

  // The migration source (and its .sql files) and the package.json that holds
  // the `migrate` script are copied into the final image; without them the
  // pre-deploy `npm run migrate` would have nothing to run.
  assert.match(dockerfile, /COPY[^\n]*\/app\/lib\/db[^\n]*lib\/db/, "lib/db is copied into the runner");
  assert.match(dockerfile, /COPY[^\n]*\/app\/package\.json[^\n]*package\.json/, "package.json is copied into the runner");
});
