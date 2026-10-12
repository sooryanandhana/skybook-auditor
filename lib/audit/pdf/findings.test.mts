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
// Commentary never prints the measured text a second time
// ---------------------------------------------------------------------------

/*
 * A MODEL OFTEN ANSWERS WITH THE CARD'S OWN SENTENCES. Asked what was found it
 * returns the evidence, and asked what to do it returns the remediation, both
 * of which are already on the card directly above. In a real report that made
 * every card half as long again and put one finding on each page.
 *
 * THE RISK RUNS BOTH WAYS, so both are tested. Printing a repeat wastes the
 * reader's time; dropping something the model really did add loses content.
 */

/** The measured sentences on the page finding's card, as the fixture has them. */
const EVIDENCE = pageFinding().evidence;
const REMEDIATION = pageFinding().remediation;
/** Prose that repeats neither of them. */
const NEW_EXPLANATION = "Search engines write their own summary when a page supplies none.";
const NEW_IMPACT = "The snippet a customer reads is chosen for you.";
const NEW_RECOMMENDATION = "Write a description for each page.";

/** The page finding's card, carrying the given commentary. */
function cardWith(commentary: PdfFinding["commentary"]): string {
  return findingsHtml(sectionOf([{ ...pageFinding(), commentary }]), LABELS);
}

const countOf = (out: string, needle: string) => out.split(needle).length - 1;

test("an explanation that repeats the measured evidence is not printed again", () => {
  const out = cardWith({ explanation: EVIDENCE, businessImpact: NEW_IMPACT, recommendation: NEW_RECOMMENDATION });

  assert.equal(countOf(out, EVIDENCE), 1, "the evidence is on the card once, as measured text");
  assert.ok(positionOf(out, EVIDENCE) < positionOf(out, "What to do"), "and that once is the measured one");
  assert.ok(out.includes(NEW_IMPACT), "what the model added is kept");
  assert.ok(out.includes(NEW_RECOMMENDATION));
});

test("a recommendation that repeats the remediation is dropped with its sub-label", () => {
  const out = cardWith({ explanation: NEW_EXPLANATION, businessImpact: NEW_IMPACT, recommendation: REMEDIATION });

  assert.equal(countOf(out, REMEDIATION), 1, "the remediation is on the card once");
  assert.ok(out.includes('class="remediation"'), "in the measured What to do panel");
  assert.ok(!out.includes("Suggested next step"), "and no label is left heading nothing");
  assert.ok(out.includes(NEW_EXPLANATION), "the rest of the commentary is kept");
  assert.ok(out.includes("Why it matters"));
  assert.ok(out.includes(NEW_IMPACT));
});

test("capitals, spacing and a closing full stop do not make a repeat into new text", () => {
  // Differences no reader would notice. Without this a stray space or a missing
  // full stop from the model would bring the whole repeat back.
  const out = cardWith({
    explanation: "  no META description   tag was found",
    businessImpact: NEW_IMPACT,
    recommendation: "WRITE A DESCRIPTION OF ABOUT 155 CHARACTERS",
  });

  assert.ok(!out.includes("META"), "the re-spaced, re-cased evidence is recognised");
  assert.ok(!out.includes("WRITE A DESCRIPTION"), "and so is the remediation");
  assert.ok(!out.includes("Suggested next step"));
  assert.equal(countOf(out, EVIDENCE), 1, "the measured evidence is untouched");
  assert.equal(countOf(out, REMEDIATION), 1, "and so is the measured remediation");
  assert.ok(out.includes(NEW_IMPACT));
});

test("commentary that repeats nothing keeps all three parts, in contract order", () => {
  const out = cardWith({
    explanation: NEW_EXPLANATION,
    businessImpact: NEW_IMPACT,
    recommendation: NEW_RECOMMENDATION,
  });

  assert.ok(positionOf(out, "AI explanation") < positionOf(out, NEW_EXPLANATION));
  assert.ok(positionOf(out, NEW_EXPLANATION) < positionOf(out, "Why it matters"));
  assert.ok(positionOf(out, "Why it matters") < positionOf(out, NEW_IMPACT));
  assert.ok(positionOf(out, NEW_IMPACT) < positionOf(out, "Suggested next step"));
  assert.ok(positionOf(out, "Suggested next step") < positionOf(out, NEW_RECOMMENDATION));
});

test("whatever commentary is kept is still labelled as AI-written", () => {
  /*
   * THE LABEL IS NOT PART OF THE EXPLANATION. It heads the box, so removing a
   * repeated explanation must not take the reader's only notice that the rest
   * was written by a model. Each part is tried as the single survivor.
   */
  const survivors = [
    { explanation: NEW_EXPLANATION, businessImpact: EVIDENCE, recommendation: REMEDIATION },
    { explanation: EVIDENCE, businessImpact: NEW_IMPACT, recommendation: REMEDIATION },
    { explanation: EVIDENCE, businessImpact: REMEDIATION, recommendation: NEW_RECOMMENDATION },
  ];

  for (const commentary of survivors) {
    const out = cardWith(commentary);

    assert.equal(countOf(out, 'class="commentary"'), 1, "the box is drawn");
    assert.equal(countOf(out, "AI explanation"), 1, "and it carries the AI label, once");
    assert.ok(positionOf(out, "What to do") < positionOf(out, "AI explanation"), "after the measured parts");
  }
});

test("commentary that only repeats the measured text draws no box at all", () => {
  // An empty tinted panel under a label would read as something gone missing.
  const out = cardWith({ explanation: EVIDENCE, businessImpact: REMEDIATION, recommendation: REMEDIATION });

  assert.ok(!out.includes('class="commentary"'));
  assert.ok(!out.includes("AI explanation"));
  assert.ok(!out.includes("Why it matters"));
  assert.ok(!out.includes("Suggested next step"));
  assert.equal(countOf(out, EVIDENCE), 1, "and the finding itself is complete");
  assert.equal(countOf(out, REMEDIATION), 1);
});

test("a card with no commentary still draws no box", () => {
  // The same card as above with the commentary taken away, so the only thing
  // that differs from the tests around it is the absence.
  const out = cardWith(null);

  assert.ok(!out.includes('class="commentary"'));
  assert.ok(!out.includes("AI explanation"));
  assert.equal(countOf(out, EVIDENCE), 1);
  assert.equal(countOf(out, REMEDIATION), 1);
});

test("wording that is close to the measured text but different is kept", () => {
  /*
   * THE TEST THAT CATCHES AN EAGER MATCHER. A sentence that adds or changes a
   * word is a different sentence. A comparison loosened to "similar enough"
   * would start deleting things the model really wrote, and this is where that
   * would show.
   */
  const closeExplanation = "No meta description tag was found on this page.";
  const closeRecommendation = "Write a description of about 150 characters.";
  const out = cardWith({
    explanation: closeExplanation,
    businessImpact: NEW_IMPACT,
    recommendation: closeRecommendation,
  });

  assert.ok(out.includes(closeExplanation));
  assert.ok(out.includes(closeRecommendation));
  assert.ok(out.includes("Suggested next step"), "with its sub-label");
  assert.ok(positionOf(out, EVIDENCE) < positionOf(out, closeExplanation), "after the measured evidence");
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
