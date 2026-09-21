/**
 * Corpus I — the AI trust boundary: what a model's answer can and cannot put
 * into a client's report.
 *
 * The contract is built by the real `buildAIReportInput` from a real fixture
 * audit, answers are checked by the real `validateExplanations`, `explainAudit`
 * runs with a scripted client in place of Gemini, and the report document comes
 * from the real `buildPdfDocument`. No model is called.
 *
 * Yardsticks:
 *   - validateExplanations.ts's own statement of scope: it "can prove that an
 *     explanation belongs to a finding that really fired, that it names no
 *     address the audit did not measure, and that it carries no field capable
 *     of overriding a severity or a count", and "cannot fact-check English";
 *   - the system prompt, which forbids invented numbers, severities, counts,
 *     percentages, URLs, hostnames and email addresses;
 *   - the provenance sentence printed beside AI text in the report.
 *
 * Cases the validator documents as outside its reach are DECISIONS, not
 * defects: they are exactly what the later AI-trust task must decide how to
 * handle. Where the code contradicts its own stated guarantee, it is a defect.
 */
import assert from "node:assert/strict";

import { AI_CONTRACT_VERSION, type AIReportInput } from "../ai/contract.ts";
import { buildAIReportInput } from "../ai/buildReportInput.ts";
import { explainAudit, type ExplainResult, type GeminiRequestClient } from "../ai/gemini/explain.ts";
import { validateExplanations } from "../ai/validateExplanations.ts";
import { buildPdfDocument } from "../audit/pdfDocument.ts";
import { createJobStore } from "../jobs/jobStore.ts";
import type { SiteAuditResult, SpeedResult } from "../types.ts";
import {
  auditFixtureSite,
  correct,
  decision,
  page,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  installOfflineCorpus,
} from "./corpus.fixture.mts";

installOfflineCorpus();
const ROOT = `https://${PUBLIC_HOST}/`;
const RULE = "seo.meta-description.missing";

/** A two-page audit with three real findings: a missing title, a missing description, an image without alt text. */
async function audit(): Promise<{ result: SiteAuditResult; input: AIReportInput }> {
  const result = await auditFixtureSite({
    [ROOT]: {
      html: page({ body: '<a href="/b">b</a><img src="/x.png">' }).replace(/<meta name="description"[^>]*>/, ""),
      headers: PROTECTED_HEADERS,
    },
    [`${ROOT}b`]: { html: page().replace(/<title>[^<]*<\/title>/, ""), headers: PROTECTED_HEADERS },
  });
  return { result, input: buildAIReportInput(result) };
}

const explanation = (overrides: Record<string, unknown> = {}) => ({
  ruleId: RULE,
  explanation: "The home page has no meta description, so search engines choose the snippet themselves.",
  businessImpact: "The line a searcher reads under your link is not one you wrote.",
  recommendation: "Write a short, specific description for the page.",
  ...overrides,
});

const answer = (explanations: unknown[], overrides: Record<string, unknown> = {}) => ({
  version: AI_CONTRACT_VERSION,
  executiveSummary: "The audit found a few gaps in how the site presents itself to search engines.",
  explanations,
  ...overrides,
});

/** Validates one candidate and returns what survived, or the whole-answer refusal. */
async function check(candidate: unknown) {
  const { input } = await audit();
  return validateExplanations(input, candidate);
}

/** A stand-in for Gemini that answers with fixed text. */
const scriptedModel = (text: string): GeminiRequestClient => ({
  interactions: { create: async () => ({ id: "corpus-interaction", output_text: text }) },
});

correct("I0 the contract carries the three measured findings with their deterministic severities", async () => {
  const { input } = await audit();
  assert.deepEqual(
    input.findings.map((finding) => `${finding.ruleId}:${finding.severity}`).sort(),
    ["seo.images.alt:medium", "seo.meta-description.missing:medium", "seo.title.missing:high"],
  );
});

// ---------------------------------------------------------------------------
// Answers the validator accepts or refuses correctly
// ---------------------------------------------------------------------------

correct("I1 a well-formed explanation of a finding that fired is accepted", async () => {
  const outcome = await check(answer([explanation()]));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.accepted.explanations.length, 1);
  assert.deepEqual(outcome.rejected, []);
});

correct("I2 a qualitative recommendation with no claims of fact is accepted", async () => {
  const outcome = await check(
    answer([explanation({ recommendation: "Describe what the page offers in one plain sentence, written for a customer rather than a search engine." })]),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.accepted.explanations.length, 1);
});

correct("I3 an explanation carrying a severity or an affected count field is dropped", async () => {
  for (const field of [{ severity: "low" }, { affectedCount: 999 }]) {
    const outcome = await check(answer([explanation(field)]));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    assert.equal(outcome.accepted.explanations.length, 0, JSON.stringify(field));
    assert.match(outcome.rejected[0]?.reason ?? "", /may not carry/);
  }
});

correct("I4 an explanation for a rule that did not fire, or the same rule twice, is dropped", async () => {
  const invented = await check(answer([explanation({ ruleId: "security.firewall.missing" })]));
  assert.equal(invented.ok, true);
  if (invented.ok) assert.equal(invented.accepted.explanations.length, 0);
  const twice = await check(answer([explanation(), explanation()]));
  assert.equal(twice.ok, true);
  if (twice.ok) assert.equal(twice.accepted.explanations.length, 0);
});

correct("I5 an http(s) address the audit did not measure is dropped; a measured one is kept", async () => {
  const invented = await check(answer([explanation({ explanation: "See https://evil.example/login for details." })]));
  assert.equal(invented.ok, true);
  if (invented.ok) assert.equal(invented.accepted.explanations.length, 0);
  const measured = await check(answer([explanation({ explanation: `The page ${ROOT} has no description.` })]));
  assert.equal(measured.ok, true);
  if (measured.ok) assert.equal(measured.accepted.explanations.length, 1);
});

correct("I6 malformed answers are refused whole: not an object, another contract version, no list, or an extra top-level score", async () => {
  const refusals = [
    "just a string",
    answer([explanation()], { version: "0.0.0" }),
    { version: AI_CONTRACT_VERSION, executiveSummary: "Summary." },
    answer([explanation()], { overallScore: 97 }),
  ];
  for (const candidate of refusals) {
    const outcome = await check(candidate);
    assert.equal(outcome.ok, false, JSON.stringify(candidate).slice(0, 80));
  }
});

correct("I7 a model reply that is not JSON, is empty, or wraps JSON in a code fence gives no commentary and is never repaired", async () => {
  const { input } = await audit();
  const replies: Array<[string, string]> = [
    ["not json {", "unreadable-response"],
    ["", "empty-response"],
    ["```json\n" + JSON.stringify(answer([explanation()])) + "\n```", "unreadable-response"],
  ];
  for (const [text, reason] of replies) {
    const outcome = await explainAudit(input, { apiKey: "corpus-key", client: scriptedModel(text) });
    assert.equal(outcome.state, "not-explained", reason);
    if (outcome.state === "not-explained") assert.equal(outcome.reason, reason);
  }
});

// ---------------------------------------------------------------------------
// Prose the validator cannot check, by its own documentation
// ---------------------------------------------------------------------------

correct("I8 prose stating a measurement the audit never made (an LCP of 9.8 seconds) is dropped", async () => {
  // 9.8 is not among the figures the contract carries, so the sentence states a
  // measurement this audit never took. (Was a decision; I16's fix settled it.)
  const outcome = await check(answer([explanation({ explanation: "Your Largest Contentful Paint is 9.8 seconds." })]));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.accepted.explanations.length, 0);
  assert.match(outcome.rejected[0]?.reason ?? "", /figure the audit did not measure/);
});

correct("I9 an invented count or percentage is dropped, while a measured count may be explained", async () => {
  // (Was a decision; I16's fix settled it.) The second half is the half that
  // matters as much: this must not become a validator that refuses arithmetic.
  for (const text of ["This problem affects 400 pages across the site.", "73% of your pages are affected."]) {
    const outcome = await check(answer([explanation({ businessImpact: text })]));
    assert.equal(outcome.ok, true, text);
    if (!outcome.ok) continue;
    assert.equal(outcome.accepted.explanations.length, 0, text);
  }

  // 1 affected page of 2 evaluated: both numbers are the audit's own.
  const measured = await check(answer([explanation({ businessImpact: "It affects 1 of the 2 pages that were read." })]));
  assert.equal(measured.ok, true);
  if (measured.ok) assert.equal(measured.accepted.explanations.length, 1);
});

decision("I10 prose escalating a Medium finding to 'critical' is accepted", async () => {
  const outcome = await check(answer([explanation({ explanation: "This is a critical issue that needs urgent attention." })]));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.accepted.explanations.length, 1);
});

decision("I11 prose asserting something the audit did not find ('no HTTPS certificate') is accepted", async () => {
  const outcome = await check(answer([explanation({ businessImpact: "The site has no HTTPS certificate, so browsers warn every visitor." })]));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.accepted.explanations.length, 1);
});

correct("I12 a summary claiming the audit found nothing is refused when it found something", async () => {
  // (Was a decision; D + A settled it.) Two things hold now: the validator
  // refuses the flat contradiction outright, and the report states its own
  // measured verdict above wherever a model's paragraph would sit — so the
  // reader's answer to "how did the site do?" never comes from the prose.
  const outcome = await check(answer([explanation()], { executiveSummary: "No problems were found. This website is fully secure and needs no work." }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /found nothing, and it found problems/);

  // Honest writing that opens the same way is not refused.
  const mixed = await check(
    answer([explanation()], { executiveSummary: "No problems were found with the certificate, but three other checks failed and need attention." }),
  );
  assert.equal(mixed.ok, true);

  // And the document says what was measured, whatever any model wrote.
  const { document } = await reportWithModelAnswer(
    answer([explanation()], { executiveSummary: "No problems were found. This website is fully secure and needs no work." }),
  );
  assert.equal(document.summary.stateSentence, "This audit found 1 High and 2 Medium issues.");
  assert.equal(document.summary.ai, null, "a refused answer leaves no summary at all");
});

decision("I13 an email address the audit never measured is accepted in prose", async () => {
  // The prompt forbids email addresses; the validator's address guarantee is
  // written about web addresses. Whether it should cover email is a decision.
  const outcome = await check(answer([explanation({ recommendation: "Email owner@competitor-example.com for help." })]));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.accepted.explanations.length, 1);
});

correct("I14 a web address written without http:// is checked like any other address", async () => {
  // The same unmeasured destination as I5, minus the scheme. (Was a defect: the
  // check read only scheme-prefixed tokens, so this went straight through.)
  const outcome = await check(answer([explanation({ recommendation: "Compare your pages with www.competitor-example.com/login." })]));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.accepted.explanations.length, 0);
});

// ---------------------------------------------------------------------------
// What reaches the report
// ---------------------------------------------------------------------------

/** Runs the scripted model through the real explanation path and builds the real report document. */
async function reportWithModelAnswer(candidate: unknown) {
  const { result, input } = await audit();
  const explained: ExplainResult = await explainAudit(input, { apiKey: "corpus-key", client: scriptedModel(JSON.stringify(candidate)) });
  const store = createJobStore<SiteAuditResult, SpeedResult, ExplainResult>();
  const job = store.create(ROOT);
  store.finish(job.id, "completed", result);
  assert.equal(store.claimExplanation(job.id), true);
  store.setExplanation(job.id, explained);
  const built = buildPdfDocument(job.id, store, {});
  if (!built.ok) throw new Error(`document refused: ${built.reason}`);
  return { result, document: built.document };
}

const UNSUPPORTED = answer([explanation({ explanation: "Your Largest Contentful Paint is 9.8 seconds and 73% of pages fail." })]);

correct("I15 a model's prose cannot change a finding's severity or reach in the report document", async () => {
  // The unsupported prose is refused outright now, so the document carries no
  // commentary at all — and the measured severities and reach are unchanged,
  // which is what this case has always been about.
  const { result, document } = await reportWithModelAnswer(UNSUPPORTED);
  const printed = [...document.siteFindings.groups, ...document.pageFindings.groups].flatMap((group) => group.findings);
  assert.deepEqual(
    printed.map((finding) => `${finding.ruleId}:${finding.severity}:${finding.reach}`).sort(),
    [
      "seo.images.alt:medium:1 of 2 evaluated pages",
      "seo.meta-description.missing:medium:1 of 2 evaluated pages",
      "seo.title.missing:high:1 of 2 evaluated pages",
    ],
  );
  assert.deepEqual(
    result.site.findings.map((finding) => `${finding.id}:${finding.severity}:${finding.affectedCount}`).sort(),
    ["seo.images.alt:medium:1", "seo.meta-description.missing:medium:1", "seo.title.missing:high:1"],
  );
  assert.deepEqual(printed.filter((finding) => finding.commentary !== null).map((finding) => finding.ruleId), []);

  // Supported prose still reaches the finding it named, and only that one.
  const supported = await reportWithModelAnswer(answer([explanation()]));
  const withProse = [...supported.document.siteFindings.groups, ...supported.document.pageFindings.groups]
    .flatMap((group) => group.findings)
    .filter((finding) => finding.commentary !== null)
    .map((finding) => finding.ruleId);
  assert.deepEqual(withProse, [RULE]);
});

correct("I16 prose carrying figures the audit never measured does not reach the report at all", async () => {
  // The provenance label is the one place the report states the AI boundary,
  // and it now holds: an answer quoting "9.8 seconds" where no such measurement
  // exists is refused by the validator, so nothing unverified sits beside it.
  // (Was a defect: the prose was printed under that label.)
  const { document } = await reportWithModelAnswer(UNSUPPORTED);
  const printsUnverifiedNumbers = JSON.stringify(document).includes("9.8 seconds");
  assert.ok(!(printsUnverifiedNumbers && /every number in this report were measured/.test(document.labels.aiProvenance)));

  assert.equal(printsUnverifiedNumbers, false, "the figure never reaches the document");
  assert.match(document.labels.aiProvenance, /every number in this report were measured by this tool/);
  // The explanation carrying it was dropped, and the report says how many were.
  assert.equal(document.summary.ai?.rejectedCount, 1);
  assert.deepEqual(
    [...document.siteFindings.groups, ...document.pageFindings.groups]
      .flatMap((group) => group.findings)
      .filter((finding) => finding.commentary !== null),
    [],
  );
});
