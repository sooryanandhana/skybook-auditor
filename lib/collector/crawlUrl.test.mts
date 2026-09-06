/**
 * Tests for crawl URL handling.
 *
 * These are the functions that decide what a crawl is ALLOWED to queue, so the
 * hostile cases matter more than the ordinary ones. A `javascript:` href, a
 * link to another domain, or an address that loops back to the machine we are
 * running on must all be refused here — before anything reaches the fetcher.
 *
 * The fetcher has its own SSRF check on every redirect hop and keeps it. This
 * layer stops bad addresses ever entering the queue.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  MAX_URL_LENGTH,
  createUrlSet,
  dedupKey,
  isSameSite,
  normalizeCrawlUrl,
  pathForKey,
  siteKey,
} from "./crawlUrl.ts";
import { createFrontier } from "./crawlFrontier.ts";

const BASE = "https://example.com/products/kettles";

/** The resolved URL, or the reason it was refused. */
function resolve(href: string, base = BASE) {
  const result = normalizeCrawlUrl(href, base);
  return result.ok ? result.url.href : `REJECTED:${result.reason}`;
}

function keyOf(href: string, base = BASE) {
  const result = normalizeCrawlUrl(href, base);
  if (!result.ok) throw new Error(`expected ${href} to resolve, got ${result.reason}`);
  return result.key;
}

// ---------------------------------------------------------------------------
// Schemes: the addresses that must never be queued
// ---------------------------------------------------------------------------

test("javascript: and data: hrefs are refused", () => {
  assert.equal(resolve("javascript:alert(1)"), "REJECTED:unsupported-scheme");
  assert.equal(resolve("JavaScript:alert(1)"), "REJECTED:unsupported-scheme");
  assert.equal(resolve("data:text/html,<h1>hi</h1>"), "REJECTED:unsupported-scheme");
});

test("file: and other local schemes are refused", () => {
  for (const href of ["file:///etc/passwd", "file://C:/Windows/system.ini", "ftp://example.com/x"]) {
    assert.equal(resolve(href), "REJECTED:unsupported-scheme", href);
  }
});

test("mailto:, tel: and anchors are refused rather than queued", () => {
  assert.equal(resolve("mailto:sales@example.com"), "REJECTED:unsupported-scheme");
  assert.equal(resolve("tel:+441234567890"), "REJECTED:unsupported-scheme");
  assert.equal(resolve(""), "REJECTED:empty");
  assert.equal(resolve("   "), "REJECTED:empty");
});

test("http and https are both accepted", () => {
  assert.equal(resolve("http://example.com/a"), "http://example.com/a");
  assert.equal(resolve("https://example.com/a"), "https://example.com/a");
});

// ---------------------------------------------------------------------------
// Hosts that point back at us
// ---------------------------------------------------------------------------

test("dotless hostnames are refused", () => {
  // The fetcher's SSRF check would catch these too. Refusing here keeps them
  // out of the queue entirely.
  for (const href of ["http://localhost/", "http://localhost:3000/admin", "http://intranet/"]) {
    assert.equal(resolve(href), "REJECTED:dotless-host", href);
  }
});

test("a numeric loopback or private address parses here but is not same-site", () => {
  // 127.0.0.1 HAS dots, so it is a syntactically valid URL. Two later gates
  // stop it: it is never the audited site, and fetchPage refuses private
  // addresses on every hop.
  for (const href of [
    "http://127.0.0.1:3000/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
  ]) {
    const result = normalizeCrawlUrl(href, BASE);
    assert.ok(result.ok, `${href} should parse`);
    assert.equal(
      isSameSite(result.url, BASE),
      false,
      `${href} must never be treated as part of the audited site`,
    );
  }
});

// ---------------------------------------------------------------------------
// Relative links
// ---------------------------------------------------------------------------

test("relative links resolve against the page they were found on", () => {
  assert.equal(resolve("/about"), "https://example.com/about");
  assert.equal(resolve("teapots"), "https://example.com/products/teapots");
  assert.equal(resolve("../contact"), "https://example.com/contact");
  assert.equal(resolve("./reviews"), "https://example.com/products/reviews");
});

test("protocol-relative links take the scheme of the page", () => {
  assert.equal(resolve("//example.com/a"), "https://example.com/a");
  assert.equal(resolve("//example.com/a", "http://example.com/x"), "http://example.com/a");
});

test("a malformed href is refused, not guessed at", () => {
  assert.equal(resolve("http://"), "REJECTED:malformed");
  assert.equal(resolve("https://[not-an-ipv6"), "REJECTED:malformed");
});

test("an odd-looking href that IS a valid relative path is kept", () => {
  // "://missing-scheme" has no scheme, so it is just an unusual filename
  // relative to the current directory. Refusing it would silently drop a page.
  assert.equal(
    resolve("://missing-scheme"),
    "https://example.com/products/://missing-scheme",
  );
});

// ---------------------------------------------------------------------------
// What gets stripped
// ---------------------------------------------------------------------------

test("fragments are stripped — they never reach the server", () => {
  assert.equal(resolve("/about#team"), "https://example.com/about");
  assert.equal(resolve("#top"), "https://example.com/products/kettles");
});

test("credentials are stripped rather than carried", () => {
  // We audit a site; we do not authenticate to it on someone else's behalf.
  assert.equal(resolve("https://user:secret@example.com/a"), "https://example.com/a");
  assert.ok(!resolve("https://user:secret@example.com/a").includes("secret"));
});

test("tracking parameters are stripped, real ones kept", () => {
  assert.equal(resolve("/a?utm_source=twitter&utm_medium=social"), "https://example.com/a");
  assert.equal(resolve("/a?fbclid=xyz"), "https://example.com/a");
  assert.equal(resolve("/a?gclid=xyz&page=2"), "https://example.com/a?page=2");
  // A parameter we do not recognise may genuinely select different content.
  assert.equal(resolve("/a?colour=red"), "https://example.com/a?colour=red");
});

test("an over-long URL is refused", () => {
  const long = "https://example.com/" + "x".repeat(MAX_URL_LENGTH);
  assert.equal(resolve(long), "REJECTED:too-long");
  // And one that only becomes long once resolved against its base.
  const longRelative = "/" + "y".repeat(MAX_URL_LENGTH);
  assert.equal(resolve(longRelative), "REJECTED:too-long");
});

test("the fetched URL keeps its original parameter order", () => {
  // The key sorts them; the address we request does not, because a server is
  // entitled to care even though almost none do.
  const result = normalizeCrawlUrl("/a?b=2&a=1", BASE);
  assert.ok(result.ok);
  assert.equal(result.url.href, "https://example.com/a?b=2&a=1");
});

// ---------------------------------------------------------------------------
// Dedup keys
// ---------------------------------------------------------------------------

test("dedupKey works directly on a URL, independent of link resolution", () => {
  // Exported in its own right: the crawler will key already-known URLs
  // (sitemap entries, redirect targets) without them coming from an href.
  assert.equal(dedupKey(new URL("https://WWW.Example.com/about/?b=2&a=1")), "example.com/about?a=1&b=2");
  assert.equal(dedupKey(new URL("http://example.com/")), "example.com/");
  assert.equal(dedupKey(new URL("https://example.com:8443/x")), "example.com:8443/x");
});

test("trailing slash does not create a second page", () => {
  assert.equal(keyOf("/about"), keyOf("/about/"));
});

test("but the root path keeps its slash", () => {
  assert.equal(keyOf("/"), "example.com/");
  assert.equal(keyOf("https://example.com"), "example.com/");
});

test("scheme does not create a second page", () => {
  assert.equal(keyOf("http://example.com/a"), keyOf("https://example.com/a"));
});

test("www does not create a second page", () => {
  assert.equal(keyOf("https://www.example.com/a"), keyOf("https://example.com/a"));
});

test("host case does not create a second page", () => {
  assert.equal(keyOf("https://EXAMPLE.com/a"), keyOf("https://example.com/a"));
});

test("path case DOES create a second page", () => {
  // Most servers serve different files for these. Merging them would silently
  // skip a page, which is worse than crawling one twice.
  assert.notEqual(keyOf("/About"), keyOf("/about"));
});

test("parameter order does not create a second page", () => {
  assert.equal(keyOf("/a?b=2&a=1"), keyOf("/a?a=1&b=2"));
});

test("different parameter values DO create different pages", () => {
  assert.notEqual(keyOf("/a?page=1"), keyOf("/a?page=2"));
});

test("a non-default port is part of the identity", () => {
  assert.equal(keyOf("https://example.com:8443/a"), "example.com:8443/a");
  // Default ports are dropped by URL itself.
  assert.equal(keyOf("https://example.com:443/a"), keyOf("https://example.com/a"));
  assert.equal(keyOf("http://example.com:80/a", "http://example.com/"), keyOf("http://example.com/a", "http://example.com/"));
});

test("every stripped thing collapses into one key", () => {
  const messy = "HTTPS://WWW.Example.com/about/?utm_source=x&b=2&a=1#team";
  assert.equal(keyOf(messy), keyOf("https://example.com/about?a=1&b=2"));
});

// ---------------------------------------------------------------------------
// Same-site boundary
// ---------------------------------------------------------------------------

test("www and apex are the same site", () => {
  assert.equal(isSameSite("https://www.example.com/a", "https://example.com/"), true);
  assert.equal(isSameSite("https://example.com/a", "https://www.example.com/"), true);
});

test("a subdomain is a different site", () => {
  // Usually a separate property with separate owners. Wandering onto it
  // uninvited is what gets a crawler blocked.
  assert.equal(isSameSite("https://blog.example.com/a", "https://example.com/"), false);
  assert.equal(isSameSite("https://shop.example.com/a", "https://www.example.com/"), false);
});

test("only the leading www label is collapsed", () => {
  // www.blog.example.com is blog.example.com, NOT example.com.
  assert.equal(siteKey("https://www.blog.example.com/"), "blog.example.com");
  assert.equal(isSameSite("https://www.blog.example.com/", "https://example.com/"), false);
});

test("other domains are refused, including lookalikes", () => {
  const site = "https://example.com/";
  for (const other of [
    "https://example.co.uk/",
    "https://example.com.evil.net/",
    "https://evil.net/https://example.com/",
    "https://notexample.com/",
    "https://example.net/",
  ]) {
    assert.equal(isSameSite(other, site), false, other);
  }
});

test("scheme is ignored when deciding same-site", () => {
  assert.equal(isSameSite("http://example.com/a", "https://example.com/"), true);
});

test("a path or query mentioning the site is not the site", () => {
  assert.equal(isSameSite("https://evil.net/?next=https://example.com", "https://example.com/"), false);
});

test("an unparseable candidate is not same-site", () => {
  assert.equal(isSameSite("not a url", "https://example.com/"), false);
});

test("siteKey lowercases the host", () => {
  assert.equal(siteKey("https://WWW.EXAMPLE.COM/"), "example.com");
});

// ---------------------------------------------------------------------------
// Port as part of site identity
//
// A different port is a different server. :8080 is routinely a staging copy,
// an admin panel, or unrelated software that happens to share a hostname, and
// auditing one while reporting on the other describes the wrong application.
// ---------------------------------------------------------------------------

test("a default port is not part of the site identity", () => {
  // Free, and worth stating: the URL parser drops :443 from an https address
  // and :80 from an http one before either reaches us.
  assert.equal(siteKey("https://example.com:443/"), siteKey("https://example.com/"));
  assert.equal(siteKey("http://example.com:80/"), siteKey("http://example.com/"));
  assert.equal(siteKey("https://example.com:443/"), "example.com");

  assert.equal(isSameSite("https://example.com:443/a", "https://example.com/"), true);
  assert.equal(isSameSite("http://example.com:80/a", "http://example.com/"), true);
});

test("a non-default port IS part of the site identity", () => {
  assert.equal(siteKey("https://example.com:8080/"), "example.com:8080");
  assert.equal(siteKey("http://example.com:8080/"), "example.com:8080");

  assert.equal(isSameSite("https://example.com:8080/a", "https://example.com/"), false);
  assert.equal(isSameSite("http://example.com:8080/a", "http://example.com/"), false);
  assert.equal(isSameSite("https://example.com/a", "https://example.com:8080/"), false);
});

test("two different non-default ports are two different sites", () => {
  assert.equal(isSameSite("https://example.com:8080/a", "https://example.com:9090/"), false);
  assert.equal(isSameSite("https://example.com:8080/a", "https://example.com:8080/"), true);
});

test("www equivalence still holds, with or without a port", () => {
  assert.equal(isSameSite("https://www.example.com/a", "https://example.com/"), true);
  assert.equal(isSameSite("https://www.example.com:8080/a", "https://example.com:8080/"), true);
  assert.equal(siteKey("https://www.example.com:8080/"), "example.com:8080");
});

test("scheme equivalence still holds, with or without a port", () => {
  // A site linking to itself over http still means itself.
  assert.equal(isSameSite("http://example.com/a", "https://example.com/"), true);
  assert.equal(isSameSite("http://example.com:8080/a", "https://example.com:8080/"), true);
  // And the two rules together: default ports vanish, so these are one site,
  // while their :8080 forms are a different one.
  assert.equal(isSameSite("http://example.com:80/a", "https://example.com:443/"), true);
  assert.equal(isSameSite("http://example.com:80/a", "https://example.com:8080/"), false);
});

test("a subdomain on the same port is still a different site", () => {
  assert.equal(isSameSite("https://blog.example.com:8080/a", "https://example.com:8080/"), false);
});

test("dedupKey and siteKey agree about which site an address is on", () => {
  // They share one definition, so a page can never be judged same-site while
  // simultaneously looking like an address the crawl has never seen.
  for (const address of [
    "https://example.com/a",
    "https://www.example.com/a",
    "http://example.com:8080/a",
    "https://example.com:443/a",
  ]) {
    const url = new URL(address);
    assert.equal(dedupKey(url).startsWith(siteKey(url)), true, address);
  }
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

test("adding a URL twice reports it as new only once", () => {
  const seen = createUrlSet();

  assert.equal(seen.add("https://example.com/about"), true);
  assert.equal(seen.add("https://example.com/about"), false);
  assert.equal(seen.size, 1);
});

test("equivalent forms of one page count once", () => {
  const seen = createUrlSet();
  seen.add("https://example.com/about");

  for (const same of [
    "https://example.com/about/",
    "http://example.com/about",
    "https://www.example.com/about",
    "https://EXAMPLE.com/about",
    "https://example.com/about#team",
  ]) {
    assert.equal(seen.add(same), false, `${same} should already be seen`);
  }
  assert.equal(seen.size, 1);
});

test("genuinely different pages are kept apart", () => {
  const seen = createUrlSet();
  for (const url of [
    "https://example.com/about",
    "https://example.com/About",
    "https://example.com/contact",
    "https://example.com/a?page=1",
    "https://example.com/a?page=2",
  ]) {
    assert.equal(seen.add(url), true, url);
  }
  assert.equal(seen.size, 5);
});

test("has() does not record anything", () => {
  const seen = createUrlSet();

  assert.equal(seen.has("https://example.com/a"), false);
  assert.equal(seen.size, 0);
  seen.add("https://example.com/a");
  assert.equal(seen.has("https://example.com/a/"), true);
  assert.equal(seen.size, 1);
});

test("an unparseable URL is refused, never queued repeatedly", () => {
  const seen = createUrlSet();

  assert.equal(seen.add("not a url"), false);
  assert.equal(seen.add("not a url"), false);
  assert.equal(seen.has("not a url"), false);
  assert.equal(seen.size, 0);
});

test("\"./\" is the directory, not the current page", () => {
  // A real trap: from /products/kettles, "./" means /products/ — a DIFFERENT
  // page. Treating it as self-referencing would silently skip a section index.
  assert.equal(resolve("./"), "https://example.com/products/");
  assert.notEqual(keyOf("./"), keyOf("/products/kettles"));
});

test("a two-page link cycle terminates", () => {
  // A links to B, B links back to A. Without dedup this crawls forever.
  const seen = createUrlSet();
  const pages = ["https://example.com/a", "https://example.com/b"];
  const queue = ["https://example.com/a"];
  let fetched = 0;

  while (queue.length > 0 && fetched < 50) {
    const url = queue.shift()!;
    if (!seen.add(url)) continue;
    fetched += 1;
    for (const link of pages) if (!seen.has(link)) queue.push(link);
  }

  assert.equal(fetched, 2, "each page fetched exactly once");
  assert.equal(seen.size, 2);
});

test("a self-referencing page does not requeue itself", () => {
  const seen = createUrlSet();
  seen.add("https://example.com/products/kettles");

  // The forms a page commonly uses to link to itself.
  for (const href of ["", "#top", "kettles", "/products/kettles/"]) {
    const result = normalizeCrawlUrl(href, BASE);
    if (!result.ok) continue;
    assert.equal(seen.add(result.url), false, `${href} resolved to a new page`);
  }
});

// ---------------------------------------------------------------------------
// TWO WRITINGS OF ONE PATH
//
// A site whose template joins a base ending in "/" with a path starting "/"
// emits `//about`. A site that percent-encodes a letter emits `/%61bout`.
// Both are the same page as `/about` to every server, and both used to produce
// their own key — so the page was fetched twice, counted twice, and a finding
// on it read as "2 of 20 pages" when it was one page out of nineteen.
//
// The other half of this matters more: the things that look similar and are
// NOT the same must stay apart. Merging those silently skips a real page.
// ---------------------------------------------------------------------------

const fetchUrlOf = (href: string, base = "https://example.com/") => {
  const result = normalizeCrawlUrl(href, base);
  assert.ok(result.ok);
  return result.url.toString();
};

// --- equivalent, and now recognised as such --------------------------------

test("repeated slashes are one separator", () => {
  assert.equal(keyOf("/a//b"), keyOf("/a/b"));
  assert.equal(keyOf("https://example.com//about"), keyOf("/about"));
  assert.equal(keyOf("/a///b////c"), keyOf("/a/b/c"));
});

test("a leading // is a HOST, not a doubled path separator", () => {
  /*
   * `//about` in an href is protocol-relative: it means the site "about",
   * which has no dot and is refused. Collapsing it into "/about" would send
   * the crawler to a path the page never linked to — so the collapse applies
   * to the path of a resolved URL, never to the raw href.
   */
  const relative = normalizeCrawlUrl("//about", "https://example.com/");
  assert.equal(relative.ok, false);
  assert.equal(relative.ok === false && relative.reason, "dotless-host");

  // The same two characters inside a real address are a doubled separator.
  assert.equal(keyOf("https://example.com//about"), keyOf("/about"));

  // And a protocol-relative link to a real site is still another site.
  const offsite = normalizeCrawlUrl("//other.example/a", "https://example.com/");
  assert.ok(offsite.ok);
  assert.equal(offsite.ok && offsite.url.hostname, "other.example");
});

test("an unreserved character means the same encoded or not", () => {
  // %61 is "a", %2D is "-", %5F is "_", %7E is "~", %2E is "."
  assert.equal(keyOf("/%61bout"), keyOf("/about"));
  assert.equal(keyOf("/a%2Db"), keyOf("/a-b"));
  assert.equal(keyOf("/a%5Fb"), keyOf("/a_b"));
  assert.equal(keyOf("/a%7Eb"), keyOf("/a~b"));
  assert.equal(keyOf("/a%2Ehtml"), keyOf("/a.html"));
  assert.equal(keyOf("/%31%32%33"), keyOf("/123"));
});

test("the two tidyings combine", () => {
  assert.equal(keyOf("https://example.com//%61bout//us/"), keyOf("/about/us"));
});

test("an escape that stays is written one way", () => {
  // %2f and %2F are the same escape, and only one of them can be the key.
  assert.equal(keyOf("/a%2fb"), keyOf("/a%2Fb"));
  assert.equal(keyOf("/a%c3%a9"), keyOf("/a%C3%A9"));
});

// --- deliberately NOT equivalent -------------------------------------------

test("an ENCODED slash is not a path separator", () => {
  /*
   * The one that would be a real bug. A server receiving `/a%2Fb` sees one
   * segment containing a slash; `/a/b` is two segments. Decoding it would
   * invent a directory boundary and merge two different pages.
   */
  assert.notEqual(keyOf("/a%2Fb"), keyOf("/a/b"));
});

test("path case is still preserved", () => {
  assert.notEqual(keyOf("/About"), keyOf("/about"));
  assert.notEqual(keyOf("/%41bout"), keyOf("/about"), "%41 is A, not a");
  assert.equal(keyOf("/%41bout"), keyOf("/About"));
});

test("a space is not nothing, and stays encoded", () => {
  assert.notEqual(keyOf("/a%20b"), keyOf("/ab"));
  assert.notEqual(keyOf("/a%20b"), keyOf("/a/b"));
});

test("reserved characters keep their meaning", () => {
  // %3F is "?", %23 is "#", %26 is "&". Decoding any of them into the key
  // would turn part of a path into a query, a fragment or a separator.
  assert.notEqual(keyOf("/a%3Fb"), keyOf("/a?b"));
  assert.notEqual(keyOf("/a%23b"), keyOf("/a"));
  assert.notEqual(keyOf("/a%26b"), keyOf("/a&b=1"));
});

test("non-ASCII bytes are left exactly as they arrived", () => {
  assert.notEqual(keyOf("/caf%C3%A9"), keyOf("/cafe"));
});

test("different pages stay different", () => {
  assert.notEqual(keyOf("/a"), keyOf("/a/b"));
  assert.notEqual(keyOf("/a"), keyOf("/b"));
  assert.notEqual(keyOf("/a?x=1"), keyOf("/a?x=2"));
});

test("a deliberate port is still part of the identity", () => {
  assert.notEqual(
    keyOf("https://example.com:8080/a", "https://example.com:8080/"),
    keyOf("/a"),
  );
});

// --- the fetched address is not touched ------------------------------------

test("the address we FETCH keeps the site's own spelling", () => {
  /*
   * The key is ours; the URL is the site's. A crawler that rewrote addresses
   * before requesting them would ask for pages nobody linked to, and a server
   * is entitled to care about details we treat as cosmetic.
   */
  assert.equal(fetchUrlOf("/a//b"), "https://example.com/a//b");
  assert.equal(fetchUrlOf("/%61bout"), "https://example.com/%61bout");
  assert.equal(fetchUrlOf("/a%2Fb"), "https://example.com/a%2Fb");
  assert.equal(fetchUrlOf("/caf%C3%A9"), "https://example.com/caf%C3%A9");
});

// --- and the frontier acts on it -------------------------------------------

test("the frontier queues one page, not three writings of it", () => {
  const frontier = createFrontier({ requestedUrl: "https://example.com/" });

  assert.equal(frontier.offer("/about", "html").outcome, "queued");
  assert.equal(frontier.offer("https://example.com//about", "html").outcome, "duplicate");
  assert.equal(frontier.offer("/%61bout", "html").outcome, "duplicate");
  assert.equal(frontier.offer("/about/", "html").outcome, "duplicate");

  // And a genuinely different page is still a different page.
  assert.equal(frontier.offer("/a%2Fbout", "html").outcome, "queued");

  assert.equal(frontier.summary().discovered, 2);
});

test("pathForKey on its own", () => {
  assert.equal(pathForKey("/a//b"), "/a/b");
  assert.equal(pathForKey("/%61"), "/a");
  assert.equal(pathForKey("/a%2Fb"), "/a%2Fb");
  assert.equal(pathForKey("/a%2fb"), "/a%2Fb");
  assert.equal(pathForKey("/"), "/");
  assert.equal(pathForKey("//"), "/");
  assert.equal(pathForKey("/already/fine"), "/already/fine");
});
