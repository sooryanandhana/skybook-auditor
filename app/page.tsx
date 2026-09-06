"use client";
// ^ This tells Next.js the file runs in the BROWSER, not on the server.
//   We need that because this page has a button, a text box, and remembers
//   things (state) — all of which are browser-side behaviour.

import { useEffect, useRef, useState } from "react";
import { AuditProgress } from "./AuditProgress";
import { PerformancePanel } from "./PerformancePanel";
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
  SITE_FINDINGS_INTRO,
  affectedView,
  crawlView,
  hasAffectedList,
  partitionByScope,
  robotsNote,
  scopeLabel,
  siteFileText,
  type FindingScope,
} from "@/lib/report/siteFindingsView";
import type { SiteCrawlSummary } from "@/lib/collector/crawlSite";
import type {
  AuditData,
  AuditResultResponse,
  AuditStartResponse,
  AuditStatusResponse,
  CertificateProblem,
  JobProgressView,
  SiteAuditResult,
  Finding,
  SkippedCheck,
  PerformanceData,
  PerformanceResponse,
  Severity,
  UptimeCheck,
} from "@/lib/types";
import styles from "./page.module.css";

/** How often to ask the server how the audit is getting on. */
const POLL_INTERVAL_MS = 1000;

export default function HomePage() {
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
        void startPerformance(payload.result.data.fetch.finalUrl, runId);
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
  async function startPerformance(finalUrl: string, runId: number) {
    const controller = new AbortController();
    performanceAbortRef.current = controller;
    setPerformanceRunning(true);

    try {
      const response = await fetch("/api/audit/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: finalUrl }),
        signal: controller.signal,
      });

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
      {siteResult !== null && <CrawlSummary crawl={siteResult.crawl} />}

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
}: {
  data: AuditData;
  /** The whole-site audit, when a crawl produced one. */
  siteResult: SiteAuditResult | null;
  performance: PerformanceData | null;
  performanceRunning: boolean;
  performanceFindings: Finding[];
  performanceSkipped: SkippedCheck[];
}) {
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
          {siteResult !== null && !siteResult.crawl.complete
            ? "Partial website audit"
            : "Website audit complete"}
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
      />

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
}: {
  findings: Finding[];
  skipped: SkippedCheck[];
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

  return (
    <>
      <h3 className={styles.findingsHeading}>Findings ({findings.length})</h3>

      {summary && <p className={styles.emptyFindings}>{summary}</p>}

      {site.length > 0 && (
        <section className={styles.findingGroup} aria-labelledby="site-findings">
          <h4 id="site-findings" className={styles.groupHeading}>
            {SITE_FINDINGS_HEADING} ({site.length})
          </h4>
          <p className={styles.groupIntro}>{SITE_FINDINGS_INTRO}</p>
          <ul className={styles.findings}>
            {site.map((finding) => (
              <FindingCard key={finding.id} finding={finding} scope="site" />
            ))}
          </ul>
        </section>
      )}

      {page.length > 0 && (
        <section className={styles.findingGroup} aria-labelledby="page-findings">
          <h4 id="page-findings" className={styles.groupHeading}>
            {PAGE_FINDINGS_HEADING} ({page.length})
          </h4>
          <p className={styles.groupIntro}>{PAGE_FINDINGS_INTRO}</p>
          <ul className={styles.findings}>
            {page.map((finding) => (
              <FindingCard key={finding.id} finding={finding} scope="page" />
            ))}
          </ul>
        </section>
      )}

      {showsSkippedPanel(state) && (
        <section className={styles.skipped}>
          <h4 className={styles.skippedHeading}>
            {SKIPPED_HEADING} ({skipped.length})
          </h4>
          <p className={styles.skippedIntro}>{SKIPPED_INTRO}</p>
          <ul className={styles.skippedList}>
            {skipped.map((check) => (
              <li key={`${check.ruleId} ${check.reason}`} className={styles.skippedItem}>
                <span className={styles.skippedId}>{check.ruleId}</span>
                {/* The server own reason, verbatim. Never reworded here. */}
                <span className={styles.skippedReason}>{check.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * One finding.
 *
 * Every number and every sentence comes from the server. The only decisions
 * made here are which of them to show and where to put it.
 */
function FindingCard({ finding, scope }: { finding: Finding; scope: FindingScope }) {
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
        {/* The fixed action declared by the rule, not written by an AI. */}
        <p className={styles.remediation}>{finding.remediation}</p>

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
      </div>
    </li>
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
        {fetch.certificateProblem && (
          <Fact
            label="Certificate problem"
            value={certificateProblemLabel(fetch.certificateProblem)}
            note="Observed while connecting. A full certificate check is not implemented yet."
          />
        )}
        {fetch.wasRedirected && (
          <Fact
            label="Redirects"
            value={`${fetch.redirectChain.length - 1} followed`}
            note={fetch.redirectChain.join(" → ")}
          />
        )}
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
          note={`${seo.h1Count} found`}
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

      <h3 className={styles.findingsHeading}>Security</h3>
      <dl className={styles.factList}>
        <Fact
          label="HTTPS protection (HSTS)"
          value={hstsSummary(data.security.hsts, data.security.strictTransportSecurity.present)}
          note={data.security.strictTransportSecurity.value ?? undefined}
        />
        <Fact
          label="Content-Security-Policy"
          value={cspSummary(data.security)}
          note={
            data.security.contentSecurityPolicy.value ??
            data.security.contentSecurityPolicyReportOnly.value ??
            undefined
          }
        />
        <Fact
          label="X-Frame-Options"
          value={data.security.xFrameOptions.value ?? "Missing"}
        />
        <Fact
          label="X-Content-Type-Options"
          value={data.security.xContentTypeOptions.value ?? "Missing"}
        />
        <Fact
          label="Referrer-Policy"
          value={data.security.referrerPolicy.value ?? "Missing"}
        />
        <Fact
          label="Permissions-Policy"
          value={data.security.permissionsPolicy.present ? "Present" : "Missing"}
          note={data.security.permissionsPolicy.value ?? undefined}
        />
        <Fact
          label="Cookies set by this page"
          value={cookieSummary(data.security.cookies)}
          note={
            data.security.cookies.cookies.length > 0
              ? data.security.cookies.cookies
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `${c.name}: ${c.secure ? "Secure" : "no Secure"}, ${
                        c.httpOnly ? "HttpOnly" : "no HttpOnly"
                      }, SameSite=${c.sameSite ?? "not set"}`,
                  )
                  .join("  ·  ")
              : undefined
          }
        />
        <Fact
          label="Insecure resources"
          value={mixedContentSummary(data.security.mixedContent)}
          note={
            data.security.mixedContent.items.length > 0
              ? data.security.mixedContent.items
                  .slice(0, 5)
                  .map((item) => `${item.element} (${item.via}): ${item.url}`)
                  .join("  ·  ")
              : undefined
          }
        />
        {/* Shown next to the count so it is never read as a whole-site
            all-clear. This scan reads the served markup and nothing more. */}
        {data.security.mixedContent.applicable && (
          <Fact
            label="Not checked by this scan"
            value={data.security.mixedContent.notInspected.join("  ·  ")}
          />
        )}
        <Fact
          label="Insecure form submission"
          value={
            data.security.insecureFormActions.length === 0
              ? "None found"
              : `${data.security.insecureFormActions.length} form${data.security.insecureFormActions.length === 1 ? "" : "s"} sends data over plain HTTP`
          }
          note={
            data.security.insecureFormActions.length > 0
              ? data.security.insecureFormActions.slice(0, 3).join("  ·  ")
              : undefined
          }
        />
        <Fact
          label="Server software announced"
          value={
            [data.security.serverHeader.value, data.security.poweredByHeader.value]
              .filter(Boolean)
              .join(" · ") || "— not announced —"
          }
        />
      </dl>
    </section>
  );
}

/** Turns the HSTS measurements into one readable line. */
function hstsSummary(hsts: AuditData["security"]["hsts"], headerPresent: boolean): string {
  if (!hsts.applicable) return "Not applicable — the page is not served over HTTPS";
  if (!headerPresent) return "No HSTS header sent";
  if (hsts.disabledByZeroMaxAge) return "Header present but switched off (max-age=0)";
  if (hsts.maxAgeSeconds === null) return "Header present, but its max-age could not be read";

  const days = Math.round(hsts.maxAgeSeconds / 86400);
  const extras = [
    hsts.includesSubdomains ? "includes subdomains" : null,
    hsts.preload ? "preload" : null,
  ].filter(Boolean);

  return `${days} day${days === 1 ? "" : "s"}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

/**
 * Describes the Content-Security-Policy situation in one line.
 *
 * A report-only policy is monitored but not enforced, so saying "Present"
 * for one would imply protection the site does not actually have.
 */
function cspSummary(security: AuditData["security"]): string {
  if (security.contentSecurityPolicy.present) return "Present";
  if (security.contentSecurityPolicyReportOnly.present) {
    return "Report-only — monitored but not enforced";
  }
  return "Missing";
}

/** Summarises the cookies, saying how many lack each protective flag. */
function cookieSummary(cookies: AuditData["security"]["cookies"]): string {
  if (cookies.total === 0) return "None set by this page";

  const missingSecure = cookies.cookies.filter((c) => !c.secure).length;
  const missingHttpOnly = cookies.cookies.filter((c) => !c.httpOnly).length;
  const missingSameSite = cookies.cookies.filter((c) => c.sameSite === null).length;

  const gaps = [
    missingSecure > 0 ? `${missingSecure} without Secure` : null,
    missingHttpOnly > 0 ? `${missingHttpOnly} without HttpOnly` : null,
    missingSameSite > 0 ? `${missingSameSite} without SameSite` : null,
  ].filter(Boolean);

  const plural = cookies.total === 1 ? "" : "s";
  return gaps.length === 0
    ? `${cookies.total} cookie${plural}, all flags set`
    : `${cookies.total} cookie${plural} — ${gaps.join(", ")}`;
}

/**
 * Turns the mixed-content measurements into one readable line.
 *
 * The wording says "in the page HTML" deliberately. We read the markup the
 * server sent; we do not run the page or download its stylesheets. A bare
 * "None found" would claim more than we checked.
 */
function mixedContentSummary(mixed: AuditData["security"]["mixedContent"]): string {
  if (!mixed.applicable) return "Not applicable — the page is not served over HTTPS";
  if (mixed.total === 0) return "None found in the page HTML";

  const blocking = mixed.activeCount > 0 ? `, ${mixed.activeCount} likely blocked by browsers` : "";
  return `${mixed.total} found in the page HTML, loaded over plain HTTP${blocking}`;
}

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

function certificateProblemLabel(problem: CertificateProblem): string {
  switch (problem) {
    case "expired":
      return "The certificate has expired";
    case "self-signed":
      return "The certificate is self-signed, so browsers will not trust it";
    case "wrong-hostname":
      return "The certificate was issued for a different address";
    case "untrusted":
      return "The certificate could not be verified";
  }
}

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "good":
      return "Good";
  }
}
