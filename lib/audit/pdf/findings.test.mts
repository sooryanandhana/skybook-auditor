/**
 * Tests for the part of the document a client acts on.
 *
 * FIVE PROPERTIES CARRY THIS FILE, and each of them is a way the document
 * could tell a client something untrue rather than merely look wrong.
 *
 *   The order is the aggregator's and is never re-sorted.
 *   A site-wide finding is never given a page denominator.
 *   A sample of affected pages says it is a sample.
 *   Commentary is last, labelled, and absent without complaint.
 *   Nothing from the site or the model becomes markup.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { findingsHtml } from "./findings.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import type { PdfFinding, PdfFindingSection, PdfLabels } from "../pdfDocument.ts";

const LABELS: PdfLabels = testDocument().labels;

const siteSection = () => testDocument().siteFindings;
const pageSection = () => testDocument().pageFindings;
const siteFinding = () => siteSection().groups[0].findings[0];
const pageFinding = () => pageSection().groups[0].findings[0];

/** A section built from the given findings, in one group. */
function sectionOf(findings: readonly PdfFinding[]): PdfFindingSection {
  return {
    heading: "Site-wide issues",
    intro: "These apply to the whole website.",
    count: findings.length,
    groups: [{ category: "security", label: "Security", findings }],
  };
}

const positionOf = (out: string, needle: string) => out.indexOf(needle);

// ---------------------------------------------------------------------------
// Order, exactly as given
// ---------------------------------------------------------------------------

test("findings render in the order the aggregator supplied", () => {
  const one = { ...siteFinding(), ruleId: "a", title: "AAA first" };
  const two = { ...siteFinding(), ruleId: "b", title: "BBB second" };
  const three = { ...siteFinding(), ruleId: "c", title: "CCC third" };

  const out = findingsHtml(sectionOf([one, two, three]), LABELS);

  assert.ok(positionOf(out, "AAA first") < positionOf(out, "BBB second"));
  assert.ok(positionOf(out, "BBB second") < positionOf(out, "CCC third"));
});

test("a lower severity listed first stays first", () => {
  /*
   * THE TEST THAT CATCHES A HELPFUL RENDERER. The aggregator sorts by severity
   * already, so anything here that re-sorted would look like an improvement
   * and would silently disagree with the screen about which problem matters
   * most. Given a deliberately "wrong" order, the renderer must keep it.
   */
  const medium = { ...siteFinding(), title: "MEDIUM one", severity: "medium" as const, severityLabel: "Medium" };
  const critical = { ...siteFinding(), title: "CRITICAL one", severity: "critical" as const, severityLabel: "Critical" };

  const out = findingsHtml(sectionOf([medium, critical]), LABELS);

  assert.ok(positionOf(out, "MEDIUM one") < positionOf(out, "CRITICAL one"));
});

test("groups render in the order they were given", () => {
  const section: PdfFindingSection = {
    heading: "Page-level issues",
    intro: "x",
    count: 2,
    groups: [
      { category: "seo", label: "Search visibility", findings: [pageFinding()] },
      { category: "security", label: "Security", findings: [siteFinding()] },
    ],
  };
  const out = findingsHtml(section, LABELS);

  assert.ok(positionOf(out, "Search visibility") < positionOf(out, "Security"));
});

test("a thirty-finding section renders every one, in order, with and without commentary", () => {
  /*
   * THE STEP'S ACCEPTANCE CRITERION. Thirty is the whole rule inventory, so it
   * is the largest section this system can produce. Half carry commentary and
   * half do not, because a renderer that dropped one or the other would still
   * look right on a fixture where every finding is the same.
   */
  const thirty = Array.from({ length: 30 }, (_value, index) => ({
    ...siteFinding(),
    ruleId: `rule.${index}`,
    title: `FINDING-${String(index).padStart(2, "0")}`,
    commentary:
      index % 2 === 0
        ? null
        : {
            explanation: `EXPLAIN-${index}`,
            businessImpact: `IMPACT-${index}`,
            recommendation: `RECOMMEND-${index}`,
          },
  }));

  const out = findingsHtml(sectionOf(thirty), LABELS);

  for (const finding of thirty) {
    assert.ok(out.includes(finding.title), `${finding.title} is on the page`);
  }

  const positions = thirty.map((finding) => positionOf(out, finding.title));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "and in the order given");

  assert.equal((out.match(/AI explanation/g) ?? []).length, 15, "half carry commentary");
  assert.ok(out.includes("EXPLAIN-1"));
  assert.ok(out.includes("FINDING-00"), "and the ones without it are still complete");
});

// ---------------------------------------------------------------------------
// Scope, and the denominator a site finding must never have
// ---------------------------------------------------------------------------

test("the scope is spelled out in words on every finding", () => {
  assert.ok(findingsHtml(siteSection(), LABELS).includes("Site-wide"));
  assert.ok(findingsHtml(pageSection(), LABELS).includes("Page-level"));
});

test("a site-wide finding carries no reach line at all", () => {
  // 7A §8: one certificate, one SPF record. "128 of 128 pages affected" about
  // a single DNS record is a false statement, not a display quirk.
  const out = findingsHtml(siteSection(), LABELS);

  assert.ok(!out.includes("class=\"reach\""));
  assert.ok(!/\d+ of \d+/.test(out), "and no denominator anywhere near it");
});

test("a page finding carries the reach the projection worked out", () => {
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("19 of 128 evaluated pages"));
});

test("a page finding with no reach is shown without one, never with an invented one", () => {
  const out = findingsHtml(sectionOf([{ ...pageFinding(), reach: null }]), LABELS);

  assert.ok(!out.includes("class=\"reach\""));
  assert.ok(out.includes("Page-level"), "the scope still appears");
});

// ---------------------------------------------------------------------------
// The affected sample says it is a sample
// ---------------------------------------------------------------------------

test("affected pages are listed, and the sample note is shown with them", () => {
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("https://example.com/about"));
  assert.ok(out.includes("https://example.com/contact"));
  assert.ok(out.includes("Showing 2 of 19 affected pages."));
});

test("a finding with no affected pages renders no list", () => {
  const out = findingsHtml(siteSection(), LABELS);
  assert.ok(!out.includes("affected-list"));
});

test("the affected list is a real list, so a screen reader can follow it", () => {
  const out = findingsHtml(pageSection(), LABELS);
  assert.match(out, /<ul class="affected-list"><li>/);
});

// ---------------------------------------------------------------------------
// Commentary: last, labelled, and optional
// ---------------------------------------------------------------------------

test("commentary comes after the evidence and the remediation", () => {
  // 7A §9. The order on the page matches the order of authority: what we
  // measured, what we advise, then what a model said about it.
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(positionOf(out, "No meta description tag was found.") < positionOf(out, "What to do"));
  assert.ok(positionOf(out, "What to do") < positionOf(out, "AI explanation"));
});

test("commentary is labelled in words as AI-written", () => {
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("AI explanation"));
  assert.ok(out.includes("Why it matters"));
  assert.ok(out.includes("Suggested next step"));
});

test("all three commentary fields are shown, in contract order", () => {
  const out = findingsHtml(pageSection(), LABELS);
  const written = pageFinding().commentary!;

  assert.ok(positionOf(out, written.explanation) < positionOf(out, written.businessImpact));
  assert.ok(positionOf(out, written.businessImpact) < positionOf(out, written.recommendation));
});

test("a finding without commentary renders without complaint", () => {
  // A finding with no writing beside it is a complete finding: its evidence
  // and its remediation were ours all along.
  const out = findingsHtml(siteSection(), LABELS);

  assert.ok(!out.includes("AI explanation"));
  assert.ok(!out.includes("commentary"));
  assert.ok(out.includes("No SPF record"), "and the finding is still there");
  assert.ok(out.includes("Publish an SPF record for this domain."));
});

test("the remediation is labelled and set apart from the evidence", () => {
  // 7A §8. On screen these were once two grey paragraphs of the same size.
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("What to do"));
  assert.ok(out.includes('class="remediation"'));
});

// ---------------------------------------------------------------------------
// Severity carries its word, never colour alone
// ---------------------------------------------------------------------------

test("every severity chip carries the word as well as the class", () => {
  for (const severity of ["critical", "high", "medium", "good"] as const) {
    const label = severity[0].toUpperCase() + severity.slice(1);
    const out = findingsHtml(sectionOf([{ ...siteFinding(), severity, severityLabel: label }]), LABELS);

    assert.ok(out.includes(`chip-${severity}`), `${severity} gets its colour class`);
    assert.ok(out.includes(`>${label}</span>`), `${severity} gets its word`);
  }
});

test("the chip label is the projection's, not one worked out here", () => {
  const out = findingsHtml(
    sectionOf([{ ...siteFinding(), severity: "high", severityLabel: "SEVERITYWORD" }]),
    LABELS,
  );

  assert.ok(out.includes("SEVERITYWORD"));
});

// ---------------------------------------------------------------------------
// Empty sections
// ---------------------------------------------------------------------------

test("a section with no findings produces nothing at all", () => {
  // 7A §19: with no site-wide findings that section is omitted and the
  // page-level one still appears.
  assert.equal(findingsHtml({ ...siteSection(), count: 0, groups: [] }, LABELS), "");
});

test("a section that says it has findings but carries no group produces nothing", () => {
  assert.equal(findingsHtml({ ...siteSection(), groups: [] }, LABELS), "");
});

// ---------------------------------------------------------------------------
// Nothing becomes markup
// ---------------------------------------------------------------------------

test("markup in a finding's evidence is rendered as text", () => {
  const out = findingsHtml(siteSection(), LABELS);

  assert.ok(out.includes("&lt;script&gt;"), "the audited site's tag is escaped");
  assert.ok(!out.includes(HOSTILE), "and never appears raw");
});

test("markup in the model's commentary is rendered as text", () => {
  const out = findingsHtml(
    sectionOf([
      {
        ...pageFinding(),
        commentary: {
          explanation: "<b>bold</b>",
          businessImpact: '<img src=x onerror="steal()">',
          recommendation: "</article><script>steal()</script>",
        },
      },
    ]),
    LABELS,
  );

  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;b&gt;bold&lt;/b&gt;"));
});

test("no document value adds an element to the section", () => {
  const plain = findingsHtml(sectionOf([{ ...siteFinding(), evidence: "plain", title: "plain" }]), LABELS);
  const hostile = findingsHtml(
    sectionOf([
      {
        ...siteFinding(),
        evidence: "<div><span>x</span></div>",
        title: "<h1>x</h1>",
        remediation: "<p>x</p>",
      },
    ]),
    LABELS,
  );

  assert.equal(
    (hostile.match(/</g) ?? []).length,
    (plain.match(/</g) ?? []).length,
    "markup in a document value adds no elements",
  );
});

// ---------------------------------------------------------------------------
// The labels come from the document, not from here
// ---------------------------------------------------------------------------

test("the labels are the document's, so the screen and the PDF cannot drift", () => {
  const out = findingsHtml(pageSection(), {
    ...LABELS,
    remediation: "REMEDIATIONLABEL",
    aiExplanation: "EXPLANATIONLABEL",
    aiImpact: "IMPACTLABEL",
    aiRecommendation: "RECOMMENDATIONLABEL",
  });

  for (const label of ["REMEDIATIONLABEL", "EXPLANATIONLABEL", "IMPACTLABEL", "RECOMMENDATIONLABEL"]) {
    assert.ok(out.includes(label), `${label} came from the document`);
  }
  assert.ok(!out.includes("What to do"), "and nothing is hard-coded here");
});
