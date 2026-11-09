/**
 * The speed section, which is present whatever happened.
 *
 * ITS ABSENCE IS NORMAL AND IS NEVER A FAILURE. 7A §10 is emphatic about this:
 * the speed check is opt-in and slow, so most audits will not have one, and a
 * section that read as a fault every time nobody ticked the box would be
 * saying something false about the client's website on most reports. The
 * not-measured arm prints the projection's own sentence and stops. It does not
 * apologise, does not mention a provider, and does not imply anything was
 * tried and failed unless that is what happened.
 *
 * FIELD AND LAB ARE NOT THE SAME MEASUREMENT, and keeping them apart is the
 * whole job of the layout. Field data is what real visitors experienced. Lab
 * data is one simulated load in Google's own test browser on a throttled
 * connection. A reader who takes the second for the first will act on a number
 * that describes nobody's actual visit. They get separate blocks with separate
 * headings, and the headings are the same words the results page uses.
 *
 * "NOT REPORTED" IS NEVER ZERO. A metric Google did not report is unknown, and
 * 7A §14's rule holds here as everywhere: an absence of knowledge never
 * becomes a bad number. The projection has already made that string; this file
 * prints whatever it was given.
 */
import type { PdfLabels, PdfMetric, PdfSpeed, PdfSpeedMetricKey } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** The section's title. See the note in `coverage.ts` on why it lives here. */
const SPEED_HEADING = "Speed";

// ---------------------------------------------------------------------------
// CP4 (F5): the glossary and the real-visitor explanation
//
// Approved wording, copied here because renderer files may import only from
// this folder and the document model; sections.test.mts holds each one equal
// to its original in lib/report/reportSections.ts.
// ---------------------------------------------------------------------------

/** Equal to `SPEED_GLOSSARY_HEADING` in lib/report/reportSections.ts. */
export const GLOSSARY_HEADING = "What these measurements mean";

/** Equal to `SPEED_GLOSSARY` in lib/report/reportSections.ts, entry for entry. */
export const GLOSSARY: Readonly<Record<PdfSpeedMetricKey, string>> = {
  lcp: "LCP (Largest Contentful Paint): how long the main visible content of the page takes to appear.",
  fcp: "FCP (First Contentful Paint): how long it takes before anything first appears on the screen.",
  tbt: "TBT (Total Blocking Time): how much time the browser is too busy to respond to the visitor while the page loads.",
  speedIndex: "Speed Index: how quickly the visible parts of the page are filled in.",
  cls: "CLS (Cumulative Layout Shift): how much the page's content unexpectedly moves around while it loads.",
  inp: "INP (Interaction to Next Paint): how quickly the page responds visually after a visitor interacts with it, such as clicking a button or tapping a menu.",
  ttfb: "TTFB (Time to First Byte): how long it takes for the server to begin sending a response after a visitor requests a page.",
};

/** The printed order (decision U-2): the key order of `SPEED_GLOSSARY`. */
export const GLOSSARY_ORDER: readonly PdfSpeedMetricKey[] = ["lcp", "fcp", "tbt", "speedIndex", "cls", "inp", "ttfb"];

/** Equal to `REAL_VISITOR_HEADING` in lib/report/reportSections.ts. */
export const REAL_VISITOR_HEADING = "About real-visitor data";

/** Equal to `realVisitorExplanation(url)` in lib/report/reportSections.ts, for any address. */
export function realVisitorParagraphs(url: string): readonly string[] {
  return [
    "Google records how fast pages load for real people who visit them using the Chrome browser, collected over recent weeks. Where a page has enough visits, Google reports how fast it was for most of those visitors. Many smaller websites do not receive enough visits for Google to report these figures.",
    "When real-visitor figures are not available, the report relies on a simulated test: Google loads the page once on a simulated mobile phone and network. A simulated test is useful for finding what slows a page down, but it is a single run under fixed conditions, so its results can differ from what real visitors experience. Missing real-visitor data says nothing, good or bad, about how fast the site is.",
    `Speed is measured on ${url}. Desktop results are shown for information and do not affect the grade.`,
  ];
}

/**
 * The keys on the metric rows one device actually prints (decision P-3): its
 * real-visitor rows when that half is available, its simulated rows when that
 * half is, whatever their values say, including "Not reported" or nothing.
 * Read from the structured keys (P-6), never from a printed label.
 */
function printedKeys(speed: PdfSpeed | null): PdfSpeedMetricKey[] {
  if (speed === null || !speed.measured) return [];
  return [
    ...(speed.fieldAvailable ? speed.field.map((metric) => metric.key) : []),
    ...(speed.labAvailable ? speed.lab.map((metric) => metric.key) : []),
  ];
}

/**
 * Whether the real-visitor explanation is printed (decision P-4): only for a
 * MOBILE result the Executive Summary also treats as measured. This is the
 * same test as its Speed sentence, so the explanation can never sit beside
 * "Speed could not be measured for this report." Desktop is never consulted.
 */
export function explainsRealVisitorData(mobile: PdfSpeed): boolean {
  return mobile.measured && (mobile.fieldAvailable || mobile.labScore !== null);
}

/**
 * The appended block (decisions P-1, P-2, P-11): one glossary for every metric
 * printed on either device, in the approved order, then the explanation when
 * P-4 holds, with the mobile result's credential-free address. Nothing at all
 * when there is neither, so a section with no metrics is byte-for-byte as before.
 */
function explanationBlock(mobile: PdfSpeed, desktop: PdfSpeed | null): string {
  const printed = new Set([...printedKeys(mobile), ...printedKeys(desktop)]);
  const entries = GLOSSARY_ORDER.filter((key) => printed.has(key));

  const glossary =
    entries.length === 0
      ? ""
      : `<div class="speed-glossary">` +
        html`<h3>${GLOSSARY_HEADING}</h3>` +
        `<ul>${entries.map((key) => html`<li>${GLOSSARY[key]}</li>`).join("")}</ul>` +
        `</div>`;

  const explanation =
    mobile.measured && explainsRealVisitorData(mobile)
      ? `<div class="speed-real-visitor">` +
        html`<h3>${REAL_VISITOR_HEADING}</h3>` +
        realVisitorParagraphs(mobile.measuredAddress).map((paragraph) => html`<p>${paragraph}</p>`).join("") +
        `</div>`
      : "";

  return glossary + explanation;
}

/**
 * A block of metrics.
 *
 * THE RATING COLUMN APPEARS ONLY WHEN SOMETHING IS RATED. Field metrics carry
 * Google's own verdict and lab metrics do not, so a lab table with an empty
 * third column would invite a reader to wonder what was missing. A table with
 * two columns does not raise the question.
 */
function metricTable(metrics: readonly PdfMetric[]): string {
  if (metrics.length === 0) return "";

  const rated = metrics.some((metric) => metric.rating !== null);

  const rows = metrics
    .map((metric) => {
      const value = html`<td>${metric.value ?? ""}</td>`;
      const rating = rated ? html`<td>${metric.rating ?? ""}</td>` : "";
      return html`<tr><th scope="row">${metric.label}</th>` + value + rating + `</tr>`;
    })
    .join("");

  const head = rated
    ? `<tr><th scope="col">Metric</th><th scope="col">Result</th><th scope="col">Rating</th></tr>`
    : `<tr><th scope="col">Metric</th><th scope="col">Result</th></tr>`;

  return `<table class="facts"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/**
 * What real visitors experienced, and Google's verdict on it.
 *
 * The overall verdict belongs here rather than at the top of the section,
 * because it is a verdict about field data specifically. Attached to the
 * section as a whole it would read as a verdict on the simulated load too.
 */
function fieldBlock(speed: Extract<PdfSpeed, { measured: true }>, labels: PdfLabels): string {
  if (!speed.fieldAvailable) return "";

  const overall = speed.overall === null ? "" : html`<p class="note">${speed.overall}</p>`;

  return (
    `<div class="speed-block">` +
    html`<h3>${labels.speedField}</h3>` +
    overall +
    metricTable(speed.field) +
    `</div>`
  );
}

/**
 * One simulated load, and the score Google gave it.
 *
 * THE DEVICE IS STATED, NEVER ASSUMED. 7A §10 requires it. A score shown
 * without it is one a client reasonably reads as describing their desktop
 * site, and this check runs against a simulated phone by default.
 */
function labBlock(speed: Extract<PdfSpeed, { measured: true }>, labels: PdfLabels): string {
  if (!speed.labAvailable) return "";

  const device = speed.device === null ? "" : html`<p class="note">${speed.device}</p>`;
  const score =
    speed.labScore === null
      ? ""
      : html`<p class="speed-score">${speed.labScore}<span class="speed-score-of"> / 100</span></p>`;

  return (
    `<div class="speed-block">` +
    html`<h3>${labels.speedLab}</h3>` +
    device +
    score +
    metricTable(speed.lab) +
    `</div>`
  );
}

/**
 * What the speed check could not see.
 *
 * Included because a reader who assumes a speed result covers their whole site
 * has been misled by omission. The check looks at one address.
 */
function notInspected(speed: Extract<PdfSpeed, { measured: true }>, labels: PdfLabels): string {
  if (speed.notInspected.length === 0) return "";

  const items = speed.notInspected.map((note) => html`<li>${note}</li>`).join("");

  return (
    `<div class="speed-limits">` +
    html`<p class="caveat-label">${labels.speedNotInspected}</p>` +
    `<ul class="caveat-list">${items}</ul>` +
    `</div>`
  );
}

/** The whole section, in whichever of its two shapes applies. */
/**
 * The speed section. With a desktop result, mobile and desktop are drawn as two
 * separate, labelled parts; without one, the section is exactly the mobile-only
 * section it has always been.
 */
export function speedHtml(speed: PdfSpeed, labels: PdfLabels, desktop: PdfSpeed | null = null): string {
  if (desktop === null) return mobileOnlyHtml(speed, labels);
  return (
    `<section class="speed">` +
    `<h2>${SPEED_HEADING}</h2>` +
    `<p class="lead">${DEVICES_LEAD}</p>` +
    `<div class="speed-device"><h3 class="sub">Mobile</h3>${deviceBody(speed, labels)}</div>` +
    `<div class="speed-device"><h3 class="sub">Desktop</h3>${deviceBody(desktop, labels)}</div>` +
    explanationBlock(speed, desktop) +
    `</section>`
  );
}

/** What the two kinds of speed result mean, said once above both devices. */
const DEVICES_LEAD =
  "Mobile and desktop speed are measured separately and can differ. Real-visitor results come from Google's records of real visits. " +
  "The simulated score comes from a single test load, which Google classes as good (90–100), needs improvement (50–89) or poor (below 50); " +
  "it helps to find problems but does not measure every visitor's experience.";

/** One device's results, or the sentence saying why there are none. */
function deviceBody(speed: PdfSpeed, labels: PdfLabels): string {
  return speed.measured
    ? fieldBlock(speed, labels) + labBlock(speed, labels) + notInspected(speed, labels)
    : html`<p class="lead">${speed.message}</p>`;
}

function mobileOnlyHtml(speed: PdfSpeed, labels: PdfLabels): string {
  const body = speed.measured
    ? fieldBlock(speed, labels) + labBlock(speed, labels) + notInspected(speed, labels)
    : /*
       * The projection's own sentence, and nothing added to it. Every one of
       * the four non-measured states -- nobody asked, still running, no key on
       * this server, the check errored -- already has wording that says which
       * it was, and none of them says anything about the website.
       */
      html`<p class="lead">${speed.message}</p>`;

  return `<section class="speed">` + `<h2>${SPEED_HEADING}</h2>` + body + explanationBlock(speed, null) + `</section>`;
}
