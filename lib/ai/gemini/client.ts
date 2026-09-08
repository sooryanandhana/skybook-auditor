/**
 * The key, and the one object that holds it.
 *
 * SERVER ONLY. Nothing in `app/` imports this, and the variable it reads is
 * deliberately not prefixed `NEXT_PUBLIC_` — that prefix is what puts a value
 * in the browser bundle, and this is the one value that must never be there.
 *
 * NO KEY IS NOT AN ERROR. It is a state, and the project already has a word
 * for it: the speed check reports `no-api-key` and means "nothing was
 * attempted", never "this website is slow". The same reading applies here. An
 * audit with no key configured is a complete audit that was not explained, and
 * the report is delivered exactly as it would have been.
 *
 * WHY THERE ARE TWO FUNCTIONS RATHER THAN ONE STATE OBJECT
 *
 * The SDK's client carries the key as an own enumerable property. Both
 * `JSON.stringify` and `util.inspect` — which is what `console.log` uses —
 * reproduce it in full. So a state object holding the client is a state object
 * that puts the key in the logs the first time anyone prints it while
 * debugging, which is exactly when someone would.
 *
 * The two are therefore kept apart. `geminiAvailability` answers "is this
 * configured?" and is safe to log, print or return. `geminiClient` hands over
 * the object that must never be logged, and says so in its own name and
 * documentation. A test pins the SDK behaviour this defends against, so the
 * split cannot be tidied away by someone who does not know why it is there.
 */
import { GoogleGenAI } from "@google/genai";
import { GEMINI_API_KEY_VARIABLE, GEMINI_MODEL } from "./config.ts";

export interface GeminiOptions {
  /**
   * Overrides the environment. Supplied by tests so none of them depend on a
   * key being present, or absent, on the machine running them.
   */
  readonly apiKey?: string;
}

/**
 * Whether an explanation can be asked for at all.
 *
 * SAFE TO LOG. It carries no key and no client — only whether there is one and,
 * when there is not, a sentence a person can act on.
 */
export type GeminiAvailability =
  | { readonly configured: true; readonly model: string }
  | { readonly configured: false; readonly reason: string };

/** Said when the key is missing. Names the variable, never a value. */
const NOT_CONFIGURED =
  `No ${GEMINI_API_KEY_VARIABLE} is configured, so no explanation was requested. ` +
  "The audit itself is unaffected.";

/** The key, from the caller or the environment, with surrounding space removed. */
function resolveKey(options: GeminiOptions): string {
  return (options.apiKey ?? process.env[GEMINI_API_KEY_VARIABLE] ?? "").trim();
}

/*
 * One client per key, built on first use.
 *
 * Construction performs no request — it builds an object and returns — so this
 * is about not rebuilding one per audit rather than about latency. Keyed by the
 * key itself so a test passing its own never receives the environment's, and
 * so a changed environment is picked up rather than cached over.
 */
const clients = new Map<string, GoogleGenAI>();

/**
 * Whether Gemini is configured, in a form that is safe to show or record.
 *
 * Does not construct a client and does not touch the network. Callers that
 * only need to decide whether to offer an explanation should use this and
 * nothing else.
 */
export function geminiAvailability(options: GeminiOptions = {}): GeminiAvailability {
  if (resolveKey(options) === "") return { configured: false, reason: NOT_CONFIGURED };
  return { configured: true, model: GEMINI_MODEL };
}

/**
 * The client, or null when there is no usable key.
 *
 * NEVER LOG, SERIALISE OR RETURN WHAT THIS GIVES YOU. The object holds the key
 * as an own enumerable property, so printing it prints the key. Use
 * `geminiAvailability` for anything a person or a log will see.
 *
 * Returns null rather than throwing, for the same reason the speed check
 * reports a state rather than failing: a missing key is a fact about this
 * server's configuration, not a fault in anybody's website.
 */
export function geminiClient(options: GeminiOptions = {}): GoogleGenAI | null {
  const apiKey = resolveKey(options);
  if (apiKey === "") return null;

  const existing = clients.get(apiKey);
  if (existing !== undefined) return existing;

  /*
   * NOT WRAPPED IN A TRY, DELIBERATELY, AND THIS WAS CHECKED.
   *
   * There was a catch here that turned a construction failure into a null. It
   * was removed once the SDK was actually exercised: on 7 September 2026,
   * version 2.21.0 constructs without complaint for every key tried --
   * garbage, five thousand characters, control characters, a bare space. It
   * validates nothing until a request is made.
   *
   * So the catch could not run, which made two tests pass while asserting
   * nothing. Unreachable protection reads like protection and is worse than
   * none, because it is believed. Request failures are real and get handled
   * where they actually happen, in the adapter.
   *
   * The empty case returned above is what stops the SDK writing "API key
   * should be set" to the console: it is never handed a blank key.
   */
  const client = new GoogleGenAI({ apiKey });
  clients.set(apiKey, client);
  return client;
}

/** Forgets the cached clients. For tests, so one cannot leak into the next. */
export function resetGeminiClients(): void {
  clients.clear();
}
