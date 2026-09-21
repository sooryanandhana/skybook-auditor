/**
 * The shared caller reading: who a request is from, and when to believe it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
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

test("trusted, the first forwarded hop is read and normalised", () => {
  assert.equal(trustedCaller(requestWith({ "x-forwarded-for": "::ffff:203.0.113.7, 10.0.0.1" }), true), "203.0.113.7");
  assert.equal(trustedCaller(requestWith({ "x-real-ip": "203.0.113.9" }), true), "203.0.113.9");
});

test("trusted but junk falls back to the shared bucket rather than a fresh one", () => {
  assert.equal(trustedCaller(requestWith({ "x-forwarded-for": "not-an-ip" }), true), UNATTRIBUTED);
  assert.equal(trustedCaller(requestWith({}), true), UNATTRIBUTED);
});
