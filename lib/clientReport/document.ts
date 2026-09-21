/**
 * The client report, section by section, as one HTML document.
 *
 * THE SIXTEEN SECTIONS, IN THE APPROVED ORDER. Each builder reads only
 * `verifiedReport.ts`. Findings appear in full exactly once; other sections
 * refer to them by ID.
 *
 * `simpleTable` takes cells that are already markup, so every cell passed to it
 * below goes through `plain` or `rich` first.
 */
import {
  actionTable,
  checkTable,
  countTile,
  cover,
  findingCard,
  gradeCards,
  headed,
  healthCard,
  list,
  metricTable,
  perfCard,
  planHead,
  scoreCards,
  section,
  severityBadge,
  simpleTable,
  stateBadge,
  sub,
} from "./components.ts";
import { plain, rich } from "./markup.ts";
import { STYLESHEET } from "./styles.ts";
import * as R from "./verifiedReport.ts";

export const SECTION_TITLES = [
  "Executive Summary",
  "Website Health Overview",
  "Key Findings",
  "SEO Audit",
  "Technical SEO / Crawl",
  "Performance",
  "Security",
  "SSL / Certificate",
  "DNS / Infrastructure",
  "Content Quality",
  "Visual / UX / Accessibility",
  "Strengths",
  "Priority Action Plan",
  "Final Assessment",
  "Appendix — Scope, Tools, Limitations & Not Assessed",
] as const;

/** Section numbers follow the brief: 1 is the cover, so content starts at 2. */
const num = (title: (typeof SECTION_TITLES)[number]) => SECTION_TITLES.indexOf(title) + 2;

function executiveSummary(): string {
  const c = R.findingCounts();
  const body =
    `<p class="lede">${rich(R.EXECUTIVE_INTRO)}</p>` +
    `<p class="note">${rich(`**Audit Date:** ${R.CLIENT.auditDate} · ${R.CLIENT.site}`)}</p>` +
    `<div class="counts">` +
    `<div class="tile tile--lead"><div class="tile__num">${c.confirmed}</div><div class="tile__label">Confirmed findings</div></div>` +
    countTile(String(c.high), "High", "high") +
    countTile(String(c.medium), "Medium", "medium") +
    countTile(String(c.low), "Low", "low") +
    `</div>` +
    `<div class="counts2">` +
    countTile(String(c.notAssigned), "Severity not assigned", "not-assigned") +
    countTile(String(c.requiresValidation), "Requires validation (in addition)", "requires-validation") +
    countTile("None identified", "Critical", "critical") +
    `</div>` +
    `<div class="exec-grid">` +
    `<div>${sub("Overall condition")}<p>${rich(R.EXECUTIVE_CONDITION)}</p></div>` +
    `<div class="panel panel--tight"><h4>Highest-priority improvements</h4>${list(R.EXECUTIVE_PRIORITIES, true)}</div>` +
    `</div>` +
    // Not kept whole: the heading stays with the list, and the list may flow on.
    sub("Main areas for improvement") + list(R.EXECUTIVE_AREAS, true);
  return section(num("Executive Summary"), "Executive Summary", `<div class="exec">${body}</div>`);
}

function healthOverview(): string {
  const body =
    `<div class="health">${R.HEALTH.map(healthCard).join("")}</div>` +
    `<div class="keep">${sub("Verified strengths", "Section 13 has the full list.")}` +
    `<ul class="strength-list">${R.HEALTH_STRENGTHS.map((s) => `<li>${rich(s)}</li>`).join("")}</ul></div>`;
  return section(num("Website Health Overview"), "Website Health Overview", body);
}

function keyFindings(): string {
  const body = R.KEY_FINDINGS.map((finding) => findingCard(finding, { key: true })).join("");
  return section(
    num("Key Findings"),
    "Key Findings",
    body,
    "**No Critical findings were identified.** The seven High-severity findings are below.",
  );
}

function seoAudit(): string {
  const body =
    `<div class="keep">${sub("Titles")}${checkTable(R.SEO_TITLE_CHECKS)}</div>` +
    `<div class="keep">${sub("Meta descriptions", R.SEO_META_NOTE)}${checkTable(R.SEO_META_CHECKS)}</div>` +
    findingCard(R.SEO_01) +
    `<div class="keep">${sub("Headings")}${checkTable(R.SEO_HEADING_CHECKS)}</div>` +
    headed(sub("Images"), [findingCard(R.SEO_02)]) +
    headed(sub("Canonical", R.SEO_CANONICAL_NOTE), [checkTable(R.SEO_CANONICAL_CHECKS), findingCard(R.SEO_03)]) +
    `<div class="keep">${sub("Indexability")}${checkTable(R.SEO_INDEXABILITY)}</div>` +
    `<div class="keep">${sub("Structured data")}<p>${severityBadge("requires-validation")} ${rich("**SEO-04.** No structured data detected. Requires validation — see Section 14, Priority Action Plan.")}</p></div>` +
    `<div class="keep">${sub("URLs")}${list(R.SEO_URL_NOTES)}</div>`;
  return section(num("SEO Audit"), "SEO Audit", body);
}

function technicalSeo(): string {
  const body =
    checkTable(R.TECH_CHECKS) +
    R.TECH_FINDINGS.map((finding) => findingCard(finding)).join("") +
    `<div class="validate">${rich("**RV-02 — Requires validation.** PageSpeed's SEO audit reports “links are not crawlable” and one link without descriptive text. The specific links were not recorded, so this is not treated as a confirmed finding.")}</div>`;
  return section(num("Technical SEO / Crawl"), "Technical SEO / Crawl", body);
}

function performance(): string {
  const body =
    `<div class="keep">${sub("PageSpeed Insights — mobile", R.PSI_MOBILE_CONDITIONS)}${scoreCards(R.PSI_MOBILE_SCORES)}</div>` +
    `<div class="keep">${metricTable([
      ...R.PSI_MOBILE_METRICS,
    ])}</div>` +
    `<div class="validate">${rich(`**RV-01 — Requires validation.** ${R.LCP_VALIDATION_NOTE}`)}</div>` +
    `<p class="note">${rich(`Real-visitor data: ${R.PSI_FIELD_DATA}`)}</p>` +
    `<div class="keep">${sub("PageSpeed Insights — desktop")}${scoreCards(R.PSI_DESKTOP_SCORES)}<p class="note">${rich(R.PSI_DESKTOP_NOTE)}</p></div>` +
    `<div class="keep">${sub("WebPageTest", R.WPT_CONDITIONS)}${simpleTable(
      ["Measurement", "Result"],
      R.WPT_METRICS.map((m) => [plain(m.label), `<strong>${plain(m.value)}</strong>`]),
      ["50%", "50%"],
    )}</div>` +
    `<div class="keep">${sub("WebPageTest grades")}${gradeCards(R.WPT_GRADES)}</div>` +
    `<p class="note">${rich(R.PERF_COMPARISON_NOTE)}</p>` +
    headed(
      sub("Findings", "All performance findings are confirmed. Severity was not assigned."),
      R.PERF_FINDINGS.map(perfCard),
    ) +
    `<div class="validate">${rich("**RV-03 — Requires validation.** PageSpeed Best Practices reports “Displays images with incorrect aspect ratio”. The affected images were not recorded.")}</div>`;
  return section(num("Performance"), "Performance", body, "Measured results first, followed by findings and recommendations.");
}

function security(): string {
  const headers = simpleTable(
    ["Header", "Purpose"],
    R.SECURITY_HEADERS.map((h) => [`<strong>${plain(h.header)}</strong>`, plain(h.purpose)]),
    ["38%", "62%"],
  );
  const body =
    `<div class="keep">${sub("Healthy / passes")}${checkTable(R.SECURITY_PASSES)}</div>` +
    headed(sub("Issues found"), [
      `<p>${rich("**HTTP not redirected to HTTPS:** see **K1** (High).")}</p>` + findingCard(R.SEC_01),
    ]) +
    `<div class="keep">${sub("The six missing headers")}${headers}</div>` +
    findingCard(R.SEC_02);
  return section(num("Security"), "Security", body);
}

function ssl(): string {
  const body =
    checkTable(R.SSL_RESULTS, ["Item", "Result", "Status"]) +
    `<div class="panel"><h4>For information — not findings</h4>${list(R.SSL_INFO)}</div>`;
  return section(num("SSL / Certificate"), "SSL / Certificate", body);
}

function dns(): string {
  const table =
    `<table><thead><tr><th style="width:12%">Record</th><th style="width:38%">Result</th><th>What it means</th><th style="text-align:right">Status</th></tr></thead><tbody>` +
    R.DNS_RECORDS.map(
      (r) =>
        `<tr><td><strong>${plain(r.record)}</strong></td><td><code>${plain(r.result)}</code></td>` +
        `<td>${rich(r.meaning)}</td><td class="state">${stateBadge(r.state)}</td></tr>`,
    ).join("") +
    `</tbody></table>`;
  const body =
    table +
    `<p class="note">${rich("**Status: Healthy.** No DNS problems were found. The absence of AAAA and CNAME records is not a defect. SPF and DMARC were not assessed.")}</p>`;
  return section(num("DNS / Infrastructure"), "DNS / Infrastructure", body);
}

function contentQuality(): string {
  const table =
    `<table><thead><tr><th style="width:9%">ID</th><th style="width:17%">Location</th><th style="width:31%">Current</th>` +
    `<th style="width:25%">Recommended</th><th style="text-align:right">Type / severity</th></tr></thead><tbody>` +
    R.CONTENT_ROWS.map(
      (row) =>
        `<tr><td class="id">${plain(row.id)}</td><td>${plain(row.location)}</td>` +
        `<td class="current">“${plain(row.current)}”</td>` +
        `<td class="recommended">${/^(Rewrite|Use )/.test(row.recommended) ? plain(row.recommended) : `“${plain(row.recommended)}”`}</td>` +
        `<td class="state"><div style="font-size:7.6pt;color:#5f6876;margin-bottom:1mm">${plain(row.type)}</div>${severityBadge(row.severity)}</td></tr>`,
    ).join("") +
    `</tbody></table>`;
  const body =
    table + headed(sub("Other confirmed content issues"), R.CONTENT_FINDINGS.map((f) => findingCard(f)));
  return section(num("Content Quality"), "Content Quality", body, "Current text → recommended text, exactly as found on the site.");
}

function visualUx(): string {
  const body =
    `<p>${rich("The High-severity UX findings are in Section 04: **K2, K3, K4, K5**.")}</p>` +
    R.UX_GROUPS.map(
      (group) => headed(sub(group.heading, group.note), group.findings.map((f) => findingCard(f))),
    ).join("");
  return section(num("Visual / UX / Accessibility"), "Visual / UX / Accessibility", body);
}

function strengths(): string {
  const body =
    `<div class="two-col">` +
    R.STRENGTHS.map(
      (s) => `<div class="keep" style="margin-bottom:4mm"><strong>${plain(s.title)}</strong><br>${rich(s.text)}</div>`,
    ).join("") +
    `</div>`;
  return section(num("Strengths"), "Strengths", body, "Verified strengths only.");
}

function actionPlan(): string {
  const validation =
    `<table class="plan"><thead><tr><th style="width:12%">ID</th><th style="width:34%">Item</th><th style="width:24%">Validation step</th><th>Why</th></tr></thead><tbody>` +
    R.REQUIRES_VALIDATION.map(
      (row) =>
        `<tr><td class="id">${plain(row.id)}</td><td>${rich(row.item)}</td><td class="flow">${rich(row.step)}</td><td>${rich(row.why)}</td></tr>`,
    ).join("") +
    `</tbody></table>`;
  const c = R.findingCounts();
  const body =
    `<p class="note">${rich("Each row reads: issue → recommended action → expected benefit.")}</p>` +
    planHead("High priority", severityBadge("high"), `${c.high} findings`) +
    actionTable(R.ACTIONS_HIGH) +
    planHead("Medium priority", severityBadge("medium"), `${c.medium} findings`) +
    actionTable(R.ACTIONS_MEDIUM) +
    planHead("Low priority", severityBadge("low"), `${c.low} findings`) +
    actionTable(R.ACTIONS_LOW) +
    planHead("Severity not assigned", severityBadge("not-assigned"), `${c.notAssigned} findings — confirmed, no severity assigned`) +
    actionTable(R.ACTIONS_NOT_ASSIGNED) +
    planHead("Requires validation", severityBadge("requires-validation"), `${c.requiresValidation} items — confirm before acting`) +
    validation;
  return section(num("Priority Action Plan"), "Priority Action Plan", body);
}

function finalAssessment(): string {
  const f = R.FINAL_ASSESSMENT;
  const body =
    `<p class="lede">${rich(f.foundation)}</p>` +
    `<div class="keep">${sub("Main risks and weaknesses")}${list(f.risks)}</div>` +
    `<div class="panel"><h4>Most important next steps</h4>${list(f.nextSteps, true)}</div>` +
    `<div class="keep">${sub("Items requiring validation")}<p>${rich(
      R.REQUIRES_VALIDATION.map((r) => `**${r.id}**`).join(", ") +
        " — five items to confirm before acting (Section 14). The mobile Largest Contentful Paint of 39.7 s is among them and is not treated as confirmed.",
    )}</p></div>` +
    `<p class="closing">${rich(f.closing)}</p>`;
  return section(num("Final Assessment"), "Final Assessment", body);
}

function appendix(): string {
  const tools = simpleTable(
    ["Tool", "Purpose", "Date"],
    R.APPENDIX_TOOLS.map((t) => [`<strong>${plain(t.tool)}</strong>`, plain(t.purpose), `<span style="white-space:nowrap">${plain(t.date)}</span>`]),
    ["42%", "40%", "18%"],
  );
  const validation = simpleTable(
    ["ID", "Item"],
    R.REQUIRES_VALIDATION.map((r) => [`<span class="ids">${plain(r.id)}</span>`, rich(r.item)]),
    ["14%", "86%"],
  );
  const body =
    `<div class="keep">${sub("Scope")}${list(R.APPENDIX_SCOPE)}</div>` +
    `<div class="keep">${sub("Tools and audit dates")}${tools}</div>` +
    `<div class="keep">${sub("Limitations")}${list(R.APPENDIX_LIMITATIONS)}</div>` +
    `<div class="keep">${sub("Not assessed", "These checks were not performed; no result is claimed.")}${list(R.NOT_ASSESSED)}</div>` +
    `<div class="keep">${sub("Requires validation", "Observed but need confirmation (Section 14).")}${validation}</div>` +
    `<div class="keep">${sub("Informational SSL and DNS items", "Recorded for completeness. These are not findings.")}${list([
      ...R.SSL_INFO,
      "DNS: no AAAA (IPv6) or CNAME record. Not a problem by itself.",
    ])}</div>` +
    `<div class="keep">${sub("Items to confirm with the business", "Outside the verified scope. These are not findings.")}${list(R.TO_CONFIRM)}</div>`;
  return section(num("Appendix — Scope, Tools, Limitations & Not Assessed"), "Appendix — Scope, Tools, Limitations & Not Assessed", body);
}

export const REPORT_TITLE = `Website Audit Report — ${R.CLIENT.name}`;

export function clientReportHtml(): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${plain(REPORT_TITLE)}</title>` +
    `<style>${STYLESHEET}</style></head><body>` +
    cover() +
    `<main>` +
    executiveSummary() +
    healthOverview() +
    keyFindings() +
    seoAudit() +
    technicalSeo() +
    performance() +
    security() +
    ssl() +
    dns() +
    contentQuality() +
    visualUx() +
    strengths() +
    actionPlan() +
    finalAssessment() +
    appendix() +
    `</main></body></html>`
  );
}
