// test/seats.test.mjs — Deliberation Engine Task 1: seat resolution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { seatOf, accountOf, seatIds, allSeats, setSeats } from "../src/seats.mjs";
import { argsForSeat, adapterForSeat, resolveCli, spawnMember } from "../src/adapters/spawn.mjs";
import { openStore } from "../src/store.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE = join(ROOT, "src", "testutil", "fake-member.mjs");

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

describe("spawn via seats", () => {
  it("threads --model for a seat that has one", () => {
    const args = argsForSeat("fable", "hello packet", {});
    const i = args.indexOf("--model");
    assert.ok(i >= 0, "--model must be present");
    assert.equal(args[i + 1], "claude-fable-5-1");
  });

  it("omits --model for a seat without one", () => {
    const args = argsForSeat("claude", "hello packet", {});
    assert.equal(args.includes("--model"), false);
  });

  it("uses the codex adapter for the codex seat", () => {
    const args = argsForSeat("codex", "hello packet", {});
    assert.ok(Array.isArray(args));
  });

  it("fable and claude are the same adapter module; --model is the only argv difference", () => {
    assert.equal(adapterForSeat("fable"), adapterForSeat("claude"));
    assert.equal(adapterForSeat("fable").describe().id, "claude");
    const fable = argsForSeat("fable", "same packet", {});
    const claude = argsForSeat("claude", "same packet", {});
    assert.deepEqual(fable.slice(2), claude);
  });

  it("an unknown seat cannot resolve an adapter or argv", () => {
    assert.throws(() => adapterForSeat("nope"), /unknown seat: nope/);
    assert.throws(() => argsForSeat("owner", "x", {}), /unknown seat: owner/);
  });

  it("resolveCli branches on the seat's adapter; the fake short-circuit and unknown ids are unchanged", () => {
    const fake = resolveCli("fable", { fakePath: FAKE });
    assert.equal(fake.fake, true);
    assert.deepEqual(fake.prefix, [FAKE]);
    assert.deepEqual(resolveCli("nope", {}), { found: false });
    assert.deepEqual(resolveCli("owner", {}), { found: false });
    // Real CLI lookup for fable takes the claude branch: found or not, it must not throw.
    const real = resolveCli("fable", {});
    assert.equal(typeof real.found, "boolean");
  });

  it("fable spawns end to end through the fake; the recorded argv carries --model", async () => {
    const home = mkdtempSync(join(tmpdir(), "council-seats-"));
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const r = await spawnMember(store, "fable", "hello from the floor", {
        fakePath: FAKE,
        limits: { daily_ceiling: { fable: 5, claude: 5 }, timeout_ms: { fake: 5000 } },
        role: "review",
        skipBuildVerify: true,
      });
      assert.equal(r.refused, undefined, JSON.stringify(r));
      assert.equal(r.exit, 0);
      assert.match(r.stdout, /fake-ok/);
      const row = store.prepare("SELECT member, argv FROM runs WHERE id = ?").get(r.runId);
      assert.equal(row.member, "fable", "the runs row is keyed by seat id, not adapter");
      assert.match(row.argv, /--model claude-fable-5-1/);
      assert.match(row.argv, /--print/, "claude adapter argv follows the model flag");
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
