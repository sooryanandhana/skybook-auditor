/**
 * About this report: what the audit does, and what it cannot see.
 *
 * THE ONLY SECTION THAT CARRIES PROSE OF ITS OWN, and 7A §6 requires it. It
 * has no equivalent on screen, so there is nothing to share it with and
 * nothing it can drift from. Every other string in the document was written by
 * the report layer; these sentences were written here, once, and are reviewed
 * as content rather than as code.
 *
 * WHY A DOCUMENT ADMITS ITS LIMITS. A prospect who discovers one of these gaps
 * themselves should find it already disclosed. The alternative is a client
 * who works out that the audit never ran their JavaScript, concludes the
 * report was overstated, and stops believing the parts that were exact. Every
 * caveat below is one the project already writes down elsewhere; this is the
 * page that says them to the person holding the report.
 *
 * NOT A DISCLAIMER. It is written for the reader, not for a lawyer: plain
 * sentences about what was looked at, in the same voice as the rest of the
 * document. 7A §2 is clear that neither reader is a developer, so there are no
 * rule identifiers, thresholds or internal state names here.
 *
 * ITS OWN PAGE, per 7A §18.
 */

/** The section's title, from 7A §6's structure table. */
const ABOUT_HEADING = "About this report";

interface Caveat {
  readonly heading: string;
  readonly points: readonly string[];
}

/**
 * What the audit measured, and what it did not.
 *
 * Grouped the way a reader would ask about it: the pages, then the security
 * and domain checks, then how much of the site was reached.
 */
const CAVEATS: readonly Caveat[] = [
  {
    heading: "How the pages were read",
    points: [
      "Every page was read as the server sent it. Scripts are not run, so anything a page builds in the browser after it loads is not counted here.",
      "Style sheets are not downloaded, so images and other files named inside them are not seen. This is why insecure resources are reported as none found in the page's own HTML, rather than as none found anywhere.",
      "Cookies created later by a script are not seen. Only the ones the server set are counted, and only their names and protective settings, never their contents.",
      "Where a page carried too little readable text to judge, its headings and images were not judged at all. The report says so rather than reporting a count of nothing.",
    ],
  },
  {
    heading: "The certificate and the domain records",
    points: [
      "The certificate's trust is reported as the operating system judges it. It is not verified independently.",
      "Whether a certificate has been withdrawn since it was issued is not checked.",
      "A record lookup can fail on some networks. Where that happened the report says the check could not be completed, and never that the record is missing. Those are different things and only one of them is a problem.",
    ],
  },
  {
    heading: "How much of the site was seen",
    points: [
      "The audit follows links and sitemaps. A page nothing points at is not found, and the report describes the pages it could check rather than claiming to have seen the whole site.",
      "Where the audit stopped at its own limit, the report says so and is marked as a partial audit throughout.",
      "Pages the site asked automated visitors not to read were left alone and counted. That is the site working as intended, not a fault.",
      "A file the audit could not read is a gap in the audit, not a fault in the website, and is described that way.",
    ],
  },
  {
    heading: "Where the writing came from",
    points: [
      "Every finding, its severity and every number in this report were produced by the audit itself, from what it measured.",
      "Where written commentary appears, it was produced by an AI from those findings and is labelled. It explains them; it does not decide them, and it cannot add, remove or re-grade anything.",
      "A report with no commentary is complete. Its absence means none was requested or none was usable, and says nothing about the website.",
    ],
  },
];

/**
 * Every clause, in its four groups, without a section or a section heading
 * (CP1 F9, CP3 step 3c-i), so the Limitations section can carry them.
 *
 * ALL OF THEM, ALWAYS (S3-D9). No clause is chosen by what the audit found:
 * deciding which caveats "apply" would be this file judging the audit.
 *
 * THE GROUP HEADING LEVEL IS THE CALLER'S (CP3 step 3c-ii, A1). The About
 * section uses the default, 3, under its own h2; the Limitations section nests
 * the groups one level deeper, under its "About this audit" h3, and passes 4.
 */
export function aboutClausesHtml(level: 3 | 4 = 3): string {
  return CAVEATS.map(
    (caveat) =>
      `<div class="caveat">` +
      `<h${level}>${caveat.heading}</h${level}>` +
      `<ul class="caveat-list">${caveat.points.map((point) => `<li>${point}</li>`).join("")}</ul>` +
      `</div>`,
  ).join("");
}

/** The section. Static, and identical in every document. */
export function aboutHtml(): string {
  return `<section class="about">` + `<h2>${ABOUT_HEADING}</h2>` + aboutClausesHtml() + `</section>`;
}
