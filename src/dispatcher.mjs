// src/dispatcher.mjs — claim → packet → spawn → ack → send. One run per (member, chamber).
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import { createOutbox } from "./outbox.mjs";
import { councilHome, ensureHome } from "./home.mjs";
import { loadLimits } from "./adapters/spawn.mjs";
import { spawnMember, killTree as killTreeSync } from "./adapters/spawn.mjs";
import { buildPacket } from "./adapters/packet.mjs";
import { prepareBridge, noneBridge, removeGrokBridgeConfig } from "./adapters/bridge-config.mjs";
import * as claudeAd from "./adapters/claude.mjs";
import * as codexAd from "./adapters/codex.mjs";
import * as grokAd from "./adapters/grok.mjs";
import { parseAddressChain, routeOwnerSay } from "./routing.mjs";

const ADAPTERS = { claude: claudeAd, codex: codexAd, grok: grokAd };

export { parseAddressChain };
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
  const apiBase = opts.apiBase || process.env.COUNCIL_API_BASE || "";
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

  function parseJsonObjects(text) {
    const objs = [];
    const t = String(text || "").trim();
    if (!t) return objs;
    try {
      const whole = JSON.parse(t);
      return Array.isArray(whole) ? whole : [whole];
    } catch { /* */ }
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith("{")) continue;
      try { objs.push(JSON.parse(l)); } catch { /* */ }
    }
    return objs;
  }

  function isCancelledStop(result) {
    for (const o of parseJsonObjects(result?.stdout)) {
      if (o && o.stopReason === "cancelled") return true;
    }
    for (const o of parseJsonObjects(result?.stderr)) {
      if (o && o.stopReason === "cancelled") return true;
    }
    return false;
  }

  function classifyRunFailure(result) {
    if (!result) return "no_result";
    if (result.refused) return String(result.refused);
    if (result.timedOut) return "timed_out";
    if (isCancelledStop(result)) return "cancelled";
    if (result.exit === null || typeof result.exit === "undefined") return "spawn_error";
    if (result.exit !== 0) return `exit_${result.exit}`;
    return null;
  }

  /** P2-6d: resume id + (non-zero exit OR stderr/stdout resume-error pattern). */
  function isResumeFailure(result, resumeId, refuseOnce) {
    if (!resumeId) return false;
    if (refuseOnce) return true;
    if (result && result.exit !== 0 && result.exit != null) return true;
    const err = String(result?.stderr || "");
    const out = String(result?.stdout || "");
    const re = /not found|already in use|Error: Failed|cannot resume|refuse_resume/i;
    if (re.test(err) || re.test(out)) return true;
    return false;
  }

  function patchRunCheckpoint(runId, member, patch) {
    if (!runId) return;
    try {
      store.commit("run_checkpoint", member || "dispatcher", (api) => {
        const row = api.prepare("SELECT checkpoint FROM runs WHERE id = ?").get(runId);
        let cp = {};
        try { cp = JSON.parse(row?.checkpoint || "{}"); } catch { /* */ }
        Object.assign(cp, patch);
        api.prepare("UPDATE runs SET checkpoint = ? WHERE id = ?").run(JSON.stringify(cp), runId);
        api.setRef("runs", runId, patch);
      });
    } catch { /* store may be closed */ }
  }

  function isCeilingOrAuth(reason) {
    return /BUDGET|ceiling|auth|unauthorized|forbidden|401|403|token/i.test(String(reason || ""));
  }

  function fenceOpenRuns() {
    store.commit("runs_fenced", "dispatcher", (api) => {
      const open = api.prepare("SELECT id, member, message_id FROM runs WHERE ended IS NULL").all();
      const now = api.nowIso();
      const ids = [];
      for (const run of open) {
        api.prepare(
          `UPDATE runs SET ended = ?, exit = ? WHERE id = ? AND ended IS NULL`
        ).run(now, "interrupted", run.id);
        if (run.message_id) {
          api.prepare(
            `UPDATE deliveries SET lease_until = ?, updated = ?
             WHERE message_id = ? AND recipient = ? AND status = 'leased'`
          ).run(now, now, run.message_id, run.member);
        }
        ids.push(run.id);
      }
      api.setRef("runs", ids[0] || null, { fenced: ids.length, ids });
      return { fenced: ids.length, ids };
    });
  }

  function expireDeliveryLease(deliveryId, reason, actor) {
    store.commit("run_failed", actor || "dispatcher", (api) => {
      const now = api.nowIso();
      api.prepare(
        `UPDATE deliveries SET lease_until = ?, updated = ? WHERE id = ?`
      ).run(now, now, deliveryId);
      api.setRef("deliveries", deliveryId, { run_failed: reason, lease_until: now });
      return { deliveryId, reason };
    });
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

        // hop / auto-reply caps. A hop is a member->member send; a delivery
        // produced by hop <= maxHops may still be consumed (its reply returns
        // to the owner), so a chain with exactly maxHops member hops completes.
        // Initiating hops beyond the cap is blocked at send time in runOne.
        const hops = hopCount.get(chamber) || 0;
        if (hops > maxHops && row.sender !== "owner") {
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

    // P2-6e: summons never spend model runs — presence invited only.
    if (message.kind === "summon") {
      setPresence(member, "invited");
      try { outbox.ack(delivery, gen, { actor: member, status: "answered" }); } catch { /* */ }
      return;
    }

    setPresence(member, "responding");

    // Session resume
    let session = store.prepare(
      "SELECT * FROM sessions WHERE member = ? AND chamber_id = ?"
    ).get(member, chamber === "_" ? "" : chamber);
    let resume = session?.provider_session_id || null;
    let resumeFailed = false;

    const msgPayload = {
      id: message.id,
      kind: message.kind,
      sender: message.sender,
      content: message.content,
    };
    // P2-6d/e: Codex + Grok plain-text / bridge=none (bridge cert is Phase 3).
    const plainText = member === "codex" || member === "grok" || !!opts.disableBridge;
    let packet = buildPacket({ member, chamber, message: msgPayload, plainText });

    const cwd = join(home, "workspaces", member, String(chamber).replace(/[^\w-]/g, "_") || "_");
    mkdirSync(cwd, { recursive: true });
    let bridge = prepareBridge(member, {
      cwd,
      token: tokens[member],
      apiBase,
      disabled: !!opts.disableBridge || member === "codex" || member === "grok",
    });
    const spawnOpts = {
      chamber_id: chamber === "_" ? null : chamber,
      message_id: message.id,
      resume,
      persist: !resume,
      newId: member === "grok" && !resume ? crypto.randomUUID() : null,
      role: "review",
      memberToken: tokens[member],
      cwd,
      timeoutMs: opts.timeoutMs,
      limits: opts.limits || limits,
      skipBuildVerify: true,
      onSpawn: (child) => { meta.child = child; },
      env: { ...(opts.env || {}), ...(bridge.env || {}) },
      extraArgs: bridge.extraArgs || [],
    };

    // Test injection via opts only (no FAKE_MODE knowledge in dispatcher).
    if (opts.useFake || opts.fakePath) {
      spawnOpts.fakePath = opts.fakePath || FAKE;
    }
    if (opts.refuseResumeOnce && resume && opts.refuseResumeEnv) {
      spawnOpts.env = { ...spawnOpts.env, ...opts.refuseResumeEnv };
    }

    const pathRunIds = [];
    const HEAD = 2048;
    function noteRun(res, status) {
      if (!res?.runId) return;
      pathRunIds.push(res.runId);
      patchRunCheckpoint(res.runId, member, {
        bridge: status,
        stdout_head: String(res.stdout || "").slice(0, HEAD),
        stderr_head: String(res.stderr || "").slice(0, HEAD),
      });
    }
    function stampBridgeAll(status, extra = {}) {
      for (const id of pathRunIds) {
        patchRunCheckpoint(id, member, { bridge: status, ...extra });
      }
    }

    let result;
    try {
      result = await spawnMember(store, member, packet, spawnOpts);
    } catch (e) {
      result = { refused: String(e), exit: null, stdout: "", stderr: String(e) };
    }

    let bridgeStatus = bridge.bridge;
    try { bridge.cleanup(); } catch { /* */ }
    noteRun(result, bridgeStatus);

    // P2-6d item 2: resume failure -> session_replaced -> retry once without resume (not run_failed).
    if (isResumeFailure(result, resume, opts.refuseResumeOnce && resume)) {
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
        newId: member === "grok" ? crypto.randomUUID() : null,
        env: { ...(opts.env || {}), ...(opts.retryEnv || {}), ...(bridge.env || {}) },
        extraArgs: bridge.extraArgs || [],
      });
      noteRun(result, bridgeStatus);
      stampBridgeAll(bridgeStatus);
    }

    let mixedBridgeFallback = false;
    // P2-6d item 5 / P2-6e: if a project bridge was used and failed, retry bridge=none; stamp every run row.
    if (
      member === "grok" &&
      bridgeStatus === "grok-project-config" &&
      !resumeFailed &&
      classifyRunFailure(result)
    ) {
      removeGrokBridgeConfig(cwd);
      // Keep the failed row explaining it used the project bridge; then fall back.
      stampBridgeAll("grok-project-config");
      bridgeStatus = "none";
      bridge = noneBridge();
      packet = buildPacket({ member, chamber, message: msgPayload, plainText: true });
      result = await spawnMember(store, member, packet, {
        ...spawnOpts,
        resume: null,
        persist: true,
        newId: crypto.randomUUID(),
        env: { ...(opts.env || {}), ...(opts.retryEnv || {}) },
        extraArgs: [],
      });
      noteRun(result, bridgeStatus);
      mixedBridgeFallback = true;
    }

    // P2-6e item 3: stamp bridge on every run of this spawn path (skip when mixed statuses already set).
    if (!mixedBridgeFallback) stampBridgeAll(bridgeStatus);

    const ad = ADAPTERS[member];
    let text = "";
    if (ad && ad.finalText) {
      try { text = ad.finalText(result) || ""; } catch { text = ""; }
    }
    if (!text) text = String(result && result.stdout || "").trim().slice(0, 4000);
    let outbound = [];
    try {
      const objs = JSON.parse(result.stdout);
      if (objs && Array.isArray(objs.outbound)) outbound = objs.outbound;
      if (objs && objs.ask) outbound.push({ kind: "ask", ...objs.ask });
    } catch { /* prose */ }
    if (opts.scriptedOutbound) {
      outbound = opts.scriptedOutbound(member, message, result) || outbound;
    }

    // No ack on a failed / cancelled / timed-out run -- expire lease for reclaim.
    // Resume failures already retried above and are not counted as run_failed for that attempt.
    const failReason = classifyRunFailure(result);
    if (failReason) {
      stampBridgeAll(bridgeStatus, { fail: failReason });
      try { expireDeliveryLease(delivery.id, failReason, member); } catch { /* store may be closed after hardStop */ }
      try {
        if (isCeilingOrAuth(failReason)) setPresence(member, "blocked", failReason);
        else setPresence(member, "idle");
      } catch { /* */ }
      return;
    }

    // Ack this delivery as answered (success only)
    const ack = outbox.ack(delivery, gen, { actor: member, status: "answered" });
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
      let recipients = out.recipients || (out.recipient ? [out.recipient] : ["owner"]);
      const memberDirected = recipients.some((r) => r && r !== "owner");
      // Hop cap at send time: at the cap, return to the floor instead of
      // starting another member hop.
      if (memberDirected && (hopCount.get(chamber) || 0) >= maxHops) {
        store.commit("floor_returned", member, (api) => {
          api.setRef("messages", message.id, { reason: "hop_cap", chamber, redirected: recipients });
        });
        recipients = ["owner"];
      }
      if (recipients.some((r) => r && r !== "owner")) {
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
        recipients,
        chamber_id: chamber === "_" ? null : chamber,
        kind: out.kind || "respond",
        content: out.content || result.stdout.slice(0, 2000),
        parent_id: message.id,
        idempotency_key: out.idempotency_key || `disp:${member}:${message.id}:${out.kind || "respond"}:${Date.now()}`,
      });
    }

    // Directed @chain (P2-6f): state lives on the root owner message row in the DB.
    function resolveChainState(msg) {
      let cur = msg;
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        let chain = cur.chain;
        if (typeof chain === "string" && chain) {
          try { chain = JSON.parse(chain); } catch { chain = null; }
        }
        if (Array.isArray(chain) && chain.length) {
          return { chain, hop: Number(cur.chain_hop) || 0, rootId: cur.id };
        }
        if (cur.sender === "owner") {
          const c = parseAddressChain(cur.content);
          if (c.length) return { chain: c, hop: Number(cur.chain_hop) || 0, rootId: cur.id };
        }
        if (!cur.parent_id) break;
        cur = store.prepare("SELECT * FROM messages WHERE id = ?").get(cur.parent_id);
        if (cur) {
          // normalize via outbox shape for chain columns
          let parsed = cur.chain;
          if (typeof parsed === "string" && parsed) {
            try { parsed = JSON.parse(parsed); } catch { parsed = null; }
          }
          cur = { ...cur, chain: parsed, chain_hop: cur.chain_hop == null ? null : Number(cur.chain_hop) };
        }
      }
      return null;
    }
    const chainState = resolveChainState(message);
    let chainNext = null;
    let advance = null;
    if (chainState && Array.isArray(chainState.chain)) {
      const hop = Number(chainState.hop) || 0;
      if (hop < chainState.chain.length - 1) {
        chainNext = chainState.chain[hop + 1];
        advance = { root_id: chainState.rootId, hop: hop + 1 };
      }
    }
    if (!outbound.length && opts.defaultRespond !== false) {
      // Hop cap at send time. Only here is a chain relay actually produced, so
      // only here can one be suppressed: when the member's own outbound already
      // answered (loop above), or defaultRespond is off, nothing is truncated
      // and no floor_returned is recorded.
      if (chainNext && chainNext !== "owner" && (hopCount.get(chamber) || 0) >= maxHops) {
        store.commit("floor_returned", member, (api) => {
          api.setRef("messages", message.id, { reason: "hop_cap", chamber, truncated_next: chainNext });
        });
        chainNext = null;
        advance = null;
      }
      if (message.sender !== "owner") {
        autoReplies.set(chamber, (autoReplies.get(chamber) || 0) + 1);
      }
      const recipients = chainNext ? [chainNext] : ["owner"];
      if (chainNext) hopCount.set(chamber, (hopCount.get(chamber) || 0) + 1);
      outbox.send({
        sender: member,
        recipients,
        chamber_id: chamber === "_" ? null : chamber,
        kind: chainNext ? "relay" : "respond",
        content: (text || result.stdout || "").slice(0, 2000) || "(empty)",
        parent_id: message.id,
        idempotency_key: `disp:${member}:${message.id}:respond:${gen}`,
        advance_chain: advance || undefined,
      });
    }

    setPresence(member, "idle");
  }

  /** P2-6e: record presence invited; create no message / delivery / model run. */
  function summon(memberList, chamber_id = null) {
    const invited = [];
    for (const m of memberList || []) {
      const id = String(m || "").toLowerCase();
      if (!id) continue;
      setPresence(id, "invited");
      invited.push(id);
    }
    const committed = store.commit("member_invited", "owner", (api) => {
      api.setRef("members", invited[0] || null, { invited, chamber_id });
      return { invited, chamber_id, runs: 0 };
    });
    return committed.result;
  }

  // P2-6f contract lives in routing.mjs, shared with the HTTP API (POST /owner/say).
  function ownerSay(envelope) {
    return routeOwnerSay(outbox, envelope);
  }

  function start() {
    stopped = false;
    fenceOpenRuns();
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

  /** Kill in-flight children and fence open runs without awaiting them (restart path). */
  function hardStop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const meta of active.values()) {
      if (meta.child && meta.child.pid) {
        try { killTreeSync(meta.child.pid); } catch { /* */ }
      }
    }
    try { fenceOpenRuns(); } catch { /* */ }
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
    hardStop,
    fenceOpenRuns,
    tick,
    close,
    store,
    outbox,
    presence,
    isHalted,
    haltPath,
    active,
    home,
    ownerSay,
    summon,
    parseAddressChain,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const d = createDispatcher({ useFake: process.env.COUNCIL_FAKE === "1" });
  d.start();
  console.error("[dispatcher] started");
}