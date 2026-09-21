/**
 * Corpus J — technical SEO cases where a wrong answer is expensive for a client.
 *
 * Beyond the minimum corpus: included because the review found a false Critical
 * here, and because the audit's silence on noindex is easy to mistake for a
 * clean result.
 *
 * Yardsticks: the robots.txt rule's own evidence sentence ("disallows all
 * crawlers from the entire site"), the Robots Exclusion Protocol's path
 * matching (RFC 9309: `$` anchors the end of the path), and the approved
 * severity table in lib/rules/technical.ts.
 */
import assert from "node:assert/strict";

import { blocksEveryCrawler } from "../collector/technicalChecks.ts";
import { SITE_RULES } from "../rules/all.ts";
import { runRules } from "../rules/runner.ts";
import {
  auditFixtureSite,
  correct,
  decision,
  findingsOf,
  page,
  PROTECTED_HEADERS,
  PUBLIC_HOST,
  installOfflineCorpus,
} from "./corpus.fixture.mts";

installOfflineCorpus();
const ROOT = `https://${PUBLIC_HOST}/`;

/** The robots.txt finding the real site rule produces when robots.txt was read with this text. */
async function robotsFinding(robotsTxt: string) {
  const base = await auditFixtureSite({ [ROOT]: { html: page(), headers: PROTECTED_HEADERS } });
  const technical = {
    robotsTxtStatus: "found" as const,
    robotsBlocksEverything: blocksEveryCrawler(robotsTxt),
    sitemapStatus: "absent" as const,
    sitemapUrl: null,
  };
  return runRules({ ...base.data, technical }, SITE_RULES).findings.find((finding) => finding.id === "technical.robots.blocks-all");
}

correct("J1 'User-agent: * / Disallow: /' blocks every crawler: Critical, with the measured sentence", async () => {
  const finding = await robotsFinding("User-agent: *\nDisallow: /\n");
  assert.equal(finding?.severity, "critical");
  assert.equal(finding?.evidence, "robots.txt disallows all crawlers from the entire site.");
});

correct("J2 an empty Disallow allows everything: no finding", async () => {
  assert.equal(await robotsFinding("User-agent: *\nDisallow:\n"), undefined);
});

correct("J3 'Disallow: /$' blocks only the home page's exact address, so it is not a whole-site block", async () => {
  // `$` anchors the end of the path, so /about and every other page stay
  // crawlable. Probing only the path "/" -- which the pattern does match --
  // raised a false Critical "the entire site". The check now probes a non-root
  // path too, so an end-anchored root rule is no longer read as a full block.
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /$\n"), false);
  assert.equal(await robotsFinding("User-agent: *\nDisallow: /$\n"), undefined);
});

decision("J4 a robots.txt that blocks only Googlebot produces no finding", async () => {
  // The rule requires every listed search engine to be blocked. A site
  // invisible to Google alone is not reported; whether it should be, and how
  // severely, is a decision.
  assert.equal(await robotsFinding("User-agent: Googlebot\nDisallow: /\n"), undefined);
});

decision("J5 a page marked noindex produces no finding, and nothing about noindex is measured", async () => {
  // A site-wide noindex removes pages from search as surely as J1, yet no
  // collector reads meta robots or X-Robots-Tag. Measuring and grading it would
  // be a new requirement.
  const result = await auditFixtureSite({
    [ROOT]: {
      html: page({ head: '<meta name="robots" content="noindex, nofollow">' }),
      headers: { ...PROTECTED_HEADERS, "x-robots-tag": "noindex" },
    },
  });
  assert.deepEqual(findingsOf(result).ids, []);
  assert.deepEqual(Object.keys(result.data.seo).filter((key) => /robot|index/i.test(key)), []);
});
