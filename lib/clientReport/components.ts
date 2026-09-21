/**
 * Reusable pieces of the client report, each returning escaped HTML.
 *
 * Every value passes through `rich` or `plain` from `markup.ts`. None of these
 * functions chooses wording, changes a value or decides a severity: they lay
 * out what `verifiedReport.ts` holds.
 */
import { LOGO_BOX, LOGO_DATA_URI } from "../audit/pdf/logo.ts";
import { plain, rich } from "./markup.ts";
import {
  CLIENT,
  SEVERITY_LABEL,
  type ActionRow,
  type CheckRow,
  type Finding,
  type HealthItem,
  type Metric,
  type Severity,
} from "./verifiedReport.ts";

// ------------------------------------------------------------------- cover

/**
 * The cover's artwork, drawn as one SVG in millimetres (the page is 210 × 297).
 *
 * A white left panel, a navy right panel, a white disc that cuts into the navy,
 * and an arc band around the disc in the Skybook logo's blue gradient — bright
 * at both ends, deepening towards the middle where it meets the navy.
 */
const COVER_SPLIT_X = 92;
const DISC = { cx: 92, cy: 150, r: 76 } as const;
const BAND = { r: 94, width: 20 } as const;

function coverArt(): string {
  const { cx, cy, r } = DISC;
  const inner = BAND.r - BAND.width / 2;
  const outer = BAND.r + BAND.width / 2;
  const blockWidth = 22;
  return (
    `<svg class="cover__art" viewBox="0 0 210 297" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs>` +
    /*
     * As in the reference: brightest where the band meets the white panel,
     * dissolving into the navy as it curves out to the right.
     */
    `<linearGradient id="band" gradientUnits="userSpaceOnUse" x1="${cx}" y1="0" x2="${cx + outer}" y2="0">` +
    `<stop offset="0" stop-color="#05a2e4"/>` +
    `<stop offset="0.3" stop-color="#0d8fd6"/>` +
    `<stop offset="0.6" stop-color="#1a5aa8"/>` +
    `<stop offset="0.85" stop-color="#16305f"/>` +
    `<stop offset="1" stop-color="#0e1a33"/>` +
    `</linearGradient>` +
    // Depth: the band's outer edge sinks into the navy.
    `<radialGradient id="depth" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${outer}">` +
    `<stop offset="${(inner / outer).toFixed(3)}" stop-color="#0e1a33" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#0e1a33" stop-opacity="0.6"/>` +
    `</radialGradient>` +
    // The blocks soften towards the page edges, brightest where they meet the arc.
    `<linearGradient id="fadeTop" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0e1a33" stop-opacity="0.55"/><stop offset="1" stop-color="#0e1a33" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<linearGradient id="fadeBottom" x1="0" y1="1" x2="0" y2="0">` +
    `<stop offset="0" stop-color="#0e1a33" stop-opacity="0.55"/><stop offset="1" stop-color="#0e1a33" stop-opacity="0"/>` +
    `</linearGradient>` +
    // The straight blocks above and below the arc stop at the band's inner edge.
    `<mask id="blocks"><rect x="0" y="0" width="210" height="297" fill="#fff"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="#000"/></mask>` +
    // Pure white where the disc meets the white panel, so there is no seam.
    `<radialGradient id="disc" cx="0" cy="0.5" r="1">` +
    `<stop offset="0.45" stop-color="#ffffff"/><stop offset="1" stop-color="#edf0f4"/>` +
    `</radialGradient>` +
    `<clipPath id="right"><rect x="${COVER_SPLIT_X}" y="0" width="${210 - COVER_SPLIT_X}" height="297"/></clipPath>` +
    `</defs>` +
    `<rect x="${COVER_SPLIT_X}" y="0" width="${210 - COVER_SPLIT_X}" height="297" fill="#0e1a33"/>` +
    `<g clip-path="url(#right)">` +
    `<g mask="url(#blocks)" fill="url(#band)">` +
    `<rect x="${COVER_SPLIT_X}" y="0" width="${blockWidth}" height="${cy - inner + 1}"/>` +
    `<rect x="${COVER_SPLIT_X}" y="${cy + inner - 1}" width="${blockWidth}" height="${297 - cy - inner + 1}"/>` +
    `</g>` +
    `<rect x="${COVER_SPLIT_X}" y="0" width="${blockWidth}" height="${cy - outer}" fill="url(#fadeTop)"/>` +
    `<rect x="${COVER_SPLIT_X}" y="${cy + outer}" width="${blockWidth}" height="${297 - cy - outer}" fill="url(#fadeBottom)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${BAND.r}" fill="none" stroke="url(#band)" stroke-width="${BAND.width}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${BAND.r}" fill="none" stroke="url(#depth)" stroke-width="${BAND.width}"/>` +
    `</g>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#disc)" clip-path="url(#right)"/>` +
    `<rect x="0" y="0" width="${COVER_SPLIT_X}" height="297" fill="#ffffff"/>` +
    `</svg>`
  );
}

export function cover(): string {
  const box = LOGO_BOX;
  return (
    `<section class="cover" aria-label="Cover">` +
    coverArt() +
    `<div class="cover__logo" style="width:${box.width}mm;height:${box.height}mm">` +
    `<img src="${LOGO_DATA_URI}" alt="Skybook Digital" ` +
    `style="width:${box.imageWidth}mm;left:-${box.offsetLeft}mm;top:-${box.offsetTop}mm"></div>` +
    `<div class="cover__intro">` +
    `<span class="cover__label">Prepared for</span>` +
    `<span class="cover__intro-line">${plain(CLIENT.name)}</span>` +
    `<span class="cover__intro-line">${plain(CLIENT.site)}</span>` +
    `</div>` +
    `<div class="cover__body">` +
    `<h1 class="cover__title">Website<br>Audit Report</h1>` +
    `<div class="cover__bar"></div>` +
    `<p class="cover__period"><span class="cover__label">Audit date</span>${plain(CLIENT.auditDate)}</p>` +
    `</div>` +
    `<div class="cover__foot"><span class="cover__label">Prepared by</span>${plain(CLIENT.preparedBy)}</div>` +
    `</section>`
  );
}

// ---------------------------------------------------------- section header

export function sectionHead(num: number, title: string, lede?: string): string {
  return (
    `<header class="section-head">` +
    `<div class="section-head__num">Section ${String(num).padStart(2, "0")}</div>` +
    `<h2 class="section-head__title">${plain(title)}</h2>` +
    `<div class="section-head__rule"></div>` +
    (lede === undefined ? "" : `<p class="section-head__lede">${rich(lede)}</p>`) +
    `</header>`
  );
}

export function section(num: number, title: string, body: string, lede?: string): string {
  return `<section class="section">${sectionHead(num, title, lede)}${body}</section>`;
}

export function sub(title: string, note?: string): string {
  return (
    `<div class="sub"><h3>${plain(title)}</h3>` +
    (note === undefined ? "" : `<p class="sub__note">${rich(note)}</p>`) +
    `</div>`
  );
}

// ------------------------------------------------------------------ badges

/**
 * A subheading kept on the same page as the first block beneath it, so a
 * heading is never stranded at the foot of a page. The rest follow normally.
 */
export function headed(heading: string, blocks: readonly string[]): string {
  if (blocks.length === 0) return heading;
  return `<div class="keep">${heading}${blocks[0]}</div>${blocks.slice(1).join("")}`;
}

export function severityBadge(severity: Severity): string {
  return `<span class="badge badge--${severity}">${plain(SEVERITY_LABEL[severity])}</span>`;
}

const STATE_LABEL: Record<CheckRow["state"], string> = {
  pass: "Pass",
  issue: "Issue",
  "not-assessed": "Not assessed",
  info: "Info",
};

export function stateBadge(state: CheckRow["state"]): string {
  return `<span class="badge badge--${state}">${STATE_LABEL[state]}</span>`;
}

// ------------------------------------------------------------ finding card

function evidenceBody(evidence: string | readonly string[]): string {
  if (typeof evidence === "string") return rich(evidence);
  return `<ul>${evidence.map((item) => `<li>${rich(item)}</li>`).join("")}</ul>`;
}

function field(label: string, body: string): string {
  return (
    `<div class="field"><div class="field__label">${plain(label)}</div>` +
    `<div class="field__body">${body}</div></div>`
  );
}

export function recommendation(label: string, text: string): string {
  return (
    `<div class="action"><div class="field__label">${plain(label)}</div>` +
    `<div class="field__body">${rich(text)}</div></div>`
  );
}

export function findingCard(finding: Finding, options: { key?: boolean } = {}): string {
  const classes = ["card", `card--${finding.severity}`, options.key === true ? "card--key" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    `<article class="${classes}">` +
    `<div class="card__top"><span class="card__id">${plain(finding.id)}</span>${severityBadge(finding.severity)}</div>` +
    `<h3 class="card__title">${rich(finding.title)}</h3>` +
    field("Affected", rich(finding.affected)) +
    field("Evidence", evidenceBody(finding.evidence)) +
    field("Impact", rich(finding.impact)) +
    recommendation("Recommended action", finding.action) +
    `</article>`
  );
}

/** Performance findings use the found → why → action shape the brief asks for. */
export function perfCard(finding: {
  id: string;
  title: string;
  found: string | readonly string[];
  why: string;
  action: string;
}): string {
  return (
    `<article class="card card--not-assigned">` +
    `<div class="card__top"><span class="card__id">${plain(finding.id)}</span>${severityBadge("not-assigned")}</div>` +
    `<h3 class="card__title">${rich(finding.title)}</h3>` +
    field("What was found", evidenceBody(finding.found)) +
    field("Why it matters", rich(finding.why)) +
    recommendation("Recommended action", finding.action) +
    `</article>`
  );
}

// ------------------------------------------------------------ health card

const HEALTH_LABEL = { healthy: "Healthy", "needs-attention": "Needs attention" } as const;

export function healthCard(item: HealthItem): string {
  return (
    `<div class="health-card health-card--${item.status}">` +
    `<div class="health-card__top"><span class="health-card__name">${plain(item.category)}</span>` +
    `<span class="badge badge--${item.status}">${HEALTH_LABEL[item.status]}</span></div>` +
    `<p class="health-card__basis">${rich(item.basis)}</p>` +
    `</div>`
  );
}

// ------------------------------------------------------------ metric cards

export function countTile(num: string, label: string, modifier = ""): string {
  const textual = !/^\d+$/.test(num);
  return (
    `<div class="tile${modifier === "" ? "" : ` tile--${modifier}`}">` +
    `<div class="tile__num${textual ? " tile__num--text" : ""}">${plain(num)}</div>` +
    `<div class="tile__label">${plain(label)}</div></div>`
  );
}

export function scoreCards(scores: readonly Metric[]): string {
  return (
    `<div class="scores">` +
    scores
      .map(
        (score, index) =>
          `<div class="score${index === 0 ? " score--lead" : ""}">` +
          `<div class="score__num">${plain(score.value)}</div>` +
          `<div class="score__label">${plain(score.label)}</div></div>`,
      )
      .join("") +
    `</div>`
  );
}

export function metricTable(metrics: readonly Metric[], ratingHeader = "PageSpeed rating"): string {
  const withRating = metrics.some((metric) => metric.rating !== undefined);
  const rows = metrics
    .map((metric) => {
      const value = metric.requiresValidation === true
        ? `<span class="value-rv">${plain(metric.value)}</span> <span class="badge badge--requires-validation">Requires validation</span>`
        : plain(metric.value);
      const rating = metric.rating === undefined ? "" : plain(metric.rating);
      return `<tr><td>${plain(metric.label)}</td><td class="num">${value}</td>${withRating ? `<td>${rating}</td>` : ""}</tr>`;
    })
    .join("");
  return (
    `<table><thead><tr><th>Metric</th><th>Result</th>${withRating ? `<th>${plain(ratingHeader)}</th>` : ""}</tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

export function gradeCards(grades: readonly { label: string; grade: string; note?: string }[]): string {
  return (
    `<div class="grades">` +
    grades
      .map(
        (grade) =>
          `<div class="grade grade--${plain(grade.grade)}"><div class="grade__letter">${plain(grade.grade)}</div>` +
          `<div class="grade__label">${plain(grade.label)}</div>` +
          (grade.note === undefined ? "" : `<div class="grade__note">${plain(grade.note)}</div>`) +
          `</div>`,
      )
      .join("") +
    `</div>`
  );
}

// ------------------------------------------------------------------ tables

export function checkTable(rows: readonly CheckRow[], headers = ["Check", "Result", "Status"]): string {
  return (
    `<table><thead><tr><th style="width:30%">${plain(headers[0])}</th><th>${plain(headers[1])}</th>` +
    `<th style="text-align:right">${plain(headers[2])}</th></tr></thead><tbody>` +
    rows
      .map(
        (row) =>
          `<tr><td><strong>${plain(row.check)}</strong></td><td>${rich(row.result)}</td>` +
          `<td class="state">${stateBadge(row.state)}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

export function simpleTable(headers: readonly string[], rows: readonly (readonly string[])[], widths?: readonly string[]): string {
  const head = headers
    .map((header, i) => `<th${widths?.[i] ? ` style="width:${widths[i]}"` : ""}>${plain(header)}</th>`)
    .join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ------------------------------------------------------------- action plan

export function actionTable(rows: readonly ActionRow[]): string {
  return (
    `<table class="plan"><thead><tr><th style="width:17%">ID</th><th style="width:27%">Issue</th>` +
    `<th style="width:30%">Recommended action</th><th>Expected benefit</th></tr></thead><tbody>` +
    rows
      .map(
        (row) =>
          `<tr><td class="id">${plain(row.ids)}</td><td>${rich(row.issue)}</td>` +
          `<td class="flow">${rich(row.action)}</td><td>${rich(row.benefit)}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

export function planHead(title: string, badge: string, count: string): string {
  return `<div class="plan-head">${badge}<h3>${plain(title)}</h3><span class="plan-head__count">${plain(count)}</span></div>`;
}

export function list(items: readonly string[], ordered = false): string {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map((item) => `<li>${rich(item)}</li>`).join("")}</${tag}>`;
}
