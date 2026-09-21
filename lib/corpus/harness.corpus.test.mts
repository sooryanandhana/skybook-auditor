/**
 * The corpus checks its own instruments before anything else relies on them.
 *
 * Several corpus verdicts are ABSENCES — no request reached a private address,
 * no DNS query left the machine, no response body was released. An absence is
 * only evidence if the instrument could have seen the presence. Each test here
 * is the positive control for one of those instruments.
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";

import {
  correct,
  escapedRequests,
  HTML,
  PUBLIC_HOST,
  installOfflineCorpus,
  withServer,
} from "./corpus.fixture.mts";

const offline = installOfflineCorpus();

correct("the DNS stub answers an IP literal itself, as Node's resolver does, without a query", async () => {
  const answer = await lookup(PUBLIC_HOST, { all: true });
  assert.deepEqual(answer, [{ address: PUBLIC_HOST, family: 4 }]);
});

correct("the DNS stub refuses a name no test registered, and records that it was asked", async () => {
  const before = offline.lookups.length;
  await assert.rejects(lookup("unregistered.example", { all: true }), { code: "ENOTFOUND" });
  assert.deepEqual(offline.lookups.slice(before), ["unregistered.example"]);
});

correct("the DNS stub answers a name a test registered, and only with the addresses given", async () => {
  offline.hosts.set("registered.example", ["203.0.113.9"]);
  assert.deepEqual(await lookup("registered.example", { all: true }), [{ address: "203.0.113.9", family: 4 }]);
  offline.hosts.delete("registered.example");
});

correct("a request made outside a scripted server hits the tripwire instead of the network", async () => {
  await assert.rejects(fetch(`https://${PUBLIC_HOST}/`), /escaped to the network/);
  assert.equal(escapedRequests.at(-1), `https://${PUBLIC_HOST}/`);
  // Deliberately tripped, so cleared: any other escape still fails this file.
  escapedRequests.length = 0;
});

correct("a response body that the code releases is recorded as released", async () => {
  await withServer(
    (_url, server) => server.respond("control", { headers: HTML, body: "x".repeat(200_000) }),
    async (server) => {
      const response = await fetch(`https://${PUBLIC_HOST}/`);
      await response.body?.cancel();
      assert.deepEqual(server.cancelled, ["control"]);
    },
  );
});

correct("a response body that the code reads to the end completes and is not recorded as released", async () => {
  await withServer(
    (_url, server) => server.respond("read", { headers: HTML, body: "y".repeat(200_000) }),
    async (server) => {
      const text = await (await fetch(`https://${PUBLIC_HOST}/`)).text();
      assert.equal(text.length, 200_000);
      assert.deepEqual(server.cancelled, []);
    },
  );
});
