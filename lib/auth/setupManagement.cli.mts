/**
 * `npm run setup:management -- <email>`
 *
 * Creates the first MANAGEMENT account from the command line, once. The email
 * is the only argument; the password is asked for twice at a hidden prompt, so
 * it never appears in shell history or in the process list. It reads
 * DATABASE_URL, creates the account, and prints the outcome — never the password
 * or the hash — then closes the pool so node exits. Any refusal exits non-zero,
 * so a script can tell it did not create the account.
 *
 * NOTHING REACHES THE DATABASE until the email is valid and both entries match
 * and meet the minimum length. A mistyped or mangled password is refused here,
 * not saved: this command only creates, so a wrong password on the first
 * manager could not be corrected through it afterwards.
 */
import path from "node:path";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { closePool, getPool } from "../db/pool.ts";
import { isAcceptablePassword, isValidEmail, MIN_PASSWORD_LENGTH } from "./registerRoute.ts";
import { createManagementAccount, type SetupResult } from "./setupManagement.ts";

/* ---------------------------------------------------------------------------
   Reading keystrokes
   --------------------------------------------------------------------------- */

/**
 * Where one hidden entry has got to.
 *
 * A terminal in raw mode delivers input in chunks, and a chunk is NOT one key:
 * a paste, fast typing or a remote session can put several characters -- Enter
 * included -- into a single event. So input is read one character at a time,
 * and this state carries everything that has to survive between chunks.
 */
export interface PasswordInput {
  readonly value: string;
  /** Enter was pressed. Anything after it is ignored. */
  readonly done: boolean;
  /** Ctrl+C was pressed. Nothing is returned. */
  readonly cancelled: boolean;
  /** Whether the entry ended on a CR, so a following LF belongs to that Enter. */
  readonly endedWithCr: boolean;
  /** Part-way through a terminal escape sequence (an arrow key, say). */
  readonly escape: "none" | "esc" | "csi" | "ss3";
  /** Swallow one LF at the very start: the tail of the previous entry's CRLF. */
  readonly skipLeadingLf: boolean;
}

export function startPasswordInput(options: { skipLeadingLf?: boolean } = {}): PasswordInput {
  return { value: "", done: false, cancelled: false, endedWithCr: false, escape: "none", skipLeadingLf: options.skipLeadingLf ?? false };
}

const CTRL_C = "\u0003";
const BACKSPACE = "\b";
const DELETE = "\u007f";
const ESC = "\u001b";

/** True for C0 and C1 control characters and DEL. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * What the escape sequence in progress makes of one character: part of the
 * sequence (`consumed`, with the state that follows), or not part of it at all
 * -- in which case the sequence is abandoned and the character is read as
 * ordinary input.
 *
 * Only characters a sequence can actually contain are taken:
 *
 *   ESC [  then parameter and intermediate bytes (0x20-0x3F), ended by one
 *          final byte (0x40-0x7E)          -- arrows, Delete, Home, F5...
 *   ESC O  then one printable character    -- F1-F4 and some arrow keys
 *
 * Anything else ends the sequence unconsumed. So a lone Escape followed by a
 * letter types the letter, and Enter, Backspace, Ctrl+C or another Escape act
 * at once, inside a sequence or not. A sequence split across chunks carries on
 * where it left off, because this state is kept between chunks.
 */
function continueEscape(
  escape: PasswordInput["escape"],
  char: string,
): { consumed: true; escape: PasswordInput["escape"] } | { consumed: false } {
  const code = char.codePointAt(0) ?? 0;
  switch (escape) {
    case "esc":
      if (char === "[") return { consumed: true, escape: "csi" };
      if (char === "O") return { consumed: true, escape: "ss3" };
      return { consumed: false };
    case "csi":
      if (code >= 0x20 && code <= 0x3f) return { consumed: true, escape: "csi" };
      if (code >= 0x40 && code <= 0x7e) return { consumed: true, escape: "none" };
      return { consumed: false };
    case "ss3":
      if (code >= 0x21 && code <= 0x7e) return { consumed: true, escape: "none" };
      return { consumed: false };
    default:
      return { consumed: false };
  }
}

/**
 * Applies one chunk of terminal input to an entry, character by character.
 *
 *   - CR, LF or CRLF ends the entry; nothing after it in the chunk is taken.
 *   - Ctrl+C cancels, wherever it appears.
 *   - Backspace (BS or DEL) removes the last character, once per press.
 *   - Escape sequences (arrow keys, function keys) are skipped whole, even
 *     when they arrive split across chunks. A lone Escape, or a sequence cut
 *     short, never swallows the key that follows it (see `continueEscape`).
 *   - Every other control character is ignored on its own; the rest of the
 *     chunk is still read.
 *
 * Pure: it returns a new state and touches no terminal, so it can be tested
 * without one.
 */
export function feedPasswordInput(state: PasswordInput, chunk: string): PasswordInput {
  let { value, done, cancelled, endedWithCr, escape, skipLeadingLf } = state;

  for (const char of chunk) {
    if (done || cancelled) break;

    if (skipLeadingLf) {
      skipLeadingLf = false;
      if (char === "\n") continue;
    }

    if (escape !== "none") {
      const step = continueEscape(escape, char);
      if (step.consumed) {
        escape = step.escape;
        continue;
      }
      // Not part of a sequence: abandon it and read this character normally.
      escape = "none";
    }

    if (char === CTRL_C) {
      cancelled = true;
    } else if (char === "\r" || char === "\n") {
      done = true;
      endedWithCr = char === "\r";
    } else if (char === BACKSPACE || char === DELETE) {
      value = Array.from(value).slice(0, -1).join("");
    } else if (char === ESC) {
      escape = "esc";
    } else if (!isControl(char)) {
      value += char;
    }
  }

  return { value, done, cancelled, endedWithCr, escape, skipLeadingLf };
}

/* ---------------------------------------------------------------------------
   Deciding whether the password may go any further
   --------------------------------------------------------------------------- */

export type PasswordCheck = { readonly ok: true; readonly password: string } | { readonly ok: false; readonly message: string };

/**
 * Whether two hidden entries may become the account's password: both present,
 * identical, and at least the minimum length the rest of auth enforces. Said
 * here, before anything connects to the database.
 */
export function checkPasswordEntries(first: string, second: string): PasswordCheck {
  if (first === "") return { ok: false, message: "Password cannot be empty." };
  if (first !== second) return { ok: false, message: "The two passwords did not match. Nothing was created." };
  if (!isAcceptablePassword(first)) {
    return { ok: false, message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters. Nothing was created.` };
  }
  return { ok: true, password: first };
}

/* ---------------------------------------------------------------------------
   The command
   --------------------------------------------------------------------------- */

/** One hidden entry as read from the terminal. */
export interface HiddenEntry {
  readonly value: string;
  readonly endedWithCr: boolean;
}

/** Everything the command touches, so a test can drive it with fakes. */
export interface SetupDeps {
  readonly readHidden: (prompt: string, options: { skipLeadingLf: boolean }) => Promise<HiddenEntry>;
  readonly create: (email: string, password: string) => Promise<SetupResult>;
  readonly closePool: () => Promise<void>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/**
 * Runs the command and returns its exit code.
 *
 * The order is the point: arguments, then the email, then both password
 * entries and their checks -- and only then `create`, the one step that
 * reaches the database.
 */
export async function runSetup(args: readonly string[], deps: SetupDeps): Promise<number> {
  const [email, ...extra] = args;

  if (email === undefined || email.trim() === "") {
    deps.error("Usage: npm run setup:management -- <email>");
    return 1;
  }
  if (extra.length > 0) {
    // Refused rather than ignored: a password typed here is already in the
    // shell history, and the person should know to change it.
    deps.error(
      "Only the email is read from the command line; the password is asked for at a hidden prompt. " +
        "If you typed a password on the command line, treat it as exposed and choose another.",
    );
    return 1;
  }
  if (!isValidEmail(email.trim().toLowerCase())) {
    deps.error("That is not a valid email address.");
    return 1;
  }

  let first: HiddenEntry;
  let second: HiddenEntry;
  try {
    first = await deps.readHidden("Management account password: ", { skipLeadingLf: false });
    second = await deps.readHidden("Type the password again: ", { skipLeadingLf: first.endedWithCr });
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Password entry failed.");
    return 1;
  }

  const checked = checkPasswordEntries(first.value, second.value);
  if (!checked.ok) {
    deps.error(checked.message);
    return 1;
  }

  try {
    const result = await deps.create(email, checked.password);
    if (result.ok) {
      deps.log(`Created a MANAGEMENT account for ${result.email}.`);
      return 0;
    }
    deps.error(result.message);
    return 1;
  } finally {
    await deps.closePool();
  }
}

/* ---------------------------------------------------------------------------
   The terminal
   --------------------------------------------------------------------------- */

/** The parts of a terminal's input stream the reader uses. `process.stdin` is one. */
export interface TerminalInput {
  readonly isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The parts of a terminal's output stream the reader uses. `process.stdout` is one. */
export interface TerminalOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * Reads one entry from a terminal with nothing echoed.
 *
 * Refuses outright when the input or output is not an interactive terminal,
 * rather than reading a password from a pipe or a file. However the entry ends
 * -- Enter, Ctrl+C, end of input or a read error -- the listeners are removed
 * and raw mode is switched back off. Only the prompt and a line break are ever
 * written; no typed character is.
 *
 * Takes the streams as arguments so a test can hand it a simulated terminal.
 */
export function readHiddenWith(
  input: TerminalInput,
  output: TerminalOutput,
  prompt: string,
  options: { skipLeadingLf: boolean },
): Promise<HiddenEntry> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.reject(new Error("Run this command directly in an interactive terminal."));
  }

  return new Promise<HiddenEntry>((resolve, reject) => {
    let state = startPasswordInput(options);

    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      // Restoring the terminal must not itself throw out of an event handler:
      // a stream that has already failed may refuse, and there is then nothing
      // left to restore.
      try {
        input.setRawMode(false);
      } catch {
        /* the stream is gone; nothing to restore */
      }
      try {
        input.pause();
      } catch {
        /* as above */
      }
    };
    const onData = (chunk: string) => {
      state = feedPasswordInput(state, chunk);
      if (state.cancelled) {
        cleanup();
        output.write("\n");
        reject(new Error("Password entry cancelled."));
      } else if (state.done) {
        cleanup();
        output.write("\n");
        resolve({ value: state.value, endedWithCr: state.endedWithCr });
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Input ended before the password was entered."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("The terminal could not be read."));
    };

    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/** The real terminal: this process's own stdin and stdout. */
function readHiddenFromTerminal(prompt: string, options: { skipLeadingLf: boolean }): Promise<HiddenEntry> {
  return readHiddenWith(stdin, stdout, prompt, options);
}

/** Whether this file is the program being run, rather than imported by a test. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isEntryPoint()) {
  runSetup(process.argv.slice(2), {
    readHidden: readHiddenFromTerminal,
    create: (email, password) => createManagementAccount(email, password, { db: getPool() }),
    closePool,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // The message only (e.g. "DATABASE_URL is not set…"), never a stack: a
      // connection string can carry a password.
      console.error("Setup failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
