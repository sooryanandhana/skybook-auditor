/**
 * Tests for the part of the document a client acts on.
 *
 * FIVE PROPERTIES CARRY THIS FILE, and each of them is a way the document
 * could tell a client something untrue rather than merely look wrong.
 *
 *   The order is the aggregator's and is never re-sorted.
 *   A site-wide finding is never given a page denominator.
 *   A sample of affected pages says it is a sample.
 *   No AI writing is printed on a card, even when the model wrote some.
 *   Nothing from the site becomes markup.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  AFFECTED_LIST_TRUNCATED,
  EVIDENCE_HEADING,
  NO_PAGE_READ_SENTENCE,
  PAGE_LEVEL_ISSUES_HEADING,
  PAGE_LEVEL_ISSUES_INTRO,
  WHAT_FIXING_ACHIEVES_LABEL,
  findingCardsHtml,
  findingsHtml,
  pageLevelIssuesHtml,
} from "./findings.ts";
import { documentHtml } from "./shell.ts";
import { HOSTILE, testDocument } from "./testDocument.fixture.mts";
import { SECTION_INTROS } from "../../report/reportSections.ts";
import type { PdfFinding, PdfFindingSection, PdfLabels } from "../pdfDocument.ts";
import { EVIDENCE_HEADINGS, evidenceHeadingWithReach } from "../../report/findingExplainers.ts";
import { AFFECTED_LIST_TRUNCATED as REPORT_AFFECTED_LIST_TRUNCATED } from "../../report/reportSections.ts";

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

  assert.ok(!out.includes("AI explanation"), "no card carries an AI block");
  assert.ok(!out.includes("EXPLAIN-1"), "even the ones the model wrote about");
  assert.ok(out.includes("FINDING-00") && out.includes("FINDING-01"), "and every card is still complete");
});

// ---------------------------------------------------------------------------
// Scope, and the denominator a site finding must never have
// ---------------------------------------------------------------------------

test("the scope is spelled out in words on every finding, as the approved scope line", () => {
  // CP1 §6 scope lines, in place of the old "Site-wide" / "Page-level" label (CP3-O2).
  const site = findingsHtml(siteSection(), LABELS);
  const page = findingsHtml(pageSection(), LABELS);
  assert.ok(site.includes('<p class="finding-meta">Applies to the whole domain: example.com.</p>'));
  assert.ok(page.includes('<p class="finding-meta">Found on 19 of 128 pages checked.</p>'));
  assert.ok(!site.includes('class="scope"') && !page.includes('class="scope"'), "the old scope label is gone");
});

test("a site-wide finding carries no reach line at all", () => {
  // 7A §8: one certificate, one SPF record. "128 of 128 pages affected" about
  // a single DNS record is a false statement, not a display quirk.
  const out = findingsHtml(siteSection(), LABELS);

  assert.ok(!out.includes("class=\"reach\""));
  assert.ok(!/\d+ of \d+/.test(out), "and no denominator anywhere near it");
});

test("a page finding states the counts the projection carried", () => {
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("Found on 19 of 128 pages checked."));
});

test("a page finding with no counts is shown without a scope line, never with an invented one", () => {
  const out = findingsHtml(sectionOf([{ ...pageFinding(), reach: null, scopeCounts: null }]), LABELS);

  assert.ok(!out.includes("finding-meta"), "no scope line at all");
  assert.ok(!/Found on/.test(out));
  assert.ok(!/\d+ of \d+/.test(out), "and no figure anywhere on the card");
});

// ---------------------------------------------------------------------------
// The affected sample says it is a sample
// ---------------------------------------------------------------------------

test("affected pages are listed, and a cut-short list says so without a figure (TR1)", () => {
  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(out.includes("https://example.com/about"));
  assert.ok(out.includes("https://example.com/contact"));
  assert.ok(out.includes('<p class="note">Further affected pages are not listed.</p>'));
  assert.ok(!out.includes("Showing"), "the old count note is gone (CP3-Q6)");
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
// No AI writing on a card
// ---------------------------------------------------------------------------

/*
 * A CARD EXPLAINS ITS FINDING ONCE, IN APPROVED WORDS. The model's per-finding
 * commentary may still be present on the document -- the fixture's page
 * finding carries some -- and none of it reaches the card: no box, no label,
 * no sentence.
 */

test("a finding the model wrote about shows no AI block", () => {
  const written = pageFinding().commentary;
  assert.ok(written !== null, "the fixture really does carry commentary");

  const out = findingsHtml(pageSection(), LABELS);

  assert.ok(!out.includes('class="commentary"'));
  assert.ok(!out.includes("AI explanation"));
  assert.ok(!out.includes("Suggested next step"));
  for (const text of [written.explanation, written.businessImpact, written.recommendation]) {
    assert.ok(!out.includes(text), `the model's sentence is not printed: ${text}`);
  }
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
  assert.ok(positionOf(out, "No meta description tag was found.") < positionOf(out, "What to do"));
});

test("the measured evidence and the remediation each appear once", () => {
  const finding = pageFinding();
  const out = findingsHtml(sectionOf([finding]), LABELS);
  const countOf = (needle: string) => out.split(needle).length - 1;

  assert.equal(countOf(finding.evidence), 1);
  assert.equal(countOf(finding.remediation), 1);
});

// ---------------------------------------------------------------------------
// The scope line and evidence heading, from the projection's own fields
// ---------------------------------------------------------------------------

test("the scope line is the only line above what we found", () => {
  const out = findingsHtml(pageSection(), LABELS);
  assert.ok(out.includes('<p class="finding-meta">Found on 19 of 128 pages checked.</p><p class="finding-eyebrow">What we found</p>'));
});

test("a site card's evidence heading says it was measured for the whole domain", () => {
  const section = siteSection();
  const out = findingsHtml(
    {
      ...section,
      groups: section.groups.map((group) => ({
        ...group,
        findings: group.findings.map((finding) => ({
          ...finding,
          evidencePanel: { heading: "Measured for the whole site", facts: [{ label: "SPF", value: "Not found" }] },
        })),
      })),
    },
    LABELS,
  );
  assert.ok(out.includes('<p class="explainer-label">Evidence · Measured for the whole domain</p>'));
  assert.ok(!out.includes("Measured for the whole site"), "the projection's old panel heading is not printed");
});

test("a card with no written explanation has no intended-aim block", () => {
  const out = findingsHtml(pageSection(), LABELS) + findingsHtml(siteSection(), LABELS);
  assert.ok(!/intended to achieve/i.test(out));
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

test("hostile commentary from the model never reaches the card, raw or escaped", () => {
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
  assert.ok(!out.includes("&lt;b&gt;bold"), "not even as escaped text");
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

test("the remediation label is the document's, so the screen and the PDF cannot drift", () => {
  const out = findingsHtml(pageSection(), {
    ...LABELS,
    remediation: "REMEDIATIONLABEL",
    aiExplanation: "EXPLANATIONLABEL",
    aiImpact: "IMPACTLABEL",
    aiRecommendation: "RECOMMENDATIONLABEL",
  });

  assert.ok(out.includes("REMEDIATIONLABEL"), "it came from the document");
  assert.ok(!out.includes("What to do"), "and nothing is hard-coded here");
  for (const label of ["EXPLANATIONLABEL", "IMPACTLABEL", "RECOMMENDATIONLABEL"]) {
    assert.ok(!out.includes(label), `${label} is an AI label, and no card has an AI block`);
  }
});

// ---------------------------------------------------------------------------
// The plain-language explanation
// ---------------------------------------------------------------------------

/** The page section with its one finding given an explanation. */
function withExplainer(explainer: PdfFinding["explainer"]): PdfFindingSection {
  const section = pageSection();
  return {
    ...section,
    groups: section.groups.map((group) => ({
      ...group,
      findings: group.findings.map((finding) => ({ ...finding, explainer })),
    })),
  };
}

const EXPLAINER = {
  whatItMeans: "MEANS-TEXT",
  whyItMatters: "MATTERS-TEXT",
  possibleImpact: "IMPACT-TEXT",
  steps: ["STEP-ONE", "STEP-TWO"],
  whoFixes: "WHO-TEXT",
  whatFixingAchieves: "ACHIEVES-TEXT",
};

test("a card reads in the approved order: found, means, matters, may affect, action, steps, who, pages", () => {
  const out = findingsHtml(withExplainer(EXPLAINER), LABELS);
  const order = [
    "Page-level",
    "What we found",
    "No meta description tag was found",
    "What this means",
    "MEANS-TEXT",
    "Why it matters",
    "MATTERS-TEXT",
    "How it may affect your website or business",
    "IMPACT-TEXT",
    "What to do",
    "Write a description of about 155 characters.",
    "Steps",
    "STEP-ONE",
    "STEP-TWO",
    "Who usually fixes it",
    "WHO-TEXT",
    "https://example.com/about",
  ];
  let at = -1;
  for (const marker of order) {
    const next = out.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" comes after the part before it`);
    at = next;
  }
  assert.ok(out.includes("<ol><li>STEP-ONE</li><li>STEP-TWO</li></ol>"), "the steps are an ordered list");
});

test("a finding without an explanation renders no explanation markup", () => {
  const out = findingsHtml(withExplainer(null), LABELS);
  assert.ok(!out.includes("explainer"));
  assert.ok(!out.includes("What this means"));
  assert.ok(!out.includes("Who usually fixes it"));
});

test("explanation text is escaped like every other document value", () => {
  const out = findingsHtml(
    withExplainer({ ...EXPLAINER, whatItMeans: HOSTILE, steps: [HOSTILE, "fine"], whoFixes: HOSTILE }),
    LABELS,
  );
  assert.ok(!out.includes("<script>"), "no element was injected");
  assert.ok(out.includes("&lt;script&gt;"), "the text was kept, escaped");
});

// ---------------------------------------------------------------------------
// The evidence panel
// ---------------------------------------------------------------------------

function withPanel(panel: PdfFinding["evidencePanel"]): PdfFindingSection {
  const section = siteSection();
  return {
    ...section,
    groups: section.groups.map((group) => ({
      ...group,
      findings: group.findings.map((finding) => ({ ...finding, evidencePanel: panel })),
    })),
  };
}

test("an evidence panel shows its measured rows under the finding, escaped", () => {
  const out = findingsHtml(
    withPanel({ heading: "Measured for the whole site", facts: [{ label: "SPF", value: "Not found", note: HOSTILE }] }),
    LABELS,
  );
  assert.ok(out.includes("Evidence · Measured for the whole domain"));
  assert.ok(out.includes("<th scope=\"row\">SPF</th><td>Not found"));
  assert.ok(!out.includes("<script>"), "a measured value cannot inject markup");
  assert.ok(out.indexOf("Evidence ·") > out.indexOf("Publish an SPF record"), "evidence follows the recommended action");
});

test("no evidence panel, no evidence markup", () => {
  const out = findingsHtml(withPanel(null), LABELS);
  assert.ok(!out.includes("evidence-panel"));
});

// ---------------------------------------------------------------------------
// CP3 step 2 (F3b): the card's approved wording
// ---------------------------------------------------------------------------

/** One card, alone, through the same renderer the sections use. */
const cardOf = (finding: PdfFinding) => findingsHtml(sectionOf([finding]), LABELS);

const PANEL = { heading: "IGNORED-BY-THE-CARD", facts: [{ label: "Row", value: "Value" }] };

/** A speed finding as the projection carries one: one measured address, counts of one. */
const speedFinding = (over: Partial<PdfFinding> = {}): PdfFinding => ({
  ...pageFinding(),
  ruleId: "speed.field.lcp.slow",
  title: "Largest Contentful Paint is slow for real visitors",
  category: "speed",
  affected: [{ url: "https://example.com/", evidence: "Google rates LCP as SLOW." }],
  affectedNote: null,
  truncated: false,
  scopeCounts: { affected: 1, evaluated: 1 },
  evidenceKind: "examplePage",
  ...over,
});

test("F3b O1: the card's wording is the report layer's approved wording, letter for letter", () => {
  assert.deepEqual({ ...EVIDENCE_HEADING }, { ...EVIDENCE_HEADINGS });
  assert.equal(AFFECTED_LIST_TRUNCATED, REPORT_AFFECTED_LIST_TRUNCATED);
  // The several-pages heading with its reach is built the same way in both places.
  const out = cardOf({ ...pageFinding(), evidencePanel: PANEL, evidenceKind: "examplePage", scopeCounts: { affected: 19, evaluated: 128 } });
  assert.ok(out.includes(`Evidence · ${evidenceHeadingWithReach(19, 128)}`));
});

test("F3b: one page read gives the single-page scope line", () => {
  const out = cardOf({ ...pageFinding(), evidenceKind: "onePage", scopeCounts: { affected: 1, evaluated: 1 } });
  assert.ok(out.includes('<p class="finding-meta">Found on the page checked.</p>'));
  assert.ok(!out.includes("1 of 1"));
});

test("F3b T-1: two pages read, a rule that ran on one, says so with both figures", () => {
  const out = cardOf({ ...pageFinding(), evidenceKind: "examplePage", scopeCounts: { affected: 1, evaluated: 1 } });
  assert.ok(out.includes('<p class="finding-meta">Found on 1 of 1 pages checked.</p>'));
});

test("F3b: a site card names its domain, and with no usable domain has no scope line (O3)", () => {
  assert.ok(cardOf({ ...siteFinding(), scopeDomain: "mail.example.org" }).includes(
    '<p class="finding-meta">Applies to the whole domain: mail.example.org.</p>',
  ));
  const unknown = cardOf({ ...siteFinding(), scopeDomain: null });
  assert.ok(!unknown.includes("finding-meta"));
  assert.ok(!unknown.includes("Applies to the whole domain"));
});

test("F3b: a scope line is escaped like every other value", () => {
  const out = cardOf({ ...siteFinding(), scopeDomain: HOSTILE });
  assert.ok(!out.includes("<script>"));
});

test("F3b: a speed card says where it was measured, and is never given page counts", () => {
  const out = cardOf(speedFinding());
  assert.ok(out.includes('<p class="finding-meta">Measured on https://example.com/ (mobile).</p>'));
  assert.ok(!/Found on/.test(out), "no page denominator for a single measured address");
  // CP3-O5: the affected-address list stays, as CP1 §6 lists it on every card.
  assert.match(out, /<ul class="affected-list"><li>https:\/\/example\.com\/<\/li><\/ul>/);
});

test("F3b: a speed card with no measured address has no scope line rather than an invented one", () => {
  const out = cardOf(speedFinding({ affected: [] }));
  assert.ok(!out.includes("finding-meta"));
});

test("F3b: each evidence heading follows the kind of evidence, and only where a panel exists (O9)", () => {
  assert.ok(cardOf({ ...siteFinding(), evidencePanel: PANEL }).includes("Evidence · Measured for the whole domain"));
  assert.ok(cardOf({ ...pageFinding(), evidencePanel: PANEL, evidenceKind: "onePage" }).includes("Evidence · Measured on the page checked"));

  const unverified = cardOf({ ...pageFinding(), evidencePanel: PANEL, evidenceKind: "examplePage", scopeCounts: null });
  assert.ok(unverified.includes('<p class="explainer-label">Evidence · Example measured on the main page checked</p>'));
  assert.ok(!/found on \d/.test(unverified), "no figure in the heading when the counts were not carried");

  for (const kind of ["site", "onePage", "examplePage"] as const) {
    const bare = cardOf({ ...pageFinding(), evidencePanel: null, evidenceKind: kind });
    assert.ok(!bare.includes("Evidence ·"), `${kind}: no heading without a panel`);
  }
  assert.ok(!cardOf({ ...siteFinding(), evidencePanel: PANEL }).includes("IGNORED-BY-THE-CARD"));
});

test("F3b: a speed card never carries an evidence heading, even with measured rows", () => {
  const out = cardOf(speedFinding({ evidencePanel: PANEL }));
  assert.ok(!out.includes("Evidence ·"));
  assert.ok(out.includes('<th scope="row">Row</th><td>Value'), "the rows themselves are kept");
});

test("F3b G6: the truncation note follows the flag alone, never the old count note", () => {
  const two = [
    { url: "https://example.com/a", evidence: "x" },
    { url: "https://example.com/b", evidence: "x" },
  ];
  const cut = cardOf({ ...pageFinding(), affected: two, truncated: true, affectedNote: "Showing 2 of 60 affected pages." });
  assert.ok(cut.includes(`<p class="note">${AFFECTED_LIST_TRUNCATED}</p>`));
  assert.ok(!cut.includes("Showing"), "the count note is never printed");
  assert.ok(!/\b60\b/.test(cut), "and no hidden total leaks");

  const whole = cardOf({ ...pageFinding(), affected: two, truncated: false, affectedNote: "Showing 2 of 60 affected pages." });
  assert.ok(!whole.includes(AFFECTED_LIST_TRUNCATED));
  assert.ok(!whole.includes("Showing"));
});

test("F3b: what fixing it is intended to achieve comes after the steps and before who fixes it, verbatim", () => {
  const out = findingsHtml(withExplainer(EXPLAINER), LABELS);
  const order = ["Steps", "STEP-TWO", WHAT_FIXING_ACHIEVES_LABEL, "ACHIEVES-TEXT", "Who usually fixes it"];
  let at = -1;
  for (const marker of order) {
    const next = out.indexOf(marker, at + 1);
    assert.ok(next > at, `"${marker}" comes after the part before it`);
    at = next;
  }
  assert.ok(out.includes(`<p class="explainer-label">${WHAT_FIXING_ACHIEVES_LABEL}</p><p>ACHIEVES-TEXT</p>`));

  const hostile = findingsHtml(withExplainer({ ...EXPLAINER, whatFixingAchieves: HOSTILE }), LABELS);
  assert.ok(!hostile.includes("<script>") && hostile.includes("&lt;script&gt;"), "escaped, not dropped");
});

test("F3b: an empty intended-aim sentence draws no block", () => {
  for (const text of ["", "   "]) {
    const out = findingsHtml(withExplainer({ ...EXPLAINER, whatFixingAchieves: text }), LABELS);
    assert.ok(!out.includes(WHAT_FIXING_ACHIEVES_LABEL), JSON.stringify(text));
    assert.ok(out.includes("Who usually fixes it"), "the rest of the block is unchanged");
  }
});

test("F3b: cards on their own carry no section, heading or group, and nothing at all when empty", () => {
  assert.equal(findingCardsHtml([], LABELS), "");

  const out = findingCardsHtml([speedFinding(), speedFinding({ ruleId: "speed.lab.score", title: "Simulated performance score is poor" })], LABELS);
  assert.ok(out.startsWith('<div class="finding-cards">') && out.endsWith("</div>"));
  assert.ok(!/<section|<h2|<h3/.test(out), "no section, section heading or group heading");
  assert.ok(out.includes("Largest Contentful Paint is slow") && out.includes("Simulated performance score is poor"));

  // The same card as inside a section, so a card reads the same wherever it is.
  const inSection = findingsHtml(sectionOf([speedFinding()]), LABELS);
  const card = findingCardsHtml([speedFinding()], LABELS).replace(/^<div class="finding-cards">|<\/div>$/g, "");
  assert.ok(inSection.includes(card));
});

// ---------------------------------------------------------------------------
// CP3 step 4a (F1): the Page-Level Issues section
// ---------------------------------------------------------------------------

/** A certificate-failure document: the model's own statuses say so (M6). */
const CERTIFICATE_FAILURE = {
  certificateFailureAreas: { seo: "not-measured", security: "attention", speed: "not-measured", technical: "incomplete" },
  overallSummary: null,
} as const;

/** The page findings section with these groups. */
function pageFindingsWith(groups: PdfFindingSection["groups"]): PdfFindingSection {
  return { ...pageSection(), count: groups.reduce((sum, one) => sum + one.findings.length, 0), groups };
}

const seoGroup = (findings: readonly PdfFinding[]) => ({ category: "seo" as const, label: "Search visibility", findings: [...findings] });
const securityGroup = (findings: readonly PdfFinding[]) => ({ category: "security" as const, label: "Security", findings: [...findings] });
const speedGroup = (findings: readonly PdfFinding[]) => ({ category: "speed" as const, label: "Speed", findings: [...findings] });

test("4a: the heading, and the introduction equal to the report layer's", () => {
  assert.equal(PAGE_LEVEL_ISSUES_HEADING, "Page-Level Issues");
  assert.equal(PAGE_LEVEL_ISSUES_INTRO, SECTION_INTROS.pageLevelIssues);
  assert.equal(NO_PAGE_READ_SENTENCE, "No page could be read, so no page-level checks were made.");
  const out = pageLevelIssuesHtml(testDocument());
  assert.ok(out.startsWith(
    `<section class="findings page-level-issues"><h2>Page-Level Issues</h2><p class="lead">${PAGE_LEVEL_ISSUES_INTRO}</p>`,
  ));
  assert.equal(out.split("<h2").length - 1, 1, "one numbered heading");
});

test("4a: the page findings are drawn with exactly the existing group and card markup", () => {
  const doc = testDocument();
  const out = pageLevelIssuesHtml(doc);
  // findingsHtml draws the same groups under the old heading and intro; the groups themselves are identical.
  const old = findingsHtml(doc.pageFindings, doc.labels);
  const groupsOld = old.slice(old.indexOf(`<div class="group">`), old.lastIndexOf("</section>"));
  const groupsNew = out.slice(out.indexOf(`<div class="group">`), out.lastIndexOf("</section>"));
  assert.ok(groupsOld.length > 0);
  assert.equal(groupsNew, groupsOld);
  assert.ok(out.includes("No meta description"));
});

test("4a: several groups are drawn in the model's order", () => {
  const first = { ...pageFinding(), ruleId: "seo.title.missing", title: "FIRST-SEO" };
  const second = { ...pageFinding(), ruleId: "security.headers.hsts", category: "security" as const, title: "SECOND-SECURITY" };
  const out = pageLevelIssuesHtml(testDocument({ pageFindings: pageFindingsWith([seoGroup([first]), securityGroup([second])]) }));
  assert.equal(out.split(`<div class="group">`).length - 1, 2);
  assert.ok(out.indexOf("FIRST-SEO") < out.indexOf("SECOND-SECURITY"));
  assert.ok(out.indexOf("<h3>Search visibility</h3>") < out.indexOf("<h3>Security</h3>"));
});

test("4a: the Speed group is left out, because its cards follow the Speed section", () => {
  const out = pageLevelIssuesHtml(testDocument({
    pageFindings: pageFindingsWith([seoGroup([pageFinding()]), speedGroup([speedFinding()])]),
  }));
  assert.ok(!out.includes(speedFinding().title));
  assert.ok(!out.includes("<h3>Speed</h3>"));
  assert.ok(out.includes("No meta description"));
});

test("4a (D1): a whole-site audit with no page finding, or only Speed findings, has no section at all", () => {
  for (const pageFindings of [pageFindingsWith([]), pageFindingsWith([speedGroup([speedFinding()])]), pageFindingsWith([seoGroup([])])]) {
    assert.equal(pageLevelIssuesHtml(testDocument({ pageFindings })), "");
  }
});

test("4a (Q9): a certificate failure says no page could be read, with no card and no introduction", () => {
  const out = pageLevelIssuesHtml(testDocument({ ...CERTIFICATE_FAILURE, pageFindings: pageFindingsWith([]) }));
  assert.equal(
    out,
    `<section class="findings page-level-issues"><h2>Page-Level Issues</h2><p>No page could be read, so no page-level checks were made.</p></section>`,
  );
});

test("4a (Q9): a certificate failure never prints a card or a success claim, whatever the model carries", () => {
  // Told apart by the model's certificate-failure statuses, not by whether the list happens to be empty.
  const out = pageLevelIssuesHtml(testDocument({ ...CERTIFICATE_FAILURE }));
  assert.ok(out.includes(NO_PAGE_READ_SENTENCE));
  assert.ok(!out.includes(`<article class="finding`), "no card");
  assert.ok(!out.includes(PAGE_LEVEL_ISSUES_INTRO), "no introduction about issues found on pages");
  for (const claim of ["No issue", "no issues", "passed", "No page-level issues"]) {
    assert.ok(!out.includes(claim), `no "${claim}"`);
  }
});

test("4a: text from the audited site is escaped on the cards", () => {
  const hostile = { ...pageFinding(), title: HOSTILE, evidence: HOSTILE, affected: [{ url: `https://example.com/${HOSTILE}`, evidence: HOSTILE }] };
  const out = pageLevelIssuesHtml(testDocument({ pageFindings: pageFindingsWith([seoGroup([hostile])]) }));
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("4a: the existing findings section is unchanged by the new one", () => {
  const doc = testDocument();
  const out = findingsHtml(doc.pageFindings, doc.labels);
  assert.ok(out.startsWith(`<section class="findings"><h2>Page-level issues</h2>`));
  assert.ok(out.includes(`<p class="lead">${doc.pageFindings.intro}</p>`));
});

test("wired (CP3 step 4b): the document prints Page-Level Issues straight after the Executive Summary, and only when it has something to show", () => {
  const shell = fs.readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  assert.ok(shell.includes("pageLevelIssuesHtml(document)"));
  const doc = testDocument();
  const page = documentHtml(doc);
  assert.equal(page.split(`<h2>${PAGE_LEVEL_ISSUES_HEADING}</h2>`).length - 1, 1);
  assert.ok(page.includes(`</section>${pageLevelIssuesHtml(doc)}<section class="seo-audit">`), "between the summary and SEO Audit");
  // D1: nothing at all for a whole-site audit with no page finding.
  // The section heading, not the words: pointers elsewhere still say "see Page-Level Issues".
  const empty = documentHtml(testDocument({ pageFindings: pageFindingsWith([]) }));
  assert.ok(!empty.includes(`<h2>${PAGE_LEVEL_ISSUES_HEADING}</h2>`));
  assert.ok(!empty.includes(`class="findings page-level-issues"`));
});
