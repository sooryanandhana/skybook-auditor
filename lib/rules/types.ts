/**
 * The contract every grading rule follows.
 *
 * WHAT THIS LAYER IS FOR: Steps 1-5 measured facts. This layer decides which
 * facts are problems and how serious they are. Nothing here measures anything,
 * and nothing here asks an AI anything.
 *
 * THE RULE THAT SHAPES THIS WHOLE FILE
 *
 *   Severity comes from fixed rules in our own code. Claude explains a grade
 *   later; it never chooses one.
 *
 * A rule therefore DECLARES its severity as a constant. It cannot compute one,
 * return one, or be handed one — `evaluate` has no way to express a severity,
 * and the runner has nothing to override it with.
 *
 * THE SECOND RULE, WHICH IS WHERE BUGS LIVE
 *
 *   A rule fires on a MEASUREMENT, never on the absence of one.
 *
 * "We could not check the SPF record" and "this domain has no SPF record" are
 * different facts. One is a finding worth money to fix; the other is our own
 * lookup timing out. Steps 1-5 kept those states apart specifically so this
 * layer could honour the difference — and honouring it by remembering to check
 * `status !== "error"` in forty separate rules is not a plan.
 *
 * So it is enforced structurally instead. A rule is split in two:
 *
 *   select()    turns the audit into a Measurement — either a value we truly
 *               have, or an explicit "not measured".
 *   evaluate()  receives ONLY the value. It never sees the Measurement, so it
 *               cannot branch on "error", cannot mistake it for a failure, and
 *               cannot fire on it.
 *
 * When `select` reports nothing measured, the runner skips the rule entirely.
 * `evaluate` is never called. That is the safety boundary, and it holds for
 * every rule automatically rather than one rule at a time.
 */
import type { Category, Finding, Severity } from "../types";

/**
 * The severities a rule may declare for a problem.
 *
 * "good" is deliberately absent. A firing rule reports something wrong, and a
 * passing rule reports something right — letting one function produce either
 * is how a rule ends up quietly grading itself.
 */
export type ProblemSeverity = Exclude<Severity, "good">;

/**
 * A fact we actually have, or an explicit statement that we do not.
 *
 * The whole point is that these two are different types, so code handling one
 * cannot silently handle the other.
 */
export type Measurement<T> =
  | { readonly measured: true; readonly value: T }
  | { readonly measured: false; readonly reason: string };

/** A fact we have. */
export function measured<T>(value: T): Measurement<T> {
  return { measured: true, value };
}

/**
 * A fact we do not have, and why.
 *
 * The reason is kept so a report can say "this was not checked" rather than
 * leaving a silent gap that reads as a pass.
 */
export function unmeasured<T>(reason: string): Measurement<T> {
  return { measured: false, reason };
}

/**
 * Something that was looked for and genuinely is not there, versus something
 * that is.
 *
 * This is what lets a rule say "this domain publishes no SPF record" — a real
 * finding — without ever being able to say it because a lookup failed. An
 * `error` never becomes an `Absent`; it becomes an unmeasured Measurement and
 * the rule does not run at all.
 */
export type Presence<T> =
  | { readonly present: true; readonly value: T }
  | { readonly present: false };

/** What a rule concluded about a value it was given. */
export type Verdict =
  | { readonly fires: false }
  /**
   * The rule fired. It supplies the EVIDENCE — the measured fact behind the
   * finding — and, where one firing rule describes genuinely different states,
   * an optional TITLE for this particular one. Severity is still not its to
   * decide: a title names what was found, it does not grade it.
   *
   * When `title` is omitted the finding takes the rule's own constant title, so
   * the common case (one rule, one thing it looks for) needs nothing extra. It
   * exists for a rule like CSP, whose one "not enforced by a header" verdict
   * covers three distinct facts — missing, meta-only, report-only — each of
   * which deserves its own honest heading.
   */
  | { readonly fires: true; readonly evidence: string; readonly title?: string };

/** The rule did not fire. */
export const passes: Verdict = { fires: false };

/**
 * The rule fired, with the measurement that caused it.
 *
 * `title` is optional: pass one only when this verdict names a different state
 * from the rule's other firing verdicts. Omit it to use the rule's constant
 * title, which is what almost every rule does.
 */
export function fires(evidence: string, title?: string): Verdict {
  return title === undefined
    ? { fires: true, evidence }
    : { fires: true, evidence, title };
}

/**
 * What to report when a rule does NOT fire.
 *
 * Optional, because not every check is worth celebrating. Where it is set, the
 * finding is always severity "good" — a rule cannot declare a passing grade of
 * anything else.
 */
export interface PassReport<T> {
  title: string;
  evidence: (value: T) => string;
  /** Nothing to fix, so this defaults to saying so. */
  remediation?: string;
}

/**
 * One grading rule.
 *
 * `T` is whatever `select` produces, so `evaluate` is strongly typed against
 * the real measured-fact types rather than an arbitrary object.
 */
/**
 * Whether this rule describes ONE PAGE or THE WHOLE SITE.
 *
 * Decided by what the rule actually measures, never by its name. A rule reading
 * a page's own HTML or its own response headers is "page": two pages can
 * genuinely differ, so a finding names the pages it was found on. A rule reading
 * the certificate, the domain's DNS records or robots.txt is "site": there is
 * one such fact for the whole website, and it does not become a hundred and
 * twenty-eight facts because a hundred and twenty-eight pages were crawled.
 *
 * Reporting a single SPF record as "128 of 128 pages affected" is not a
 * rounding error, it is a false statement about the measurement — which is why
 * this is declared here, on the rule, and not guessed from the id at runtime.
 */
export type RuleScope = "page" | "site";

export interface RuleDefinition<T, F = AuditFacts> {
  /** Stable and unique, e.g. "no-https". Used in tests and in every finding. */
  id: string;
  /** Short human-readable name, e.g. "Site not served over HTTPS". */
  title: string;
  /**
   * What to do about it. A constant, for the same reason severity is one.
   *
   * Phase 5 will let Claude explain this in the client's own context, but the
   * action itself is decided here where it can be reviewed.
   */
  remediation: string;
  category: Category;
  /**
   * What this rule's measurement describes: one page, or the whole site.
   *
   * REQUIRED, deliberately. Making it optional would let a new rule default
   * silently into the wrong one, and the wrong one produces a sentence that is
   * untrue about the website.
   */
  scope: RuleScope;
  /**
   * The grade when this rule fires. A constant, declared here and nowhere
   * else — this is the line that keeps severity out of AI hands.
   */
  severity: ProblemSeverity;
  /**
   * Pulls the fact this rule needs out of the audit, or says it is missing.
   *
   * The ONLY place allowed to look at "error", "null", "timeout" and friends.
   */
  select: (data: F) => Measurement<T>;
  /**
   * Decides whether the fact is a problem.
   *
   * Receives the value alone. There is no unmeasured state to see here, so
   * there is none to misread.
   */
  evaluate: (value: T) => Verdict;
  /** What to say when the rule does not fire. Omit to stay quiet. */
  pass?: PassReport<T>;
}

/**
 * The facts a rule may read.
 *
 * Deliberately NOT the whole AuditData. Both of this layer's own outputs are
 * excluded — `findings` and `skippedChecks` — so a rule can never grade on
 * top of another rule's verdict, which would make the result depend on the
 * order the rules happened to run in.
 *
 * There is also nothing here produced by an AI, and there cannot be — this
 * type is built from the collector's own output and nothing else.
 */
export type AuditFacts = Omit<
  import("../types").AuditData,
  "findings" | "skippedChecks"
>;

/**
 * The facts a SPEED rule may read.
 *
 * Deliberately narrower than AuditFacts. The speed rules run on their own
 * endpoint, which holds the PageSpeed result and nothing else — it has no SEO,
 * certificate or DNS measurements to offer, and inventing empty ones to
 * satisfy a type would be fabricating facts to make a signature fit.
 *
 * So the fact type is a parameter instead. A speed rule declares that it reads
 * only `performance`, which the compiler then enforces: it CANNOT read the
 * other sections, because they are not in its input at all.
 */
export type PerformanceFacts = Pick<AuditFacts, "performance">;

/**
 * The facts a SITE rule may read.
 *
 * Narrower than AuditFacts for the same reason PerformanceFacts is. A site
 * rule describes the whole website -- its certificate, its domain records, its
 * robots.txt -- and none of those needs a page. Declaring that is what lets
 * these rules run on an audit whose entry page could not be fetched at all:
 * the certificate was still read, so the certificate rules still have
 * something true to say, and there is no page-shaped hole to fill with
 * invented values to satisfy a signature.
 *
 * The compiler enforces it. A site rule CANNOT read `seo`, `security` or
 * `uptime`, because they are not in its input.
 */
export type SiteFacts = Pick<AuditFacts, "ssl" | "dns" | "technical">;

/** What happened to one rule on one audit. */
export type RuleOutcome =
  | { readonly ruleId: string; readonly kind: "finding"; readonly finding: Finding }
  | { readonly ruleId: string; readonly kind: "pass"; readonly finding: Finding }
  /** Ran, did not fire, and reports nothing either way. */
  | { readonly ruleId: string; readonly kind: "quiet" }
  /** Never ran: the fact it needed was not measured. */
  | { readonly ruleId: string; readonly kind: "skipped"; readonly reason: string };

/**
 * A rule with its value type sealed inside.
 *
 * Rules measure different things, so they cannot share one `T`. `defineRule`
 * closes over it and hands back this uniform shape, which is what lets the
 * runner hold a list of them without losing the type safety at the point each
 * rule was written.
 */
export interface CompiledRule<F = AuditFacts> {
  readonly id: string;
  readonly title: string;
  readonly category: Category;
  readonly severity: ProblemSeverity;
  readonly scope: RuleScope;
  readonly run: (data: F) => RuleOutcome;
}
