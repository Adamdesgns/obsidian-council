// test/deliberation.test.mjs — Deliberation Engine Task 6: the deliberations table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";
import { preflight, RUNS_PER_DELIBERATOR, MAX_ROUNDS, startDeliberation, deliberationKey, blindPrompt, advanceOnReply, findDeliberationFor, parseDeliberationKey, abandon, debatePrompt, stall } from "../src/deliberation.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
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

describe("advanceOnReply", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };
  const rowOf = (store, id) => store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
  const answersOf = (store, id) => JSON.parse(rowOf(store, id).answers);
  const msgs = (store) => store.prepare("SELECT * FROM messages ORDER BY created ASC, rowid ASC").all();
  const latestTo = (store, m) => store.prepare("SELECT * FROM messages WHERE recipients LIKE ? ORDER BY created DESC, rowid DESC").get(`%"${m}"%`);
  const events = (store, kind) => store.getEvents().filter((e) => e.kind === kind);

  const withDelib = (fn) => withStore((store) => {
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, { chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS });
      return fn({ store, outbox, id: r.id, first: msgs(store)[0] });
    } finally { try { outbox.close(); } catch { /* */ } }
  });
  // Drive both blind answers; returns the two debate-round-1 packets.
  const toDebate = (ctx) => {
    advanceOnReply(ctx.store, ctx.outbox, { message: ctx.first, member: "codex", text: "A" });
    advanceOnReply(ctx.store, ctx.outbox, { message: latestTo(ctx.store, "fable"), member: "fable", text: "B" });
  };
  const reply = (ctx, m, text) => advanceOnReply(ctx.store, ctx.outbox, { message: latestTo(ctx.store, m), member: m, text });

  it("moves to answer_2 and does NOT leak the first answer", () => withDelib((ctx) => {
    const out = advanceOnReply(ctx.store, ctx.outbox, { message: ctx.first, member: "codex", text: "cache it in memory" });
    assert.deepEqual(out, { state: "answer_2", round: 0, flag: null });

    const second = msgs(ctx.store).at(-1);
    assert.deepEqual(JSON.parse(second.recipients), ["fable"]);
    assert.equal(second.content.includes("cache it in memory"), false, "the second deliberator must not see the first answer");
    assert.equal(second.content, blindPrompt("q"), "round one stays blind: the question and nothing else");
    assert.equal(second.kind, "deliberate");
    assert.equal(second.idempotency_key, deliberationKey(ctx.id, "answer_2", 0, "fable"));
    assert.equal(second.sender, "codex", "engine packets carry the member whose reply produced them, never owner (plan Decision 2 / Task 12)");
    assert.equal(second.parent_id, ctx.first.id, "linked to the packet that was answered");
    assert.equal(msgs(ctx.store).length, 2);

    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "answer_2");
    assert.equal(row.round, 0);
    assert.equal(answersOf(ctx.store, ctx.id).codex, "cache it in memory");
  }));

  it("the second blind answer opens debate round 1: both deliberators get both answers, labelled, with the verdict protocol", () => withDelib((ctx) => {
    toDebate(ctx);
    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "debate");
    assert.equal(row.round, 1);
    const all = msgs(ctx.store);
    assert.equal(all.length, 4, "1 blind + 1 blind + 2 debate packets");
    const debate = all.slice(2);
    assert.deepEqual(debate.map((m) => JSON.parse(m.recipients)[0]).sort(), ["codex", "fable"]);
    for (const m of debate) {
      assert.equal(m.content, debatePrompt("q", { codex: "A", fable: "B" }, 1));
      assert.match(m.content, /--- codex ---\nA\n/);
      assert.match(m.content, /--- fable ---\nB\n/);
      assert.match(m.content, /round 1 of 3/);
      assert.match(m.content, /AGREE: <the answer you both now hold>/);
      assert.equal(m.sender, "fable", "fable's answer completed the blind phase");
      assert.equal(m.idempotency_key, deliberationKey(ctx.id, "debate", 1, JSON.parse(m.recipients)[0]));
    }
    const a = answersOf(ctx.store, ctx.id);
    assert.deepEqual({ codex: a.codex, fable: a.fable, __verdicts: a.__verdicts }, { codex: "A", fable: "B", __verdicts: {} });
  }));

  it("both AGREE in round 1 settles to pending_owner", () => withDelib((ctx) => {
    toDebate(ctx);
    const half = reply(ctx, "codex", "fine by me\nAGREE: cache it");
    assert.deepEqual(half, { state: "debate", round: 1, flag: null }, "waiting for the other verdict");
    assert.equal(msgs(ctx.store).length, 4, "no new packets while waiting");
    const done = reply(ctx, "fable", "yes\nAGREE: cache it");
    assert.deepEqual(done, { state: "pending_owner", round: 1, flag: "agreed" });
    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "pending_owner");
    assert.equal(row.flag, "agreed");
    assert.equal(row.final_answer, "cache it");
    assert.equal(msgs(ctx.store).length, 4, "nothing more is sent once it is in the Black Seat");
    assert.deepEqual(answersOf(ctx.store, ctx.id).__verdicts, { codex: "AGREE", fable: "AGREE" });
  }));

  it("ESCALATE short-circuits straight to pending_owner; no answer is proposed, the reason is kept", () => withDelib((ctx) => {
    toDebate(ctx);
    const out = reply(ctx, "codex", "ESCALATE: this would delete data");
    assert.deepEqual(out, { state: "pending_owner", round: 1, flag: "escalated" });
    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "pending_owner");
    assert.equal(row.flag, "escalated");
    assert.equal(row.final_answer, null, "an escalation reason is not an answer for the owner to approve");
    assert.deepEqual(answersOf(ctx.store, ctx.id).__escalation, { member: "codex", body: "this would delete data", round: 1 });
    assert.equal(msgs(ctx.store).length, 4);
    // fable's late reply to the same round is ignored: the row is already with the owner.
    assert.equal(reply(ctx, "fable", "AGREE: whatever"), null);
    assert.equal(rowOf(ctx.store, ctx.id).flag, "escalated");
  }));

  it("DISAGREE opens the next round with fresh verdicts and new packets; three rounds without agreement is a deadlock", () => withDelib((ctx) => {
    toDebate(ctx);
    // round 1
    reply(ctx, "codex", "no\nDISAGREE: too slow");
    let out = reply(ctx, "fable", "AGREE: cache it");
    assert.deepEqual(out, { state: "debate", round: 2, flag: null }, "one AGREE is not agreement");
    assert.equal(msgs(ctx.store).length, 6);
    const r2 = latestTo(ctx.store, "codex");
    assert.match(r2.content, /round 2 of 3/);
    assert.match(r2.content, /--- codex ---\nno\nDISAGREE: too slow/, "round 2 shows the latest replies, verdict lines included");
    assert.equal(r2.idempotency_key, deliberationKey(ctx.id, "debate", 2, "codex"));
    assert.deepEqual(answersOf(ctx.store, ctx.id).__verdicts, {}, "fresh verdicts each round");
    // round 2
    reply(ctx, "codex", "DISAGREE: still slow");
    out = reply(ctx, "fable", "DISAGREE: fine, then no");
    assert.deepEqual(out, { state: "debate", round: 3, flag: null });
    assert.equal(msgs(ctx.store).length, 8);
    // round 3 — the cap
    reply(ctx, "codex", "DISAGREE: no");
    out = reply(ctx, "fable", "DISAGREE: no");
    assert.deepEqual(out, { state: "pending_owner", round: 3, flag: "deadlock" });
    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "pending_owner");
    assert.equal(row.flag, "deadlock");
    assert.equal(row.final_answer, null);
    assert.equal(row.round, 3);
    assert.equal(msgs(ctx.store).length, 8, "no round 4");
    assert.equal(MAX_ROUNDS, 3);
  }));

  it("a malformed verdict line counts as DISAGREE, never as agreement", () => withDelib((ctx) => {
    toDebate(ctx);
    reply(ctx, "codex", "AGREE: cache it");
    const out = reply(ctx, "fable", "Sounds good, agree: cache it");
    assert.deepEqual(out, { state: "debate", round: 2, flag: null });
    assert.equal(rowOf(ctx.store, ctx.id).state, "debate");
  }));

  it("the blind answers survive in __history after debate replies overwrite the latest text", () => withDelib((ctx) => {
    toDebate(ctx);
    reply(ctx, "codex", "AGREE: cache it");
    reply(ctx, "fable", "AGREE: cache it");
    const a = answersOf(ctx.store, ctx.id);
    assert.equal(a.codex, "AGREE: cache it", "latest text per member, as the plan's shape has it");
    assert.deepEqual(
      a.__history.map((h) => [h.state, h.round, h.member, h.text, h.verdict ?? null]),
      [
        ["answer_1", 0, "codex", "A", null],
        ["answer_2", 0, "fable", "B", null],
        ["debate", 1, "codex", "AGREE: cache it", "AGREE"],
        ["debate", 1, "fable", "AGREE: cache it", "AGREE"],
      ]
    );
  }));

  it("stale, misrouted and duplicate replies are ignored without writing", () => withDelib((ctx) => {
    // Not a deliberation message at all.
    assert.equal(advanceOnReply(ctx.store, ctx.outbox, { message: { idempotency_key: "owner-say:1" }, member: "codex", text: "x" }), null);
    assert.equal(advanceOnReply(ctx.store, ctx.outbox, { message: null, member: "codex", text: "x" }), null);
    // Wrong member answering the first packet.
    assert.equal(advanceOnReply(ctx.store, ctx.outbox, { message: ctx.first, member: "fable", text: "x" }), null);
    assert.equal(rowOf(ctx.store, ctx.id).state, "answer_1");
    const before = ctx.store.getEvents().length;
    toDebate(ctx);
    // A late re-delivery of the answer_1 packet after the row has moved on.
    assert.equal(advanceOnReply(ctx.store, ctx.outbox, { message: ctx.first, member: "codex", text: "again" }), null);
    assert.equal(rowOf(ctx.store, ctx.id).round, 1);
    assert.equal(answersOf(ctx.store, ctx.id).codex, "A");
    // Duplicate verdict from the same member in the same round: idempotent.
    reply(ctx, "codex", "AGREE: cache it");
    const evBefore = ctx.store.getEvents().length;
    const dup = reply(ctx, "codex", "DISAGREE: changed my mind");
    assert.deepEqual(dup, { state: "debate", round: 1, flag: null });
    assert.equal(ctx.store.getEvents().length, evBefore, "no write for a duplicate");
    assert.equal(answersOf(ctx.store, ctx.id).__verdicts.codex, "AGREE", "first verdict stands");
    assert.ok(ctx.store.getEvents().length > before);
  }));

  it("terminal and owner-held states ignore replies", () => withDelib((ctx) => {
    toDebate(ctx);
    reply(ctx, "codex", "AGREE: x");
    reply(ctx, "fable", "AGREE: x");
    assert.equal(rowOf(ctx.store, ctx.id).state, "pending_owner");
    assert.equal(reply(ctx, "codex", "DISAGREE: wait"), null);
    for (const state of ["settled", "overruled", "abandoned", "stalled"]) {
      ctx.store.prepare("UPDATE deliberations SET state = ? WHERE id = ?").run(state, ctx.id);
      assert.equal(reply(ctx, "codex", "AGREE: x"), null, state);
    }
  }));

  it("findDeliberationFor resolves from the claimed message's key; parseDeliberationKey is strict", () => withDelib((ctx) => {
    assert.equal(findDeliberationFor(ctx.store, ctx.first).id, ctx.id);
    assert.equal(findDeliberationFor(ctx.store, { idempotency_key: "delib:nope:answer_1:0:codex" }), null);
    assert.equal(findDeliberationFor(ctx.store, { idempotency_key: "owner-say:x" }), null);
    assert.equal(findDeliberationFor(ctx.store, null), null);
    assert.deepEqual(parseDeliberationKey("delib:d1:debate:2:fable"), { id: "d1", state: "debate", round: 2, member: "fable" });
    assert.equal(parseDeliberationKey("delib:d1:debate"), null);
    assert.equal(parseDeliberationKey("delib:d1:debate:x:fable"), null);
    assert.equal(parseDeliberationKey(42), null);
  }));

  it("every transition is one deliberation_advanced event and the chain verifies; no model run is ever recorded here", () => withDelib((ctx) => {
    toDebate(ctx);
    reply(ctx, "codex", "AGREE: x");
    reply(ctx, "fable", "AGREE: x");
    const adv = events(ctx.store, "deliberation_advanced");
    assert.equal(adv.length, 4, "answer_1->answer_2, answer_2->debate, half-round, agreed");
    assert.deepEqual(adv.map((e) => JSON.parse(e.payload).state ?? null), ["answer_2", "debate", null, "pending_owner"]);
    assert.ok(adv.every((e) => e.actor === "dispatcher" && e.ref_id === ctx.id));
    assert.equal(ctx.store.verifyChain().ok, true);
    assert.equal(ctx.store.prepare("SELECT COUNT(*) AS c FROM runs").get().c, 0);
  }));

  it("abandon marks the row and records why; terminal rows are left alone", () => withDelib((ctx) => {
    const out = abandon(ctx.store, ctx.id, "halt");
    assert.deepEqual(out, { id: ctx.id, reason: "halt", changed: true });
    const row = rowOf(ctx.store, ctx.id);
    assert.equal(row.state, "abandoned");
    assert.equal(row.flag, "halt");
    const ev = events(ctx.store, "deliberation_abandoned");
    assert.equal(ev.length, 1);
    assert.deepEqual(JSON.parse(ev[0].payload), { abandoned: "halt" });
    assert.deepEqual(abandon(ctx.store, ctx.id, "again"), { id: ctx.id, reason: "again", changed: false });
    assert.equal(rowOf(ctx.store, ctx.id).flag, "halt", "first reason stands");
    for (const state of ["settled", "overruled"]) {
      ctx.store.prepare("UPDATE deliberations SET state = ?, flag = NULL WHERE id = ?").run(state, ctx.id);
      assert.equal(abandon(ctx.store, ctx.id, "halt").changed, false, state);
      assert.equal(rowOf(ctx.store, ctx.id).state, state);
    }
    // pending_owner may still be cancelled by the owner.
    ctx.store.prepare("UPDATE deliberations SET state = 'pending_owner' WHERE id = ?").run(ctx.id);
    assert.equal(abandon(ctx.store, ctx.id, "owner_cancel").changed, true);
  }));
});

describe("scriptedReply", () => {
  const LIMITS = {
    daily_ceiling: { codex: 100, fable: 100, anthropic: 100 },
    timeout_ms: { codex: 3000, fable: 3000, fake: 3000 },
    dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, { timeout = 6000, every = 40 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = fn();
      if (last) return last;
      await sleep(every);
    }
    throw new Error("timeout; last=" + JSON.stringify(last));
  }
  async function withDispatcher(extra, fn) {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home, useFake: true, members: ["codex", "fable"], tickMs: 40, timeoutMs: 3000, defaultRespond: true, limits: LIMITS, ...extra,
    });
    try {
      return await fn(d);
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  }
  const replyFrom = (d, member) => d.store.prepare("SELECT * FROM messages WHERE sender = ? ORDER BY created DESC").get(member);

  it("overrides the fake's reply text per member", async () => {
    const seen = [];
    await withDispatcher({ scriptedReply: (member) => { seen.push(member); return `AGREE: from ${member}`; } }, async (d) => {
      d.outbox.send({ sender: "owner", recipients: ["codex"], chamber_id: "c1", kind: "say", content: "hi", idempotency_key: "k1" });
      d.start();
      const msg = await waitFor(() => replyFrom(d, "codex"));
      assert.ok(seen.includes("codex"), "scriptedReply must be consulted");
      assert.match(msg.content, /AGREE: from codex/);
      assert.doesNotMatch(msg.content, /fake-ok/, "the fake's own text is replaced, not appended");
    });
  });

  it("returning null falls through to the adapter's real finalText", async () => {
    await withDispatcher({ scriptedReply: () => null }, async (d) => {
      d.outbox.send({ sender: "owner", recipients: ["codex"], chamber_id: "c1", kind: "say", content: "hi", idempotency_key: "k1" });
      d.start();
      const msg = await waitFor(() => replyFrom(d, "codex"));
      assert.match(msg.content, /fake-ok mode=echo/);
    });
  });

  it("receives (member, claimed message, run result) so a script can vary by packet and round", async () => {
    const calls = [];
    await withDispatcher({
      scriptedReply: (member, message, result) => {
        calls.push({ member, key: message.idempotency_key, content: message.content, exit: result.exit, hasStdout: typeof result.stdout === "string" });
        return message.idempotency_key === "k-fable" ? "DISAGREE: from fable" : "AGREE: from codex";
      },
    }, async (d) => {
      d.outbox.send({ sender: "owner", recipients: ["codex"], chamber_id: "c1", kind: "deliberate", content: "packet one", idempotency_key: "k-codex" });
      d.outbox.send({ sender: "owner", recipients: ["fable"], chamber_id: "c1", kind: "deliberate", content: "packet two", idempotency_key: "k-fable" });
      d.start();
      await waitFor(() => replyFrom(d, "codex") && replyFrom(d, "fable"));
      const byMember = Object.fromEntries(calls.map((c) => [c.member, c]));
      assert.deepEqual(byMember.codex, { member: "codex", key: "k-codex", content: "packet one", exit: 0, hasStdout: true });
      assert.deepEqual(byMember.fable, { member: "fable", key: "k-fable", content: "packet two", exit: 0, hasStdout: true });
      assert.match(replyFrom(d, "codex").content, /AGREE: from codex/);
      assert.match(replyFrom(d, "fable").content, /DISAGREE: from fable/, "the fable seat runs through the fake and is scripted too");
      // A real model run happened for each (the fake), recorded against the seat id.
      const runs = d.store.prepare("SELECT member, exit FROM runs ORDER BY started").all().map((r) => [r.member, r.exit]).sort();
      assert.deepEqual(runs, [["codex", 0], ["fable", 0]]);
    });
  });

  it("without the seam, behaviour is unchanged", async () => {
    await withDispatcher({}, async (d) => {
      d.outbox.send({ sender: "owner", recipients: ["codex"], chamber_id: "c1", kind: "say", content: "hi", idempotency_key: "k1" });
      d.start();
      const msg = await waitFor(() => replyFrom(d, "codex"));
      assert.match(msg.content, /fake-ok mode=echo/);
    });
  });
});

describe("dispatcher hooks", () => {
  const LIMITS = {
    daily_ceiling: { codex: 100, fable: 100, anthropic: 100 },
    timeout_ms: { codex: 3000, fable: 3000, fake: 3000 },
    dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, { timeout = 8000, every = 40, label = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = fn();
      if (last) return last;
      await sleep(every);
    }
    throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
  }
  async function withDispatcher(extra, fn) {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home, useFake: true, members: ["codex", "fable"], tickMs: 40, timeoutMs: 3000, defaultRespond: true, limits: LIMITS, ...extra,
    });
    try {
      return await fn(d);
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  }
  const rowOf = (d, id) => d.store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
  const start = (d, q = "cache the chain?") =>
    startDeliberation(d.store, d.outbox, { chamber_id: "c1", question: q, deliberators: ["codex", "fable"], limits: LIMITS });

  it("drives a whole deliberation to pending_owner on agreement", async () => {
    const packets = [];
    await withDispatcher({
      scriptedReply: (member, message) => {
        packets.push({ member, key: message.idempotency_key, content: message.content });
        return /debate round/i.test(String(message?.content || "")) ? "looks right\nAGREE: cache it" : `my independent answer from ${member}`;
      },
    }, async (d) => {
      const r = start(d);
      d.start();
      const row = await waitFor(() => { const x = rowOf(d, r.id); return x.state === "pending_owner" ? x : null; }, { label: "pending_owner" });
      assert.equal(row.flag, "agreed");
      assert.equal(row.final_answer, "cache it");
      assert.equal(row.round, 1);

      // Four runs, one per packet, in engine order; blindness held on the wire.
      const keys = packets.map((p) => p.key);
      assert.deepEqual(keys, [
        deliberationKey(r.id, "answer_1", 0, "codex"),
        deliberationKey(r.id, "answer_2", 0, "fable"),
        deliberationKey(r.id, "debate", 1, "codex"),
        deliberationKey(r.id, "debate", 1, "fable"),
      ].slice(0, 2).concat(keys.slice(2).sort((a, b) => a.localeCompare(b))));
      assert.equal(packets[1].content.includes("my independent answer from codex"), false, "fable's blind packet must not carry codex's answer");
      assert.match(packets[2].content, /my independent answer from codex/);
      assert.match(packets[2].content, /my independent answer from fable/);
      assert.equal(d.store.prepare("SELECT COUNT(*) AS c FROM runs").get().c, 4, "exactly 4 model runs for agreement in round 1");
      assert.equal(d.store.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE status = 'answered'").get().c, 4);
      assert.equal(d.store.verifyChain().ok, true);
      assert.equal(d.presence.codex.state, "idle");
      assert.equal(d.presence.fable.state, "idle");
    });
  });

  it("a failed run stalls the deliberation with the provider's own words, and the row keeps everything", async () => {
    await withDispatcher({ env: { FAKE_MODE: "fail-nonzero" } }, async (d) => {
      const r = start(d);
      d.start();
      const row = await waitFor(() => { const x = rowOf(d, r.id); return x.state === "stalled" ? x : null; }, { label: "stalled" });
      assert.equal(row.flag, "exit_1");
      const detail = JSON.parse(row.stall_detail);
      assert.equal(detail.member, "codex");
      assert.equal(detail.reason, "exit_1");
      assert.equal(detail.exit, 1);
      assert.match(detail.stderr, /bridge boom/, "provider stderr is kept verbatim");
      assert.match(detail.stdout, /fail-nonzero/);
      assert.equal(detail.from_state, "answer_1");
      assert.equal(detail.from_round, 0);
      assert.equal(row.question, "cache the chain?");
      assert.deepEqual(JSON.parse(row.deliberators), ["codex", "fable"]);
      const ev = d.store.getEvents().filter((e) => e.kind === "deliberation_stalled");
      assert.ok(ev.length >= 1);
      assert.equal(ev[0].actor, "codex");
      assert.equal(d.store.prepare("SELECT COUNT(*) AS c FROM deliberations WHERE state = 'abandoned'").get().c, 0, "never abandoned on a run failure");
    });
  });

  it("a budget refusal stalls too, and spends nothing", async () => {
    // Dispatcher enforces codex: 0 while the deliberation was opened under generous limits.
    const tight = { ...LIMITS, daily_ceiling: { codex: 0, fable: 100, anthropic: 100 } };
    await withDispatcher({ limits: tight }, async (d) => {
      const r = start(d);
      d.start();
      const row = await waitFor(() => { const x = rowOf(d, r.id); return x.state === "stalled" ? x : null; }, { label: "stalled on BUDGET" });
      assert.match(row.flag, /^BUDGET: codex has used 0\/0/);
      const spawned = d.store.prepare("SELECT COUNT(*) AS c FROM runs WHERE checkpoint IS NULL OR checkpoint NOT LIKE '%refused%'").get().c;
      assert.equal(spawned, 0, "no process was spawned");
      assert.equal(d.presence.codex.state, "blocked");
    });
  });

  it("a stalled deliberation self-heals when the retried packet finally succeeds", () => withStore((store) => {
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, { chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS });
      const packet = store.prepare("SELECT * FROM messages").get();
      stall(store, r.id, { member: "codex", reason: "exit_1", stderr: "usage limit reached", from_state: "answer_1", from_round: 0 });
      assert.equal(rowOf({ store }, r.id).state, "stalled");
      // The dispatcher keeps retrying the expired lease; one day the run succeeds.
      const out = advanceOnReply(store, outbox, { message: packet, member: "codex", text: "A" });
      assert.deepEqual(out, { state: "answer_2", round: 0, flag: null });
      const row = rowOf({ store }, r.id);
      assert.equal(row.state, "answer_2");
      assert.equal(row.flag, null);
      assert.equal(row.stall_detail, null, "the stall is cleared once the row moves on");
      assert.equal(store.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 2, "fable's blind packet went out");
      // A reply for a state the row was NOT stalled in is still ignored.
      stall(store, r.id, { member: "fable", reason: "exit_1", from_state: "answer_2", from_round: 0 });
      assert.equal(advanceOnReply(store, outbox, { message: packet, member: "codex", text: "again" }), null);
      assert.equal(rowOf({ store }, r.id).state, "stalled");
    } finally { try { outbox.close(); } catch { /* */ } }
  }));

  it("stall only touches live rows and records from_state; abandon and stall are distinct events", () => withStore((store) => {
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, { chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS });
      const out = stall(store, r.id, { member: "codex", reason: "timed_out" });
      assert.deepEqual(out, { id: r.id, stalled: true });
      let row = rowOf({ store }, r.id);
      assert.equal(row.state, "stalled");
      assert.equal(row.flag, "timed_out");
      const detail = JSON.parse(row.stall_detail);
      assert.equal(detail.from_state, "answer_1", "from_state is filled in from the row when the caller omits it");
      assert.equal(detail.from_round, 0);
      // Stalling an already-stalled or closed row is a no-op.
      assert.deepEqual(stall(store, r.id, { member: "codex", reason: "again" }), { id: r.id, stalled: false });
      assert.equal(rowOf({ store }, r.id).flag, "timed_out");
      store.prepare("UPDATE deliberations SET state = 'pending_owner', flag = 'agreed', stall_detail = NULL WHERE id = ?").run(r.id);
      assert.equal(stall(store, r.id, { reason: "x" }).stalled, false);
      row = rowOf({ store }, r.id);
      assert.equal(row.state, "pending_owner");
      assert.equal(row.stall_detail, null);
      // Reason defaults; actor defaults to dispatcher.
      store.prepare("UPDATE deliberations SET state = 'debate', round = 2 WHERE id = ?").run(r.id);
      stall(store, r.id, {});
      row = rowOf({ store }, r.id);
      assert.equal(row.flag, "run_failed");
      assert.equal(JSON.parse(row.stall_detail).from_round, 2);
      const ev = store.getEvents().filter((e) => e.kind === "deliberation_stalled");
      assert.equal(ev.at(-1).actor, "dispatcher");
    } finally { try { outbox.close(); } catch { /* */ } }
  }));

  it("abandons an in-flight deliberation when HALT appears; stalled rows are abandoned too, closed rows are not", async () => {
    await withDispatcher({}, async (d) => {
      const live = start(d, "q1");
      const stalled = start(d, "q2");
      stall(d.store, stalled.id, { member: "codex", reason: "exit_1" });
      const settled = start(d, "q3");
      d.store.prepare("UPDATE deliberations SET state = 'pending_owner', flag = 'agreed' WHERE id = ?").run(settled.id);
      writeFileSync(d.haltPath(), new Date().toISOString());
      d.start();
      const row = await waitFor(() => { const x = rowOf(d, live.id); return x.state === "abandoned" ? x : null; }, { label: "abandoned" });
      assert.equal(row.flag, "halt");
      assert.equal(rowOf(d, stalled.id).state, "abandoned", "HALT is the owner's stop; a stalled row is abandoned like a live one");
      assert.equal(rowOf(d, settled.id).state, "pending_owner", "rows already with the owner are left alone");
      assert.equal(d.store.prepare("SELECT COUNT(*) AS c FROM runs").get().c, 0, "HALT spends nothing");
      const ev = d.store.getEvents().filter((e) => e.kind === "deliberation_abandoned");
      assert.equal(ev.length, 2, "one event per abandoned row, not one per tick");
    });
  });

  it("a throwing hook is recorded and never leaves presence stuck", async () => {
    await withDispatcher({}, async (d) => {
      start(d);
      // Sabotage: the hook's lookup will throw "no such table"; the run itself is fine.
      d.store.exec("ALTER TABLE deliberations RENAME TO deliberations_gone");
      d.start();
      const ev = await waitFor(() => d.store.getEvents().find((e) => e.kind === "deliberation_hook_failed"), { label: "hook_failed event" });
      assert.match(JSON.parse(ev.payload).error, /no such table/);
      assert.equal(ev.actor, "codex");
      await waitFor(() => d.presence.codex.state === "idle", { label: "presence idle" });
      assert.equal(d.store.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE status = 'answered'").get().c, 1, "the reply itself was still acked");
    });
  });
});
