/**
 * Tests for what the findings section says about a whole-site audit.
 *
 * Every sentence produced here is a claim about somebody's website, and the
 * ways to get one subtly wrong all read perfectly well: "50 pages affected"
 * when 147 were, "1 of 128 pages" about a DNS record measured once, "the whole
 * site was audited" after stopping at a limit. Each of those is a test below.
 *
 * Also asserted: this layer computes nothing. No severity, no counts, no
 * denominators, no judgement about completeness — it reads what the server
 * decided and turns it into English.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import {
  affectedView,
  auditStatusText,
  crawlView,
  findingScope,
  hasAffectedList,
  PAGE_FINDINGS_HEADING,
  partitionByScope,
  robotsNote,
  scopeLabel,
  siteFileText,
  SITE_FINDINGS_HEADING,
  stopReasonText,
} from "./siteFindingsView.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";
import type { Finding } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pageFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "seo.meta-description.missing",
  title: "No meta description",
  category: "seo",
  severity: "medium",
  evidence: "The page has no meta description tag.",
  remediation: "Add a meta description of 50 to 160 characters.",
  scope: "page",
  affected: [{ url: "https://example.com/a", evidence: "none" }],
  affectedCount: 1,
  evaluatedPages: 1,
  ...overrides,
});

const siteFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "security.dns.spf",
  title: "No SPF record",
  category: "security",
  severity: "medium",
  evidence: "No SPF record was found for example.com.",
  remediation: "Publish an SPF record listing the servers allowed to send mail.",
  scope: "site",
  affected: [{ url: "https://example.com", evidence: "No SPF record was found." }],
  affectedCount: 1,
  ...overrides,
});

const crawl = (overrides: Partial<SiteCrawlSummary> = {}): SiteCrawlSummary => ({
  requestedUrl: "https://example.com/",
  limits: {
    maxPages: 150,
    maxDurationMs: 300_000,
    maxQueueSize: 2_000,
    maxResponseBytes: 5_000_000,
    concurrency: 3,
    perRequestDelayMs: 200,
  },
  stoppedBecause: "completed",
  complete: true,
  discovered: 128,
  queuedAtStop: 0,
  evaluated: 128,
  unavailable: [],
  skippedNonHtml: 0,
  sources: { html: 127, sitemap: 0 },
  sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
  robots: { status: "absent", enforced: true, excluded: 0 },
  ...overrides,
});

function sourceOf(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Scope comes from the finding, and only from the finding
// ---------------------------------------------------------------------------

test("scope is read from the finding, never guessed from anything else", () => {
  assert.equal(findingScope(siteFinding()), "site");
  assert.equal(findingScope(pageFinding()), "page");

  // A site-sounding id on a page-scoped finding stays page-scoped, and a
  // page-sounding id on a site-scoped finding stays site-scoped. The rule
  // declared it; nothing here may overrule that.
  assert.equal(findingScope(pageFinding({ id: "security.dns.spf" })), "page");
  assert.equal(findingScope(siteFinding({ id: "seo.title.missing" })), "site");
  assert.equal(findingScope(pageFinding({ category: "security" })), "page");
});

test("a finding with no scope is page-level, as it always was", () => {
  // The speed findings describe one address, and everything written before
  // scope existed described one page.
  const legacy = pageFinding();
  delete legacy.scope;

  assert.equal(findingScope(legacy), "page");
});

test("the two groups are split by scope and keep the server's order", () => {
  const findings = [
    siteFinding({ id: "security.ssl.expired", severity: "critical" }),
    pageFinding({ id: "seo.title.missing", severity: "high" }),
    siteFinding({ id: "security.dns.spf" }),
    pageFinding({ id: "seo.h1.missing" }),
  ];

  const { site, page } = partitionByScope(findings);

  assert.deepEqual(site.map((f) => f.id), ["security.ssl.expired", "security.dns.spf"]);
  assert.deepEqual(page.map((f) => f.id), ["seo.title.missing", "seo.h1.missing"]);
});

test("the scope label says which kind of thing a finding describes", () => {
  assert.equal(scopeLabel("site"), "Site-wide");
  assert.equal(scopeLabel("page"), "Page-level");
});

// ---------------------------------------------------------------------------
// A site finding gets no page count
// ---------------------------------------------------------------------------

test("a site finding is NEVER given a page denominator", () => {
  /*
   * The claim this prevents: "1 of 128 pages affected" about a single SPF
   * record. Its affectedCount is 1 because one SITE was affected — a reader
   * told "1 of 128 pages" would reasonably conclude the other 127 were fine.
   */
  const view = affectedView(siteFinding());

  assert.equal(view.reach, null);
  assert.equal(view.sample, null);
});

test("a site finding gets no page count even if one is somehow attached", () => {
  // Defensive: scope wins over any stray counts.
  const view = affectedView(siteFinding({ evaluatedPages: 128, affectedCount: 1 }));

  assert.equal(view.reach, null);
});

test("a site finding still carries its own evidence and target", () => {
  const view = affectedView(siteFinding());

  assert.equal(view.pages.length, 1);
  assert.equal(view.pages[0].url, "https://example.com");
});

// ---------------------------------------------------------------------------
// A page finding's denominator
// ---------------------------------------------------------------------------

test("a page finding reads as a share of the pages the rule ran on", () => {
  const view = affectedView(
    pageFinding({ affectedCount: 19, evaluatedPages: 128, affected: [] }),
  );

  assert.equal(view.reach, "19 of 128 evaluated pages");
});

test("the denominator is the server's, not a count of anything on screen", () => {
  // Nineteen affected, three listed, a hundred and twenty-eight evaluated.
  // The sentence must use the server's numbers, not the length of the list.
  const view = affectedView(
    pageFinding({
      affectedCount: 19,
      evaluatedPages: 128,
      affected: [
        { url: "https://example.com/a", evidence: "none" },
        { url: "https://example.com/b", evidence: "none" },
        { url: "https://example.com/c", evidence: "none" },
      ],
    }),
  );

  assert.equal(view.reach, "19 of 128 evaluated pages");
  assert.ok(!view.reach?.includes("3 of"), "the list length is not the count");
});

test("one page reads as a page, not as pages", () => {
  assert.equal(
    affectedView(pageFinding({ affectedCount: 1, evaluatedPages: 1, affected: [] })).reach,
    "1 of 1 evaluated page",
  );
});

test("a page finding with no denominator says only what it knows", () => {
  const view = affectedView(
    pageFinding({ affectedCount: 4, evaluatedPages: undefined, affected: [] }),
  );

  assert.equal(view.reach, "4 pages affected");
});

test("a finding with no counts at all claims none", () => {
  // The speed findings arrive this way: one address, no aggregation.
  const view = affectedView(
    pageFinding({ affectedCount: undefined, evaluatedPages: undefined, affected: undefined }),
  );

  assert.equal(view.reach, null);
  assert.equal(view.sample, null);
  assert.deepEqual(view.pages, []);
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test("a capped list says so, and the true total is what is claimed", () => {
  /*
   * The server lists at most fifty. Saying "50 pages affected" when 147 were
   * is false, and letting a reader assume the fifty ARE the total is the same
   * falsehood told by omission.
   */
  const listed = Array.from({ length: 50 }, (_, i) => ({
    url: `https://example.com/p${i}`,
    evidence: "none",
  }));

  const view = affectedView(
    pageFinding({ affectedCount: 147, evaluatedPages: 200, affected: listed }),
  );

  assert.equal(view.reach, "147 of 200 evaluated pages");
  assert.equal(view.sample, "Showing 50 of 147");
  assert.equal(view.pages.length, 50);
});

test("an uncapped list says nothing about being a sample", () => {
  const listed = [
    { url: "https://example.com/a", evidence: "none" },
    { url: "https://example.com/b", evidence: "none" },
  ];

  const view = affectedView(
    pageFinding({ affectedCount: 2, evaluatedPages: 10, affected: listed }),
  );

  assert.equal(view.sample, null, "nothing was left out, so nothing is claimed");
});

test("an expandable list is offered only when there is something in it", () => {
  assert.equal(hasAffectedList(pageFinding()), true);
  assert.equal(hasAffectedList(pageFinding({ affected: [] })), false);
  assert.equal(hasAffectedList(pageFinding({ affected: undefined })), false);
});

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

test("a finished crawl is not described as partial", () => {
  const view = crawlView(crawl());

  assert.equal(view.partial, false);
  assert.equal(view.reason, null);
  assert.match(view.headline, /128 pages read/);
});

test("a crawl stopped at a limit is partial, and says what it covered", () => {
  const view = crawlView(
    crawl({
      complete: false,
      stoppedBecause: "max-pages",
      evaluated: 128,
      discovered: 417,
      queuedAtStop: 267,
      unavailable: [{ url: "https://example.com/gone", reason: "timeout" }],
    }),
  );

  assert.equal(view.partial, true);
  assert.match(view.headline, /128 of 417/);
  assert.match(view.headline, /part of the site rather than all of it/);
  assert.equal(view.reason, "Stopped at the 150-page safety limit.");
});

test("partial comes from `complete`, never from comparing counts", () => {
  /*
   * A crawl can read every page it found and still be incomplete, because
   * sitemap discovery was cut short and there are sections it never heard of.
   * Counting pages would call this finished. The server already decided.
   */
  const view = crawlView(
    crawl({
      complete: false,
      stoppedBecause: "completed",
      evaluated: 128,
      discovered: 128,
      queuedAtStop: 0,
      sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "max-files" },
    }),
  );

  assert.equal(view.partial, true, "evaluated equals discovered, and it is still partial");
  assert.match(view.reason ?? "", /sitemaps could not be read in full/);
});

test("every stop reason has words a person can read", () => {
  const reasons = ["max-pages", "max-duration", "max-queue", "deadline", "completed"] as const;

  for (const stoppedBecause of reasons) {
    const text = stopReasonText(crawl({ stoppedBecause }));
    assert.ok(text.length > 0, stoppedBecause);
    // Never the raw enum: nobody outside this codebase knows what max-queue is.
    assert.ok(!text.includes(stoppedBecause), `${stoppedBecause} leaked into the text`);
  }
});

test("the page limit in the message is the one actually configured", () => {
  const text = stopReasonText(crawl({ stoppedBecause: "max-pages", limits: { ...crawl().limits, maxPages: 40 } }));

  assert.equal(text, "Stopped at the 40-page safety limit.");
});

test("crawl facts show only what happened", () => {
  const quiet = crawlView(crawl()).facts.map((f) => f.label);

  // No row of zeroes: "0 pages excluded by robots.txt" invites a question
  // nobody asked and implies something was nearly wrong.
  assert.ok(!quiet.some((label) => /robots|not web pages|not visited/i.test(label)));

  const busy = crawlView(
    crawl({
      complete: false,
      stoppedBecause: "max-pages",
      unavailable: [{ url: "https://example.com/a", reason: "timeout" }],
      skippedNonHtml: 3,
      queuedAtStop: 267,
      robots: { status: "rules", enforced: true, excluded: 12 },
    }),
  ).facts;

  const labels = busy.map((f) => f.label).join(" | ");
  assert.match(labels, /robots/i);
  assert.match(labels, /not web pages/i);
  assert.match(labels, /not visited/i);
  assert.deepEqual(
    busy.find((f) => /robots/i.test(f.label)),
    { label: "Excluded by robots.txt", value: "12" },
  );
});

test("unread robots.txt is disclosed rather than passed over", () => {
  assert.equal(robotsNote(crawl()), null);

  const note = robotsNote(
    crawl({ robots: { status: "unavailable", enforced: false, excluded: 0 } }),
  );
  assert.match(note ?? "", /could not be read/);
});

// ---------------------------------------------------------------------------
// This layer decides nothing
// ---------------------------------------------------------------------------

test("the view layer contains no severity, threshold or grading logic", () => {
  const code = sourceOf("./siteFindingsView.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const word of ['"critical"', '"high"', '"medium"', '"good"', "severity"]) {
    assert.ok(!code.includes(word), `${word} must not appear in a presentation layer`);
  }
  // No arithmetic that could invent a count or a proportion.
  assert.ok(!/\/\s*\w+\s*\)\s*\*\s*100|toFixed|Math\.round/.test(code), "no percentages");
  assert.ok(!/\.filter\([^)]*fires|evaluate\(/.test(code), "no rule evaluation");
});

test("headings name the two kinds plainly", () => {
  assert.equal(SITE_FINDINGS_HEADING, "Site-wide issues");
  assert.equal(PAGE_FINDINGS_HEADING, "Page-level issues");
});

// ---------------------------------------------------------------------------
// A file we could not check is never reported as missing
//
// The bug this replaces: robots.txt that timed out was displayed as
// "Not found" — a claim about the client's website drawn entirely from our own
// failed request.
// ---------------------------------------------------------------------------

test("a found file shows what was found", () => {
  assert.equal(siteFileText("found", "Found"), "Found");
  assert.equal(
    siteFileText("found", "https://example.com/sitemap.xml"),
    "https://example.com/sitemap.xml",
  );
});

test("a genuinely absent file reads as Not found", () => {
  // The server told us. That claim is ours to make.
  assert.equal(siteFileText("absent", "Found"), "Not found");
});

test("an UNAVAILABLE file is never rendered as Not found", () => {
  const text = siteFileText("unavailable", "Found");

  assert.equal(text, "Could not be checked");
  assert.notEqual(text, "Not found");
  assert.ok(!/not found/i.test(text), "the reader must not infer absence");
});

test("the three states produce three different sentences", () => {
  const seen = new Set([
    siteFileText("found", "Found"),
    siteFileText("absent", "Found"),
    siteFileText("unavailable", "Found"),
  ]);

  assert.equal(seen.size, 3, "collapsing any two of them is the original bug");
});

test("the unavailable wording blames nothing on the website", () => {
  const text = siteFileText("unavailable", "Found");

  // "Could not be checked" is about us. "Missing", "broken" or "failed" would
  // read as a fault of the site.
  assert.ok(!/missing|broken|fail|error|invalid/i.test(text));
});


// ---------------------------------------------------------------------------
// ONE PAGE IS A PAGE
//
// The partial headline hard-coded the plural, so the smallest site there is
// read "1 of 1 pages found on this site were read". Two numbers appear in that
// sentence and they agree with different things: the noun follows what was
// FOUND, the verb follows what was READ.
// ---------------------------------------------------------------------------

const partialCrawl = (evaluated: number, discovered: number) =>
  crawlView(
    crawl({ evaluated, discovered, complete: false, stoppedBecause: "max-pages" }),
  ).headline;

test("exactly one page found and read is entirely singular", () => {
  const headline = partialCrawl(1, 1);

  assert.match(headline, /^1 of 1 page found on this site was read/);
  assert.doesNotMatch(headline, /1 pages/);
  assert.doesNotMatch(headline, /were read/);
});

test("the noun follows what was found, the verb follows what was read", () => {
  // One page read out of a hundred found: plural noun, singular verb.
  const oneOfMany = partialCrawl(1, 100);
  assert.match(oneOfMany, /^1 of 100 pages found on this site was read/);

  // Many read out of many found: both plural.
  const manyOfMany = partialCrawl(25, 100);
  assert.match(manyOfMany, /^25 of 100 pages found on this site were read/);
});

test("zero and two read the way English does", () => {
  assert.match(partialCrawl(0, 5), /^0 of 5 pages found on this site were read/);
  assert.match(partialCrawl(2, 10), /^2 of 10 pages found on this site were read/);
  assert.match(partialCrawl(150, 400), /^150 of 400 pages found on this site were read/);
});

test("the sentence still says what it said before", () => {
  // The wording change is grammar only. The meaning it carries — that this
  // covers part of the site — must survive it.
  assert.match(partialCrawl(2, 10), /covers part of the site rather than all of it\.$/);
});

test("the complete-crawl wording is untouched", () => {
  assert.equal(
    crawlView(crawl({ evaluated: 1, discovered: 1 })).headline,
    "1 page read. Every page we found was visited.",
  );
  assert.equal(
    crawlView(crawl({ evaluated: 12, discovered: 12 })).headline,
    "12 pages read. Every page we found was visited.",
  );
});

// ---------------------------------------------------------------------------
// WHAT THE REPORT CALLS ITSELF
//
// One line, shown on the results page and on the PDF cover. It was written in
// the page until the PDF needed the same two words, and a second copy is how
// an export comes to claim a whole-site audit the browser called partial.
// ---------------------------------------------------------------------------

test("a crawl that covered the site says the audit is complete", () => {
  assert.equal(auditStatusText(true), "Website audit complete");
});

test("a crawl that did not says the audit is partial", () => {
  /*
   * "Complete" is a claim about the SITE, so it may only be made when the
   * crawl actually covered it. The caller passes the server's own verdict;
   * nothing here recomputes it from counts.
   */
  assert.equal(auditStatusText(false), "Partial website audit");
});

test("the two never read as each other", () => {
  assert.notEqual(auditStatusText(true), auditStatusText(false));
  assert.ok(!auditStatusText(false).includes("complete"));
  assert.ok(!auditStatusText(true).includes("Partial"));
});
