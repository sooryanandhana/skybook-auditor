/**
 * Turns rules plus measured facts into findings.
 *
 * The runner is deliberately dull. It selects, skips or evaluates, and copies
 * the rule's own declared severity onto the finding. It has no opinion about
 * how serious anything is, and no way to form one — the only severity value it
 * ever handles is the constant the rule declared, plus the literal "good" for
 * a pass.
 */
import type { Finding, Severity } from "../types";
import type {
  AuditFacts,
  CompiledRule,
  RuleDefinition,
  RuleOutcome,
} from "./types";

/**
 * Seals a rule's value type inside a uniform, runnable shape.
 *
 * This is where the safety boundary is actually enforced: `select` runs first,
 * and `evaluate` is called ONLY on the value it produced. There is no path
 * through this function that hands an unmeasured state to a rule.
 */
export function defineRule<T, F = AuditFacts>(rule: RuleDefinition<T, F>): CompiledRule<F> {
  return {
    id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    // Carried through like severity: declared once by the rule, copied, never
    // decided here and never guessed from the id.
    scope: rule.scope,

    run(data: F): RuleOutcome {
      const measurement = rule.select(data);

      // Not measured. The rule never runs, so it cannot fire on nothing.
      if (!measurement.measured) {
        return { ruleId: rule.id, kind: "skipped", reason: measurement.reason };
      }

      const verdict = rule.evaluate(measurement.value);

      if (verdict.fires) {
        return {
          ruleId: rule.id,
          kind: "finding",
          finding: {
            id: rule.id,
            // The rule's constant title, unless this particular verdict named a
            // more specific one. A verdict title only ever renames the heading;
            // it cannot touch severity, category or id, which stay the rule's.
            // The rule's constant title, unless this particular verdict named a
            // more specific one. A verdict title only ever renames the heading;
            // it cannot touch severity, category or id, which stay the rule's.
            title: verdict.title ?? rule.title,
            category: rule.category,
            // The rule's own constant, copied. Never computed here.
            severity: rule.severity,
            evidence: verdict.evidence,
            // The rule's own constant, like severity. Never composed here.
            remediation: rule.remediation,
          },
        };
      }

      if (rule.pass) {
        return {
          ruleId: rule.id,
          kind: "pass",
          finding: {
            id: rule.id,
            title: rule.pass.title,
            category: rule.category,
            // A rule that did not fire reports something right. There is no
            // other value this may take.
            severity: "good",
            evidence: rule.pass.evidence(measurement.value),
            remediation: rule.pass.remediation ?? "No action needed.",
          },
        };
      }

      return { ruleId: rule.id, kind: "quiet" };
    },
  };
}

/** Everything one pass of the rules produced. */
export interface RuleRunResult {
  /** Problems and passes, worst first. */
  findings: Finding[];
  /**
   * Rules that could not run, and why.
   *
   * Kept rather than discarded, because "we could not check this" is itself
   * something a report should say. A silent gap reads as a pass.
   */
  skipped: Array<{ ruleId: string; reason: string }>;
}

/** Worst first, so a reader meets the important things at the top. */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  good: 3,
};

/**
 * Runs every rule against one audit.
 *
 * Deterministic: the same facts always produce the same findings, in the same
 * order. Findings are sorted by severity and then by rule id, so the order
 * never depends on how the rules happened to be listed.
 */
export function runRules<F>(data: F, rules: readonly CompiledRule<F>[]): RuleRunResult {
  const findings: Finding[] = [];
  const skipped: Array<{ ruleId: string; reason: string }> = [];

  for (const rule of rules) {
    /*
     * One rule failing must not cost the audit.
     *
     * The boundary is deliberately this narrow — one rule, one try. Before it,
     * a rule whose select() or evaluate() threw took the whole run with it:
     * later rules never ran, and findings ALREADY PRODUCED by earlier rules
     * were discarded along with it. In the audit route, which has no outer
     * guard around this call, that turned one broken rule into a 500 and lost
     * every measurement the collectors had just spent thirty seconds making.
     *
     * A rule that throws has not discovered anything about the website. It has
     * failed to run. So it becomes a skipped check — the same as a measurement
     * that was never taken — and never a finding.
     */
    let outcome: RuleOutcome;
    try {
      outcome = rule.run(data);
    } catch (error) {
      /*
       * Logged for whoever has to fix the rule, using the same console.warn
       * convention as the rate limiter. The message that reaches the client is
       * the fixed sentence below, never this one: an exception message can
       * carry a file path, a URL with a key in it, or any other detail the
       * thrower happened to include.
       */
      console.warn(
        `Rule "${rule.id}" threw while running and was skipped.`,
        error instanceof Error ? error.stack ?? error.message : error,
      );

      skipped.push({
        ruleId: rule.id,
        reason:
          "This check could not be evaluated because it failed to run. That is a fault in the check itself, not a problem with the website.",
      });
      continue;
    }

    if (outcome.kind === "finding" || outcome.kind === "pass") {
      findings.push(outcome.finding);
    } else if (outcome.kind === "skipped") {
      skipped.push({ ruleId: outcome.ruleId, reason: outcome.reason });
    }
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });

  return { findings, skipped };
}

/**
 * Refuses a rule set containing two rules with the same id.
 *
 * A duplicate id would make findings ambiguous to trace back and would break
 * the tests that address rules by id. Cheaper to catch here than to debug in a
 * client report.
 */
export function assertUniqueRuleIds(rules: readonly CompiledRule<never>[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }
}
