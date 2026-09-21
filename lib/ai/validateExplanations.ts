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
 * it names no address the audit did not measure, that every figure it states
 * was measured by this audit, and that it carries no field capable of
 * overriding a severity or a count.
 *
 * It cannot fact-check English. A sentence can be misleading while every
 * structural check passes — a measured number can be used to mean something
 * it does not measure — and pretending otherwise would be worse than saying
 * so. What it does guarantee is that no audit fact ENTERS the report from an
 * answer: the numbers, severities and counts a reader sees are the ones this
 * application measured.
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
 * Every address the audit actually measured, in the two forms a sentence can
 * name one.
 *
 * THE TRUSTED SET IS THE INPUT'S OWN, EXACTLY. Not the hostname, not the
 * origin: a model returning a real-looking address on the right domain has
 * still named a page nobody looked at, and "same site" is not the same claim as
 * "we measured this".
 *
 * Both forms are canonical — parsed, not matched as text — so a measured page
 * is recognised however it is written, and an address that merely CONTAINS a
 * measured one ("example.com.evil.test", "evil.test/?go=example.com") is not.
 */
interface MeasuredAddresses {
  /** `https://host/path?query`, for a quotation that gives its scheme. */
  readonly withScheme: ReadonlySet<string>;
  /** `host/path?query`, for one written without it. */
  readonly withoutScheme: ReadonlySet<string>;
}

/**
 * One address in the forms two of them can be compared by, or null when it is
 * not a web address at all.
 *
 * PARSED, BECAUSE STRING COMPARISON CANNOT DO THIS. A trailing slash, an
 * upper-case host and a default port all write the same page three ways, and
 * `mailto:` and `javascript:` are not pages at all.
 */
function canonicalAddress(token: string): {
  withScheme: string;
  withoutScheme: string;
  hadScheme: boolean;
} | null {
  const hadScheme = /^https?:\/\//i.test(token);
  // A scheme-relative "//host/path" is a web address; anything else without a
  // scheme is read as one so it can be compared, never as a different protocol.
  const absolute = hadScheme ? token : token.startsWith("//") ? `https:${token}` : `https://${token}`;

  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  /*
   * CREDENTIALS AND A FRAGMENT ARE PART OF WHAT WAS QUOTED, not noise to be
   * tidied away. A measured page returned with a password in front of it, or
   * with a fragment nobody measured after it, is a different thing being
   * presented to a reader — so it must not compare equal to the measurement.
   */
  const credentials = url.username === "" && url.password === "" ? "" : `${url.username}:${url.password}@`;
  const withoutScheme = `${credentials}${url.host}${url.pathname}${url.search}${url.hash}`;
  return { withScheme: `${url.protocol}//${withoutScheme}`, withoutScheme, hadScheme };
}

function measuredAddresses(input: AIReportInput): MeasuredAddresses {
  const withScheme = new Set<string>();
  const withoutScheme = new Set<string>();

  const add = (url: string | null | undefined): void => {
    if (typeof url !== "string" || url === "") return;
    const canonical = canonicalAddress(url);
    if (canonical === null) return;
    withScheme.add(canonical.withScheme);
    withoutScheme.add(canonical.withoutScheme);
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

  return { withScheme, withoutScheme };
}

/**
 * Anything in a sentence shaped like a host, with or without a scheme.
 *
 * Deliberately wider than the addresses that are then CHECKED: what to do with
 * each match is decided below, where the reason can be written down.
 */
const ADDRESS_SHAPED = /(?:https?:\/\/|\/\/)?(?:[^\s/@]+@)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>"'`)\]}]*)?/gi;

/**
 * Endings that make a token a file or a technology rather than a destination.
 *
 * WHY THIS LIST EXISTS. "robots.txt", "sitemap.xml" and "Node.js" are ordinary
 * things to write about a website, and every one of them is shaped exactly like
 * a hostname. Treating them as addresses would reject honest sentences about
 * the very files this audit reports on.
 *
 * IT CANNOT BE USED TO SMUGGLE A LINK, because it applies only to tokens
 * written WITHOUT a scheme: "https://evil.js/login" is still an address and is
 * still checked.
 */
const FILE_LIKE_ENDINGS = new Set([
  "txt", "xml", "html", "htm", "js", "ts", "json", "css", "md", "png", "jpg",
  "jpeg", "gif", "svg", "webp", "pdf", "csv", "yml", "yaml", "sh", "py", "rb",
  "php", "ico", "map", "lock", "env",
]);

/**
 * The addresses a piece of writing quotes.
 *
 * A SCHEME IS NOT REQUIRED, and that was this check's largest hole: the exact
 * destination refused with `https://` in front of it sailed through without.
 * What is required is that the token is something a reader could go to —
 * a scheme, "//", a "www." prefix, or a path — so an ordinary sentence
 * containing a full stop between two words is not read as a link.
 *
 * Trailing punctuation is stripped, because an address at the end of a
 * sentence is followed by a full stop and that full stop is not part of it.
 */
function addressesIn(text: string): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(ADDRESS_SHAPED)) {
    const token = match[0].replace(/[.,;:!?]+$/, "");
    if (token === "") continue;

    if (!/^(?:https?:\/\/|\/\/)/i.test(token)) {
      const host = token.split("/")[0];
      const ending = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
      if (FILE_LIKE_ENDINGS.has(ending)) continue;

      // Without a scheme, a token is read as an address only when it is
      // unmistakably one: a "www." host, or a host carrying a path.
      if (!/^www\./i.test(token) && !token.includes("/")) continue;
    }

    found.push(token);
  }

  return found;
}

/** The first address in the text that the audit never measured, if any. */
function unmeasuredAddress(text: string, allowed: MeasuredAddresses): string | null {
  for (const token of addressesIn(text)) {
    const address = canonicalAddress(token);
    // Not a web address after parsing (a mail link, a bare colon): the
    // address guarantee is about pages, and this one names none.
    if (address === null) continue;

    const known = address.hadScheme
      ? allowed.withScheme.has(address.withScheme)
      : allowed.withoutScheme.has(address.withoutScheme);
    if (!known) return token;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A run of digits together with the separators a number may carry.
 *
 * Matched as a whole so that "93.184.216.34" and "1.2.3" are seen for what they
 * are — an address and a version, not numbers — rather than being chopped into
 * pieces that would each look like a quantity.
 */
const NUMBER_RUN = /\d[\d,.]*/g;

/**
 * What a run of digits states, or null when it states no single number.
 *
 * Thousands separators are the same number written for a reader, so "1,200"
 * and 1200 are one value. Anything with a second decimal point is not a
 * number at all and is left to the address check.
 */
function numberValue(run: string): number | null {
  const trimmed = run.replace(/[.,]+$/, "");
  if (!/^\d+(?:\.\d+)?$/.test(trimmed) && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const value = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Every number the audit actually measured.
 *
 * READ FROM THE CONTRACT THE MODEL WAS GIVEN, and from nothing else. This walks
 * the same object that was sent: its measured values, its counts, and the
 * numbers inside the sentences our own rules wrote. So "the certificate expired
 * 253 day(s) ago" leaves 253 available to be explained, and nothing that was
 * never measured is.
 *
 * NOTHING IS COMPUTED HERE. No total is added up, no percentage is derived, no
 * measurement is taken. A number is available to a model because this audit
 * already produced it.
 */
function measuredNumbers(input: AIReportInput): ReadonlySet<number> {
  const measured = new Set<number>();

  const walk = (value: unknown): void => {
    if (typeof value === "number") {
      if (Number.isFinite(value)) measured.add(value);
      return;
    }

    if (typeof value === "string") {
      for (const match of value.matchAll(NUMBER_RUN)) {
        const parsed = numberValue(match[0]);
        if (parsed !== null) measured.add(parsed);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };

  walk(input);
  return measured;
}

/**
 * Whether a run of digits is part of a name rather than a quantity.
 *
 * "h1", "UTF-8", "HTTP/2" and "TLSv1.3" are things a page has, not numbers
 * about it, and a check that refused them would refuse most honest writing
 * about headings. A quantity stands on its own: "9.8 seconds", "73%",
 * "400 pages".
 */
function isPartOfAName(text: string, start: number): boolean {
  const before = text.slice(0, start);
  return /[A-Za-z]$/.test(before) || /[A-Za-z][-/]$/.test(before);
}

/** The numbers a piece of writing states as quantities. */
function claimedNumbers(text: string): Array<{ run: string; value: number }> {
  const claims: Array<{ run: string; value: number }> = [];

  for (const match of text.matchAll(NUMBER_RUN)) {
    if (isPartOfAName(text, match.index ?? 0)) continue;
    const value = numberValue(match[0]);
    if (value !== null) claims.push({ run: match[0], value });
  }

  return claims;
}

/**
 * The first figure the writing states that this audit never measured.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It proves that every figure in the prose came
 * from the measurements — a model cannot introduce "73% of pages" or "a score
 * of 94" where no such measurement exists. It does NOT prove that a measured
 * number is being used to mean what it measured, and it cannot see a figure
 * written out in words. Both are stated plainly here rather than implied away.
 */
function unmeasuredNumber(text: string, measured: ReadonlySet<number>): string | null {
  return claimedNumbers(text).find((claim) => !measured.has(claim.value))?.run ?? null;
}

// ---------------------------------------------------------------------------
// A summary that contradicts the findings
// ---------------------------------------------------------------------------

/**
 * Ways of saying, in so many words, that the audit found nothing wrong.
 *
 * DELIBERATELY SHORT, AND DELIBERATELY BLUNT. This is not an attempt to
 * understand English: it catches the flat all-clear a model actually writes
 * when it has lost track of its input, and nothing subtler. A paraphrase
 * ("your site is in great shape") is not caught, and the report does not rely
 * on it being caught — the verdict a reader sees is measured, printed above
 * the summary, and owes nothing to this list.
 */
const NOTHING_FOUND_CLAIMS = [
  "no problems were found",
  "no problems found",
  "no problems at all",
  "no issues were found",
  "no issues found",
  "no issues at all",
  "found no problems",
  "found no issues",
  "we found nothing",
  "found nothing wrong",
  "nothing was found",
  "nothing to fix",
  "nothing to report",
  "nothing needs fixing",
  "no action is needed",
  "no action needed",
  "needs no work",
  "all clear",
  "clean bill of health",
  "fully secure",
];

/**
 * Words that show the same summary is also reporting problems.
 *
 * THE GUARD AGAINST REFUSING HONEST WRITING. "No problems were found with the
 * certificate, but three other checks failed" opens with an all-clear phrase
 * and is a perfectly true sentence. The phrases above are cut out of the text
 * before this looks, so the words that remain are the writer's own account of
 * what else the audit said.
 *
 * Erring towards acceptance is the intended direction: a summary this misses
 * still sits underneath the measured verdict.
 */
const ACKNOWLEDGES_PROBLEMS = [
  "but", "however", "although", "though", "except", "aside", "other than",
  "issue", "problem", "finding", "fault", "weakness", "risk",
  "critical", "high", "medium", "severity",
  "fix", "failed", "failing", "missing", "attention", "affected", "improve",
];

/** How many graded problems this audit actually found. Passes are not problems. */
function problemCount(input: AIReportInput): number {
  return input.findings.filter((finding) => finding.severity !== "good").length;
}

/**
 * Whether the summary claims outright that nothing was found.
 *
 * Read on a lower-cased copy, with the claim itself removed before looking for
 * any acknowledgement, so the phrase cannot vouch for itself.
 */
function claimsNothingWasFound(summary: string): boolean {
  const text = summary.toLowerCase();
  const claimed = NOTHING_FOUND_CLAIMS.filter((claim) => text.includes(claim));
  if (claimed.length === 0) return false;

  let remainder = text;
  for (const claim of claimed) remainder = remainder.split(claim).join(" ");

  return !ACKNOWLEDGES_PROBLEMS.some((word) => remainder.includes(word));
}

// ---------------------------------------------------------------------------
// One explanation
// ---------------------------------------------------------------------------

/**
 * Why this entry cannot be believed, or null when it can.
 *
 * THE BOUNDARY IT KEEPS. An explanation belongs to a finding that really
 * fired; it names no address the audit did not measure; it states no figure
 * the audit did not measure; and it carries no field capable of overriding a
 * severity, a count or a denominator. Within that, the writing is the model's
 * own and is not second-guessed.
 *
 * WHAT IS STILL NOT PROVED, SAID PLAINLY. A sentence can use a measured number
 * to mean something it does not measure, or write a figure out in words, or
 * draw a wrong conclusion from facts that are all present. None of that can be
 * caught by comparing values, so none of it is claimed to be. What cannot
 * happen is a figure, an address or a severity ARRIVING from the answer: every
 * number the report displays is read from the deterministic result, and every
 * number the prose states was in the measurements the model was shown.
 */
function rejectionReason(
  entry: unknown,
  input: AIReportInput,
  gradedRules: ReadonlySet<string>,
  allowedAddresses: MeasuredAddresses,
  allowedNumbers: ReadonlySet<number>,
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

    const invented = unmeasuredNumber(String(entry[field]), allowedNumbers);
    if (invented !== null) return `"${field}" states a figure the audit did not measure (${forReason(invented)})`;
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
  /*
   * Both sets are built once, from the contract, and read many times. They
   * are the measurements themselves — nothing here derives a new one.
   */
  const allowedNumbers = measuredNumbers(input);

  const summaryStray = unmeasuredAddress(executiveSummary, allowedAddresses);
  if (summaryStray !== null) {
    return { ok: false, reason: "the summary names an address the audit did not measure" };
  }

  /*
   * THE SUMMARY IS REFUSED WHOLE, like a stray address in it. It stands for
   * the audit rather than for one finding, so there is no smaller thing to
   * drop, and a report reads better with no opening paragraph than with one
   * quoting a figure nobody measured.
   */
  const summaryFigure = unmeasuredNumber(executiveSummary, allowedNumbers);
  if (summaryFigure !== null) {
    return { ok: false, reason: "the summary states a figure the audit did not measure" };
  }

  /*
   * A SUMMARY MAY NOT SAY THE AUDIT FOUND NOTHING WHEN IT FOUND SOMETHING.
   *
   * Refused whole, like the two checks above it: the opening paragraph
   * stands for the audit, and one that contradicts the findings printed
   * beneath it is worse than no paragraph at all. Narrow on purpose --
   * only a flat all-clear is caught -- because the reader's verdict comes
   * from the measured findings either way.
   */
  if (problemCount(input) > 0 && claimsNothingWasFound(executiveSummary)) {
    return { ok: false, reason: "the summary says the audit found nothing, and it found problems" };
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

    const reason = rejectionReason(entry, input, gradedRules, allowedAddresses, allowedNumbers);
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
