/**
 * The crawl loop: take a page from the frontier, fetch it, record what happened.
 *
 * THE SECURITY BOUNDARY IS NOT HERE, AND THAT IS DELIBERATE.
 *
 * This file performs no HTTP of its own. Every request goes through
 * `fetchPage`, which validates the hostname against private, loopback and
 * link-local addresses BEFORE EVERY REQUEST AND AGAIN ON EVERY REDIRECT HOP.
 * That check is the reason this crawler was written by hand rather than on top
 * of a crawling framework: a library that follows redirects internally would
 * fetch the target of a 302 without asking us, and a page that redirects to
 * 169.254.169.254 is exactly the attack this project has closed twice.
 *
 * So there is no fetch(), no axios, no got, no Crawlee. There is one call to
 * fetchPage and nothing else, and a test asserts that.
 *
 * THREE OUTCOMES, KEPT APART
 *
 *   evaluated    fetched and read as HTML. The only pages an audit may grade.
 *   unavailable  we could not read it. NOT a finding — the page may be fine
 *                and the fault ours, or the network's.
 *   non-HTML     a PDF or an image. Neither a success nor a failure; there was
 *                simply nothing to audit.
 *
 * Collapsing any two of those would put something untrue in a client's report.
 *
 * HOW THE CRAWL GROWS
 *
 * The frontier starts with the requested URL. Every page we successfully read
 * is then mined for `<a href>` links, which go back into the same frontier
 * through the same gate the starting address used. Pages we could not read
 * contribute nothing — a timeout tells us about the network, not the site.
 *
 * SCOPE: sitemap.xml is not read and robots.txt is not consulted yet, the
 * crawl is one page at a time, and the queue is strictly first-in-first-out,
 * so a site's own navigation order is the order it gets crawled in.
 */
import { capDeadline, createDeadline, type Deadline } from "./deadline.ts";
import { fetchPage, NOT_A_WEB_PAGE, type FetchedPage } from "./fetchPage.ts";
import { dedupKey, isSameSite, normalizeCrawlUrl, type CrawlUrlRejection } from "./crawlUrl.ts";
import { extractLinks } from "./extractLinks.ts";
import {
  discoverSitemapUrls,
  SITEMAP_DISCOVERY_SKIPPED,
  type SitemapDiscovery,
  type SitemapFetcher,
  type SitemapLimits,
} from "./sitemap.ts";
import {
  fetchRobots,
  robotsMeasurement,
  type RobotsMeasurement,
  type RobotsPolicy,
  type RobotsStatus,
} from "./robots.ts";
import {
  createFrontier,
  DEFAULT_CRAWL_LIMITS,
  type CrawlLimits,
  type CrawlSummary,
  type UrlSource,
} from "./crawlFrontier.ts";

/**
 * The longest any single page may take.
 *
 * Capped separately from the crawl's own budget so one unresponsive page
 * cannot spend the whole crawl. `fetchPage` already limits each individual
 * request; this limits a page's redirect chain as a whole.
 */
export const PAGE_BUDGET_MS = 20_000;

/** One page the crawl visited, and what came of it. */
export type CrawlPageOutcome =
  | { url: string; outcome: "evaluated"; page: FetchedPage }
  | { url: string; outcome: "unavailable"; reason: string }
  | { url: string; outcome: "non-html"; reason: string };

/**
 * A crawl's outcome: the page queue's own summary, plus how discovery went.
 *
 * WHY THIS EXTENDS `CrawlSummary` RATHER THAN CHANGING IT. The frontier's
 * summary describes the page queue, and the frontier cannot compute this — it
 * has no idea sitemaps exist, and should not. Adding the field there would mean
 * teaching the queue about a subsystem it does not own, and giving every
 * existing frontier a value it cannot know. So the frontier reports on pages,
 * this reports on the crawl, and callers read this one.
 *
 * READ THE `complete` NOTE BELOW BEFORE RELYING ON `stoppedBecause`.
 */
/** What the site's robots.txt said, and what we did about it. */
export interface RobotsReport {
  status: RobotsStatus;
  /**
   * Whether the crawl actually applied the site's rules.
   *
   * False when robots.txt could not be read — the crawl went ahead, but
   * nothing may claim its rules were respected. See `fetchRobots`.
   */
  enforced: boolean;
  /**
   * How many distinct same-site addresses robots kept us away from.
   *
   * CRAWL METADATA, NOT A FINDING. These pages are excluded because the site
   * asked, which is a well-run site behaving normally. The count exists so a
   * report can say "and 40 pages you asked us not to visit" instead of quietly
   * implying they did not exist.
   */
  excluded: number;
}

export interface SiteCrawlSummary extends CrawlSummary {
  sitemapDiscovery: SitemapDiscovery;
  robots: RobotsReport;
  /**
   * True only when the page crawl AND sitemap discovery both finished naturally.
   *
   * THE ONE PLACE WHERE `complete` IS NOT `stoppedBecause === "completed"`.
   * A crawl can visit every page it knew about — `stoppedBecause: "completed"`,
   * honestly — while sitemap discovery ran out of files or time and a section
   * of the site was never learned about. The page crawl really did complete, so
   * its reason stays as it is; but the crawl as a whole did not see the site,
   * so `complete` is false and `sitemapDiscovery.stoppedBecause` says why.
   *
   * Anything asking "did we audit the whole site?" must read THIS, never the
   * stop reason alone.
   */
  complete: boolean;
}

export interface CrawlResult {
  summary: SiteCrawlSummary;
  /**
   * The site's robots.txt, read once here and handed on.
   *
   * IN-PROCESS ONLY. It carries the file's text, so it stays out of the
   * summary and never reaches the browser or the AI contract. The site-file
   * checks read this instead of fetching the same file a second time, which
   * is what stops one audit reporting two different answers about it.
   */
  robots: RobotsMeasurement;
  /** Every page fetched and read as HTML, in the order they were visited. */
  pages: FetchedPage[];
  /** Every attempt, including the ones that produced nothing to audit. */
  attempts: CrawlPageOutcome[];
}

export interface CrawlOptions {
  /** The address the audit was asked about. Seeds the crawl and sets the site. */
  requestedUrl: string;
  limits?: Partial<CrawlLimits>;
  /** The surrounding audit's clock, when the crawl runs inside one. */
  outerDeadline?: Deadline;
  /** Injectable clock for the frontier's limits, so tests need not wait. */
  now?: () => number;
  /**
   * Swapped out by tests so no unit test touches the network.
   *
   * Typed as `fetchPage` itself, which is what stops a substitute quietly
   * having a different contract — and the production default is the real
   * function, so the security boundary is what runs unless a test says
   * otherwise.
   */
  fetchImpl?: typeof fetchPage;
  /**
   * Whether to read the site's sitemaps before crawling. On by default.
   *
   * Turned off by callers that want only what navigation reaches, and by tests
   * that are about something else.
   */
  useSitemaps?: boolean;
  sitemapLimits?: Partial<SitemapLimits>;
  /**
   * The fetcher for sitemaps and robots.txt, which are XML and text rather
   * than pages and so cannot go through `fetchPage`. Its production default
   * uses `safeFetch`, the same per-hop-checked boundary `technicalChecks` uses.
   */
  sitemapFetchImpl?: SitemapFetcher;
  /**
   * Whether to read and obey robots.txt. On by default.
   *
   * Turning it off makes the crawl ignore the site's wishes, so it exists for
   * tests and for auditing a site you own — never as a default.
   */
  useRobots?: boolean;
  /** The name to match `User-agent:` lines against. Ours unless overridden. */
  robotsAgentToken?: string;
  /**
   * How the politeness delay waits. Injectable so tests never spend real time.
   *
   * Given the exact number of milliseconds the crawl wants to pause for, which
   * is what lets a test assert the spacing rather than measure it.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Called after each page is dealt with, so a caller can report progress.
   *
   * Every number handed over is read from the crawl's own counters rather than
   * recomputed, so nothing here can drift from what the summary will say. It
   * carries no percentage: the denominator of a crawl is not known until it
   * ends, and inventing one would be inventing a fact.
   */
  onProgress?: (progress: CrawlProgress) => void;
}

/**
 * A truthful snapshot of a crawl in flight.
 *
 * `discovered` is what we know about SO FAR, not a total — a crawl discovers
 * more of a site as it reads it, so this number climbs. That is why there is
 * no percentage: "12 of 40 discovered" is a fact, "30% complete" is a guess.
 */
export interface CrawlProgress {
  /** Same-site pages the crawl knows about so far, queued or not. */
  discovered: number;
  /** How many are waiting to be visited right now. */
  queued: number;
  /** Pages read as HTML. */
  evaluated: number;
  /** Pages that could not be read. Not findings. */
  unavailable: number;
  /** Fetched but not HTML — a PDF, an image. Neither success nor failure. */
  skippedNonHtml: number;
  /** Distinct addresses robots.txt kept us away from. */
  robotsExcluded: number;
  /** Only ever true in the final snapshot of a crawl that genuinely finished. */
  complete: boolean;
}

/**
 * Spaces requests out across the WHOLE crawl, not per worker.
 *
 * Three workers each pausing 200ms between their own requests would put fifteen
 * requests a second on a stranger's server; three workers sharing one 200ms
 * spacing put five. The second is what the approved defaults describe, and it
 * is the number that matters to the person whose website this is.
 *
 * The slot is reserved SYNCHRONOUSLY and only then awaited, so two workers
 * arriving at the same moment take consecutive slots rather than the same one.
 */
function createPoliteness(
  delayMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
) {
  let nextFreeAt = 0;

  return {
    async slot(): Promise<void> {
      if (delayMs <= 0) return;

      const at = Math.max(now(), nextFreeAt);
      nextFreeAt = at + delayMs;

      const wait = at - now();
      if (wait > 0) await sleep(wait);
    },
  };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thrown when the address a crawl was asked to start from is not one we can
 * fetch — malformed, `javascript:`, `file:`, or a dotless machine name.
 *
 * A THROW RATHER THAN A RESULT, deliberately. Every other kind of trouble here
 * is a fact about the site and belongs in the summary; this one is a fact about
 * the call. There is no honest `stoppedBecause` for it either: the crawl did
 * not stop at a limit, and calling it "completed" would report a finished audit
 * of a site nobody ever visited. Callers hand this layer an address that has
 * already been through `normalizeUrl`, so reaching it means a bug upstream —
 * which is exactly what an exception is for.
 */
export class UnusableStartingUrlError extends Error {
  // Written out rather than declared as constructor parameter properties: Node
  // runs these files by stripping types, and that shorthand needs a compiler.
  readonly requestedUrl: string;
  readonly reason: CrawlUrlRejection;

  constructor(requestedUrl: string, reason: CrawlUrlRejection) {
    super(`Cannot start a crawl at ${requestedUrl}: ${reason}.`);
    this.name = "UnusableStartingUrlError";
    this.requestedUrl = requestedUrl;
    this.reason = reason;
  }
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const limits: CrawlLimits = { ...DEFAULT_CRAWL_LIMITS, ...options.limits };
  const fetchImpl = options.fetchImpl ?? fetchPage;
  const now = options.now ?? Date.now;
  const sleep = options.sleepImpl ?? realSleep;

  /*
   * The starting URL goes through the same gate as any discovered link:
   * parsing, the scheme check, the dotless-host check, and the stripping of
   * credentials, fragments and tracking parameters. It gets no exemption for
   * having been typed by a person rather than found in someone's markup.
   *
   * It is resolved against itself because a seed has no page to be relative to.
   * An address that needs a base — "/about", or "example.com" without a scheme
   * — is therefore refused here; making the crawl guess a scheme is the job of
   * `normalizeUrl`, upstream, where a human is there to be told what we assumed.
   */
  const seed = normalizeCrawlUrl(options.requestedUrl, options.requestedUrl);
  if (!seed.ok) {
    throw new UnusableStartingUrlError(options.requestedUrl, seed.reason);
  }

  const frontier = createFrontier({
    requestedUrl: seed.url,
    limits,
    outerDeadline: options.outerDeadline,
    now: options.now,
  });

  /*
   * The crawl's clock. Inside the audit's when there is one, so a crawl can
   * never outlive the request that asked for it.
   */
  const crawlClock = options.outerDeadline
    ? capDeadline(options.outerDeadline, limits.maxDurationMs)
    : createDeadline(limits.maxDurationMs);

  /*
   * The site's rules, read once, before anything is queued.
   *
   * The same file carries the `Sitemap:` lines, so its text is handed to
   * sitemap discovery below rather than fetched a second time.
   */
  const robots: RobotsPolicy = (options.useRobots ?? true)
    ? await fetchRobots({
        site: seed.url,
        deadline: crawlClock,
        fetchImpl: options.sitemapFetchImpl,
        agentToken: options.robotsAgentToken,
      })
    : { status: "unavailable", enforced: false, text: null, isAllowed: () => true };

  /*
   * Distinct addresses robots kept us away from, counted once each.
   *
   * A page named in both the sitemap and the navigation is one excluded page,
   * not two — this number goes into a report a person reads.
   */
  const robotsExcluded = new Set<string>();

  /**
   * The one way an address enters this crawl.
   *
   * THE ORDER OF THESE CHECKS IS THE SECURITY PROPERTY. Normalisation, then
   * the same-site rule, then robots, then the frontier — which normalises and
   * applies the same-site rule AGAIN on its own account. Robots therefore sits
   * between two independent checks it cannot influence, and can only ever
   * remove an address that would otherwise have been crawled. An `Allow:` line
   * naming somebody else's server, or a private address, changes nothing at
   * all; and every address that survives is still fetched through `fetchPage`,
   * which re-checks the hostname on every request and every redirect hop.
   */
  const offerIfPermitted = (href: string, source: UrlSource, base: URL): void => {
    const resolved = normalizeCrawlUrl(href, base);
    if (!resolved.ok) return;
    if (!isSameSite(resolved.url, seed.url)) return;

    if (!robots.isAllowed(resolved.url)) {
      robotsExcluded.add(resolved.key);
      return;
    }

    frontier.offer(resolved.url.toString(), source, base);
  };

  // Offered rather than pushed, so there is exactly one way into this crawl and
  // the seed is counted, de-duplicated and bounded like everything else. The
  // requested page gets no exemption from the site's rules either.
  offerIfPermitted(seed.url.toString(), "seed", seed.url);

  /*
   * The site's own list of its pages, read before any crawling begins.
   *
   * Done here rather than inside the loop so the order is decided once and is
   * the same every run: the requested page, then everything the sitemaps
   * declare, then whatever navigation turns up. Sitemap addresses come early
   * because they are the site telling us what it considers important, and a
   * crawl that stops at a limit will then have spent its budget on those.
   *
   * Every address goes through `offer` exactly like a link found in markup, so
   * a sitemap gets no privilege: same normalisation, same same-site rule, same
   * de-duplication, same queue limit. An address only a sitemap knows about is
   * still refused if it points at another domain.
   */
  let sitemapDiscovery: SitemapDiscovery = SITEMAP_DISCOVERY_SKIPPED;

  if (options.useSitemaps ?? true) {
    const declared = await discoverSitemapUrls({
      site: seed.url,
      deadline: crawlClock,
      limits: options.sitemapLimits,
      fetchImpl: options.sitemapFetchImpl,
      // Already read for its rules; this is the same file. The STATE travels
      // with it, so a robots.txt we could not read cannot be mistaken for one
      // that simply declared no sitemaps.
      robots: robotsMeasurement(robots),
    });

    sitemapDiscovery = declared.discovery;
    // Through the same gate as everything else: a sitemap cannot exempt a page
    // from the rules the same site published in its own robots.txt.
    for (const address of declared.urls) offerIfPermitted(address, "sitemap", seed.url);
  }

  const pages: FetchedPage[] = [];
  const attempts: CrawlPageOutcome[] = [];

  /*
   * Pages claimed from the queue that have not yet been recorded.
   *
   * THE NUMBER THAT MAKES CONCURRENCY SAFE. The frontier counts a page when it
   * is RECORDED, which is after the fetch returns — so while requests are in
   * flight its count is stale by exactly this much. Three workers checking a
   * budget of one would each see nothing spent and each take a page.
   *
   * Every claim is added here the instant it is made and removed in a
   * `finally`, and both happen between awaits, so no two workers can ever
   * observe the same stale total.
   */
  let inFlight = 0;

  const politeness = createPoliteness(limits.perRequestDelayMs, now, sleep);

  /**
   * Hands the caller the crawl's own counters, never a recomputed copy.
   *
   * `complete` is deliberately false in every snapshot taken while the crawl
   * is running: a crawl in flight has not finished, whatever its queue happens
   * to look like at this instant.
   */
  const reportProgress = (): void => {
    if (options.onProgress === undefined) return;
    const snapshot = frontier.summary();
    options.onProgress({
      discovered: snapshot.discovered,
      queued: snapshot.queuedAtStop,
      evaluated: snapshot.evaluated,
      unavailable: snapshot.unavailable.length,
      skippedNonHtml: snapshot.skippedNonHtml,
      robotsExcluded: robotsExcluded.size,
      complete: false,
    });
  };

  /**
   * Whether another page may be claimed right now.
   *
   * Counting the in-flight pages against the budget is what stops the pool
   * exceeding `maxPages`. The frontier applies its own `processed >= maxPages`
   * check inside `next()` as well — it is the looser of the two, so a mistake
   * here cannot silently uncap the crawl.
   */
  const mayClaim = (): boolean => frontier.processed + inFlight < limits.maxPages;

  /*
   * How an idle worker learns that the world has changed.
   *
   * AN EMPTY QUEUE IS NOT THE END OF THE CRAWL when other workers are still
   * running: the page one of them is reading may contain the next fifty links.
   * A worker that exited on the first empty queue would leave the pool with one
   * survivor — three workers would start, two would die on the seed page, and
   * the crawl would quietly run single-file for the rest of its life.
   *
   * So an idle worker parks here instead, and is woken when any page finishes.
   */
  let idleWaiters: Array<() => void> = [];
  const wakeIdleWorkers = (): void => {
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const wake of waiting) wake();
  };
  const waitForProgress = (): Promise<void> =>
    new Promise<void>((resolve) => idleWaiters.push(resolve));

  /** One worker, running until there is no more work it is allowed to do. */
  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (crawlClock.expired()) {
        frontier.stopReason();
        return;
      }

      if (!mayClaim()) {
        // The budget is committed. If nothing is running it can never free up.
        if (inFlight === 0) {
          // Records a limit if one is genuinely active now. Never touches the
          // queue, so it is safe to ask from any worker at any time.
          frontier.stopReason();
          return;
        }
        await waitForProgress();
        continue;
      }

      if (frontier.queued === 0) {
        // Nothing to do right now — and if nothing is in flight either, then
        // nothing can ever add more, so the queue has genuinely drained.
        if (inFlight === 0) return;
        await waitForProgress();
        continue;
      }

      /*
       * The politeness slot is taken BEFORE the page is claimed, and only once
       * we know there is something to claim.
       *
       * That ordering matters: a page taken out of the queue is a page we go on
       * to fetch. Claiming first and then discovering we must stop would leave
       * an address that is neither queued nor visited, and the frontier has no
       * way to hand one back.
       */
      await politeness.slot();

      // Re-checked after the wait: the world moved while we were sleeping.
      if (crawlClock.expired() || !mayClaim()) {
        frontier.stopReason();
        return;
      }

      const url = frontier.next();
      // Another worker took the last one while we waited for our slot.
      if (url === null) continue;

      inFlight += 1;
      try {
        await visit(url);
      } finally {
        inFlight -= 1;
        reportProgress();
        // Whatever happened, an idle worker may now have something to do —
        // and if this was the last one running, they need to know that too.
        wakeIdleWorkers();
      }
    }
  };

  /** Fetches one page and records what came of it. Exactly one record, always. */
  const visit = async (url: URL): Promise<void> => {
    const address = url.toString();
    /*
     * The crawl's own response limit is passed, not assumed.
     *
     * `maxResponseBytes` used to sit in the limits unread, so a caller could
     * configure it and silently receive the fetcher's built-in default — a
     * limit the API advertised and did not honour.
     */
    const result = await fetchImpl(
      address,
      capDeadline(crawlClock, PAGE_BUDGET_MS),
      limits.maxResponseBytes,
    );

    if (result.ok) {
      frontier.recordEvaluated(url);
      pages.push(result.page);
      attempts.push({ url: address, outcome: "evaluated", page: result.page });
      /*
       * Only a page we actually read can tell us about more pages.
       *
       * Safe with workers running alongside: every step of discovery —
       * normalising, the same-site rule, robots, and the frontier's own queue
       * and de-duplication — is synchronous, so one page's whole discovery
       * pass completes before any other worker can begin its own.
       */
      discoverLinks(result.page, url, seed.url, offerIfPermitted);
      return;
    }

    /*
     * A PDF or an image is not a broken page.
     *
     * Compared against the exported constant rather than the sentence, so the
     * two cannot drift apart if the wording is ever changed.
     */
    if (result.reason === NOT_A_WEB_PAGE) {
      frontier.recordSkippedNonHtml(url);
      attempts.push({ url: address, outcome: "non-html", reason: result.reason });
      return;
    }

    /*
     * Unavailable. Recorded with its address and the collector's own reason,
     * and that is all: no severity, no evidence, no remediation. A page we
     * could not read is not a page that failed a check, and turning one into
     * the other would put a fault in a report that the site may not have.
     */
    frontier.recordUnavailable(url, result.reason);
    attempts.push({ url: address, outcome: "unavailable", reason: result.reason });
  };

  /*
   * A fixed pool: `concurrency` workers, started once, each running until
   * there is nothing left it is permitted to do.
   *
   * `allSettled` rather than `all`, so one worker throwing does not leave the
   * others running unobserved after this function has already returned. A
   * fetcher is not supposed to throw — `fetchPage` never does — so if one has,
   * that is a fault in the caller's code and it is re-thrown once everything
   * has stopped, rather than being turned into a finding about the website.
   */
  const workerCount = Math.max(1, Math.floor(limits.concurrency));
  const settled = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure !== undefined && failure.status === "rejected") throw failure.reason;

  const pageCrawl = frontier.summary();

  return {
    summary: {
      ...pageCrawl,
      sitemapDiscovery,
      robots: {
        status: robots.status,
        enforced: robots.enforced,
        excluded: robotsExcluded.size,
      },
      /*
       * Both halves must have finished for the crawl to be called complete.
       *
       * The page crawl's own reason is left exactly as the frontier recorded
       * it — a page crawl that drained still says "completed", because it did.
       * What changes is the claim made about the SITE, and only downwards.
       */
      complete: pageCrawl.complete && sitemapDiscovery.complete,
    },
    pages,
    attempts,
    robots: robotsMeasurement(robots),
  };
}

/**
 * Feeds the links found on one page back into the frontier.
 *
 * THIS FUNCTION DECIDES ALMOST NOTHING, which is the reason it is safe. It
 * hands every href to the same `normalizeCrawlUrl` and the same `frontier.offer`
 * that the starting address went through, so the scheme rules, the length and
 * host checks, the tracking-parameter stripping, the www equivalence, the
 * same-site rule, the de-duplication and the queue limit are all the existing
 * ones. Nothing about a link being discovered rather than typed relaxes any of
 * them, and there is no second copy of any of them here.
 *
 * The two judgements it does make are both about WHICH PAGE WE ARE ON.
 */
function discoverLinks(
  page: FetchedPage,
  requestedUrl: URL,
  site: URL,
  offer: (href: string, source: UrlSource, base: URL) => void,
): void {
  /*
   * Relative links resolve against where we ENDED UP, not what we asked for.
   *
   * Requesting /blog and being redirected to /articles/ means a link to
   * "2024-review" is /articles/2024-review. Resolving it against the requested
   * address would give /2024-review — a page that does not exist — and we
   * would spend the crawl budget collecting 404s.
   */
  const here = normalizeCrawlUrl(page.finalUrl, page.finalUrl);
  if (!here.ok) return; // we cannot say where we are, so we do not guess

  /*
   * A redirect that left the site is recorded, but never mined.
   *
   * We asked for a same-site address and were sent elsewhere. Reading that
   * page is one thing; treating its navigation as a list of pages to crawl
   * would walk us straight into a stranger's website that nobody asked us to
   * audit. `offer` would refuse those links anyway — this refuses to even look.
   */
  if (!isSameSite(here.url, site)) return;

  /*
   * Every address this one page answered to.
   *
   * A link back to the current page must not queue it again. The frontier
   * already remembers the address we REQUESTED, so on an ordinary page its
   * de-duplication handles this by itself. A page that redirected is the gap:
   * the addresses it passed THROUGH, and the one it ended at, were never
   * offered, so a link to any of them looks new — and fetching one just
   * redirects back to the page we already have, which would audit it twice.
   *
   * This is a comparison against the page in hand, not a second visited-set.
   * The frontier remains the only thing that remembers where the crawl has been.
   */
  const ownAddresses = new Set([here.key, dedupKey(requestedUrl)]);
  for (const hop of page.redirectChain) {
    const stop = normalizeCrawlUrl(hop, hop);
    if (stop.ok) ownAddresses.add(stop.key);
  }

  const { baseHref, hrefs } = extractLinks(page.html);
  const base = effectiveBase(baseHref, here.url);

  for (const href of hrefs) {
    const resolved = normalizeCrawlUrl(href, base);
    // Not a usable address — `offer` would reject it too. Skipped quietly:
    // a mailto: link is normal markup, not a fault to report.
    if (!resolved.ok) continue;

    if (ownAddresses.has(resolved.key)) continue;

    offer(resolved.url.toString(), "html", base);
  }
}

/**
 * The address a page's relative links are actually relative to.
 *
 * A `<base href>` element changes that, and a browser obeys it — so a crawler
 * that ignores it requests pages the site never published. Given
 * `<base href="/shop/">`, a link to "widgets" is /shop/widgets to every real
 * visitor; resolving it against the page's own address instead would collect
 * 404s and miss the actual catalogue.
 *
 * A BASE IS NOT PERMISSION. It only decides what relative links point AT.
 * Whatever comes out still goes through `normalizeCrawlUrl` and still has to
 * satisfy the frontier's same-site rule, so `<base href="https://evil.test/">`
 * makes a page's relative links resolve to addresses that are then refused —
 * one line further on, by the same check that refuses any other off-site link.
 * There is no path by which a base widens what may be crawled.
 *
 * A base we cannot use is not an error and not a finding. Malformed, empty,
 * `javascript:`, a dotless host: any of them simply leaves resolution where it
 * would have been anyway, at the page's own address. `normalizeCrawlUrl` makes
 * that judgement, so the rules about schemes, hosts and lengths are the same
 * ones applied everywhere else rather than a second opinion.
 */
function effectiveBase(baseHref: string | null, pageUrl: URL): URL {
  if (baseHref === null) return pageUrl;

  // A base href may itself be relative — <base href="/shop/"> is ordinary —
  // so it resolves against the page before it can serve as a base for anything.
  const resolved = normalizeCrawlUrl(baseHref, pageUrl);
  return resolved.ok ? resolved.url : pageUrl;
}
