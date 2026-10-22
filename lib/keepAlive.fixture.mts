/**
 * Keeps a test's process alive while it waits on an UNREFERENCED timer.
 *
 * WHY. `AbortSignal.timeout()` and the Gemini SDK's request timeout
 * (`setTimeout(...).unref()`) deliberately do not hold the event loop open.
 * A test whose only pending work is such a timer is CANCELLED by Node 22's
 * test runner ("Promise resolution is still pending but the event loop has
 * already resolved"), and every later test in the file with it; Node 24
 * waits instead. One referenced timer, held for the length of the wait,
 * makes both runtimes behave the same.
 *
 * WHAT IT DOES NOT DO.
 *   - It never decides when anything times out: the real deadline fires on
 *     its own clock, and the hold is cleared the moment the wait settles.
 *   - It never swallows an outcome: no catch, so a rejection propagates
 *     unchanged, and a resolved value is returned unchanged.
 *   - It never lets a hang pass: the hold only keeps the process alive.
 *
 * `holdMs` MUST BE LONGER THAN THE CALLING TEST'S `timeout`. The test's
 * timeout is what turns a genuine hang into a clear "test timed out"
 * failure; if the hold lapsed first, Node 22 would cancel the test instead.
 */
export async function keepAliveWhile<T>(work: Promise<T>, holdMs: number): Promise<T> {
  if (!(holdMs > 0)) throw new RangeError("keepAliveWhile needs a positive holdMs");
  const hold = setTimeout(() => {}, holdMs);
  try {
    return await work;
  } finally {
    clearTimeout(hold);
  }
}
