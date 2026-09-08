/**
 * The only thing an AI provider is allowed to send back.
 *
 * DEFINED NOW, DELIBERATELY, EVEN THOUGH NOTHING PRODUCES IT YET. The boundary
 * is only half a boundary if the inbound side is specified and the outbound
 * side is left to whatever a provider happens to return. Writing the return
 * shape down is what makes "AI only explains" a property of the types rather
 * than a promise in a comment.
 *
 * WHAT IS MISSING FROM THIS TYPE IS THE POINT
 *
 * There is no severity. No category. No count, no denominator, no score, no
 * completeness verdict, no list of affected pages, no measured value of any
 * kind. Every one of those was decided by fixed rules before the model was
 * asked anything, and there is no field here an answer could put a different
 * one into. A model that disagrees with a severity has nowhere to say so.
 *
 * `ruleId` IS THE JOIN. An explanation attaches to a finding by the rule that
 * produced it, never by matching on a title. A returned id that does not
 * appear in the input names nothing and is dropped; a finding with no
 * explanation is still a complete finding, because the evidence and the
 * remediation were ours all along.
 *
 * No provider is named here and no SDK is imported. Phase 5 adds an adapter
 * that speaks to one particular service and returns this; nothing above the
 * adapter learns which service it was.
 */
import type { AIContractVersion } from "./contract.ts";

/**
 * Prose about one deterministic finding.
 *
 * Every field is writing. Nothing here is a measurement, and nothing here may
 * be read as one.
 */
export interface AIExplanation {
  /** The finding this explains, by the rule that produced it. */
  readonly ruleId: string;
  /** What the measured fact means, in plain words. */
  readonly explanation: string;
  /** Why it matters to this business. Never a severity, and never a score. */
  readonly businessImpact: string;
  /**
   * The rule's own remediation, expanded into the client's context.
   *
   * An expansion, not a replacement. The action itself was decided in our
   * source where it can be reviewed.
   */
  readonly recommendation: string;
}

/**
 * A complete answer from an AI provider.
 *
 * The version is echoed so an answer built against an older contract can be
 * recognised rather than quietly merged into a newer report.
 */
export interface AIExplanationSet {
  readonly version: AIContractVersion;
  /**
   * The report's opening paragraph, written with every finding in view.
   *
   * The one thing here that is not about a single finding, and the reason it
   * belongs to the model rather than to us: a summary is a judgement about
   * emphasis — which of eleven problems a particular client should read first
   * — and that is writing, not measurement.
   *
   * IT SUMMARISES; IT DOES NOT TOTAL. Nothing in it is a count, a score or a
   * severity. Those were decided before the model was asked anything, they
   * appear in the report from the deterministic result, and a sentence here
   * that disagrees with one of them is wrong by definition.
   *
   * Required, not optional. A report with no opening is a worse report, and an
   * optional field would let a provider quietly stop producing one.
   */
  readonly executiveSummary: string;
  readonly explanations: readonly AIExplanation[];
}
