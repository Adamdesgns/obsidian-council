// test/floor-send.test.mjs — the Floor's Say button is idempotent per submission.
//
// The page's real inline <script> from web/index.html runs in a node:vm sandbox
// with a minimal DOM, so the handler under test is the one the browser runs, not
// a re-implementation. Fake providers only; temp COUNCIL_HOME only.
//
// Contract (B3):
//   - one submission = one idempotency key; a click while the request is in
//     flight is ignored, so a double-click yields one root message and one set
//     of provider runs;
//   - a retry of the same (chamber, content) after a network error reuses the
//     key, so the server dedupes it if the first request did land;
//   - only new text (or a new chamber) mints a new key; empty text sends nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApi } from "../src/api.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML = readFileSync(join(ROOT, "web", "index.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

const LIMITS = {
  daily_ceiling: { claude: 10, codex: 15, grok: 15 },
  timeout_ms: { claude: 8000, codex: 8000, grok: 8000, fake: 8000 },
  dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
};

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

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "council-floor-send-"));
  process.env.COUNCIL_HOME = home;
  const api = createApi({ home, config: { host: "127.0.0.1", port: 0 } });
  await new Promise((resolve, reject) => {
    api.server.listen(0, "127.0.0.1", () => resolve());
    api.server.once("error", reject);
  });
  const port = api.server.address().port;
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
  });
  return { home, api, dispatcher, port, owner: api.tokens.owner };
}

async function shutdown(ctx) {
  try { ctx.dispatcher.stop(); } catch { /* */ }
  await Promise.allSettled([...ctx.dispatcher.active.values()].map((m) => m.promise).filter(Boolean));
  try { await ctx.api.close(); } catch { /* */ }
  await sleep(50);
  try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* */ }
}

/** Minimal DOM + browser globals for web/index.html's script. */
function loadFloor({ origin, ownerToken, fetch: fetchImpl }) {
  const els = new Map();
  function element(id) {
    if (!els.has(id)) {
      els.set(id, {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        disabled: false,
        scrollTop: 0,
        scrollHeight: 0,
        onclick: null,
        children: [],
        addEventListener() {},
        appendChild(child) { this.children.push(child); },
      });
    }
    return els.get(id);
  }
  const storage = new Map([["council.ownerToken", ownerToken]]);
  const sandbox = {
    document: {
      getElementById: element,
      createElement: (tag) => ({ tag, textContent: "", innerHTML: "", value: "", selected: false, appendChild() {} }),
    },
    location: { origin, hash: "", pathname: "/" },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    EventSource: class { close() {} },
    // The 3 s state/messages poll loop is not under test; keep the process free.
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "web/index.html#script" });
  return { el: element, sandbox };
}

describe("Floor Say button idempotency (real web/index.html script, fake providers)", () => {
  it("(a) a double-click is one submission: one root message, one chain of provider runs", async () => {
    const ctx = await boot();
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "double-click";
    try {
      const { el } = loadFloor({ origin: `http://127.0.0.1:${port}`, ownerToken: owner, fetch });
      await sleep(50); // let the page's initial refresh() settle

      el("chamberSelect").value = chamber;
      el("say").value = "@codex plan @grok critique @codex revise";
      const send = el("send");
      assert.equal(typeof send.onclick, "function", "Say handler installed by the page script");

      // Two clicks before the first request has returned.
      const first = send.onclick();
      const disabledInFlight = send.disabled;
      const second = send.onclick();
      await Promise.allSettled([first, second]);

      const roots = api.store.prepare(
        "SELECT id, idempotency_key, recipients FROM messages WHERE chamber_id = ? AND sender = 'owner'"
      ).all(chamber);
      assert.equal(roots.length, 1, "double-click must produce exactly one root message");
      assert.equal(disabledInFlight, true, "button disabled while the submission is in flight");
      assert.match(roots[0].idempotency_key, /^floor:[0-9a-f-]{36}$/);
      assert.deepEqual(JSON.parse(roots[0].recipients), ["codex"]);
      assert.equal(el("say").value, "", "composer cleared after the server accepted the submission");
      assert.equal(send.disabled, false);

      dispatcher.start();
      await waitFor(() => api.store.prepare(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE m.chamber_id = ? AND d.recipient = 'owner' AND m.kind = 'respond'`
      ).get(chamber), { label: "chain completes" });
      await sleep(300);

      const runs = api.store.prepare(
        "SELECT member FROM runs WHERE chamber_id = ? ORDER BY started ASC"
      ).all(chamber).map((r) => r.member);
      assert.deepEqual(runs, ["codex", "grok", "codex"], "one chain of provider runs, not two");
      const memberMsgs = api.store.prepare(
        "SELECT sender FROM messages WHERE chamber_id = ? AND sender IN ('codex','grok') ORDER BY created ASC, id ASC"
      ).all(chamber).map((m) => m.sender);
      assert.deepEqual(memberMsgs, ["codex", "grok", "codex"]);

      // Empty composer: a click sends nothing.
      await send.onclick();
      // New text: a new submission with a new key.
      el("say").value = "@grok status";
      await send.onclick();
      const after = api.store.prepare(
        "SELECT idempotency_key, recipients FROM messages WHERE chamber_id = ? AND sender = 'owner' ORDER BY created ASC, rowid ASC"
      ).all(chamber);
      assert.equal(after.length, 2, "one more root for the new text, none for the empty click");
      assert.notEqual(after[1].idempotency_key, after[0].idempotency_key);
      assert.deepEqual(JSON.parse(after[1].recipients), ["grok"]);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(b) a retry after a network error reuses the same key; new text mints a new one", async () => {
    const calls = [];
    let failNextSay = true;
    const ok = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
    const fakeFetch = async (url, opts = {}) => {
      const path = new URL(url).pathname;
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method: opts.method || "GET", path, body });
      if (path === "/owner/say") {
        if (failNextSay) { failNextSay = false; throw new TypeError("fetch failed"); }
        return ok({ message: { id: "m-" + calls.length, idempotency_key: body.idempotency_key }, duplicate: false });
      }
      if (path === "/owner/messages") return ok({ messages: [] });
      return ok({ halt: false, chambers: [], members: [] });
    };
    const { el } = loadFloor({ origin: "http://127.0.0.1:1", ownerToken: "t".repeat(64), fetch: fakeFetch });
    await sleep(10);

    el("chamberSelect").value = "retry";
    el("say").value = "@codex once";
    const send = el("send");

    await send.onclick(); // network error
    assert.equal(el("say").value, "@codex once", "text kept so the owner can retry");
    assert.match(el("log").textContent, /say error: fetch failed/);
    assert.equal(send.disabled, false);

    await send.onclick(); // retry, same text
    assert.equal(el("say").value, "", "cleared once the server accepted it");

    el("say").value = "@grok twice";
    await send.onclick();

    const says = calls.filter((c) => c.method === "POST" && c.path === "/owner/say").map((c) => c.body);
    assert.equal(says.length, 3);
    assert.deepEqual(says.map((b) => b.content), ["@codex once", "@codex once", "@grok twice"]);
    assert.deepEqual(says.map((b) => b.chamber_id), ["retry", "retry", "retry"]);
    assert.equal(says[0].idempotency_key, says[1].idempotency_key, "retry of the same submission reuses its key");
    assert.notEqual(says[2].idempotency_key, says[0].idempotency_key, "new text is a new submission");
    for (const b of says) {
      assert.match(b.idempotency_key, /^floor:[0-9a-f-]{36}$/);
      assert.equal("recipients" in b, false, "the Floor no longer pre-parses mentions into recipients");
    }
  });
});
