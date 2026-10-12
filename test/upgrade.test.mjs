import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, eventHash, GENESIS } from "../src/store.mjs";
import { loadOrCreateTokens, identityFromToken } from "../src/tokens.mjs";
import { seatIds } from "../src/seats.mjs";
import { startWorkOrder } from "../src/work-orders.mjs";

test("a Phase 2 database upgrades without losing its messages, credentials, or verified record", () => {
  const home = mkdtempSync(join(tmpdir(), "council-upgrade-"));
  const dbPath = join(home, "council.db");
  let oldDb, store;
  try {
    // Build the historical schema directly, so this is a real migration test
    // rather than reopening a database that already has the latest schema.
    oldDb = new DatabaseSync(dbPath);
    oldDb.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied TEXT NOT NULL)");
    const created = "2026-09-14T11:47:34.343Z";
    for (const name of ["001_init.sql", "002_messages_chain.sql"]) {
      oldDb.exec(readFileSync(new URL("../src/migrations/" + name, import.meta.url), "utf8"));
      oldDb.prepare("INSERT INTO schema_migrations(name,applied) VALUES(?,?)").run(name, created);
    }
    for (const member of ["codex", "grok", "claude"]) oldDb.prepare("INSERT INTO members VALUES(?,?,?,?)").run(member, "cli", member, created);
    oldDb.prepare("INSERT INTO chambers VALUES(?,?,?,?)").run("old-chamber", "Original Council", created, "open");
    oldDb.prepare("INSERT INTO messages(id,chamber_id,sender,recipients,kind,parent_id,content,idempotency_key,created,chain,chain_hop) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("old-plan", "old-chamber", "owner", '["codex"]', "say", null, "Plan a CLI", "old-request", created, '["codex","grok","codex"]', 1);
    oldDb.prepare("INSERT INTO messages(id,chamber_id,sender,recipients,kind,parent_id,content,idempotency_key,created) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("old-review", "old-chamber", "codex", '["grok"]', "relay", "old-plan", "Preserve this review", "old-reply", created);
    oldDb.prepare("INSERT INTO deliveries(message_id,recipient,status,attempt_gen,updated) VALUES(?,?,?,?,?)").run("old-plan", "codex", "answered", 1, created);
    oldDb.prepare("INSERT INTO deliveries(message_id,recipient,status,attempt_gen,updated) VALUES(?,?,?,?,?)").run("old-review", "grok", "pending", 0, created);
    oldDb.prepare("INSERT INTO sessions(member,chamber_id,provider_session_id,lease_gen,resume_kind,updated) VALUES(?,?,?,?,?,?)")
      .run("codex", "old-chamber", "fixture-provider-session", 1, "resume", created);

    let previous = GENESIS;
    for (const [index, id] of ["old-plan", "old-review"].entries()) {
      const event = { seq: index + 1, ts: created, kind: "message_sent", actor: index ? "codex" : "owner", ref_table: "messages", ref_id: id, payload: JSON.stringify({ fixture: true }) };
      const hash = eventHash(event, previous);
      oldDb.prepare("INSERT INTO events(seq,ts,kind,actor,ref_table,ref_id,payload,hash,prev_hash) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(event.seq, event.ts, event.kind, event.actor, event.ref_table, event.ref_id, event.payload, hash, previous);
      previous = hash;
    }
    const snapshot = {
      messages: oldDb.prepare("SELECT rowid AS sequence,* FROM messages ORDER BY rowid").all(),
      deliveries: oldDb.prepare("SELECT * FROM deliveries ORDER BY id").all(),
      sessions: oldDb.prepare("SELECT * FROM sessions").all(),
      events: oldDb.prepare("SELECT * FROM events ORDER BY seq").all(),
    };
    oldDb.close(); oldDb = null;
    const fixtureTokens = { owner: "fixture-owner-token", members: { codex: "fixture-codex-token", grok: "fixture-grok-token", claude: "fixture-claude-token" }, created };
    writeFileSync(join(home, "tokens.json"), JSON.stringify(fixtureTokens));

    store = openStore({ home });
    assert.deepEqual(store.prepare("SELECT rowid AS sequence,* FROM messages ORDER BY rowid").all(), snapshot.messages);
    assert.deepEqual(store.prepare("SELECT * FROM deliveries ORDER BY id").all(), snapshot.deliveries);
    assert.deepEqual(store.prepare("SELECT * FROM sessions").all(), snapshot.sessions);
    assert.deepEqual(store.getEvents(), snapshot.events);
    assert.deepEqual(store.verifyChain(), { ok: true, count: 2 });
    assert.deepEqual(store.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map(row => row.name), ["001_init.sql", "002_messages_chain.sql", "003_deliberations.sql", "004_work_orders.sql", "005_work_review.sql"]);

    const upgradedTokens = loadOrCreateTokens(home);
    assert.equal(upgradedTokens.owner, fixtureTokens.owner);
    assert.equal(upgradedTokens.created, created);
    for (const [member, token] of Object.entries(fixtureTokens.members)) {
      assert.equal(upgradedTokens.members[member], token);
      assert.deepEqual(identityFromToken(upgradedTokens, token), { role: "member", member });
    }
    assert.deepEqual(identityFromToken(upgradedTokens, fixtureTokens.owner), { role: "owner", member: "owner" });
    assert.deepEqual(Object.keys(upgradedTokens.members).sort(), [...seatIds()].sort());

    const work = startWorkOrder(store, { objective: "Plan fixture work after upgrade", workspace: home, planner: "codex", worker: "codex", idempotency_key: "upgrade-work-order" });
    assert.equal(work.ok, true);
    assert.equal(store.prepare("SELECT revision FROM work_orders WHERE id=?").get(work.id).revision, 0);
    assert.equal(store.verifyChain().ok, true);
    store.close(); store = openStore({ home });
    assert.equal(store.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 5);
    assert.deepEqual(store.getEvents().slice(0, 2), snapshot.events);
    assert.equal(store.verifyChain().ok, true);
    assert.deepEqual(loadOrCreateTokens(home), upgradedTokens);
  } finally {
    store?.close(); oldDb?.close(); rmSync(home, { recursive: true, force: true });
  }
});
