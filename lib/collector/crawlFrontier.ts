/**
 * The queue of pages a crawl still has to visit, and the limits that stop it.
 *
 * NOTHING HERE FETCHES. It decides which addresses are allowed in, hands them
 * out in order, records what happened to each, and says when to stop. Keeping
 * that separate from the fetching means every limit can be tested exactly,
 * without a network or a stopwatch.
 *
 * THE POINT OF THE LIMITS
 *
 * A crawl walks someone else's website. Left alone it will follow a calendar
 * into the year 3000, or a faceted product filter into a combinatorial
 * explosion. Every limit below exists to make the crawl stop.
 *
 * THE POINT OF `stoppedBecause`
 *
 * A crawl that stopped at a limit has NOT audited the site. It has audited a
 * prefix of it. Reporting "no issues found" after stopping at page 150 of 4000
 * would be false in the way this project has spent its whole life avoiding —
 * so the reason is always recorded, and `complete` is true only when the queue
 * genuinely ran dry.
 */
import { createDeadline, type Deadline } from "./deadline.ts";
import { createUrlSet, isSameSite, normalizeCrawlUrl, type CrawlUrlRejection } from "./crawlUrl.ts";

export interface CrawlLimits {
  /** How many pages may be fetched. Counts attempts, not successes. */
  maxPages: number;
  /** How long the whole crawl may run. */
  maxDurationMs: number;
  /** How many URLs may wait in the queue before we stop accepting more. */
  maxQueueSize: number;
  /**
   * The most of one page's body we will read.
   *
   * Passed to `fetchPage` on every request, so setting it here actually
   * changes what is read. It was declared and never used for several stages —
   * a caller could configure a limit and silently get the fetcher's own
   * default instead.
   */
  maxResponseBytes: number;
  /** How many pages may be in flight at once. Used by the loop in stage 3. */
  concurrency: number;
  /** A pause between requests, so a crawl does not read as an attack. */
  perRequestDelayMs: number;
}

/**
 * Prototype defaults, not permanent product limits.
 *
 * 150 pages at roughly 1.5 per second is about a hundred seconds — long enough
 * to be useful, short enough that a salesperson will wait. Concurrency 3 with a
 * 200ms pause keeps us to a handful of requests per second against a single
 * stranger's server, which is polite rather than alarming.
 */
export const DEFAULT_CRAWL_LIMITS: CrawlLimits = {
  maxPages: 150,
  maxDurationMs: 300_000,
  maxQueueSize: 2_000,
  maxResponseBytes: 5_000_000,
  concurrency: 3,
  perRequestDelayMs: 200,
};

/** Why a crawl stopped. Only one of these means the whole site was covered. */
export type CrawlStopReason =
  /** The queue ran dry. This is the ONLY value that means a complete crawl. */
  | "completed"
  /** Hit maxPages. */
  | "max-pages"
  /** Hit maxDurationMs — the crawl's own budget. */
  | "max-duration"
  /** The queue filled, so URLs were discovered and never visited. */
  | "max-queue"
  /** The surrounding audit ran out of time, which is not the crawl's own limit. */
  | "deadline";

/** Where a URL was first found. */
export type UrlSource = "seed" | "html" | "sitemap";

/** What happened when a URL was offered to the frontier. */
export type OfferOutcome =
  | "queued"
  /** Already seen — the same page under any of its equivalent addresses. */
  | "duplicate"
  /** Belongs to another site, so it is neither crawled nor audited. */
  | "off-site"
  /** The queue is full. Counted as discovered; never visited. */
  | "queue-full"
  /** Not a usable address. See `reason`. */
  | "rejected";

export interface OfferResult {
  outcome: OfferOutcome;
  /** Present only when the outcome is "rejected". */
  reason?: CrawlUrlRejection;
}

/** One page the crawl could not read. Never an audit finding. */
export interface PageFailure {
  url: string;
  reason: string;
}

export interface CrawlSummary {
  requestedUrl: string;
  limits: CrawlLimits;
  stoppedBecause: CrawlStopReason;
  /** True only when stoppedBecause is "completed". */
  complete: boolean;
  /** Unique same-site pages the crawl became aware of, queued or not. */
  discovered: number;
  /** How many were still waiting when it stopped. Above zero means partial. */
  queuedAtStop: number;
  /** Pages fetched and read as HTML. The denominator for page-level findings. */
  evaluated: number;
  /** Pages that could not be read. Not findings — the site may be fine. */
  unavailable: PageFailure[];
  /** Fetched but not HTML: a PDF, an image. Not a failure either. */
  skippedNonHtml: number;
  /** Where the discovered pages came from. */
  sources: { html: number; sitemap: number };
}

export interface Frontier {
  /**
   * Offers a URL for crawling.
   *
   * Applies, in order: normalisation, the same-site rule, de-duplication, and
   * the queue limit. Anything that fails is reported, never silently dropped.
   */
  offer(href: string, source: UrlSource, base?: URL | string): OfferResult;
  /** The next page to fetch, or null when the queue is empty. */
  next(): URL | null;
  /** Records a page that was fetched and read as HTML. */
  recordEvaluated(url: URL | string): void;
  /** Records a page that could not be read. */
  recordUnavailable(url: URL | string, reason: string): void;
  /** Records a page that was fetched but is not HTML. */
  recordSkippedNonHtml(url: URL | string): void;
  /**
   * The limit forcing a stop right now, or null if the crawl may continue.
   *
   * An empty queue is NOT a stop reason — that is completion, and `summary()`
   * reports it.
   */
  stopReason(): CrawlStopReason | null;
  summary(): CrawlSummary;
  readonly queued: number;
  readonly discovered: number;
  /** Pages taken from the queue and dealt with, however they turned out. */
  readonly processed: number;
}

export interface FrontierOptions {
  /** The address the audit was asked about. Defines the site boundary. */
  requestedUrl: URL | string;
  limits?: Partial<CrawlLimits>;
  /**
   * The surrounding audit's clock, when there is one.
   *
   * Reported separately from the crawl's own `maxDurationMs`: "the audit ran
   * out of time" and "the crawl used its budget" are different facts, and
   * merging them would hide which limit needs raising.
   */
  outerDeadline?: Deadline;
  /** Injectable clock, so limit behaviour can be tested without waiting. */
  now?: () => number;
}

export function createFrontier(options: FrontierOptions): Frontier {
  const limits: CrawlLimits = { ...DEFAULT_CRAWL_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const startedAt = now();

  const site = new URL(String(options.requestedUrl));
  const requestedUrl = site.toString();

  const seen = createUrlSet();
  const queue: URL[] = [];
  const sources = { html: 0, sitemap: 0 };
  const unavailable: PageFailure[] = [];

  let evaluated = 0;
  let skippedNonHtml = 0;
  let processed = 0;

  /*
   * Sticky, because it changes the meaning of the whole result.
   *
   * Once the queue has overflowed we know pages were discovered and never
   * visited, so the crawl cannot be called complete even if it later drains
   * tidily. Recording it as a flag rather than stopping immediately lets the
   * crawl still audit everything it did manage to queue.
   */
  let queueOverflowed = false;

  /** Set at the moment a limit first forces a stop, so the reason is the real one. */
  let haltedBecause: CrawlStopReason | null = null;

  function currentLimit(): CrawlStopReason | null {
    // Order matters: the outer audit clock outranks our own budget, because
    // when it expires nothing else is allowed to run either.
    if (options.outerDeadline?.expired()) return "deadline";
    if (now() - startedAt >= limits.maxDurationMs) return "max-duration";

    /*
     * A limit is only a limit if it actually cost us something.
     *
     * Spending the page budget exactly as the queue runs dry means we visited
     * every page we found — the budget and the site simply came out even. There
     * is nothing left that we declined to visit, so reporting "we stopped at a
     * limit" would tell a client their audit was partial when it was complete.
     * A site with exactly 150 pages and a budget of 150 is the ordinary case
     * this exists for.
     *
     * The queue check is what keeps this honest, and it is NOT the same as
     * letting an empty queue override the limit: while even one eligible URL is
     * still waiting, the budget is genuinely why we are not visiting it, and
     * the crawl is genuinely partial. `queueOverflowed` is handled separately
     * in `summary()` and stays partial regardless — pages were discovered and
     * dropped, and an empty queue does not undo that.
     */
    if (processed >= limits.maxPages && queue.length > 0) return "max-pages";

    return null;
  }

  return {
    offer(href, source, base) {
      const resolved = normalizeCrawlUrl(href, base ?? site);
      if (!resolved.ok) return { outcome: "rejected", reason: resolved.reason };

      // Another site's page is neither crawled nor audited, so it is not
      // "discovered" either — discovered counts pages of THIS site.
      if (!isSameSite(resolved.url, site)) return { outcome: "off-site" };

      if (seen.has(resolved.url)) return { outcome: "duplicate" };

      /*
       * The queue limit is a memory guard, not a stop signal. We record the
       * page as discovered — it genuinely exists — mark that the queue
       * overflowed, and decline to queue it. The crawl finishes what it has
       * and reports itself partial.
       */
      if (queue.length >= limits.maxQueueSize) {
        seen.add(resolved.url);
        if (source !== "seed") sources[source] += 1;
        queueOverflowed = true;
        return { outcome: "queue-full" };
      }

      seen.add(resolved.url);
      if (source !== "seed") sources[source] += 1;
      queue.push(resolved.url);
      return { outcome: "queued" };
    },

    next() {
      // A limit reached mid-crawl stops us handing out more work, and the
      // reason is captured here rather than recomputed later — by the time the
      // summary is built the clock has moved on.
      const limit = currentLimit();
      if (limit !== null) {
        haltedBecause ??= limit;
        return null;
      }
      return queue.shift() ?? null; // FIFO: breadth-first, shallow pages first
    },

    recordEvaluated() {
      evaluated += 1;
      processed += 1;
    },

    recordUnavailable(url, reason) {
      unavailable.push({ url: String(url), reason });
      processed += 1;
    },

    recordSkippedNonHtml() {
      skippedNonHtml += 1;
      processed += 1;
    },

    stopReason() {
      const limit = currentLimit();
      if (limit !== null) haltedBecause ??= limit;
      return haltedBecause;
    },

    summary(): CrawlSummary {
      const stoppedBecause: CrawlStopReason =
        haltedBecause ?? currentLimit() ?? (queueOverflowed ? "max-queue" : "completed");

      return {
        requestedUrl,
        limits,
        stoppedBecause,
        // The single most important line in this file. Anything other than a
        // drained queue means the site was not fully audited.
        complete: stoppedBecause === "completed",
        discovered: seen.size,
        queuedAtStop: queue.length,
        evaluated,
        unavailable: [...unavailable],
        skippedNonHtml,
        sources: { ...sources },
      };
    },

    get queued() {
      return queue.length;
    },
    get discovered() {
      return seen.size;
    },
    get processed() {
      return processed;
    },
  };
}

/** A crawl deadline built from the limits, for the loop in stage 3. */
export function crawlDeadline(limits: CrawlLimits): Deadline {
  return createDeadline(limits.maxDurationMs);
}
