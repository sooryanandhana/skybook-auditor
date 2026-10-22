/**
 * Tests for the management setup command's hidden password prompt.
 *
 * NO TERMINAL, NO DATABASE. Keystrokes are fed to the pure input reader as the
 * chunks a raw-mode terminal can deliver, and the command runs with fake
 * dependencies that record whether anything reached account creation.
 *
 * PASSWORDS ARE NEVER PRINTED. Comparisons use `same()`, which fails with a
 * label rather than with the two values, so a failing run shows no password.
 */
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  checkPasswordEntries,
  feedPasswordInput,
  readHiddenWith,
  runSetup,
  startPasswordInput,
  type HiddenEntry,
  type PasswordInput,
  type SetupDeps,
  type TerminalInput,
  type TerminalOutput,
} from "./setupManagement.cli.mts";
import type { SetupResult } from "./setupManagement.ts";

/** Equality that reports a label, never the values. */
function same(actual: unknown, expected: unknown, label: string): void {
  assert.ok(actual === expected, label);
}

/** Feeds chunks in order, as separate data events. */
function feed(chunks: readonly string[], options: { skipLeadingLf?: boolean } = {}): PasswordInput {
  return chunks.reduce(feedPasswordInput, startPasswordInput(options));
}

const GOOD = "correct-horse-battery";

/* ---------------------------------------------------------------------------
   Reading keystrokes
   --------------------------------------------------------------------------- */

test("typing one key at a time, then Enter, gives exactly what was typed", () => {
  const state = feed([...GOOD, "\r"]);
  assert.ok(state.done && !state.cancelled, "finished");
  same(state.value, GOOD, "typed password read exactly");
});

test("pasted text followed by Enter in the same chunk is read without the Enter", () => {
  const state = feed([`${GOOD}\r`]);
  assert.ok(state.done, "the Enter inside the paste ends the entry");
  same(state.value, GOOD, "no line ending kept in the password");
});

test("pasted text, then Enter as its own event", () => {
  const state = feed([GOOD, "\r"]);
  same(state.value, GOOD, "paste then Enter");
});

test("CR, LF and CRLF each end the entry and none is kept", () => {
  for (const [label, ending] of [["CR", "\r"], ["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    const state = feed([`${GOOD}${ending}`]);
    assert.ok(state.done, `${label} ends the entry`);
    same(state.value, GOOD, `${label} not kept`);
  }
  assert.ok(feed([`${GOOD}\r\n`]).endedWithCr, "a CRLF entry is marked as ending on CR");
  assert.ok(!feed([`${GOOD}\n`]).endedWithCr, "an LF entry is not");
});

test("the LF left over from a CRLF does not end the confirmation entry", () => {
  const confirmation = feed(["\n", GOOD, "\r"], { skipLeadingLf: true });
  same(confirmation.value, GOOD, "leading LF skipped once");

  const notSkipped = feed(["\n", GOOD, "\r"]);
  assert.ok(notSkipped.done && notSkipped.value === "", "without the flag an LF is an Enter");
});

test("Backspace in the middle removes one character per press", () => {
  same(feed(["a", "b", "x", "\u007f", "c", "\r"]).value, "abc", "DEL removes one");
  same(feed(["a", "b", "x", "\b", "c", "\r"]).value, "abc", "BS removes one");
  same(feed(["abx\u007fc\r"]).value, "abc", "Backspace inside a chunk");
});

test("several Backspaces in one chunk are all applied", () => {
  same(feed(["abcd", "\u007f\u007f", "\r"]).value, "ab", "two in one chunk");
  same(feed(["ab", "\u007f\u007f\u007f\u007f", "\r"]).value, "", "never below empty");
});

test("Backspace removes a whole character, not half of one", () => {
  same(feed(["pass😀", "\u007f", "\r"]).value, "pass", "emoji removed whole");
});

test("Enter on its own gives an empty entry", () => {
  const state = feed(["\r"]);
  assert.ok(state.done && state.value === "", "empty");
});

test("Ctrl+C cancels on its own and inside a chunk", () => {
  assert.ok(feed(["a", "\u0003"]).cancelled, "on its own");
  const inChunk = feed(["ab\u0003cd\r"]);
  assert.ok(inChunk.cancelled && !inChunk.done, "inside a chunk, before Enter");
});

test("arrow keys and other escape sequences are skipped whole", () => {
  same(feed(["ab", "\u001b[D", "c", "\r"]).value, "abc", "left arrow");
  same(feed(["ab\u001b[1;5Cc\r"]).value, "abc", "ctrl+right, inside a chunk");
  same(feed(["ab", "\u001b", "[", "A", "c", "\r"]).value, "abc", "split across chunks");
  same(feed(["ab\u001bOPc\r"]).value, "abc", "F1 (SS3)");
  same(feed(["ab\u001b[3~c\r"]).value, "abc", "Delete key");
});

/* ---------------------------------------------------------------------------
   Escape: a lone press, sequences cut short, sequences split across chunks
   --------------------------------------------------------------------------- */

test("a lone Escape followed by ordinary text and Enter keeps every character", () => {
  same(feed(["\u001b", "abc", "\r"]).value, "abc", "separate chunks");
  same(feed(["\u001babc\r"]).value, "abc", "one chunk");
  same(feed(["pass", "\u001b", "word", "\r"]).value, "password", "in the middle");
});

test("a lone Escape followed by Enter ends the entry", () => {
  const state = feed(["ab", "\u001b", "\r"]);
  assert.ok(state.done && state.value === "ab", "Enter is not swallowed");
});

test("a lone Escape followed by Ctrl+C cancels", () => {
  assert.ok(feed(["ab", "\u001b", "\u0003"]).cancelled, "separate chunks");
  assert.ok(feed(["ab\u001b\u0003"]).cancelled, "one chunk");
});

test("a lone Escape followed by Backspace still deletes", () => {
  same(feed(["ab", "\u001b", "\u007f", "\r"]).value, "a", "Backspace is not swallowed");
});

test("two Escapes in a row, then a real sequence, then text", () => {
  same(feed(["\u001b", "\u001b", "[", "A", "x", "\r"]).value, "x", "only the sequence is skipped");
});

test("an incomplete CSI sequence followed by Enter ends the entry", () => {
  const cut = feed(["ab", "\u001b[", "\r"]);
  assert.ok(cut.done && cut.value === "ab", "after ESC [");
  const withParams = feed(["ab\u001b[1;", "\r"]);
  assert.ok(withParams.done && withParams.value === "ab", "after ESC [ 1 ;");
});

test("an incomplete CSI sequence followed by Ctrl+C cancels", () => {
  assert.ok(feed(["ab", "\u001b[1", "\u0003"]).cancelled, "separate chunks");
  assert.ok(feed(["ab\u001b[\u0003"]).cancelled, "one chunk");
});

test("an incomplete SS3 sequence followed by Enter ends the entry", () => {
  const state = feed(["ab\u001bO", "\r"]);
  assert.ok(state.done && state.value === "ab", "Enter is not swallowed");
});

test("escape sequences split across chunks are skipped whole", () => {
  same(feed(["a", "\u001b", "[", "1", ";", "5", "C", "b", "\r"]).value, "ab", "CSI one byte per chunk");
  same(feed(["a\u001b[", "3~b\r"]).value, "ab", "Delete key split after ESC [");
  same(feed(["a\u001b", "O", "P", "b\r"]).value, "ab", "F1 split after ESC");
  same(feed(["a\u001bO", "Pb\r"]).value, "ab", "F1 split after ESC O");
});

test("several ordinary characters after a sequence that was cut short are all kept", () => {
  same(feed(["\u001b", "xyz", "\r"]).value, "xyz", "after a lone Escape");
  same(feed(["\u001b[", "éxy", "\r"]).value, "éxy", "after ESC [ and a character no sequence can hold");
  same(feed(["\u001bO", "\tqrs", "\r"]).value, "qrs", "after ESC O and a control character");
});

test("a character that completes a valid sequence is not taken as password input", () => {
  // ESC [ a is a complete CSI sequence (final byte "a"), so the "a" belongs to
  // it; only what follows is typed text.
  same(feed(["\u001b[", "abc", "\r"]).value, "bc", "ESC [ a is one sequence");
  same(feed(["\u001bO", "Pqr", "\r"]).value, "qr", "ESC O P is one sequence");
});

test("other control characters are ignored one at a time, keeping the rest", () => {
  same(feed([`\t${GOOD}\r`]).value, GOOD, "a leading Tab no longer drops the chunk");
  same(feed(["ab\u0004c\u0000d\r"]).value, "abcd", "Ctrl+D and NUL ignored");
});

test("nothing after Enter is taken", () => {
  const state = feed([`${GOOD}\rextra`, "more\r"]);
  same(state.value, GOOD, "text after Enter ignored");
});

/* ---------------------------------------------------------------------------
   The checks before the database
   --------------------------------------------------------------------------- */

test("matching entries of the minimum length pass", () => {
  const checked = checkPasswordEntries(GOOD, GOOD);
  assert.ok(checked.ok && checked.password === GOOD, "accepted");
});

test("empty, mismatched and short entries are refused, with no password in the message", () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["", "", /cannot be empty/],
    [GOOD, `${GOOD}x`, /did not match/],
    ["short-pw", "short-pw", /at least 10 characters/],
  ];
  for (const [first, second, expected] of cases) {
    const checked = checkPasswordEntries(first, second);
    assert.ok(!checked.ok, "refused");
    if (checked.ok) continue;
    assert.match(checked.message, expected);
    assert.ok(first === "" || !checked.message.includes(first), "the message does not quote the password");
  }
});

/* ---------------------------------------------------------------------------
   The command, with fakes
   --------------------------------------------------------------------------- */

interface Recorded {
  deps: SetupDeps;
  created: number;
  closed: number;
  prompts: number;
  errors: string[];
  logs: string[];
}

function fakes(entries: HiddenEntry[], result: SetupResult = { ok: true, email: "boss@skybook.example" }): Recorded {
  const record: Recorded = {
    created: 0,
    closed: 0,
    prompts: 0,
    errors: [],
    logs: [],
    deps: undefined as unknown as SetupDeps,
  };
  record.deps = {
    readHidden: async () => {
      const next = entries[record.prompts++];
      if (next === undefined) throw new Error("no more input in this test");
      return next;
    },
    create: async () => {
      record.created++;
      return result;
    },
    closePool: async () => {
      record.closed++;
    },
    log: (line) => record.logs.push(line),
    error: (line) => record.errors.push(line),
  };
  return record;
}

const entry = (value: string, endedWithCr = true): HiddenEntry => ({ value, endedWithCr });

test("matching passwords reach account creation once, and the pool is closed", async () => {
  const run = fakes([entry(GOOD), entry(GOOD)]);
  const code = await runSetup(["boss@skybook.example"], run.deps);

  same(code, 0, "exit 0");
  same(run.prompts, 2, "asked twice");
  same(run.created, 1, "created once");
  same(run.closed, 1, "pool closed");
  assert.ok(run.logs.some((line) => line.includes("Created a MANAGEMENT account")), "says so");
});

test("mismatched passwords never reach account creation or the database", async () => {
  const run = fakes([entry(GOOD), entry(`${GOOD}!`)]);
  const code = await runSetup(["boss@skybook.example"], run.deps);

  same(code, 1, "exit 1");
  same(run.created, 0, "nothing created");
  same(run.closed, 0, "no pool was opened, so none closed");
  assert.match(run.errors.join("\n"), /did not match/);
});

test("a password shorter than 10 characters is refused before the database", async () => {
  const run = fakes([entry("abc123xyz"), entry("abc123xyz")]);
  const code = await runSetup(["boss@skybook.example"], run.deps);

  same(code, 1, "exit 1");
  same(run.created, 0, "nothing created");
  assert.match(run.errors.join("\n"), /at least 10 characters/);
});

test("an empty password is refused before the database", async () => {
  const run = fakes([entry(""), entry("")]);
  same(await runSetup(["boss@skybook.example"], run.deps), 1, "exit 1");
  same(run.created, 0, "nothing created");
});

test("a cancelled or failed prompt stops the command before the database", async () => {
  const run = fakes([]);
  same(await runSetup(["boss@skybook.example"], run.deps), 1, "exit 1");
  same(run.created, 0, "nothing created");
  same(run.errors.length, 1, "one message");
});

test("an invalid email is refused before any prompt", async () => {
  const run = fakes([entry(GOOD), entry(GOOD)]);
  same(await runSetup(["not-an-email"], run.deps), 1, "exit 1");
  same(run.prompts, 0, "never asked for a password");
  same(run.created, 0, "nothing created");
});

test("no email prints the usage and asks nothing", async () => {
  const run = fakes([]);
  same(await runSetup([], run.deps), 1, "exit 1");
  same(run.prompts, 0, "never asked");
  assert.match(run.errors.join("\n"), /Usage: npm run setup:management -- <email>/);
});

test("a password on the command line is refused, not silently ignored", async () => {
  const typedOnCommandLine = "typed-on-the-command-line";
  const run = fakes([entry(GOOD), entry(GOOD)]);
  same(await runSetup(["boss@skybook.example", typedOnCommandLine], run.deps), 1, "exit 1");
  same(run.prompts, 0, "never asked");
  same(run.created, 0, "nothing created");
  assert.ok(!run.errors.join("\n").includes(typedOnCommandLine), "the message does not repeat it");
});

test("a refusal from account creation is reported and the pool still closed", async () => {
  const run = fakes([entry(GOOD), entry(GOOD)], {
    ok: false,
    reason: "exists",
    message: "An account already exists for that email address.",
  });
  same(await runSetup(["boss@skybook.example"], run.deps), 1, "exit 1");
  same(run.created, 1, "attempted once");
  same(run.closed, 1, "pool closed");
  assert.match(run.errors.join("\n"), /already exists/);
});

test("the confirmation prompt is told to skip the LF of a CRLF", async () => {
  const seen: boolean[] = [];
  const run = fakes([]);
  const answers = [entry(GOOD, true), entry(GOOD, false)];
  const deps: SetupDeps = {
    ...run.deps,
    readHidden: async (_prompt, options) => {
      seen.push(options.skipLeadingLf);
      return answers[seen.length - 1];
    },
  };
  await runSetup(["boss@skybook.example"], deps);
  assert.deepEqual(seen, [false, true]);
});

/* ---------------------------------------------------------------------------
   The terminal reader, against a simulated terminal
   --------------------------------------------------------------------------- */

/** A stand-in for a TTY's input: records raw-mode changes and pausing. */
class FakeInput extends EventEmitter implements TerminalInput {
  isTTY = true;
  readonly rawModes: boolean[] = [];
  paused = true;
  failOnRestore = false;

  setRawMode(mode: boolean): this {
    if (!mode && this.failOnRestore) throw new Error("the stream is already destroyed");
    this.rawModes.push(mode);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  get attached(): number {
    return this.listenerCount("data") + this.listenerCount("end") + this.listenerCount("error");
  }
  get rawNow(): boolean {
    return this.rawModes.at(-1) ?? false;
  }
}

/** A stand-in for a TTY's output: keeps everything written. */
class FakeOutput implements TerminalOutput {
  isTTY = true;
  readonly written: string[] = [];
  write(text: string): boolean {
    this.written.push(text);
    return true;
  }
}

const PROMPT = "Management account password: ";

function terminal() {
  return { input: new FakeInput(), output: new FakeOutput() };
}

/** Lets pending promise callbacks run, so a reader can attach or settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Waits until a reader is listening, then delivers the chunks one event each. */
async function type(input: FakeInput, chunks: readonly string[]): Promise<void> {
  for (let i = 0; i < 50 && input.listenerCount("data") === 0; i++) await tick();
  assert.ok(input.listenerCount("data") === 1, "a reader is listening");
  for (const chunk of chunks) input.emit("data", chunk);
}

/** Raw mode was switched on, then off; nothing is listening; input is paused. */
function assertRestored(input: FakeInput, label: string): void {
  assert.ok(input.rawModes[0] === true, `${label}: raw mode was switched on`);
  assert.ok(!input.rawNow, `${label}: raw mode is off again`);
  same(input.attached, 0, `${label}: every listener removed`);
  assert.ok(input.paused, `${label}: input paused`);
}

test("terminal: Enter returns the entry, restores the terminal and echoes nothing typed", async () => {
  const { input, output } = terminal();
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["correct-", "horse-battery\r"]);
  const result = await reading;

  same(result.value, "correct-horse-battery", "entry read");
  assert.ok(result.endedWithCr, "ended on CR");
  assertRestored(input, "Enter");
  // Compared with same(), not deepEqual, so a failure cannot print what was echoed.
  same(output.written.length, 2, "exactly two writes: the prompt and a line break");
  same(output.written[0], PROMPT, "the first write is the prompt");
  same(output.written[1], "\n", "the second write is a line break, not a typed character");
});

test("terminal: Ctrl+C rejects and restores the terminal", async () => {
  const { input, output } = terminal();
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["abc", "\u0003"]);

  await assert.rejects(reading, /cancelled/);
  assertRestored(input, "Ctrl+C");
});

test("terminal: end of input rejects and restores the terminal", async () => {
  const { input, output } = terminal();
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["abc"]);
  input.emit("end");

  await assert.rejects(reading, /Input ended/);
  assertRestored(input, "EOF");
});

test("terminal: a read error rejects and restores the terminal", async () => {
  const { input, output } = terminal();
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["abc"]);
  input.emit("error", new Error("EIO"));

  await assert.rejects(reading, /could not be read/);
  assertRestored(input, "error");
});

test("terminal: a stream that refuses to leave raw mode still has its listeners removed", async () => {
  const { input, output } = terminal();
  input.failOnRestore = true;
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["abc\r"]);

  same((await reading).value, "abc", "the entry still completes");
  same(input.attached, 0, "every listener removed");
});

test("terminal: not a TTY is refused without touching raw mode", async () => {
  const { input, output } = terminal();
  input.isTTY = false;

  await assert.rejects(readHiddenWith(input, output, PROMPT, { skipLeadingLf: false }), /interactive terminal/);
  same(input.rawModes.length, 0, "raw mode never switched on");
  same(input.attached, 0, "nothing attached");

  const piped = terminal();
  piped.output.isTTY = false;
  await assert.rejects(readHiddenWith(piped.input, piped.output, PROMPT, { skipLeadingLf: false }), /interactive terminal/);
  same(piped.input.rawModes.length, 0, "raw mode never switched on for piped output");
});

test("terminal: an escape sequence split across events is skipped whole", async () => {
  const { input, output } = terminal();
  const reading = readHiddenWith(input, output, PROMPT, { skipLeadingLf: false });
  await type(input, ["ab", "\u001b", "[", "D", "c\r"]);
  same((await reading).value, "abc", "arrow key skipped");
});

/* ---------------------------------------------------------------------------
   The whole command, through the simulated terminal
   --------------------------------------------------------------------------- */

/** runSetup reading from the simulated terminal, with a recording `create`. */
function commandOn(input: FakeInput, output: FakeOutput) {
  const record = { created: 0, closed: 0, passwordMatched: false, errors: [] as string[] };
  const deps: SetupDeps = {
    readHidden: (prompt, options) => readHiddenWith(input, output, prompt, options),
    create: async (_email, password) => {
      record.created++;
      record.passwordMatched = password === GOOD;
      return { ok: true, email: "boss@skybook.example" };
    },
    closePool: async () => {
      record.closed++;
    },
    log: () => {},
    error: (line) => record.errors.push(line),
  };
  return { record, run: runSetup(["boss@skybook.example"], deps) };
}

test("command: CRLF on the first entry, its LF arriving at the second prompt, still matches", async () => {
  const { input, output } = terminal();
  const { record, run } = commandOn(input, output);
  await type(input, [`${GOOD}\r`]);
  await tick();
  await type(input, ["\n", `${GOOD}\r`]);

  same(await run, 0, "exit 0");
  same(record.created, 1, "created once");
  assert.ok(record.passwordMatched, "the password created is exactly the one typed");
  same(record.closed, 1, "pool closed");
  assertRestored(input, "after both prompts");
  assert.deepEqual(input.rawModes, [true, false, true, false], "raw mode on and off once per prompt");
});

test("command: an Escape pressed in only one entry no longer causes a mismatch", async () => {
  const { input, output } = terminal();
  const { record, run } = commandOn(input, output);
  await type(input, ["\u001b", `${GOOD}\r`]);
  await tick();
  await type(input, [`${GOOD}\r`]);

  same(await run, 0, "exit 0");
  assert.ok(record.passwordMatched, "the Escape cost no character");
});

test("command: entries that differ through the terminal never reach account creation", async () => {
  const { input, output } = terminal();
  const { record, run } = commandOn(input, output);
  await type(input, [`${GOOD}\r`]);
  await tick();
  await type(input, [`${GOOD}x\r`]);

  same(await run, 1, "exit 1");
  same(record.created, 0, "nothing created");
  same(record.closed, 0, "no pool to close");
  assert.match(record.errors.join("\n"), /did not match/);
  assertRestored(input, "after a mismatch");
});

test("command: Ctrl+C at the second prompt stops before account creation", async () => {
  const { input, output } = terminal();
  const { record, run } = commandOn(input, output);
  await type(input, [`${GOOD}\r`]);
  await tick();
  await type(input, ["abc\u0003"]);

  same(await run, 1, "exit 1");
  same(record.created, 0, "nothing created");
  assertRestored(input, "after Ctrl+C");
});

test("importing the command for a test does not run it", () => {
  // If the module had run on import it would have printed the usage or the
  // terminal refusal and set an exit code; reaching this line with none set
  // is the evidence.
  same(process.exitCode ?? 0, 0, "no exit code set by importing");
});
