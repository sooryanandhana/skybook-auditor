/**
 * "Let's Make Your Website Work Better for Your Business": the Skybook section
 * (CP1 F11, U1, CP3 step 3c-ii). Its internal name is "How Skybook Can Help".
 *
 * [COMPANY] CONFIRMED (CP1 R2). Skybook has approved the section's marketing
 * claims, the report contact wording and contact-field approach, and the exact
 * brand name: Skybook.
 *
 * PRINTED. Since CP3 step 4b, `shell.ts` prints `pitchSectionHtml`
 * immediately before Limitations and About This Audit.
 *
 * FIXED WORDING ONLY. It reads nothing from the audit and claims nothing about
 * the audited site. The copy is the approved text, copied here because
 * renderer files may import only from this folder and the document model;
 * pitch.test.mts holds it equal to `PITCH_HEADING` and `PITCH_PARAGRAPHS` in
 * lib/report/reportSections.ts.
 */
import { html } from "./escape.ts";

/** Equal to `PITCH_HEADING` in lib/report/reportSections.ts. [COMPANY] */
export const PITCH_SECTION_HEADING = "Let's Make Your Website Work Better for Your Business";

/** Equal to `PITCH_PARAGRAPHS` in lib/report/reportSections.ts. [COMPANY] */
export const PITCH_SECTION_PARAGRAPHS: readonly string[] = [
  "This audit gives a clear picture of how your website performs today: where it is working well and where it could do more for your business. The next step is turning those findings into practical improvements.",
  "The Skybook team can work through this report with you, explain what each finding means for your business, and help you decide which improvements matter most and in what order. We can help improve how quickly your pages load and how smoothly they work for visitors, and strengthen how clearly your website presents itself to search engines and to the people searching for what you offer.",
  "Where findings involve technical or security settings, we can work alongside your developer or hosting provider so that changes are planned carefully and made without disrupting your website or email. Beyond the first round of changes, we can help you plan ongoing improvements and run a follow-up audit to confirm what has changed, using the same measurements as this report.",
  "If you would like to discuss these findings, your Skybook contact will be glad to talk them through with you.",
];

/** The section: the heading and the four approved paragraphs. Identical in every document. */
export function pitchSectionHtml(): string {
  return (
    `<section class="pitch">` +
    html`<h2>${PITCH_SECTION_HEADING}</h2>` +
    PITCH_SECTION_PARAGRAPHS.map((paragraph) => html`<p>${paragraph}</p>`).join("") +
    `</section>`
  );
}
