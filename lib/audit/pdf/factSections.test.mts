/**
 * The fact groups, with and without a section around them (CP1 F6, CP3 step 3a).
 *
 * Run with:  npm test
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { factGroupsHtml, factSectionsHtml } from "./factSections.ts";
import { factTable } from "./facts.ts";
import { HOSTILE } from "./testDocument.fixture.mts";
import type { PdfFactSection } from "../pdfDocument.ts";

const GROUPS: readonly PdfFactSection[] = [
  { heading: "Security", facts: [{ label: "X-Frame-Options", value: "DENY" }] },
  { heading: "Empty", facts: [] },
  { heading: `Certificate ${HOSTILE}`, facts: [{ label: "Issuer", value: HOSTILE, note: "A note." }] },
];

test("table-only groups carry no section and no section heading", () => {
  const out = factGroupsHtml(GROUPS);
  assert.ok(!out.includes("<section"), "no section");
  assert.ok(!out.includes("<h2"), "no section heading");
  assert.equal((out.match(/<div class="fact-group">/g) ?? []).length, 2, "one group per group with rows");
  assert.equal((out.match(/<h3>/g) ?? []).length, 2, "each group keeps its own sub-heading");
});

test("each group is its heading and the one shared fact table, in order", () => {
  const out = factGroupsHtml(GROUPS);
  const security = `<div class="fact-group"><h3>Security</h3>${factTable(GROUPS[0].facts)}</div>`;
  assert.ok(out.startsWith(security), "the first group, exactly");
  assert.ok(out.indexOf("Security") < out.indexOf("Certificate"), "groups keep their order");
});

test("a group with no rows produces nothing, and all-empty input produces nothing at all", () => {
  assert.ok(!factGroupsHtml(GROUPS).includes("Empty"));
  assert.equal(factGroupsHtml([]), "");
  assert.equal(factGroupsHtml([{ heading: "Empty", facts: [] }]), "");
});

test("values from the audited site are escaped", () => {
  const out = factGroupsHtml(GROUPS);
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("the existing section renderer is unchanged: the same groups, wrapped in its section and heading", () => {
  assert.equal(
    factSectionsHtml("What we measured", GROUPS, "measured"),
    `<section class="measured"><h2>What we measured</h2>` + factGroupsHtml(GROUPS) + `</section>`,
  );
  assert.equal(factSectionsHtml("What we measured", [{ heading: "Empty", facts: [] }], "measured"), "", "still omitted when empty");
});

test("a section key is never printed", () => {
  const out = factGroupsHtml([{ key: "security", heading: "Security", facts: [{ label: "l", value: "v" }] }]);
  assert.ok(!out.includes("key"));
  assert.equal(out, factGroupsHtml([{ heading: "Security", facts: [{ label: "l", value: "v" }] }]));
});
