/**
 * Tests for the site-measurement rows.
 *
 * The thing being defended: a measurement that came back HEALTHY must still
 * appear. Every one of these facts used to be invisible unless it was bad
 * enough to produce a finding, so a valid certificate and an unread one looked
 * exactly alike on the page.
 *
 * The second thing: "not there" and "we could not look" must never share a
 * sentence. That distinction is the whole discipline of this project, and it
 * has to survive the trip to the screen.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  NOT_CHECKED,
  NOT_FOUND,
  contentFacts,
  crawlLimitFacts,
  crawlStatusText,
  discoverySourceFacts,
  fieldOverallText,
  headingCountText,
  robotsFacts,
  sitemapDiscoveryFacts,
  withThousands,
  categoryLabel,
  certificateFacts,
  dmarcFacts,
  dnsFacts,
  groupByCategory,
  groupSkippedByReason,
  ruleTitle,
  severityCounts,
  skippedCheckCount,
  crawlCountTiles,
  mxText,
  readableDate,
  readableTimestamp,
  recordSetText,
  spfFacts,
  strategyLabel,
  expiryNote,
  certificateProblemFacts,
  certificateProblemLabel,
  cookieSummary,
  cspSummary,
  hstsSummary,
  METRIC_NOT_REPORTED,
  fieldShiftText,
  labShiftText,
  securityFacts,
  metricDurationText,
  mixedContentSummary,
  ratingLabel,
  severityLabel,
} from "./measurementsView.ts";
import type {
  DnsData,
  DnsRecordSet,
  FieldPerformance,
  Finding,
  MxRecord,
  SecurityData,
  SeoData,
  SslData,
  TechnicalData,
} from "../types.ts";
import type { SiteCrawlSummary } from "../collector/crawlSite.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const found = <T,>(records: T[]): DnsRecordSet<T> => ({ status: "found", records, error: null });
const absent = <T,>(): DnsRecordSet<T> => ({ status: "absent", records: [], error: null });
const failed = <T,>(): DnsRecordSet<T> => ({ status: "error", records: [], error: "The lookup timed out." });

function ssl(overrides: Partial<SslData> = {}): SslData {
  return {
    status: "checked",
    hostname: "example.com",
    certificate: {
      validFrom: "2026-01-15T00:00:00.000Z",
      validTo: "2026-10-27T22:17:21.000Z",
      daysUntilExpiry: 84,
      issuer: "DigiCert Inc",
      subject: "example.com",
      subjectAltNames: ["example.com", "www.example.com"],
      coversHostname: true,
      hostnameMatch: "exact",
      protocol: "TLSv1.3",
    },
    trusted: true,
    problem: null,
    failure: null,
    message: "The certificate is valid and trusted.",
    ...overrides,
  } as SslData;
}

function dns(overrides: Partial<DnsData> = {}): DnsData {
  return {
    hostname: "www.example.com",
    emailDomain: "example.com",
    a: found(["93.184.216.34"]),
    aaaa: absent<string>(),
    mx: found<MxRecord>([{ exchange: "mail.example.com", priority: 10 }]),
    ns: found(["ns1.example.com", "ns2.example.com"]),
    txt: found(["v=spf1 -all"]),
    spf: { status: "found", record: "v=spf1 -all", error: null },
    dmarc: {
      status: "found",
      record: "v=DMARC1; p=reject",
      error: null,
      hostname: "_dmarc.example.com",
      appliesTo: "example.com",
      policyDomain: "example.com",
      inherited: false,
      effectivePolicy: "reject",
    },
    ...overrides,
  } as DnsData;
}

const valueOf = (rows: ReturnType<typeof certificateFacts>, label: string) =>
  rows.find((row) => row.label === label)?.value;
const noteOf = (rows: ReturnType<typeof certificateFacts>, label: string) =>
  rows.find((row) => row.label === label)?.note;

// ---------------------------------------------------------------------------
// A HEALTHY certificate is visible
// ---------------------------------------------------------------------------

test("a valid certificate shows its details rather than nothing", () => {
  const rows = certificateFacts(ssl());

  assert.equal(valueOf(rows, "Issued by"), "DigiCert Inc");
  assert.equal(valueOf(rows, "Issued to"), "example.com");
  assert.equal(valueOf(rows, "Valid from"), "15 January 2026");
  assert.equal(valueOf(rows, "Expires"), "27 October 2026");
  assert.equal(noteOf(rows, "Expires"), "84 days from now");
  assert.equal(valueOf(rows, "Covers this address"), "Yes");
  assert.equal(valueOf(rows, "Trusted"), "Yes, by the system's certificate store");
  assert.equal(valueOf(rows, "Protocol"), "TLSv1.3");
});

test("the other names on the certificate are shown, and capped", () => {
  const many = Array.from({ length: 10 }, (_, i) => `n${i}.example.com`);
  const rows = certificateFacts(
    ssl({ certificate: { ...ssl().certificate!, subjectAltNames: many } }),
  );

  const note = noteOf(rows, "Covers this address") ?? "";
  assert.match(note, /n0\.example\.com/);
  assert.match(note, /and 4 more/);
});

test("a wildcard match says so rather than just yes", () => {
  const rows = certificateFacts(
    ssl({ certificate: { ...ssl().certificate!, hostnameMatch: "wildcard" } }),
  );

  assert.equal(valueOf(rows, "Covers this address"), "Yes, by a wildcard");
});

// --- the states that are NOT a certificate ---------------------------------

test("no HTTPS is not a failed check, and does not read like one", () => {
  const rows = certificateFacts(
    ssl({ status: "not-applicable", certificate: null, trusted: null, message: "The site is not served over HTTPS." }),
  );

  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /not served over HTTPS/);
  assert.notEqual(rows[0].value, NOT_CHECKED);
});

test("an unreachable certificate says we could not check, never that it is bad", () => {
  for (const status of ["blocked", "unreachable"] as const) {
    const rows = certificateFacts(ssl({ status, certificate: null, trusted: null, message: "The connection timed out." }));

    assert.equal(rows[0].value, NOT_CHECKED, status);
    assert.equal(rows[0].note, "The connection timed out.");
  }
});

test("a connection with no readable certificate is unknown, not untrusted", () => {
  const rows = certificateFacts(ssl({ certificate: null }));

  assert.equal(rows[0].value, NOT_CHECKED);
  assert.doesNotMatch(rows[0].note ?? "", /not trusted/i);
});

test("unknown trust and unknown coverage are never reported as No", () => {
  /*
   * The dangerous shortcut. `trusted: null` means the platform gave us no
   * verdict, and `coversHostname: null` means the certificate carried no names
   * to compare. Reporting either as "No" tells a client their certificate is
   * broken on the strength of a check that did not happen.
   */
  const rows = certificateFacts(
    ssl({
      trusted: null,
      certificate: { ...ssl().certificate!, coversHostname: null, hostnameMatch: null },
    }),
  );

  assert.equal(valueOf(rows, "Trusted"), NOT_CHECKED);
  assert.equal(valueOf(rows, "Covers this address"), NOT_CHECKED);
});

test("a genuinely uncovered address does say No", () => {
  const rows = certificateFacts(
    ssl({ certificate: { ...ssl().certificate!, coversHostname: false, hostnameMatch: "none" } }),
  );

  assert.match(valueOf(rows, "Covers this address") ?? "", /^No/);
});

test("an expired certificate reports how long ago, without grading it", () => {
  const rows = certificateFacts(
    ssl({ certificate: { ...ssl().certificate!, daysUntilExpiry: -21 }, problem: "expired", trusted: false }),
  );

  assert.equal(noteOf(rows, "Expires"), "Expired 21 days ago");
  assert.match(noteOf(rows, "Trusted") ?? "", /expired/i);
});

test("dates are written the same way wherever the browser thinks it is", () => {
  assert.equal(readableDate("2026-10-27T22:17:21.000Z"), "27 October 2026");
  assert.equal(readableDate("2026-01-01T00:00:00.000Z"), "1 January 2026");
  assert.equal(readableDate(null), null);
  assert.equal(readableDate("not a date"), null);
});

test("a moment carries the time of day and names its timezone", () => {
  assert.equal(
    readableTimestamp("2026-10-27T22:17:21.000Z"),
    "27 October 2026 at 22:17 UTC",
  );
});

test("the hour and the minute are padded, so the column lines up", () => {
  assert.equal(readableTimestamp("2026-01-01T00:00:00.000Z"), "1 January 2026 at 00:00 UTC");
  assert.equal(readableTimestamp("2026-01-01T09:05:00.000Z"), "1 January 2026 at 09:05 UTC");
});

test("a moment reads identically wherever the machine thinks it is", () => {
  /*
   * The reason the zone is named rather than converted. This value is
   * rendered on a server whose timezone nobody chose, and a time that looks
   * local but is not can be the wrong day for an audit run late in the
   * evening. Stated in UTC, it can be checked against the screen instead of
   * quietly disagreeing with it.
   */
  const before = process.env.TZ;
  try {
    process.env.TZ = "Asia/Kolkata";
    assert.equal(readableTimestamp("2026-09-08T20:30:00.000Z"), "8 September 2026 at 20:30 UTC");
    process.env.TZ = "America/Los_Angeles";
    assert.equal(readableTimestamp("2026-09-08T20:30:00.000Z"), "8 September 2026 at 20:30 UTC");
  } finally {
    process.env.TZ = before;
  }
});

test("a moment refuses anything it cannot read, exactly as a date does", () => {
  assert.equal(readableTimestamp(null), null);
  assert.equal(readableTimestamp(""), null);
  assert.equal(readableTimestamp("not a date"), null);
  assert.equal(readableTimestamp("<script>steal()</script>"), null);
});

test("a moment is the date helper plus a time, not a second date formatter", () => {
  // One month-name table and one unparseable-input policy. Two would drift.
  const iso = "2026-03-09T07:04:00.000Z";
  assert.ok(
    (readableTimestamp(iso) ?? "").startsWith(readableDate(iso) ?? "!"),
    "the moment opens with exactly the date the date helper gives",
  );
});

test("the expiry note handles today and one day either side", () => {
  assert.equal(expiryNote(0), "Expires today");
  assert.equal(expiryNote(1), "1 day from now");
  assert.equal(expiryNote(-1), "Expired 1 day ago");
  assert.equal(expiryNote(null), undefined);
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

test("records that exist are listed", () => {
  const rows = dnsFacts(dns());

  assert.equal(valueOf(rows, "Website address records"), "93.184.216.34");
  assert.equal(valueOf(rows, "Mail servers"), "mail.example.com (priority 10)");
  assert.equal(valueOf(rows, "Name servers"), "ns1.example.com, ns2.example.com");
});

test("which name each lookup used is stated", () => {
  // They differ for a www site, and the difference explains the rows.
  const rows = dnsFacts(dns());

  assert.match(noteOf(rows, "Website address records") ?? "", /www\.example\.com/);
  assert.match(noteOf(rows, "Mail servers") ?? "", /example\.com/);
});

test("absent records and unreadable ones read differently", () => {
  assert.equal(recordSetText(absent<string>()), "None published");
  assert.equal(recordSetText(failed<string>()), NOT_CHECKED);
  assert.notEqual(recordSetText(absent<string>()), recordSetText(failed<string>()));

  assert.equal(mxText(absent<MxRecord>()), "None published");
  assert.equal(mxText(failed<MxRecord>()), NOT_CHECKED);
});

test("mail servers come out in priority order", () => {
  const set = found<MxRecord>([
    { exchange: "backup.example.com", priority: 20 },
    { exchange: "primary.example.com", priority: 5 },
  ]);

  assert.match(mxText(set), /^primary\.example\.com \(priority 5\)/);
});

test("a long record list is summarised rather than dumped", () => {
  const many = Array.from({ length: 12 }, (_, i) => `ns${i}.example.com`);
  const text = recordSetText(found(many));

  assert.match(text, /and 4 more$/);
});

test("IPv6 is only shown when there is something to say", () => {
  const without = dnsFacts(dns());
  assert.equal(without.find((r) => r.label === "IPv6 records"), undefined);

  const with6 = dnsFacts(dns({ aaaa: found(["2606:2800:220:1:248:1893:25c8:1946"]) }));
  assert.ok(with6.find((r) => r.label === "IPv6 records"));
});

// ---------------------------------------------------------------------------
// SPF and DMARC — visible whether or not they are a problem
// ---------------------------------------------------------------------------

test("a healthy SPF record is shown", () => {
  const rows = spfFacts(dns());

  assert.equal(rows[0].value, "Published");
  assert.equal(rows[0].note, "v=spf1 -all");
});

test("SPF absent and SPF unreadable are different sentences", () => {
  const missing = spfFacts(dns({ spf: { status: "absent", record: null, error: null } }));
  const unknown = spfFacts(dns({ spf: { status: "error", record: null, error: "The lookup timed out." } }));

  assert.equal(missing[0].value, NOT_FOUND);
  assert.equal(unknown[0].value, NOT_CHECKED);
  assert.notEqual(missing[0].value, unknown[0].value);
});

test("nothing here claims SPF makes email secure", () => {
  const rows = spfFacts(dns());
  const text = rows.map((r) => `${r.label} ${r.value} ${r.note ?? ""}`).join(" ");

  assert.doesNotMatch(text, /secure|protected|safe/i);
});

test("a direct DMARC policy shows its effective policy and where it came from", () => {
  const rows = dmarcFacts(dns());

  assert.equal(valueOf(rows, "DMARC"), "Published, policy reject");
  assert.equal(valueOf(rows, "Applies to"), "example.com");
  assert.equal(valueOf(rows, "Published by"), "example.com");
  assert.equal(valueOf(rows, "Record"), "v=DMARC1; p=reject");
});

test("an INHERITED policy names the parent it came from", () => {
  /*
   * The real case: the audited domain publishes nothing and its parent's
   * record governs it through sp=. Both names must appear, or the reader
   * cannot tell whose policy they are looking at.
   */
  const rows = dmarcFacts(
    dns({
      dmarc: {
        status: "found",
        record: "v=DMARC1; p=quarantine; sp=none",
        error: null,
        hostname: "_dmarc.cern.ch",
        appliesTo: "info.cern.ch",
        policyDomain: "cern.ch",
        inherited: true,
        effectivePolicy: "none",
      },
    } as Partial<DnsData>),
  );

  assert.equal(valueOf(rows, "DMARC"), "Published, policy none");
  assert.equal(valueOf(rows, "Applies to"), "info.cern.ch");
  assert.equal(valueOf(rows, "Inherited from"), "cern.ch");
  assert.equal(valueOf(rows, "Published by"), undefined, "it is not published by the audited domain");
});

test("DMARC absent and DMARC unreadable are different sentences", () => {
  const missing = dmarcFacts(
    dns({ dmarc: { ...dns().dmarc, status: "absent", record: null, policyDomain: null, effectivePolicy: null } }),
  );
  const unknown = dmarcFacts(
    dns({ dmarc: { ...dns().dmarc, status: "error", record: null, error: "The lookup timed out.", policyDomain: null, effectivePolicy: null } }),
  );

  assert.equal(missing[0].value, NOT_FOUND);
  assert.equal(unknown[0].value, NOT_CHECKED);
});

test("a record with no policy we recognise says so instead of guessing", () => {
  const rows = dmarcFacts(
    dns({ dmarc: { ...dns().dmarc, record: "v=DMARC1; p=banana", effectivePolicy: null } }),
  );

  assert.equal(valueOf(rows, "DMARC"), "Published");
  assert.match(noteOf(rows, "DMARC") ?? "", /no policy this audit recognises/);
});

// ---------------------------------------------------------------------------
// Skipped checks
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Findings by category
// ---------------------------------------------------------------------------

const finding = (id: string, category: Finding["category"], severity: Finding["severity"]): Finding =>
  ({ id, title: id, category, severity, evidence: "e", remediation: "r" }) as Finding;

test("findings are gathered under the category their rule declared", () => {
  const groups = groupByCategory([
    finding("seo.a", "seo", "medium"),
    finding("sec.a", "security", "critical"),
    finding("seo.b", "seo", "high"),
  ]);

  assert.deepEqual(groups.map((g) => g.category), ["security", "seo"]);
  assert.deepEqual(groups[1].findings.map((f) => f.id), ["seo.b", "seo.a"], "severity order kept");
});

test("the worst thing on the page is still near the top", () => {
  /*
   * The risk grouping introduces: burying a critical security problem under a
   * list of medium SEO ones. Groups are ordered by the worst finding inside
   * them, so the category holding the critical comes first.
   */
  const groups = groupByCategory([
    finding("seo.a", "seo", "medium"),
    finding("seo.b", "seo", "medium"),
    finding("seo.c", "seo", "medium"),
    finding("sec.a", "security", "critical"),
  ]);

  assert.equal(groups[0].category, "security");
  assert.equal(groups[0].findings[0].severity, "critical");
});

test("grouping invents nothing and drops nothing", () => {
  const input = [
    finding("a", "seo", "medium"),
    finding("b", "security", "high"),
    finding("c", "technical", "critical"),
    finding("d", "speed", "good"),
  ];
  const groups = groupByCategory(input);

  assert.equal(groups.flatMap((g) => g.findings).length, input.length);
  assert.equal(groups.length, 4);
  // Severity is the rule's own and must be carried untouched.
  for (const group of groups) {
    for (const f of group.findings) {
      assert.equal(f.severity, input.find((i) => i.id === f.id)?.severity);
    }
  }
});

test("only categories that are actually present appear", () => {
  const groups = groupByCategory([finding("a", "seo", "medium")]);

  assert.deepEqual(groups.map((g) => g.category), ["seo"]);
});

test("empty in, empty out", () => {
  assert.deepEqual(groupByCategory([]), []);
});

test("every category has a readable name", () => {
  for (const category of ["seo", "speed", "security", "technical"] as const) {
    const label = categoryLabel(category);
    assert.ok(label.length > 0);
    assert.notEqual(label, category, "a label, not the raw value");
  }
});

// ---------------------------------------------------------------------------
// Performance strategy
// ---------------------------------------------------------------------------

test("the simulation says which device it simulated", () => {
  // A score presented without this is one a client reads as their desktop site.
  assert.equal(strategyLabel("mobile"), "Mobile simulation");
  assert.equal(strategyLabel("desktop"), "Desktop simulation");
  assert.equal(strategyLabel("MOBILE"), "Mobile simulation");
});

test("an unknown strategy is repeated rather than guessed at", () => {
  assert.equal(strategyLabel("tablet"), "tablet simulation");
});

test("a missing strategy produces no label at all", () => {
  // Never invent "mobile" just because it usually is.
  assert.equal(strategyLabel(null), null);
  assert.equal(strategyLabel(undefined), null);
  assert.equal(strategyLabel(""), null);
});

test("a null MX record is described, not rendered as a blank", () => {
  /*
   * A single MX with an empty name and priority 0 is how a domain states that
   * it accepts no email. Rendered naively it came out as "(priority 0)" — a
   * blank and a number — which reads as a broken report rather than a fact.
   * Found on a live audit of example.com, which publishes exactly this.
   */
  const nullMx = mxText(found<MxRecord>([{ exchange: "", priority: 0 }]));

  assert.equal(nullMx, "no mail server named (priority 0)");
  assert.doesNotMatch(nullMx, /^\s*\(/);

  // A root-label "." means the same thing and reads the same way.
  assert.equal(mxText(found<MxRecord>([{ exchange: ".", priority: 0 }])), "no mail server named (priority 0)");
});

test("a null MX is not confused with having no MX records at all", () => {
  // One is a published record; the other is the absence of one.
  const published = mxText(found<MxRecord>([{ exchange: "", priority: 0 }]));
  const none = mxText(absent<MxRecord>());

  assert.notEqual(published, none);
  assert.equal(none, "None published");
});

test("nothing about a null MX grades the domain", () => {
  // Whether a domain should accept mail is not this audit's business.
  const text = mxText(found<MxRecord>([{ exchange: "", priority: 0 }]));
  assert.doesNotMatch(text, /should|missing|problem|misconfigur/i);
});

// ---------------------------------------------------------------------------
// CRAWL, SITEMAP, ROBOTS, CONTENT, FIELD CATEGORY
//
// The second batch of measurements that reached the browser and were rendered
// nowhere. The recurring danger in all of them is the same: a boolean or a
// zero that means "we did not find out" being printed as though it meant "no"
// or "none".
// ---------------------------------------------------------------------------

function crawl(overrides: Partial<SiteCrawlSummary> = {}): SiteCrawlSummary {
  return {
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
    discovered: 12,
    queuedAtStop: 0,
    evaluated: 12,
    unavailable: [],
    skippedNonHtml: 0,
    sources: { html: 9, sitemap: 3 },
    sitemapDiscovery: { attempted: true, complete: true, stoppedBecause: "completed" },
    robots: { status: "rules", enforced: true, excluded: 0 },
    ...overrides,
  } as SiteCrawlSummary;
}

const technical = (overrides: Partial<TechnicalData> = {}): TechnicalData => ({
  robotsTxtStatus: "found",
  robotsBlocksEverything: false,
  sitemapStatus: "found",
  sitemapUrl: "https://example.com/sitemap.xml",
  ...overrides,
});

// --- crawl status ----------------------------------------------------------

test("a finished crawl says complete, and says what ended it", () => {
  assert.equal(crawlStatusText(crawl()), "Complete — the queue was emptied");
});

test("every stop reason has its own wording", () => {
  const seen = new Set<string>();

  for (const reason of ["completed", "max-pages", "max-duration", "max-queue", "deadline"] as const) {
    const text = crawlStatusText(crawl({ stoppedBecause: reason, complete: false }));
    assert.match(text, /^Partial — /, reason);
    seen.add(text);
  }

  assert.equal(seen.size, 5, "no two reasons read the same");
});

test("complete is the server's verdict, not merely an emptied queue", () => {
  /*
   * The case this exists for: every page it knew about was read, so the queue
   * emptied, but a sitemap went unread and the crawl is therefore not whole.
   * Saying "Complete" here would claim coverage the audit does not have.
   */
  const text = crawlStatusText(
    crawl({
      complete: false,
      stoppedBecause: "completed",
      sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "unavailable" },
    }),
  );

  assert.match(text, /^Partial/);
});

test("discovery sources are read, never recomputed", () => {
  const rows = discoverySourceFacts(crawl({ sources: { html: 120, sitemap: 37 } }));

  assert.equal(valueOf(rows, "Found by following links"), "120");
  assert.equal(valueOf(rows, "Found in the sitemap"), "37");
});

test("large numbers are grouped, the same way everywhere", () => {
  assert.equal(withThousands(0), "0");
  assert.equal(withThousands(999), "999");
  assert.equal(withThousands(1000), "1,000");
  assert.equal(withThousands(12480), "12,480");
  assert.equal(withThousands(1234567), "1,234,567");
});

test("the limits are shown in units a person reads", () => {
  const rows = crawlLimitFacts(crawl().limits);

  assert.equal(valueOf(rows, "Most pages read"), "150");
  assert.equal(valueOf(rows, "Longest crawl"), "5 minutes");
  assert.equal(valueOf(rows, "Largest queue"), "2,000 addresses");
  assert.equal(valueOf(rows, "Largest page read"), "5 MB");
  assert.equal(valueOf(rows, "Pages at once"), "3");
  assert.equal(valueOf(rows, "Pause between requests"), "200 ms");
});

test("a duration that is not whole minutes stays in seconds", () => {
  const rows = crawlLimitFacts({ ...crawl().limits, maxDurationMs: 90_000 });
  assert.equal(valueOf(rows, "Longest crawl"), "90 seconds");
});

// --- sitemap discovery -----------------------------------------------------

test("a complete sitemap walk says so, with the count it produced", () => {
  const rows = sitemapDiscoveryFacts(crawl());

  assert.equal(valueOf(rows, "Sitemap discovery"), "Complete");
  assert.equal(valueOf(rows, "Addresses taken from sitemaps"), "3");
});

test("a sitemap that could not be read is NOT reported as absent", () => {
  /*
   * The distinction the whole engine is built on, arriving at the screen. An
   * unread sitemap may list a section of the site nobody saw; a site with no
   * sitemap has simply been checked.
   */
  const unread = sitemapDiscoveryFacts(
    crawl({
      complete: false,
      sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "unavailable" },
    }),
  );

  assert.equal(valueOf(unread, "Sitemap discovery"), NOT_CHECKED);
  assert.notEqual(valueOf(unread, "Sitemap discovery"), NOT_FOUND);
  assert.match(noteOf(unread, "Sitemap discovery") ?? "", /could not be read/);
});

test("a walk stopped by a limit is incomplete, and names the limit", () => {
  for (const reason of ["max-files", "max-urls", "budget", "deadline"] as const) {
    const rows = sitemapDiscoveryFacts(
      crawl({
        complete: false,
        sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: reason },
      }),
    );

    assert.equal(valueOf(rows, "Sitemap discovery"), "Incomplete", reason);
    assert.ok((noteOf(rows, "Sitemap discovery") ?? "").length > 0, reason);
  }
});

test("sitemaps turned off is not a failure", () => {
  const rows = sitemapDiscoveryFacts(
    crawl({ sitemapDiscovery: { attempted: false, complete: true, stoppedBecause: "completed" } }),
  );

  assert.equal(valueOf(rows, "Sitemap discovery"), "Not attempted");
  assert.notEqual(valueOf(rows, "Sitemap discovery"), NOT_CHECKED);
});

test("zero addresses from a COMPLETE walk is explained, not left bare", () => {
  const rows = sitemapDiscoveryFacts(crawl({ sources: { html: 9, sitemap: 0 } }));

  assert.equal(valueOf(rows, "Addresses taken from sitemaps"), "0");
  assert.match(noteOf(rows, "Addresses taken from sitemaps") ?? "", /listed no addresses/);
});

test("zero addresses from a FAILED walk carries no such reassurance", () => {
  // Zero here means we could not read them, and must not read as "there were none".
  const rows = sitemapDiscoveryFacts(
    crawl({
      complete: false,
      sources: { html: 9, sitemap: 0 },
      sitemapDiscovery: { attempted: true, complete: false, stoppedBecause: "unavailable" },
    }),
  );

  assert.equal(noteOf(rows, "Addresses taken from sitemaps"), undefined);
});

// --- robots ----------------------------------------------------------------

test("a robots file that blocks nothing says so plainly", () => {
  const rows = robotsFacts(crawl(), technical());

  assert.equal(valueOf(rows, "robots.txt"), "Published, with rules");
  assert.equal(valueOf(rows, "Blocks all search engines"), "No");
});

test("a robots file that blocks everything says Yes, with no badge", () => {
  const rows = robotsFacts(crawl(), technical({ robotsBlocksEverything: true }));

  assert.equal(valueOf(rows, "Blocks all search engines"), "Yes");
  // The severity belongs to the rule, not to this measurement.
  const text = rows.map((r) => `${r.value} ${r.note ?? ""}`).join(" ");
  assert.doesNotMatch(text, /critical|severe|urgent/i);
});

test("an UNREADABLE robots file never reports No", () => {
  /*
   * `robotsBlocksEverything` is false when the file blocks nobody AND when it
   * could not be read at all. Printing the boolean would tell a client their
   * site is open to search engines on the strength of a request that failed.
   */
  const rows = robotsFacts(
    crawl({ robots: { status: "unavailable", enforced: false, excluded: 0 } }),
    technical({ robotsTxtStatus: "unavailable", robotsBlocksEverything: false }),
  );

  assert.equal(valueOf(rows, "robots.txt"), NOT_CHECKED);
  assert.equal(valueOf(rows, "Blocks all search engines"), NOT_CHECKED);
  assert.notEqual(valueOf(rows, "Blocks all search engines"), "No");
});

test("a missing technical block is unknown, not No", () => {
  // `technical` is null when the audit ran out of time before those checks.
  const rows = robotsFacts(crawl(), null);

  assert.equal(valueOf(rows, "Blocks all search engines"), NOT_CHECKED);
});

test("an absent robots file is not the same as an unreadable one", () => {
  const rows = robotsFacts(
    crawl({ robots: { status: "absent", enforced: true, excluded: 0 } }),
    technical({ robotsTxtStatus: "absent" }),
  );

  assert.equal(valueOf(rows, "robots.txt"), NOT_FOUND);
  assert.equal(valueOf(rows, "Blocks all search engines"), "No", "a site with no rules blocks nobody");
});

test("a crawl that could not apply the rules says so", () => {
  const rows = robotsFacts(
    crawl({ robots: { status: "unavailable", enforced: false, excluded: 0 } }),
    technical({ robotsTxtStatus: "unavailable" }),
  );

  assert.equal(valueOf(rows, "Rules applied to this crawl"), "No");
});

test("excluded pages are shown as normal behaviour, and hidden when zero", () => {
  const none = robotsFacts(crawl(), technical());
  assert.equal(valueOf(none, "Pages the site asked us to skip"), undefined);

  const some = robotsFacts(crawl({ robots: { status: "rules", enforced: true, excluded: 4 } }), technical());
  assert.equal(valueOf(some, "Pages the site asked us to skip"), "4");
  assert.match(noteOf(some, "Pages the site asked us to skip") ?? "", /behaving normally/);
});

// --- page content ----------------------------------------------------------

const seo = (overrides: Partial<SeoData> = {}): SeoData =>
  ({
    titleText: "T",
    titleLength: 1,
    metaDescriptionText: null,
    metaDescriptionLength: 0,
    bodyTextLength: 12_480,
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h1Texts: ["Enterprise Travel Management"],
    headingSkips: [],
    imageCount: 0,
    imagesMissingAlt: 0,
    canonicalUrl: null,
    langAttribute: null,
    hasViewportMeta: true,
    ...overrides,
  }) as SeoData;

test("body text is reported as a number and never graded", () => {
  const rows = contentFacts(seo());

  assert.equal(valueOf(rows, "Readable text"), "12,480 characters");
  const text = rows.map((r) => `${r.value} ${r.note ?? ""}`).join(" ");
  // Word boundaries matter: "anything" contains "thin".
  assert.doesNotMatch(text, /(poor|good|thin|inadequate)/i);
  assert.doesNotMatch(text, /too little|should be/i);
});

test("a tiny page reports its real number, not a verdict", () => {
  assert.equal(valueOf(contentFacts(seo({ bodyTextLength: 32 })), "Readable text"), "32 characters");
  assert.equal(valueOf(contentFacts(seo({ bodyTextLength: 0 })), "Readable text"), "0 characters");
});





test("headingCountText on its own", () => {
  assert.equal(headingCountText(0, []), NOT_FOUND);
  assert.equal(headingCountText(1, ["a"]), "1 found");
  assert.equal(headingCountText(3, ["a", "b", "c"]), "3 found");
  assert.equal(headingCountText(3, ["a"]), "3 found, 2 with no text");
  assert.equal(headingCountText(1, []), "1 found, 1 with no text");
});

// --- what real visitors experienced ----------------------------------------

const field = (overrides: Partial<FieldPerformance> = {}): FieldPerformance =>
  ({
    status: "found",
    measuredUrl: "https://example.com/",
    scope: "page",
    overall: "FAST",
    lcp: null,
    inp: null,
    cls: null,
    fcp: null,
    ttfb: null,
    error: null,
    ...overrides,
  }) as FieldPerformance;

test("Google's own verdict is repeated, in each of its three values", () => {
  assert.equal(fieldOverallText(field({ overall: "FAST" })), "Fast");
  assert.equal(fieldOverallText(field({ overall: "AVERAGE" })), "Average");
  assert.equal(fieldOverallText(field({ overall: "SLOW" })), "Slow");
});

test("no field data means no verdict, rather than a made-up one", () => {
  assert.equal(fieldOverallText(field({ status: "absent", overall: null })), null);
  assert.equal(fieldOverallText(field({ status: "error", overall: null, error: "timed out" })), null);
});

test("metrics without an overall category produce no category", () => {
  // Google sometimes reports the individual metrics and no summary. Deriving
  // one from them here would be inventing Google's verdict.
  assert.equal(fieldOverallText(field({ overall: null })), null);
});

test("a found block with a stale category is still not trusted without found status", () => {
  assert.equal(fieldOverallText(field({ status: "absent", overall: "FAST" })), null);
});


// ---------------------------------------------------------------------------
// THE SEVERITY SPLIT
//
// "Findings (11)" was the only number on the page, and it is the wrong one:
// one critical among ten mediums is a different conversation from eleven
// mediums. Counted from what the rules decided — nothing here grades.
// ---------------------------------------------------------------------------

const sev = (id: string, severity: Finding["severity"]): Finding =>
  ({ id, title: id, category: "seo", severity, evidence: "e", remediation: "r" }) as Finding;

test("the split counts each severity the rules assigned", () => {
  const counts = severityCounts([
    sev("a", "critical"),
    sev("b", "high"),
    sev("c", "high"),
    sev("d", "medium"),
  ]);

  assert.deepEqual(
    counts.map((c) => [c.label, c.count]),
    [["Critical", 1], ["High", 2], ["Medium", 1]],
  );
});

test("worst comes first, whatever order the findings arrived in", () => {
  const counts = severityCounts([sev("a", "medium"), sev("b", "critical"), sev("c", "high")]);
  assert.deepEqual(counts.map((c) => c.severity), ["critical", "high", "medium"]);
});

test("a passing check is not a finding and is not counted", () => {
  const counts = severityCounts([sev("a", "good"), sev("b", "good"), sev("c", "medium")]);

  assert.deepEqual(counts.map((c) => [c.label, c.count]), [["Medium", 1]]);
});

test("severities with nothing in them are left out, not shown as zero", () => {
  const counts = severityCounts([sev("a", "medium")]);

  assert.equal(counts.length, 1);
  assert.ok(!counts.some((c) => c.count === 0));
});

test("no findings produces no summary at all", () => {
  assert.deepEqual(severityCounts([]), []);
  assert.deepEqual(severityCounts([sev("a", "good")]), []);
});

// ---------------------------------------------------------------------------
// SKIPPED CHECKS, BY REASON
//
// Grouping by rule solved one problem and left its mirror image: a site on
// plain HTTP skips three separate certificate checks, and all three carry the
// same sentence. The panel printed it three times.
// ---------------------------------------------------------------------------

test("a rule id becomes the rule's own written title", () => {
  assert.equal(ruleTitle("security.ssl.expired"), "TLS certificate has expired");
  assert.equal(ruleTitle("security.cookies.httponly"), "Cookies readable by page JavaScript");
  assert.doesNotMatch(ruleTitle("security.cookies.secure"), /^security\./);
});

test("an unknown id falls back to itself rather than inventing a name", () => {
  assert.equal(ruleTitle("nothing.like.this"), "nothing.like.this");
});

test("three checks sharing one reason read as one line naming all three", () => {
  const groups = groupSkippedByReason([
    { ruleId: "security.ssl.expired", reason: "The site is not served over HTTPS." },
    { ruleId: "security.ssl.hostname", reason: "The site is not served over HTTPS." },
    { ruleId: "security.ssl.untrusted", reason: "The site is not served over HTTPS." },
  ]);

  assert.equal(groups.length, 1, "one sentence, not three");
  assert.equal(groups[0].checks.length, 3, "and all three checks are still named");
  for (const title of groups[0].checks) assert.doesNotMatch(title, /^security\./);
});

test("one check with two reasons stays two lines", () => {
  // The case the earlier grouping was built for. It must survive the change.
  const groups = groupSkippedByReason([
    { ruleId: "security.cookies.secure", reason: "The site is not served over HTTPS." },
    { ruleId: "security.cookies.secure", reason: "This response set no cookies." },
  ]);

  assert.equal(groups.length, 2);
  for (const group of groups) assert.deepEqual(group.checks.length, 1);
});

test("no reason is lost and none is merged", () => {
  const input = [
    { ruleId: "a.one", reason: "first" },
    { ruleId: "b.two", reason: "second" },
    { ruleId: "c.three", reason: "first" },
  ];
  const groups = groupSkippedByReason(input);

  assert.equal(groups.length, 2);
  for (const check of input) {
    assert.ok(groups.some((g) => g.reason === check.reason), check.reason);
  }
});

test("the same check twice for the same reason is named once", () => {
  const groups = groupSkippedByReason([
    { ruleId: "seo.h1.missing", reason: "Too little text." },
    { ruleId: "seo.h1.missing", reason: "Too little text." },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].checks.length, 1);
});

test("the heading counts distinct CHECKS, not reasons", () => {
  const skipped = [
    { ruleId: "security.ssl.expired", reason: "no HTTPS" },
    { ruleId: "security.ssl.hostname", reason: "no HTTPS" },
    { ruleId: "security.cookies.secure", reason: "no cookies" },
  ];

  assert.equal(skippedCheckCount(skipped), 3);
});

// ---------------------------------------------------------------------------
// The crawl numbers, compactly
// ---------------------------------------------------------------------------

test("the tiles carry every crawl number, and invent none", () => {
  const tiles = crawlCountTiles(
    crawl({
      discovered: 417,
      evaluated: 128,
      queuedAtStop: 267,
      skippedNonHtml: 5,
      sources: { html: 416, sitemap: 0 },
      unavailable: [{ url: "https://example.com/x", reason: "404" }],
      robots: { status: "rules", enforced: true, excluded: 4 },
    } as Partial<SiteCrawlSummary>),
  );

  const by = (label: string) => tiles.find((t) => t.label === label)?.value;

  assert.equal(by("Discovered"), "417");
  assert.equal(by("Evaluated"), "128");
  assert.equal(by("From links"), "416");
  assert.equal(by("From sitemap"), "0");
  assert.equal(by("Not read"), "1");
  assert.equal(by("Not web pages"), "5");
  assert.equal(by("Excluded by robots"), "4");
  assert.equal(by("Queued at stop"), "267");
});

test("zeroes are kept here, because how it looked is a fact too", () => {
  const tiles = crawlCountTiles(crawl({ sources: { html: 0, sitemap: 0 } }));

  assert.equal(tiles.find((t) => t.label === "From sitemap")?.value, "0");
});

// ---------------------------------------------------------------------------
// SECURITY AND SPEED, IN WORDS
//
// These lines were written for the results page and lived inside it until the
// PDF needed them too. They were moved here unchanged, so what these tests pin
// is that the move changed nothing: the same inputs still produce the same
// strings, including the edge cases the wording exists to handle.
// ---------------------------------------------------------------------------

const hstsBlock = (over: Partial<SecurityData["hsts"]> = {}): SecurityData["hsts"] => ({
  applicable: true,
  valid: true,
  maxAgeSeconds: 15_552_000,
  disabledByZeroMaxAge: false,
  includesSubdomains: false,
  preload: false,
  ...over,
});

test("HSTS on a page without HTTPS is not applicable rather than missing", () => {
  assert.equal(
    hstsSummary(hstsBlock({ applicable: false }), false),
    "Not applicable — the page is not served over HTTPS",
  );
});

test("HSTS distinguishes no header from a header that switched itself off", () => {
  assert.equal(hstsSummary(hstsBlock(), false), "No HSTS header sent");
  assert.equal(
    hstsSummary(hstsBlock({ disabledByZeroMaxAge: true }), true),
    "Header present but switched off (max-age=0)",
  );
});

test("an unreadable max-age says so rather than reporting zero days", () => {
  assert.equal(
    hstsSummary(hstsBlock({ maxAgeSeconds: null }), true),
    "Header present, but its max-age could not be read",
  );
});

test("HSTS reports whole days, singular at one", () => {
  assert.equal(hstsSummary(hstsBlock({ maxAgeSeconds: 15_552_000 }), true), "180 days");
  assert.equal(hstsSummary(hstsBlock({ maxAgeSeconds: 86_400 }), true), "1 day");
  // Rounded, not truncated: half a day short of two is still two.
  assert.equal(hstsSummary(hstsBlock({ maxAgeSeconds: 129_600 }), true), "2 days");
});

test("HSTS appends the extras it was given, in order", () => {
  assert.equal(
    hstsSummary(hstsBlock({ maxAgeSeconds: 86_400, includesSubdomains: true }), true),
    "1 day · includes subdomains",
  );
  assert.equal(
    hstsSummary(
      hstsBlock({ maxAgeSeconds: 86_400, includesSubdomains: true, preload: true }),
      true,
    ),
    "1 day · includes subdomains · preload",
  );
  assert.equal(
    hstsSummary(hstsBlock({ maxAgeSeconds: 86_400, preload: true }), true),
    "1 day · preload",
  );
});

const securityWith = (over: Record<string, unknown> = {}): SecurityData =>
  ({
    contentSecurityPolicy: { present: false },
    contentSecurityPolicyReportOnly: { present: false },
    ...over,
  }) as unknown as SecurityData;

test("a report-only policy is never called present", () => {
  /*
   * THE DISTINCTION THIS FUNCTION EXISTS FOR. Report-only is monitored and not
   * enforced, so "Present" would claim protection the site does not have.
   */
  assert.equal(
    cspSummary(securityWith({ contentSecurityPolicyReportOnly: { present: true } })),
    "Report-only — monitored but not enforced",
  );
  assert.equal(
    cspSummary(securityWith({ contentSecurityPolicy: { present: true } })),
    "Present",
  );
  assert.equal(cspSummary(securityWith()), "Missing");
});

test("an enforced policy wins over a report-only one", () => {
  assert.equal(
    cspSummary(
      securityWith({
        contentSecurityPolicy: { present: true },
        contentSecurityPolicyReportOnly: { present: true },
      }),
    ),
    "Present",
  );
});

const oneCookie = (over: Record<string, unknown> = {}) => ({
  name: "session",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  ...over,
});

const cookiesOf = (list: unknown[]): SecurityData["cookies"] =>
  ({ total: list.length, cookies: list, notInspected: [] }) as unknown as SecurityData["cookies"];

test("a page that set no cookies says so, rather than reporting missing flags", () => {
  assert.equal(cookieSummary(cookiesOf([])), "None set by this page");
});

test("cookies with every flag set are reported as such, and pluralised", () => {
  assert.equal(cookieSummary(cookiesOf([oneCookie()])), "1 cookie, all flags set");
  assert.equal(cookieSummary(cookiesOf([oneCookie(), oneCookie()])), "2 cookies, all flags set");
});

test("each missing flag is counted separately", () => {
  assert.equal(
    cookieSummary(cookiesOf([oneCookie({ secure: false })])),
    "1 cookie — 1 without Secure",
  );
  assert.equal(
    cookieSummary(cookiesOf([oneCookie({ secure: false, httpOnly: false, sameSite: null })])),
    "1 cookie — 1 without Secure, 1 without HttpOnly, 1 without SameSite",
  );
  assert.equal(
    cookieSummary(cookiesOf([oneCookie({ httpOnly: false }), oneCookie({ httpOnly: false })])),
    "2 cookies — 2 without HttpOnly",
  );
});

test("the cookie summary reads flags and never a value", () => {
  // A cookie value is often a live session token, so none is ever captured.
  const withValue = oneCookie({ value: "super-secret-session-token" });
  assert.ok(!cookieSummary(cookiesOf([withValue])).includes("super-secret"));
});

const mixedWith = (over: Record<string, unknown> = {}): SecurityData["mixedContent"] =>
  ({
    applicable: true,
    total: 0,
    activeCount: 0,
    truncated: false,
    notInspected: [],
    ...over,
  }) as unknown as SecurityData["mixedContent"];

test("mixed content on a page without HTTPS is not applicable", () => {
  assert.equal(
    mixedContentSummary(mixedWith({ applicable: false })),
    "Not applicable — the page is not served over HTTPS",
  );
});

test("no insecure resources says what was actually read", () => {
  /*
   * "in the page HTML" is the point. Scripts are not run and stylesheets are
   * not downloaded, so a bare "None found" would claim more than was checked.
   */
  assert.equal(mixedContentSummary(mixedWith()), "None found in the page HTML");
});

test("insecure resources are counted, with the likely-blocked ones said separately", () => {
  assert.equal(
    mixedContentSummary(mixedWith({ total: 3 })),
    "3 found in the page HTML, loaded over plain HTTP",
  );
  assert.equal(
    mixedContentSummary(mixedWith({ total: 3, activeCount: 2 })),
    "3 found in the page HTML, loaded over plain HTTP, 2 likely blocked by browsers",
  );
});

test("every certificate problem has its own sentence", () => {
  assert.equal(certificateProblemLabel("expired"), "The certificate has expired");
  assert.equal(
    certificateProblemLabel("self-signed"),
    "The certificate is self-signed, so browsers will not trust it",
  );
  assert.equal(
    certificateProblemLabel("wrong-hostname"),
    "The certificate was issued for a different address",
  );
  assert.equal(certificateProblemLabel("untrusted"), "The certificate could not be verified");
});

test("every severity has a word, including the one the split leaves out", () => {
  assert.equal(severityLabel("critical"), "Critical");
  assert.equal(severityLabel("high"), "High");
  assert.equal(severityLabel("medium"), "Medium");
  assert.equal(severityLabel("good"), "Good");
});

test("the severity split still counts problems only, and agrees on wording", () => {
  // Widening the label map must not widen what the split reports.
  const counted = severityCounts([
    { severity: "critical" } as Finding,
    { severity: "good" } as Finding,
  ]);

  assert.deepEqual(
    counted.map((entry) => entry.severity),
    ["critical"],
  );
  assert.equal(counted[0].label, severityLabel("critical"));
});

test("a metric rating is worded as advice, not as the overall verdict", () => {
  /*
   * DELIBERATELY DIFFERENT WORDS FROM `fieldOverallText`. The overall verdict
   * quotes Google -- Fast, Average, Slow. A single metric tells the reader what
   * to do about it. Merging the two maps would silently reword half the speed
   * section, so this pins both at once.
   */
  assert.equal(ratingLabel("FAST"), "Good");
  assert.equal(ratingLabel("AVERAGE"), "Needs work");
  assert.equal(ratingLabel("SLOW"), "Poor");

  const overall = (rating: "FAST" | "AVERAGE" | "SLOW") =>
    fieldOverallText({ status: "found", overall: rating } as unknown as FieldPerformance);

  assert.equal(overall("FAST"), "Fast");
  assert.equal(overall("AVERAGE"), "Average");
  assert.equal(overall("SLOW"), "Slow");
  assert.notEqual(ratingLabel("FAST"), overall("FAST"));
});

test("an absent measurement has no duration, not a duration of zero", () => {
  assert.equal(metricDurationText(null), null);
  assert.equal(metricDurationText(undefined), null);
});

test("durations switch to seconds at one thousand milliseconds", () => {
  assert.equal(metricDurationText(999), "999 ms");
  assert.equal(metricDurationText(1000), "1.00 s");
  assert.equal(metricDurationText(1240), "1.24 s");
  assert.equal(metricDurationText(2500), "2.50 s");
});

test("milliseconds are whole numbers, and zero is a real measurement", () => {
  assert.equal(metricDurationText(0), "0 ms");
  assert.equal(metricDurationText(640.4), "640 ms");
  assert.equal(metricDurationText(640.6), "641 ms");
});

test("a speed figure is not rounded the way a crawl limit is", () => {
  // The crawl's own limits round to whole seconds. A page measurement of 1.24
  // seconds is not 1 second, and 640 ms is not 1 second either.
  assert.equal(metricDurationText(1240), "1.24 s");
  assert.equal(metricDurationText(640), "640 ms");
});

// ---------------------------------------------------------------------------
// LAYOUT SHIFT, IN TWO PLACES AND TWO PRECISIONS
//
// The last two formatting rules to leave the results panel. They describe the
// same quantity and deliberately do not print it the same way, so what these
// pin is that the move preserved both, and that nobody later folds them into
// one function.
// ---------------------------------------------------------------------------

test("a real-visitor shift score shows two decimals", () => {
  assert.equal(fieldShiftText({ percentile: 0.12, category: "AVERAGE" }), "0.12");
  assert.equal(fieldShiftText({ percentile: 0.1, category: "FAST" }), "0.10");
  assert.equal(fieldShiftText({ percentile: 0, category: "FAST" }), "0.00");
  assert.equal(fieldShiftText({ percentile: 1, category: "SLOW" }), "1.00");
});

test("a real-visitor shift score rounds at the second decimal", () => {
  // The thresholds a reader is judged against sit at 0.1 and 0.25, so the
  // second place is what tells them which side of one they are on.
  assert.equal(fieldShiftText({ percentile: 0.254, category: "AVERAGE" }), "0.25");
  assert.equal(fieldShiftText({ percentile: 0.255, category: "SLOW" }), "0.26");
  assert.equal(fieldShiftText({ percentile: 0.099, category: "FAST" }), "0.10");
});

test("an unreported shift score has no value, not a value of zero", () => {
  assert.equal(fieldShiftText(null), null);
  assert.equal(fieldShiftText(undefined), null);
});

test("a simulated shift score shows three decimals", () => {
  assert.equal(labShiftText(0.045), "0.045");
  assert.equal(labShiftText(0), "0.000");
  assert.equal(labShiftText(0.1), "0.100");
});

test("a simulated shift score rounds at the third decimal", () => {
  /*
   * ROUNDED ON THE BINARY VALUE, not the decimal one, because that is what
   * `toFixed` does: 0.0455 is stored slightly below its decimal form and comes
   * out 0.045. Pinned as it behaves rather than as it reads, because this is
   * the behaviour the results page has always had and the move preserved it.
   */
  assert.equal(labShiftText(0.0454), "0.045");
  assert.equal(labShiftText(0.0455), "0.045");
  assert.equal(labShiftText(0.0456), "0.046");
});

test("an unreported simulated score has no value either", () => {
  assert.equal(labShiftText(null), null);
  assert.equal(labShiftText(undefined), null);
});

test("the two shift formatters are not the same function", () => {
  /*
   * THE POINT OF KEEPING THEM APART. A lab run lands in the thousandths, and
   * two clearly different runs would round to the same number at two places.
   * If someone merges these, this fails.
   */
  assert.equal(labShiftText(0.045), "0.045");
  assert.equal(fieldShiftText({ percentile: 0.045, category: "FAST" }), "0.04");
  assert.notEqual(labShiftText(0.045), fieldShiftText({ percentile: 0.045, category: "FAST" }));
});

test("neither shift formatter borrows the duration formatter's units", () => {
  // A score is not a duration, and must never come out carrying "ms" or "s".
  assert.ok(!(fieldShiftText({ percentile: 0.12, category: "AVERAGE" }) ?? "").includes("s"));
  assert.ok(!(labShiftText(0.045) ?? "").includes("m"));
});

// ---------------------------------------------------------------------------
// THE SECURITY SECTION, AS ROWS
//
// Eleven rows that the results page used to build inline and the PDF needed
// too. What these pin is the wording, and one distinction that is easy to get
// wrong: three of the four simple headers show what the server actually sent,
// not merely that it sent something.
// ---------------------------------------------------------------------------

const header = (value: string | null) => ({ present: value !== null, value });

const fullSecurity = (over: Record<string, unknown> = {}): SecurityData =>
  ({
    servedOverHttps: true,
    strictTransportSecurity: header(null),
    contentSecurityPolicy: header(null),
    contentSecurityPolicyReportOnly: header(null),
    xFrameOptions: header(null),
    xContentTypeOptions: header(null),
    referrerPolicy: header(null),
    permissionsPolicy: header(null),
    hsts: {
      applicable: true, valid: false, maxAgeSeconds: null,
      disabledByZeroMaxAge: false, includesSubdomains: false, preload: false,
    },
    mixedContent: { applicable: true, total: 0, activeCount: 0, truncated: false, notInspected: ["Pages other than this one"], items: [] },
    cookies: { total: 0, cookies: [], notInspected: [] },
    insecureFormActions: [],
    serverHeader: header(null),
    poweredByHeader: header(null),
    ...over,
  }) as unknown as SecurityData;

const rowValue = (security: SecurityData, label: string) =>
  securityFacts(security).find((row) => row.label === label)?.value;

const rowNote = (security: SecurityData, label: string) =>
  securityFacts(security).find((row) => row.label === label)?.note;

test("the security section carries its eleven rows, in order", () => {
  assert.deepEqual(
    securityFacts(fullSecurity()).map((row) => row.label),
    [
      "HTTPS protection (HSTS)",
      "Content-Security-Policy",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cookies set by this page",
      "Insecure resources",
      "Not checked by this scan",
      "Insecure form submission",
      "Server software announced",
    ],
  );
});

test("a header that was never sent reads Missing", () => {
  const none = fullSecurity();

  assert.equal(rowValue(none, "X-Frame-Options"), "Missing");
  assert.equal(rowValue(none, "X-Content-Type-Options"), "Missing");
  assert.equal(rowValue(none, "Referrer-Policy"), "Missing");
  assert.equal(rowValue(none, "Permissions-Policy"), "Missing");
});

test("three of the simple headers show what the server actually sent", () => {
  /*
   * NOT "Present". `X-Frame-Options: SAMEORIGIN` and `X-Frame-Options: DENY`
   * are different protections, and a reader checking our reading needs the
   * value rather than a word that covers both.
   */
  const sent = fullSecurity({
    xFrameOptions: header("SAMEORIGIN"),
    xContentTypeOptions: header("nosniff"),
    referrerPolicy: header("strict-origin-when-cross-origin"),
  });

  assert.equal(rowValue(sent, "X-Frame-Options"), "SAMEORIGIN");
  assert.equal(rowValue(sent, "X-Content-Type-Options"), "nosniff");
  assert.equal(rowValue(sent, "Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("Permissions-Policy is the exception and says Present, with its value beside it", () => {
  // Its value is routinely long enough to fill the row, so it goes in the note.
  const sent = fullSecurity({ permissionsPolicy: header("geolocation=(), camera=()") });

  assert.equal(rowValue(sent, "Permissions-Policy"), "Present");
  assert.equal(rowNote(sent, "Permissions-Policy"), "geolocation=(), camera=()");
});

test("the HSTS and policy rows carry the raw header as their note", () => {
  const sent = fullSecurity({
    strictTransportSecurity: header("max-age=15552000; includeSubDomains"),
    contentSecurityPolicy: header("default-src 'self'"),
  });

  assert.equal(rowNote(sent, "HTTPS protection (HSTS)"), "max-age=15552000; includeSubDomains");
  assert.equal(rowNote(sent, "Content-Security-Policy"), "default-src 'self'");
});

test("a report-only policy falls back to its own header for the note", () => {
  const reportOnly = fullSecurity({
    contentSecurityPolicyReportOnly: header("default-src 'self'; report-uri /csp"),
  });

  assert.equal(rowValue(reportOnly, "Content-Security-Policy"), "Report-only — monitored but not enforced");
  assert.equal(rowNote(reportOnly, "Content-Security-Policy"), "default-src 'self'; report-uri /csp");
});

test("the cookie note lists names and flags, and never a value", () => {
  const withCookies = fullSecurity({
    cookies: {
      total: 1,
      cookies: [{ name: "session", secure: false, httpOnly: true, sameSite: null, value: "SECRET" }],
      notInspected: [],
    },
  });

  const note = rowNote(withCookies, "Cookies set by this page") ?? "";
  assert.match(note, /session: no Secure, HttpOnly, SameSite=not set/);
  assert.ok(!note.includes("SECRET"));
});

test("the insecure-resource note is capped, and absent when there is nothing to list", () => {
  const clean = fullSecurity();
  assert.equal(rowNote(clean, "Insecure resources"), undefined);

  const many = fullSecurity({
    mixedContent: {
      applicable: true, total: 9, activeCount: 2, truncated: false, notInspected: [],
      items: Array.from({ length: 9 }, (_v, i) => ({
        element: "img", via: "src", url: `http://example.com/${i}.png`,
      })),
    },
  });
  const note = rowNote(many, "Insecure resources") ?? "";
  assert.equal(note.split("  ·  ").length, 5, "five listed, not nine");
});

test("the not-checked row appears only where mixed content could be checked", () => {
  const overHttp = fullSecurity({
    mixedContent: { applicable: false, total: 0, activeCount: 0, truncated: false, notInspected: [], items: [] },
  });

  assert.ok(!securityFacts(overHttp).some((row) => row.label === "Not checked by this scan"));
  assert.ok(securityFacts(fullSecurity()).some((row) => row.label === "Not checked by this scan"));
});

test("insecure forms are counted and pluralised, or said to be absent", () => {
  assert.equal(rowValue(fullSecurity(), "Insecure form submission"), "None found");
  assert.equal(
    rowValue(fullSecurity({ insecureFormActions: ["http://example.com/a"] }), "Insecure form submission"),
    "1 form sends data over plain HTTP",
  );
  assert.equal(
    rowValue(
      fullSecurity({ insecureFormActions: ["http://example.com/a", "http://example.com/b"] }),
      "Insecure form submission",
    ),
    "2 forms sends data over plain HTTP",
  );
});

test("a server that announced nothing says so rather than showing an empty row", () => {
  assert.equal(rowValue(fullSecurity(), "Server software announced"), "— not announced —");
  assert.equal(
    rowValue(fullSecurity({ serverHeader: header("cloudflare") }), "Server software announced"),
    "cloudflare",
  );
  assert.equal(
    rowValue(
      fullSecurity({ serverHeader: header("nginx"), poweredByHeader: header("PHP/8.2") }),
      "Server software announced",
    ),
    "nginx · PHP/8.2",
  );
});

// ---------------------------------------------------------------------------
// A METRIC NOBODY REPORTED
// ---------------------------------------------------------------------------

test("an unreported metric says so rather than showing a dash", () => {
  /*
   * A dash lets a reader assume either an unreported metric or a good one.
   * The wording says which, without implying the site failed anything.
   */
  assert.equal(METRIC_NOT_REPORTED, "Not reported");
  assert.ok(!METRIC_NOT_REPORTED.includes("0"));
  assert.ok(!/slow|fail|poor|error/i.test(METRIC_NOT_REPORTED));
});

// ---------------------------------------------------------------------------
// THE CERTIFICATE PROBLEM SEEN WHILE CONNECTING
// ---------------------------------------------------------------------------

test("no certificate problem produces no row at all", () => {
  assert.deepEqual(certificateProblemFacts(null), []);
});

test("a certificate problem is one labelled row, with its own caveat", () => {
  const [row] = certificateProblemFacts("expired");

  assert.equal(row.label, "Certificate problem");
  assert.equal(row.value, "The certificate has expired");
  assert.equal(
    row.note,
    "Seen while connecting. The certificate itself is read separately, below.",
  );
});

test("every certificate problem produces the label and its own sentence", () => {
  for (const problem of ["expired", "self-signed", "wrong-hostname", "untrusted"] as const) {
    const [row] = certificateProblemFacts(problem);
    assert.equal(row.label, "Certificate problem");
    assert.equal(row.value, certificateProblemLabel(problem));
  }
});

test("the note exists because two certificate verdicts appear in one report", () => {
  // Without it a reader meets a verdict here and another further down, and
  // cannot tell why they differ.
  const [row] = certificateProblemFacts("untrusted");
  assert.match(row.note ?? "", /read separately/);
});

// ---------------------------------------------------------------------------
// WHICH SECURITY NOTES ARE A SERVER'S OWN WORDS
// ---------------------------------------------------------------------------

test("the rows quoting a response header verbatim say so", () => {
  const sent = fullSecurity({
    strictTransportSecurity: header("max-age=15552000"),
    contentSecurityPolicy: header("default-src 'self'"),
    permissionsPolicy: header("geolocation=()"),
  });

  const marked = securityFacts(sent)
    .filter((row) => row.rawHeaderNote === true)
    .map((row) => row.label);

  assert.deepEqual(marked, [
    "HTTPS protection (HSTS)",
    "Content-Security-Policy",
    "Permissions-Policy",
  ]);
});

test("the notes that are not header text are left unmarked", () => {
  // Cookie names and flags, and addresses the crawl measured. None of these is
  // a header, and an export may carry them.
  const withDetail = fullSecurity({
    cookies: {
      total: 1,
      cookies: [{ name: "session", secure: true, httpOnly: true, sameSite: "Lax" }],
      notInspected: [],
    },
    mixedContent: {
      applicable: true, total: 1, activeCount: 0, truncated: false, notInspected: [],
      items: [{ element: "img", via: "src", url: "http://example.com/a.png" }],
    },
    insecureFormActions: ["http://example.com/submit"],
  });

  for (const label of ["Cookies set by this page", "Insecure resources", "Insecure form submission"]) {
    const row = securityFacts(withDetail).find((r) => r.label === label);
    assert.ok(row?.note, `${label} should carry a note`);
    assert.equal(row?.rawHeaderNote, undefined, `${label} is not header text`);
  }
});

test("the browser still receives every note, marked or not", () => {
  // Marking changes nothing about what the shared builder returns. The results
  // page shows the header so a reader can check our reading of it.
  const sent = fullSecurity({ strictTransportSecurity: header("max-age=15552000") });
  const row = securityFacts(sent).find((r) => r.label === "HTTPS protection (HSTS)");

  assert.equal(row?.note, "max-age=15552000");
  assert.equal(row?.rawHeaderNote, true);
});

// ---------------------------------------------------------------------------
// The announced-software row: on screen and in a document
//
// The measurement is one measurement. What differs is who is reading it: a
// person auditing the site needs to see what is being given away, and a
// document that leaves the building and gets forwarded does not.
// ---------------------------------------------------------------------------

/** The whole row, not just its value, since the document reads a second field. */
const securityRow = (security: SecurityData, label: string) =>
  securityFacts(security).find((row) => row.label === label);

test("a document is told to withhold the announced software, and told what to say", () => {
  const row = securityRow(
    fullSecurity({ serverHeader: header("internal-nginx-build-4417") }),
    "Server software announced",
  );

  assert.ok(row);
  assert.equal(row.value, "internal-nginx-build-4417", "the screen still shows what was measured");
  assert.match(row.documentValue ?? "", /Announced/, "and the document says the fact");
  assert.ok(
    !(row.documentValue ?? "").includes("internal-nginx-build-4417"),
    "without the string itself",
  );
});

test("both headers are withheld together, not one of the two", () => {
  /*
   * The screen joins them, so a document taking the first half of a joined
   * value would leak the other. There is one replacement for the row.
   */
  const row = securityRow(
    fullSecurity({
      serverHeader: header("internal-nginx-build-4417"),
      poweredByHeader: header("SecretFramework/9.9"),
    }),
    "Server software announced",
  );

  assert.ok(row);
  assert.equal(row.value, "internal-nginx-build-4417 · SecretFramework/9.9");
  for (const value of ["internal-nginx-build-4417", "SecretFramework/9.9"]) {
    assert.ok(!(row.documentValue ?? "").includes(value), `${value} is withheld`);
  }
});

test("the X-Powered-By header alone is enough to withhold the row", () => {
  const row = securityRow(
    fullSecurity({ poweredByHeader: header("SecretFramework/9.9") }),
    "Server software announced",
  );

  assert.ok(row);
  assert.equal(row.value, "SecretFramework/9.9", "still measured and still on screen");
  assert.ok(row.documentValue !== undefined, "and still withheld from a document");
});

test("a server that announced nothing has nothing to withhold", () => {
  /*
   * A reader of a clean site's report must not be told a value is being kept
   * back when there is none, so the row reads the same in both places.
   */
  const row = securityRow(fullSecurity(), "Server software announced");

  assert.ok(row);
  assert.equal(row.value, "— not announced —");
  assert.equal(row.documentValue, undefined);
});

test("no other security row asks a document to print something different", () => {
  /*
   * ONE ROW, NOT A NEW HABIT. The policy headers stay as they are: their values
   * are directives a reader checks our verdict against, not a fingerprint of
   * somebody's build, and narrowing them is a separate decision nobody made.
   */
  const narrowed = securityFacts(
    fullSecurity({
      serverHeader: header("internal-nginx-build-4417"),
      xFrameOptions: header("SAMEORIGIN"),
      referrerPolicy: header("strict-origin-when-cross-origin"),
    }),
  ).filter((row) => row.documentValue !== undefined);

  assert.deepEqual(
    narrowed.map((row) => row.label),
    ["Server software announced"],
  );
});
