/**
 * Attaching the deterministic score to a finished audit.
 *
 * WHERE THE SCORE COMES FROM, AND WHERE IT DOES NOT.
 *
 * The score is computed by our own code from the audit's verified findings and
 * the ledger of which rules ran. It reads NOTHING an AI wrote — the commentary
 * lives in its own slot and is never an input here. So the grade a client is
 * shown cannot be moved by a model any more than a severity can.
 *
 * WHY IT IS ATTACHED HERE RATHER THAN MEASURED IN THE CRAWL.
 *
 * The score reads the whole audit, and the speed check is measured in its own
 * request and merged afterwards by `withSpeed`. A score taken during the crawl
 * would always read the speed check as pending, so it is taken at delivery,
 * from the crawl and the speed check together, exactly as the AI contract is.
 *
 * THE DELIVERED FINDINGS ARE LEFT ALONE. `withSpeed` builds a view for the
 * scorer to read, but this returns the original result with only a `score`
 * added — the speed findings are not merged into the delivered list, so a
 * consumer that joins the speed check itself sees no change. The score is the
 * one place the whole audit is summarised.
 */
import { withSpeed } from "./withSpeed.ts";
import { isCertificateFailureAudit } from "../report/siteFindingsView.ts";
import { scoreAudit } from "../scoring/score.ts";
import type { AuditResult, SpeedResult } from "../types.ts";

/**
 * One audit result carrying its deterministic score.
 *
 * Pure: the same result and speed check always produce the same score, and a
 * new object is returned so the stored job is left untouched. A `null` speed
 * check is an audit whose speed was never asked for — a complete audit whose
 * Speed category is simply Not Assessed, which the scorer states rather than
 * penalises.
 */
export function withScore(result: AuditResult, speed: SpeedResult | null): AuditResult {
  // A certificate failure read no page, so there is no speed check to merge —
  // it is scored on the site-level checks that did run.
  if (isCertificateFailureAudit(result)) {
    return { ...result, score: scoreAudit(result) };
  }

  // Score the whole audit — the crawl and the speed check together — while
  // leaving the delivered result's own findings exactly as the crawl produced
  // them.
  return { ...result, score: scoreAudit(withSpeed(result, speed)) };
}
