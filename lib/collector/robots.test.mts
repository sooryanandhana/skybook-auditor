/**
 * Tests for robots.txt parsing and enforcement.
 *
 * Two things are being defended here, and they pull in opposite directions.
 *
 * The site's wishes must actually be obeyed — a Disallow that quietly fails to
 * exclude anything is worse than not implementing robots at all, because it
 * looks like compliance.
 *
 * And robots must never be able to WIDEN what the crawler does. Every rule here
 * is applied to an address that has already passed normalisation and the
 * same-site rule, and everything that survives is still fetched through the
 * boundary that checks hostnames. An `Allow:` line is not a key to anything.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import { createDeadline } from "./deadline.ts";
import {
  CRAWLER_USER_AGENT_TOKEN,
  fetchRobots,
  isPathAllowed,
  parseGroups,
  parseRobots,
  patternMatches,
  ROBOTS_BUDGET_MS,
  selectRules,
} from "./robots.ts";
import type { SitemapFetcher } from "./sitemap.ts";

const SITE = new URL("https://example.com/");

/** Whether our crawler may fetch a path, given this robots.txt. */
const allows = (robotsTxt: string, path: string, agent = CRAWLER_USER_AGENT_TOKEN) =>
  parseRobots(robotsTxt, agent).isAllowed(new URL(path, SITE));

function sourceOf(file: string): string {
  return fs.readFileSync(new URL(file, import.meta.url), "utf8");
}

function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Our identity
// ---------------------------------------------------------------------------

test("the crawler answers to the name it actually sends", () => {
  // A crawler whose robots token does not match its User-Agent header cannot
  // be excluded by name, however carefully a site tries.
  assert.equal(CRAWLER_USER_AGENT_TOKEN, "SkybookAuditBot");
  assert.ok(codeOf("./fetchPage.ts").includes(`"${CRAWLER_USER_AGENT_TOKEN}/1.0`));
  assert.ok(codeOf("./sitemap.ts").includes(`"${CRAWLER_USER_AGENT_TOKEN}/1.0`));
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

test("a rule applies when its group names us", () => {
  const robots = `User-agent: SkybookAuditBot
Disallow: /private`;

  assert.equal(allows(robots, "/private"), false);
  assert.equal(allows(robots, "/public"), true);
});

test("user-agent matching ignores case", () => {
  const robots = `User-agent: SKYBOOKAUDITBOT
Disallow: /private`;

  assert.equal(allows(robots, "/private"), false);
});

test("the wildcard group applies when nothing names us", () => {
  const robots = `User-agent: *
Disallow: /private`;

  assert.equal(allows(robots, "/private"), false);
});

test("a group naming only other crawlers does not apply to us", () => {
  const robots = `User-agent: Googlebot
Disallow: /private

User-agent: AhrefsBot
Disallow: /`;

  // Nothing here is addressed to us and there is no wildcard group.
  assert.equal(allows(robots, "/private"), true);
  assert.equal(allows(robots, "/anything"), true);
});

test("our own group beats the wildcard group, and they are not merged", () => {
  const robots = `User-agent: *
Disallow: /

User-agent: SkybookAuditBot
Disallow: /admin`;

  // The standard is explicit that exactly one group applies. Merging them
  // would leave the whole site disallowed.
  assert.equal(allows(robots, "/anything"), true);
  assert.equal(allows(robots, "/admin"), false);
});

test("the wildcard applies even when our group comes first in the file", () => {
  const robots = `User-agent: SkybookAuditBot
Disallow: /ours

User-agent: *
Disallow: /`;

  assert.equal(allows(robots, "/ours"), false);
  assert.equal(allows(robots, "/anything"), true, "our group applies, not the wildcard");
});

test("consecutive user-agent lines share one group's rules", () => {
  // The trap: treating each line as a new group leaves the first agent with
  // no rules at all.
  const robots = `User-agent: SkybookAuditBot
User-agent: Googlebot
Disallow: /shared`;

  const groups = parseGroups(robots);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].agents, ["skybookauditbot", "googlebot"]);
  assert.equal(allows(robots, "/shared"), false);
});

test("a user-agent line after a rule starts a new group", () => {
  const robots = `User-agent: Googlebot
Disallow: /google-only
User-agent: SkybookAuditBot
Disallow: /ours`;

  const groups = parseGroups(robots);
  assert.equal(groups.length, 2);
  assert.equal(allows(robots, "/google-only"), true);
  assert.equal(allows(robots, "/ours"), false);
});

test("the longest matching agent token wins", () => {
  const groups = parseGroups(`User-agent: sky
Disallow: /short

User-agent: skybookauditbot
Disallow: /long`);

  const rules = selectRules(groups, "SkybookAuditBot");
  assert.deepEqual(rules.map((r) => r.pattern), ["/long"]);
});

test("comments and blank lines are ignored wherever they appear", () => {
  const robots = `# top comment

User-agent: *   # trailing comment
Disallow: /private   # another

# a whole line`;

  assert.equal(allows(robots, "/private"), false);
  assert.equal(allows(robots, "/public"), true);
});

test("directives that are not permissions do not break the groups", () => {
  const robots = `User-agent: *
Crawl-delay: 10
Sitemap: https://example.com/sitemap.xml
Host: example.com
Disallow: /private`;

  assert.equal(allows(robots, "/private"), false);
  assert.equal(allows(robots, "/public"), true);
});

test("rules written before any user-agent line are ignored", () => {
  const robots = `Disallow: /orphan
User-agent: *
Disallow: /private`;

  assert.equal(allows(robots, "/orphan"), true, "the standard gives it no meaning");
  assert.equal(allows(robots, "/private"), false);
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("a disallowed prefix covers everything beneath it", () => {
  const robots = `User-agent: *
Disallow: /admin`;

  assert.equal(allows(robots, "/admin"), false);
  assert.equal(allows(robots, "/admin/"), false);
  assert.equal(allows(robots, "/admin/users/42"), false);
  assert.equal(allows(robots, "/administrator"), false, "prefix matching, as specified");
  assert.equal(allows(robots, "/public/admin"), true, "it is a prefix, not a substring");
});

test("Disallow: / blocks the whole site", () => {
  const robots = `User-agent: *
Disallow: /`;

  assert.equal(allows(robots, "/"), false);
  assert.equal(allows(robots, "/anything/at/all"), false);
});

test("an empty Disallow means nothing is disallowed", () => {
  // The conventional way to say "crawl everything", and the exact opposite of
  // `Disallow: /`. Reading the empty value as a path would lock us out.
  const robots = `User-agent: *
Disallow:`;

  assert.equal(allows(robots, "/"), true);
  assert.equal(allows(robots, "/anything"), true);
});

test("an empty-valued rule is dropped at parse time, not left as a pattern", () => {
  // Two independent things stop an empty `Disallow:` from matching the whole
  // site: it is discarded here, and an empty pattern matches nothing anyway.
  // This pins the first of them — the failure it prevents is locking the
  // crawler out of an entire website, so one guard is not enough.
  const groups = parseGroups(`User-agent: *
Disallow:
Allow:
Disallow: /real`);

  assert.deepEqual(groups[0].rules, [{ allow: false, pattern: "/real" }]);
});

test("an empty Disallow alongside a real one leaves the real one working", () => {
  const robots = `User-agent: *
Disallow:
Disallow: /private`;

  assert.equal(allows(robots, "/private"), false);
  assert.equal(allows(robots, "/public"), true);
});

test("multiple rules all apply", () => {
  const robots = `User-agent: *
Disallow: /admin
Disallow: /tmp
Disallow: /cgi-bin`;

  assert.equal(allows(robots, "/admin/x"), false);
  assert.equal(allows(robots, "/tmp/x"), false);
  assert.equal(allows(robots, "/cgi-bin/x"), false);
  assert.equal(allows(robots, "/shop"), true);
});

test("a query string is part of what gets matched", () => {
  const robots = `User-agent: *
Disallow: /search?
Disallow: /*?sessionid=`;

  assert.equal(allows(robots, "/search?q=hats"), false);
  assert.equal(allows(robots, "/search"), true, "no query, so the pattern does not match");
  assert.equal(allows(robots, "/products?sessionid=abc"), false);
  assert.equal(allows(robots, "/products?colour=red"), true);
});

// ---------------------------------------------------------------------------
// Allow and precedence
// ---------------------------------------------------------------------------

test("Allow carves an exception out of a broader Disallow", () => {
  const robots = `User-agent: *
Disallow: /shop
Allow: /shop/public`;

  assert.equal(allows(robots, "/shop/private"), false);
  assert.equal(allows(robots, "/shop/public"), true);
  assert.equal(allows(robots, "/shop/public/item"), true);
});

test("precedence is by pattern length, not by line order", () => {
  // Written the other way round, the answer must not change. Taking the first
  // or the last match instead would flip one of these.
  const disallowFirst = `User-agent: *
Disallow: /shop
Allow: /shop/public`;

  const allowFirst = `User-agent: *
Allow: /shop/public
Disallow: /shop`;

  for (const robots of [disallowFirst, allowFirst]) {
    assert.equal(allows(robots, "/shop/public"), true);
    assert.equal(allows(robots, "/shop/private"), false);
  }
});

test("on an exact tie, Allow wins", () => {
  const robots = `User-agent: *
Disallow: /page
Allow: /page`;

  assert.equal(allows(robots, "/page"), true);
});

test("a longer Disallow beats a shorter Allow", () => {
  const robots = `User-agent: *
Allow: /docs
Disallow: /docs/internal`;

  assert.equal(allows(robots, "/docs/public"), true);
  assert.equal(allows(robots, "/docs/internal"), false);
});

test("an address no rule mentions is allowed", () => {
  const robots = `User-agent: *
Disallow: /admin`;

  assert.equal(allows(robots, "/completely/unrelated"), true);
});

// ---------------------------------------------------------------------------
// Wildcards
// ---------------------------------------------------------------------------

test("* matches any run of characters", () => {
  assert.equal(patternMatches("/a*b", "/axxxb"), true);
  assert.equal(patternMatches("/a*b", "/ab"), true);
  assert.equal(patternMatches("/a*b", "/axxx"), false);
  assert.equal(patternMatches("/*.pdf", "/files/report.pdf"), true);
});

test("$ anchors the end of the path", () => {
  assert.equal(patternMatches("/page$", "/page"), true);
  assert.equal(patternMatches("/page$", "/page/more"), false);
  assert.equal(patternMatches("/*.pdf$", "/a/b.pdf"), true);
  assert.equal(patternMatches("/*.pdf$", "/a/b.pdf.html"), false);
});

test("a trailing * matches whatever remains", () => {
  assert.equal(patternMatches("/admin*", "/admin"), true);
  assert.equal(patternMatches("/admin*", "/admin/users"), true);
});

test("wildcards work through the whole policy", () => {
  const robots = `User-agent: *
Disallow: /*.pdf$
Disallow: /*/private/`;

  assert.equal(allows(robots, "/reports/2024.pdf"), false);
  assert.equal(allows(robots, "/reports/2024.pdf.html"), true);
  assert.equal(allows(robots, "/team/private/notes"), false);
  assert.equal(allows(robots, "/team/public/notes"), true);
});

test("an empty pattern matches nothing", () => {
  assert.equal(patternMatches("", "/anything"), false);
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

test("an encoded path is matched against an unencoded rule", () => {
  // The URL arrives percent-encoded; the site wrote the rule in plain text.
  // Comparing only one form would walk into a directory we were asked to avoid.
  const robots = `User-agent: *
Disallow: /private files`;

  assert.equal(allows(robots, "/private%20files/secret"), false);
});

test("an unencoded path is matched against an encoded rule", () => {
  const robots = `User-agent: *
Disallow: /private%20files`;

  assert.equal(allows(robots, "/private files/secret"), false);
});

test("a malformed percent sequence does not throw", () => {
  const robots = `User-agent: *
Disallow: /bad%zz`;

  assert.equal(allows(robots, "/bad%zz"), false);
  assert.equal(allows(robots, "/fine"), true);
});

test("matching is deterministic: the same inputs give the same answer", () => {
  const robots = `User-agent: *
Disallow: /shop
Allow: /shop/public
Disallow: /shop/public/hidden`;

  for (const path of ["/shop", "/shop/public", "/shop/public/hidden", "/other"]) {
    const answers = Array.from({ length: 5 }, () => allows(robots, path));
    assert.equal(new Set(answers).size, 1, path);
  }
});

test("rule order in the file does not change any answer", () => {
  const lines = ["Disallow: /shop", "Allow: /shop/public", "Disallow: /shop/public/hidden"];
  const forwards = `User-agent: *\n${lines.join("\n")}`;
  const backwards = `User-agent: *\n${[...lines].reverse().join("\n")}`;

  for (const path of ["/shop/x", "/shop/public/x", "/shop/public/hidden/x"]) {
    assert.equal(allows(forwards, path), allows(backwards, path), path);
  }
});

test("isPathAllowed is total: any rule set yields an answer", () => {
  assert.equal(isPathAllowed([], "/anything"), true);
});

// ---------------------------------------------------------------------------
// Fetching, and the four things that can happen
// ---------------------------------------------------------------------------

const answering = (result: Awaited<ReturnType<SitemapFetcher>>): SitemapFetcher => async () =>
  result;

test("a robots.txt with rules is read and enforced", async () => {
  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: true, body: "User-agent: *\nDisallow: /private" }),
  });

  assert.equal(policy.status, "rules");
  assert.equal(policy.enforced, true);
  assert.equal(policy.isAllowed(new URL("/private", SITE)), false);
});

test("an empty robots.txt allows everything, and enforcement did apply", async () => {
  for (const body of ["", "   \n\n  "]) {
    const policy = await fetchRobots({
      site: SITE,
      deadline: createDeadline(10_000),
      fetchImpl: answering({ ok: true, body }),
    });

    assert.equal(policy.status, "empty");
    assert.equal(policy.enforced, true, "we read the file; it has no rules");
    assert.equal(policy.isAllowed(new URL("/anything", SITE)), true);
  }
});

test("a robots.txt with only comments counts as having no rules", async () => {
  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: true, body: "# nothing to see" }),
  });

  assert.equal(policy.status, "empty");
  assert.equal(policy.enforced, true);
});

test("a 404 means there are no rules, and enforcement DID apply", async () => {
  // The server answered plainly. That is knowledge, not a failure.
  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: false, reason: "absent" }),
  });

  assert.equal(policy.status, "absent");
  assert.equal(policy.enforced, true);
  assert.equal(policy.isAllowed(new URL("/anything", SITE)), true);
});

test("an unreachable robots.txt allows the crawl but is NOT enforced", async () => {
  /*
   * The deliberate deviation from the strict standard, and the reason for it:
   * a search engine meeting a failed robots.txt should assume it is disallowed
   * everything. Here, a person asked for an audit of one named site, and
   * answering "we audited nothing because a file timed out" would fail them for
   * a reason unrelated to their website — and would look identical to a site
   * that genuinely blocks us. So the crawl proceeds and `enforced` says plainly
   * that the rules were never read.
   */
  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: false, reason: "unavailable" }),
  });

  assert.equal(policy.status, "unavailable");
  assert.equal(policy.enforced, false, "we must never claim to have honoured unread rules");
  assert.equal(policy.isAllowed(new URL("/anything", SITE)), true);
});

test("a failure with no stated reason is read as unavailable, not as absent", async () => {
  // "We do not know" is the honest reading of an unexplained failure, and it
  // is the one that refuses to claim enforcement.
  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: false }),
  });

  assert.equal(policy.status, "unavailable");
  assert.equal(policy.enforced, false);
});

test("an expired clock means no request and no claim of enforcement", async () => {
  const calls: string[] = [];
  const watching: SitemapFetcher = async (url) => {
    calls.push(url);
    return { ok: false };
  };

  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(0),
    fetchImpl: watching,
  });

  assert.deepEqual(calls, []);
  assert.equal(policy.status, "unavailable");
  assert.equal(policy.enforced, false);
});

test("the robots request is capped so it cannot spend the whole crawl", async () => {
  const budgets: number[] = [];
  const watching: SitemapFetcher = async (_url, deadline) => {
    budgets.push(deadline.remainingMs());
    return { ok: false };
  };

  await fetchRobots({
    site: SITE,
    deadline: createDeadline(300_000),
    fetchImpl: watching,
  });

  assert.ok(budgets[0] <= ROBOTS_BUDGET_MS, `got ${budgets[0]}ms`);
});

test("the surrounding clock still wins when it is the shorter one", async () => {
  const budgets: number[] = [];
  const watching: SitemapFetcher = async (_url, deadline) => {
    budgets.push(deadline.remainingMs());
    return { ok: false };
  };

  await fetchRobots({ site: SITE, deadline: createDeadline(2_000), fetchImpl: watching });

  assert.ok(budgets[0] <= 2_000);
});

test("robots.txt is fetched from the site's own origin", async () => {
  const calls: string[] = [];
  const watching: SitemapFetcher = async (url) => {
    calls.push(url);
    return { ok: false };
  };

  await fetchRobots({
    site: new URL("https://www.example.com/deep/page?x=1"),
    deadline: createDeadline(10_000),
    fetchImpl: watching,
  });

  assert.deepEqual(calls, ["https://www.example.com/robots.txt"]);
});

test("the policy carries the file's text so nothing fetches it twice", async () => {
  const body = "User-agent: *\nDisallow: /x\nSitemap: https://example.com/s.xml";

  const policy = await fetchRobots({
    site: SITE,
    deadline: createDeadline(10_000),
    fetchImpl: answering({ ok: true, body }),
  });

  assert.equal(policy.text, body);
});

// ---------------------------------------------------------------------------
// Security: robots can only ever subtract
// ---------------------------------------------------------------------------

test("robots enforcement contains no HTTP and no SSRF logic of its own", () => {
  const code = codeOf("./robots.ts");

  assert.ok(!/\bfetch\s*\(/.test(code.replace(/fetchImpl\s*\(/g, "")), "no raw fetch()");
  assert.ok(!/\bXMLHttpRequest\b/.test(code));
  assert.ok(!/from\s+["']node:https?["']/.test(code));
  assert.ok(!/isPublicAddress|checkHostnameIsPublic|isPrivateIPv/.test(code));
});

test("robots imports only existing modules", () => {
  const imports = [...sourceOf("./robots.ts").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (m) => m[1],
  );

  assert.deepEqual(imports.sort(), ["./deadline.ts", "./sitemap.ts"]);
});

test("robots decides nothing about hosts, schemes or sites", () => {
  // Its only question is "may we fetch this path". Everything about WHERE an
  // address points is settled before it is consulted, and again afterwards.
  const code = codeOf("./robots.ts");

  assert.ok(!/isSameSite|siteKey|normalizeCrawlUrl/.test(code));
});

test("an Allow rule cannot grant anything, only narrow a Disallow", () => {
  // A policy built entirely of Allow lines permits exactly what a policy with
  // no rules at all permits: everything it was already going to be asked about.
  const permissiveByRule = parseRobots(`User-agent: *
Allow: /
Allow: http://169.254.169.254/
Allow: https://evil.test/`);

  const noRules = parseRobots("User-agent: *\nDisallow:");

  for (const path of ["/a", "/b/c", "/"]) {
    assert.equal(
      permissiveByRule.isAllowed(new URL(path, SITE)),
      noRules.isAllowed(new URL(path, SITE)),
      path,
    );
  }
});

test("robots produces no findings, severities or recommendations", () => {
  const code = codeOf("./robots.ts");

  assert.ok(!/\b(severity|critical|finding|recommendation)\s*[:=]/i.test(code));
  assert.ok(!/Finding/.test(code));
});

test("a policy exposes only a status, a flag, the text and a question", () => {
  const policy = parseRobots("User-agent: *\nDisallow: /x");

  assert.deepEqual(Object.keys(policy).sort(), ["enforced", "isAllowed", "status", "text"]);
});
