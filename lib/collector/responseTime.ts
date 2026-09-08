/**
 * How quickly the server starts answering, measured three times.
 *
 * WHY THREE, AND WHY A MEDIAN
 *
 * One timing is an anecdote. A single request can land on a cold cache, a
 * garbage collection pause or a noisy neighbour, and a report that says "your
 * server takes 900ms" on that basis is a report a client can disprove by
 * refreshing. Three samples and their middle value throw away one outlier in
 * either direction, which is the smallest honest improvement available.
 *
 * THREE SAMPLES ARE NOT THREE RETRIES. Every one of them is taken whether or
 * not the last succeeded, because the point is a distribution rather than an
 * answer. Nothing here re-runs a failed request hoping for a better result.
 *
 * WHAT IS TIMED, AND WHAT IS NOT
 *
 * The clock starts immediately before the request and stops the moment the
 * response headers arrive. The body is never read -- it is cancelled straight
 * away -- so no download time, no HTML parsing, no rule evaluation, no
 * rendering and nothing about the report is inside the number.
 *
 * It still includes the connection setup, because a visitor waits for that
 * too. It is time to first byte, not page-load time; those have been confused
 * in this project before, and the field name and this paragraph exist so they
 * are not confused again.
 *
 * ONE HONEST CAVEAT, RECORDED RATHER THAN HIDDEN. The samples run one after
 * another against one host, so the second and third may reuse a warm
 * connection and read faster than a first visit would. The median is therefore
 * a fair measure of a repeat visitor's experience and a slightly optimistic
 * one of a first-time visitor's.
 *
 * NOTHING AI TOUCHES THIS. It is measured by fixed code and graded, if it ever
 * is, by fixed rules. No model sees it before it is measured and none can
 * change it afterwards.
 */
import { normalizeUrl } from "./url.ts";
import { checkHostnameIsPublic } from "./safety.ts";
import { createDeadline, type Deadline } from "./deadline.ts";
import type { ResponseTimeFailure, ResponseTimeMeasurement, ResponseTimeSample } from "@/lib/types";

/** How many timings are taken. Not configurable: the median assumes three. */
export const RESPONSE_TIME_SAMPLES = 3;

/** How long one sample may take before it counts as a timeout. */
export const RESPONSE_TIME_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The whole measurement's own budget, when no audit clock is supplied.
 *
 * Three requests at ten seconds each, and nothing more. A caller inside an
 * audit passes the audit's deadline instead and this is never used.
 */
export const RESPONSE_TIME_BUDGET_MS =
  RESPONSE_TIME_SAMPLES * RESPONSE_TIME_REQUEST_TIMEOUT_MS;

/** Identifies this tool honestly, exactly as the page fetcher does. */
const USER_AGENT = "SkybookAuditBot/1.0 (+website audit tool)";

export interface ResponseTimeOptions {
  /**
   * The audit's shared clock. Time spent here is time the later checks no
   * longer have, which is the point of there being one.
   */
  readonly deadline?: Deadline;
  /**
   * A monotonic clock, in milliseconds. Injected by tests.
   *
   * DELIBERATELY NOT `Date.now`. This is a duration, and the wall clock can be
   * stepped backwards by an NTP correction between two readings -- which would
   * produce a negative response time, and a median computed from one.
   */
  readonly now?: () => number;
  /** The request function. Injected by tests so none of them reach a network. */
  readonly fetchImpl?: typeof fetch;
}

/** Sentences a person can read. Fixed text, never an exception's own message. */
const MESSAGES: Record<ResponseTimeFailure, string> = {
  "invalid-address": "That address could not be read, so response time was not measured.",
  refused: "That address could not be checked safely, so response time was not measured.",
  "out-of-time": "The audit ran out of time before response time could be measured.",
  timeout: "The server did not start answering quickly enough to be timed.",
  network: "The server could not be reached, so response time was not measured.",
  incomplete: "The server did not answer every time, so no median could be taken.",
};

function unavailable(
  failure: ResponseTimeFailure,
  samples: readonly ResponseTimeSample[],
): ResponseTimeMeasurement {
  return {
    status: "unavailable",
    /*
     * NULL, NEVER ZERO. Zero milliseconds is a measurement, and an impossibly
     * good one; it would sit in a report as the fastest server ever audited.
     * A failure has no number, and this says so.
     */
    medianResponseTimeMs: null,
    attempted: samples.length,
    succeeded: 0,
    samples,
    failure,
    message: MESSAGES[failure],
  };
}

/**
 * The middle value of three numbers.
 *
 * Sorted numerically and taken from the centre. `sort()` without a comparator
 * sorts as text, which puts 1000 before 200, and that is exactly the sort of
 * quiet wrongness a median hides well.
 *
 * Exported so the arithmetic can be tested on its own, without a network.
 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Even-length input is not produced here -- three samples are always taken
  // and a median is only offered when all three succeeded -- but a helper that
  // silently returned the wrong one of the two middles would be worse.
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** What went wrong with one request, in the vocabulary the result uses. */
function classify(error: unknown): ResponseTimeFailure {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "network";
}

/**
 * Takes one timing.
 *
 * REDIRECTS ARE NOT FOLLOWED. `redirect: "manual"` means a 3xx is a response
 * like any other: the server answered, and how fast it answered is the thing
 * being measured. Not following one also means this module has no redirect
 * machinery to get wrong -- the audit already resolved the final address, hop
 * by hop, with the safety check applied to every one of them.
 *
 * ANY STATUS IS A SUCCESSFUL SAMPLE, for the same reason the uptime check
 * treats one that way. A 404 is a server answering promptly; whether it
 * answered usefully is a different measurement entirely.
 */
async function takeSample(
  url: URL,
  deadline: Deadline,
  now: () => number,
  request: typeof fetch,
): Promise<ResponseTimeSample> {
  if (deadline.expired()) return { ok: false, ms: null, failure: "out-of-time" };

  const startedAt = now();

  let response: Response;
  try {
    response = await request(url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      // Whichever is shorter: this sample's own cap, or what is left of the
      // audit's shared budget. The same rule every other request follows.
      signal: deadline.signal(RESPONSE_TIME_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, ms: null, failure: classify(error) };
  }

  /*
   * STOPPED HERE, BEFORE A SINGLE BYTE OF BODY IS READ. `fetch` resolves when
   * the headers arrive, so this is time to first byte and nothing else.
   */
  const elapsed = Math.max(0, Math.round(now() - startedAt));

  /*
   * The body is thrown away rather than read. It frees the socket, and it is
   * why no response-size limit applies here: nothing is downloaded to limit.
   * A cancel that throws is not a measurement problem -- the timing above
   * already happened -- so it is swallowed rather than allowed to discard it.
   */
  try {
    await response.body?.cancel();
  } catch {
    /* The reading end is already gone. Nothing to release. */
  }

  return { ok: true, ms: elapsed, failure: null };
}

/**
 * Measures how quickly one address starts answering.
 *
 * REUSES EVERY EXISTING PROTECTION AND BYPASSES NONE. The address goes through
 * the audit's own parser, which is what refuses a `javascript:` or `file:`
 * address; its hostname goes through the public-host check, which is what
 * refuses a private or loopback address; every request is bounded by the
 * shared deadline and by its own cap.
 *
 * A MEDIAN IS OFFERED ONLY WHEN ALL THREE SAMPLES SUCCEEDED. Two timings have
 * a mean, not a median, and one timing is just itself; presenting either as
 * "the median of three samples" would describe a measurement that never
 * happened. Fewer than three is reported as unavailable, with the counts and
 * the reason stated, which is the truthful answer and the one a reader can act
 * on.
 */
export async function measureResponseTime(
  rawUrl: string,
  options: ResponseTimeOptions = {},
): Promise<ResponseTimeMeasurement> {
  const deadline = options.deadline ?? createDeadline(RESPONSE_TIME_BUDGET_MS);
  const now = options.now ?? (() => performance.now());
  const request = options.fetchImpl ?? fetch;

  const normalized = normalizeUrl(rawUrl);
  if (!normalized.ok) return unavailable("invalid-address", []);

  if (deadline.expired()) return unavailable("out-of-time", []);

  const safety = await checkHostnameIsPublic(normalized.url.hostname);
  if (!safety.safe) return unavailable("refused", []);

  /*
   * SEQUENTIAL, NOT PARALLEL. Three requests at once contend with each other
   * and with the crawl, so the numbers would measure our own concurrency as
   * much as the server's speed. One after another also means the deadline
   * stops the third sample rather than being spent on all three at once.
   */
  const samples: ResponseTimeSample[] = [];
  for (let index = 0; index < RESPONSE_TIME_SAMPLES; index += 1) {
    samples.push(await takeSample(normalized.url, deadline, now, request));
  }

  const succeeded = samples.filter((sample) => sample.ok);

  if (succeeded.length < RESPONSE_TIME_SAMPLES) {
    /*
     * The reason is the first failure's own, so "the audit ran out of time"
     * and "the server timed out" stay apart -- they call for different things
     * from whoever reads the report. A mixture of successes and failures is
     * "incomplete", which says exactly what happened.
     */
    const firstFailure = samples.find((sample) => !sample.ok)?.failure ?? "incomplete";
    const failure = succeeded.length > 0 ? "incomplete" : firstFailure;

    return {
      ...unavailable(failure, samples),
      succeeded: succeeded.length,
      // The timings that did arrive are kept. They are real measurements, and
      // dropping them would hide that the server answered at all.
      message:
        succeeded.length > 0
          ? `${MESSAGES.incomplete} ${succeeded.length} of ${RESPONSE_TIME_SAMPLES} requests were answered.`
          : MESSAGES[failure],
    };
  }

  const timings = succeeded.map((sample) => sample.ms as number);

  return {
    status: "measured",
    medianResponseTimeMs: medianOf(timings),
    attempted: samples.length,
    succeeded: succeeded.length,
    samples,
    failure: null,
    message: `The server started answering in ${medianOf(timings)} ms, the middle of ${RESPONSE_TIME_SAMPLES} timed requests.`,
  };
}
