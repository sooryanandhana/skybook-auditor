/**
 * The real-audit fixture, tested as an instrument.
 *
 * Every suite built on `runRealAudit` asserts things about an offline audit.
 * Those assertions are only worth something if the fixture really is offline,
 * really does exercise the production code it claims to, and really can reach
 * the rules it claims to. Each of those is a claim, so each is tested here.
 */
import { strict as assert } from "node:assert";
import dns from "node:dns";
import { lookup } from "node:dns/promises";
import tls from "node:tls";
import test from "node:test";

import { runSiteAudit } from "../siteAudit.ts";
import {
  FIXTURE_ROBOTS_TXT,
  fetcherFor,
  runRealAudit,
  siteChecksFor,
  withNetworkUnplugged,
  type FakeSite,
} from "./realAudit.fixture.mts";

const SITE: FakeSite = {
  "https://example.com/": {
    html:
      '<!doctype html><html lang="en"><head><title>Example Company</title></head><body><h1>Welcome</h1>' +
      "<p>We sell widgets to businesses across the country and have done so since 1994.</p></body></html>",
  },
};

// ---------------------------------------------------------------------------
// The network is unplugged, and an attempt on it cannot pass unnoticed
// ---------------------------------------------------------------------------

test("a real audit completes with DNS, sockets and fetch all unplugged", async () => {
  // `withNetworkUnplugged` fails the call on any attempt, so completing is the proof.
  const audit = await runRealAudit({ site: SITE, checks: { spfMissing: true } });
  assert.equal(audit.crawl.evaluated, 1);
});

test("a request the code swallows still fails the call, naming the address", async () => {
  await assert.rejects(
    withNetworkUnplugged(async () => {
      const response = await fetch("https://example.com/robots.txt").catch(() => null);
      assert.equal(response, null, "the refusal reached the code as an ordinary failure");
      return "carried on";
    }),
    /reached for the network: a request to https:\/\/example\.com\/robots\.txt/,
  );
});

test("a DNS lookup the code swallows still fails the call, through the promise API production imports", async () => {
  await assert.rejects(
    withNetworkUnplugged(async () => {
      await lookup("example.com", { all: true }).catch(() => []);
    }),
    /reached for the network: a DNS lookup of example\.com/,
  );
});

test("a Resolver query and a TLS connection are refused and recorded too", async () => {
  await assert.rejects(
    withNetworkUnplugged(async () => {
      await new dns.promises.Resolver().resolveTxt("_dmarc.example.com").catch(() => []);
    }),
    /a DNS resolveTxt of _dmarc\.example\.com/,
  );
  await assert.rejects(
    withNetworkUnplugged(async () => {
      try {
        tls.connect({ host: "example.com", port: 443 });
      } catch {
        // swallowed, as a careless caller would
      }
    }),
    /a TLS connection/,
  );
});

test("the network is restored after an unplugged call, whether it succeeded or failed", async () => {
  const before = { fetch: globalThis.fetch, lookup: dns.promises.lookup, callbackLookup: dns.lookup, connect: tls.connect };

  await withNetworkUnplugged(async () => {
    assert.notEqual(globalThis.fetch, before.fetch, "unplugged while running");
  });
  await withNetworkUnplugged(async () => {
    await fetch("https://example.com/").catch(() => null);
  }).catch(() => {});

  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(dns.promises.lookup, before.lookup);
  assert.equal(dns.lookup, before.callbackLookup);
  assert.equal(tls.connect, before.connect);
});

test("overlapping unplugged calls keep the network unplugged until the last one ends", async () => {
  const original = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const long = withNetworkUnplugged(async () => {
    await held;
    assert.notEqual(globalThis.fetch, original, "still unplugged after the shorter call ended");
  });
  await withNetworkUnplugged(async () => {});
  assert.notEqual(globalThis.fetch, original, "the shorter call did not plug the network back in early");
  release();
  await long;

  assert.equal(globalThis.fetch, original);
});

test("the wiring this fixture used to have — no robots.txt seam — is caught, not passed", async () => {
  // The negative control. Without `sitemapFetchImpl` the production crawler
  // reads robots.txt itself: an address check that resolves example.com, then a
  // request. That is the leak the fixture had, and the audit still "succeeds"
  // because the refusal becomes "robots.txt unavailable". Unplugged, it fails.
  await assert.rejects(
    withNetworkUnplugged(() =>
      runSiteAudit({
        requestedUrl: "https://example.com/",
        crawl: { fetchImpl: fetcherFor(SITE), useSitemaps: false },
        siteChecksImpl: siteChecksFor({}),
      }),
    ),
    /reached for the network: a DNS lookup of example\.com/,
  );
});

test("an audit's own failure is still reported when nothing reached for the network", async () => {
  await assert.rejects(
    withNetworkUnplugged(async () => {
      throw new Error("the work itself failed");
    }),
    /the work itself failed/,
  );
});

// ---------------------------------------------------------------------------
// robots.txt is supplied, and read by the production code
// ---------------------------------------------------------------------------

test("robots.txt is read from the fixture, parsed and enforced by the production crawler", async () => {
  const audit = await runRealAudit({ site: SITE });

  assert.equal(FIXTURE_ROBOTS_TXT, "User-agent: *\nAllow: /\n");
  assert.equal(audit.crawl.robots.status, "rules", "the file was read and had rules to apply");
  assert.equal(audit.crawl.robots.enforced, true);
  assert.equal(audit.crawl.robots.excluded, 0, "and it permits every page");
});

test("the crawl's reading of robots.txt and the site-level measurement describe the same file", async () => {
  const audit = await runRealAudit({ site: SITE });

  assert.equal(audit.data.technical?.robotsTxtStatus, "found");
  assert.equal(audit.data.technical?.robotsBlocksEverything, false);
  assert.notEqual(audit.crawl.robots.status, "unavailable");
});

// ---------------------------------------------------------------------------
// The certificate is built the way production builds one
// ---------------------------------------------------------------------------

test("the expired certificate's facts come from describeCertificate, in the production shape", async () => {
  const checks = await siteChecksFor({ certificateExpired: true })();
  const certificate = checks.ssl.certificate;

  assert.ok(certificate, "a certificate was read");
  assert.equal(certificate.daysUntilExpiry, -253);
  assert.equal(certificate.coversHostname, true);
  assert.equal(certificate.hostnameMatch, "exact");
  assert.equal(certificate.validTo, "2026-01-01T00:00:00.000Z");
  assert.equal(certificate.issuer, "Example CA");
  assert.equal(checks.ssl.problem, "expired");
  assert.equal(checks.ssl.trusted, false);
});

test("an expired certificate from the fixture reaches the expired-certificate rule", async () => {
  const audit = await runRealAudit({ site: SITE, checks: { certificateExpired: true } });
  const expired = audit.site.findings.find((finding) => finding.id === "security.ssl.expired");

  assert.ok(expired, "the rule fired");
  assert.equal(expired.severity, "critical");
  assert.equal(expired.scope, "site");
  assert.equal(expired.evidence, "The certificate expired 253 day(s) ago, on 2026-01-01T00:00:00.000Z.");
});

test("an expired certificate reaches the finished audit as one certificate finding, not two", async () => {
  // The fixture's certificate is rejected as expired, and its own facts show
  // the expiry, so "not trusted" must not report the same renewal again.
  const audit = await runRealAudit({ site: SITE, checks: { certificateExpired: true } });
  const certificateFindings = audit.site.findings.filter((finding) => finding.id.startsWith("security.ssl."));

  assert.deepEqual(
    certificateFindings.map((finding) => finding.id),
    ["security.ssl.expired"],
  );
});

test("without an expired certificate the expired-certificate rule does not fire", async () => {
  const audit = await runRealAudit({ site: SITE });
  assert.equal(audit.site.findings.some((finding) => finding.id === "security.ssl.expired"), false);
});
