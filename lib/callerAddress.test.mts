/**
 * The shared caller reading: who a request is from, and when to believe it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CLIENT_ADDRESS_HEADER,
  MAX_CLIENT_ADDRESS_LENGTH,
  TRUST_PROXY_VARIABLE,
  UNATTRIBUTED,
  normaliseCaller,
  trustedCaller,
  trustsProxy,
} from "./callerAddress.ts";

const requestWith = (headers: Record<string, string>) =>
  new Request("https://skybook.example/api/audit", { method: "POST", headers });

/* ---------------------------------------------------------------------------
   trustsProxy
   --------------------------------------------------------------------------- */

test("an explicit boolean wins over the environment", () => {
  const previous = process.env[TRUST_PROXY_VARIABLE];
  try {
    process.env[TRUST_PROXY_VARIABLE] = "1";
    assert.equal(trustsProxy(false), false, "the argument overrides a true environment");
    delete process.env[TRUST_PROXY_VARIABLE];
    assert.equal(trustsProxy(true), true, "and a false environment");
  } finally {
    if (previous === undefined) delete process.env[TRUST_PROXY_VARIABLE];
    else process.env[TRUST_PROXY_VARIABLE] = previous;
  }
});

test("with no argument the environment decides, and its default is not to trust", () => {
  const previous = process.env[TRUST_PROXY_VARIABLE];
  try {
    for (const value of ["1", "true", "TRUE", " true "]) {
      process.env[TRUST_PROXY_VARIABLE] = value;
      assert.equal(trustsProxy(), true, JSON.stringify(value));
    }
    for (const value of ["0", "false", "no", "", "yes-please"]) {
      process.env[TRUST_PROXY_VARIABLE] = value;
      assert.equal(trustsProxy(), false, JSON.stringify(value));
    }
    delete process.env[TRUST_PROXY_VARIABLE];
    assert.equal(trustsProxy(), false, "absent means untrusted");
  } finally {
    if (previous === undefined) delete process.env[TRUST_PROXY_VARIABLE];
    else process.env[TRUST_PROXY_VARIABLE] = previous;
  }
});

/* ---------------------------------------------------------------------------
   normaliseCaller
   --------------------------------------------------------------------------- */

test("one machine written many ways normalises to one key", () => {
  for (const form of ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(normaliseCaller(form), "127.0.0.1", form);
  }
});

test("a public IPv4-mapped address unwraps, and an ordinary IPv6 is lower-cased", () => {
  assert.equal(normaliseCaller("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseCaller("2001:DB8::1"), "2001:db8::1");
});

test("anything that is not an address is refused, so it cannot mint a bucket", () => {
  for (const junk of ["not-an-ip", "127.000.000.001", "", "   ", "1.2.3.4.5", "example.com", "<script>"]) {
    assert.equal(normaliseCaller(junk), null, JSON.stringify(junk));
  }
});

/* ---------------------------------------------------------------------------
   trustedCaller
   --------------------------------------------------------------------------- */

test("untrusted, every request is the one shared bucket", () => {
  assert.equal(trustedCaller(requestWith({ "x-forwarded-for": "203.0.113.7" }), false), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({ "x-real-ip": "198.51.100.1" }), false), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({}), false), UNATTRIBUTED);
});

test("untrusted, CF-Connecting-IP is ignored like every other client-address header", () => {
  assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": "203.0.113.7" }), false), UNATTRIBUTED);
  assert.equal(
    trustedCaller(requestWith({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }), false),
    UNATTRIBUTED,
  );
});

test("the trusted header is CF-Connecting-IP", () => {
  assert.equal(CLIENT_ADDRESS_HEADER, "cf-connecting-ip");
  assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": "203.0.113.7" }), true), "203.0.113.7");
  assert.equal(trustedCaller(requestWith({ "CF-Connecting-IP": "2001:DB8::1" }), true), "2001:db8::1");
});

test("trusted, conflicting X-Forwarded-For and X-Real-IP are ignored", () => {
  // The Render path: Cloudflare appends to whatever X-Forwarded-For the client
  // sent, so its first entry is the client's choice. Only CF-Connecting-IP counts.
  const request = requestWith({
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "198.51.100.66, 203.0.113.7, 172.71.0.1, 10.0.0.1",
    "x-real-ip": "198.51.100.77",
  });
  assert.equal(trustedCaller(request, true), "203.0.113.7");
});

test("trusted, a missing CF-Connecting-IP is unattributed and never falls back to another header", () => {
  assert.equal(trustedCaller(requestWith({}), true), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({ "x-forwarded-for": "203.0.113.7" }), true), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({ "x-real-ip": "203.0.113.9" }), true), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.9" }), true), UNATTRIBUTED);
});

test("trusted, an empty or junk CF-Connecting-IP is unattributed rather than a fresh bucket", () => {
  for (const junk of ["", "   ", "not-an-ip", "127.000.000.001", "1.2.3.4.5", "example.com", "<script>", "203.0.113.7:443", "[2001:db8::1]"]) {
    assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": junk }), true), UNATTRIBUTED, JSON.stringify(junk));
  }
});

test("trusted, a CF-Connecting-IP holding more than one entry is unattributed", () => {
  for (const many of ["203.0.113.7, 198.51.100.1", "203.0.113.7,198.51.100.1", "203.0.113.7,", ",203.0.113.7"]) {
    assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": many }), true), UNATTRIBUTED, JSON.stringify(many));
  }

  // The same header sent twice reaches the app comma-joined, so it is refused too.
  const headers = new Headers();
  headers.append("cf-connecting-ip", "203.0.113.7");
  headers.append("cf-connecting-ip", "198.51.100.1");
  const twice = new Request("https://skybook.example/api/audit", { method: "POST", headers });
  assert.equal(trustedCaller(twice, true), UNATTRIBUTED);
});

test("trusted, a CF-Connecting-IP longer than any address is unattributed", () => {
  // The longest textual address there is: exactly the limit, and accepted.
  const longest = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255";
  assert.equal(longest.length, MAX_CLIENT_ADDRESS_LENGTH);
  assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": longest }), true), longest);

  // One past it, and far past it, are refused before any parsing.
  assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": `0${longest}` }), true), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": `203.0.113.7${"x".repeat(5000)}` }), true), UNATTRIBUTED);
});

test("trusted, IPv4-mapped spellings of one address in CF-Connecting-IP share one key", () => {
  for (const form of ["203.0.113.7", "::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107"]) {
    assert.equal(trustedCaller(requestWith({ "cf-connecting-ip": form }), true), "203.0.113.7", form);
  }
});

test("trusted, rotating X-Forwarded-For under a fixed CF-Connecting-IP is one caller", () => {
  const keys = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    keys.add(trustedCaller(requestWith({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `198.51.100.${i}` }), true));
  }
  assert.deepEqual([...keys], ["203.0.113.7"]);
});
