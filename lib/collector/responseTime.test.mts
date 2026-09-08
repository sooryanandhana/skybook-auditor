/**
 * Tests for the three-sample response time.
 *
 * THE ARITHMETIC IS THE EASY PART and it is tested anyway, because a median
 * that quietly returns the first sample looks right on sorted input. What
 * matters more is what happens when a request does not answer: a failure that
 * became a zero would be the fastest server ever audited, and it would drag a
 * median down with it silently.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The request function and the clock are
 * both injected. The two tests that exercise the safety checks use the real
 * ones against addresses that resolve locally, which is the point of them.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  RESPONSE_TIME_REQUEST_TIMEOUT_MS,
  RESPONSE_TIME_SAMPLES,
  measureResponseTime,
  medianOf,
} from "./responseTime.ts";
import type { Deadline } from "./deadline.ts";

const SITE = "https://example.com/";

/** What one planned request does: take this long, or fail this way. */
type Step = number | "timeout" | "abort" | "network";

/**
 * A clock and a request function that follow a plan.
 *
 * The clock only moves when a request takes time, so a duration is exactly
 * what the plan said and nothing depends on how fast the test machine is.
 */
function planned(steps: readonly Step[]) {
  const remaining = [...steps];
  let elapsed = 0;
  const calls: Array<{ url: string; signal: unknown }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    const step = remaining.shift();

    if (step === "timeout" || step === "abort") {
      // Real time passes before a timeout fires, so the clock moves too.
      elapsed += RESPONSE_TIME_REQUEST_TIMEOUT_MS;
      const error = new Error("the request was aborted");
      error.name = step === "timeout" ? "TimeoutError" : "AbortError";
      throw error;
    }
    if (step === "network") {
      elapsed += 5;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }

    elapsed += step ?? 0;
    return new Response("<html></html>", { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, now: () => elapsed };
}

/** A deadline that never runs out, and records what it was asked to cap. */
function openDeadline() {
  const caps: Array<number | undefined> = [];
  const deadline: Deadline = {
    expired: () => false,
    remainingMs: () => 60_000,
    signal: (capMs) => {
      caps.push(capMs);
      return AbortSignal.timeout(Math.max(1, capMs ?? 60_000));
    },
  };
  return { deadline, caps };
}

/**
 * A deadline that runs out once `allowed` requests have been made.
 *
 * Counted in requests rather than in calls to `expired`, because the module
 * checks the clock before it starts as well as before each sample -- and a
 * fake that counted those would expire a sample early and quietly turn this
 * into a different test.
 */
function deadlineAfter(allowed: number, made: () => number) {
  const deadline: Deadline = {
    expired: () => made() >= allowed,
    remainingMs: () => 60_000,
    signal: () => AbortSignal.timeout(60_000),
  };
  return deadline;
}

const measure = (steps: readonly Step[], deadline?: Deadline) => {
  const plan = planned(steps);
  const clock = deadline ?? openDeadline().deadline;
  return {
    plan,
    result: measureResponseTime(SITE, {
      deadline: clock,
      now: plan.now,
      fetchImpl: plan.fetchImpl,
    }),
  };
};

// ---------------------------------------------------------------------------
// A. B. C. D. The median itself
// ---------------------------------------------------------------------------

test("three samples produce their middle value", async () => {
  const { result } = measure([100, 300, 200]);
  const answer = await result;

  assert.equal(answer.status, "measured");
  assert.equal(answer.medianResponseTimeMs, 200);
  assert.equal(answer.attempted, 3);
  assert.equal(answer.succeeded, 3);
  assert.deepEqual(
    answer.samples.map((sample) => sample.ms),
    [100, 300, 200],
  );
});

test("samples already in order produce the same middle value", async () => {
  assert.equal((await measure([100, 200, 300]).result).medianResponseTimeMs, 200);
});

test("samples in reverse order produce the same middle value", async () => {
  assert.equal((await measure([300, 200, 100]).result).medianResponseTimeMs, 200);
});

test("a repeated value is still the middle one", async () => {
  assert.equal((await measure([200, 200, 500]).result).medianResponseTimeMs, 200);
  assert.equal((await measure([500, 200, 200]).result).medianResponseTimeMs, 200);
});

test("the median is the middle, not the first, the smallest or the average", async () => {
  /*
   * The one input that tells four wrong implementations apart. First is 900,
   * smallest is 100, largest 900, mean 400 — and the median is 200.
   */
  const answer = await measure([900, 200, 100]).result;

  assert.equal(answer.medianResponseTimeMs, 200);
  assert.notEqual(answer.medianResponseTimeMs, 900);
  assert.notEqual(answer.medianResponseTimeMs, 100);
  assert.notEqual(answer.medianResponseTimeMs, 400);
});

test("large numbers sort as numbers, not as text", async () => {
  // Sorted as text, 1000 comes before 200 and the median would be 200.
  assert.equal((await measure([1000, 200, 3000]).result).medianResponseTimeMs, 1000);
});

// ---------------------------------------------------------------------------
// M. The same input always gives the same answer
// ---------------------------------------------------------------------------

test("the calculation is deterministic", async () => {
  for (let run = 0; run < 5; run += 1) {
    assert.equal((await measure([412, 118, 267]).result).medianResponseTimeMs, 267);
  }

  // And the helper on its own, with no request anywhere near it.
  assert.equal(medianOf([412, 118, 267]), 267);
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([3, 2, 1]), 2);
  assert.equal(medianOf([]), null);
});

test("the helper does not disturb the array it was given", () => {
  const values = [900, 100, 500];
  medianOf(values);

  assert.deepEqual(values, [900, 100, 500]);
});

// ---------------------------------------------------------------------------
// E. F. G. H. Failure is never a number
// ---------------------------------------------------------------------------

test("a failed request is not recorded as zero milliseconds", async () => {
  const answer = await measure([100, "network", 200]).result;

  assert.equal(answer.status, "unavailable");
  assert.equal(answer.medianResponseTimeMs, null);
  const failed = answer.samples.find((sample) => !sample.ok);
  assert.equal(failed?.ms, null, "a failure has no timing, not a timing of zero");
  assert.equal(failed?.failure, "network");
  assert.ok(!answer.samples.some((sample) => sample.ms === 0));
});

test("a timed-out request is not recorded as zero milliseconds", async () => {
  const answer = await measure([100, "timeout", 200]).result;

  assert.equal(answer.status, "unavailable");
  assert.equal(answer.medianResponseTimeMs, null);
  const failed = answer.samples.find((sample) => !sample.ok);
  assert.equal(failed?.ms, null);
  assert.equal(failed?.failure, "timeout");
});

test("an aborted request reads as a timeout, not as a network fault", async () => {
  const answer = await measure(["abort", "abort", "abort"]).result;

  assert.equal(answer.failure, "timeout");
});

test("two good samples out of three is unavailable, not a median of two", async () => {
  /*
   * THE DECISION THIS TASK TURNS ON. Two numbers have a mean, not a median,
   * and calling one "the median of three samples" describes a measurement that
   * did not happen. The two real timings are kept, because the server did
   * answer twice and hiding that would be its own falsehood.
   */
  const answer = await measure([100, 300, "network"]).result;

  assert.equal(answer.status, "unavailable");
  assert.equal(answer.medianResponseTimeMs, null);
  assert.equal(answer.failure, "incomplete");
  assert.equal(answer.attempted, 3);
  assert.equal(answer.succeeded, 2);
  assert.deepEqual(
    answer.samples.filter((sample) => sample.ok).map((sample) => sample.ms),
    [100, 300],
  );
  assert.match(answer.message, /2 of 3/);
});

test("one good sample out of three is unavailable too", async () => {
  const answer = await measure(["network", 250, "timeout"]).result;

  assert.equal(answer.status, "unavailable");
  assert.equal(answer.medianResponseTimeMs, null);
  assert.equal(answer.succeeded, 1);
  assert.equal(answer.failure, "incomplete");
});

test("all three failing says why, and claims no timing at all", async () => {
  const answer = await measure(["network", "network", "network"]).result;

  assert.equal(answer.status, "unavailable");
  assert.equal(answer.medianResponseTimeMs, null);
  assert.equal(answer.attempted, 3);
  assert.equal(answer.succeeded, 0);
  assert.equal(answer.failure, "network");
  assert.ok(answer.samples.every((sample) => sample.ms === null));
});

test("all three timing out is reported as a timeout", async () => {
  const answer = await measure(["timeout", "timeout", "timeout"]).result;

  assert.equal(answer.failure, "timeout");
  assert.equal(answer.succeeded, 0);
});

// ---------------------------------------------------------------------------
// I. The audit deadline
// ---------------------------------------------------------------------------

test("the audit deadline stops further samples rather than being ignored", async () => {
  const plan = planned([100, 300, 200]);
  const answer = await measureResponseTime(SITE, {
    deadline: deadlineAfter(1, () => plan.calls.length),
    now: plan.now,
    fetchImpl: plan.fetchImpl,
  });

  assert.equal(plan.calls.length, 1, "a request was made after the clock ran out");
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.succeeded, 1);
  assert.equal(answer.failure, "incomplete");
  assert.equal(
    answer.samples[1].failure,
    "out-of-time",
    "running out of time is its own state, not a slow server",
  );
  /*
   * FOUND BY MUTATION TESTING. A sample cut short by the clock recording zero
   * survived every other test here, and zero is the one wrong answer that
   * would not look wrong: it is a plausible number that makes a server appear
   * instant and drags any median containing it to the floor.
   */
  assert.equal(answer.samples[1].ms, null, "a sample that never ran has no timing");
  assert.equal(answer.samples[2].ms, null);
  for (const sample of answer.samples) {
    if (!sample.ok) assert.equal(sample.ms, null, "a failed sample carried a number");
  }
});

test("no failed sample anywhere carries a timing", async () => {
  const plans: ReadonlyArray<readonly Step[]> = [
    ["network", "network", "network"],
    ["timeout", "timeout", "timeout"],
    [100, "network", "timeout"],
    ["abort", 200, "network"],
  ];

  for (const plan of plans) {
    const answer = await measure(plan).result;
    for (const sample of answer.samples) {
      if (sample.ok) assert.equal(typeof sample.ms, "number");
      else assert.equal(sample.ms, null, `a failed sample carried ${sample.ms}`);
    }
  }
});

test("a deadline already spent makes no request at all", async () => {
  const plan = planned([100, 300, 200]);
  const answer = await measureResponseTime(SITE, {
    deadline: deadlineAfter(0, () => plan.calls.length),
    now: plan.now,
    fetchImpl: plan.fetchImpl,
  });

  assert.equal(plan.calls.length, 0);
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.failure, "out-of-time");
  assert.equal(answer.attempted, 0);
  assert.equal(answer.medianResponseTimeMs, null);
});

// ---------------------------------------------------------------------------
// J. K. The protections that were already there
// ---------------------------------------------------------------------------

test("a private address is refused, by the audit's own safety check", async () => {
  // These parse as ordinary addresses. It is the public-host check, doing a
  // real lookup, that refuses them -- which is exactly the layer under test.
  for (const address of ["http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/"]) {
    const plan = planned([100, 100, 100]);
    const answer = await measureResponseTime(address, {
      deadline: openDeadline().deadline,
      now: plan.now,
      fetchImpl: plan.fetchImpl,
    });

    assert.equal(plan.calls.length, 0, `${address} was requested`);
    assert.equal(answer.status, "unavailable");
    assert.equal(answer.failure, "refused");
    assert.equal(answer.medianResponseTimeMs, null);
  }
});

test("an address the audit would not accept is not requested either", async () => {
  /*
   * Refused earlier still, by the audit's own parser: a scheme that is not
   * http, a hostname with no dot, or something that is not an address at all.
   * `localhost` is here rather than above because this is the layer that
   * stops it, and a test that named the wrong layer would pass while the
   * protection it claimed to check was gone.
   */
  for (const address of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://localhost:3000/",
    "http://[::1]/",
    "not a url",
    "",
  ]) {
    const plan = planned([100, 100, 100]);
    const answer = await measureResponseTime(address, {
      deadline: openDeadline().deadline,
      now: plan.now,
      fetchImpl: plan.fetchImpl,
    });

    assert.equal(plan.calls.length, 0, `${address} was requested`);
    assert.equal(answer.failure, "invalid-address");
  }
});

test("every request is bounded by its own cap and by the shared clock", async () => {
  const { deadline, caps } = openDeadline();
  const plan = planned([100, 300, 200]);
  await measureResponseTime(SITE, { deadline, now: plan.now, fetchImpl: plan.fetchImpl });

  assert.deepEqual(caps, [
    RESPONSE_TIME_REQUEST_TIMEOUT_MS,
    RESPONSE_TIME_REQUEST_TIMEOUT_MS,
    RESPONSE_TIME_REQUEST_TIMEOUT_MS,
  ]);
  for (const call of plan.calls) {
    assert.ok(call.signal instanceof AbortSignal, "a request went out with no abort signal");
  }
});

test("redirects are not followed, so no hop escapes the safety check", async () => {
  const plan = planned([100, 300, 200]);
  await measureResponseTime(SITE, {
    deadline: openDeadline().deadline,
    now: plan.now,
    fetchImpl: plan.fetchImpl,
  });

  const source = fs.readFileSync(new URL("./responseTime.ts", import.meta.url), "utf8");
  assert.match(source, /redirect: "manual"/);
  assert.ok(!/redirect:\s*"follow"/.test(source));
  for (const call of plan.calls) assert.equal(call.url, SITE);
});

test("exactly three requests are made, and they are not retries", async () => {
  const plan = planned([100, 300, 200]);
  await measureResponseTime(SITE, {
    deadline: openDeadline().deadline,
    now: plan.now,
    fetchImpl: plan.fetchImpl,
  });

  assert.equal(plan.calls.length, RESPONSE_TIME_SAMPLES);
  assert.equal(RESPONSE_TIME_SAMPLES, 3);
});

test("a failed sample is followed by the next sample, not by a repeat of it", async () => {
  // Three attempts happen whatever the first one did. If these were retries,
  // a success would stop them and a failure would produce more than three.
  const plan = planned(["network", 200, 100]);
  const answer = await measureResponseTime(SITE, {
    deadline: openDeadline().deadline,
    now: plan.now,
    fetchImpl: plan.fetchImpl,
  });

  assert.equal(plan.calls.length, 3);
  assert.equal(answer.attempted, 3);
});

// ---------------------------------------------------------------------------
// L. N. What it must not do
// ---------------------------------------------------------------------------

test("the measurement reads no body, so nothing is downloaded", async () => {
  let cancelled = false;
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>a large page</html>"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;

  const answer = await measureResponseTime(SITE, {
    deadline: openDeadline().deadline,
    now: (() => {
      let t = 0;
      return () => (t += 50);
    })(),
    fetchImpl,
  });

  assert.equal(answer.status, "measured");
  assert.equal(cancelled, true, "the body was read rather than discarded");
});

test("any HTTP status is a timing, because the server answered", async () => {
  for (const status of [200, 301, 404, 500]) {
    const fetchImpl = (async () => new Response("x", { status })) as unknown as typeof fetch;
    let t = 0;
    const answer = await measureResponseTime(SITE, {
      deadline: openDeadline().deadline,
      now: () => (t += 60),
      fetchImpl,
    });

    assert.equal(answer.status, "measured", `status ${status} was not timed`);
    assert.equal(answer.medianResponseTimeMs, 60);
  }
});

test("a clock that steps backwards cannot produce a negative timing", async () => {
  // Guards the floor, not the clock choice: the module reads a monotonic
  // source precisely so this cannot happen, and this proves the floor anyway.
  const readings = [1000, 400, 1000, 400, 1000, 400];
  const fetchImpl = (async () => new Response("x", { status: 200 })) as unknown as typeof fetch;

  const answer = await measureResponseTime(SITE, {
    deadline: openDeadline().deadline,
    now: () => readings.shift() ?? 0,
    fetchImpl,
  });

  assert.equal(answer.status, "measured");
  assert.equal(answer.medianResponseTimeMs, 0);
  assert.ok(answer.samples.every((sample) => (sample.ms ?? 0) >= 0));
});

test("this collector knows nothing about any AI provider", () => {
  const source = fs.readFileSync(new URL("./responseTime.ts", import.meta.url), "utf8");

  for (const name of ["@google/genai", "gemini", "Gemini", "explainAudit", "GEMINI_API_KEY"]) {
    assert.ok(!source.includes(name), `the collector mentions ${name}`);
  }
  assert.ok(!/from\s+["'][^"']*\/ai\//.test(source), "the collector imports from the AI layer");
});

test("it reuses the audit's own safety and timing modules rather than its own", () => {
  const source = fs.readFileSync(new URL("./responseTime.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\/url\.ts"/);
  assert.match(source, /from "\.\/safety\.ts"/);
  assert.match(source, /from "\.\/deadline\.ts"/);
  // No second HTTP client, and no retry machinery.
  assert.ok(!/require\(|axios|node-fetch|got\(/.test(source));
  assert.ok(!/\bretry|\bretries/i.test(source.replace(/NOT THREE RETRIES|not three retries/gi, "")));
});
