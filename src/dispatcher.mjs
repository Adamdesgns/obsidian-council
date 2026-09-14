// src/dispatcher.mjs — claim → packet → spawn → ack → send. One run per (member, chamber).
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import { createOutbox } from "./outbox.mjs";
import { councilHome, ensureHome } from "./home.mjs";
import { loadLimits } from "./adapters/spawn.mjs";
import { spawnMember } from "./adapters/spawn.mjs";
import { buildPacket } from "./adapters/packet.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE = join(ROOT, "src", "testutil", "fake-member.mjs");

export function createDispatcher(opts = {}) {
  const home = ensureHome(opts.home || councilHome());
  const store = opts.store || openStore({ home });
  const outbox = opts.outbox || createOutbox(store, { leaseMs: opts.leaseMs });
  const limits = opts.limits || loadLimits();
  const tickMs = opts.tickMs ?? limits.dispatcher?.tick_ms ?? 2000;
  const maxHops = limits.dispatcher?.max_member_hops ?? 2;
  const maxAuto = limits.dispatcher?.max_auto_replies_per_owner_turn ?? 4;
  const members = opts.members || ["codex", "grok"];
  const active = new Map(); // key member::chamber -> run promise
  const presence = Object.fromEntries(members.map((m) => [m, { state: "idle", reason: null }]));
  const hopCount = new Map(); // chamber -> hops this owner turn
  const autoReplies = new Map();
  let timer = null;
  let stopped = false;
  const tokens = opts.tokens || {};

  function haltPath() {
    return join(home, "HALT");
  }

  function isHalted() {
    return existsSync(haltPath());
  }

  function setPresence(member, state, reason = null) {
    presence[member] = { state, reason, at: new Date().toISOString() };
  }

  function activeKey(member, chamber) {
    return `${member}::${chamber || "_"}`;
  }

  async function tick() {
    if (stopped) return;
    if (isHalted()) {
      // Cancel active fakes if possible
      for (const [k, meta] of active) {
        if (meta.child) {
          try {
            const { killTree } = await import("./adapters/spawn.mjs");
            killTree(meta.child.pid);
          } catch { /* */ }
        }
        setPresence(k.split("::")[0], "blocked", "HALT");
      }
      return;
    }

    for (const member of members) {
      // Find chambers with pending work and no active run
      const pending = store.prepare(
        `SELECT d.*, m.chamber_id, m.kind AS msg_kind, m.content, m.sender, m.id AS message_id
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient = ? AND (
           d.status = 'pending'
           OR (d.status = 'leased' AND d.lease_until IS NOT NULL AND d.lease_until < ?)
           OR d.status = 'waiting'
         )
         ORDER BY d.id ASC LIMIT 5`
      ).all(member, new Date().toISOString());

      for (const row of pending) {
        if (row.status === "waiting") continue; // waiting for peer answer
        const chamber = row.chamber_id || "_";
        const key = activeKey(member, chamber);
        if (active.has(key)) continue;

        // hop / auto-reply caps
        const hops = hopCount.get(chamber) || 0;
        if (hops >= maxHops && row.sender !== "owner") {
          store.commit("floor_returned", "dispatcher", (api) => {
            api.setRef("deliveries", row.id, { reason: "hop_cap", chamber });
          });
          continue;
        }
        const autos = autoReplies.get(chamber) || 0;
        if (row.sender === "owner") {
          autoReplies.set(chamber, 0);
          hopCount.set(chamber, 0);
        } else if (autos >= maxAuto) {
          store.commit("floor_returned", "dispatcher", (api) => {
            api.setRef("deliveries", row.id, { reason: "auto_reply_cap", chamber });
          });
          continue;
        }

        const meta = { child: null };
        const job = runOne(member, row, chamber, meta).finally(() => active.delete(key));
        active.set(key, meta);
        meta.promise = job;
        break; // one new spawn per member per tick
      }
    }
  }

  async function runOne(member, deliveryRow, chamber, meta) {
    setPresence(member, "starting");
    const claimed = outbox.claim(member);
    if (!claimed) {
      setPresence(member, "idle");
      return;
    }
    const { delivery, message, gen } = claimed;
    setPresence(member, "responding");

    // Session resume
    let session = store.prepare(
      "SELECT * FROM sessions WHERE member = ? AND chamber_id = ?"
    ).get(member, chamber === "_" ? "" : chamber);
    let resume = session?.provider_session_id || null;
    let resumeFailed = false;

    const packet = buildPacket({
      member,
      chamber,
      message: {
        id: message.id,
        kind: message.kind,
        sender: message.sender,
        content: message.content,
      },
    });

    const spawnOpts = {
      chamber_id: chamber === "_" ? null : chamber,
      message_id: message.id,
      resume,
      persist: !resume,
      newId: member === "grok" && !resume ? crypto.randomUUID() : null,
      role: "review",
      memberToken: tokens[member],
      cwd: join(home, "workspaces", member, String(chamber).replace(/[^\w-]/g, "_") || "_"),
      timeoutMs: opts.timeoutMs,
      limits: opts.limits || limits,
      skipBuildVerify: true,
      onSpawn: (child) => { meta.child = child; },
      env: { ...(opts.fakeEnv || {}) },
    };
    mkdirSync(spawnOpts.cwd, { recursive: true });

    if (opts.useFake || process.env.COUNCIL_FAKE === "1") {
      spawnOpts.fakePath = opts.fakePath || FAKE;
      if (opts.fakeEnv?.FAKE_MODE === "refuse-resume" && resume) {
        spawnOpts.env = { ...spawnOpts.env, FAKE_MODE: "refuse-resume" };
      }
    }

    let result;
    try {
      result = await spawnMember(store, member, packet, spawnOpts);
    } catch (e) {
      result = { refused: String(e), exit: null, stdout: "", stderr: String(e) };
    }

    if (spawnOpts.env?.FAKE_MODE === "refuse-resume" || /cannot resume|refuse_resume/i.test(result.stdout + result.stderr)) {
      resumeFailed = true;
      store.commit("session_replaced", member, (api) => {
        api.prepare(
          `INSERT INTO sessions(member, chamber_id, provider_session_id, lease_gen, resume_kind, updated)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(member, chamber_id) DO UPDATE SET
             provider_session_id=excluded.provider_session_id,
             resume_kind='replaced',
             updated=excluded.updated`
        ).run(member, chamber === "_" ? "" : chamber, "new-" + Date.now(), 0, "replaced", api.nowIso());
        api.setRef("sessions", member, { chamber, old: resume, reason: "resume_failed" });
      });
      // Retry once without resume
      result = await spawnMember(store, member, packet, {
        ...spawnOpts,
        resume: null,
        persist: true,
        env: { ...(opts.fakeEnv || {}), FAKE_MODE: "echo" },
      });
    }

    // Parse outbound intents from fake/final JSON
    let outbound = [];
    try {
      const objs = JSON.parse(result.stdout);
      if (objs && objs.outbound) outbound = objs.outbound;
      if (objs && objs.ask) outbound.push({ kind: "ask", ...objs.ask });
    } catch {
      // prose / multi-line: look for council_submit style markers in fake
    }
    if (opts.scriptedOutbound) {
      outbound = opts.scriptedOutbound(member, message, result) || outbound;
    }

    // Ack this delivery
    const ack = outbox.ack(delivery, gen, { actor: member, status: "acked" });
    if (!ack.ok) {
      setPresence(member, "idle");
      return;
    }

    // Record session if present
    const sid =
      (result.stdout.match(/"thread_id"\s*:\s*"([^"]+)"/) || [])[1] ||
      (result.stdout.match(/"session_id"\s*:\s*"([^"]+)"/) || [])[1] ||
      (result.stdout.match(/"sessionId"\s*:\s*"([^"]+)"/) || [])[1] ||
      spawnOpts.newId;
    if (sid && !resumeFailed) {
      store.commit("session_recorded", member, (api) => {
        api.prepare(
          `INSERT INTO sessions(member, chamber_id, provider_session_id, lease_gen, resume_kind, updated)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(member, chamber_id) DO UPDATE SET
             provider_session_id=excluded.provider_session_id,
             updated=excluded.updated`
        ).run(member, chamber === "_" ? "" : chamber, sid, 0, resume ? "resumed" : "created", api.nowIso());
        api.setRef("sessions", member, { chamber, sid });
      });
    }

    for (const out of outbound) {
      if (out.kind === "ask" || out.recipient) {
        hopCount.set(chamber, (hopCount.get(chamber) || 0) + 1);
        // checkpoint waiting if asking another member
        if (out.recipient && out.recipient !== "owner") {
          store.commit("delivery_waiting", member, (api) => {
            api.prepare(
              `UPDATE deliveries SET status='waiting', updated=? WHERE id=?`
            ).run(api.nowIso(), delivery.id);
            api.setRef("deliveries", delivery.id, { waiting_for: out.recipient });
          });
        }
      }
      if (message.sender !== "owner") {
        autoReplies.set(chamber, (autoReplies.get(chamber) || 0) + 1);
      }
      outbox.send({
        sender: member,
        recipients: out.recipients || (out.recipient ? [out.recipient] : ["owner"]),
        chamber_id: chamber === "_" ? null : chamber,
        kind: out.kind || "respond",
        content: out.content || result.stdout.slice(0, 2000),
        parent_id: message.id,
        idempotency_key: out.idempotency_key || `disp:${member}:${message.id}:${out.kind || "respond"}:${Date.now()}`,
      });
    }

    // Default: if no outbound, still send a respond to owner for Floor visibility
    if (!outbound.length && opts.defaultRespond !== false) {
      if (message.sender !== "owner") {
        autoReplies.set(chamber, (autoReplies.get(chamber) || 0) + 1);
      }
      outbox.send({
        sender: member,
        recipients: ["owner"],
        chamber_id: chamber === "_" ? null : chamber,
        kind: "respond",
        content: (result.stdout || "").slice(0, 2000) || "(empty)",
        parent_id: message.id,
        idempotency_key: `disp:${member}:${message.id}:respond:${gen}`,
      });
    }

    setPresence(member, "idle");
  }

  function start() {
    stopped = false;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      tick().catch((e) => console.error("[dispatcher]", e));
    }, tickMs);
    tick().catch(() => {});
    return { home, tickMs };
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function close() {
    stop();
    const pending = [...active.values()].map((m) => m.promise).filter(Boolean);
    try { await Promise.allSettled(pending); } catch { /* */ }
    active.clear();
    try { outbox.close(); } catch { /* */ }
    try { store.close(); } catch { /* */ }
  }

  return {
    start,
    stop,
    tick,
    close,
    store,
    outbox,
    presence,
    isHalted,
    haltPath,
    active,
    home,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const d = createDispatcher({ useFake: process.env.COUNCIL_FAKE === "1" });
  d.start();
  console.error("[dispatcher] started");
}