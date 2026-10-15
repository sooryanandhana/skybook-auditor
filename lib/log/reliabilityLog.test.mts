/**
 * Tests for the reliability log.
 *
 * ONE PROPERTY CARRIES THIS FILE: a line holds the approved fields and nothing
 * else, whatever it was handed. Everything the log is trusted with -- that it
 * cannot print an address, a recipient, a key or an exception's message --
 * follows from that, so it is tested from several directions.
 *
 * The second property is that it cannot hurt its caller: it never throws.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  describeError,
  logOutcome,
  logOutcomeOnce,
  reliabilityWords,
  resetLoggedOnce,
  ONCE_LIMIT,
  type ReliabilityEvent,
} from "./reliabilityLog.ts";
import { APPROVED_FIELDS, captureLog } from "./captureLog.fixture.mts";
import { EXPLANATION_FAILURE_MESSAGES } from "../ai/explanationOutcome.ts";
import { PDF_RENDER_MESSAGES } from "../audit/pdf/render.ts";
import { SEND_FAILURE_MESSAGES } from "../email/provider.ts";

const JOB = "3f9c1a7e-0000-4000-8000-000000000000";

/** Hands the logger something its type does not allow, as a careless caller might. */
const loose = (event: Record<string, unknown>) => event as unknown as ReliabilityEvent;

async function lineOf(event: ReliabilityEvent) {
  const captured = await captureLog(() => logOutcome(event));
  return captured;
}

// ---------------------------------------------------------------------------
// What a line is
// ---------------------------------------------------------------------------

test("an outcome is written as one line of JSON", async () => {
  const captured = await lineOf({ op: "ai.explain", job: JOB, outcome: "succeeded", ms: 1200, accepted: 5, rejected: 0 });

  assert.equal(captured.all.length, 1, "one entry");
  assert.ok(!captured.all[0].includes("\n"), "on one line");
  assert.deepEqual(
    { ...captured.lines[0], ts: "T" },
    { ts: "T", op: "ai.explain", job: "3f9c1a7e", outcome: "succeeded", ms: 1200, accepted: 5, rejected: 0 },
  );
});

test("every line carries the time it was written", async () => {
  const before = Date.now();
  const captured = await lineOf({ op: "email.send", outcome: "accepted" });
  const after = Date.now();

  const written = Date.parse(String(captured.lines[0].ts));
  assert.ok(written >= before && written <= after, "the moment of writing, as an ISO timestamp");
  assert.match(String(captured.lines[0].ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("only the first eight characters of a job id are written", async () => {
  const captured = await lineOf({ op: "pdf.render", job: JOB, outcome: "succeeded" });

  assert.equal(captured.lines[0].job, "3f9c1a7e");
  assert.ok(!captured.all[0].includes(JOB), "the whole id is not in the line");
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test("a field nobody approved never reaches the line", async () => {
  const captured = await lineOf(
    loose({
      op: "email.send",
      job: JOB,
      outcome: "accepted",
      recipient: "ana@harbourdental.example",
      url: "https://client.example/?token=abc",
      message: "connect ECONNREFUSED 10.0.0.1",
      receipt: "re_123",
      headers: { authorization: "Bearer secret" },
    }),
  );

  assert.deepEqual(Object.keys(captured.lines[0]).sort(), ["job", "op", "outcome", "ts"]);
  for (const forbidden of ["harbourdental", "client.example", "token", "ECONNREFUSED", "re_123", "Bearer", "secret"]) {
    assert.ok(!captured.all[0].includes(forbidden), `${forbidden} is not in the line`);
  }
});

test("a line never carries a field outside the approved list", async () => {
  const everything = loose({
    op: "pdf.render",
    job: JOB,
    via: "email",
    outcome: "failed",
    reason: "timed-out",
    ms: 1,
    bytes: 2,
    accepted: 3,
    rejected: 4,
    aiText: "included",
    aiState: "explained",
    extra: "x",
  });

  const captured = await lineOf(everything);
  for (const name of Object.keys(captured.lines[0])) {
    assert.ok((APPROVED_FIELDS as readonly string[]).includes(name), `${name} is an approved field`);
  }
});

test("a reason that is not on the operation's list is left out, not passed through", async () => {
  const captured = await lineOf({
    op: "ai.explain",
    job: JOB,
    outcome: "rejected",
    reason: 'the answer may not carry "client-secret-key"',
  });

  assert.equal(captured.lines[0].outcome, "rejected", "the line is still written");
  assert.ok(!("reason" in captured.lines[0]), "without the sentence");
  assert.ok(!captured.all[0].includes("client-secret-key"));
});

test("a reason belonging to another operation is not accepted", async () => {
  const captured = await lineOf({ op: "email.send", outcome: "not-accepted", reason: "browser-unavailable" });

  assert.ok(!("reason" in captured.lines[0]));
});

test("an outcome that is not on the list writes nothing at all", async () => {
  for (const outcome of ["delivered", "https://client.example/", "", "SUCCEEDED"]) {
    const captured = await lineOf({ op: "email.send", outcome });
    assert.equal(captured.all.length, 0, `${JSON.stringify(outcome)} is not an outcome`);
  }
});

test("an operation this file does not know writes nothing", async () => {
  for (const op of ["audit.run", "constructor", "__proto__", "toString"]) {
    const captured = await lineOf(loose({ op, outcome: "succeeded" }));
    assert.equal(captured.all.length, 0, `${op} is not an operation`);
  }
});

test("an operation that answers differently each time it is read cannot write an unapproved value", async () => {
  // The value that passes the check must be the value that is written. Every
  // way of changing it afterwards is tried: on the second read, the third, and
  // on every read after the first.
  for (const honestReads of [1, 2, 3, 4]) {
    let reads = 0;
    const shifty = {
      get op() {
        reads += 1;
        return reads <= honestReads ? "pdf.render" : "https://client.example/?token=abc";
      },
      outcome: "succeeded",
    };

    const captured = await lineOf(shifty as unknown as ReliabilityEvent);

    assert.equal(reads, 1, "the operation is read once");
    assert.equal(captured.all.length, 1);
    assert.equal(captured.lines[0].op, "pdf.render");
    assert.ok(!captured.all[0].includes("client.example"), "nothing unapproved is in the line");
    assert.ok(!captured.all[0].includes("token"));
  }
});

test("an operation that is unapproved on its first read writes nothing, whatever it says later", async () => {
  let reads = 0;
  const shifty = {
    get op() {
      reads += 1;
      return reads === 1 ? "https://client.example/" : "pdf.render";
    },
    outcome: "succeeded",
  };

  const captured = await lineOf(shifty as unknown as ReliabilityEvent);

  assert.equal(captured.all.length, 0);
});

test("an operation that is not a string is never written, even when it reads like an approved one", async () => {
  const lookalikes: unknown[] = [
    ["pdf.render"],
    ["pdf.render", "https://client.example/"],
    { toString: () => "pdf.render" },
    new String("pdf.render"),
    Symbol("pdf.render"),
    1,
    null,
    undefined,
  ];

  for (const op of lookalikes) {
    const captured = await lineOf(loose({ op, outcome: "succeeded" }));
    assert.equal(captured.all.length, 0, `${typeof op} is not an operation`);
  }
});

test("the operation on a line is always one of the three, as a string", async () => {
  for (const op of ["ai.explain", "pdf.render", "email.send"] as const) {
    const outcome = reliabilityWords(op).outcomes[0];
    const captured = await lineOf({ op, outcome });

    assert.equal(captured.lines.length, 1);
    assert.equal(typeof captured.lines[0].op, "string");
    assert.equal(captured.lines[0].op, op);
  }
});

test("a number is written only when it is a whole number that is not negative", async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12", null, { valueOf: () => 3 }]) {
    const captured = await lineOf(loose({ op: "pdf.render", outcome: "succeeded", ms: bad, bytes: bad }));
    assert.ok(!("ms" in captured.lines[0]), `ms: ${String(bad)}`);
    assert.ok(!("bytes" in captured.lines[0]), `bytes: ${String(bad)}`);
  }

  const captured = await lineOf({ op: "pdf.render", outcome: "succeeded", ms: 0, bytes: 930539 });
  assert.equal(captured.lines[0].ms, 0, "nought is a number");
  assert.equal(captured.lines[0].bytes, 930539);
});

test("a job id made of anything but letters, digits and hyphens is left out", async () => {
  for (const bad of ["ana@x.io", "https://a", "a b", "../../etc", "", 12345678, null]) {
    const captured = await lineOf(loose({ op: "pdf.render", job: bad, outcome: "succeeded" }));
    assert.ok(!("job" in captured.lines[0]), `${String(bad)} is not a job id`);
  }
});

test("where the document went, and how the commentary stood, are words from a fixed list", async () => {
  const bad = await lineOf(
    loose({ op: "pdf.render", outcome: "succeeded", via: "ftp", aiText: "This site is perfect.", aiState: "done" }),
  );
  assert.deepEqual(Object.keys(bad.lines[0]).sort(), ["op", "outcome", "ts"]);

  const good = await lineOf({ op: "pdf.render", outcome: "succeeded", via: "download", aiText: "absent", aiState: "pending" });
  assert.equal(good.lines[0].via, "download");
  assert.equal(good.lines[0].aiText, "absent");
  assert.equal(good.lines[0].aiState, "pending");
});

// ---------------------------------------------------------------------------
// The lists are the application's own
// ---------------------------------------------------------------------------

test("every reason the application can give for a missing explanation can be logged", () => {
  const known = reliabilityWords("ai.explain").reasons;

  for (const reason of Object.keys(EXPLANATION_FAILURE_MESSAGES)) {
    assert.ok(known.includes(reason), `${reason} would be dropped from the log`);
  }
  assert.ok(known.includes("no-page-measurements"), "and the refusal that asks nothing");
});

test("an audit with no key and an audit with no page are told apart", async () => {
  const noKey = await lineOf({ op: "ai.explain", outcome: "not-started", reason: "no-api-key" });
  const noPage = await lineOf({ op: "ai.explain", outcome: "not-started", reason: "no-page-measurements" });

  assert.equal(noKey.lines[0].reason, "no-api-key");
  assert.equal(noPage.lines[0].reason, "no-page-measurements");
});

test("every way a render can fail can be logged", () => {
  assert.deepEqual([...reliabilityWords("pdf.render").reasons].sort(), Object.keys(PDF_RENDER_MESSAGES).sort());
});

test("every way a send can fail can be logged", () => {
  assert.deepEqual([...reliabilityWords("email.send").reasons].sort(), Object.keys(SEND_FAILURE_MESSAGES).sort());
});

test("an email is never logged as delivered", () => {
  const outcomes = reliabilityWords("email.send").outcomes;

  assert.deepEqual([...outcomes], ["accepted", "not-accepted"]);
  for (const claim of ["delivered", "sent", "received", "bounced"]) {
    assert.ok(!outcomes.includes(claim), `${claim} is more than this application is told`);
  }
});

// ---------------------------------------------------------------------------
// It cannot hurt its caller
// ---------------------------------------------------------------------------

test("a console that throws does not make the logger throw", () => {
  const real = console.log;
  console.log = () => {
    throw new Error("the console is closed");
  };

  try {
    assert.doesNotThrow(() => logOutcome({ op: "pdf.render", outcome: "succeeded" }));
    assert.doesNotThrow(() => logOutcomeOnce("k", { op: "pdf.render", outcome: "succeeded" }));
  } finally {
    console.log = real;
  }
});

test("an event that cannot be read does not make the logger throw", async () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("https://client.example/ must not be printed");
      },
    },
  );

  const captured = await captureLog(() => {
    assert.doesNotThrow(() => logOutcome(hostile as unknown as ReliabilityEvent));
    assert.doesNotThrow(() => logOutcome(null as unknown as ReliabilityEvent));
    assert.doesNotThrow(() => logOutcome(undefined as unknown as ReliabilityEvent));
  });

  assert.equal(captured.all.length, 0, "and nothing about it is written");
});

test("the logger returns nothing and is not a promise", () => {
  const real = console.log;
  console.log = () => {};
  try {
    assert.equal(logOutcome({ op: "pdf.render", outcome: "succeeded" }), undefined);
  } finally {
    console.log = real;
  }
});

// ---------------------------------------------------------------------------
// Once
// ---------------------------------------------------------------------------

test("an outcome logged once for a key is not logged again", async () => {
  resetLoggedOnce();
  const event: ReliabilityEvent = { op: "ai.explain", job: JOB, outcome: "not-started", reason: "no-page-measurements" };

  const captured = await captureLog(() => {
    for (let ask = 0; ask < 5; ask += 1) logOutcomeOnce("ai.explain:a", event);
    logOutcomeOnce("ai.explain:b", event);
  });

  assert.equal(captured.lines.length, 2, "one for each audit, however often it was asked");
});

test("what it remembers is bounded", async () => {
  resetLoggedOnce();
  const event: ReliabilityEvent = { op: "ai.explain", outcome: "not-started", reason: "no-page-measurements" };

  const captured = await captureLog(() => {
    for (let index = 0; index <= ONCE_LIMIT; index += 1) logOutcomeOnce(`key-${index}`, event);
    logOutcomeOnce(`key-${ONCE_LIMIT}`, event); // recent: still remembered
    logOutcomeOnce("key-0", event); // the oldest: forgotten, so written again
  });

  assert.equal(captured.lines.length, ONCE_LIMIT + 2);
  resetLoggedOnce();
});

// ---------------------------------------------------------------------------
// Describing an error without repeating it
// ---------------------------------------------------------------------------

const SECRETS = [
  "https://client.example/checkout?token=abc123",
  "ana@harbourdental.example",
  "sk_live_0123456789",
  "Harbour Dental",
];

/** A class that names itself after construction, as most custom errors do. */
class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlError";
  }
}

test("an error is described by its class name and nothing else", () => {
  assert.equal(describeError(new TypeError("anything")), "TypeError");
  assert.equal(describeError(new RangeError("anything")), "RangeError");
  assert.equal(describeError(new Error("anything")), "Error");
  assert.equal(describeError(new CrawlError("anything")), "CrawlError");
});

test("a description is only ever a plain class name", () => {
  const thrown: unknown[] = [
    new TypeError(SECRETS.join(" ")),
    new CrawlError(`could not read ${SECRETS[0]}`),
    SECRETS[0],
    { url: SECRETS[0] },
    42,
    null,
    undefined,
  ];

  for (const value of thrown) {
    assert.match(describeError(value), /^[A-Z][A-Za-z0-9]{0,40}$/);
  }
});

test("an error's message is never part of its description", () => {
  for (const secret of SECRETS) {
    assert.equal(describeError(new Error(`Could not read ${secret} after 3 tries`)), "Error");
  }
});

test("nothing is taken from the stack: no file, no line number, no text", () => {
  const error = new TypeError("x");
  const described = describeError(error);

  assert.equal(described, "TypeError");
  for (const forbidden of ["reliabilityLog", ".mts", ".ts", ".js", ":", "/", "\\", " at ", " "]) {
    assert.ok(!described.includes(forbidden), `${JSON.stringify(forbidden)} is not in the description`);
  }
});

test("a stack is not read, whatever it says", () => {
  const stacks = [
    "Error: x\n    at run (/srv/harbour-dental.js:1:1)",
    "Error: x\n    at fetch (https://client.example/app.js?token=abc:1:1)",
    "ana@harbourdental.example sk_live_0123456789",
    "",
  ];

  for (const stack of stacks) {
    const error = new Error("x");
    Object.defineProperty(error, "stack", { value: stack });
    assert.equal(describeError(error), "Error");
  }
});

test("a stack that would throw if it were read is never read", () => {
  const error = new RangeError("x");
  let reads = 0;
  Object.defineProperty(error, "stack", {
    get() {
      reads += 1;
      throw new Error("no stack for you");
    },
  });

  assert.equal(describeError(error), "RangeError");
  assert.equal(reads, 0, "the stack was not touched");
});

test("a message written to look like a stack trace changes nothing", () => {
  // The case that made reading the stack unsafe: text shaped like a frame,
  // inside a message that is shortened after the stack was first read.
  const forged = new Error("A\n    at evil (/srv/harbour-dental.js:1:1)");
  void forged.stack;
  forged.message = "A";

  assert.equal(describeError(forged), "Error");
});

test("a class name that is not a plain name is replaced", () => {
  for (const name of ["https://client.example/", "Type Error", "x", "", "A".repeat(60), "Err<script>", "ana@x.io", "a.js:1"]) {
    const error = new Error("m");
    error.name = name;
    assert.equal(describeError(error), "Error", JSON.stringify(name));
  }
});

test("a name that is not a string is replaced", () => {
  for (const name of [42, null, undefined, { toString: () => "https://client.example/" }, ["TypeError"]]) {
    const error = new Error("m");
    Object.defineProperty(error, "name", { value: name });
    assert.equal(describeError(error), "Error");
  }
});

test("something thrown that is not an error is called an error and is not printed", () => {
  for (const thrown of ["https://client.example/ failed", { url: "https://client.example/", name: "TypeError" }, 42, null, undefined]) {
    assert.equal(describeError(thrown), "Error");
  }
});

test("describing an error never throws, even when its name cannot be read", () => {
  const hostile = new Error("x");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("https://client.example/ must not be printed");
    },
  });
  const revoked = Proxy.revocable(new Error("x"), {});
  revoked.revoke();

  assert.equal(describeError(hostile), "Error");
  assert.doesNotThrow(() => describeError(revoked.proxy));
  assert.equal(describeError(revoked.proxy), "Error");
});

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

test("the logger imports nothing and reads no environment", () => {
  const source = fs
    .readFileSync(new URL("./reliabilityLog.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  assert.ok(!/^\s*import /m.test(source), "no import: it can pull nothing in");
  for (const forbidden of ["process.env", "fetch(", "writeFile", "require(", "console.warn", "console.error", ".stack", ".message"]) {
    assert.ok(!source.includes(forbidden), `must not reach ${forbidden}`);
  }
  assert.equal(source.split("console.log").length - 1, 1, "and it writes in exactly one place");
});

// ---------------------------------------------------------------------------
// The HTTP status of a failed explanation (Step 1: written before the code)
//
// A failed `ai.explain` line may carry the provider's numeric HTTP status, so a
// "provider-error" can be told apart as 500, 503 or 504. Only a whole number
// from 100 to 599, only on a failed explanation, and never anything else the
// provider said.
// ---------------------------------------------------------------------------

test("a failed explanation line carries its HTTP status", async () => {
  const captured = await lineOf(loose({ op: "ai.explain", job: JOB, outcome: "failed", reason: "provider-error", ms: 1779, status: 503 }));

  assert.equal(captured.lines.length, 1);
  assert.equal(captured.lines[0].status, 503);
  assert.equal(captured.lines[0].reason, "provider-error");
});

test("an HTTP status that is not a whole number from 100 to 599 is never written", async () => {
  for (const bad of [99, 600, 503.5, -1, "503", null, Number.NaN]) {
    const captured = await lineOf(loose({ op: "ai.explain", outcome: "failed", reason: "provider-error", status: bad }));

    assert.equal(captured.lines.length, 1, `the line is still written for ${String(bad)}`);
    assert.ok(!("status" in captured.lines[0]), `status ${JSON.stringify(bad)} was written`);
  }
});

test("an HTTP status is written only on a failed explanation", async () => {
  const succeeded = await lineOf(loose({ op: "ai.explain", outcome: "succeeded", accepted: 3, rejected: 0, status: 200 }));
  const otherOperation = await lineOf(loose({ op: "pdf.render", outcome: "failed", reason: "timed-out", status: 503 }));

  assert.ok(!("status" in succeeded.lines[0]), "a success carries no status");
  assert.ok(!("status" in otherOperation.lines[0]), "no other operation carries one");
});
