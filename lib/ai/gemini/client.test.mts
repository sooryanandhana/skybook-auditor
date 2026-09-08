/**
 * Tests for the key, and for the object that holds it.
 *
 * Two properties matter here and neither is about talking to anybody.
 *
 * A MISSING KEY IS A STATE, NOT A FAILURE. The project already has this word:
 * the speed check reports `no-api-key` and means "nothing was attempted". An
 * audit with no key configured must be a complete audit that was not
 * explained, and nothing here may throw to say so.
 *
 * THE KEY DOES NOT ESCAPE. Not into a return value, not into a reason, not
 * into an error. The SDK's own client carries it as an own enumerable
 * property, which is the reason this module is shaped the way it is, and one
 * of the tests below pins that behaviour so the shape cannot be tidied away by
 * somebody who does not know why it exists.
 *
 * Nothing here reaches the network. Constructing a client performs no request,
 * and no test asks the client to do anything.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import util from "node:util";
import { geminiAvailability, geminiClient, resetGeminiClients } from "./client.ts";
import { GEMINI_API_KEY_VARIABLE, GEMINI_MODEL } from "./config.ts";

const SECRET = "AIzaTEST-SECRET-KEY-DO-NOT-LEAK";

/** Runs with the environment key set to `value`, then puts it back. */
function withEnvKey(value: string | undefined, run: () => void): void {
  const before = process.env[GEMINI_API_KEY_VARIABLE];
  if (value === undefined) delete process.env[GEMINI_API_KEY_VARIABLE];
  else process.env[GEMINI_API_KEY_VARIABLE] = value;
  resetGeminiClients();
  try {
    run();
  } finally {
    if (before === undefined) delete process.env[GEMINI_API_KEY_VARIABLE];
    else process.env[GEMINI_API_KEY_VARIABLE] = before;
    resetGeminiClients();
  }
}

// ---------------------------------------------------------------------------
// No key is a state
// ---------------------------------------------------------------------------

test("with no key configured, nothing throws and nothing is available", () => {
  withEnvKey(undefined, () => {
    const availability = geminiAvailability();

    assert.equal(availability.configured, false);
    assert.equal(geminiClient(), null);
  });
});

test("an empty or blank key is the same as no key at all", () => {
  for (const value of ["", "   ", "\n\t "]) {
    withEnvKey(value, () => {
      assert.equal(geminiAvailability().configured, false, JSON.stringify(value));
      assert.equal(geminiClient(), null);
    });
  }
});

test("the reason says the key is MISSING, names the variable, and quotes no value", () => {
  /*
   * The specific wording is asserted, not merely that a reason exists. "No key
   * is set" and "the key does not work" call for different actions from
   * whoever runs this, and a check that accepts either would let one be
   * reported as the other.
   */
  withEnvKey(undefined, () => {
    const availability = geminiAvailability();

    assert.equal(availability.configured, false);
    if (availability.configured) return;
    assert.match(availability.reason, new RegExp(`^No ${GEMINI_API_KEY_VARIABLE} is configured`));
    assert.match(availability.reason, /audit itself is unaffected/);
  });
});

test("a key with space around it is still a key", () => {
  withEnvKey(`  ${SECRET}  `, () => {
    assert.equal(geminiAvailability().configured, true);
    assert.notEqual(geminiClient(), null);
  });
});

test("a configured key reports the model that will be asked", () => {
  withEnvKey(SECRET, () => {
    const availability = geminiAvailability();

    assert.equal(availability.configured, true);
    if (!availability.configured) return;
    assert.equal(availability.model, GEMINI_MODEL);
  });
});

// ---------------------------------------------------------------------------
// The key does not escape
// ---------------------------------------------------------------------------

test("the availability a caller may log carries no key", () => {
  withEnvKey(SECRET, () => {
    const availability = geminiAvailability();

    assert.ok(!JSON.stringify(availability).includes(SECRET));
    assert.ok(!util.inspect(availability, { depth: 6 }).includes(SECRET));
  });
});

test("the availability carries no client either, which is the point", () => {
  /*
   * THE REASON THIS MODULE HAS TWO FUNCTIONS INSTEAD OF ONE STATE.
   *
   * The test below proves the SDK's client reproduces the key when printed. If
   * the loggable state carried the client, the key would be one console.log
   * away — and debugging is exactly when somebody prints a state object.
   */
  withEnvKey(SECRET, () => {
    const availability = geminiAvailability();

    assert.deepEqual(Object.keys(availability).sort(), ["configured", "model"]);
  });
});

test("the SDK client really does reproduce the key when printed", () => {
  /*
   * Not our behaviour, but the reason for ours. Pinned so that if a future SDK
   * stops doing this, the split above can be revisited deliberately rather
   * than kept out of superstition — and so it is not removed while it is still
   * true.
   */
  withEnvKey(SECRET, () => {
    const client = geminiClient();
    assert.notEqual(client, null);

    assert.ok(
      JSON.stringify(client).includes(SECRET) || util.inspect(client, { depth: 4 }).includes(SECRET),
      "if this ever fails, the SDK has changed and this module can be simplified",
    );
  });
});

test("the SDK is never handed a blank key, so it never complains to the console", () => {
  /*
   * WHAT THIS IS REALLY GUARDING. Version 2.21.0 writes "API key should be set
   * when using the Gemini API" straight to the console when constructed with
   * nothing usable. This module returns before constructing in that case, so
   * that line never appears -- and a log line about a key is the beginning of
   * a log line containing one.
   */
  const printed: string[] = [];
  const real = { warn: console.warn, log: console.log, error: console.error };
  console.warn = (...args: unknown[]) => printed.push(args.join(" "));
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  console.error = (...args: unknown[]) => printed.push(args.join(" "));

  try {
    for (const blank of ["", "   ", "\n\t "]) {
      withEnvKey(blank, () => {
        assert.equal(geminiClient(), null);
        assert.equal(geminiAvailability().configured, false);
      });
    }
  } finally {
    console.warn = real.warn;
    console.log = real.log;
    console.error = real.error;
  }

  assert.deepEqual(printed, [], "nothing was printed while refusing a blank key");
});

test("an odd but non-empty key is accepted here, because judging it is not this job", () => {
  /*
   * Checked against the SDK rather than assumed: version 2.21.0 validates
   * nothing at construction, for a key of any shape. Whether a key WORKS is
   * answered by a request, and that belongs to the adapter. Deciding it here
   * would be a check that cannot fail, dressed as one that can.
   */
  for (const odd of ["not-a-key", "a".repeat(5_000)]) {
    withEnvKey(odd, () => {
      assert.equal(geminiAvailability().configured, true, odd.slice(0, 12));
      assert.notEqual(geminiClient(), null);
    });
  }
});

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

test("the same key gets the same client rather than a new one each time", () => {
  withEnvKey(SECRET, () => {
    assert.equal(geminiClient(), geminiClient());
  });
});

test("a caller supplying its own key never receives the environment's client", () => {
  withEnvKey(SECRET, () => {
    const fromEnvironment = geminiClient();
    const fromCaller = geminiClient({ apiKey: "AIzaDIFFERENT-KEY" });

    assert.notEqual(fromCaller, null);
    assert.notEqual(fromCaller, fromEnvironment);
  });
});

test("a caller's own key answers even when the environment has none", () => {
  withEnvKey(undefined, () => {
    assert.equal(geminiAvailability({ apiKey: SECRET }).configured, true);
    assert.notEqual(geminiClient({ apiKey: SECRET }), null);
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

function sourceOf(file: string): string {
  return fs
    .readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the key is never written to a log, and never built into a message", () => {
  const source = sourceOf("./client.ts");

  assert.ok(!/console\./.test(source), "nothing here logs");
  assert.ok(!/\$\{apiKey\}|\+\s*apiKey|apiKey\s*\+/.test(source), "the key is never interpolated");
});

test("the variable is read from the server environment and is never public", () => {
  const source = sourceOf("./client.ts");

  assert.ok(!/NEXT_PUBLIC/.test(source), "that prefix is what puts a value in the browser");
  assert.match(source, /process\.env\[GEMINI_API_KEY_VARIABLE\]/);
});

test("this module talks to nobody; it only builds the thing that could", () => {
  const source = sourceOf("./client.ts");

  assert.ok(!/\bfetch\s*\(/.test(source), "no request is made here");
  assert.ok(!/await|async/.test(source), "and nothing here is even asynchronous");
});

test("the settings carry a model and a variable name, and no key", () => {
  const source = sourceOf("./config.ts");

  assert.match(source, /GEMINI_MODEL = "gemini-/);
  assert.ok(!/AIza|apiKey\s*=/.test(source), "no key material belongs in configuration");
  assert.ok(!/process\.env/.test(source), "reading the environment is the client's job");
});

test("nothing outside this folder imports the provider", () => {
  /*
   * The contract, the builder and the validator are provider-neutral, and the
   * whole architecture rests on them staying that way. This is what stops an
   * import creeping upward the day somebody needs one small thing.
   */
  const root = new URL("../../../lib/", import.meta.url);
  const offenders: string[] = [];

  const walk = (dir: URL): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) {
        if (entry.name !== "gemini") walk(child);
        continue;
      }
      if (!/\.(ts|mts)$/.test(entry.name)) continue;
      const source = fs.readFileSync(child, "utf8");
      /*
       * IMPORTS ONLY, not mentions. Several files name the SDK in order to
       * forbid it — the explanation contract's own test lists it among the
       * things that must never appear there — and a check that cannot tell
       * those apart would flag the guards as the problem.
       */
      if (/from\s+["'][^"']*(@google\/genai|gemini\/(client|config))/.test(source)) {
        offenders.push(entry.name);
      }
    }
  };

  walk(root);
  assert.deepEqual(offenders, [], "only lib/ai/gemini may know a provider exists");
});
