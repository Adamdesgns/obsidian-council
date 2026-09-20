// test/routing.test.mjs — Task 2 Step 5/5b: the routable set comes from the seat table.
// Pure: no DB, no HTTP. The HTTP-level chain contract is test/chain-routing.http.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAddressChain, routeOwnerSay, defaultBroadcast, DEFAULT_BROADCAST } from "../src/routing.mjs";
import { setSeats, seatIds } from "../src/seats.mjs";

function stubOutbox() {
  const sent = [];
  return { sent, send(envelope) { sent.push(envelope); return { message: envelope, deliveries: [], duplicate: false }; } };
}

describe("routing: routable set is the seat table", () => {
  it("(a) every seat id is routable, including fable", () => {
    for (const id of seatIds()) {
      assert.deepEqual(parseAddressChain(`@${id} please`), [id], id);
    }
    assert.deepEqual(parseAddressChain("@fable draft it. @codex tear it apart. @fable revise."), ["fable", "codex", "fable"]);
  });

  it("(b) @owner is plain text, never a hop, in any position", () => {
    assert.deepEqual(parseAddressChain("@owner please decide"), []);
    assert.deepEqual(parseAddressChain("@owner and @codex look"), ["codex"]);
    assert.deepEqual(parseAddressChain("@codex draft @owner check @grok ship"), ["codex", "grok"]);
    assert.equal(seatIds().includes("owner"), false);
  });

  it("(c) unknown names are plain text; matching is case-insensitive", () => {
    assert.deepEqual(parseAddressChain("@bob @mystery-tool @Fable @CODEX"), ["fable", "codex"]);
    assert.deepEqual(parseAddressChain(""), []);
    assert.deepEqual(parseAddressChain(null), []);
  });

  it("(d) a seat added through setSeats becomes routable without touching routing.mjs", () => {
    try {
      setSeats({ opus: { adapter: "claude", model: "claude-opus-5", account: "anthropic", role: "arbiter" } });
      assert.deepEqual(parseAddressChain("@opus rule on this @codex"), ["opus"]);
    } finally {
      setSeats(null);
    }
    assert.deepEqual(parseAddressChain("@opus rule on this @codex"), ["codex"]);
  });

  it("(e) routeOwnerSay delivers a @fable chain root to fable only, chain persisted", () => {
    const outbox = stubOutbox();
    routeOwnerSay(outbox, { content: "@fable plan @codex critique", chamber_id: "c" });
    assert.equal(outbox.sent.length, 1);
    assert.deepEqual(outbox.sent[0].recipients, ["fable"]);
    assert.deepEqual(outbox.sent[0].chain, ["fable", "codex"]);
    assert.equal(outbox.sent[0].chain_hop, 0);
    assert.equal(outbox.sent[0].sender, "owner");
  });
});

describe("routing: broadcast default (Step 5b)", () => {
  it("(a) defaultBroadcast() is the deliberators, derived from seat roles, never executors", () => {
    assert.deepEqual(defaultBroadcast(), ["codex", "fable"]);
    try {
      setSeats({
        a: { adapter: "codex", model: null, account: "codex", role: "executor" },
        b: { adapter: "grok", model: null, account: "grok", role: "deliberator" },
      });
      assert.deepEqual(defaultBroadcast(), ["b"]);
    } finally {
      setSeats(null);
    }
  });

  it("(b) until Task 3 lands per-account ceilings, unaddressed owner lines still go to DEFAULT_BROADCAST (codex+grok)", () => {
    // Deliberately NOT defaultBroadcast() yet: the running dispatcher serves
    // codex/grok/claude (council.mjs), so a fable delivery would be a dead
    // letter, and fable has no ceiling until Task 3. PR #1 pinned this in
    // test/chain-routing.http.test.mjs (d)/(e). Flip both when Task 3 lands.
    assert.deepEqual(DEFAULT_BROADCAST, ["codex", "grok"]);
    const outbox = stubOutbox();
    routeOwnerSay(outbox, { content: "status check please" });
    assert.deepEqual(outbox.sent[0].recipients, ["codex", "grok"]);
    assert.equal(outbox.sent[0].chain, undefined);
  });
});
