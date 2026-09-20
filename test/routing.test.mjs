// test/routing.test.mjs — Task 2 Step 5/5b: the routable set comes from the seat table.
// Pure: no DB, no HTTP. The HTTP-level chain contract is test/chain-routing.http.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAddressChain, routeOwnerSay, defaultBroadcast } from "../src/routing.mjs";
import { setSeats, seatIds } from "../src/seats.mjs";
import { defaultMembers } from "../src/council.mjs";

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

  it("(b) unaddressed owner lines go to the deliberators (Task 3 flipped the consumer); executors and the arbiter only when addressed", () => {
    const outbox = stubOutbox();
    routeOwnerSay(outbox, { content: "status check please" });
    assert.deepEqual(outbox.sent[0].recipients, ["codex", "fable"]);
    assert.equal(outbox.sent[0].chain, undefined);
    routeOwnerSay(outbox, { content: "@grok ship it" });
    assert.deepEqual(outbox.sent[1].recipients, ["grok"]);
    routeOwnerSay(outbox, { content: "@claude rule on this" });
    assert.deepEqual(outbox.sent[2].recipients, ["claude"]);
  });

  it("(c) the default follows the seat table, so a role change re-routes without a code edit", () => {
    try {
      setSeats({
        codex: { adapter: "codex", model: null, account: "codex", role: "deliberator" },
        grok: { adapter: "grok", model: null, account: "grok", role: "deliberator" },
      });
      const outbox = stubOutbox();
      routeOwnerSay(outbox, { content: "status check please" });
      assert.deepEqual(outbox.sent[0].recipients, ["codex", "grok"]);
    } finally {
      setSeats(null);
    }
  });

  it("(d) the council entry point runs a dispatcher seat for every seat, so no default recipient is a dead letter", () => {
    // Guards the Step 5 rationale: a delivery to a seat the dispatcher does not
    // loop can never be claimed. council.mjs must derive its member list from
    // the same table routing uses.
    const members = defaultMembers();
    for (const id of defaultBroadcast()) assert.ok(members.includes(id), id);
    assert.deepEqual([...members].sort(), [...seatIds()].sort());
  });
});
