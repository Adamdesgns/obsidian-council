// test/seats.test.mjs — Deliberation Engine Task 1: seat resolution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { seatOf, accountOf, seatIds, allSeats, setSeats } from "../src/seats.mjs";
import { argsForSeat, adapterForSeat, resolveCli, spawnMember, runsTodayForAccount, ceilingFor, timeoutFor } from "../src/adapters/spawn.mjs";
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

describe("per-account ceilings", () => {
  function withStore(fn) {
    const home = mkdtempSync(join(tmpdir(), "council-seats-"));
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    return Promise.resolve()
      .then(() => fn(store))
      .finally(() => {
        try { store.close(); } catch { /* */ }
        try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
      });
  }
  const insertRun = (store, member, started = new Date().toISOString()) =>
    store.prepare(
      `INSERT INTO runs(id, member, chamber_id, message_id, argv, started) VALUES(?,?,?,?,?,?)`
    ).run(`run-${member}-${Math.random()}`, member, "c1", null, "[]", started);

  it("counts fable and claude runs against ONE account", () => withStore((store) => {
    for (const m of ["fable", "claude"]) insertRun(store, m);
    assert.equal(runsTodayForAccount(store, "anthropic"), 2);
    assert.equal(runsTodayForAccount(store, "codex"), 0);
  }));

  it("only today's runs count; an unknown account counts nothing", () => withStore((store) => {
    insertRun(store, "claude", "2000-01-01T00:00:00.000Z");
    insertRun(store, "codex");
    assert.equal(runsTodayForAccount(store, "anthropic"), 0);
    assert.equal(runsTodayForAccount(store, "codex"), 1);
    assert.equal(runsTodayForAccount(store, "nope"), 0);
  }));

  it("ceilingFor resolves account key first, then the smallest peer seat key, then member, then fake, then 100", () => {
    assert.equal(ceilingFor({ daily_ceiling: { anthropic: 10, claude: 99, fable: 99 } }, "fable"), 10, "account key wins");
    assert.equal(ceilingFor({ daily_ceiling: { claude: 10, codex: 15, grok: 15 } }, "fable"), 10, "member-keyed limits: fable inherits claude's via the shared account");
    assert.equal(ceilingFor({ daily_ceiling: { claude: 10, fable: 3 } }, "claude"), 3, "the tightest peer key bounds the whole account");
    assert.equal(ceilingFor({ daily_ceiling: { codex: 0 } }, "codex"), 0);
    assert.equal(ceilingFor({ daily_ceiling: { fake: 7 } }, "codex"), 7, "fake fallback kept for member-less limits");
    assert.equal(ceilingFor({ daily_ceiling: {} }, "grok"), 100);
    assert.equal(ceilingFor({}, "grok"), 100);
    assert.equal(ceilingFor({ daily_ceiling: { fake: 2 } }, "not-a-seat"), 2, "non-seat ids keep the old member/fake chain");
  });

  it("timeoutFor falls back from seat to adapter, so a real fable run is not cut at the fake 5 s", () => {
    const limits = JSON.parse(readFileSync(join(ROOT, "config", "limits.json"), "utf8"));
    assert.equal(timeoutFor(limits, "fable"), limits.timeout_ms.claude);
    assert.equal(timeoutFor(limits, "claude"), limits.timeout_ms.claude);
    assert.equal(timeoutFor({ timeout_ms: { fable: 1234, claude: 9 } }, "fable"), 1234, "seat key wins");
    assert.equal(timeoutFor({ timeout_ms: { fake: 5000 } }, "codex"), 5000, "fake fallback kept for member-less limits");
    assert.equal(timeoutFor({ timeout_ms: { fake: 5000 } }, "not-a-seat"), 5000);
    assert.equal(timeoutFor({}, "grok"), 240000);
  });

  it("the shipped limits file is keyed by account: anthropic, codex, grok", () => {
    const limits = JSON.parse(readFileSync(join(ROOT, "config", "limits.json"), "utf8"));
    assert.deepEqual(Object.keys(limits.daily_ceiling).sort(), ["anthropic", "codex", "grok"]);
    assert.equal(ceilingFor(limits, "fable"), limits.daily_ceiling.anthropic);
    assert.equal(ceilingFor(limits, "claude"), limits.daily_ceiling.anthropic);
    assert.equal(limits.daily_ceiling.anthropic, 10, "claude's shipped 10/day is now the whole anthropic account");
  });

  it("a claude run spends fable's budget: spawnMember refuses fable once the anthropic account is at its ceiling", () => withStore(async (store) => {
    insertRun(store, "claude");
    const limits = { daily_ceiling: { anthropic: 1, codex: 5 }, timeout_ms: { fake: 5000 } };
    const refused = await spawnMember(store, "fable", "hello", { fakePath: FAKE, limits, skipBuildVerify: true });
    assert.match(refused.refused || "", /BUDGET/);
    assert.match(refused.refused, /anthropic/, "the refusal names the account, not just the seat");
    assert.match(refused.refused, /1\/1/);
    const row = store.prepare("SELECT member FROM runs WHERE id = ?").get(refused.runId);
    assert.equal(row.member, "fable", "the refusal row is keyed by seat");
    // codex is a different account and still runs.
    const ok = await spawnMember(store, "codex", "hello", { fakePath: FAKE, limits, skipBuildVerify: true });
    assert.equal(ok.refused, undefined, JSON.stringify(ok));
    assert.equal(ok.exit, 0);
  }));
});
