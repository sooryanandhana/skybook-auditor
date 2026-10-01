/**
 * The PostgreSQL driver stays inside this folder.
 *
 * WHY THIS GUARD EXISTS. `pg` is the one database driver, and the two crawler
 * dependency guards (crawlSite.test, sitemap.test) allow it into package.json
 * only on the promise that it is confined to `lib/db`. This is that promise,
 * stated as a test: the rest of the application reaches the database through the
 * small surface in this folder (the pool and the repositories built on it), not
 * by importing `pg` directly. One place owns the connection, and one place is
 * where a connection bug can be.
 *
 * Walked rather than listed, so a new route, collector or auth module is covered
 * on the day it is written rather than on the day somebody remembers this file.
 * Modelled on the matching walk that confines the browser to `lib/audit/pdf`.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";

test("nothing outside lib/db imports the pg driver", () => {
  const root = new URL("../../lib/", import.meta.url);
  const offenders: string[] = [];

  const walk = (dir: URL): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) {
        // This folder is the one place allowed to import pg.
        if (entry.name !== "db") walk(child);
        continue;
      }
      if (!/\.(ts|mts)$/.test(entry.name)) continue;
      // Imports only, not mentions: the crawler guards name "pg" to argue about
      // it, and a check that could not tell an import from a mention would
      // report those guards as the breach.
      if (/from\s+["']pg["']/.test(fs.readFileSync(child, "utf8"))) {
        offenders.push(entry.name);
      }
    }
  };

  walk(root);
  assert.deepEqual(offenders, [], "only lib/db may import the database driver");
});
