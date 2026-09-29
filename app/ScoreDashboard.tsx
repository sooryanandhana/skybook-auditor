/**
 * The premium dashboard: the audit's verdict, at a glance.
 *
 * WHAT IT DISPLAYS AND WHAT IT NEVER DOES. Every number on this dashboard comes
 * from `result.score` — the deterministic `ScoreResult` our own code computed
 * from the verified findings. This file grades nothing, averages nothing, and
 * re-derives nothing: it reads the score and the findings the server already
 * produced and lays them out. `result.score` is the single source of truth, and
 * a model cannot reach any of it.
 *
 * THREE BANDS, TOP TO BOTTOM. The overall health hero (grade, pass rate,
 * coverage), the four category tiles, and the issue triage with whatever capped
 * the grade. A withheld grade, a Not Assessed category and a capped grade are
 * each stated honestly rather than shown as a zero or hidden.
 */
import {
  GATE_HEADING,
  GATE_NOTE,
  SCORE_CATEGORY_ORDER,
  SCORE_PARTIAL_NOTE,
  coveragePercent,
  gateReasons,
  gradeBandLabel,
  isGradeCapped,
  scoreStatusMessage,
} from "@/lib/report/scoreView";
import { categoryLabel, severityCounts } from "@/lib/report/measurementsView";
import type { CategoryScore, Grade, ScoreResult } from "@/lib/scoring/score";
import type { Category, Finding } from "@/lib/types";
import styles from "./page.module.css";

/** The class carrying a grade's own colour. Total over the five grades. */
const GRADE_CLASS: Record<Grade, string> = {
  A: styles.gradeA,
  B: styles.gradeB,
  C: styles.gradeC,
  D: styles.gradeD,
  F: styles.gradeF,
};

/**
 * The whole dashboard.
 *
 * `findings` is the same list the findings section renders — the site findings
 * and, once measured, the speed findings — so the triage counts and the gate
 * titles describe exactly what the score saw. Nothing here reads a severity to
 * decide it; it reads the ones the rules set.
 */
export function ScoreDashboard({
  score,
  findings,
}: {
  score: ScoreResult;
  findings: Finding[];
}) {
  return (
    <section id="overview" className={styles.scoreboard} aria-labelledby="dashboard-heading">
      <h2 id="dashboard-heading" className={styles.scoreboardHeading}>
        Audit summary
      </h2>
      <ScoreHero score={score} />
      <CategoryScoreboard score={score} />
      <IssueTriage score={score} findings={findings} />
    </section>
  );
}

/**
 * The overall verdict: one grade, the weighted pass rate behind it, and how much
 * of the site it covers.
 *
 * THE GRADE AND THE PASS RATE ARE SHOWN TOGETHER, and when a gate has held the
 * grade below its pass rate the gap is stated in words — a site can pass most of
 * its checks and still grade F because one critical is not offset by twenty
 * passes. A withheld grade reads "Not graded" with the score's own reason,
 * never a zero.
 */
function ScoreHero({ score }: { score: ScoreResult }) {
  const statusMessage = scoreStatusMessage(score);
  const capped = isGradeCapped(score);

  return (
    <div className={styles.scoreHero}>
      <div className={styles.scoreGradeBlock}>
        {score.grade !== null ? (
          <>
            <span className={`${styles.scoreGrade} ${GRADE_CLASS[score.grade]}`}>
              {score.grade}
            </span>
            {/* The word carries the grade for anyone who cannot use the colour. */}
            <span className={styles.scoreGradeLabel}>{gradeBandLabel(score.grade)}</span>
          </>
        ) : (
          <span className={styles.scoreGradeNone}>Not graded</span>
        )}
      </div>

      <div className={styles.scoreMeta}>
        <p className={styles.scoreMetaHeading}>Website health</p>

        {score.passRate !== null && (
          <p className={styles.scorePassRate}>
            <span className={styles.scorePassRateValue}>{score.passRate}</span>
            <span className={styles.scorePassRateOutOf}> / 100 · weighted checks passed</span>
          </p>
        )}

        <p className={styles.scoreCoverage}>
          {coveragePercent(score.coverage)}% of applicable checks assessed
        </p>

        {statusMessage && <p className={styles.scoreStatus}>{statusMessage}</p>}

        {score.partial && <p className={styles.scoreCaveat}>{SCORE_PARTIAL_NOTE}</p>}

        {capped && score.grade !== null && score.passRate !== null && (
          <p className={styles.scoreCaveat}>
            {score.passRate}% of checks passed, but unresolved serious issues cap the
            grade at {score.grade}.
          </p>
        )}
      </div>
    </div>
  );
}

/** The four pillars, side by side, in their product order. */
function CategoryScoreboard({ score }: { score: ScoreResult }) {
  return (
    <div className={styles.categoryTiles}>
      {SCORE_CATEGORY_ORDER.map((category) => (
        <CategoryTile key={category} category={category} tile={score.categories[category]} />
      ))}
    </div>
  );
}

/**
 * One pillar's score, or a plain statement that it was not assessed.
 *
 * NOT ASSESSED IS NEVER A ZERO. A category no rule could run for reads "Not
 * assessed" in words — a grey 0 would tell a client their security is broken
 * when the truth is that it was never checked.
 */
function CategoryTile({
  category,
  tile,
}: {
  category: Category;
  tile: CategoryScore;
}) {
  return (
    <div className={styles.categoryTile}>
      <p className={styles.categoryTileLabel}>{categoryLabel(category)}</p>

      {tile.status === "assessed" ? (
        <>
          <p className={styles.categoryTileGrade}>
            <span className={`${styles.categoryTileLetter} ${GRADE_CLASS[tile.grade]}`}>
              {tile.grade}
            </span>
            <span className={styles.categoryTilePass}>{tile.passRate}%</span>
          </p>
          <p className={styles.categoryTileCoverage}>
            {coveragePercent(tile.coverage)}% assessed
          </p>
        </>
      ) : (
        <p className={styles.categoryTileNotAssessed}>Not assessed</p>
      )}
    </div>
  );
}

/**
 * How many problems, and which of them are holding the grade down.
 *
 * The counts are the severity split of the graded findings — the same split the
 * findings section shows, counting values the rules set. The gate list names the
 * findings the score itself chose in `gatedBy`, so a reader sees exactly what to
 * fix to lift the grade.
 */
function IssueTriage({
  score,
  findings,
}: {
  score: ScoreResult;
  findings: Finding[];
}) {
  const counts = severityCounts(findings);
  const reasons = gateReasons(score, findings);

  return (
    <div className={styles.triage}>
      <div className={styles.triageCounts}>
        {counts.length === 0 ? (
          <p className={styles.triageClean}>
            No critical, high or medium issues were found in what was assessed.
          </p>
        ) : (
          counts.map((entry) => (
            <div key={entry.severity} className={styles.triageStat}>
              <span className={`${styles.triageNumber} ${styles[entry.severity]}`}>
                {entry.count}
              </span>
              <span className={styles.triageLabel}>{entry.label}</span>
            </div>
          ))
        )}
      </div>

      {reasons.length > 0 && (
        <div className={styles.gate}>
          <p className={styles.gateHeading}>{GATE_HEADING}</p>
          <ul className={styles.gateList}>
            {reasons.map((reason) => (
              <li key={reason.id} className={styles.gateItem}>
                {reason.title}
              </li>
            ))}
          </ul>
          <p className={styles.gateNote}>{GATE_NOTE}</p>
        </div>
      )}
    </div>
  );
}
