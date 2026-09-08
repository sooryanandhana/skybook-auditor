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
 * VERIFIED AGAINST GOOGLE'S OWN MODEL LIST ON 7 SEPTEMBER 2026, along with the
 * SDK version and the pricing note below. That check is not optional and not a
 * formality: this project's own research went stale inside four months once
 * already -- the Gemini 2.x line was current in training data and is shut down
 * now -- so re-read the list before changing anything here.
 *
 * WHY THIS ONE, AND WHY NOT THE NEWEST
 *
 * The work is one bounded request of roughly fifteen thousand tokens producing
 * short prose about thirty findings. It is not long-horizon, not agentic and
 * not multi-turn, which is what the newest Flash is built and priced for --
 * capability this task would pay for and never use.
 *
 * The deciding factor is not cost. At this volume an audit is pennies on any
 * of them and free on the development tier. It is that this prose goes in
 * front of a prospect, so the writing and the schema adherence are what
 * matter.
 *
 * NOT SETTLED UNTIL 5H. `gemini-3.5-flash-lite` is the cheaper comparator and
 * may well be good enough; that is decided by running both against real
 * Skybook audits, not by reading a table.
 *
 * ONE NUANCE, RECORDED SO IT IS NOT "CORRECTED" BY MISTAKE. The SDK ships an
 * advisory union of model names for autocompletion, and at 2.21.0 that union
 * lists `gemini-3.6-flash` but NOT `gemini-3.5-flash-lite`. The comparator is
 * nonetheless a current stable model in Google's own endpoint table, and the
 * union ends in `(string & {})` so it constrains nothing. An editor that does
 * not offer the comparator is out of date, not right.
 */
export const GEMINI_MODEL = "gemini-3.6-flash";

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
 * drifts silently. As read on 7 September 2026, this model was $0.75-$1.50 per
 * million input tokens and $3.75-$7.50 per million output, on promotional
 * rates that Google states end on 31 December 2026. An audit is roughly
 * fifteen thousand tokens in and six thousand out.
 *
 * If this project ever runs at a volume where that matters, re-read the
 * pricing page rather than trusting this paragraph.
 */
