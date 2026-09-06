/**
 * How long each part of an audit is allowed to take.
 *
 * WHY THESE LIVE TOGETHER: they are not independent numbers. The audit's
 * budget and the speed check's budget must stay separate — that separation is
 * the whole reason the speed check moved to its own endpoint — and keeping
 * them in one file is what lets a test assert the relationship rather than
 * trusting two route files not to drift apart.
 */

/**
 * The longest one audit may take, covering every request it makes.
 *
 * Each part used to keep its own timer — the page fetch allowed 20 seconds and
 * could run twice, the technical checks another 10 — so nothing capped the
 * total and a slow site could hold a request open for around fifty seconds.
 *
 * This number does NOT move when the speed check gets slower. Steps 1-4 are
 * governed by it whether or not performance was requested, so ticking a box
 * about page speed can never change what the audit reports about robots.txt.
 */
export const AUDIT_BUDGET_MS = 30_000;

/**
 * The share of the audit's time the site-level checks may take together.
 *
 * SSL and DNS describe the site rather than the page, so Phase 4 will run them
 * once and reuse the result across every page it crawls. They are capped as a
 * group for the same reason the technical checks are: a component handed the
 * audit's whole clock would use every second the earlier steps did not.
 */
export const SITE_CHECKS_BUDGET_MS = 10_000;

/**
 * The speed check's own budget, on its own endpoint.
 *
 * Sits just above the collector's 90-second cap on a single request, so that
 * cap is what stops a slow reply — giving a clear "Google took too long"
 * rather than a vaguer deadline error. The margin also covers the one retry's
 * 300ms pause.
 *
 * RAISED FROM 65s WHEN THE CAP WENT TO 90s. That was affordable only because
 * the speed check no longer blocks the audit: the results are already on
 * screen and readable while this runs, so a longer wait costs a spinner in one
 * panel rather than a dead page.
 */
export const PERFORMANCE_BUDGET_MS = 95_000;

/**
 * How many audits may actually be RUNNING at the same time.
 *
 * NOT the same thing as the crawler's own `concurrency`, which is how many
 * pages ONE audit fetches at once and stays at 3. This bounds how many audits
 * exist to have workers at all, so the outbound total is 2 x 3 = 6 rather than
 * whatever number of audits happened to be submitted.
 *
 * WHY IT IS NEEDED NOW. Before the job API, POST /api/audit did the whole
 * audit while the caller waited, so the ten-per-minute request limit bounded
 * the WORK as well as the requests. Now POST returns in milliseconds and the
 * crawl carries on for minutes behind it, so ten accepted requests could mean
 * ten simultaneous crawls, thirty outbound workers, and ten sets of results in
 * memory. The request limit still does its own job; this does the other one.
 *
 * Two is a prototype figure for a tool one salesperson runs on one machine.
 */
export const MAX_CONCURRENT_AUDITS = 2;
