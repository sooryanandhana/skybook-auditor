/**
 * The client report's stylesheet.
 *
 * REUSES THE AUDIT RENDERER'S FACES. The same embedded IBM Plex files, under
 * the same family names, so this document travels with its own fonts exactly
 * as the automated report does and never depends on the reader's machine.
 *
 * PAGE FURNITURE IS CSS, NOT CHROMIUM'S TEMPLATES. The running head and the
 * "Page n of m" foot are drawn with `@page` margin boxes, which Chrome 131+
 * supports. Unlike the header/footer templates the automated report uses,
 * margin boxes belong to the document, so they use the embedded faces, and a
 * named `cover` page can switch them off for a full-bleed dark cover.
 *
 * RESTRAINED BY DESIGN. One accent (Skybook deep blue), a charcoal cover, and
 * muted severity colours. Every severity is also written as a word, so the
 * document still reads correctly printed in greyscale.
 */
import { FONT_FACE_CSS, MONO, SANS, SERIF } from "../audit/pdf/fonts.ts";
import { CLIENT } from "./verifiedReport.ts";

export const COLOURS = {
  charcoal: "#1b1e23",
  charcoalSoft: "#2a2e35",
  ink: "#1c2330",
  text: "#2e3643",
  muted: "#5f6876",
  faint: "#8a929e",
  hairline: "#dde1e6",
  panel: "#f5f6f8",
  accent: "#264a9a",
  accentBright: "#05a2e4",
  high: "#9b2c2c",
  highTint: "#fbefef",
  medium: "#9a5b0e",
  mediumTint: "#fcf5ea",
  low: "#56606d",
  lowTint: "#f1f3f5",
  validate: "#86650f",
  validateTint: "#fbf6e5",
  neutral: "#6a7280",
  healthy: "#2d6a4d",
  healthyTint: "#eef6f1",
} as const;

const C = COLOURS;

/** A CSS string literal, for margin-box `content`. Quotes and backslashes escaped. */
function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const RUNNING = `font-family:${SANS};font-size:7.5pt;color:${C.faint};`;

export const STYLESHEET: string =
  FONT_FACE_CSS +
  `
@page {
  size: A4;
  margin: 24mm 20mm 22mm 20mm;
  @top-left { content: "SKYBOOK"; ${RUNNING} color:${C.accent}; letter-spacing:.22em; vertical-align:bottom; padding-bottom:4mm; }
  @top-right { content: ${cssString(`Website Audit Report · ${CLIENT.name}`)}; ${RUNNING} vertical-align:bottom; padding-bottom:4mm; }
  @bottom-left { content: ${cssString(`${CLIENT.site}  ·  Audit Date: ${CLIENT.auditDate}`)}; ${RUNNING} vertical-align:top; padding-top:5mm; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); ${RUNNING} vertical-align:top; padding-top:5mm; }
}
@page cover {
  margin: 0;
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font-family: ${SANS};
  font-size: 9.5pt;
  line-height: 1.55;
  color: ${C.text};
  orphans: 3;
  widows: 3;
}
p { margin: 0 0 3mm; }
strong { font-weight: 600; color: ${C.ink}; }
code {
  font-family: ${MONO};
  font-size: .9em;
  color: ${C.ink};
  background: ${C.panel};
  padding: 0 .35em;
  border-radius: 2px;
  overflow-wrap: anywhere;
}
ul, ol { margin: 0 0 3mm; padding-left: 5mm; }
li { margin: 0 0 1.4mm; }
li::marker { color: ${C.faint}; }

/* ------------------------------------------------------------------ cover */
/*
 * White left panel and navy right panel, with the Skybook-blue arc artwork
 * drawn by the SVG in components.ts. Text sits on the white side only.
 */
.cover {
  page: cover;
  position: relative;
  width: 210mm;
  height: 297mm;
  background: #ffffff;
  overflow: hidden;
  break-after: page;
}
.cover__art { position: absolute; left: 0; top: 0; width: 210mm; height: 297mm; }
.cover__logo { position: absolute; left: 22mm; top: 24mm; overflow: hidden; }
.cover__logo img { position: absolute; }
.cover__label {
  display: block; font-size: 7pt; font-weight: 600; letter-spacing: .24em;
  text-transform: uppercase; color: ${C.accentBright}; margin-bottom: 2mm;
}
.cover__intro { position: absolute; left: 22mm; top: 84mm; }
.cover__intro-line {
  display: block; font-size: 10pt; letter-spacing: .16em; text-transform: uppercase;
  color: #0e1a33; line-height: 1.6;
}
.cover__body { position: absolute; left: 22mm; top: 124mm; width: 150mm; }
.cover__title {
  font-family: ${SANS}; font-weight: 600; text-transform: uppercase;
  font-size: 38pt; line-height: 1.08; letter-spacing: .01em; color: #0e1a33; margin: 0;
}
.cover__bar { width: 18mm; height: 1.4mm; background: ${C.accentBright}; margin: 9mm 0; }
.cover__period { font-size: 17pt; color: #7a8290; margin: 0; letter-spacing: .02em; }
.cover__foot {
  position: absolute; left: 22mm; bottom: 22mm;
  font-size: 11pt; font-weight: 600; color: #0e1a33; letter-spacing: .04em;
}

/* -------------------------------------------------------- section headers */
.section { break-before: page; }
.section-head { margin: 0 0 8mm; break-inside: avoid; break-after: avoid; }
.section-head__num {
  font-size: 7.5pt; letter-spacing: .28em; text-transform: uppercase;
  color: ${C.accent}; margin-bottom: 2.5mm;
}
.section-head__title {
  font-family: ${SERIF}; font-weight: 600; font-size: 23pt; line-height: 1.15;
  color: ${C.ink}; margin: 0;
}
.section-head__rule { width: 16mm; height: .8mm; background: ${C.accent}; margin-top: 5mm; }
.section-head__lede { font-size: 10.5pt; color: ${C.muted}; margin: 5mm 0 0; max-width: 150mm; }

.sub { margin: 9mm 0 3.5mm; break-after: avoid; }
.sub h3 {
  font-family: ${SERIF}; font-weight: 600; font-size: 13pt; color: ${C.ink}; margin: 0;
}
.sub__note { font-size: 8.8pt; color: ${C.muted}; margin: 1.5mm 0 0; }
.keep { break-inside: avoid; }
.lede { font-size: 10.5pt; color: ${C.text}; }
.note {
  font-size: 8.8pt; color: ${C.muted}; border-left: .6mm solid ${C.hairline};
  padding: .5mm 0 .5mm 3.5mm; margin: 3mm 0 4mm;
}

/* --------------------------------------------------------------- badges */
.badge {
  display: inline-block; font-size: 6.8pt; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; padding: .9mm 2.3mm .8mm; border-radius: 1.2mm;
  border: .25mm solid currentColor; line-height: 1.2; white-space: nowrap;
}
.badge--high { color: #ffffff; background: ${C.high}; border-color: ${C.high}; }
.badge--medium { color: ${C.medium}; background: ${C.mediumTint}; }
.badge--low { color: ${C.low}; background: ${C.lowTint}; border-color: ${C.hairline}; }
.badge--requires-validation { color: ${C.validate}; background: ${C.validateTint}; border-style: dashed; }
.badge--not-assigned { color: ${C.neutral}; background: #ffffff; border-color: ${C.hairline}; }
.badge--healthy { color: ${C.healthy}; background: ${C.healthyTint}; }
.badge--needs-attention { color: ${C.medium}; background: ${C.mediumTint}; }
.badge--pass { color: ${C.healthy}; background: ${C.healthyTint}; }
.badge--issue { color: ${C.medium}; background: ${C.mediumTint}; }
.badge--not-assessed { color: ${C.neutral}; background: #ffffff; border-color: ${C.hairline}; }
.badge--info { color: ${C.low}; background: ${C.lowTint}; border-color: ${C.hairline}; }

/* ---------------------------------------------------------- finding card */
.card {
  border: .25mm solid ${C.hairline};
  border-left: 1mm solid ${C.low};
  padding: 5mm 6mm 5mm 6mm;
  margin: 0 0 5mm;
  break-inside: avoid;
  background: #ffffff;
}
.card--high { border-left-color: ${C.high}; }
.card--medium { border-left-color: ${C.medium}; }
.card--low { border-left-color: #a3abb6; }
.card--not-assigned { border-left-color: ${C.neutral}; }
.card--requires-validation { border-left-color: ${C.validate}; border-left-style: dashed; }
.card__top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.8mm; }
.card__id { font-family: ${MONO}; font-size: 8pt; color: ${C.muted}; letter-spacing: .06em; }
.card__title {
  font-family: ${SERIF}; font-weight: 600; font-size: 12.5pt; line-height: 1.3;
  color: ${C.ink}; margin: 0 0 3.5mm;
}
.card--key { padding: 6.5mm 7mm; }
.card--key .card__title { font-size: 15pt; text-transform: none; }
.card--key .card__id { font-size: 9pt; color: ${C.high}; font-weight: 400; }
.field { display: grid; grid-template-columns: 27mm 1fr; column-gap: 4mm; margin: 0 0 2.6mm; }
.field__label {
  font-size: 6.8pt; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
  color: ${C.faint}; padding-top: .9mm;
}
.field__body { min-width: 0; overflow-wrap: anywhere; }
.field__body ul { margin: 0; padding-left: 3.8mm; }
.field__body li:last-child { margin-bottom: 0; }
.action {
  margin-top: 3.5mm; background: ${C.panel}; border-left: .8mm solid ${C.accent};
  padding: 3mm 4mm; display: grid; grid-template-columns: 27mm 1fr; column-gap: 4mm;
}
.action .field__label { color: ${C.accent}; }

/* -------------------------------------------------------- summary tiles */
.counts { display: grid; grid-template-columns: 1.25fr repeat(3, 1fr); gap: 3mm; margin: 4mm 0 3mm; }
.counts2 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin: 0 0 3mm; }
.tile {
  border: .25mm solid ${C.hairline}; padding: 3.2mm 4.5mm; break-inside: avoid; background: #ffffff;
}
.tile--lead { background: ${C.charcoal}; border-color: ${C.charcoal}; color: #ffffff; }
.tile__num { font-family: ${SERIF}; font-weight: 600; font-size: 21pt; line-height: 1; color: ${C.ink}; }
.tile--lead .tile__num { color: #ffffff; font-size: 26pt; }
.tile__label { font-size: 7pt; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: ${C.muted}; margin-top: 2.5mm; }
.tile--lead .tile__label { color: #aab4c3; }
.tile--high { border-top: 1mm solid ${C.high}; }
.tile--medium { border-top: 1mm solid ${C.medium}; }
.tile--low { border-top: 1mm solid #a3abb6; }
.tile--not-assigned { border-top: 1mm solid ${C.neutral}; }
.tile--requires-validation { border-top: 1mm dashed ${C.validate}; }
.tile--critical { border-top: 1mm solid ${C.hairline}; }
.tile__num--text { font-size: 13pt; padding-top: 3mm; }

.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.exec-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 7mm; align-items: start; break-inside: avoid; }
.exec-grid .sub { margin-top: 0; }
.panel--tight { margin: 0; font-size: 9pt; }
/* The executive summary is kept to one page. */
.exec .lede { font-size: 10pt; margin-bottom: 2mm; }
.exec .note { margin: 2mm 0 2mm; }
.exec .sub { margin: 6mm 0 2.5mm; }
.exec .exec-grid .sub { margin-top: 0; }
.exec .panel--tight { padding: 4mm 5mm; }
.exec .panel--tight li { margin-bottom: .6mm; }
.exec ol li { margin-bottom: 1mm; }
.panel { background: ${C.panel}; padding: 5mm 6mm; break-inside: avoid; margin: 0 0 5mm; }
.panel h4 {
  font-size: 7pt; font-weight: 600; letter-spacing: .18em; text-transform: uppercase;
  color: ${C.accent}; margin: 0 0 3mm;
}
.panel ol, .panel ul { margin-bottom: 0; }

/* -------------------------------------------------------- health cards */
.health { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin: 2mm 0 8mm; }
.health-card {
  border: .25mm solid ${C.hairline}; padding: 4.5mm 5mm; break-inside: avoid;
  border-top: 1mm solid ${C.medium}; background: #ffffff;
}
.health-card--healthy { border-top-color: ${C.healthy}; }
.health-card__top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5mm; }
.health-card__name { font-family: ${SERIF}; font-weight: 600; font-size: 12pt; color: ${C.ink}; }
.health-card__basis { font-size: 8.6pt; color: ${C.muted}; line-height: 1.5; margin: 0; }
.strength-list { columns: 2; column-gap: 8mm; list-style: none; padding: 0; }
.strength-list li { break-inside: avoid; padding-left: 5mm; position: relative; }
.strength-list li::before {
  content: ""; position: absolute; left: 0; top: 1.9mm; width: 2mm; height: 2mm;
  border-radius: 50%; background: ${C.healthy};
}

/* ---------------------------------------------------------- metric cards */
.scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 0 0 4mm; }
.score { border: .25mm solid ${C.hairline}; padding: 3.5mm 4mm; text-align: left; break-inside: avoid; }
.score__num { font-family: ${SERIF}; font-weight: 600; font-size: 22pt; line-height: 1; color: ${C.ink}; }
.score__label { font-size: 7pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: ${C.muted}; margin-top: 2mm; }
.score--lead { background: ${C.charcoal}; border-color: ${C.charcoal}; }
.score--lead .score__num { color: #ffffff; }
.score--lead .score__label { color: #aab4c3; }
.grades { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2.5mm; margin: 0 0 4mm; }
.grade { border: .25mm solid ${C.hairline}; padding: 3mm; text-align: center; break-inside: avoid; }
.grade__letter { font-family: ${SERIF}; font-weight: 600; font-size: 18pt; line-height: 1; color: ${C.ink}; }
.grade--F .grade__letter { color: ${C.high}; }
.grade--A .grade__letter { color: ${C.healthy}; }
.grade--X .grade__letter { color: ${C.neutral}; }
.grade__label { font-size: 6.6pt; letter-spacing: .08em; text-transform: uppercase; color: ${C.muted}; margin-top: 1.8mm; line-height: 1.3; }
.grade__note { font-size: 6.6pt; color: ${C.faint}; }
.validate {
  border: .3mm dashed ${C.validate}; background: ${C.validateTint};
  padding: 3.5mm 4.5mm; margin: 0 0 5mm; font-size: 8.8pt; color: ${C.ink}; break-inside: avoid;
}
.validate strong { color: ${C.validate}; }
.value-rv { color: ${C.validate}; font-weight: 600; }

/* ---------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; margin: 0 0 5mm; font-size: 8.8pt; }
thead { display: table-header-group; }
th {
  text-align: left; font-size: 6.8pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
  color: ${C.muted}; border-bottom: .4mm solid ${C.ink}; padding: 0 3mm 2mm 0;
}
td { border-bottom: .25mm solid ${C.hairline}; padding: 2.4mm 3mm 2.4mm 0; vertical-align: top; overflow-wrap: anywhere; }
tr { break-inside: avoid; }
td.id { font-family: ${MONO}; font-size: 7.8pt; color: ${C.muted}; white-space: nowrap; }
td.num { white-space: nowrap; font-weight: 600; color: ${C.ink}; }
td.state { white-space: nowrap; text-align: right; padding-right: 0; }
.current { color: ${C.muted}; }
.recommended { color: ${C.ink}; }
.arrow { color: ${C.faint}; }

/* --------------------------------------------------------- action plan */
.plan-head { display: flex; align-items: center; gap: 3mm; margin: 8mm 0 3mm; break-after: avoid; }
.plan-head h3 { font-family: ${SERIF}; font-weight: 600; font-size: 13pt; color: ${C.ink}; margin: 0; }
.plan-head__count { font-size: 8pt; color: ${C.muted}; }
.plan td.flow { color: ${C.ink}; }
.plan td.id { white-space: normal; }
.plan table, table.plan { table-layout: fixed; }
.plan .step { display: block; }
.plan .step__label { font-size: 6.4pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: ${C.faint}; }

/* --------------------------------------------------------------- misc */
.ids { font-family: ${MONO}; font-size: 8pt; color: ${C.muted}; }
.closing { font-family: ${SERIF}; font-weight: 600; font-size: 12pt; color: ${C.ink}; margin-top: 6mm; }
`;
