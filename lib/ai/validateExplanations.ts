/**
 * Checking a model's answer before any of it is believed.
 *
 * WHY THIS EXISTS, AND WHY IT WAS BUILT BEFORE THE PROVIDER
 *
 * Everything upstream of here is measured and graded by fixed code. The moment
 * a model is asked to write about that, something outside this project starts
 * producing text that will sit next to it in a client's report. The prompt will
 * tell that model what it may and may not say. This file is what happens when
 * it does not listen.
 *
 * It is deliberately written before any provider exists, so there is no window
 * in which an answer is trusted because the checking has not been written yet.
 *
 * PROVIDER-NEUTRAL. It knows nothing about who produced the candidate, imports
 * no SDK, and makes no request. It compares an untrusted object against the
 * deterministic input that produced it, and that comparison is the same
 * whoever wrote the answer.
 *
 * WHAT IT CAN AND CANNOT DO
 *
 * It can prove that an explanation belongs to a finding that really fired, that
 * it names no address the audit did not measure, and that it carries no field
 * capable of overriding a severity or a count.
 *
 * It cannot fact-check English. A sentence can be misleading while every
 * structural check passes, and pretending otherwise would be worse than saying
 * so. See NUMBERS IN PROSE below for the one place that limitation is sharpest.
 */
import { AI_CONTRACT_VERSION, type AIReportInput } from "./contract.ts";
import type { AIExplanation, AIExplanationSet } from "./explanation.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The longest one piece of writing about a single finding may be.
 *
 * The input's own limits are far smaller -- two hundred characters for a value
 * copied off a website, five hundred for a sentence a rule wrote -- because
 * those are quotations of measured things. This is different: it is prose
 * written for a person, and a paragraph is the point. Twelve hundred is a few
 * sentences with room to spare, and small enough that a model looping on
 * itself is cut off rather than filling a report.
 */
export const MAX_EXPLANATION_LENGTH = 1_200;

/** The opening paragraph. Longer, because it stands for the whole audit. */
export const MAX_SUMMARY_LENGTH = 2_000;

/**
 * How many entries a candidate may contain before it is refused unread.
 *
 * A WORK BOUND, NOT A SEMANTIC ONE. At most one explanation is ever accepted
 * per finding and the rule set is around thirty, so anything approaching this
 * is already malformed; the number exists so a runaway answer is dropped
 * rather than walked.
 */
export const MAX_CANDIDATE_EXPLANATIONS = 500;

/** The only keys a candidate answer may carry. */
const ALLOWED_SET_KEYS = ["version", "executiveSummary", "explanations"] as const;

/** The only keys one explanation may carry. */
const ALLOWED_EXPLANATION_KEYS = [
  "ruleId",
  "explanation",
  "businessImpact",
  "recommendation",
] as const;

/** The three pieces of writing every explanation must carry. */
const PROSE_FIELDS = ["explanation", "businessImpact", "recommendation"] as const;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** One entry that was not believed, and why. */
export interface RejectedExplanation {
  /** The rule it claimed to be about, when it named one readably. */
  readonly ruleId: string | null;
  readonly reason: string;
}

/**
 * What checking produced.
 *
 * A DISCRIMINATED UNION, like every other "this may not have worked" answer in
 * this codebase. `ok: false` means the candidate was not usable as a whole and
 * NOTHING is returned -- no half-built set, no invented summary. `ok: true`
 * carries the entries that survived, which may be none.
 *
 * Either way the deterministic report is complete and unchanged. That is the
 * property this whole file exists to keep.
 */
export type ExplanationCheck =
  | {
      readonly ok: true;
      readonly accepted: AIExplanationSet;
      /** Entries that were dropped. Kept so a gap can be explained, not hidden. */
      readonly rejected: readonly RejectedExplanation[];
    }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with something in it, within a limit. */
function readableText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (value.length > limit) return null;
  return trimmed;
}

/** Any key the shape does not allow, or null when there is none. */
function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

/** How much of a candidate's own text a rejection reason may quote back. */
const MAX_REASON_QUOTE = 80;

/**
 * A candidate's own text, cut short before it is quoted in a reason.
 *
 * REASONS ARE RETURNED AND WILL BE LOGGED, so anything a candidate supplied
 * that gets named in one is attacker-controlled text crossing a boundary --
 * the same thing the report contract bounds everywhere else. A two-hundred
 * thousand character key produced a two-hundred thousand character reason
 * until this existed. Enough survives to identify what was wrong.
 */
function forReason(value: string): string {
  return value.length <= MAX_REASON_QUOTE ? value : `${value.slice(0, MAX_REASON_QUOTE)}...`;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Every address the audit actually measured.
 *
 * THE TRUSTED SET IS THE INPUT'S OWN, EXACTLY. Not the hostname, not the
 * origin: a model returning a real-looking address on the right domain has
 * still named a page nobody looked at, and "same site" is not the same claim as
 * "we measured this".
 *
 * Only addresses the contract actually carries appear here, and only when the
 * measurement they belong to produced a value. A canonical address the audit
 * could not carry is not in this set, so quoting one is refused.
 */
function measuredAddresses(input: AIReportInput): ReadonlySet<string> {
  const allowed = new Set<string>();

  const add = (url: string | null | undefined): void => {
    if (typeof url === "string" && url !== "") allowed.add(url);
  };

  add(input.site.requestedUrl);
  add(input.site.finalUrl);
  add(input.measurements.page.url);

  const canonical = input.measurements.page.canonicalUrl;
  if (canonical.knowledge === "value") add(canonical.value);

  const sitemap = input.measurements.siteFiles.sitemap;
  if (sitemap.knowledge === "value") add(sitemap.value.url);

  const performance = input.measurements.performance;
  if (performance.knowledge === "value") {
    add(performance.value.requestedUrl);
    if (performance.value.field.knowledge === "value") add(performance.value.field.value.measuredUrl);
    if (performance.value.lab.knowledge === "value") add(performance.value.lab.value.measuredUrl);
  }

  for (const finding of input.findings) {
    for (const sample of finding.reach?.samples ?? []) add(sample.url);
  }

  return allowed;
}

/**
 * The addresses a piece of writing quotes.
 *
 * ONLY SCHEME-PREFIXED TOKENS. A bare "example.com" in a sentence is a word as
 * often as it is an address, and refusing prose because it contains a full stop
 * between two words would be a check that costs more than it saves. What this
 * catches is the thing that matters: a model presenting a specific page as one
 * the audit looked at.
 *
 * Trailing punctuation is stripped, because an address at the end of a sentence
 * is followed by a full stop and that full stop is not part of it.
 */
function addressesIn(text: string): string[] {
  const tokens = text.match(/https?:\/\/[^\s<>"'`)\]}]+/gi) ?? [];
  return tokens.map((token) => token.replace(/[.,;:!?]+$/, ""));
}

/** The first address in the text that the audit never measured, if any. */
function unmeasuredAddress(text: string, allowed: ReadonlySet<string>): string | null {
  return addressesIn(text).find((url) => !allowed.has(url)) ?? null;
}

// ---------------------------------------------------------------------------
// One explanation
// ---------------------------------------------------------------------------

/**
 * Why this entry cannot be believed, or null when it can.
 *
 * NUMBERS IN PROSE, AND WHY THEY ARE NOT CHECKED HERE
 *
 * The obvious next check is that every figure a model quotes appears in the
 * input. It was considered and rejected, because it cannot be made reliable
 * from this contract and a check that is unreliable in this position is worse
 * than none: it would reject ordinary sentences containing a year, a count of
 * words, or a figure the rule's own remediation text mentions, and it would
 * still miss a wrong number written out as a word.
 *
 * What stands in its place is structural and absolute: `AIExplanationSet` has
 * no field for a severity, a count, a denominator or a measurement, and the key
 * check below refuses an entry that invents one. A model can therefore write a
 * misleading sentence, and this is stated plainly rather than papered over --
 * but it cannot change a single number the report displays, because every one
 * of those is read from the deterministic result and never from an answer.
 */
function rejectionReason(
  entry: unknown,
  input: AIReportInput,
  gradedRules: ReadonlySet<string>,
  allowedAddresses: ReadonlySet<string>,
): string | null {
  if (!isPlainObject(entry)) return "an explanation must be an object";

  const extra = unexpectedKey(entry, ALLOWED_EXPLANATION_KEYS);
  if (extra !== null) {
    // The contract has no such field, so an answer carrying one is trying to
    // say something it has no authority to say.
    return `an explanation may not carry "${forReason(extra)}"`;
  }

  const ruleId = readableText(entry.ruleId, 200);
  if (ruleId === null) return "an explanation must name the rule it is about";

  for (const field of PROSE_FIELDS) {
    if (readableText(entry[field], MAX_EXPLANATION_LENGTH) === null) {
      return `"${field}" must be readable text no longer than ${MAX_EXPLANATION_LENGTH} characters`;
    }
  }

  if (!gradedRules.has(ruleId)) {
    /*
     * The dangerous case, and the reason it gets its own sentence.
     *
     * A rule can be skipped on one page and fire on another, so appearing in
     * `notEvaluated` is not by itself disqualifying -- being absent from
     * `findings` is. An explanation attached to a check that produced no
     * finding would turn "we could not check this" into something a client
     * reads as a problem, which is the exact falsehood this project exists to
     * avoid.
     */
    const wasSkipped = input.notEvaluated.some((check) => check.ruleId === ruleId);
    return wasSkipped
      ? `"${forReason(ruleId)}" did not run on this audit, so there is nothing to explain`
      : `"${forReason(ruleId)}" is not a finding in this audit`;
  }

  for (const field of PROSE_FIELDS) {
    const stray = unmeasuredAddress(String(entry[field]), allowedAddresses);
    if (stray !== null) return `"${field}" names an address the audit did not measure`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Checks an untrusted answer against the audit that produced it.
 *
 * READS BOTH ARGUMENTS AND WRITES TO NEITHER. The deterministic input is not
 * copied, reordered, filtered or annotated, and no finding, severity, count or
 * denominator is touched by anything here. Whatever this returns, the report
 * is exactly the report it would have been had no model been asked.
 *
 * Entries are dropped one at a time. One bad explanation costs its own
 * explanation and nothing else, because a finding with no writing beside it is
 * still a complete finding -- the evidence and the remediation were ours all
 * along.
 */
export function validateExplanations(input: AIReportInput, candidate: unknown): ExplanationCheck {
  /*
   * NOTHING IN HERE MAY THROW ITS WAY OUT.
   *
   * The argument is `unknown`, and reading a property off an unknown object can
   * run somebody else's code: a getter that throws turns a bad answer into an
   * exception in the caller. In the intended path the candidate is the output
   * of `JSON.parse`, which is inert data and cannot do that — but this file is
   * what is supposed to hold when the intended path does not, so it does not
   * lean on the caller having parsed anything.
   *
   * The cost, stated plainly: a bug in the checking below also becomes a
   * refusal rather than a crash. That is the safer direction here. An answer
   * that cannot be read is an answer that is not used, and the deterministic
   * report is delivered complete either way — which is the promise this whole
   * file exists to keep.
   */
  try {
    return check(input, candidate);
  } catch {
    return { ok: false, reason: "the answer could not be read" };
  }
}

function check(input: AIReportInput, candidate: unknown): ExplanationCheck {
  if (!isPlainObject(candidate)) return { ok: false, reason: "the answer is not an object" };

  const extra = unexpectedKey(candidate, ALLOWED_SET_KEYS);
  if (extra !== null) return { ok: false, reason: `the answer may not carry "${forReason(extra)}"` };

  if (candidate.version !== AI_CONTRACT_VERSION || candidate.version !== input.version) {
    // An answer built against a different contract is not merged into this
    // report on the assumption that the difference will not matter.
    return { ok: false, reason: "the answer was built against a different contract version" };
  }

  const executiveSummary = readableText(candidate.executiveSummary, MAX_SUMMARY_LENGTH);
  if (executiveSummary === null) {
    return {
      ok: false,
      reason: `the summary must be readable text no longer than ${MAX_SUMMARY_LENGTH} characters`,
    };
  }

  if (!Array.isArray(candidate.explanations)) {
    return { ok: false, reason: "the answer must carry a list of explanations" };
  }
  if (candidate.explanations.length > MAX_CANDIDATE_EXPLANATIONS) {
    return { ok: false, reason: "the answer carries more explanations than an audit can have" };
  }

  const gradedRules = new Set(input.findings.map((finding) => finding.ruleId));
  const allowedAddresses = measuredAddresses(input);

  const summaryStray = unmeasuredAddress(executiveSummary, allowedAddresses);
  if (summaryStray !== null) {
    return { ok: false, reason: "the summary names an address the audit did not measure" };
  }

  /*
   * A rule explained twice is explained zero times.
   *
   * Two answers about one finding cannot both be shown, and there is no
   * deterministic way to prefer one -- choosing the first would let a model put
   * its real answer second, and merging them would be this file writing prose.
   * Both are dropped and the finding keeps its own evidence.
   */
  const seen = new Map<string, number>();
  for (const entry of candidate.explanations) {
    if (!isPlainObject(entry) || typeof entry.ruleId !== "string") continue;
    const id = entry.ruleId.trim();
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  const accepted: AIExplanation[] = [];
  const rejected: RejectedExplanation[] = [];

  for (const entry of candidate.explanations) {
    const claimedId =
      isPlainObject(entry) && typeof entry.ruleId === "string" ? entry.ruleId.trim() : null;

    if (claimedId !== null && (seen.get(claimedId) ?? 0) > 1) {
      rejected.push({
        ruleId: forReason(claimedId),
        reason: `"${forReason(claimedId)}" was explained more than once`,
      });
      continue;
    }

    const reason = rejectionReason(entry, input, gradedRules, allowedAddresses);
    if (reason !== null) {
      rejected.push({ ruleId: claimedId, reason });
      continue;
    }

    const valid = entry as Record<string, string>;
    accepted.push({
      ruleId: valid.ruleId.trim(),
      explanation: valid.explanation.trim(),
      businessImpact: valid.businessImpact.trim(),
      recommendation: valid.recommendation.trim(),
    });
  }

  return {
    ok: true,
    accepted: { version: AI_CONTRACT_VERSION, executiveSummary, explanations: accepted },
    rejected,
  };
}
