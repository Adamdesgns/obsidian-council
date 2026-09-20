// test/seats.test.mjs — Deliberation Engine Task 1: seat resolution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seatOf, accountOf, seatIds, allSeats, setSeats } from "../src/seats.mjs";

describe("seats", () => {
  it("resolves a built-in seat to its adapter", () => {
    const s = seatOf("codex");
    assert.equal(s.adapter, "codex");
    assert.equal(s.model, null);
    assert.equal(s.account, "codex");
  });

  it("resolves fable to the claude adapter with a model", () => {
    const s = seatOf("fable");
    assert.equal(s.adapter, "claude");
    assert.equal(s.model, "claude-fable-5-1");
  });

  it("puts fable and claude on the SAME account", () => {
    assert.equal(accountOf("fable"), accountOf("claude"));
  });

  it("throws on an unknown seat", () => {
    assert.throws(() => seatOf("nope"), /unknown seat: nope/);
  });

  it("lists every seat id", () => {
    assert.deepEqual(seatIds().sort(), ["claude", "codex", "fable", "grok"]);
  });

  it("prototype names and non-strings are unknown seats, not accidental hits", () => {
    for (const id of ["constructor", "__proto__", "toString", "", null, undefined, 42]) {
      assert.throws(() => seatOf(id), /unknown seat/, String(id));
    }
  });

  it("owner is the floor, not a seat", () => {
    assert.throws(() => seatOf("owner"), /unknown seat: owner/);
    assert.equal(seatIds().includes("owner"), false);
  });

  it("every seat carries id, adapter, model, account and role; allSeats matches seatIds", () => {
    const seats = allSeats();
    assert.deepEqual(seats.map((s) => s.id), seatIds());
    for (const s of seats) {
      assert.ok(["claude", "codex", "grok"].includes(s.adapter), s.id);
      assert.ok(s.model === null || typeof s.model === "string", s.id);
      assert.equal(typeof s.account, "string");
      assert.ok(["deliberator", "executor", "arbiter"].includes(s.role), s.id);
    }
    assert.deepEqual(seats.filter((s) => s.role === "deliberator").map((s) => s.id), ["codex", "fable"]);
  });

  it("seatOf returns a copy: mutating it does not change the table", () => {
    const a = seatOf("grok");
    a.role = "deliberator";
    assert.equal(seatOf("grok").role, "executor");
  });

  it("setSeats swaps the table for tests and null restores the built-ins", () => {
    try {
      setSeats({ solo: { adapter: "codex", model: null, account: "codex", role: "deliberator" } });
      assert.deepEqual(seatIds(), ["solo"]);
      assert.throws(() => seatOf("codex"), /unknown seat: codex/);
    } finally {
      setSeats(null);
    }
    assert.deepEqual(seatIds().sort(), ["claude", "codex", "fable", "grok"]);
  });
});
