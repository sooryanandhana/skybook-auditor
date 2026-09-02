/**
 * Tests for the address safety check.
 *
 * This is the most security-sensitive code in the project: it decides whether
 * our server is allowed to fetch an address. A mistake here means the tool can
 * be pointed at a private network.
 *
 * These tests use no network — they check the address classification directly,
 * so they are fast and always give the same answer.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress } from "./safety.ts";

test("allows ordinary public IPv4 addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "151.101.1.140"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("blocks loopback", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("blocks the three private IPv4 ranges", () => {
  const blocked = [
    "10.0.0.1", "10.255.255.255", // 10.0.0.0/8
    "172.16.0.1", "172.31.255.255", // 172.16.0.0/12
    "192.168.0.1", "192.168.1.1", // 192.168.0.0/16
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("does not over-block addresses that merely look private", () => {
  // 172.15.x and 172.32.x sit just OUTSIDE the private 172.16-31 range, and
  // 11.x is not 10.x. Blocking these would wrongly refuse real websites.
  for (const ip of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "9.255.255.255"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("blocks the cloud metadata address", () => {
  // 169.254.169.254 is where cloud servers keep their own credentials.
  // Reaching it via someone else's server is a well-known attack.
  assert.equal(isPublicAddress("169.254.169.254"), false);
  assert.equal(isPublicAddress("169.254.0.1"), false);
});

test("blocks other reserved IPv4 ranges", () => {
  const blocked = [
    "0.0.0.0", // "this network"
    "100.64.0.1", // carrier-grade NAT
    "192.0.0.1", // protocol assignments
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("blocks IPv6 loopback and private ranges", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test("allows ordinary public IPv6 addresses", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("sees through IPv4 addresses disguised as IPv6", () => {
  // "::ffff:127.0.0.1" is loopback wearing an IPv6 costume. Checking only the
  // IPv6 rules would let it straight through.
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:192.168.1.1"), false);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
});

test("treats anything unparseable as unsafe", () => {
  // When in doubt, refuse. A malformed address should never be assumed public.
  for (const ip of ["", "not-an-ip", "999.999.999.999", "1.2.3"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});
