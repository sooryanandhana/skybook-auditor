/**
 * Tests for the four sections that finish the document.
 *
 * THE THEME IS THE SAME AS EVERYWHERE ELSE: an absence of knowledge must never
 * read as bad news. A speed check nobody asked for is not a slow website. A
 * check that could not run is not a finding. A measurement that could not be
 * taken is not a missing record. Each of these sections has a way of getting
 * that wrong, and most of this file is about the ways.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { speedHtml } from "./speed.ts";
import { skippedGroupsHtml, skippedHtml } from "./skipped.ts";
import { COVERAGE_DETAIL_HEADING, MEASURED_HEADING, factSectionsHtml } from "./factSections.ts";
import { aboutClausesHtml, aboutHtml } from "./about.ts";
import { testDocument } from "./testDocument.fixture.mts";
import type { PdfLabels, PdfMetric, PdfSpeed } from "../pdfDocument.ts";

const LABELS: PdfLabels = testDocument().labels;

const metric = (label: string, value: string | null, rating: string | null = null): PdfMetric => ({
  label,
  value,
  rating,
});

const measured = (over: Partial<Extract<PdfSpeed, { measured: true }>> = {}): PdfSpeed => ({
  measured: true,
  status: "checked",
  device: "Mobile simulation",
  overall: "Slow",
  fieldAvailable: true,
  field: [metric("LCP", "4.20 s", "Poor"), metric("CLS", "0.250", "Needs work")],
  labAvailable: true,
  labScore: 31,
  lab: [metric("LCP", "5.10 s"), metric("TBT", "890 ms")],
  notInspected: ["Pages other than the address measured."],
  ...over,
});

// ---------------------------------------------------------------------------
// Speed: absent is normal
// ---------------------------------------------------------------------------

test("the speed section is present even when nothing was measured", () => {
  // 7A §10: the section is always there and says which of the states applies.
  const out = speedHtml(
    { measured: false, status: "not-requested", message: "Speed was not measured." },
    LABELS,
  );

  assert.ok(out.includes("Speed"));
  assert.ok(out.includes("Speed was not measured."));
});

test("every non-measured state prints its own sentence and nothing more", () => {
  /*
   * FOUR WAYS TO HAVE NO SPEED RESULT, and not one of them is a fault in the
   * website. The projection already worded each; this asserts the renderer
   * adds no gloss of its own to any of them.
   */
  const states = [
    ["not-requested", "Speed was not measured. It is an optional extra check."],
    ["no-api-key", "The speed service is not configured on this server."],
    ["pending", "The speed check had not finished when this report was made."],
    ["error", "The speed check did not complete."],
  ] as const;

  for (const [status, message] of states) {
    const out = speedHtml({ measured: false, status, message } as PdfSpeed, LABELS);

    assert.ok(out.includes(message), `${status} carries its sentence`);
    assert.ok(!out.includes("Real visitors"), `${status} shows no empty blocks`);
    assert.ok(!out.includes("/ 100"), `${status} shows no score`);
  }
});

test("a non-measured speed section never says anything about the website", () => {
  const out = speedHtml(
    { measured: false, status: "no-api-key", message: "The speed service is not configured here." },
    LABELS,
  );

  assert.ok(!/slow|poor|fail/i.test(out.replace("Speed", "")));
});

// ---------------------------------------------------------------------------
// Speed: field and lab are not the same measurement
// ---------------------------------------------------------------------------

test("real visitors and the simulation get separate, labelled blocks", () => {
  // 7A §10. A reader who takes the simulation for real visitors acts on a
  // number that describes nobody's actual visit.
  const out = speedHtml(measured(), LABELS);

  assert.ok(out.includes("Real visitors"));
  assert.ok(out.includes("Simulated load"));
  assert.ok(out.indexOf("Real visitors") < out.indexOf("Simulated load"), "field first");
});

test("the block headings come from the document, not from the renderer", () => {
  const out = speedHtml(measured(), { ...LABELS, speedField: "FIELDHEAD", speedLab: "LABHEAD" });

  assert.ok(out.includes("FIELDHEAD"));
  assert.ok(out.includes("LABHEAD"));
  assert.ok(!out.includes("Real visitors"));
});

test("the simulated device is stated, never assumed", () => {
  // 7A §10. A score without it reads as describing the desktop site.
  assert.ok(speedHtml(measured(), LABELS).includes("Mobile simulation"));
});

test("the lab score is shown out of one hundred", () => {
  const out = speedHtml(measured(), LABELS);

  assert.ok(out.includes(">31<"));
  assert.ok(out.includes("/ 100"));
});

test("a missing lab score shows no score rather than a zero", () => {
  const out = speedHtml(measured({ labScore: null }), LABELS);

  assert.ok(!out.includes("/ 100"));
  assert.ok(out.includes("Simulated load"), "the block is still there");
});

test("an unavailable half is omitted rather than shown empty", () => {
  const noField = speedHtml(measured({ fieldAvailable: false, field: [] }), LABELS);
  assert.ok(!noField.includes("Real visitors"));
  assert.ok(noField.includes("Simulated load"));

  const noLab = speedHtml(measured({ labAvailable: false, lab: [], labScore: null }), LABELS);
  assert.ok(noLab.includes("Real visitors"));
  assert.ok(!noLab.includes("Simulated load"));
});

// ---------------------------------------------------------------------------
// Speed: metrics
// ---------------------------------------------------------------------------

test("a metric Google did not report reads as such, never as zero", () => {
  // 7A §10 and §14. An absence of knowledge never becomes a bad number.
  const out = speedHtml(measured({ field: [metric("LCP", "Not reported", null)] }), LABELS);

  assert.ok(out.includes("Not reported"));
  assert.ok(!out.includes(">0<"));
});

test("the rating column appears for rated metrics and not for unrated ones", () => {
  const out = speedHtml(measured(), LABELS);

  // Field metrics carry Google's verdict; lab metrics do not, so a lab table
  // with an empty third column would invite a reader to wonder what is missing.
  assert.equal((out.match(/<th scope="col">Rating<\/th>/g) ?? []).length, 1);
  assert.equal((out.match(/<th scope="col">Metric<\/th>/g) ?? []).length, 2);
});

test("every metric is a table row, so a spanning table can repeat its header", () => {
  const out = speedHtml(measured(), LABELS);

  assert.match(out, /<thead>/);
  assert.ok(out.includes('<th scope="row">LCP</th>'));
});

test("what the speed check cannot see is stated", () => {
  const out = speedHtml(measured(), LABELS);

  assert.ok(out.includes("What this does not cover"));
  assert.ok(out.includes("Pages other than the address measured."));
});

test("nothing uninspected means no caveat block", () => {
  assert.ok(!speedHtml(measured({ notInspected: [] }), LABELS).includes("does not cover"));
});

test("speed values carrying markup are rendered as text", () => {
  const out = speedHtml(measured({ overall: "<b>Slow</b>", device: "<i>Mobile</i>" }), LABELS);

  assert.ok(!out.includes("<b>"));
  assert.ok(!out.includes("<i>"));
});

// ---------------------------------------------------------------------------
// Checks that did not run
// ---------------------------------------------------------------------------

test("the skipped section carries its heading and its one line of context", () => {
  // 7A §14 carries both word for word, and the intro is doing real work: it
  // says nothing is claimed about these checks either way.
  const out = skippedHtml({
    heading: "Checks not evaluated",
    intro: "These checks did not run, so nothing is claimed about them either way.",
    count: 2,
    groups: [{ reason: "The page carried too little readable text.", checks: ["A check", "Another"] }],
  });

  assert.ok(out.includes("Checks not evaluated"));
  assert.ok(out.includes("nothing is claimed about them either way"));
});

test("checks come first and their reason follows", () => {
  const out = skippedHtml({
    heading: "H",
    intro: "I",
    count: 1,
    groups: [{ reason: "REASONTEXT", checks: ["CHECKNAME"] }],
  });

  assert.ok(out.indexOf("CHECKNAME") < out.indexOf("REASONTEXT"));
});

test("a skipped check carries no badge and no severity colour", () => {
  // 7A §14. A check that could not run is not a finding, and giving it the
  // visual language of one turns our gap into an accusation.
  const out = skippedHtml({
    heading: "H",
    intro: "I",
    count: 1,
    groups: [{ reason: "R", checks: ["C"] }],
  });

  assert.ok(!out.includes("chip"));
  for (const severity of ["critical", "high", "medium", "good"]) {
    assert.ok(!out.includes(severity), `no ${severity} styling`);
  }
});

test("nothing skipped produces no section at all", () => {
  // 7A §19: the section is omitted entirely rather than left saying zero.
  assert.equal(skippedHtml(null), "");
  assert.equal(skippedHtml({ heading: "H", intro: "I", count: 0, groups: [] }), "");
});

test("a skipped reason carrying markup is rendered as text", () => {
  const out = skippedHtml({
    heading: "H",
    intro: "I",
    count: 1,
    groups: [{ reason: "<script>steal()</script>", checks: ["<b>c</b>"] }],
  });

  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("<b>"));
});

// ---------------------------------------------------------------------------
// The measured facts, and the coverage detail
// ---------------------------------------------------------------------------

test("each fact group gets its own sub-heading and table", () => {
  const out = factSectionsHtml(
    MEASURED_HEADING,
    [
      { heading: "Security", facts: [{ label: "HTTPS", value: "Yes" }] },
      { heading: "Certificate", facts: [{ label: "Issuer", value: "Example CA" }] },
    ],
    "measured",
  );

  assert.ok(out.includes("What we measured"));
  assert.ok(out.includes("Security"));
  assert.ok(out.includes("Certificate"));
  assert.equal((out.match(/<table class="facts">/g) ?? []).length, 2);
});

test("groups keep the order the projection gave them", () => {
  const out = factSectionsHtml(
    MEASURED_HEADING,
    [
      { heading: "FIRSTGROUP", facts: [{ label: "a", value: "b" }] },
      { heading: "SECONDGROUP", facts: [{ label: "c", value: "d" }] },
    ],
    "measured",
  );

  assert.ok(out.indexOf("FIRSTGROUP") < out.indexOf("SECONDGROUP"));
});

test("a group with no rows produces no heading and no table", () => {
  const out = factSectionsHtml(
    MEASURED_HEADING,
    [
      { heading: "EMPTYGROUP", facts: [] },
      { heading: "FULLGROUP", facts: [{ label: "a", value: "b" }] },
    ],
    "measured",
  );

  assert.ok(!out.includes("EMPTYGROUP"));
  assert.ok(out.includes("FULLGROUP"));
});

test("no groups at all produces no section", () => {
  assert.equal(factSectionsHtml(MEASURED_HEADING, [], "measured"), "");
  assert.equal(
    factSectionsHtml(COVERAGE_DETAIL_HEADING, [{ heading: "x", facts: [] }], "coverage-detail"),
    "",
  );
});

test("a fact note reaches the page, because a caveat on a value is not optional", () => {
  const out = factSectionsHtml(
    MEASURED_HEADING,
    [{ heading: "G", facts: [{ label: "Text", value: "29 characters", note: "Scripts are not run." }] }],
    "measured",
  );

  assert.ok(out.includes("Scripts are not run."));
});

test("a group heading carrying markup is rendered as text", () => {
  const out = factSectionsHtml(
    MEASURED_HEADING,
    [{ heading: "<script>steal()</script>", facts: [{ label: "a", value: "b" }] }],
    "measured",
  );

  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

// ---------------------------------------------------------------------------
// About this report
// ---------------------------------------------------------------------------

test("the about section names the limits a client could otherwise discover alone", () => {
  // 7A §6. A prospect who finds one of these gaps themselves should find it
  // already disclosed.
  const out = aboutHtml();

  assert.ok(out.includes("About this report"));
  assert.match(out, /Scripts are not run/i);
  assert.match(out, /[Ss]tyle sheets are not downloaded/);
  assert.match(out, /withdrawn since it was issued is not checked/);
  assert.match(out, /follows links and sitemaps/);
});

test("the about section says where the writing came from", () => {
  const out = aboutHtml();

  assert.match(out, /produced by the audit itself/);
  assert.match(out, /It explains them; it does not decide them/);
  assert.match(out, /A report with no commentary is complete/);
});

test("the about section is written for a client, not a developer", () => {
  // 7A §2: neither reader is a developer. No rule identifiers, no internal
  // state names, no thresholds.
  const out = aboutHtml();

  assert.ok(!/\b[a-z]+\.[a-z-]+\.[a-z-]+\b/.test(out), "no rule identifiers");
  for (const internal of ["no-api-key", "stoppedBecause", "AuditData", "PdfDocument", "robots.txt"]) {
    assert.ok(!out.includes(internal), `no ${internal}`);
  }
});

test("the about section is the same in every document", () => {
  // It reads nothing, so it cannot differ between audits.
  assert.equal(aboutHtml(), aboutHtml());
});

test("the about section takes its own page", () => {
  assert.ok(aboutHtml().startsWith('<section class="about">'));
});

// ---------------------------------------------------------------------------
// CP3 step 3c-i (F9): the Q4 clause, and the clauses without their section
// ---------------------------------------------------------------------------

/** Every About clause, exactly as approved (CP3 revision 9 §1.8: Q4, O2, Q8). */
const ABOUT_CLAUSES = [
  "Every page was read as the server sent it. Scripts are not run, so anything a page builds in the browser after it loads is not counted here.",
  "Style sheets are not downloaded, so images and other files named inside them are not seen. This is why insecure resources are reported as none found in the page's own HTML, rather than as none found anywhere.",
  "Cookies created later by a script are not seen. Only the ones the server set are counted, and only their names and protective settings, never their contents.",
  "Where a page carried too little readable text to judge, its headings and images were not judged at all. The report says so rather than reporting a count of nothing.",
  "The certificate's trust is reported as the operating system judges it. It is not verified independently.",
  "Whether a certificate has been withdrawn since it was issued is not checked.",
  "A record lookup can fail on some networks. Where that happened the report says the check could not be completed, and never that the record is missing. Those are different things and only one of them is a problem.",
  "The audit follows links and sitemaps. A page nothing points at is not found, and the report describes the pages it could check rather than claiming to have seen the whole site.",
  "Where the audit stopped at its own limit, the report says so and is marked as a partial audit throughout.",
  "Pages the site asked automated visitors not to read were left alone and counted. That is the site working as intended, not a fault.",
  "A file the audit could not read is a gap in the audit, not a fault in the website, and is described that way.",
  "Every finding, its severity and every number in this report were produced by the audit itself, from what it measured.",
  "Where written commentary appears, it was produced by an AI from those findings and is labelled. It explains them; it does not decide them, and it cannot add, remove or re-grade anything.",
  "A report with no commentary is complete. Its absence means none was requested or none was usable, and says nothing about the website.",
];

test("3c-i Q4: the revised clause is printed exactly, and the old wording is gone", () => {
  const out = aboutHtml();
  assert.ok(out.includes(
    "<li>The audit follows links and sitemaps. A page nothing points at is not found, and the report describes the pages it could check rather than claiming to have seen the whole site.</li>",
  ));
  assert.ok(!out.includes("says how many pages were read"));
});

test("3c-i O2 and Q8: the counted-exclusions and AI clauses are unchanged", () => {
  const out = aboutHtml();
  assert.ok(out.includes("<li>Pages the site asked automated visitors not to read were left alone and counted. That is the site working as intended, not a fault.</li>"));
  assert.ok(out.includes("<li>Where written commentary appears, it was produced by an AI from those findings and is labelled. It explains them; it does not decide them, and it cannot add, remove or re-grade anything.</li>"));
});

test("3c-i S3-D9: all 14 clauses are printed, in order, every time", () => {
  const clauses = [...aboutClausesHtml().matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(clauses, ABOUT_CLAUSES);
  assert.equal(aboutClausesHtml(), aboutClausesHtml(), "no clause depends on anything");
});

test("3c-i the clauses come without a section or a section heading, and the About section wraps them unchanged", () => {
  const clauses = aboutClausesHtml();
  assert.ok(!clauses.includes("<section"));
  assert.ok(!clauses.includes("<h2"));
  assert.equal(clauses.split(`<div class="caveat">`).length - 1, 4, "the four groups");
  assert.equal(aboutHtml(), `<section class="about"><h2>About this report</h2>${clauses}</section>`);
});

// ---------------------------------------------------------------------------
// CP3 step 3c-ii (A1): the About group heading level
// ---------------------------------------------------------------------------

const ABOUT_GROUP_HEADINGS = [
  "How the pages were read",
  "The certificate and the domain records",
  "How much of the site was seen",
  "Where the writing came from",
];

test("3c-ii A1: the default level is h3, exactly as before, and the About section is unchanged", () => {
  const out = aboutClausesHtml();
  assert.equal(out, aboutClausesHtml(3));
  assert.deepEqual([...out.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]), ABOUT_GROUP_HEADINGS);
  assert.ok(!out.includes("<h4"));
  assert.equal(aboutHtml(), `<section class="about"><h2>About this report</h2>${out}</section>`);
});

test("3c-ii A1: level 4 gives h4 group headings and changes nothing else", () => {
  const out = aboutClausesHtml(4);
  assert.deepEqual([...out.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1]), ABOUT_GROUP_HEADINGS);
  assert.ok(!out.includes("<h3"));
  assert.equal(out.replace(/<(\/?)h4>/g, "<$1h3>"), aboutClausesHtml(3), "only the heading level differs");
  assert.deepEqual([...out.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]), ABOUT_CLAUSES, "all 14 clauses, in order");
});

// ---------------------------------------------------------------------------
// CP3 step 3c-ii (F10): the grouping, reusable on its own
// ---------------------------------------------------------------------------

const SKIPPED = {
  heading: "Checks not evaluated",
  intro: "These checks did not run, so nothing is claimed about them either way.",
  count: 3,
  groups: [
    { reason: "The page carried too little readable text.", checks: ["Main heading", "Image descriptions"] },
    { reason: "The lookup timed out.", checks: ["Email policy record"] },
  ],
};

test("3c-ii F10: the exported grouping is the existing reason-group markup, in order", () => {
  assert.equal(
    skippedGroupsHtml(SKIPPED.groups),
    `<div class="skipped-group"><ul class="skipped-checks"><li>Main heading</li><li>Image descriptions</li></ul>` +
      `<p class="note">The page carried too little readable text.</p></div>` +
      `<div class="skipped-group"><ul class="skipped-checks"><li>Email policy record</li></ul>` +
      `<p class="note">The lookup timed out.</p></div>`,
  );
});

test("3c-ii F10: the skipped section keeps its wrapper, heading and intro, around the exported grouping", () => {
  assert.equal(
    skippedHtml(SKIPPED),
    `<section class="skipped"><h2>Checks not evaluated</h2>` +
      `<p class="lead">These checks did not run, so nothing is claimed about them either way.</p>` +
      skippedGroupsHtml(SKIPPED.groups) +
      `</section>`,
  );
});

test("3c-ii F10: an empty group list gives nothing at all", () => {
  assert.equal(skippedGroupsHtml([]), "");
});

// ---------------------------------------------------------------------------
// Speed with a desktop result
// ---------------------------------------------------------------------------

test("speed with a desktop result draws mobile and desktop as separate parts", () => {
  const doc = testDocument();
  const desktop = { measured: false as const, status: "error" as const, message: "DESKTOP-NOT-MEASURED" };
  const out = speedHtml(doc.speed, doc.labels, desktop);
  const mobileAt = out.indexOf('<h3 class="sub">Mobile</h3>');
  const desktopAt = out.indexOf('<h3 class="sub">Desktop</h3>');
  assert.ok(mobileAt >= 0 && desktopAt > mobileAt, "mobile, then desktop");
  assert.ok(out.includes("DESKTOP-NOT-MEASURED"), "desktop's own state is shown, not mobile's");
  assert.ok(out.includes("measured separately and can differ"));
});

test("speed without a desktop result is the section it has always been", () => {
  const doc = testDocument();
  assert.equal(speedHtml(doc.speed, doc.labels, null), speedHtml(doc.speed, doc.labels));
  assert.ok(!speedHtml(doc.speed, doc.labels).includes("speed-device"));
});
