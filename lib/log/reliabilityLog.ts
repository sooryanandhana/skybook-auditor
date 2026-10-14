/**
 * The reliability log: one line saying how an operation ended, and nothing else.
 *
 * WHY IT EXISTS. A report once went out with no written commentary and there
 * was no way to tell why: the model may have timed out, been refused, or simply
 * not have answered yet. The application knew, and wrote it down nowhere. This
 * file is where it now writes it down.
 *
 * WHAT A LINE MAY HOLD IS A FIXED LIST, AND THAT IS THE WHOLE DESIGN. Every
 * field below is either one of a handful of words this file spells out, or a
 * whole number. There is no field for a sentence. An address, a recipient, a
 * company name, a finding, a model's answer, a key or an exception message has
 * nowhere to go, so none of them can be logged by a careless edit somewhere
 * else -- the edit would have to be made here, where the tests are.
 *
 * A VALUE THAT IS NOT ON ITS LIST IS LEFT OUT, never passed through. A line
 * with a field missing is still true. A line carrying whatever it was handed
 * would not be a log anybody could promise was safe.
 *
 * IT CANNOT FAIL ITS CALLER. Everything is inside one `try`, it returns
 * nothing, and it is never awaited. An audit, a download and an email all end
 * the way they would have ended had this file not existed.
 *
 * IT IMPORTS NOTHING. The words it accepts are written out here and are held
 * to the application's own lists by the tests, so a new reason added elsewhere
 * fails a test until it is added here on purpose.
 */

/** The operations that report how they ended. */
export type ReliabilityOp = "ai.explain" | "pdf.render" | "email.send" | "page.parse" | "audit.run";

/**
 * What a caller may hand in.
 *
 * Deliberately loose about its strings: the checking is done on the way out,
 * against the lists below, and not by trusting what a caller typed.
 */
export interface ReliabilityEvent {
  readonly op: ReliabilityOp;
  /** The job's own id. Only its first eight characters are ever written. */
  readonly job?: string;
  readonly outcome: string;
  readonly reason?: string;
  /** How long the operation took, in milliseconds. */
  readonly ms?: number;
  /** The size of the document produced, in bytes. */
  readonly bytes?: number;
  /** How many explanations the validator kept, and how many it dropped. */
  readonly accepted?: number;
  readonly rejected?: number;
  /** Whether the document was being downloaded or attached to an email. */
  readonly via?: string;
  /** Whether the document that was built carries written commentary. */
  readonly aiText?: string;
  /** Where the commentary stood when the document was built. */
  readonly aiState?: string;
  /** Which page of the crawl this is, counting from one. */
  readonly order?: number;
  /** How large the page is, as a band from `sizeBand`, never an exact size. */
  readonly size?: string;
  /** How long an audit waited in the queue before it started, in milliseconds. */
  readonly waitMs?: number;
  /** How many pages an audit read. */
  readonly pages?: number;
  /** Why the crawl stopped: one of the crawl's own stop-reason codes. */
  readonly stop?: string;
}

/** Every outcome and reason an operation may report. Nothing else is written. */
const WORDS: Record<ReliabilityOp, { outcomes: readonly string[]; reasons: readonly string[] }> = {
  "ai.explain": {
    outcomes: ["succeeded", "timed-out", "rejected", "failed", "not-started"],
    reasons: [
      "no-api-key",
      "no-page-measurements",
      "timeout",
      "network",
      "rate-limited",
      "not-authorised",
      "provider-error",
      "bad-request",
      "empty-response",
      "unreadable-response",
      "refused",
      "internal-error",
    ],
  },
  "pdf.render": {
    outcomes: ["succeeded", "failed"],
    reasons: ["timed-out", "browser-unavailable", "internal-error"],
  },
  "email.send": {
    /*
     * ACCEPTED, NEVER DELIVERED. The email service taking a request is all this
     * application is ever told. Whether the message arrived, bounced or was
     * filed as spam is known only to that service.
     */
    outcomes: ["accepted", "not-accepted"],
    reasons: ["not-configured", "rejected", "rate-limited", "network", "provider-error"],
  },
  "page.parse": {
    /*
     * "parsing" is written immediately before a page is parsed, so the last one
     * before a crash names the size of the page being parsed when it happened.
     * "skipped" is a page too large to analyse, which is not parsed at all.
     */
    outcomes: ["parsing", "skipped", "measured"],
    reasons: ["too-large"],
  },
  "audit.run": {
    /*
     * "started" when an audit leaves the queue and begins, with how long it
     * waited. Then one of the job's own end states: "completed", "partial" or
     * "failed". A failure says which kind, never what the error said.
     */
    outcomes: ["started", "completed", "partial", "failed"],
    reasons: ["entry-unavailable", "unexpected", "certificate-failure"],
  },
};

/** The crawl's own stop-reason codes (CrawlStopReason), and nothing else. */
const STOP: readonly string[] = ["completed", "max-pages", "max-duration", "max-queue", "deadline"];

const VIA: readonly string[] = ["download", "email"];
const AI_TEXT: readonly string[] = ["included", "absent"];
const AI_STATE: readonly string[] = ["explained", "not-explained", "pending", "not-requested"];

/**
 * The bands a page's size is reported in, each with its upper bound in bytes.
 *
 * ROUNDED ON PURPOSE. An exact byte count is close to a fingerprint of one
 * page; a band says what memory needs to know -- small, large, or larger than
 * the analysis limit -- and nothing about which page it was.
 */
const SIZE_BANDS: readonly (readonly [number, string])[] = [
  [100_000, "under-100kb"],
  [500_000, "100kb-500kb"],
  [1_000_000, "500kb-1mb"],
  [1_500_000, "1mb-1.5mb"],
  [2_000_000, "1.5mb-2mb"],
  [3_000_000, "2mb-3mb"],
  [5_000_000, "3mb-5mb"],
];
const OVER_ALL_BANDS = "over-5mb";
const SIZE: readonly string[] = [...SIZE_BANDS.map(([, band]) => band), OVER_ALL_BANDS];

/** The band a size in bytes falls in. Each band includes its upper bound. */
export function sizeBand(bytes: number): string {
  for (const [upTo, band] of SIZE_BANDS) {
    if (bytes <= upTo) return band;
  }
  return OVER_ALL_BANDS;
}

/** The outcomes and reasons `op` may report, for the tests that hold them to the application's lists. */
export function reliabilityWords(op: ReliabilityOp): { outcomes: readonly string[]; reasons: readonly string[] } {
  return WORDS[op];
}

/** `value` if it is one of `allowed`, and otherwise nothing. */
function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

/** `value` if it is a whole number that is not negative, and otherwise nothing. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The first eight characters of a job id, or nothing.
 *
 * ENOUGH TO FOLLOW ONE AUDIT THROUGH THE LOG, and not enough to ask for its
 * report. Only letters, digits and hyphens are let through, which is what a
 * job id is made of and what an address or a recipient is not.
 */
function shortJob(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const short = value.slice(0, 8);
  return /^[A-Za-z0-9-]{1,8}$/.test(short) ? short : undefined;
}

/**
 * The line for one event, or null when the event names no operation or outcome
 * this file knows.
 *
 * Built field by field from the checked values, in a fixed order. The event
 * object is never spread, copied or serialised, so a field this file does not
 * name cannot reach the line however it got onto the object.
 */
function lineFor(event: ReliabilityEvent, at: Date): string | null {
  /*
   * READ ONCE, AND THE VALUE THAT WAS CHECKED IS THE VALUE THAT IS WRITTEN. An
   * event is only an object, and a property can answer differently each time
   * it is asked; reading it again after checking it would write something that
   * was never checked. It must also be a string: a list holding an operation's
   * name is not that operation.
   */
  const op: unknown = event.op;
  if (typeof op !== "string" || !Object.prototype.hasOwnProperty.call(WORDS, op)) return null;
  const words = WORDS[op as ReliabilityOp];

  const outcome = oneOf(event.outcome, words.outcomes);
  if (outcome === undefined) return null;

  const line: Record<string, string | number> = { ts: at.toISOString(), op };

  const put = (name: string, value: string | number | undefined) => {
    if (value !== undefined) line[name] = value;
  };

  put("job", shortJob(event.job));
  put("via", oneOf(event.via, VIA));
  line.outcome = outcome;
  put("reason", oneOf(event.reason, words.reasons));
  put("ms", count(event.ms));
  put("bytes", count(event.bytes));
  put("accepted", count(event.accepted));
  put("rejected", count(event.rejected));
  put("aiText", oneOf(event.aiText, AI_TEXT));
  put("aiState", oneOf(event.aiState, AI_STATE));
  put("order", count(event.order));
  put("size", oneOf(event.size, SIZE));
  put("waitMs", count(event.waitMs));
  put("pages", count(event.pages));
  put("stop", oneOf(event.stop, STOP));

  return JSON.stringify(line);
}

/**
 * Writes how one operation ended.
 *
 * Never throws and returns nothing: a log that could not be written is a line
 * that is missing, and never a reason for the operation it described to fail.
 */
export function logOutcome(event: ReliabilityEvent): void {
  try {
    const line = lineFor(event, new Date());
    if (line !== null) console.log(line);
  } catch {
    // Nothing to do, and nothing to tell: the caller's own work is unaffected.
  }
}

/**
 * Milliseconds elapsed since `since` on the monotonic clock, as a whole
 * number. For durations: unlike the wall clock, it cannot jump backwards or
 * forwards when the system time is corrected, so a duration is never negative
 * or invented.
 */
export function elapsedMs(since: number): number {
  return Math.max(0, Math.round(performance.now() - since));
}

/** How many keys `logOutcomeOnce` remembers before it forgets the oldest. */
export const ONCE_LIMIT = 500;

const seen = new Set<string>();

/**
 * Writes how an operation ended, the first time it is asked to for `key`.
 *
 * FOR AN OUTCOME THAT NOTHING ELSE STOPS BEING REPORTED TWICE. Most outcomes
 * are written at a point the application already reaches once per audit. One is
 * not: an audit that read no page is refused its commentary on every request,
 * so a browser that asked five times would write five lines about one audit.
 *
 * BOUNDED. It remembers a few hundred keys and then forgets the oldest, so it
 * is the same size after a year as after an hour. Audits live for half an hour,
 * which is far shorter than the time it takes to push a key out.
 */
export function logOutcomeOnce(key: string, event: ReliabilityEvent): void {
  try {
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > ONCE_LIMIT) {
      for (const oldest of seen) {
        seen.delete(oldest);
        break;
      }
    }
  } catch {
    return;
  }
  logOutcome(event);
}

/** Forgets every key. For tests, which would otherwise depend on one another's. */
export function resetLoggedOnce(): void {
  seen.clear();
}

// ---------------------------------------------------------------------------
// Describing an error without repeating it
// ---------------------------------------------------------------------------

/** What an error is called when it has no name this file is willing to print. */
const FALLBACK_NAME = "Error";

/** A class name: a capital, then letters and digits. Anything else is not one. */
const SAFE_NAME = /^[A-Z][A-Za-z0-9]{0,40}$/;

/**
 * What kind of error this was -- its class name, and nothing else.
 *
 * FOR THE TWO PLACES THAT LOG AN UNEXPECTED ERROR. They used to print the
 * error's message and stack, and a message is written by whatever threw it: it
 * can hold the address being audited, a line of a client's page, or a key that
 * was in a URL.
 *
 * THE STACK IS NOT READ AT ALL. A stack trace begins with the message, and a
 * message can be several lines long and can be written to look like the lines
 * that follow it. Telling the two apart is possible nearly always, and "nearly
 * always" is not a promise that can be made about a client's data. So nothing
 * is taken from the stack: no file, no line number, no text of any kind.
 *
 * THE NAME IS CHECKED, because it too is only a property somebody set. A name
 * that is not a plain class name -- and anything thrown that is not an error --
 * is called "Error", which is true of all of them.
 *
 * Never throws: an error whose name cannot even be read is "Error" as well.
 */
export function describeError(error: unknown): string {
  try {
    if (!(error instanceof Error)) return FALLBACK_NAME;
    const name: unknown = error.name;
    return typeof name === "string" && SAFE_NAME.test(name) ? name : FALLBACK_NAME;
  } catch {
    return FALLBACK_NAME;
  }
}
