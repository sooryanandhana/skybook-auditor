"use client";
// ^ This tells Next.js the file runs in the BROWSER, not on the server.
//   We need that because this page has a button, a text box, and remembers
//   things (state) — all of which are browser-side behaviour.

import { useEffect, useRef, useState } from "react";
import { SignOut } from "./SignOut";
import { AuditProgress } from "./AuditProgress";
import { PerformancePanel } from "./PerformancePanel";
import { ReportDownload } from "./ReportDownload";
import {
  SKIPPED_HEADING,
  SKIPPED_INTRO,
  findingsState,
  findingsSummary,
  showsSkippedPanel,
} from "@/lib/report/findingsState";
import {
  PAGE_FINDINGS_HEADING,
  PAGE_FINDINGS_INTRO,
  SITE_FINDINGS_HEADING,
  REMEDIATION_LABEL,
  SITE_FINDINGS_INTRO,
  affectedView,
  auditStatusText,
  crawlView,
  hasAffectedList,
  partitionByScope,
  robotsNote,
  scopeLabel,
  siteFileText,
  type FindingScope,
} from "@/lib/report/siteFindingsView";
import { MAX_EXPLAINED_FINDINGS } from "@/lib/ai/contract";
import { exportableJobId } from "@/lib/report/pdfExport";
import {
  AI_EXPLANATION_LABEL,
  AI_IMPACT_LABEL,
  AI_PROVENANCE,
  AI_RECOMMENDATION_LABEL,
  AI_SUMMARY_HEADING,
  coverageNote,
  rejectedNote,
} from "@/lib/report/commentaryView";
import {
  certificateFacts,
  certificateProblemFacts,
  contentFacts,
  crawlLimitFacts,
  dmarcFacts,
  dnsFacts,
  groupByCategory,
  crawlCountTiles,
  crawlStateFacts,
  groupSkippedByReason,
  headingCountText,
  securityFacts,
  severityCounts,
  severityLabel,
  skippedCheckCount,
  spfFacts,
} from "@/lib/report/measurementsView";
import type { SiteCrawlSummary } from "@/lib/collector/crawlSite";
import type { AIExplanation } from "@/lib/ai/explanation";
import type {
  AuditData,
  AuditExplanationResponse,
  AuditResultResponse,
  AuditStartResponse,
  AuditStatusResponse,
  JobProgressView,
  SiteAuditResult,
  Finding,
  SkippedCheck,
  PerformanceData,
  PerformanceResponse,
  UptimeCheck,
} from "@/lib/types";
import styles from "./page.module.css";

/** How often to ask the server how the audit is getting on. */
const POLL_INTERVAL_MS = 1000;

export function AuditPage() {
  // Pieces of "state" — values the page remembers and re-renders when changed.
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  /** What the server last said about the running job, for the progress line. */
  const [jobStatus, setJobStatus] = useState<
    "queued" | "running" | "completed" | "partial" | null
  >(null);
  const [progress, setProgress] = useState<JobProgressView | null>(null);
  /**
   * The whole-site result, kept beside the entry page rather than instead of it.
   *
   * `result` stays exactly what it always was — the entry page's audit — so
   * every existing section renders unchanged. This carries the crawl summary
   * and the site-wide findings for the parts that need them.
   */
  const [siteResult, setSiteResult] = useState<SiteAuditResult | null>(null);
  /*
   * Opt-in, and remembered for the run that is in flight.
   * `includePerformance` can be toggled while an audit runs, so the progress UI
   * reads `runningWithPerformance` — what was actually asked for — rather than
   * what the checkbox says right now.
   */
  const [includePerformance, setIncludePerformance] = useState(false);
  /*
   * The speed check runs as its own request, so it has its own state. "running"
   * is a real state here — the audit below it is finished and readable while
   * this is still in flight.
   */
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [performanceRunning, setPerformanceRunning] = useState(false);
  /*
   * The speed findings, exactly as the server graded them.
   *
   * Held rather than derived. Nothing in this file decides a severity, reads a
   * threshold, or judges whether a site is slow — that happens in
   * lib/rules/speed.ts on the server, and the browser only displays the result.
   */
  const [performanceFindings, setPerformanceFindings] = useState<Finding[]>([]);
  const [performanceSkipped, setPerformanceSkipped] = useState<SkippedCheck[]>([]);

  /*
   * Which audit is current.
   *
   * A speed check started for the previous URL can still be in flight when a
   * new audit begins — Google takes up to 90 seconds. Without this, that older
   * reply would land in the panel and quietly report one site's speed under
   * another site's audit. Every reply checks this before it is allowed to
   * write anything.
   */
  const runIdRef = useRef(0);
  /** Lets a superseded speed check be abandoned rather than merely ignored. */
  const performanceAbortRef = useRef<AbortController | null>(null);
  /** The pending poll delay, so unmounting can clear it rather than leak it. */
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set when the component goes away, so a running poll loop stops. */
  const stoppedRef = useRef(false);

  /*
   * Stop polling when the page goes away.
   *
   * Without this the loop would keep asking a server nobody is listening to,
   * and would call setState on a component that no longer exists.
   */
  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
      performanceAbortRef.current?.abort();
    };
  }, []);
  /*
   * The written commentary, and whether it is still being written.
   *
   * A SEPARATE PIECE OF STATE FROM THE AUDIT, deliberately. The report above
   * is complete and on screen before this is even asked for, and nothing here
   * can empty, reorder or re-grade it. Null means "not asked yet or still
   * being written" and never means "the site is fine".
   */
  const [explanation, setExplanation] = useState<AuditExplanationResponse | null>(null);
  const [explanationRunning, setExplanationRunning] = useState(false);

  /**
   * The finished audit's job id, held so the report can be asked for.
   *
   * It was already flowing through the polling chain as an argument. Keeping
   * it in state is what lets a control rendered later name the audit it
   * belongs to, and it is cleared when a new audit starts so a download button
   * can never ask for the previous one's report.
   */
  const [jobId, setJobId] = useState<string | null>(null);

  const [result, setResult] = useState<AuditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed audit can still have measured something — see AuditResponse.
  const [errorUptime, setErrorUptime] = useState<UptimeCheck | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault(); // stop the browser reloading the page

    // Any reply from the previous audit is now stale by definition.
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    performanceAbortRef.current?.abort();
    performanceAbortRef.current = null;

    setIsLoading(true);
    setError(null);
    setErrorUptime(null);
    setResult(null);
    setSiteResult(null);
    setJobStatus(null);
    setProgress(null);
    setPerformance(null);
    setPerformanceRunning(false);
    setPerformanceFindings([]);
    setPerformanceSkipped([]);
    setExplanation(null);
    setExplanationRunning(false);
    setJobId(null);

    try {
      /*
       * The audit no longer answers this request — a full-site crawl takes
       * minutes. This starts one and gets back a receipt; the loop below asks
       * how it is getting on until it stops.
       */
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const started: AuditStartResponse = await response.json();

      // A newer audit started while this one was in flight.
      if (runIdRef.current !== runId) return;

      if (!started.ok) {
        setError(started.error);
        setIsLoading(false);
        return;
      }

      setJobId(started.jobId);
      void pollUntilDone(started.jobId, runId);
    } catch {
      if (runIdRef.current !== runId) return;
      setError("Could not reach the audit service. Is the server running?");
      setIsLoading(false);
    }
  }

  /**
   * Asks how the audit is getting on, once a second, until it stops.
   *
   * Sequential rather than on a timer: each poll is sent only after the last
   * one answered, so a slow reply can never leave two in flight or let them
   * arrive out of order. `runIdRef` ends the loop when a newer audit begins,
   * and `stoppedRef` ends it when the component goes away — an interval left
   * running after unmount would poll a server nobody is listening to.
   */
  async function pollUntilDone(jobId: string, runId: number) {
    setJobStatus("queued");

    for (;;) {
      if (runIdRef.current !== runId || stoppedRef.current) return;

      await new Promise((resolve) => {
        pollTimerRef.current = setTimeout(resolve, POLL_INTERVAL_MS);
      });

      if (runIdRef.current !== runId || stoppedRef.current) return;

      let status: AuditStatusResponse;
      try {
        const response = await fetch(
          `/api/audit/status?jobId=${encodeURIComponent(jobId)}`,
        );
        status = await response.json();
      } catch {
        if (runIdRef.current !== runId) return;
        setError("Lost contact with the audit service.");
        setIsLoading(false);
        return;
      }

      if (runIdRef.current !== runId || stoppedRef.current) return;

      if (!("status" in status)) {
        // The job is gone — expired, or the server restarted.
        setError(status.error);
        setIsLoading(false);
        return;
      }

      if (status.status === "failed") {
        setError(status.error);
        setIsLoading(false);
        return;
      }

      setJobStatus(status.status);
      setProgress(status.progress);

      // Terminal: stop asking and go and get the report.
      if (status.status === "completed" || status.status === "partial") {
        await loadResult(jobId, runId);
        return;
      }
    }
  }

  /** Fetches the finished audit and puts it on screen. */
  async function loadResult(jobId: string, runId: number) {
    try {
      const response = await fetch(`/api/audit/result?jobId=${encodeURIComponent(jobId)}`);
      const payload: AuditResultResponse = await response.json();

      if (runIdRef.current !== runId || stoppedRef.current) return;

      if (!payload.ok) {
        setError("error" in payload ? payload.error : "The audit produced no report.");
        return;
      }

      setResult(payload.result.data);
      setSiteResult(payload.result);

      /*
       * The audit is on screen now. The speed check starts here and the page
       * stays fully usable while it runs — this is the whole point of the
       * split, so it must not be awaited before showing the results above.
       */
      if (includePerformance) {
        /*
         * The commentary waits for the speed check, and only for that.
         *
         * The server composes what the model sees from what it measured, and
         * the speed figures arrive last. Asking before they land would produce
         * a report that says the speed check is pending -- which is true, and
         * useless, and permanent, because the answer is asked for once.
         *
         * `startPerformance` handles its own failures and never rejects, so
         * this runs whether the speed check succeeded or not. A speed check
         * that failed is still a measured state the writing may describe.
         */
        void startPerformance(payload.result.data.fetch.finalUrl, runId, jobId).then(() => {
          void startExplanation(jobId, runId);
        });
      } else {
        void startExplanation(jobId, runId);
      }
    } catch {
      if (runIdRef.current !== runId) return;
      setError("Could not read the finished audit.");
    } finally {
      if (runIdRef.current === runId) setIsLoading(false);
    }
  }

  /**
   * Asks the server for the speed figures, separately from the audit.
   *
   * There is deliberately no retry here. The collector already makes at most
   * two attempts at Google, and a retry in the browser would turn that into
   * four — doubling a paid quota to solve a problem already solved.
   */
  async function startPerformance(finalUrl: string, runId: number, jobId: string) {
    const controller = new AbortController();
    performanceAbortRef.current = controller;
    setPerformanceRunning(true);

    try {
      /*
       * The job id travels with the request so the SERVER can keep this result
       * beside the audit it belongs to. The browser still receives it exactly
       * as before and renders from its own copy — nothing here changes what is
       * shown, only what the server is able to describe later.
       */
      const response = await fetch(
        `/api/audit/performance?jobId=${encodeURIComponent(jobId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: finalUrl }),
          signal: controller.signal,
        },
      );

      const payload: PerformanceResponse = await response.json();
      if (runIdRef.current !== runId) return;

      setPerformance(
        payload.ok ? payload.data : localPerformanceFailure(finalUrl, payload.error),
      );
      // Copied through untouched. A failed request grades nothing, so there is
      // nothing to invent here either.
      setPerformanceFindings(payload.ok ? payload.findings : []);
      setPerformanceSkipped(payload.ok ? payload.skippedChecks : []);
    } catch (fetchError) {
      /*
       * An abort means WE cancelled it because a newer audit began. That is not
       * a failure of anything, and reporting it as one would invent a Google
       * error that never happened.
       */
      if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
      if (runIdRef.current !== runId) return;

      setPerformance(
        localPerformanceFailure(
          finalUrl,
          "Could not reach the speed check on this server.",
        ),
      );
    } finally {
      if (runIdRef.current === runId) setPerformanceRunning(false);
    }
  }

  /**
   * Asks the server, once, for the writing that goes beside the report.
   *
   * ONE REQUEST, AND NO RETRY. The server hands out a single claim per audit,
   * so asking again would be answered from what it already has -- but there is
   * no reason to ask again at all, and a retry here would be the beginning of
   * a loop that spends money.
   *
   * THE BROWSER NEVER TALKS TO A MODEL. It sends a job id to this server and
   * receives prose that has already been validated against the audit. There is
   * no key here, no provider client, and nothing to configure.
   */
  async function startExplanation(jobId: string, runId: number) {
    setExplanationRunning(true);

    try {
      const response = await fetch(
        `/api/audit/explain?jobId=${encodeURIComponent(jobId)}`,
        { method: "POST" },
      );

      const payload: AuditExplanationResponse = await response.json();
      if (runIdRef.current !== runId || stoppedRef.current) return;

      setExplanation(payload);
    } catch {
      /*
       * Not reaching this server is not a failure of the audit, which is
       * already on screen. It is recorded as the one thing we actually know.
       */
      if (runIdRef.current !== runId) return;
      setExplanation({
        ok: true,
        jobId,
        state: "not-explained",
        reason: "network",
        message: "Could not reach the commentary service on this server.",
      });
    } finally {
      if (runIdRef.current === runId) setExplanationRunning(false);
    }
  }

  /*
   * Which audit, if any, a report may be made from.
   *
   * Decided here because this is the one place that knows both halves of it:
   * which audit is current, and whether it finished with something to typeset.
   * An audit that is queued, running or failed leaves this null.
   */
  const reportJobId = exportableJobId(jobId, result !== null);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          {/*
            The logo file has ~77% empty padding around it, and stacks the icon
            above the wordmark and tagline. We show only the icon here by
            scaling the image up inside a fixed-size box that hides the overflow.
            The crop values come from measuring the file's actual content bounds.
          */}
          <span className={styles.logoMark} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/skybook-digital-logo-white.png" alt="" className={styles.logoImg} />
          </span>
          <p className={styles.brand}>Skybook</p>
          <SignOut />
        </div>
        <h1 className={styles.title}>Website Audit</h1>
        <p className={styles.subtitle}>
          Enter a website address to check its speed, SEO, security, and technical health.
        </p>
      </header>

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="example.com"
          aria-label="Website address"
          disabled={isLoading}
        />
        <button className={styles.button} type="submit" disabled={isLoading || !url.trim()}>
          {isLoading ? "Checking…" : "Run Audit"}
        </button>
      </form>

      {/*
        Off by default, and says why. The speed test is the slowest thing this
        tool does, so the cost is on the label rather than discovered after the
        button is pressed.
      */}
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={includePerformance}
          onChange={(event) => setIncludePerformance(event.target.checked)}
          disabled={isLoading}
        />
        <span>
          Include Google PageSpeed performance analysis
          <span className={styles.toggleNote}>
            Takes up to 90 seconds, and runs separately — your audit results
            appear first. Uses Google&rsquo;s service, not this server.
          </span>
        </span>
      </label>

      {/*
        A statement of how the report is produced, not a caveat about it —
        hence the plain subtitle style rather than the amber notice box that
        carried the old "rules still being written" warning.
      */}
      <p className={styles.subtitle}>
        This report is generated from deterministic website checks.
        Recommendations are based on measured results.
      </p>

      {isLoading && <AuditProgress />}

      {/*
        Counts, never a percentage. A crawl discovers more of a site as it
        reads it, so there is no denominator that would make a percentage
        true — "12 of 40 discovered" is a fact, "30% complete" is a guess.
      */}
      {isLoading && progress !== null && (
        <p className={styles.progressLine} role="status">
          {jobStatus === "queued"
            ? "Waiting for an available audit slot…"
            : `${progress.evaluated} of ${progress.discovered} pages read` +
              (progress.queued > 0 ? ` · ${progress.queued} waiting` : "") +
              (progress.unavailable > 0
                ? ` · ${progress.unavailable} could not be read`
                : "") +
              (progress.robotsExcluded > 0
                ? ` · ${progress.robotsExcluded} excluded by robots.txt`
                : "")}
        </p>
      )}

      {/*
        A crawl that stopped at a limit is not a whole-site audit, and the
        report must say so rather than letting the reader assume otherwise.
        This is state, not a finding: it carries no severity, because a limit
        we imposed is not a fault of the website.
      */}
      {siteResult !== null && (
        <CrawlSummary crawl={siteResult.crawl} />
      )}

      {error && (
        <div className={styles.error}>
          <p>{error}</p>
          {/* We couldn't audit the page, but we did reach the server —
              show what was genuinely measured rather than discarding it. */}
          {errorUptime && (
            <p className={styles.errorDetail}>
              The server did respond ({errorUptime.statusCode}) in{" "}
              {errorUptime.serverResponseTimeMs} ms, so the site itself is reachable.
            </p>
          )}
        </div>
      )}

      {result && (
        <Results
          data={result}
          siteResult={siteResult}
          performance={performance}
          performanceRunning={performanceRunning}
          performanceFindings={performanceFindings}
          performanceSkipped={performanceSkipped}
          explanation={explanation}
          explanationRunning={explanationRunning}
          reportJobId={reportJobId}
        />
      )}
    </main>
  );
}

/**
 * A speed section describing a failure on OUR side of the wire.
 *
 * Used when the request never reached the collector — a refused address, the
 * rate limit, or our own server being unreachable. Marked "internal-error"
 * rather than any Google-specific reason, because in these cases nothing at
 * all is known about Google's service.
 */
function localPerformanceFailure(requestedUrl: string, message: string): PerformanceData {
  return {
    status: "error",
    strategy: "mobile",
    requestedUrl,
    failureReason: "internal-error",
    field: {
      status: "error",
      measuredUrl: null,
      scope: null,
      overall: null,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      ttfb: null,
      error: message,
    },
    lab: {
      status: "error",
      measuredUrl: null,
      score: null,
      lcpMs: null,
      fcpMs: null,
      tbtMs: null,
      speedIndexMs: null,
      cls: null,
      error: message,
    },
    notInspected: [
      "Page speed and Core Web Vitals — the speed check could not be started.",
    ],
    message,
  };
}

/** Displays one completed audit. */
function Results({
  data,
  siteResult,
  performance,
  performanceRunning,
  performanceFindings,
  performanceSkipped,
  explanation,
  explanationRunning,
  reportJobId,
}: {
  data: AuditData;
  /** The whole-site audit, when a crawl produced one. */
  siteResult: SiteAuditResult | null;
  performance: PerformanceData | null;
  performanceRunning: boolean;
  performanceFindings: Finding[];
  performanceSkipped: SkippedCheck[];
  /** The server's answer about the writing. Null until it has answered. */
  explanation: AuditExplanationResponse | null;
  explanationRunning: boolean;
  /** The audit a report may be made from, or null when none may be. */
  reportJobId: string | null;
}) {
  /*
   * ruleId -> the writing about that rule.
   *
   * Built from the server's list, which the validator already checked against
   * the audit. A lookup rather than a merge: the finding is rendered from the
   * server's measurement exactly as before, and the writing is shown beside it
   * only when the id matches something that actually fired. An entry naming a
   * rule not on screen therefore renders nothing at all -- there is no card
   * for it to appear on.
   */
  const explanations = new Map<string, AIExplanation>(
    explanation !== null && explanation.ok && explanation.state === "explained"
      ? explanation.explanations.map((entry) => [entry.ruleId, entry])
      : [],
  );
  return (
    <section className={styles.results}>
      <div className={styles.summary}>
        {/*
          Said plainly, because a speed check that failed must not make the
          whole audit read as failed. The performance panel carries its own
          heading for that case.
        */}
        {/*
          "Complete" is a claim about the SITE, so it may only be made when
          the crawl actually covered it. A partial crawl says so instead —
          the banner above gives the detail, and this must not contradict it.
        */}
        <p className={styles.completeBadge}>
          {auditStatusText(siteResult?.crawl.complete ?? true)}
        </p>
        <h2 className={styles.resultsUrl}>{data.fetch.finalUrl}</h2>
        <p className={styles.checkedAt}>
          Checked {new Date(data.website.checkedAt).toLocaleString()}
        </p>
        {data.fetch.wasRedirected && (
          <p className={styles.checkedAt}>
            Redirected from {data.website.requestedUrl}
          </p>
        )}
        <dl className={styles.uptime}>
          <div>
            {/* "Responded" rather than "Online": the server answering is the
                fact we measured. A 404 site is answering, so it is not down. */}
            <dt>Server</dt>
            <dd>{data.uptime.isOnline ? "Responded" : "No response"}</dd>
          </div>
          <div>
            <dt>Status code</dt>
            <dd>{data.uptime.statusCode ?? "—"}</dd>
          </div>
          <div>
            {/* Deliberately not "response time" or "load time" — this measures
                only how quickly the server began replying, not how long the
                page took to load. */}
            <dt>Server response</dt>
            <dd>
              {data.uptime.serverResponseTimeMs === null
                ? "—"
                : `${data.uptime.serverResponseTimeMs} ms`}
            </dd>
          </div>
        </dl>
      </div>

      {/*
        Directly under the summary, because the document IS the deliverable —
        a salesperson opens this to get something to hand over, and burying
        the button below two screens of appendix would hide it. The findings
        still come first among the report's own sections: this is an action,
        not one of them.
      */}
      {reportJobId !== null && (
        <ReportDownload jobId={reportJobId} auditedUrl={data.fetch.finalUrl} />
      )}

      {/*
        FINDINGS FIRST.

        They used to sit last, below the speed panel and twenty-eight rows of
        measured facts — about seventeen hundred pixels down, two screens below
        the fold. That inverted the product: a salesperson opens this to learn
        what is wrong with a prospect's site, and had to scroll past the
        appendix to reach the answer.

        The measured facts exist so a person can CHECK a claim, which means
        they belong after the claim, not in front of it.

        The audit findings and the speed findings are shown together. Both
        arrays arrive already GRADED by the server. Each is sorted within
        itself, so the concatenation is not — FindingsSection reorders them by
        the severity it was given. Ordering by a severity is not deciding one.
      */}
      <AiSummaryPanel
        answer={explanation}
        running={explanationRunning}
        findingCount={
          (siteResult?.site.findings ?? data.findings).length + performanceFindings.length
        }
      />

      <FindingsSection
        /*
         * The WHOLE SITE when a crawl produced one, not just the entry page.
         *
         * `site.findings` already contains both kinds: the page-scoped rules
         * aggregated across every page that was read, and the site-scoped rules
         * evaluated once. Adding `data.findings` as well would show the entry
         * page twice, since it is one of the pages already counted.
         */
        findings={[...(siteResult?.site.findings ?? data.findings), ...performanceFindings]}
        skipped={[
          ...(siteResult?.site.skippedChecks ?? data.skippedChecks),
          ...performanceSkipped,
        ]}
        explanations={explanations}
      />

      {siteResult !== null && (
        <CoverageDetail crawl={siteResult.crawl} technical={siteResult.data.technical} />
      )}

      {/*
        Its own section, with its own state. The audit above is complete and
        readable whatever this is doing.
      */}
      <PerformancePanel
        performance={performance ?? data.performance}
        running={performanceRunning}
      />

      <MeasuredFacts data={data} />
    </section>
  );
}

/**
 * What the rules concluded, and what they could not look at.
 *
 * Four states, because collapsing them is how a report ends up saying
 * something untrue. "No findings" can mean the site came back clean, or that
 * several checks never ran — and only one of those is good news. The section
 * used to say grading had not happened at all, which stopped being true the
 * moment the security rules started running.
 *
 * The skipped list is deliberately plain: no badge, no colour, no severity. A
 * check that did not run is neither a problem nor a pass, and styling it as
 * either would make it one.
 */
function FindingsSection({
  findings,
  skipped,
  explanations,
}: {
  findings: Finding[];
  skipped: SkippedCheck[];
  /** Written commentary by rule id. Empty when there is none, which is fine. */
  explanations: Map<string, AIExplanation>;
}) {
  const state = findingsState(findings.length, skipped.length);
  const summary = findingsSummary(state);

  /*
   * Worst first. The findings arrive from two requests, each sorted within
   * itself, so the joined list needs reordering to read sensibly.
   *
   * This reads `severity` and never sets it. Every value here was decided by
   * a rule on the server; nothing in the browser can change one, and the ties
   * break on id so the order is stable rather than dependent on which request
   * answered first.
   */
  const ordered = [...findings].sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, good: 3 } as const;
    return rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id);
  });

  /*
   * Split by the scope the RULE declared, which the server carried through.
   * Nothing here reads a title or an id to work out what a finding is about.
   */
  const { site, page } = partitionByScope(ordered);

  /*
   * The severity split, counted from the findings the server graded.
   *
   * "Findings (11)" was the only number on the page, and it is the wrong
   * one: one critical among ten mediums is a different conversation from
   * eleven mediums. Nothing here decides a severity — it counts values the
   * rules set, and skipped checks are not among them.
   */
  const counts = severityCounts(findings);

  // Grouped by REASON, so three certificate checks skipped for the same
  // reason read as one sentence rather than three identical ones.
  const skippedGroups = groupSkippedByReason(skipped);

  return (
    <>
      <h3 className={styles.findingsHeading}>Findings ({findings.length})</h3>

      {counts.length > 0 && (
        <p className={styles.severitySummary}>
          {counts.map((entry, index) => (
            <span key={entry.severity}>
              {index > 0 && <span className={styles.severityDivider}> · </span>}
              <span className={`${styles.severityCount} ${styles[entry.severity]}`}>
                {entry.count}
              </span>{" "}
              {entry.label}
            </span>
          ))}
        </p>
      )}

      {summary && <p className={styles.emptyFindings}>{summary}</p>}

      {site.length > 0 && (
        <ScopedFindings
          id="site-findings"
          heading={SITE_FINDINGS_HEADING}
          intro={SITE_FINDINGS_INTRO}
          findings={site}
          scope="site"
          explanations={explanations}
        />
      )}

      {page.length > 0 && (
        <ScopedFindings
          id="page-findings"
          heading={PAGE_FINDINGS_HEADING}
          intro={PAGE_FINDINGS_INTRO}
          findings={page}
          scope="page"
          explanations={explanations}
        />
      )}

      {showsSkippedPanel(state) && (
        <section className={styles.skipped}>
          {/*
            GROUPED BY CHECK, because one check can genuinely be skipped for
            two reasons — cookie flags are moot on an HTTP page, and there is
            nothing to look at on a page that set no cookies. Both are true and
            the aggregator deliberately keeps both.

            Listed flat, the same check appeared twice and read like a bug in
            the report. Grouping is presentation only: every reason survives,
            and two are never merged into a sentence neither of them said. The
            count is of CHECKS, which is what the heading names.
          */}
          <h4 className={styles.skippedHeading}>
            {SKIPPED_HEADING} ({skippedCheckCount(skipped)})
          </h4>
          <p className={styles.skippedIntro}>{SKIPPED_INTRO}</p>
          <ul className={styles.skippedList}>
            {skippedGroups.map((group) => (
              <li key={group.reason} className={styles.skippedItem}>
                {/* The rules' own written titles, not their identifiers. */}
                <span className={styles.skippedId}>{group.checks.join(" · ")}</span>
                {/* The server's own reason, verbatim. Never reworded here. */}
                <span className={styles.skippedReason}>{group.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * One scope's findings, gathered under the subject each rule declared.
 *
 * Eleven findings in one list is a list nobody reads. `category` was on every
 * finding already — set by the rule, carried through aggregation untouched —
 * and was the one field the page ignored.
 *
 * THE SCOPE SPLIT COMES FIRST AND STILL DOES. Category grouping happens inside
 * a scope, never across one, so a site-wide fact about a certificate is never
 * shown among page-level ones.
 *
 * Ordering is `groupByCategory`'s, where it is tested: worst first at the group
 * level too, so grouping cannot bury a critical security problem under a run of
 * medium SEO ones. Nothing here reads or sets a severity.
 */
function ScopedFindings({
  id,
  heading,
  intro,
  findings,
  scope,
  explanations,
}: {
  id: string;
  heading: string;
  intro: string;
  findings: Finding[];
  scope: FindingScope;
  explanations: Map<string, AIExplanation>;
}) {
  const categories = groupByCategory(findings);

  return (
    <section className={styles.findingGroup} aria-labelledby={id}>
      <h4 id={id} className={styles.groupHeading}>
        {heading} ({findings.length})
      </h4>
      <p className={styles.groupIntro}>{intro}</p>

      {categories.map((group) => (
        <div key={group.category} className={styles.categoryGroup}>
          <h5 className={styles.categoryHeading}>
            {group.label} ({group.findings.length})
          </h5>
          <ul className={styles.findings}>
            {group.findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                scope={scope}
                explanation={explanations.get(finding.id)}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * One finding.
 *
 * Every number and every sentence comes from the server. The only decisions
 * made here are which of them to show and where to put it.
 */
function FindingCard({
  finding,
  scope,
  explanation,
}: {
  finding: Finding;
  scope: FindingScope;
  /** Writing about this finding, when there is any. Never a measurement. */
  explanation?: AIExplanation;
}) {
  const reach = affectedView(finding);

  return (
    <li className={styles.finding}>
      <span className={`${styles.badge} ${styles[finding.severity]}`}>
        {severityLabel(finding.severity)}
      </span>
      <div className={styles.findingBody}>
        <p className={styles.findingTitle}>{finding.title}</p>

        <p className={styles.findingMeta}>
          {/* Not colour alone: the scope is spelled out in words. */}
          <span className={scope === "site" ? styles.scopeSite : styles.scopePage}>
            {scopeLabel(scope)}
          </span>
          {/*
            Present only for page findings, and only when the server supplied
            both numbers. A site finding has no page denominator and must never
            be shown one.
          */}
          {reach.reach !== null && <span className={styles.reach}>{reach.reach}</span>}
        </p>

        <p className={styles.evidence}>{finding.evidence}</p>

        {/*
          The fixed action declared by the rule, not written by an AI.

          Labelled and set apart, because it and the evidence used to be two
          grey paragraphs of the same size — and a reader could not tell what
          was measured from what to do about it. The label carries the
          distinction in words, so it does not rest on the styling alone.
        */}
        <p className={styles.remediation}>
          <span className={styles.remediationLabel}>{REMEDIATION_LABEL}</span>
          {finding.remediation}
        </p>

        {scope === "page" && hasAffectedList(finding) && (
          <details className={styles.affected}>
            <summary className={styles.affectedToggle}>
              View affected pages
              {/*
                Said outright when the list is shorter than the total, so the
                sample is never mistaken for the whole.
              */}
              {reach.sample !== null && (
                <span className={styles.affectedSample}> ({reach.sample})</span>
              )}
            </summary>
            <ul className={styles.affectedList}>
              {reach.pages.map((entry) => (
                <li key={entry.url} className={styles.affectedItem}>
                  <span className={styles.affectedUrl}>{entry.url}</span>
                  <span className={styles.affectedEvidence}>{entry.evidence}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/*
          The writing, LAST and clearly labelled.

          Below the evidence and the fixed action on purpose: what was measured
          and what the rule says to do about it come first, and this explains
          them. It carries no badge, no count and no denominator, because there
          is no field in the contract it arrives on that could hold one.
        */}
        {explanation !== undefined && <FindingExplanation explanation={explanation} />}
      </div>
    </li>
  );
}

/**
 * What a model wrote about one finding.
 *
 * PLAIN TEXT ONLY. Every string here is rendered as text by React, which
 * escapes it; nothing uses `dangerouslySetInnerHTML`, no link is built from
 * it, and no part of it is ever put in an href or a style. The words
 * originated with a model that was shown text taken off somebody else's
 * website, so they are treated as text and nothing else.
 *
 * NONE OF THIS IS A MEASUREMENT and the labels say so. The severity, the
 * counts, the evidence and the action above were all decided by our own code
 * and are unaffected by anything here.
 */
function FindingExplanation({ explanation }: { explanation: AIExplanation }) {
  return (
    <div className={styles.aiExplanation}>
      <p className={styles.aiLabel}>{AI_EXPLANATION_LABEL}</p>
      <p className={styles.aiText}>{explanation.explanation}</p>

      <p className={styles.aiSubLabel}>{AI_IMPACT_LABEL}</p>
      <p className={styles.aiText}>{explanation.businessImpact}</p>

      <p className={styles.aiSubLabel}>{AI_RECOMMENDATION_LABEL}</p>
      <p className={styles.aiText}>{explanation.recommendation}</p>
    </div>
  );
}

/**
 * The written summary of the whole audit, and only ever a real one.
 *
 * NOTHING IS INVENTED HERE. With no answer yet the panel says it is being
 * written; with an answer that produced no writing it says so and why; with an
 * empty summary it renders nothing at all rather than filling the space.
 *
 * IT CANNOT OVERRIDE THE REPORT. It sits above the findings and describes
 * them; every severity, count and measurement on this page comes from the
 * audit and is rendered whether this panel says anything or not.
 */
function AiSummaryPanel({
  answer,
  running,
  findingCount,
}: {
  answer: AuditExplanationResponse | null;
  running: boolean;
  /** How many findings are on the page, so any without commentary are accounted for. */
  findingCount: number;
}) {
  if (running || answer === null) {
    return (
      <section className={styles.aiPanel} aria-live="polite">
        <p className={styles.aiPanelHeading}>AI summary</p>
        <p className={styles.aiPending}>Writing a summary of these findings…</p>
      </section>
    );
  }

  if (!answer.ok || answer.state === "not-explained") {
    /*
     * A sentence the server wrote, shown as it was written.
     *
     * It never contains a provider's own words, a status line or an exception,
     * and it never says anything about the website. The audit above is
     * complete either way, and the wording is chosen so a reader cannot
     * mistake a missing paragraph for a missing check.
     */
    const message = answer.ok ? answer.message : answer.error;

    return (
      <section className={styles.aiPanel}>
        <p className={styles.aiPanelHeading}>AI summary</p>
        <p className={styles.aiUnavailable}>{message}</p>
        <p className={styles.aiUnavailableNote}>
          Every finding below was measured and graded by this tool, and is
          unaffected.
        </p>
      </section>
    );
  }

  if (answer.executiveSummary.trim() === "") return null;

  const coverage = coverageNote(findingCount, MAX_EXPLAINED_FINDINGS);

  return (
    <section className={styles.aiPanel}>
      <p className={styles.aiPanelHeading}>{AI_SUMMARY_HEADING}</p>
      <p className={styles.aiSummary}>{answer.executiveSummary}</p>
      <p className={styles.aiPanelNote}>
        {AI_PROVENANCE}
        {answer.partial && ` ${rejectedNote(answer.rejectedCount) ?? ""}`}
        {/*
          Said for the same reason the dropped-entry sentence is: a reader who
          counts the findings and counts the explanations should find the
          difference already accounted for.
        */}
        {coverage !== null && ` ${coverage}`}
      </p>
    </section>
  );
}

/**
 * What the crawl covered.
 *
 * `partial` comes straight from the server complete flag. Nothing here
 * decides whether a crawl finished by comparing counts — a crawl can read
 * every page it found and still be incomplete, because there were sections it
 * never heard of.
 */
function CrawlSummary({ crawl }: { crawl: SiteCrawlSummary }) {
  const view = crawlView(crawl);
  const robots = robotsNote(crawl);

  return (
    <section
      className={view.partial ? styles.crawlPartial : styles.crawlComplete}
      aria-labelledby="crawl-summary"
    >
      {/* h2: it sits at the top level of the report, beside the audited
          address, so an h3 here would skip a level from the page title. */}
      <h2 id="crawl-summary" className={styles.crawlHeading}>
        {view.partial ? "Partial crawl" : "Site crawl"}
      </h2>
      <p className={styles.crawlHeadline}>{view.headline}</p>
      {view.reason !== null && <p className={styles.crawlReason}>{view.reason}</p>}
      {robots !== null && <p className={styles.crawlReason}>{robots}</p>}

      <dl className={styles.crawlFacts}>
        {view.facts.map((fact) => (
          <div key={fact.label} className={styles.crawlFact}>
            <dt className={styles.crawlFactLabel}>{fact.label}</dt>
            <dd className={styles.crawlFactValue}>{fact.value}</dd>
          </div>
        ))}
      </dl>

    </section>
  );
}

/**
 * How much of the site was seen, and what the crawl met on the way.
 *
 * BELOW THE FINDINGS, DELIBERATELY. This began life inside the coverage banner
 * at the top and grew to about seven hundred pixels, which pushed the first
 * finding thirteen hundred pixels down the page — undoing the earlier decision
 * that put findings first. It is reference material: it explains why coverage
 * is what it is, which is a question a reader has after seeing the findings,
 * not before.
 *
 * The numbers use the same compact tiles as the coverage counts above. The
 * states that carry a caveat stay as rows, because "Could not be checked" in a
 * tile beside "416" would read as a count.
 */
function CoverageDetail({
  crawl,
  technical,
}: {
  crawl: SiteCrawlSummary;
  technical: AuditData["technical"];
}) {
  return (
    <section className={styles.coverage} aria-labelledby="coverage-detail">
      <h3 id="coverage-detail" className={styles.findingsHeading}>
        Crawl coverage
      </h3>
      <p className={styles.groupIntro}>
        How the crawl found its way around the site, measured once.
      </p>

      <dl className={styles.crawlFacts}>
        {crawlCountTiles(crawl).map((tile) => (
          <div key={tile.label} className={styles.crawlFact}>
            <dt className={styles.crawlFactLabel}>{tile.label}</dt>
            <dd className={styles.crawlFactValue}>{tile.value}</dd>
          </div>
        ))}
      </dl>

      <dl className={styles.crawlDetail}>
        {crawlStateFacts(crawl, technical).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
      </dl>

      {/*
        Folded away: the limits explain a partial result rather than describing
        the website, so they are available without being in the way.
      */}
      <details className={styles.limits}>
        <summary className={styles.limitsToggle}>Audit limits</summary>
        <dl className={styles.factList}>
          {crawlLimitFacts(crawl.limits).map((row) => (
            <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
          ))}
        </dl>
      </details>
    </section>
  );
}

/**
 * The raw measured facts, shown as a plain table.
 *
 * This panel stays in the finished app on purpose. Once Claude writes the
 * report in Phase 5, a person needs to be able to check any sentence it wrote
 * against the measurement it came from — this is where they do that.
 *
 * All values here are rendered as plain text. Some (page title, description)
 * are copied from the audited website, and React escaping is what stops that
 * third-party content being treated as markup.
 */
function MeasuredFacts({ data }: { data: AuditData }) {
  const { seo, technical, fetch } = data;

  return (
    <section className={styles.facts}>
      <h3 className={styles.findingsHeading}>Measured facts</h3>
      <dl className={styles.factList}>
        <Fact
          label="Served over HTTPS"
          value={fetch.servedOverHttps ? "Yes" : "No"}
          note={
            fetch.httpsUnavailable
              ? "HTTPS could not be reached; the page was read over plain HTTP"
              : undefined
          }
        />
        {certificateProblemFacts(fetch.certificateProblem).map((fact) => (
          <Fact key={fact.label} label={fact.label} value={fact.value} note={fact.note} />
        ))}
        {fetch.wasRedirected && (
          <Fact
            label="Redirects"
            value={`${fetch.redirectChain.length - 1} followed`}
            note={fetch.redirectChain.join(" → ")}
          />
        )}
        {/*
          Page-level, and about the page that was audited. The character count
          is reported and not judged — the threshold that decides when a page
          is too thin to grade headings by lives in the rules, and stays there.
        */}
        {contentFacts(seo).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
        <Fact
          label="Page title"
          value={seo.titleText ?? "— none —"}
          note={seo.titleText ? `${seo.titleLength} characters` : undefined}
        />
        <Fact
          label="Meta description"
          value={seo.metaDescriptionText ?? "— none —"}
          note={
            seo.metaDescriptionText ? `${seo.metaDescriptionLength} characters` : undefined
          }
        />
        <Fact
          label="Main heading (h1)"
          value={seo.h1Count === 0 ? "— none —" : seo.h1Texts.join(" · ")}
          /*
           * `h1Texts` can be SHORTER than `h1Count`: an empty <h1></h1> is an
           * element carrying no text, so it appears in the count and not in the
           * list. The note used to read "2 found" beside a single heading and
           * left the reader to spot the discrepancy; it now says outright how
           * many carried no text.
           */
          note={headingCountText(seo.h1Count, seo.h1Texts)}
        />
        <Fact
          label="Subheadings"
          value={`${seo.h2Count} h2 · ${seo.h3Count} h3`}
        />
        <Fact
          label="Heading order"
          value={seo.headingSkips.length === 0 ? "No skipped levels" : seo.headingSkips.join("; ")}
        />
        <Fact
          label="Images"
          value={`${seo.imageCount} total`}
          note={
            seo.imageCount === 0
              ? undefined
              : `${seo.imagesMissingAlt} missing alt text`
          }
        />
        <Fact label="Language" value={seo.langAttribute ?? "— not set —"} />
        <Fact label="Canonical URL" value={seo.canonicalUrl ?? "— not set —"} />
        <Fact label="Mobile viewport tag" value={seo.hasViewportMeta ? "Present" : "Missing"} />
        {/* technical is null when the audit ran out of time. Saying "Not
            found" there would claim we looked when we did not. */}
        <Fact
          label="robots.txt"
          value={
            technical === null
              ? "Not checked — the audit ran out of time"
              : siteFileText(technical.robotsTxtStatus, "Found")
          }
          note={technical?.robotsBlocksEverything ? "Blocks all crawlers" : undefined}
        />
        <Fact
          label="Sitemap"
          value={
            technical === null
              ? "Not checked — the audit ran out of time"
              : siteFileText(technical.sitemapStatus, technical.sitemapUrl ?? "Found")
          }
        />
      </dl>

      {/*
        THE CERTIFICATE AND THE DOMAIN'S RECORDS.

        All of this was measured on every audit and displayed on none of them.
        The only way a certificate reached a reader was by being broken enough
        to produce a finding, so a valid one and an unread one looked exactly
        alike: like nothing at all.

        Every row is a measured value written out by `measurementsView`, which
        is where the wording lives and where it is tested. Nothing is graded
        here — that already happened, in the rules, and its conclusions are in
        the findings above.

        SITE-SCOPED, and said so. The facts above describe the page that was
        audited; these describe the whole domain and were measured once.
      */}
      <h3 className={styles.findingsHeading}>Certificate</h3>
      {/*
        Deliberately says nothing about a TLS connection. A site served over
        plain HTTP presents no certificate and opens no such connection, and an
        intro claiming one would contradict the row directly beneath it.
      */}
      <p className={styles.groupIntro}>Measured once, for the whole site.</p>
      <dl className={styles.factList}>
        {certificateFacts(data.ssl).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
      </dl>

      <h3 className={styles.findingsHeading}>Domain and email records</h3>
      <p className={styles.groupIntro}>
        One set of records for the whole domain, looked up once.
      </p>
      <dl className={styles.factList}>
        {dnsFacts(data.dns).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
        {spfFacts(data.dns).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
        {dmarcFacts(data.dns).map((row) => (
          <Fact key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
      </dl>

      <h3 className={styles.findingsHeading}>Security</h3>
      <dl className={styles.factList}>
        {/*
          ELEVEN ROWS, BUILT ONCE. They used to be written out here and the PDF
          needed the same eleven; two copies of a sentence about a client's
          site drift, and the browser and an export would then disagree about
          the same measurement.
        */}
        {securityFacts(data.security).map((fact) => (
          <Fact key={fact.label} label={fact.label} value={fact.value} note={fact.note} />
        ))}
      </dl>
    </section>
  );
}

/** Turns the HSTS measurements into one readable line. */
function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className={styles.factNote}>{note}</span>}
      </dd>
    </div>
  );
}

