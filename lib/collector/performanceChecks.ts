/**
 * How fast the site is, according to Google PageSpeed Insights.
 *
 * WHY AN EXTERNAL API: measuring real page speed means loading the page in a
 * real browser engine and watching what paints when. We cannot do that from a
 * plain HTTP fetch, and running Lighthouse ourselves would mean shipping a
 * headless Chrome — a very large dependency for an intern project. Google
 * already runs it, and their numbers are the ones the client's search ranking
 * actually depends on.
 *
 * WHY IT IS OPT-IN: one call takes anywhere from ten to forty seconds, which
 * is longer than every other check in this audit put together. Making it
 * automatic would make every audit feel broken.
 *
 * TWO KINDS OF NUMBER, KEPT APART: `field` is what real visitors experienced
 * over the last 28 days. `lab` is one simulated load in Google's datacentre.
 * They frequently disagree, and merging them would produce a report that
 * cannot be checked against anything. Field data is the truth about the site;
 * lab data helps explain it.
 *
 * PRIVACY: this sends the prospect's URL to Google. Nothing else about them is
 * sent, and the URL is public anyway, but it does leave our machine.
 */
import type { Deadline } from "./deadline";
import type {
  FieldPerformance,
  FieldShiftMetric,
  FieldTimeMetric,
  LabPerformance,
  PerformanceData,
  PerformanceFailureReason,
  PerformanceRating,
} from "../types";

/**
 * Google's endpoint. Hardcoded on purpose.
 *
 * The site being audited is attacker-controlled, so it must never influence
 * WHERE we send a request — it only ever travels as a query parameter to this
 * fixed address. That is why this check does not need `safeFetch`: the host is
 * a constant, so there is no address for an attacker to point us at.
 */
export const PAGESPEED_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * The longest we will wait for Google.
 *
 * MEASURED, NOT GUESSED: 30s was tried first and was far too short. Timing
 * real calls gave 7.5s for example.com but 42s for bbc.co.uk, so every large
 * site — exactly the kind of prospect worth auditing — failed while small ones
 * passed. 60s was better and still not enough: bbc.co.uk came back at 27, 42,
 * 53 and 55 seconds on different runs, and hit the cap on roughly one run in
 * three.
 *
 * RAISED TO 90s ONCE THE CHECK STOPPED BLOCKING THE AUDIT. While the audit
 * waited for Google, a longer cap meant a longer dead page, and 60s was the
 * honest trade. Now the audit returns in its own 30 seconds and the results
 * are on screen and readable while this runs, so the cost of waiting longer is
 * a spinner in one panel — cheap enough to buy the heavy sites a real chance.
 *
 * Still a cap. Without one this single request would run until the endpoint's
 * own budget stopped it, with a vaguer error to show for it.
 */
export const PAGESPEED_TIMEOUT_MS = 90_000;

/**
 * Real visitors' CLS arrives as a whole number that is 100x the real score:
 * a score of 0.10 comes back as 10. Reported unscaled it would look like a
 * catastrophic layout problem on a perfectly stable page.
 */
const CLS_PERCENTILE_SCALE = 100;

/** Lighthouse scores a category from 0 to 1. Reports show 0 to 100. */
const LIGHTHOUSE_SCORE_SCALE = 100;

/**
 * The most of Google's reply we are willing to hold in memory.
 *
 * These replies are big — a real bbc.co.uk response measured 1.42 MB, because
 * Lighthouse returns every audit it ran. 10 MB leaves a wide margin over that
 * while still being a bound: `response.json()` on its own would read whatever
 * arrived, however much that turned out to be. The page fetch has capped its
 * own reads since Step 1 for the same reason; this closes the one place that
 * did not.
 */
export const MAX_PAGESPEED_BYTES = 10_000_000; // 10 MB

/**
 * How long to wait before the single retry.
 *
 * Long enough to let a momentary fault at Google's end pass, short enough that
 * it is noise against a check that takes tens of seconds. The retry spends the
 * audit's own budget, so this is deliberately small.
 */
export const RETRY_DELAY_MS = 300;

/**
 * The time a retry needs left on the clock to be worth attempting.
 *
 * With two seconds remaining the second attempt would fail on the deadline and
 * relabel a server error as a timeout — a worse answer than the honest one we
 * already have.
 */
const MIN_RETRY_BUDGET_MS = 5_000;

export interface PerformanceOptions {
  /** Defaults to PAGESPEED_API_KEY from the environment. */
  apiKey?: string;
  /** Swapped out by tests so they never touch the network. */
  fetchImpl?: typeof fetch;
  /** Swapped out by tests. */
  endpoint?: string;
  /**
   * Swapped out by tests, so an over-size case can be proved without building
   * a ten-megabyte fixture. Defaults to MAX_PAGESPEED_BYTES.
   */
  maxBytes?: number;
  /**
   * Swapped out by tests so retry cases do not each cost a real pause.
   * Defaults to RETRY_DELAY_MS.
   */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Small readers
//
// Every one of these returns null rather than throwing or guessing. The API is
// outside our control, so any field may be missing or a different type than we
// expect, and a wrong number in a client report is worse than a blank one.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a thrown error is our own clock running out.
 *
 * Used for both the connection and the body read, so a timeout is classified
 * the same way wherever in the request it happens. `AbortSignal.timeout` throws
 * TimeoutError; an abort from elsewhere throws AbortError.
 */
export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/** What came back from reading the body, and if nothing, why not. */
type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "timeout" | "response-too-large" | "unreadable-response" };

/**
 * Reads the reply in pieces, stopping if it grows past `maxBytes`.
 *
 * WHY NOT REUSE readCapped FROM fetchPage/technicalChecks: those return null
 * for both "too big" and "the read failed", because neither caller needed to
 * tell them apart. Here that distinction is the whole point — a reply that was
 * too large, a read that timed out, and a reply full of nonsense each mean
 * something different to whoever reads the report, and each calls for a
 * different fix. So this one returns the reason.
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<BodyRead> {
  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        // Abandoned mid-stream. Nothing over the limit is ever parsed, or even
        // fully received.
        await reader.cancel();
        return { ok: false, reason: "response-too-large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    /*
     * The abort signal covers the body stream, not just the connection, so a
     * slow reply lands here rather than at the fetch. Reporting this as an
     * unreadable response would name the wrong culprit: Google's answer was
     * fine, we simply stopped waiting for it.
     */
    return { ok: false, reason: isTimeoutError(error) ? "timeout" : "unreadable-response" };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(merged) };
}

/**
 * Whether two addresses point at the same place.
 *
 * Compared as URLs rather than as text, so that "https://example.com" and
 * "https://example.com/" do not read as a redirect. Announcing a redirect that
 * never happened would be its own small false finding.
 */
export function sameAddress(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** A URL from Google's reply, or null when it is missing or blank. */
function readUrl(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The address Google's test browser actually loaded.
 *
 * `lighthouseResult.finalUrl` only, and it describes the LAB run alone. There
 * is deliberately no fallback to the field block's address: the two are
 * separate statements by Google about separate measurements, and borrowing one
 * to label the other turns a guess into an apparent fact.
 */
export function readLabUrl(body: unknown): string | null {
  return readUrl(readObject(body, "lighthouseResult")?.finalUrl);
}

/**
 * The address the real-visitor figures belong to.
 *
 * Taken from whichever field block we actually read — `loadingExperience.id`
 * for page-level data, `originLoadingExperience.id` for site-level. Never the
 * lab run's final URL, and never the requested address.
 */
export function readFieldUrl(source: unknown): string | null {
  return isObject(source) ? readUrl(source.id) : null;
}

function readObject(parent: unknown, key: string): Json | null {
  if (!isObject(parent)) return null;
  const value = parent[key];
  return isObject(value) ? value : null;
}

/** Accepts a number, or a string holding one — the API has used both. */
function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const RATINGS = new Set<string>(["FAST", "AVERAGE", "SLOW"]);

/**
 * Google's own verdict, passed through untouched.
 *
 * We deliberately do not apply our own thresholds. Google moves them — INP
 * replaced FID outright in 2024 — and a hardcoded copy would quietly start
 * disagreeing with the client's own Search Console.
 */
export function readRating(value: unknown): PerformanceRating | null {
  return typeof value === "string" && RATINGS.has(value)
    ? (value as PerformanceRating)
    : null;
}

/** A timing metric. Both halves must be present, or we report nothing. */
export function readTimeMetric(metrics: unknown, key: string): FieldTimeMetric | null {
  const metric = readObject(metrics, key);
  if (!metric) return null;
  const percentileMs = readNumber(metric.percentile);
  const category = readRating(metric.category);
  if (percentileMs === null || category === null) return null;
  return { percentileMs, category };
}

export function readShiftMetric(metrics: unknown, key: string): FieldShiftMetric | null {
  const metric = readObject(metrics, key);
  if (!metric) return null;
  const raw = readNumber(metric.percentile);
  const category = readRating(metric.category);
  if (raw === null || category === null) return null;
  return { percentile: raw / CLS_PERCENTILE_SCALE, category };
}

function readAuditNumber(audits: unknown, key: string): number | null {
  const audit = readObject(audits, key);
  return audit ? readNumber(audit.numericValue) : null;
}

/**
 * Whether the body is a PageSpeed result at all.
 *
 * This guard is the difference between "Google has too little traffic for this
 * page" and "we could not read Google's answer". Without it, an empty or
 * mangled response would parse as a site with no visitors — a false finding
 * stated with total confidence.
 */
export function looksLikePagespeedResult(body: unknown): boolean {
  if (!isObject(body)) return false;
  return (
    "lighthouseResult" in body ||
    "loadingExperience" in body ||
    "originLoadingExperience" in body
  );
}

// ---------------------------------------------------------------------------
// Field data — what real visitors experienced
// ---------------------------------------------------------------------------

function emptyField(
  status: FieldPerformance["status"],
  error: string | null,
): FieldPerformance {
  return {
    status,
    measuredUrl: null,
    scope: null,
    overall: null,
    lcp: null,
    inp: null,
    cls: null,
    fcp: null,
    ttfb: null,
    error,
  };
}

export function readFieldData(body: unknown): FieldPerformance {
  if (!looksLikePagespeedResult(body)) {
    return emptyField("error", "Google's reply could not be read.");
  }

  const root = body as Json;
  const page = readObject(root, "loadingExperience");
  const origin = readObject(root, "originLoadingExperience");

  /*
   * Which set of numbers are these?
   *
   * When one page has too few visitors of its own, Google silently answers
   * with the whole site's figures and sets `origin_fallback`. Reporting those
   * as this page's data would be wrong, so the scope is recorded alongside
   * them and the report can say which it is.
   */
  let source: Json | null = null;
  let scope: "page" | "origin" | null = null;

  if (page && readObject(page, "metrics")) {
    source = page;
    scope = page.origin_fallback === true ? "origin" : "page";
  } else if (origin && readObject(origin, "metrics")) {
    source = origin;
    scope = "origin";
  }

  if (!source || !scope) {
    /*
     * No field data. That means TOO FEW VISITORS for Google to report on
     * anonymously — it is not a speed problem, and it is very common on the
     * small business sites this tool is aimed at. "absent", never "slow".
     */
    return emptyField("absent", null);
  }

  const metrics = readObject(source, "metrics");

  return {
    status: "found",
    // Read from the block we actually used, so page data is labelled with the
    // page address and origin data with the origin address.
    measuredUrl: readFieldUrl(source),
    scope,
    overall: readRating(source.overall_category),
    lcp: readTimeMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS"),
    inp: readTimeMetric(metrics, "INTERACTION_TO_NEXT_PAINT"),
    cls: readShiftMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE"),
    fcp: readTimeMetric(metrics, "FIRST_CONTENTFUL_PAINT_MS"),
    ttfb: readTimeMetric(metrics, "EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Lab data — one simulated load
// ---------------------------------------------------------------------------

function emptyLab(error: string): LabPerformance {
  return {
    status: "error",
    // A run that produced no measurements measured no address. Reporting the
    // URL it tried would say Google measured something it did not.
    measuredUrl: null,
    score: null,
    lcpMs: null,
    fcpMs: null,
    tbtMs: null,
    speedIndexMs: null,
    cls: null,
    error,
  };
}

export function readLabData(body: unknown): LabPerformance {
  const lighthouse = readObject(body, "lighthouseResult");
  if (!lighthouse) {
    return emptyLab("Google did not return a lab result for this page.");
  }

  /*
   * Lighthouse reports its own failures inside an otherwise successful HTTP
   * response. A site that blocks automated browsers lands here, and the run
   * contains no usable numbers — so this is an error, not a set of zeroes.
   */
  const runtimeError = readObject(lighthouse, "runtimeError");
  if (runtimeError) {
    const message =
      typeof runtimeError.message === "string" && runtimeError.message.trim() !== ""
        ? runtimeError.message.trim()
        : "Google's test browser could not load the page.";
    return emptyLab(message);
  }

  const audits = readObject(lighthouse, "audits");
  const performance = readObject(readObject(lighthouse, "categories"), "performance");
  const rawScore = performance ? readNumber(performance.score) : null;

  const lab: LabPerformance = {
    status: "found",
    measuredUrl: readLabUrl(body),
    score: rawScore === null ? null : Math.round(rawScore * LIGHTHOUSE_SCORE_SCALE),
    lcpMs: readAuditNumber(audits, "largest-contentful-paint"),
    fcpMs: readAuditNumber(audits, "first-contentful-paint"),
    tbtMs: readAuditNumber(audits, "total-blocking-time"),
    speedIndexMs: readAuditNumber(audits, "speed-index"),
    cls: readAuditNumber(audits, "cumulative-layout-shift"),
    error: null,
  };

  // A lighthouseResult holding nothing we can use is a failure to read, not a
  // page that scored nothing.
  const gotSomething =
    lab.score !== null ||
    lab.lcpMs !== null ||
    lab.fcpMs !== null ||
    lab.tbtMs !== null ||
    lab.speedIndexMs !== null ||
    lab.cls !== null;

  return gotSomething
    ? lab
    : emptyLab("Google's lab result contained no measurements we could read.");
}

// ---------------------------------------------------------------------------
// Assembling the result
// ---------------------------------------------------------------------------

/** What goes in the report when nobody asked for a speed check. */
export function performanceNotRequested(requestedUrl: string): PerformanceData {
  const message =
    "Speed was not measured. The PageSpeed check is optional because it can take up to 90 seconds and uses a limited Google quota.";
  return {
    status: "not-requested",
    strategy: "mobile",
    requestedUrl,
    failureReason: null,
    // "error", not "absent": we did not learn that this site has few visitors,
    // we simply never looked.
    field: emptyField("error", message),
    lab: emptyLab(message),
    notInspected: [
      "Page speed and Core Web Vitals — the speed check was not requested for this audit.",
    ],
    message,
  };
}

/**
 * The placeholder the main audit returns while the speed check runs elsewhere.
 *
 * The audit no longer waits for Google: it finishes in its usual thirty
 * seconds and says "pending" here, and the browser fetches the real answer
 * from /api/audit/performance separately.
 *
 * Both halves report status "error" with an explanation, exactly as
 * performanceNotRequested does, because nothing has been measured. A pending
 * section must never read as a measurement — least of all as a good one.
 */
export function performancePending(requestedUrl: string): PerformanceData {
  const message =
    "Performance analysis is running separately so the rest of the audit does not have to wait for it.";
  return {
    status: "pending",
    strategy: "mobile",
    requestedUrl,
    failureReason: null,
    field: emptyField("error", message),
    lab: emptyLab(message),
    notInspected: [
      "Page speed and Core Web Vitals — the speed check has not returned yet.",
    ],
    message,
  };
}

/**
 * A speed section that records why there are no numbers in it.
 *
 * Exported so the route can use it as a last-resort catch: this module is
 * written not to throw, and that guard makes it true even if a future change
 * breaks the promise.
 */
export function performanceUnavailable(
  requestedUrl: string,
  message: string,
): PerformanceData {
  /*
   * "internal-error", never "unreadable-response". This path means the check
   * itself broke, which is our fault — labelling it as a bad reply from Google
   * would pin our bug on them, and the whole point of failureReason is that it
   * agrees with the English beside it.
   */
  return failed(requestedUrl, "error", "internal-error", message);
}

function failed(
  requestedUrl: string,
  status: "no-api-key" | "error",
  failureReason: PerformanceFailureReason,
  message: string,
): PerformanceData {
  return {
    status,
    strategy: "mobile",
    requestedUrl,
    failureReason,
    field: emptyField("error", message),
    lab: emptyLab(message),
    notInspected: [
      "Page speed and Core Web Vitals — the speed check could not complete.",
    ],
    message,
  };
}

/**
 * The five real-visitor metrics, with the names a reader would recognise.
 *
 * Used to say which ones Google left out. Everywhere else in this audit a null
 * is spelled out rather than left as a blank, and these were the last nulls
 * that were not.
 */
const FIELD_METRICS = [
  { key: "lcp", label: "Largest Contentful Paint (LCP)" },
  { key: "inp", label: "Interaction to Next Paint (INP)" },
  { key: "cls", label: "Cumulative Layout Shift (CLS)" },
  { key: "fcp", label: "First Contentful Paint (FCP)" },
  { key: "ttfb", label: "Time to First Byte (TTFB)" },
] as const;

/**
 * The real-visitor metrics Google did not return, named one by one.
 *
 * Only meaningful when the field section itself is sound: if there is no field
 * data at all, that is already said once and listing five missing metrics
 * underneath would be noise.
 */
export function missingFieldMetrics(field: FieldPerformance): string[] {
  if (field.status !== "found") return [];
  return FIELD_METRICS.filter((metric) => field[metric.key] === null).map(
    (metric) =>
      `${metric.label} — Google did not report this metric for this address. That is a missing figure, not a poor one.`,
  );
}

/**
 * Names the address a section's figures belong to, for use mid-sentence.
 *
 * Origin-level field data covers a whole site, so it is never described as a
 * page — that single word is the difference between a true statement and a
 * claim about a page Google never measured on its own.
 */
function describeFieldSubject(field: FieldPerformance): string {
  if (field.scope === "origin") {
    return field.measuredUrl
      ? `the wider site at ${field.measuredUrl}`
      : "the wider site";
  }
  return field.measuredUrl ? `the page at ${field.measuredUrl}` : "this page";
}

function notInspectedFor(
  field: FieldPerformance,
  lab: LabPerformance,
  requestedUrl: string,
): string[] {
  const notes = [
    "Desktop speed — only the mobile experience was tested.",
    "Every page except the one tested.",
  ];

  /*
   * Google follows redirects we did not, so the figures above can belong to a
   * different address — sometimes a different domain. Each section names its
   * own address, and this says plainly that the requested one was not it.
   */
  const labMoved = lab.measuredUrl !== null && !sameAddress(requestedUrl, lab.measuredUrl);
  const fieldMoved =
    field.measuredUrl !== null && !sameAddress(requestedUrl, field.measuredUrl);
  const bothLandedTogether =
    labMoved && fieldMoved && sameAddress(lab.measuredUrl!, field.measuredUrl!);

  if (bothLandedTogether) {
    notes.push(
      `${requestedUrl} itself — it redirects, and Google measured ${lab.measuredUrl} instead. Every figure above describes that address, not the one requested.`,
    );
  } else {
    // Named separately, because when the two halves disagree, saying "Google
    // measured X" would be true of one section and false of the other.
    if (labMoved) {
      notes.push(
        `${requestedUrl} as the simulation loaded it — it redirects, so the simulated figures describe ${lab.measuredUrl}.`,
      );
    }
    if (fieldMoved) {
      notes.push(
        `${requestedUrl} as Google records it — the real-visitor figures are held under ${field.measuredUrl}.`,
      );
    }
  }

  if (field.status === "absent") {
    notes.push(
      "Real visitor speed — Google has too few recent visits to this address to report on. This says nothing about how fast the site is.",
    );
  }

  /*
   * The single most misleading thing this section could do is let site-wide
   * figures pass as figures for the page a salesperson typed in.
   */
  if (field.status === "found" && field.scope === "origin") {
    notes.push(
      "Real visitor speed for this exact page — Google has too little traffic for this page alone, so the real-visitor figures above cover the whole site instead. They are not a measurement of the requested page.",
    );
  }

  // Each metric Google omitted, named. A blank in a report is otherwise
  // indistinguishable from a measurement of nothing.
  notes.push(...missingFieldMetrics(field));

  if (field.status === "found" && field.measuredUrl === null) {
    notes.push(
      "Which address the real-visitor figures belong to — Google's reply did not say.",
    );
  }
  if (lab.status === "found" && lab.measuredUrl === null) {
    notes.push("Which address the simulated load used — Google's reply did not say.");
  }

  if (lab.status === "error") {
    notes.push("The simulated page load — Google's test run did not produce results.");
  }

  return notes;
}

function summarise(
  field: FieldPerformance,
  lab: LabPerformance,
  requestedUrl: string,
): string {
  const parts: string[] = [];

  /*
   * Real visitors first, because that is what Google ranks on.
   *
   * Each branch names its own subject rather than inheriting one, so an
   * origin-level answer can never be read as a page-level one — and the lab
   * run's address never leaks in here.
   */
  if (field.status === "found") {
    const subject = describeFieldSubject(field);
    const rating = field.overall ? ` as ${field.overall}` : "";

    if (field.scope === "origin") {
      const rated = field.overall ? ` Google rates that ${field.overall}.` : "";
      parts.push(
        `Google has too little real-visitor data for this page on its own, so it reports on ${subject} instead.${rated} Those figures describe the site as a whole, not the requested page.`,
      );
    } else if (field.overall) {
      parts.push(`Google rates the real-visitor experience of ${subject}${rating}.`);
    } else {
      parts.push(`Google returned real-visitor data for ${subject}.`);
    }
  } else if (field.status === "absent") {
    parts.push(
      "Google has no real-visitor data for this address, which means too few recent visits to report on — not a speed problem.",
    );
  } else {
    parts.push("Real-visitor data could not be read.");
  }

  // The simulation, named separately and never blended with the above.
  const labWhere = lab.measuredUrl ? ` of ${lab.measuredUrl}` : "";
  if (lab.status === "found" && lab.score !== null) {
    parts.push(`A simulated mobile load${labWhere} scored ${lab.score} out of 100.`);
  } else if (lab.status === "found") {
    parts.push(
      `A simulated mobile load${labWhere} completed, but returned no overall score.`,
    );
  } else {
    parts.push("The simulated load did not complete.");
  }

  // Said last so it qualifies figures the reader has already seen labelled.
  if (lab.measuredUrl && !sameAddress(requestedUrl, lab.measuredUrl)) {
    parts.push(`${requestedUrl} redirects to ${lab.measuredUrl}.`);
  }

  return parts.join(" ");
}

/**
 * Turns a failed request into something a person can read.
 *
 * Each case says what we do and do not know, because "could not check speed"
 * and "the site is slow" must never look the same in a report.
 */
export const TIMEOUT_MESSAGE =
  "Speed was not measured: Google's speed test did not finish in the time allowed.";

/**
 * Classifies a failed request.
 *
 * A timeout is reported identically whether it happened while connecting,
 * while waiting, or while reading the reply — it is the same fact about the
 * same clock, and splitting it would suggest three different problems.
 */
export function classifyRequestError(error: unknown): {
  reason: PerformanceFailureReason;
  message: string;
} {
  if (isTimeoutError(error)) {
    return { reason: "timeout", message: TIMEOUT_MESSAGE };
  }
  return {
    reason: "network",
    message: "Speed was not measured: Google's speed service could not be reached.",
  };
}

export function describeRequestError(error: unknown): string {
  return classifyRequestError(error).message;
}

/** Pulls Google's own explanation out of an error response, when there is one. */
export function describeApiError(status: number, body: unknown): string {
  const error = readObject(body, "error");
  const detail =
    error && typeof error.message === "string" && error.message.trim() !== ""
      ? error.message.trim()
      : null;

  const headline =
    status === 429
      ? "Google's speed service refused the request because its usage limit was reached"
      : status === 400
        ? "Google's speed service rejected this address"
        : status === 403
          ? "Google's speed service refused the API key"
          : `Google's speed service returned an error (${status})`;

  return detail
    ? `Speed was not measured: ${headline} — ${detail}`
    : `Speed was not measured: ${headline}.`;
}

/**
 * Whether an HTTP status is worth one more try.
 *
 * 5xx only. Google's speed service fails this way fairly often and for no
 * reason to do with the site — "Lighthouse returned error: Something went
 * wrong" and Chrome protocol errors both arrive as 500, and the same address
 * usually succeeds moments later.
 *
 * Everything else is deliberately excluded. A 400 means the address is wrong,
 * a 403 means the key is wrong, and a 429 means we are over quota — asking
 * again changes none of those, and in the 429 case actively makes it worse.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** One request, read and classified. `retryable` covers only transient faults. */
type PagespeedAttempt =
  | { ok: true; body: unknown }
  | { ok: false; failure: PerformanceData; retryable: boolean };

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether there is enough of the audit left to be worth a second attempt.
 *
 * A retry with two seconds left would fail on the clock and simply relabel a
 * server error as a timeout, which is worse than the honest first answer.
 */
function hasTimeToRetry(deadline: Deadline, delayMs: number): boolean {
  return deadline.remainingMs() > delayMs + MIN_RETRY_BUDGET_MS;
}

/**
 * Makes one request and reads the answer.
 *
 * Split out so the retry is genuinely the same request run twice, rather than
 * a second code path that could drift away from the first.
 */
async function attemptPagespeed(
  requestedUrl: string,
  requestUrl: string,
  deadline: Deadline,
  doFetch: typeof fetch,
  maxBytes: number,
): Promise<PagespeedAttempt> {
  let response: Response;
  try {
    response = await doFetch(requestUrl, {
      /*
       * Derived from the SHARED deadline every time, so a second attempt gets
       * whatever the first one left and never a fresh 90 seconds. This is why
       * the retry needs no clock of its own.
       */
      signal: deadline.signal(PAGESPEED_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const { reason, message } = classifyRequestError(error);
    /*
     * Not retryable. A timeout says our clock ran out, and an unreachable
     * service says the network is down — neither is a transient fault at
     * Google's end, and trying again would only spend more of the audit
     * before giving the same answer.
     */
    return {
      ok: false,
      failure: failed(requestedUrl, "error", reason, message),
      retryable: false,
    };
  }

  // Read the body even on failure: Google explains its refusals in there, and
  // "quota exceeded" is far more useful to us than the bare number 429.
  const read = await readCappedBody(response, maxBytes);

  if (!read.ok) {
    /*
     * An error status is the more useful thing to report when we have one, so
     * a 429 whose body we could not read still says "quota" rather than
     * "unreadable".
     */
    if (!response.ok) {
      return {
        ok: false,
        failure: failed(
          requestedUrl,
          "error",
          "api-error",
          describeApiError(response.status, null),
        ),
        retryable: isRetryableStatus(response.status),
      };
    }
    return {
      ok: false,
      failure: failed(
        requestedUrl,
        "error",
        read.reason,
        read.reason === "timeout"
          ? TIMEOUT_MESSAGE
          : read.reason === "response-too-large"
            ? "Speed was not measured: Google's reply was larger than this tool will read."
            : "Speed was not measured: Google's reply could not be read.",
      ),
      retryable: false,
    };
  }

  let body: unknown = null;
  let parsed = true;
  try {
    body = JSON.parse(read.text);
  } catch {
    parsed = false;
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: failed(
        requestedUrl,
        "error",
        "api-error",
        describeApiError(response.status, parsed ? body : null),
      ),
      retryable: isRetryableStatus(response.status),
    };
  }

  if (!parsed) {
    // Google answered successfully with something that is not PageSpeed data.
    // A second identical request has no reason to answer differently.
    return {
      ok: false,
      failure: failed(
        requestedUrl,
        "error",
        "unreadable-response",
        "Speed was not measured: Google's reply was not readable data.",
      ),
      retryable: false,
    };
  }

  return { ok: true, body };
}

/**
 * Runs the speed check.
 *
 * Never throws: every failure becomes a PerformanceData whose status explains
 * itself, so one unreachable third party can never cost us the rest of an
 * audit.
 */
export async function runPerformanceChecks(
  requestedUrl: string,
  deadline: Deadline,
  options: PerformanceOptions = {},
): Promise<PerformanceData> {
  const apiKey = (options.apiKey ?? process.env.PAGESPEED_API_KEY ?? "").trim();

  /*
   * The key is required, not optional. Google used to allow a small number of
   * unkeyed requests; as of testing, an unkeyed call returns 429 with a daily
   * quota of zero. Checking here means we say so plainly instead of passing on
   * a confusing rate-limit message from Google.
   */
  if (apiKey === "") {
    return failed(
      requestedUrl,
      "no-api-key",
      "no-api-key",
      "Speed was not measured: no PageSpeed API key is configured on the server.",
    );
  }

  if (deadline.expired()) {
    return failed(
      requestedUrl,
      "error",
      "out-of-time",
      "Speed was not measured: the audit ran out of time before the speed check could start.",
    );
  }

  const endpoint = options.endpoint ?? PAGESPEED_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_PAGESPEED_BYTES;

  // URLSearchParams escapes the address for us. Building this string by hand
  // is how an address containing "&" turns into a different request.
  const params = new URLSearchParams({
    url: requestedUrl,
    strategy: "mobile",
    category: "performance",
    key: apiKey,
  });

  const requestUrl = `${endpoint}?${params.toString()}`;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  let attempt = await attemptPagespeed(requestedUrl, requestUrl, deadline, doFetch, maxBytes);

  /*
   * One retry. Not a loop — an `if`, so there can never be a third request no
   * matter how the conditions are edited later.
   *
   * Google's speed service returns 500 for reasons that have nothing to do
   * with the site being audited, and the same address usually succeeds a
   * moment later. Without this a salesperson sees a failed speed check on a
   * site that is perfectly fine.
   *
   * A retry that succeeds is not marked or flagged: the result is a normal
   * measurement, because that is exactly what it is.
   */
  if (!attempt.ok && attempt.retryable && hasTimeToRetry(deadline, retryDelayMs)) {
    await pause(retryDelayMs);
    attempt = await attemptPagespeed(requestedUrl, requestUrl, deadline, doFetch, maxBytes);
  }

  if (!attempt.ok) return attempt.failure;

  const body = attempt.body;

  // Each half carries its own address, read from its own part of the reply.
  const field = readFieldData(body);
  const lab = readLabData(body);

  /*
   * If neither half yielded anything, the call succeeded but told us nothing.
   * Calling that "checked" would present two empty sections as a completed
   * measurement.
   */
  if (field.status === "error" && lab.status === "error") {
    return failed(
      requestedUrl,
      "error",
      "unreadable-response",
      "Speed was not measured: Google's reply could not be read.",
    );
  }

  return {
    status: "checked",
    strategy: "mobile",
    requestedUrl,
    failureReason: null,
    field,
    lab,
    notInspected: notInspectedFor(field, lab, requestedUrl),
    message: summarise(field, lab, requestedUrl),
  };
}
