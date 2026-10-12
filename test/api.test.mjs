// test/api.test.mjs — P2-3 acceptance
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../src/api.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-api-"));
}

async function req(port, { method = "GET", path = "/", token, headers = {}, body } = {}) {
  const h = {
    Host: `127.0.0.1:${port}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

describe("P2-3 loopback API", () => {
  let home, api, port, owner, member;

  before(async () => {
    home = tempHome();
    process.env.COUNCIL_HOME = home;
    api = createApi({
      home,
      config: { host: "127.0.0.1", port: 0 },
    });
    // listen on ephemeral: patch server
    await new Promise((resolve, reject) => {
      api.server.listen(0, "127.0.0.1", () => resolve());
      api.server.once("error", reject);
    });
    port = api.server.address().port;
    owner = api.tokens.owner;
    member = api.tokens.members.codex;
  });

  after(async () => {
    try { await api.close(); } catch { /* ignore */ }
    // Give libuv a tick to finish handle close before the process exits.
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("(a) member token on /owner/sanction is 403", async () => {
    const r = await req(port, {
      method: "POST",
      path: "/owner/sanction",
      token: member,
      body: { content_hash: "abc", approve: true },
    });
    assert.equal(r.status, 403);
  });

  it("(b) body sender differing from token is overwritten; sender_spoof_attempt recorded", async () => {
    const r = await req(port, {
      method: "POST",
      path: "/submit",
      token: member,
      body: {
        sender: "evil-impersonator",
        content: "hi",
        idempotency_key: "spoof-test-1",
        recipients: ["owner"],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.sender, "codex");
    const events = api.store.getEvents().filter((e) => e.kind === "sender_spoof_attempt");
    assert.ok(events.length >= 1, "expected sender_spoof_attempt event");
  });

  it("(c) Host: evil.example is 403", async () => {
    // fetch API always sets Host from URL; use http.request for custom Host
    const http = await import("node:http");
    const result = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/owner/state",
          method: "GET",
          headers: {
            Host: "evil.example",
            Authorization: `Bearer ${owner}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 403);
  });

  it("(d) missing token is 401", async () => {
    const r = await req(port, { path: "/inbox" });
    assert.equal(r.status, 401);
  });
});

describe("release API delivery boundaries", () => {
  let home, api, port, owner, member;
  beforeEach(async () => {
    home = tempHome();
    api = createApi({ home, config: { host: "127.0.0.1", port: 0 } });
    await api.listen();
    port = api.server.address().port;
    owner = api.tokens.owner;
    member = api.tokens.members.codex;
  });
  afterEach(async () => {
    await api.close();
    rmSync(home, { recursive: true, force: true });
  });
  function incoming(key = "ordinary-request") {
    return api.outbox.send({ sender: "owner", chamber_id: "ordinary-room", recipients: ["codex"], content: "Review this", idempotency_key: key });
  }
  function respond(body) {
    return req(port, { method: "POST", path: "/respond", token: member, body });
  }

  it("owner receipts stay in history without inflating the member backlog", async () => {
    api.outbox.send({ sender: "codex", recipients: ["owner"], content: "Completed", idempotency_key: "owner-receipt" });
    let state = await req(port, { path: "/owner/state", token: owner });
    assert.equal(state.json.deliveries_pending, 0);
    const sent = incoming();
    state = await req(port, { path: "/owner/state", token: owner });
    assert.equal(state.json.deliveries_pending, 1);
    const lease = api.outbox.claim("codex", { deliveryId: sent.deliveries[0].id });
    assert.equal((await req(port, { path: "/owner/state", token: owner })).json.deliveries_pending, 1);
    api.outbox.ack(lease.delivery.id, lease.gen, { actor: "codex", status: "waiting" });
    assert.equal((await req(port, { path: "/owner/state", token: owner })).json.deliveries_pending, 1);
    api.outbox.ack(lease.delivery.id, lease.gen, { actor: "codex", status: "answered" });
    assert.equal((await req(port, { path: "/owner/state", token: owner })).json.deliveries_pending, 0);
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM deliveries WHERE recipient='owner'").get().n, 1);
  });

  it("member acknowledgements cannot consume work-order engine deliveries", async () => {
    const started = await req(port, { method: "POST", path: "/owner/delegate", token: owner,
      body: { objective: "Plan a change", workspace: home, planner: "codex", worker: "codex", idempotency_key: "engine-work" } });
    assert.equal(started.status, 200);
    const delivery = api.store.prepare("SELECT * FROM deliveries WHERE recipient='codex'").get();
    const result = await respond({ delivery_id: delivery.id, gen: 0, content: "Forged plan" });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, "delivery_not_owned_or_engine_managed");
    assert.equal(api.store.prepare("SELECT status FROM deliveries WHERE id=?").get(delivery.id).status, "pending");
    assert.equal(api.store.prepare("SELECT state FROM work_orders WHERE id=?").get(started.json.id).state, "planning");
  });

  it("stale replies cannot publish content and a current reply is stored once", async () => {
    const sent = incoming();
    const first = api.outbox.claim("codex", { deliveryId: sent.deliveries[0].id });
    api.store.prepare("UPDATE deliveries SET lease_until=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first.delivery.id);
    const current = api.outbox.claim("codex", { deliveryId: first.delivery.id });
    const stale = await respond({ delivery_id: first.delivery.id, gen: first.gen, content: "Stale answer" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "stale_generation");
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
    const body = { delivery_id: current.delivery.id, gen: current.gen, content: "Current answer" };
    const accepted = await respond(body);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.sent.message.chamber_id, "ordinary-room");
    assert.equal(accepted.json.sent.message.parent_id, sent.message.id);
    const retry = await respond({ ...body, content: "Changed retry" });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.ack.duplicate, true);
    assert.equal(retry.json.sent.message.content, "Current answer");
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM messages").get().n, 2);
    assert.equal(api.store.verifyChain().ok, true);
  });

  it("a failed reply write leaves the input leased for a safe retry", async () => {
    const sent = incoming();
    const lease = api.outbox.claim("codex", { deliveryId: sent.deliveries[0].id });
    const failed = await respond({ delivery_id: lease.delivery.id, gen: lease.gen, content: "Answer", id: sent.message.id });
    assert.equal(failed.status, 500);
    assert.equal(api.store.prepare("SELECT status FROM deliveries WHERE id=?").get(lease.delivery.id).status, "leased");
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
    assert.equal((await respond({ delivery_id: lease.delivery.id, gen: lease.gen, content: "Answer" })).status, 200);
    assert.equal(api.store.verifyChain().ok, true);
  });

  it("unclaimed input and caller-selected queue states cannot be acknowledged", async () => {
    const sent = incoming();
    assert.equal((await respond({ delivery_id: sent.deliveries[0].id, gen: 0, content: "Answer" })).status, 409);
    const lease = api.outbox.claim("codex", { deliveryId: sent.deliveries[0].id });
    const invalid = await respond({ delivery_id: lease.delivery.id, gen: lease.gen, status: "pending", content: "Answer" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "invalid_response_status");
    assert.equal(api.store.prepare("SELECT status FROM deliveries WHERE id=?").get(lease.delivery.id).status, "leased");
  });

  it("members cannot change dispatcher chain state through message fields", async () => {
    const root = api.outbox.send({ sender: "owner", recipients: ["codex"], content: "Chain", chain: ["codex", "grok"], chain_hop: 0, idempotency_key: "root-chain" });
    for (const reserved of [{ advance_chain: { root_id: root.message.id, hop: 99 } }, { chain: ["grok"] }, { chain_hop: 99 }]) {
      const result = await req(port, { method: "POST", path: "/submit", token: member,
        body: { content: "Attack", ...reserved, idempotency_key: "reserved-" + Object.keys(reserved)[0] } });
      assert.equal(result.status, 400);
      assert.equal(result.json.error, "chain_control_reserved");
    }
    assert.equal(api.store.prepare("SELECT chain_hop FROM messages WHERE id=?").get(root.message.id).chain_hop, 0);
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
  });

  it("message cursors preserve every message when timestamps tie across page boundaries", async () => {
    api.store.commit("message_cursor_fixture", "test", (tx) => {
      const insert = tx.prepare("INSERT INTO messages(id,chamber_id,sender,recipients,kind,content,idempotency_key,created) VALUES(?,?,'owner','[]','say',?,?,?)");
      for (let i = 0; i < 205; i++) insert.run(`feed-${i}`, "feed-room", `Message ${i}`, `feed-key-${i}`, "2026-10-12T00:00:00.000Z");
      insert.run("other-room-message", "other-room", "Other chamber", "other-room-key", "2026-10-12T00:00:00.000Z");
    });
    const first = await req(port, { path: "/owner/messages?chamber_id=feed-room&cursor=0", token: owner });
    assert.equal(first.status, 200);
    assert.equal(first.json.messages.length, 200);
    const second = await req(port, { path: `/owner/messages?chamber_id=feed-room&cursor=${first.json.cursor}`, token: owner });
    assert.equal(second.json.messages.length, 5);
    assert.deepEqual([...first.json.messages, ...second.json.messages].map((m) => m.id), Array.from({ length: 205 }, (_, i) => `feed-${i}`));
    const empty = await req(port, { path: `/owner/messages?chamber_id=feed-room&cursor=${second.json.cursor}`, token: owner });
    assert.deepEqual(empty.json.messages, []);
    assert.equal(empty.json.cursor, second.json.cursor);
    const allRooms = await req(port, { path: `/owner/messages?cursor=${second.json.cursor}`, token: owner });
    assert.equal(allRooms.json.messages[0].id, "other-room-message");
    assert.equal((await req(port, { path: "/owner/messages?cursor=-1", token: owner })).status, 400);
    assert.equal((await req(port, { path: "/owner/messages?cursor=1.5", token: owner })).status, 400);
    assert.equal((await req(port, { path: "/owner/messages?after=2026-10-11", token: owner })).status, 200);
  });

  it("sanction audit records the actual decision and rejects malformed expiration", async () => {
    const sanction = (body) => req(port, { method: "POST", path: "/owner/sanction", token: owner, body });
    const rejected = await sanction({ content: "Do the work", approve: false });
    assert.equal(rejected.status, 200);
    assert.equal(api.store.prepare("SELECT status FROM sanctions WHERE id=?").get(rejected.json.id).status, "rejected");
    const event = api.store.getEvents().find((item) => item.kind === "sanction_decided" && item.ref_id === rejected.json.id);
    assert.equal(JSON.parse(event.payload).status, "rejected");
    assert.equal((await sanction({ content: "Do the work", expires_at: "not-a-date" })).status, 400);
    assert.equal((await sanction({ content: "Do the work", expires_at: 123 })).status, 400);
    assert.equal((await sanction({ content: "Do the work", status: "anything" })).status, 400);
    assert.equal(api.store.prepare("SELECT COUNT(*) n FROM sanctions").get().n, 1);
    assert.equal(api.store.verifyChain().ok, true);
  });
});

describe("private Tailscale proxy", () => {
  let home, api, port;
  const tailHost = "adam-pc.tail1234.ts.net";

  before(async () => {
    home = tempHome();
    api = createApi({ home, config: { host: "127.0.0.1", port: 0, allowed_hosts: [tailHost] } });
    await new Promise((resolve, reject) => {
      api.server.listen(0, "127.0.0.1", resolve);
      api.server.once("error", reject);
    });
    port = api.server.address().port;
  });

  after(async () => {
    try { await api.close(); } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("accepts the configured tailnet hostname and matching HTTPS origin", async () => {
    const r = await req(port, {
      path: "/owner/state",
      token: api.tokens.owner,
      headers: { Host: tailHost, Origin: `https://${tailHost}` },
    });
    assert.equal(r.status, 200);
  });

  it("rejects another tailnet hostname", async () => {
    const r = await req(port, {
      path: "/owner/state",
      token: api.tokens.owner,
      headers: { Host: "stranger.tail1234.ts.net", Origin: "https://stranger.tail1234.ts.net" },
    });
    assert.equal(r.status, 403);
  });

  it("serves installable web app assets without a bearer token", async () => {
    const manifest = await req(port, { path: "/manifest.webmanifest", headers: { Host: tailHost } });
    const icon = await req(port, { path: "/council-icon.svg", headers: { Host: tailHost } });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.json.short_name, "Council");
    assert.equal(icon.status, 200);
    assert.match(icon.text, /<svg/);
  });

  it("rejects broad or malformed allowed host configuration", () => {
    const badHome = tempHome();
    try {
      assert.throws(
        () => createApi({ home: badHome, config: { allowed_hosts: ["*.ts.net"] } }),
        /invalid_allowed_host/
      );
    } finally {
      try { rmSync(badHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
