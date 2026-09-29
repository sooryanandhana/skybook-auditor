/**
 * The provider-specific settings, in one place.
 *
 * WHY THEY ARE ISOLATED. A model name scattered through an application is a
 * model name that gets changed in four places and missed in a fifth. This is
 * the only file that knows which model is being asked, and it holds nothing
 * else: no key, no prompt, no schema, no request.
 *
 * NOTHING ABOVE THIS FOLDER IMPORTS IT. The contract, the builder and the
 * validator are provider-neutral and stay that way; swapping this out for a
 * different service should not touch a line of them.
 */

/**
 * The model this project asks.
 *
 * VERIFIED AGAINST GOOGLE'S OWN MODEL LIST ON 29 SEPTEMBER 2026, along with the
 * SDK version and the pricing note below. That check is not optional and not a
 * formality: this project's own research went stale inside four months once
 * already -- the Gemini 2.x line was current in training data and is shut down
 * now -- so re-read the list before changing anything here.
 *
 * WHY THIS ONE
 *
 * The work is one bounded request of roughly fifteen thousand tokens producing
 * short prose about thirty findings. It is not long-horizon, not agentic and
 * not multi-turn, which is what the full Flash models are built and priced for
 * -- capability this task would pay for and never use. A fast, cost-effective
 * Lite model fits the workload exactly, and this prose goes in front of a
 * prospect, so the writing and the schema adherence are what matter.
 *
 * WHY NOT gemini-3.6-flash. It was the earlier choice, but this project's own
 * API key has no available headroom for it: a live check returned 429
 * RESOURCE_EXHAUSTED, and under load 503 UNAVAILABLE -- which the renderer
 * faithfully reported to readers as an AI-service fault. gemini-3.5-flash-lite
 * is a current stable model that IS available on this key's quota, answers in
 * about a second, and returns valid structured JSON. All three were confirmed
 * against the live API on the date above.
 *
 * ONE NUANCE, RECORDED SO IT IS NOT "CORRECTED" BY MISTAKE. The SDK ships an
 * advisory union of model names for autocompletion, and at 2.21.0 that union
 * lists `gemini-3.6-flash` but NOT `gemini-3.5-flash-lite`. The chosen model is
 * nonetheless a current stable model in Google's own endpoint table, and the
 * union ends in `(string & {})` so it constrains nothing. An editor that does
 * not offer it is out of date, not right.
 */
export const GEMINI_MODEL = "gemini-3.5-flash-lite";

/**
 * The environment variable the key is read from.
 *
 * NEVER PREFIXED `NEXT_PUBLIC_`. That prefix is what puts a value in the
 * browser bundle, and this is the one value that must never be there.
 */
export const GEMINI_API_KEY_VARIABLE = "GEMINI_API_KEY";

/*
 * PRICING, AS A NOTE RATHER THAN A VALUE.
 *
 * Nothing in the code branches on cost, so a constant would be a number that
 * drifts silently. The figures once recorded here were for the previously
 * selected gemini-3.6-flash; gemini-3.5-flash-lite is a cheaper Lite tier, and
 * exact rates were not re-read at the switch. An audit is roughly fifteen
 * thousand tokens in and six thousand out.
 *
 * If this project ever runs at a volume where that matters, re-read the
 * pricing page rather than trusting this paragraph.
 */
