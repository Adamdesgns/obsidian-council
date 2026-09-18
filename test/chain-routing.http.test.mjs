// test/chain-routing.http.test.mjs — HTTP regression for ordered @chain routing
// through POST /owner/say (the Floor's entry point), with fake providers only.
//
// Defect under test: api.mjs used to call outbox.send directly with the supplied
// recipients (the Floor sends every @mention) or a codex+grok broadcast default,
// bypassing the dispatcher's chain contract (root goes only to the first member,
// chain + hop persisted on the root row). That produced parallel initial delivery
// plus later relay — duplicate / confused replies.
//
// Routing contract exercised here (shared by API and dispatcher via routing.mjs):
//   - @mentions of known members form the hop chain; root delivers to chain[0] only.
//   - Repeated mentions are legitimate hops (codex -> grok -> codex).
//   - Unknown @names are plain text, not routes. So is "@owner": the owner is
//     the floor every chain returns to, never a hop (B1).
//   - floor_returned is written only when the hop cap actually cuts a relay (B2).
//   - No mentions + explicit recipients -> those recipients.
//   - No mentions + no recipients -> codex+grok broadcast (claude only when addressed).
//   - Provider invocations (runs table) are counted separately from message
//     deliveries; no exactly-once promise for external execution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../src/api.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { parseAddressChain } from "../src/routing.mjs";

// Shipped ceilings preserved (10/15/15 daily, 2 member hops, 4 auto replies);
// only tick/timeout are tightened for test speed.
const LIMITS = {
  daily_ceiling: { claude: 10, codex: 15, grok: 15 },
  timeout_ms: { claude: 8000, codex: 8000, grok: 8000, fake: 8000 },
  dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
};

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-chain-http-"));
}

async function boot(dispatcherOpts = {}) {
  const home = tempHome();
  process.env.COUNCIL_HOME = home;
  const api = createApi({ home, config: { host: "127.0.0.1", port: 0 } });
  await new Promise((resolve, reject) => {
    api.server.listen(0, "127.0.0.1", () => resolve());
    api.server.once("error", reject);
  });
  const port = api.server.address().port;
  // Same wiring as council.mjs: dispatcher shares the API's store + outbox.
  const dispatcher = createDispatcher({
    home,
    store: api.store,
    outbox: api.outbox,
    members: ["codex", "grok"],
    tokens: api.tokens.members,
    useFake: true,
    tickMs: 40,
    timeoutMs: 8000,
    limits: LIMITS,
    defaultRespond: true,
    ...dispatcherOpts,
  });
  return { home, api, dispatcher, port, owner: api.tokens.owner };
}

async function shutdown(ctx) {
  try { ctx.dispatcher.stop(); } catch { /* */ }
  const pending = [...ctx.dispatcher.active.values()].map((m) => m.promise).filter(Boolean);
  await Promise.allSettled(pending);
  try { await ctx.api.close(); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 50));
  try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* */ }
}

async function req(port, { method = "GET", path = "/", token, body } = {}) {
  const headers = { Host: `127.0.0.1:${port}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, every = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

function memberMessages(store, chamber) {
  return store.prepare(
    `SELECT id, sender, kind, recipients, content, parent_id, created FROM messages
     WHERE chamber_id = ? AND sender IN ('codex','grok','claude') ORDER BY created ASC, id ASC`
  ).all(chamber);
}

function deliveriesFor(store, chamber) {
  return store.prepare(
    `SELECT d.id, d.recipient, d.status, m.sender, m.kind, m.content, m.id AS message_id
     FROM deliveries d JOIN messages m ON m.id = d.message_id
     WHERE m.chamber_id = ? ORDER BY d.id ASC`
  ).all(chamber);
}

function providerRuns(store, chamber) {
  return store.prepare(
    `SELECT id, member, exit FROM runs WHERE chamber_id = ? ORDER BY started ASC`
  ).all(chamber);
}

function floorReturned(store) {
  return store.getEvents()
    .filter((e) => e.kind === "floor_returned")
    .map((e) => ({ actor: e.actor, ...JSON.parse(e.payload || "{}") }));
}

async function ownerReplyFrom(store, chamber, member) {
  return waitFor(() => deliveriesFor(store, chamber).find(
    (d) => d.recipient === "owner" && d.sender === member && d.kind === "respond"
  ), { label: `${member} replies to owner` });
}

describe("HTTP chain routing through POST /owner/say (fake providers)", () => {
  it("(a) @codex plan @grok critique @codex revise routes root to codex only, then relays in order", async () => {
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "acceptance-chain";
    try {
      // Exact Floor payload shape (web/index.html send handler): the client used to
      // pre-parse every @mention into recipients. The server must still route the
      // root only to the first chain member.
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: {
          chamber_id: chamber,
          content: "@codex plan @grok critique @codex revise",
          recipients: ["codex", "grok", "codex"],
        },
      });
      assert.equal(r.status, 200);

      // 1. Root reaches ONLY codex initially; chain + hop persisted on the root row.
      assert.deepEqual(r.json.message.recipients, ["codex"], "root must deliver to first chain member only");
      const root = api.store.prepare(
        "SELECT * FROM messages WHERE id = ?"
      ).get(r.json.message.id);
      assert.deepEqual(JSON.parse(root.chain), ["codex", "grok", "codex"], "chain persisted on root");
      assert.equal(Number(root.chain_hop), 0, "root hop starts at 0");
      const rootDeliveries = api.store.prepare(
        "SELECT recipient FROM deliveries WHERE message_id = ?"
      ).all(root.id).map((d) => d.recipient);
      assert.deepEqual(rootDeliveries, ["codex"], "no parallel initial delivery to grok");

      dispatcher.start();

      // 2. Grok receives the plan (a relay from codex), and only after codex ran.
      await waitFor(() => deliveriesFor(api.store, chamber).find(
        (d) => d.recipient === "grok" && d.sender === "codex" && d.kind === "relay"
      ), { label: "grok receives codex's plan" });
      const grokInbound = deliveriesFor(api.store, chamber).filter((d) => d.recipient === "grok");
      assert.equal(grokInbound.length, 1, "grok got exactly one inbound delivery (the relay)");
      assert.equal(grokInbound[0].sender, "codex");

      // 3. Codex receives the critique (a relay from grok).
      await waitFor(() => deliveriesFor(api.store, chamber).find(
        (d) => d.recipient === "codex" && d.sender === "grok" && d.kind === "relay"
      ), { label: "codex receives grok's critique" });

      // Final hop replies to the owner.
      await waitFor(() => deliveriesFor(api.store, chamber).find(
        (d) => d.recipient === "owner" && d.sender === "codex" && d.kind === "respond"
      ), { label: "final codex reply reaches owner" });

      // Let any stray in-flight work surface before counting.
      await sleep(300);

      // 4. One visible reply per completed hop — exactly three member messages,
      //    visible through the owner's own HTTP view of the chamber.
      const visible = await req(port, {
        path: `/owner/messages?chamber_id=${chamber}`,
        token: owner,
      });
      assert.equal(visible.status, 200);
      const memberVisible = visible.json.messages.filter((m) => ["codex", "grok"].includes(m.sender));
      assert.equal(
        memberVisible.length, 3,
        "one visible reply per hop, got: " + JSON.stringify(memberVisible.map((m) => [m.sender, m.kind]))
      );
      assert.deepEqual(memberVisible.map((m) => m.sender), ["codex", "grok", "codex"], "hop order");

      // 6. Provider invocation count is recorded separately from delivery count.
      const runs = providerRuns(api.store, chamber);
      assert.deepEqual(runs.map((x) => x.member), ["codex", "grok", "codex"], "three provider invocations, in hop order");
      const allDeliveries = deliveriesFor(api.store, chamber);
      assert.equal(allDeliveries.length, 4, "root + 2 relays + final owner reply = 4 deliveries");

      // Chain hop advanced to the last index on the root row.
      const rootAfter = api.store.prepare("SELECT chain_hop FROM messages WHERE id = ?").get(root.id);
      assert.equal(Number(rootAfter.chain_hop), 2, "root chain_hop advanced to final hop");

      // Two member hops fit inside max_member_hops=2: nothing was cut, so no
      // floor_returned may be recorded.
      assert.deepEqual(floorReturned(api.store), [], "no floor_returned when the chain completes within the cap");

      const events = api.store.verifyChain();
      assert.equal(events.ok, true, JSON.stringify(events));
    } finally {
      await shutdown(ctx);
    }
  });

  it("(b) repeat submission / retry with the same idempotency_key creates no duplicate visible replies", async () => {
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "retry-chain";
    const key = "owner-say:retry-1";
    const body = {
      chamber_id: chamber,
      content: "@codex plan @grok critique @codex revise",
      idempotency_key: key,
    };
    try {
      const first = await req(port, { method: "POST", path: "/owner/say", token: owner, body });
      assert.equal(first.status, 200);
      // Immediate double-submit (e.g. double click / client retry) before processing.
      const second = await req(port, { method: "POST", path: "/owner/say", token: owner, body });
      assert.equal(second.status, 200);
      assert.equal(second.json.duplicate, true, "retry is deduplicated by idempotency_key");
      assert.equal(second.json.message.id, first.json.message.id);

      dispatcher.start();
      await waitFor(() => deliveriesFor(api.store, chamber).find(
        (d) => d.recipient === "owner" && d.kind === "respond"
      ), { label: "chain completes" });
      await sleep(300);

      // Late retry after completion must also be a no-op.
      const third = await req(port, { method: "POST", path: "/owner/say", token: owner, body });
      assert.equal(third.json.duplicate, true);
      await sleep(200);

      const roots = api.store.prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE idempotency_key = ?"
      ).get(key).c;
      assert.equal(roots, 1, "one root message despite three submissions");
      assert.equal(memberMessages(api.store, chamber).length, 3, "still one visible reply per hop");
      assert.deepEqual(providerRuns(api.store, chamber).map((x) => x.member), ["codex", "grok", "codex"],
        "still exactly three provider invocations");
    } finally {
      await shutdown(ctx);
    }
  });

  it("(c) restart between completion and new work does not re-deliver or re-run", async () => {
    const ctx = await boot();
    const { port, owner, api, dispatcher, home } = ctx;
    const chamber = "restart-chain";
    try {
      await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: chamber, content: "@codex plan @grok critique @codex revise" },
      });
      dispatcher.start();
      await waitFor(() => deliveriesFor(api.store, chamber).find(
        (d) => d.recipient === "owner" && d.kind === "respond"
      ), { label: "chain completes" });
      await sleep(200);
      const runsBefore = providerRuns(api.store, chamber).length;
      const visibleBefore = memberMessages(api.store, chamber).length;

      // Restart the dispatcher on the same home (council restart path).
      dispatcher.stop();
      const pending = [...dispatcher.active.values()].map((m) => m.promise).filter(Boolean);
      await Promise.allSettled(pending);
      const d2 = createDispatcher({
        home,
        store: api.store,
        outbox: api.outbox,
        members: ["codex", "grok"],
        tokens: api.tokens.members,
        useFake: true,
        tickMs: 40,
        timeoutMs: 8000,
        limits: LIMITS,
        defaultRespond: true,
      });
      d2.start();
      await sleep(600); // several ticks
      d2.stop();
      const p2 = [...d2.active.values()].map((m) => m.promise).filter(Boolean);
      await Promise.allSettled(p2);

      assert.equal(providerRuns(api.store, chamber).length, runsBefore, "no new provider invocations after restart");
      assert.equal(memberMessages(api.store, chamber).length, visibleBefore, "no duplicate visible replies after restart");
    } finally {
      await shutdown(ctx);
    }
  });

  it("(d) unaddressed broadcast goes to codex+grok only; claude joins only when addressed", async () => {
    const ctx = await boot();
    const { port, owner, api } = ctx;
    try {
      // No mentions, no recipients (simplified Floor payload) -> default broadcast.
      const plain = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "bcast", content: "status check please" },
      });
      assert.equal(plain.status, 200);
      assert.deepEqual([...plain.json.message.recipients].sort(), ["codex", "grok"],
        "unaddressed broadcast = codex+grok (claude's 10/day budget is not spent unaddressed)");

      // @claude routes to claude (root only, chain of one).
      const toClaude = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "bcast", content: "@claude summarize the day" },
      });
      assert.deepEqual(toClaude.json.message.recipients, ["claude"]);

      // Explicit recipients, no mentions -> honored as-is.
      const explicit = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "bcast", content: "just you", recipients: ["grok"] },
      });
      assert.deepEqual(explicit.json.message.recipients, ["grok"]);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(e) unknown @names are plain text: no route, no delivery to a nonexistent member", async () => {
    const ctx = await boot();
    const { port, owner, api } = ctx;
    try {
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "unknowns", content: "@bob please help with @mystery-tool" },
      });
      assert.equal(r.status, 200);
      assert.deepEqual([...r.json.message.recipients].sort(), ["codex", "grok"],
        "unknown mentions fall back to the default broadcast");
      const bob = api.store.prepare(
        "SELECT COUNT(*) AS c FROM deliveries WHERE recipient = 'bob'"
      ).get().c;
      assert.equal(bob, 0, "no delivery to unknown member");

      // Mixed: unknown mention alongside a known one — known member chain wins.
      const mixed = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "unknowns", content: "@bob and @grok look at this" },
      });
      assert.deepEqual(mixed.json.message.recipients, ["grok"]);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(f) repeated mention of one member is a legitimate chain (@codex then @codex)", async () => {
    const ctx = await boot();
    const { port, owner, api } = ctx;
    try {
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: "twice", content: "@codex draft it then @codex tighten it" },
      });
      assert.deepEqual(r.json.message.recipients, ["codex"]);
      const root = api.store.prepare("SELECT chain, chain_hop FROM messages WHERE id = ?").get(r.json.message.id);
      assert.deepEqual(JSON.parse(root.chain), ["codex", "codex"]);
      assert.equal(Number(root.chain_hop), 0);
    } finally {
      await shutdown(ctx);
    }
  });

  // B1 — "@owner" must never swallow a turn. The owner is the floor, not a hop:
  // nobody dispatches for it and every chain ends by replying to it anyway.
  it("(g) @owner and @codex: root goes to codex, codex runs, reply reaches the owner", async () => {
    assert.deepEqual(parseAddressChain("@owner and @codex look at this"), ["codex"]);
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "owner-mention";
    try {
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: chamber, content: "@owner and @codex look at this" },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.message.recipients, ["codex"], "root must reach codex, not the owner seat");
      const root = api.store.prepare("SELECT chain FROM messages WHERE id = ?").get(r.json.message.id);
      assert.deepEqual(JSON.parse(root.chain), ["codex"], "owner is not a chain hop");
      const toOwnerRoot = api.store.prepare(
        "SELECT COUNT(*) AS c FROM deliveries WHERE message_id = ? AND recipient = 'owner'"
      ).get(r.json.message.id).c;
      assert.equal(toOwnerRoot, 0, "the root is never delivered to the owner seat");

      dispatcher.start();
      await ownerReplyFrom(api.store, chamber, "codex");
      await sleep(300);

      assert.deepEqual(providerRuns(api.store, chamber).map((x) => x.member), ["codex"], "exactly one codex run");
      assert.deepEqual(memberMessages(api.store, chamber).map((m) => [m.sender, m.kind]), [["codex", "respond"]]);
      assert.deepEqual(floorReturned(api.store), []);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(h) @codex draft @owner check @grok ship runs codex then grok; nothing relays into the owner seat", async () => {
    assert.deepEqual(parseAddressChain("@codex draft @owner check @grok ship"), ["codex", "grok"]);
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "owner-mid-chain";
    try {
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: chamber, content: "@codex draft @owner check @grok ship" },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.message.recipients, ["codex"]);
      const root = api.store.prepare("SELECT chain, chain_hop FROM messages WHERE id = ?").get(r.json.message.id);
      assert.deepEqual(JSON.parse(root.chain), ["codex", "grok"]);
      assert.equal(Number(root.chain_hop), 0);

      dispatcher.start();
      await ownerReplyFrom(api.store, chamber, "grok");
      await sleep(300);

      assert.deepEqual(providerRuns(api.store, chamber).map((x) => x.member), ["codex", "grok"], "codex then grok, one run each");
      const deliveries = deliveriesFor(api.store, chamber).map((d) => [d.sender, d.kind, d.recipient]);
      assert.deepEqual(deliveries, [
        ["owner", "say", "codex"],
        ["codex", "relay", "grok"],
        ["grok", "respond", "owner"],
      ], "root -> codex, codex relays to grok, grok answers the owner");
      assert.equal(Number(
        api.store.prepare("SELECT chain_hop FROM messages WHERE id = ?").get(r.json.message.id).chain_hop
      ), 1);
      assert.deepEqual(floorReturned(api.store), []);
    } finally {
      await shutdown(ctx);
    }
  });

  // B2 — floor_returned is a record that a relay was actually suppressed by the
  // hop cap. It must be written exactly then, and never otherwise.
  it("(i) chain beyond the cap: one floor_returned, the next hop never runs, reply returns to the owner", async () => {
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "over-cap";
    try {
      const r = await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: chamber, content: "@codex a @grok b @codex c @grok d" },
      });
      assert.deepEqual(JSON.parse(
        api.store.prepare("SELECT chain FROM messages WHERE id = ?").get(r.json.message.id).chain
      ), ["codex", "grok", "codex", "grok"]);

      dispatcher.start();
      // Third hop (codex) is at max_member_hops=2: its relay to grok is cut and
      // it answers the owner instead.
      await ownerReplyFrom(api.store, chamber, "codex");
      await sleep(400);

      assert.deepEqual(providerRuns(api.store, chamber).map((x) => x.member), ["codex", "grok", "codex"],
        "the fourth hop (grok again) is never invoked");
      assert.deepEqual(deliveriesFor(api.store, chamber).map((d) => [d.sender, d.kind, d.recipient]), [
        ["owner", "say", "codex"],
        ["codex", "relay", "grok"],
        ["grok", "relay", "codex"],
        ["codex", "respond", "owner"],
      ]);
      const third = deliveriesFor(api.store, chamber).find((d) => d.sender === "grok" && d.kind === "relay");
      assert.deepEqual(floorReturned(api.store), [
        { actor: "codex", reason: "hop_cap", chamber, truncated_next: "grok" },
      ], "exactly one floor_returned, for the one relay that was cut");
      assert.equal(
        api.store.getEvents().find((e) => e.kind === "floor_returned").ref_id, third.message_id,
        "floor_returned points at the message whose relay was cut"
      );
    } finally {
      await shutdown(ctx);
    }
  });

  it("(j) member at the cap answers the owner itself: nothing is cut, so no floor_returned", async () => {
    const ctx = await boot({
      // Stand-in for a provider whose own output addresses the owner: the third
      // hop (codex answering grok's relay) replies to the owner directly.
      scriptedOutbound: (member, message) => (
        member === "codex" && message.sender === "grok"
          ? [{ kind: "respond", recipient: "owner", content: "shipped" }]
          : null
      ),
    });
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "self-answered";
    try {
      await req(port, {
        method: "POST",
        path: "/owner/say",
        token: owner,
        body: { chamber_id: chamber, content: "@codex a @grok b @codex c @grok d" },
      });
      dispatcher.start();
      await ownerReplyFrom(api.store, chamber, "codex");
      await sleep(400);

      assert.deepEqual(providerRuns(api.store, chamber).map((x) => x.member), ["codex", "grok", "codex"]);
      const final = deliveriesFor(api.store, chamber).filter((d) => d.recipient === "owner");
      assert.deepEqual(final.map((d) => [d.sender, d.kind, d.content]), [["codex", "respond", "shipped"]],
        "the member's own answer is what reached the owner");
      assert.deepEqual(floorReturned(api.store), [], "no relay was suppressed, so no floor_returned");
    } finally {
      await shutdown(ctx);
    }
  });
});
