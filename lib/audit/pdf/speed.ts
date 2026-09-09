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
import type { PdfLabels, PdfMetric, PdfSpeed } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/** The section's title. See the note in `coverage.ts` on why it lives here. */
const SPEED_HEADING = "Speed";

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
export function speedHtml(speed: PdfSpeed, labels: PdfLabels): string {
  const body = speed.measured
    ? fieldBlock(speed, labels) + labBlock(speed, labels) + notInspected(speed, labels)
    : /*
       * The projection's own sentence, and nothing added to it. Every one of
       * the four non-measured states -- nobody asked, still running, no key on
       * this server, the check errored -- already has wording that says which
       * it was, and none of them says anything about the website.
       */
      html`<p class="lead">${speed.message}</p>`;

  return `<section class="speed">` + `<h2>${SPEED_HEADING}</h2>` + body + `</section>`;
}
