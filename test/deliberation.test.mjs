// test/deliberation.test.mjs — Deliberation Engine Task 6: the deliberations table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";
import { preflight, RUNS_PER_DELIBERATOR, MAX_ROUNDS, startDeliberation, deliberationKey, blindPrompt } from "../src/deliberation.mjs";
import { createOutbox } from "../src/outbox.mjs";
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

describe("startDeliberation", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };
  const Q = "should we cache the chain?";
  const insertRuns = (store, member, n) => {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      store.prepare(`INSERT INTO runs(id, member, chamber_id, message_id, argv, started) VALUES(?,?,?,?,?,?)`)
        .run(`r-${member}-${i}`, member, "c1", null, "[]", now);
    }
  };
  const withOutbox = (fn) => withStore((store) => {
    const outbox = createOutbox(store);
    try { return fn(store, outbox); } finally { try { outbox.close(); } catch { /* */ } }
  });

  it("asks only the FIRST deliberator, and the packet holds only the question", () => withOutbox((store, outbox) => {
    const r = startDeliberation(store, outbox, { chamber_id: "c1", question: Q, deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, true);
    assert.equal(r.state, "answer_1");
    assert.match(r.id, /^[0-9a-f-]{36}$/);

    const msgs = store.prepare("SELECT * FROM messages WHERE chamber_id = ?").all("c1");
    assert.equal(msgs.length, 1, "exactly one member is asked first");
    assert.deepEqual(JSON.parse(msgs[0].recipients), ["codex"]);
    assert.match(msgs[0].content, /should we cache the chain\?/);
    assert.equal(msgs[0].content, blindPrompt(Q), "the packet is the blind prompt and nothing more");
    assert.doesNotMatch(msgs[0].content, /fable|codex|grok|claude/i, "no seat is named to the first answerer");
    assert.equal(msgs[0].kind, "deliberate");
    assert.equal(msgs[0].sender, "owner");
    assert.equal(msgs[0].idempotency_key, deliberationKey(r.id, "answer_1", 0, "codex"));
    assert.equal(r.message_id, msgs[0].id);

    const deliveries = store.prepare("SELECT recipient, status FROM deliveries").all().map((d) => ({ ...d }));
    assert.deepEqual(deliveries, [{ recipient: "codex", status: "pending" }], "one pending delivery, to codex only");
  }));

  it("persists the row in answer_1, round 0, empty answers, deliberators in order", () => withOutbox((store, outbox) => {
    const r = startDeliberation(store, outbox, { chamber_id: "c1", question: Q, deliberators: ["fable", "codex"], limits: LIMITS, category: "routine" });
    const row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
    assert.equal(row.state, "answer_1");
    assert.equal(row.round, 0);
    assert.equal(row.chamber_id, "c1");
    assert.equal(row.question, Q);
    assert.equal(row.category, "routine");
    assert.equal(row.flag, null);
    assert.equal(row.final_answer, null);
    assert.deepEqual(JSON.parse(row.deliberators), ["fable", "codex"]);
    assert.deepEqual(JSON.parse(row.answers), {});
    assert.equal(row.created, row.updated);
    // The order given is the order asked: fable first here.
    assert.deepEqual(JSON.parse(store.prepare("SELECT recipients FROM messages").get().recipients), ["fable"]);
  }));

  it("records a deliberation_started event and the chain verifies", () => withOutbox((store, outbox) => {
    const r = startDeliberation(store, outbox, { chamber_id: "c1", question: Q, deliberators: ["codex", "fable"], limits: LIMITS });
    const ev = store.getEvents().find((e) => e.kind === "deliberation_started");
    assert.ok(ev, "deliberation_started event");
    assert.equal(ev.actor, "owner");
    assert.equal(ev.ref_table, "deliberations");
    assert.equal(ev.ref_id, r.id);
    assert.deepEqual(JSON.parse(ev.payload), { state: "answer_1", deliberators: ["codex", "fable"] });
    const kinds = store.getEvents().map((e) => e.kind);
    assert.ok(kinds.indexOf("deliberation_started") < kinds.indexOf("message_sent"), "row first, then the send");
    assert.equal(store.verifyChain().ok, true);
  }));

  it("uses a deterministic idempotency key", () => {
    assert.equal(deliberationKey("d1", "answer_1", 0, "codex"), "delib:d1:answer_1:0:codex");
    assert.equal(deliberationKey("d1", "debate", 2, "fable"), "delib:d1:debate:2:fable");
  });

  it("the key makes a re-send a no-op through the real outbox: one message, one delivery", () => withOutbox((store, outbox) => {
    const r = startDeliberation(store, outbox, { chamber_id: "c1", question: Q, deliberators: ["codex", "fable"], limits: LIMITS });
    const again = outbox.send({
      sender: "owner", recipients: ["codex"], chamber_id: "c1", kind: "deliberate",
      content: blindPrompt(Q), idempotency_key: deliberationKey(r.id, "answer_1", 0, "codex"),
    });
    assert.equal(again.duplicate, true);
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 1);
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliveries").get().c, 1);
  }));

  it("refuses to start when budget is short: no row, no message", () => withOutbox((store, outbox) => {
    insertRuns(store, "fable", 8);
    const r = startDeliberation(store, outbox, { chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient_budget");
    assert.equal(r.member, "fable");
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 0);
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 0);
    assert.equal(store.getEvents().filter((e) => e.kind === "deliberation_started").length, 0);
  }));

  it("needs exactly two distinct known seats and a non-empty question; refuses without writing", () => withOutbox((store, outbox) => {
    const base = { chamber_id: "c1", question: Q, limits: LIMITS };
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: ["codex"] }).reason, "need_exactly_two_deliberators");
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: ["codex", "fable", "grok"] }).reason, "need_exactly_two_deliberators");
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: undefined }).reason, "need_exactly_two_deliberators");
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: ["codex", "codex"] }).reason, "duplicate_deliberator");
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: ["codex", "nope"] }).reason, "unknown_seat");
    assert.equal(startDeliberation(store, outbox, { ...base, deliberators: ["codex", "owner"] }).reason, "unknown_seat");
    for (const question of ["", "   ", null, undefined, 42]) {
      const r = startDeliberation(store, outbox, { ...base, question, deliberators: ["codex", "fable"] });
      assert.equal(r.ok, false, String(question));
      assert.equal(r.reason, "empty_question");
    }
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 0);
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 0);
  }));

  it("chamber_id may be null (the default chamber)", () => withOutbox((store, outbox) => {
    const r = startDeliberation(store, outbox, { question: Q, deliberators: ["codex", "fable"], limits: LIMITS });
    assert.equal(r.ok, true);
    assert.equal(store.prepare("SELECT chamber_id FROM deliberations").get().chamber_id, null);
    assert.equal(store.prepare("SELECT chamber_id FROM messages").get().chamber_id, null);
  }));

  it("two deliberations on one chamber get distinct ids and keys; each asks its own first seat", () => withOutbox((store, outbox) => {
    const a = startDeliberation(store, outbox, { chamber_id: "c1", question: "first?", deliberators: ["codex", "fable"], limits: LIMITS });
    const b = startDeliberation(store, outbox, { chamber_id: "c1", question: "second?", deliberators: ["fable", "codex"], limits: LIMITS });
    assert.notEqual(a.id, b.id);
    const keys = store.prepare("SELECT idempotency_key FROM messages ORDER BY created, id").all().map((m) => m.idempotency_key).sort();
    assert.deepEqual(keys, [deliberationKey(a.id, "answer_1", 0, "codex"), deliberationKey(b.id, "answer_1", 0, "fable")].sort());
    assert.equal(store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 2);
  }));

  it("blindPrompt carries the question verbatim and says why nothing else is there", () => {
    const p = blindPrompt("Is 4777 loopback only?");
    assert.match(p, /QUESTION:\nIs 4777 loopback only\?$/);
    assert.match(p, /independently/);
    assert.match(p, /No other member's answer/);
  });
});
