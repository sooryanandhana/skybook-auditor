/**
 * Tests for the audit's time budgets.
 *
 * These are relationships, not values. The point of moving the speed check to
 * its own endpoint was that a slow Google can no longer slow the audit, and
 * that guarantee lives entirely in how these numbers relate to each other —
 * so it is worth a test rather than two route files trusting each other.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  AUDIT_BUDGET_MS,
  PERFORMANCE_BUDGET_MS,
  SITE_CHECKS_BUDGET_MS,
} from "./budgets.ts";
import { PAGESPEED_TIMEOUT_MS } from "./collector/performanceChecks.ts";

test("the PageSpeed cap is 90 seconds", () => {
  assert.equal(PAGESPEED_TIMEOUT_MS, 90_000);
});

test("the main audit budget is 30 seconds", () => {
  assert.equal(AUDIT_BUDGET_MS, 30_000);
});

test("the site checks stay capped inside the audit budget", () => {
  assert.equal(SITE_CHECKS_BUDGET_MS, 10_000);
  assert.ok(SITE_CHECKS_BUDGET_MS < AUDIT_BUDGET_MS);
});

test("the 90-second speed check does not leak into the audit budget", () => {
  // The whole reason for the separate endpoint. If these two were ever tied
  // together, a slow Google would once again mean a dead page.
  assert.ok(
    AUDIT_BUDGET_MS < PAGESPEED_TIMEOUT_MS,
    "the audit must finish well before Google's cap is even reached",
  );
  assert.equal(
    AUDIT_BUDGET_MS,
    30_000,
    "raising the speed cap must never move the audit's budget",
  );
});

test("the performance endpoint leaves room for the cap and the retry pause", () => {
  // The cap should be what stops a slow reply, not the endpoint deadline —
  // otherwise a clear "Google took too long" becomes a vaguer timeout.
  assert.ok(
    PERFORMANCE_BUDGET_MS > PAGESPEED_TIMEOUT_MS,
    "the endpoint budget must sit above the per-request cap",
  );
  assert.ok(
    PERFORMANCE_BUDGET_MS - PAGESPEED_TIMEOUT_MS >= 300,
    "and leave at least the retry delay in hand",
  );
});

test("the performance budget is the only one that grew", () => {
  assert.equal(PERFORMANCE_BUDGET_MS, 95_000);
  assert.equal(AUDIT_BUDGET_MS, 30_000);
  assert.equal(SITE_CHECKS_BUDGET_MS, 10_000);
});
