/**
 * Turning a string into text, never into markup.
 *
 * WHY THIS FILE EXISTS AT ALL. The renderer builds HTML, and a `PdfDocument`
 * carries strings that came from somewhere else: a page title written by the
 * audited website, evidence quoting that website's own markup, a URL from its
 * links, and commentary written by a language model. None of that is trusted,
 * and 7A §22 says so outright -- text from the audited site and text from the
 * model are both rendered as plain text, neither is interpreted as markup, and
 * neither becomes a live link.
 *
 * Every other renderer in the 7C evaluation drew glyphs directly and had no
 * markup layer to get wrong. Choosing a browser bought a layout engine and an
 * accessibility tree, and this is the bill: one escaping function, applied
 * without exception, tested on its own.
 *
 * NOT A TEMPLATING FRAMEWORK, deliberately. Two functions and a tagged
 * template. A general-purpose one would grow a "raw" escape hatch, and the
 * escape hatch is the vulnerability.
 */

/**
 * The five characters that can end an element or an attribute early.
 *
 * `&` is first and must stay first: escaping it after the others would turn
 * the `&` this function had just written into `&amp;amp;`.
 *
 * Both quote marks are escaped even though only one can close any given
 * attribute, because this function does not know which quote its caller used,
 * and a function that is safe only when called correctly is not safe.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An attribute value, quote marks included.
 *
 * The quotes come from here rather than from the call site, so an attribute
 * cannot be written unquoted by accident. An unquoted attribute is broken by a
 * space, which `escapeHtml` has no reason to touch.
 */
export function attribute(value: string): string {
  return `"${escapeHtml(value)}"`;
}

/**
 * Markup with its interpolations escaped.
 *
 * `html`...`` reads like an ordinary template literal, and every `${}` in it is
 * escaped on the way in. The point is that escaping becomes the default rather
 * than something the author has to remember at each hole -- a forgotten call is
 * invisible in review, and this makes forgetting impossible.
 *
 * A number interpolates as its digits. Anything else must be made a string by
 * the caller, so composing markup out of markup is a deliberate act.
 */
export function html(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    out += typeof value === "number" ? String(value) : escapeHtml(value);
    out += strings[i + 1];
  }
  return out;
}
