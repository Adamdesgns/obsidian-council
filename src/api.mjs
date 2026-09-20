// src/api.mjs — loopback HTTP API for Obsidian Council (P2-3).
import http from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./store.mjs";
import { createOutbox } from "./outbox.mjs";
import { councilHome, ensureHome } from "./home.mjs";
import { loadOrCreateTokens, identityFromToken, parseBearer } from "./tokens.mjs";
import { routeOwnerSay, defaultBroadcast } from "./routing.mjs";
import { contentHash, assertSanction, markUsed } from "./sanctions.mjs";
import { startDeliberation } from "./deliberation.mjs";
import { loadLimits } from "./adapters/spawn.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG = { host: "127.0.0.1", port: 4777, lease_ms: 60_000 };

function loadConfig() {
  const p = join(ROOT, "config", "council.json");
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(",")[0].trim().toLowerCase();
  const name = host.replace(/^\[|\]$/g, "").split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function isLoopbackOrigin(origin) {
  if (!origin) return true; // non-browser clients omit Origin
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createApi(opts = {}) {
  const home = ensureHome(opts.home || councilHome());
  const config = { ...loadConfig(), ...opts.config };
  const store = opts.store || openStore({ home });
  const outbox = opts.outbox || createOutbox(store, { leaseMs: config.lease_ms });
  const tokens = opts.tokens || loadOrCreateTokens(home);
  const limits = opts.limits || loadLimits();
  const sseClients = new Set();
  let halt = existsSync(join(home, "HALT"));

  /** Row as the Floor should see it: JSON columns parsed, nothing else changed. */
  function deliberationView(row) {
    const parse = (v, dflt) => { try { return v == null ? dflt : JSON.parse(v); } catch { return dflt; } };
    return {
      ...row,
      deliberators: parse(row.deliberators, []),
      answers: parse(row.answers, {}),
      stall_detail: parse(row.stall_detail, null),
    };
  }

  // Seed default members
  store.commit("api_boot", "system", (api) => {
    for (const id of ["claude", "codex", "grok"]) {
      const row = api.prepare("SELECT id FROM members WHERE id = ?").get(id);
      if (!row) {
        api.prepare(
          "INSERT INTO members(id, kind, display_name, created) VALUES(?,?,?,?)"
        ).run(id, "cli", id, api.nowIso());
      }
    }
    api.setRef("members", null, { seeded: true });
  });

  function recordSpoof(identity, bodySender) {
    store.commit("sender_spoof_attempt", identity.member, (api) => {
      api.setRef("messages", null, {
        token_member: identity.member,
        body_sender: bodySender,
      });
    });
  }

  function stampSender(identity, body) {
    const b = body && typeof body === "object" ? { ...body } : {};
    if (b.sender != null && String(b.sender) !== identity.member) {
      recordSpoof(identity, b.sender);
    }
    b.sender = identity.member;
    return b;
  }

  async function handle(req, res) {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!isLoopbackHost(host) || !isLoopbackOrigin(origin)) {
      return sendJson(res, 403, { error: "loopback_only" });
    }

    const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
    const path = url.pathname;

    // Static Floor
    if (req.method === "GET" && path === "/") {
      const htmlPath = join(ROOT, "web", "index.html");
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      }
      return sendJson(res, 200, { ok: true, service: "obsidian-council" });
    }

    const bearer = parseBearer(req);
    if (!bearer) return sendJson(res, 401, { error: "missing_token" });
    const identity = identityFromToken(tokens, bearer);
    if (!identity) return sendJson(res, 401, { error: "invalid_token" });

    if (path.startsWith("/owner/") && identity.role !== "owner") {
      return sendJson(res, 403, { error: "owner_only" });
    }

    try {
      if (identity.role === "member") {
        return await memberRoutes(req, res, path, identity, url);
      }
      return await ownerRoutes(req, res, path, identity, url);
    } catch (e) {
      const status = e.statusCode || 500;
      return sendJson(res, status, { error: String(e.message || e) });
    }
  }

  async function memberRoutes(req, res, path, identity, url) {
    const member = identity.member;

    if (req.method === "GET" && path === "/inbox") {
      const rows = store.prepare(
        `SELECT d.*, m.kind, m.sender, m.content, m.chamber_id, m.parent_id, m.created AS message_created
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient = ? AND d.status IN ('pending','leased','waiting')
         ORDER BY d.id ASC`
      ).all(member);
      return sendJson(res, 200, { deliveries: rows });
    }

    if (req.method === "POST" && path === "/claim") {
      const claimed = outbox.claim(member);
      return sendJson(res, 200, { claimed });
    }

    if (req.method === "POST" && path === "/ask") {
      const body = stampSender(identity, await readBody(req));
      const r = outbox.send({
        ...body,
        sender: member,
        kind: body.kind || "ask",
        recipients: body.recipients || (body.recipient ? [body.recipient] : []),
        idempotency_key: body.idempotency_key || `ask:${member}:${body.to || body.recipient}:${Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/submit") {
      const body = stampSender(identity, await readBody(req));
      const r = outbox.send({
        ...body,
        sender: member,
        kind: body.kind || "submit",
        recipients: body.recipients || ["owner"],
        idempotency_key: body.idempotency_key || `submit:${member}:${body.operation_id || body.id || Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/attach") {
      const body = stampSender(identity, await readBody(req));
      const art = store.commit("artifact_attached", member, (api) => {
        const id = body.id || api.uuid();
        api.prepare(
          `INSERT INTO artifacts(id, kind, path, sha256, bytes, producer, run_id, created)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(
          id,
          body.kind || "file",
          body.path || "",
          body.sha256 || "",
          body.bytes ?? null,
          member,
          body.run_id ?? null,
          api.nowIso()
        );
        api.setRef("artifacts", id, { kind: body.kind || "file" });
        return { id };
      });
      return sendJson(res, 200, art.result);
    }

    if (req.method === "POST" && path === "/request-review") {
      const body = stampSender(identity, await readBody(req));
      const r = outbox.send({
        ...body,
        sender: member,
        kind: "request-review",
        recipients: body.recipients || (body.recipient ? [body.recipient] : []),
        idempotency_key: body.idempotency_key || `review:${member}:${body.parent_id || Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/respond") {
      const body = stampSender(identity, await readBody(req));
      if (body.delivery_id != null && body.gen != null) {
        const ack = outbox.ack(body.delivery_id, body.gen, {
          actor: member,
          status: body.status || "acked",
        });
        if (body.content || body.recipients || body.recipient) {
          const r = outbox.send({
            ...body,
            sender: member,
            kind: body.kind || "respond",
            recipients: body.recipients || (body.recipient ? [body.recipient] : ["owner"]),
            idempotency_key: body.idempotency_key || `respond:${member}:${body.delivery_id}:${body.gen}`,
          });
          return sendJson(res, 200, { ack, sent: r });
        }
        return sendJson(res, 200, { ack });
      }
      const r = outbox.send({
        ...body,
        sender: member,
        kind: body.kind || "respond",
        recipients: body.recipients || (body.recipient ? [body.recipient] : ["owner"]),
        idempotency_key: body.idempotency_key || `respond:${member}:${Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/task") {
      const body = stampSender(identity, await readBody(req));
      const r = outbox.send({
        ...body,
        sender: member,
        kind: "task",
        recipients: body.recipients || (body.recipient ? [body.recipient] : ["owner"]),
        idempotency_key: body.idempotency_key || `task:${member}:${Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/notify-steward") {
      const body = stampSender(identity, await readBody(req));
      const r = outbox.send({
        ...body,
        sender: member,
        kind: "notify-steward",
        recipients: ["owner"],
        idempotency_key: body.idempotency_key || `notify:${member}:${Date.now()}`,
      });
      return sendJson(res, 200, r);
    }

    if (req.method === "GET" && path === "/resume") {
      const chamberId = url.searchParams.get("chamber_id");
      const q = chamberId
        ? store.prepare("SELECT * FROM sessions WHERE member = ? AND chamber_id = ?").get(member, chamberId)
        : store.prepare("SELECT * FROM sessions WHERE member = ? ORDER BY updated DESC LIMIT 1").get(member);
      return sendJson(res, 200, { session: q || null });
    }

    if (req.method === "GET" && path.startsWith("/context/")) {
      const task = decodeURIComponent(path.slice("/context/".length));
      const msgs = store.prepare(
        `SELECT * FROM messages WHERE content LIKE ? OR id = ? ORDER BY created ASC LIMIT 50`
      ).all("%" + task + "%", task);
      return sendJson(res, 200, { task, messages: msgs });
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  async function ownerRoutes(req, res, path, identity, url) {
    if (req.method === "POST" && path === "/owner/chamber") {
      const body = await readBody(req);
      const committed = store.commit("chamber_created", "owner", (api) => {
        const id = body.id || api.uuid();
        api.prepare(
          "INSERT INTO chambers(id, title, created, status) VALUES(?,?,?,?)"
        ).run(id, body.title || "Chamber", api.nowIso(), "open");
        api.setRef("chambers", id, { title: body.title || "Chamber" });
        return { id, title: body.title || "Chamber" };
      });
      return sendJson(res, 200, committed.result);
    }

    if (req.method === "POST" && path === "/owner/summon") {
      const body = await readBody(req);
      const members = body.members || body.member && [body.member] || [];
      const chamber_id = body.chamber_id;
      // P2-6e: summons record presence invited only — no message, no delivery, no model run.
      const committed = store.commit("member_invited", "owner", (api) => {
        api.setRef("members", members[0] || null, { invited: members, chamber_id });
        return { invited: members, chamber_id, runs: 0 };
      });
      if (typeof opts.onSummon === "function") {
        try { opts.onSummon(members, chamber_id); } catch { /* */ }
      }
      return sendJson(res, 200, committed.result);
    }

    if (req.method === "POST" && path === "/owner/say") {
      const body = await readBody(req);
      // One shared routing contract with the dispatcher (routing.mjs): @chains
      // route the root only to the first member and persist chain/hop state.
      const r = routeOwnerSay(outbox, {
        chamber_id: body.chamber_id,
        kind: "say",
        content: body.content || body.text || "",
        recipients: body.recipients || (body.recipient ? [body.recipient] : body.at ? [body.at] : []),
        idempotency_key: body.idempotency_key,
      });
      broadcast({ type: "say", message: r.message });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && path === "/owner/sanction") {
      const body = await readBody(req);
      // Never trust a client-supplied hash when the content itself is here —
      // derive it from what is actually being approved. Hash-only (the Floor's
      // current form) is still accepted.
      const hash = body.content != null ? contentHash(body.content) : String(body.content_hash || "").trim();
      if (!hash) return sendJson(res, 400, { error: "content or content_hash required" });
      const committed = store.commit("sanction_decided", "owner", (api) => {
        const id = body.id || api.uuid();
        api.prepare(
          `INSERT INTO sanctions(id, directive_id, content_hash, scopes, decided_by, decided_at, expires_at, used_at, status)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(
          id,
          body.directive_id ?? null,
          hash,
          typeof body.scopes === "string" ? body.scopes : JSON.stringify(body.scopes || []),
          "owner",
          api.nowIso(),
          body.expires_at ?? null,
          null,
          body.status || (body.approve === false ? "rejected" : "approved")
        );
        api.setRef("sanctions", id, { content_hash: hash, status: body.status || "approved" });
        return { id, content_hash: hash };
      });
      return sendJson(res, 200, committed.result);
    }

    // Deliberation Engine (Task 13). Same owner token and loopback checks as
    // every /owner/* route; the engine itself decides what is startable.
    if (req.method === "POST" && path === "/owner/deliberate") {
      const body = await readBody(req);
      const r = startDeliberation(store, outbox, {
        chamber_id: body.chamber_id ?? null,
        question: body.content ?? body.question ?? "",
        deliberators: body.deliberators || defaultBroadcast(),
        category: body.category ?? null,
        limits,
      });
      if (r.ok) {
        broadcast({ type: "deliberate", id: r.id, state: r.state });
        return sendJson(res, 200, r);
      }
      // Budget is a 409 (try later); everything else is the caller's request.
      return sendJson(res, r.reason === "insufficient_budget" ? 409 : 400, r);
    }

    // Floor list view: summary columns only. `answers` can hold every reply of a
    // three-round debate, so it stays on the per-row GET.
    if (req.method === "GET" && path === "/owner/deliberations") {
      const chamberId = url.searchParams.get("chamber_id");
      const cols = "id, chamber_id, question, category, state, round, flag, final_answer, created, updated";
      const rows = chamberId
        ? store.prepare(`SELECT ${cols} FROM deliberations WHERE chamber_id = ? ORDER BY created DESC LIMIT 50`).all(chamberId)
        : store.prepare(`SELECT ${cols} FROM deliberations ORDER BY created DESC LIMIT 50`).all();
      return sendJson(res, 200, { deliberations: rows });
    }

    if (path.startsWith("/owner/deliberation/")) {
      const [id, action, ...more] = path.slice("/owner/deliberation/".length).split("/");
      if (!id || more.length) return sendJson(res, 404, { error: "not_found" });
      const row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
      if (!row) return sendJson(res, 404, { error: "no such deliberation" });

      if (req.method === "GET" && !action) return sendJson(res, 200, deliberationView(row));

      if (req.method === "POST" && action === "approve") {
        if (row.state !== "pending_owner") {
          return sendJson(res, 409, { ok: false, reason: "not_pending", state: row.state });
        }
        // escalated and deadlock rows carry no agreed answer: the owner writes
        // their own (overrule). Hashing NULL would gate the string "null".
        if (row.final_answer == null || row.final_answer === "") {
          return sendJson(res, 409, { ok: false, reason: "no_answer_to_approve", flag: row.flag });
        }
        const gate = assertSanction(store, { content: row.final_answer, actor: "owner" });
        if (!gate.ok) return sendJson(res, 403, gate);
        markUsed(store, gate.sanction.id, "owner");
        const hash = contentHash(row.final_answer);
        const out = store.commit("deliberation_settled", "owner", (api) => {
          api.prepare(
            "UPDATE deliberations SET state='settled', content_hash=?, updated=? WHERE id=? AND state='pending_owner'"
          ).run(hash, api.nowIso(), id);
          api.setRef("deliberations", id, { settled: true, content_hash: hash, sanction_id: gate.sanction.id });
          return { id, state: "settled", content_hash: hash, sanction_id: gate.sanction.id };
        });
        broadcast({ type: "deliberation", id, state: "settled" });
        return sendJson(res, 200, out.result);
      }

      if (req.method === "POST" && action === "overrule") {
        if (["settled", "overruled", "abandoned"].includes(row.state)) {
          return sendJson(res, 409, { ok: false, reason: "closed", state: row.state });
        }
        const body = await readBody(req);
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) return sendJson(res, 400, { error: "content required" });
        const hash = contentHash(content);
        const out = store.commit("deliberation_overruled", "owner", (api) => {
          api.prepare(
            "UPDATE deliberations SET state='overruled', final_answer=?, content_hash=?, updated=? WHERE id=?"
          ).run(content, hash, api.nowIso(), id);
          api.setRef("deliberations", id, { overruled: true, from_state: row.state, content_hash: hash });
          return { id, state: "overruled", content_hash: hash };
        });
        broadcast({ type: "deliberation", id, state: "overruled" });
        return sendJson(res, 200, out.result);
      }

      return sendJson(res, 404, { error: "not_found" });
    }

    if (req.method === "POST" && path === "/owner/halt") {
      writeFileSync(join(home, "HALT"), new Date().toISOString(), "utf8");
      halt = true;
      store.commit("halt_set", "owner", (api) => api.setRef(null, null, { halt: true }));
      return sendJson(res, 200, { halt: true });
    }

    if (req.method === "DELETE" && path === "/owner/halt") {
      try {
        const { unlinkSync } = await import("node:fs");
        if (existsSync(join(home, "HALT"))) unlinkSync(join(home, "HALT"));
      } catch { /* ignore */ }
      halt = false;
      store.commit("halt_cleared", "owner", (api) => api.setRef(null, null, { halt: false }));
      return sendJson(res, 200, { halt: false });
    }

    if (req.method === "GET" && path.startsWith("/owner/floor/")) {
      const chamberId = path.slice("/owner/floor/".length);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const client = { res, chamberId };
      sseClients.add(client);
      const recent = store.prepare(
        `SELECT * FROM events ORDER BY seq DESC LIMIT 50`
      ).all().reverse();
      for (const ev of recent) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      req.on("close", () => sseClients.delete(client));
      return;
    }

    if (req.method === "GET" && path === "/owner/messages") {
      const chamberId = url.searchParams.get("chamber_id");
      const after = url.searchParams.get("after") || "";
      const rows = chamberId
        ? store.prepare(
            `SELECT id, kind, sender, content, created FROM messages
             WHERE chamber_id = ? AND created > ? ORDER BY created ASC LIMIT 200`
          ).all(chamberId, after)
        : store.prepare(
            `SELECT id, kind, sender, content, chamber_id, created FROM messages
             WHERE created > ? ORDER BY created ASC LIMIT 200`
          ).all(after);
      return sendJson(res, 200, { messages: rows });
    }

    if (req.method === "GET" && path === "/owner/state") {
      return sendJson(res, 200, {
        halt: existsSync(join(home, "HALT")),
        chambers: store.prepare("SELECT * FROM chambers").all(),
        members: store.prepare("SELECT * FROM members").all(),
        events: store.verifyChain(),
        deliveries_pending: store.prepare(
          "SELECT COUNT(*) AS c FROM deliveries WHERE status IN ('pending','leased','waiting')"
        ).get().c,
      });
    }

    // Owner can also hit member-shaped routes as owner (optional) — not required.
    return sendJson(res, 404, { error: "not_found" });
  }

  function broadcast(obj) {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of sseClients) {
      try { c.res.write(data); } catch { sseClients.delete(c); }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", reject);
        resolve({ host: config.host, port: config.port, home });
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      for (const c of sseClients) {
        try { c.res.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      try { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); } catch { /* ignore */ }
      server.close(() => {
        try { outbox.close(); } catch { /* ignore */ }
        try { store.close(); } catch { /* ignore */ }
        resolve();
      });
      // Safety: if close hangs, resolve anyway
      setTimeout(resolve, 2000);
    });
  }

  return {
    server,
    listen,
    close,
    store,
    outbox,
    tokens,
    home,
    config,
    broadcast,
  };
}

// CLI: node src/api.mjs
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const api = createApi();
  api.listen().then(({ host, port }) => {
    console.error(`[council-api] listening on http://${host}:${port}`);
  });
}