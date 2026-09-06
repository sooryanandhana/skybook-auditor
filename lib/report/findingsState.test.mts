/**
 * Tests for the findings section's four states.
 *
 * The one that matters most is "no findings". Before Step 6b the section said
 * grading had not happened, which is now false and reads to a client as "we
 * did not check" — the opposite of a clean result.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  SKIPPED_HEADING,
  SKIPPED_INTRO,
  findingsState,
  findingsSummary,
  showsSkippedPanel,
} from "./findingsState.ts";

// ---------------------------------------------------------------------------
// 1. Findings, no skipped checks
// ---------------------------------------------------------------------------

test("findings with every check run: the list speaks for itself", () => {
  const state = findingsState(2, 0);

  assert.equal(state, "findings");
  assert.equal(findingsSummary(state), "", "a list of problems needs no preamble");
  assert.equal(showsSkippedPanel(state), false);
});

// ---------------------------------------------------------------------------
// 2. No findings, no skipped checks — the genuinely clean result
// ---------------------------------------------------------------------------

test("nothing found and everything checked: says so plainly", () => {
  const state = findingsState(0, 0);

  assert.equal(state, "clean");
  assert.equal(findingsSummary(state), "No issues found by the checks that were run.");
  assert.equal(showsSkippedPanel(state), false);
});

test("a clean result never suggests the checks did not run", () => {
  const summary = findingsSummary(findingsState(0, 0));

  assert.match(summary, /checks that were run/);
  assert.ok(!/not been graded|has not run|still to come/i.test(summary));
});

// ---------------------------------------------------------------------------
// 3. No findings, some skipped — the case that caused this change
// ---------------------------------------------------------------------------

test("nothing found but some checks skipped: does not overstate the result", () => {
  // The real bbc.co.uk case: twelve rules ran, eight passed, four could not
  // be evaluated. Calling that "clean" would claim more than we measured.
  const state = findingsState(0, 4);

  assert.equal(state, "clean-with-skipped");
  assert.equal(
    findingsSummary(state),
    "No issues were found by the checks that completed, but some checks could not be evaluated.",
  );
  assert.equal(showsSkippedPanel(state), true);
});

test("that state is different from a fully clean one", () => {
  assert.notEqual(findingsState(0, 0), findingsState(0, 1));
  assert.notEqual(findingsSummary(findingsState(0, 0)), findingsSummary(findingsState(0, 1)));
});

// ---------------------------------------------------------------------------
// 4. Findings plus skipped checks
// ---------------------------------------------------------------------------

test("findings plus skipped checks: both are shown, findings first", () => {
  const state = findingsState(3, 2);

  assert.equal(state, "findings-with-skipped");
  assert.equal(findingsSummary(state), "", "the findings lead; the notice is secondary");
  assert.equal(showsSkippedPanel(state), true);
});

// ---------------------------------------------------------------------------
// The stale message can no longer appear
// ---------------------------------------------------------------------------

test("no state produces the old 'nothing has been graded yet' wording", () => {
  const states = [
    findingsState(0, 0),
    findingsState(0, 5),
    findingsState(4, 0),
    findingsState(4, 5),
  ];

  for (const state of states) {
    const summary = findingsSummary(state);
    for (const stale of [
      "nothing has been graded",
      "not been graded",
      "Step 6",
      "still to come",
    ]) {
      assert.ok(
        !summary.toLowerCase().includes(stale.toLowerCase()),
        `"${stale}" must not appear for state ${state}`,
      );
    }
  }
});

test("the stale wording is gone from the page source itself", () => {
  // The function above can be right while the component still hardcodes the
  // old sentence, so the source is checked directly.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const pageSource = fs.readFileSync(path.join(here, "..", "..", "app", "page.tsx"), "utf8");

  for (const stale of [
    "nothing has been graded yet",
    "Step 6 adds the rules",
    "are still to come",
  ]) {
    assert.ok(!pageSource.includes(stale), `page.tsx still contains: "${stale}"`);
  }
});

// ---------------------------------------------------------------------------
// Skipped checks are never findings
// ---------------------------------------------------------------------------

test("the skipped panel is worded as neither a problem nor a pass", () => {
  assert.equal(SKIPPED_HEADING, "Checks not evaluated");

  // Nothing that reads as a fault...
  for (const alarming of ["fail", "error", "problem", "warning", "issue"]) {
    assert.ok(
      !SKIPPED_HEADING.toLowerCase().includes(alarming),
      `the heading must not read as a fault (found "${alarming}")`,
    );
  }

  // ...and nothing that reads as a clean bill of health either.
  assert.match(SKIPPED_INTRO, /nothing is claimed about them/);
});

test("the summary never labels skipped checks with a severity", () => {
  for (const count of [1, 4, 20]) {
    const summary = findingsSummary(findingsState(0, count));
    for (const severity of ["critical", "high", "medium", "good"]) {
      assert.ok(
        !summary.toLowerCase().includes(severity),
        `a skipped check must never be graded (found "${severity}")`,
      );
    }
  }
});

test("the skipped panel appears only when something was actually skipped", () => {
  assert.equal(showsSkippedPanel(findingsState(0, 0)), false);
  assert.equal(showsSkippedPanel(findingsState(9, 0)), false);
  assert.equal(showsSkippedPanel(findingsState(0, 1)), true);
  assert.equal(showsSkippedPanel(findingsState(9, 1)), true);
});

test("every count combination resolves to exactly one state", () => {
  const seen = new Set<string>();
  for (const findings of [0, 1, 7]) {
    for (const skipped of [0, 1, 7]) {
      seen.add(findingsState(findings, skipped));
    }
  }
  assert.equal(seen.size, 4, "all four states must be reachable and distinct");
});
