/**
 * Tests for robots.txt parsing.
 *
 * Getting this wrong matters in both directions: saying a site blocks all
 * search engines when it doesn't would put a false critical claim in a
 * client-facing report, and missing a real block would hide a costly problem.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksEveryCrawler, findSitemapDirective } from "./technicalChecks.ts";

test("detects a site blocking all crawlers", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /"), true);
});

test("an empty Disallow means nothing is blocked", () => {
  // "Disallow:" with no value is the standard way to say "allow everything".
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow:"), false);
});

test("blocking one folder is not blocking the site", () => {
  assert.equal(blocksEveryCrawler("User-agent: *\nDisallow: /admin/"), false);
});

test("a block aimed at one named crawler does not count", () => {
  // Blocking a single bot is normal and deliberate; it does not mean the site
  // is hidden from search engines.
  assert.equal(blocksEveryCrawler("User-agent: BadBot\nDisallow: /"), false);
});

test("consecutive User-agent lines share the rules that follow", () => {
  // This blocks everyone, including *. Treating each User-agent line as a
  // fresh group would miss it entirely.
  const robots = "User-agent: *\nUser-agent: Googlebot\nDisallow: /";
  assert.equal(blocksEveryCrawler(robots), true);
});

test("an Allow rule means the site is not entirely blocked", () => {
  const robots = "User-agent: *\nDisallow: /\nAllow: /public/";
  assert.equal(blocksEveryCrawler(robots), false);
});

test("rules for a named bot do not leak into the wildcard group", () => {
  const robots = "User-agent: *\nDisallow: /admin/\n\nUser-agent: BadBot\nDisallow: /";
  assert.equal(blocksEveryCrawler(robots), false);
});

test("ignores comments and odd spacing", () => {
  const robots = "# our robots file\n  User-agent :  *  \n  Disallow :  /   # everything\n";
  assert.equal(blocksEveryCrawler(robots), true);
});

test("handles an empty file", () => {
  assert.equal(blocksEveryCrawler(""), false);
});

test("finds a Sitemap directive", () => {
  const robots = "User-agent: *\nDisallow:\n\nSitemap: https://example.com/sitemap.xml";
  assert.equal(findSitemapDirective(robots), "https://example.com/sitemap.xml");
});

test("finds a Sitemap directive regardless of case", () => {
  assert.equal(
    findSitemapDirective("SITEMAP: https://example.com/s.xml"),
    "https://example.com/s.xml",
  );
});

test("returns null when there is no Sitemap line", () => {
  assert.equal(findSitemapDirective("User-agent: *\nDisallow:"), null);
});
