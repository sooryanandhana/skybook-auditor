/**
 * Catches what is written to the console while some work runs, for the tests of
 * the reliability log.
 *
 * EVERYTHING, NOT ONLY THE LOG'S OWN LINES. A test that asks "did anything
 * about this client reach the console" has to see a stray `console.warn` as
 * well as a well-formed line, so all three writers are caught and each caught
 * entry is every argument joined, exactly as it would have been printed.
 *
 * The real writers are put back whatever happens, so a failing test does not
 * silence the ones after it.
 */

export interface Captured {
  /** Every entry written, by any of the three writers, in order. */
  readonly all: string[];
  /** The entries that are one JSON object, parsed. These are the log's lines. */
  readonly lines: Record<string, unknown>[];
}

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

function parsed(entry: string): Record<string, unknown> | null {
  if (!entry.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(entry);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function captureLog<T>(work: () => T | Promise<T>): Promise<Captured & { result: T }> {
  const all: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const catcher = (...args: unknown[]) => {
    all.push(args.map(asText).join(" "));
  };

  console.log = catcher;
  console.warn = catcher;
  console.error = catcher;

  try {
    const result = await work();
    const lines = all.map(parsed).filter((line): line is Record<string, unknown> => line !== null);
    return { all, lines, result };
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

/** The log's lines for one operation. */
export const linesFor = (captured: Captured, op: string) => captured.lines.filter((line) => line.op === op);

/**
 * The only names a line may carry. A test that finds any other name on a line
 * has found a field nobody approved.
 */
export const APPROVED_FIELDS = [
  "ts",
  "op",
  "job",
  "via",
  "outcome",
  "reason",
  "ms",
  "bytes",
  "accepted",
  "rejected",
  "aiText",
  "aiState",
] as const;
