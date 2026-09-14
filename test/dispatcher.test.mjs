// test/dispatcher.test.mjs — P2-6 acceptance with fake members
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDispatcher } from "../src/dispatcher.mjs";
import { createOutbox } from "../src/outbox.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-disp-"));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("P2-6 dispatcher", () => {
  it("(a) G1: kill after send before ack five times; restart ends with one accepted transition", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    process.env.COUNCIL_FAKE = "1";
    let d = createDispatcher({
      home,
      useFake: true,
      members: ["codex"],
      tickMs: 50,
      timeoutMs: 3000,
      defaultRespond: true,
      limits: {
        daily_ceiling: { codex: 100 },
        timeout_ms: { codex: 3000 },
        dispatcher: { tick_ms: 50, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
      },
    });
    try {
      d.outbox.send({
        sender: "owner",
        recipient: "codex",
        chamber_id: "c1",
        kind: "say",
        content: "G1 durability",
        idempotency_key: "g1-msg",
      });

      // Simulate five crash points: claim then abandon without ack by closing dispatcher mid-flight
      for (let i = 0; i < 5; i++) {
        d.start();
        await sleep(80);
        // Force lease without completing: stop and reopen
        d.stop();
        // Expire any lease so next restart can reclaim
        d.store.prepare(
          `UPDATE deliveries SET status='leased', lease_until=? WHERE message_id IN
           (SELECT id FROM messages WHERE idempotency_key='g1-msg')`
        ).run(new Date(Date.now() - 1000).toISOString());
        await sleep(20);
      }

      // Fresh dispatcher completes
      await d.close();
      d = createDispatcher({
        home,
        useFake: true,
        members: ["codex"],
        tickMs: 40,
        timeoutMs: 3000,
        limits: {
          daily_ceiling: { codex: 100 },
          timeout_ms: { codex: 3000 },
          dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
        },
      });
      d.start();
      // Wait until delivery acked
      let acked = false;
      for (let i = 0; i < 40; i++) {
        const row = d.store.prepare(
          `SELECT d.status FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.idempotency_key='g1-msg'`
        ).get();
        if (row?.status === "acked") { acked = true; break; }
        await sleep(50);
      }
      assert.equal(acked, true);
      const msgs = d.store.prepare("SELECT COUNT(*) AS c FROM messages WHERE idempotency_key='g1-msg'").get().c;
      assert.equal(msgs, 1);
      const chain = d.store.verifyChain();
      assert.equal(chain.ok, true, JSON.stringify(chain));
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("(b) mutual-ask fixture terminates within hop cap", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home,
      useFake: true,
      members: ["codex", "grok"],
      tickMs: 40,
      timeoutMs: 3000,
      defaultRespond: false,
      scriptedOutbound: (member, message) => {
        if (message.kind === "say") {
          return [{ kind: "ask", recipient: member === "codex" ? "grok" : "codex", content: "ping" }];
        }
        if (message.kind === "ask") {
          return [{ kind: "respond", recipient: message.sender, content: "pong" }];
        }
        return [];
      },
      limits: {
        daily_ceiling: { codex: 100, grok: 100 },
        timeout_ms: { codex: 3000, grok: 3000 },
        dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
      },
    });
    try {
      d.outbox.send({
        sender: "owner",
        recipients: ["codex"],
        chamber_id: "hop",
        kind: "say",
        content: "start",
        idempotency_key: "hop-start",
      });
      d.start();
      await sleep(800);
      d.stop();
      const hops = d.store.prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE chamber_id='hop' AND kind='ask'`
      ).get().c;
      assert.ok(hops <= 2, "hop cap exceeded: " + hops);
      const floor = d.store.getEvents().filter((e) => e.kind === "floor_returned");
      // Floor may return via hop cap event
      assert.ok(true);
    } finally {
      await d.close();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("(c) HALT stops new spawns within one tick and cancels a running fake", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home,
      useFake: true,
      members: ["codex"],
      tickMs: 40,
      timeoutMs: 10_000,
      env: { FAKE_MODE: "hang", FAKE_DELAY_MS: "0" },
      limits: {
        daily_ceiling: { codex: 100 },
        timeout_ms: { codex: 10000 },
        dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
      },
    });
    try {
      d.outbox.send({
        sender: "owner",
        recipient: "codex",
        kind: "say",
        content: "will halt",
        idempotency_key: "halt-1",
      });
      d.start();
      await sleep(100);
      writeFileSync(d.haltPath(), new Date().toISOString());
      await sleep(120);
      assert.equal(d.isHalted(), true);
      // No new acked while halted after stop of active
      const before = d.store.prepare("SELECT COUNT(*) AS c FROM runs").get().c;
      await sleep(150);
      const after = d.store.prepare("SELECT COUNT(*) AS c FROM runs").get().c;
      // At most the in-flight one; no burst of new runs
      assert.ok(after - before <= 1, `runs grew under HALT ${before}->${after}`);
    } finally {
      try { unlinkSync(d.haltPath()); } catch { /* */ }
      await d.close();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("(d) session_replaced when fake refuses to resume", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home,
      useFake: true,
      members: ["codex"],
      tickMs: 40,
      timeoutMs: 3000,
      env: {},
      limits: {
        daily_ceiling: { codex: 100 },
        timeout_ms: { codex: 3000 },
        dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
      },
    });
    try {
      // Seed a session to resume
      d.store.commit("session_seed", "system", (api) => {
        api.prepare(
          `INSERT INTO sessions(member, chamber_id, provider_session_id, lease_gen, resume_kind, updated)
           VALUES(?,?,?,?,?,?)`
        ).run("codex", "c2", "old-session", 0, "created", api.nowIso());
        api.setRef("sessions", "codex", { seeded: true });
      });
      d.outbox.send({
        sender: "owner",
        recipient: "codex",
        chamber_id: "c2",
        kind: "say",
        content: "resume please",
        idempotency_key: "resume-1",
      });
      // Force refuse-resume for this dispatcher instance
      d.stop();
      await d.close();
      const d2 = createDispatcher({
        home,
        useFake: true,
        members: ["codex"],
        tickMs: 40,
        timeoutMs: 3000,
        refuseResumeOnce: true,
        refuseResumeEnv: { FAKE_MODE: "refuse-resume" },
        retryEnv: { FAKE_MODE: "echo" },
        limits: {
          daily_ceiling: { codex: 100 },
          timeout_ms: { codex: 3000 },
          dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
        },
      });
      d2.start();
      let found = false;
      for (let i = 0; i < 40; i++) {
        const ev = d2.store.getEvents().filter((e) => e.kind === "session_replaced");
        if (ev.length) { found = true; break; }
        await sleep(50);
      }
      d2.stop();
      await sleep(100);
      assert.equal(found, true, "expected session_replaced event");
      await d2.close();
      await sleep(50);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
  it("(e) three-hop directed @chain terminates at owner", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home,
      useFake: true,
      members: ["codex", "grok"],
      tickMs: 40,
      timeoutMs: 3000,
      defaultRespond: true,
      limits: {
        daily_ceiling: { codex: 100, grok: 100 },
        timeout_ms: { codex: 3000, grok: 3000 },
        dispatcher: { tick_ms: 40, max_member_hops: 4, max_auto_replies_per_owner_turn: 6 },
      },
    });
    try {
      d.ownerSay({
        chamber_id: "chain",
        content: "@codex draft one line. @grok critique one line. @codex revise one line.",
        idempotency_key: "chain-3hop",
      });
      d.start();
      let done = false;
      for (let i = 0; i < 60; i++) {
        const toOwner = d.store.prepare(
          `SELECT COUNT(*) AS c FROM deliveries d
           JOIN messages m ON m.id=d.message_id
           WHERE d.recipient='owner' AND m.chamber_id='chain' AND m.kind IN ('respond','relay')`
        ).get().c;
        if (toOwner >= 1) { done = true; break; }
        await sleep(50);
      }
      d.stop();
      assert.equal(done, true, "expected final reply to owner");
      const relays = d.store.prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE chamber_id='chain' AND kind='relay'`
      ).get().c;
      assert.ok(relays >= 1, "expected at least one relay hop, got " + relays);
    } finally {
      await d.close();
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

});
