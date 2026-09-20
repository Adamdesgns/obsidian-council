// test/deliberation.test.mjs — Deliberation Engine Task 6: the deliberations table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";
import { preflight, RUNS_PER_DELIBERATOR, MAX_ROUNDS } from "../src/deliberation.mjs";
import { setSeats } from "../src/seats.mjs";
import { spawnMember } from "../src/adapters/spawn.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATION = join(ROOT, "src", "migrations", "003_deliberations.sql");
const FAKE = join(ROOT, "src", "testutil", "fake-member.mjs");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-delib-"));
}

function withStore(fn) {
  const home = tempHome();
  process.env.COUNCIL_HOME = home;
  const store = openStore({ home });
  const cleanup = () => {
    try { store.close(); } catch { /* */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  };
  let out;
  try {
    out = fn(store, home);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(cleanup);
  cleanup();
  return out;
}

describe("deliberations schema", () => {
  it("creates the table on open", () => withStore((store) => {
    const row = store.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='deliberations'"
    ).get();
    assert.equal(row?.name, "deliberations");
  }));

  it("has exactly the columns the spec names, with the right nullability and defaults", () => withStore((store) => {
    const cols = store.prepare("PRAGMA table_info(deliberations)").all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.deepEqual(
      cols.map((c) => c.name),
      ["id", "chamber_id", "question", "category", "state", "round", "flag", "deliberators", "answers", "final_answer", "content_hash", "stall_detail", "created", "updated"]
    );
    assert.equal(byName.id.pk, 1);
    for (const required of ["question", "state", "round", "deliberators", "answers", "created", "updated"]) {
      assert.equal(byName[required].notnull, 1, `${required} must be NOT NULL`);
    }
    for (const optional of ["chamber_id", "category", "flag", "final_answer", "content_hash", "stall_detail"]) {
      assert.equal(byName[optional].notnull, 0, `${optional} must be nullable`);
    }
    assert.equal(byName.round.dflt_value, "0");
    assert.equal(byName.answers.dflt_value, "'{}'");
  }));

  it("indexes state and chamber_id", () => withStore((store) => {
    const idx = store.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deliberations' AND name LIKE 'idx_%' ORDER BY name"
    ).all().map((r) => r.name);
    assert.deepEqual(idx, ["idx_delib_chamber", "idx_delib_state"]);
  }));

  it("is recorded in schema_migrations and re-opening the same home does not re-run or fail", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    let store = openStore({ home });
    try {
      const applied = () => store.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(applied(), ["001_init.sql", "002_messages_chain.sql", "003_deliberations.sql"]);
      store.prepare(
        `INSERT INTO deliberations(id, question, state, deliberators, created, updated) VALUES(?,?,?,?,?,?)`
      ).run("d1", "q", "answer_1", '["codex","fable"]', "t", "t");
      store.close();
      store = openStore({ home });
      assert.deepEqual(applied(), ["001_init.sql", "002_messages_chain.sql", "003_deliberations.sql"]);
      assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 1, "data survives re-open");
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("the migration file carries no BEGIN/COMMIT: the runner wraps it", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    assert.doesNotMatch(sql, /\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS deliberations/);
  });

  it("deliberators and answers are JSON strings that round-trip through the row; answers defaults to {}", () => withStore((store) => {
    const deliberators = ["codex", "fable"];
    const answers = { codex: "m-1", fable: "m-2" };
    store.commit("deliberation_opened", "owner", (api) => {
      api.prepare(
        `INSERT INTO deliberations(id, chamber_id, question, state, deliberators, answers, created, updated)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run("d1", "c1", "Should we?", "answer_1", JSON.stringify(deliberators), JSON.stringify(answers), api.nowIso(), api.nowIso());
      api.prepare(
        `INSERT INTO deliberations(id, question, state, deliberators, created, updated) VALUES(?,?,?,?,?,?)`
      ).run("d2", "Bare row", "answer_1", JSON.stringify(deliberators), api.nowIso(), api.nowIso());
      api.setRef("deliberations", "d1", { deliberators });
    });
    const d1 = store.prepare("SELECT * FROM deliberations WHERE id = 'd1'").get();
    assert.deepEqual(JSON.parse(d1.deliberators), deliberators);
    assert.deepEqual(JSON.parse(d1.answers), answers);
    assert.equal(d1.round, 0);
    assert.equal(d1.flag, null);
    const d2 = store.prepare("SELECT answers, round FROM deliberations WHERE id = 'd2'").get();
    assert.deepEqual(JSON.parse(d2.answers), {});
    assert.equal(d2.round, 0);
    assert.equal(store.verifyChain().ok, true);
  }));

  it("NOT NULL columns are enforced", () => withStore((store) => {
    assert.throws(
      () => store.prepare(`INSERT INTO deliberations(id, state, deliberators, created, updated) VALUES('d3','answer_1','[]','t','t')`).run(),
      /NOT NULL constraint failed: deliberations\.question/
    );
  }));
});

describe("preflight", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };
  const insertRun = (store, member, n = 1) => {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      store.prepare(
        `INSERT INTO runs(id, member, chamber_id, message_id, argv, started) VALUES(?,?,?,?,?,?)`
      ).run(`r-${member}-${i}-${Math.random()}`, member, "c1", null, "[]", now);
    }
  };

  it("constants: 4 runs per deliberator (1 blind answer + 3 debate rounds), 3 rounds max", () => {
    assert.equal(RUNS_PER_DELIBERATOR, 4);
    assert.equal(MAX_ROUNDS, 3);
  });

  it("allows a deliberation when both have 4 runs left", () => withStore((store) => {
    const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, true);
  }));

  it("refuses when one deliberator has fewer than 4 runs left", () => withStore((store) => {
    insertRun(store, "fable", 7);
    const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient_budget");
    assert.equal(r.member, "fable");
    assert.equal(r.account, "anthropic");
    assert.equal(r.remaining, 3);
    assert.equal(r.needed, 4);
  }));

  it("exactly 4 left passes; 3 left refuses (boundary)", () => withStore((store) => {
    insertRun(store, "codex", 11);
    assert.equal(preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS }).ok, true, "15-11 = 4 remaining");
    insertRun(store, "codex", 1);
    const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.member, "codex");
    assert.equal(r.remaining, 3);
  }));

  it("a claude run spends fable's preflight budget: the account is what is counted", () => withStore((store) => {
    insertRun(store, "claude", 7);
    const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.member, "fable");
    assert.equal(r.account, "anthropic");
    assert.equal(r.remaining, 3);
  }));

  it("two deliberators on ONE account need 8 runs between them, not 4 each checked alone", () => withStore((store) => {
    // fable and claude both spend anthropic (10). With 3 used, 7 remain: each
    // alone would pass a >= 4 check, yet the pair would strand at run 8.
    insertRun(store, "claude", 3);
    const r = preflight(store, { deliberators: ["fable", "claude"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient_budget");
    assert.equal(r.account, "anthropic");
    assert.equal(r.member, "fable", "the first deliberator on the short account is named");
    assert.equal(r.remaining, 7);
    assert.equal(r.needed, 8);
    assert.equal(preflight(store, { deliberators: ["fable", "claude"], limits: { daily_ceiling: { anthropic: 11 } } }).ok, true);
  }));

  it("uses the same ceiling rule as spawnMember, so it can never approve what spawn would refuse", () => withStore((store) => {
    // Member-keyed limits (as every existing test passes them): fable inherits
    // claude's 10 through the shared account instead of the 100 fallback.
    const memberKeyed = { daily_ceiling: { claude: 10, codex: 15, grok: 15 } };
    insertRun(store, "fable", 7);
    const r = preflight(store, { deliberators: ["codex", "fable"], limits: memberKeyed });
    assert.equal(r.ok, false);
    assert.equal(r.remaining, 3);
    // No ceiling anywhere -> 100, same as spawn.
    assert.equal(preflight(store, { deliberators: ["codex", "fable"], limits: {} }).ok, true);
  }));

  it("a refusal is consistent with what spawnMember then does at the wall", () => withStore(async (store) => {
    const limits = { daily_ceiling: { anthropic: 4, codex: 15 }, timeout_ms: { fake: 5000 } };
    assert.equal(preflight(store, { deliberators: ["codex", "fable"], limits }).ok, true, "4 remaining passes");
    insertRun(store, "claude", 1);
    const r = preflight(store, { deliberators: ["codex", "fable"], limits });
    assert.equal(r.ok, false);
    assert.equal(r.remaining, 3);
    // Preflight said 3 runs remain: three fable runs succeed, the fourth is refused by spawn.
    for (let i = 0; i < 3; i++) {
      const ok = await spawnMember(store, "fable", "hi", { fakePath: FAKE, limits, skipBuildVerify: true });
      assert.equal(ok.refused, undefined, `run ${i}: ${JSON.stringify(ok)}`);
    }
    const wall = await spawnMember(store, "fable", "hi", { fakePath: FAKE, limits, skipBuildVerify: true });
    assert.match(wall.refused || "", /BUDGET/);
  }));

  it("is read-only: no event is appended, the chain length is unchanged", () => withStore((store) => {
    const before = store.getEvents().length;
    preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    insertRun(store, "fable", 9);
    preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(store.getEvents().length, before);
    assert.equal(store.verifyChain().ok, true);
  }));

  it("an unknown seat is refused, not thrown", () => withStore((store) => {
    const r = preflight(store, { deliberators: ["codex", "nope"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unknown_seat");
    assert.equal(r.member, "nope");
    assert.deepEqual(preflight(store, { deliberators: [], limits: LIMITS }), { ok: false, reason: "no_deliberators" });
    assert.equal(preflight(store, { limits: LIMITS }).reason, "no_deliberators");
  }));

  it("follows the seat table: a seat swapped onto another account is budgeted there", () => withStore((store) => {
    try {
      setSeats({
        codex: { adapter: "codex", model: null, account: "codex", role: "deliberator" },
        fable: { adapter: "claude", model: "claude-fable-5-1", account: "fable-solo", role: "deliberator" },
      });
      insertRun(store, "claude", 9); // claude is not a seat now; must not count anywhere
      const r = preflight(store, { deliberators: ["codex", "fable"], limits: { daily_ceiling: { "fable-solo": 4, codex: 15 } } });
      assert.equal(r.ok, true);
    } finally {
      setSeats(null);
    }
  }));
});
