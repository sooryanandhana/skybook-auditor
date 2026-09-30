/**
 * The PDF client-summary section: five parts when the model contributed,
 * nothing when it did not, and every string escaped as text.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { clientSummaryHtml } from "./clientSummary.ts";
import { testDocument } from "./testDocument.fixture.mts";
import type { ClientAiSummary, PdfLabels } from "../pdfDocument.ts";

const LABELS: PdfLabels = testDocument().labels;

const full = (over: Partial<ClientAiSummary> = {}): ClientAiSummary => ({
  overallSummary: "This site has two issues worth attention.",
  whatWeChecked: ["Security — the protections that keep the site safe.", "Search visibility — how the site appears in search."],
  keyFindings: [
    { finding: "No SPF record", explanation: "Senders cannot be verified.", impact: "Mail may be marked as spam." },
  ],
  recommendations: [{ action: "Publish an SPF record.", reason: "Mail may be marked as spam." }],
  nextSteps: ["Resolve the high-priority issue: No SPF record."],
  ...over,
});

test("a full summary renders all five parts, labelled and in order", () => {
  const out = clientSummaryHtml(full(), LABELS, "PROVENANCE NOTE");

  assert.ok(out.includes("<h2>AI summary</h2>"), "the section heading");
  assert.ok(out.includes("This site has two issues worth attention."), "overall summary");
  assert.ok(out.includes("What we checked"), "what we checked heading");
  assert.ok(out.includes("Security — the protections that keep the site safe."), "a checked area");
  assert.ok(out.includes("Key findings"), "key findings heading");
  assert.ok(out.includes("No SPF record"), "a finding title");
  assert.ok(out.includes("Senders cannot be verified."), "a finding explanation");
  assert.ok(out.includes("Recommended improvements"), "recommendations heading");
  assert.ok(out.includes("Publish an SPF record."), "a recommendation action");
  assert.ok(out.includes("Next steps"), "next steps heading");
  assert.ok(out.includes("Resolve the high-priority issue: No SPF record."), "a next step");
  assert.ok(out.includes("PROVENANCE NOTE"), "the provenance note rides with the panel");
  assert.ok(out.includes("AI summary"), "the AI provenance label");
});

test("the order of the parts is summary, checked, findings, improvements, steps", () => {
  const out = clientSummaryHtml(full(), LABELS, "");
  const at = (needle: string) => out.indexOf(needle);
  assert.ok(
    at("This site has two issues") < at("What we checked") &&
      at("What we checked") < at("Key findings") &&
      at("Key findings") < at("Recommended improvements") &&
      at("Recommended improvements") < at("Next steps"),
    "the five parts are in the intended reading order",
  );
});

test("with no model narrative the section is omitted entirely", () => {
  // Derived parts alone are not enough: the measured sections carry the report.
  const derivedOnly = full({ overallSummary: null, keyFindings: [], recommendations: [] });
  assert.equal(clientSummaryHtml(derivedOnly, LABELS, ""), "", "no section at all");
});

test("key findings alone (summary refused) still render the section", () => {
  const out = clientSummaryHtml(full({ overallSummary: null }), LABELS, "");
  assert.ok(out.includes("<h2>AI summary</h2>"));
  assert.ok(out.includes("No SPF record"));
});

test("the model's words are rendered as text, never as markup", () => {
  const out = clientSummaryHtml(full({ overallSummary: "<script>steal()</script>" }), LABELS, "");
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("an empty note produces no note paragraph", () => {
  const out = clientSummaryHtml(full(), LABELS, "");
  assert.ok(!out.includes('class="ai-note"'), "no empty note line");
});
