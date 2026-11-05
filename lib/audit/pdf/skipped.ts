/**
 * The checks that did not run.
 *
 * WHY A REPORT ADMITS ITS OWN GAPS. A clean-looking audit that quietly omitted
 * six checks overstates itself, and the client who later discovers one of them
 * has every reason to distrust the rest. 7A §14 carries the heading and its
 * one line of context word for word, and this file prints both as given: the
 * intro says these checks did not run, so nothing is claimed about them either
 * way, and that sentence is doing real work.
 *
 * NO BADGE AND NO COLOUR. 7A §14 says so outright. A check that could not run
 * is not a finding, and giving it the visual language of one would turn our
 * own gap into an accusation about the client's website.
 *
 * GROUPED BY REASON, NOT BY CHECK. One cause usually stops several checks at
 * once -- a page too thin to judge, a lookup that timed out -- and a reader
 * needs the cause once rather than repeated beside each check.
 */
import type { PdfSkipped, PdfSkippedGroup } from "../pdfDocument.ts";
import { html } from "./escape.ts";

/**
 * One reason, and everything it stopped.
 *
 * The checks come first and the reason follows, because the reader's question
 * is "what did you not check" before it is "why".
 */
function reasonGroup(group: PdfSkippedGroup): string {
  const checks = group.checks.map((check) => html`<li>${check}</li>`).join("");

  return (
    `<div class="skipped-group">` +
    `<ul class="skipped-checks">${checks}</ul>` +
    html`<p class="note">${group.reason}</p>` +
    `</div>`
  );
}

/**
 * Every reason and the checks it stopped, without a section or a heading
 * (CP1 F10, CP3 step 3c-ii), so the Limitations section can reuse the same
 * grouping. Nothing at all for an empty list.
 */
export function skippedGroupsHtml(groups: readonly PdfSkippedGroup[]): string {
  return groups.map(reasonGroup).join("");
}

/**
 * The section, or nothing at all.
 *
 * 7A §19: with nothing skipped the section is omitted entirely. 7B passes null
 * for exactly that case, so an audit where every check ran carries no heading
 * inviting a reader to look for an absence that is not there.
 */
export function skippedHtml(skipped: PdfSkipped | null): string {
  if (skipped === null || skipped.count === 0 || skipped.groups.length === 0) return "";

  return (
    `<section class="skipped">` +
    html`<h2>${skipped.heading}</h2>` +
    html`<p class="lead">${skipped.intro}</p>` +
    skippedGroupsHtml(skipped.groups) +
    `</section>`
  );
}
