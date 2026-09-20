// test/floor-deliberate.test.mjs — the Floor's Deliberation panel drives the engine.
//
// Same harness as floor-send.test.mjs: web/index.html's real inline <script>
// runs in a node:vm sandbox with a minimal DOM against the real loopback API and
// a fake dispatcher, so the handlers under test are the ones the browser runs.
//
// Contract:
//   - Deliberate posts the question to /owner/deliberate with the selected
//     chamber and no deliberators (the server picks them); a click while the
//     request is in flight is ignored; empty text sends nothing;
//   - the panel polls GET /owner/deliberation/:id and renders state, answer and
//     every reply from `answers.__history` as text, never as HTML;
//   - Approve needs two clicks, then sanctions the exact answer on screen and
//     settles; Overrule posts the owner's own text and closes the row;
//   - GET /owner/deliberations lists rows newest first, optionally per chamber.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApi } from "../src/api.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { startDeliberation, advanceOnReply, deliberationKey } from "../src/deliberation.mjs";
import { contentHash } from "../src/sanctions.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML = readFileSync(join(ROOT, "web", "index.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

const LIMITS = {
  daily_ceiling: { anthropic: 100, codex: 100, grok: 100 },
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

async function boot({ scriptedReply } = {}) {
  const home = mkdtempSync(join(tmpdir(), "council-floor-delib-"));
  process.env.COUNCIL_HOME = home;
  const api = createApi({ home, config: { host: "127.0.0.1", port: 0 }, limits: LIMITS });
  await new Promise((resolve, reject) => {
    api.server.listen(0, "127.0.0.1", () => resolve());
    api.server.once("error", reject);
  });
  const port = api.server.address().port;
  const dispatcher = createDispatcher({
    home,
    store: api.store,
    outbox: api.outbox,
    members: ["codex", "fable"],
    tokens: api.tokens.members,
    useFake: true,
    tickMs: 40,
    timeoutMs: 8000,
    limits: LIMITS,
    defaultRespond: true,
    scriptedReply,
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
      const node = {
        id,
        value: "",
        textContent: "",
        className: "",
        disabled: false,
        hidden: false,
        scrollTop: 0,
        scrollHeight: 0,
        onclick: null,
        children: [],
        addEventListener() {},
        appendChild(child) { this.children.push(child); },
      };
      // Like the DOM, `innerHTML = ""` drops the children the page appended.
      let html = "";
      Object.defineProperty(node, "innerHTML", {
        get() { return html; },
        set(v) { html = String(v); if (html === "") node.children = []; },
      });
      els.set(id, node);
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
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "web/index.html#script" });
  return { el: element, sandbox, storage };
}

const rowOf = (store, id) => store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
const latestTo = (store, m) => store.prepare("SELECT * FROM messages WHERE recipients LIKE ? ORDER BY created DESC, rowid DESC").get(`%"${m}"%`);

describe("Floor Deliberation panel (real web/index.html script, fake providers)", () => {
  it("(a) Deliberate opens one row, the panel follows it to pending_owner, two clicks approve it behind a sanction", async () => {
    const ctx = await boot({
      scriptedReply: (member, message) =>
        /debate round/i.test(String(message?.content || ""))
          ? "looks right to me <b>bold</b>\nAGREE: cache the chain in memory"
          : `independent answer from ${member} <script>alert(1)</script>`,
    });
    const { port, owner, api, dispatcher } = ctx;
    const chamber = "delib-chamber";
    try {
      const { el, sandbox, storage } = loadFloor({ origin: `http://127.0.0.1:${port}`, ownerToken: owner, fetch });
      await sleep(50);

      el("chamberSelect").value = chamber;
      const btn = el("deliberate");
      assert.equal(typeof btn.onclick, "function", "Deliberate handler installed by the page script");

      // Empty question: nothing sent.
      await btn.onclick();
      assert.equal(api.store.prepare("SELECT COUNT(*) AS c FROM deliberations").get().c, 0);

      el("delibQuestion").value = "  should we cache the chain?  ";
      const first = btn.onclick();
      const disabledInFlight = btn.disabled;
      const second = btn.onclick();
      await Promise.allSettled([first, second]);
      assert.equal(disabledInFlight, true, "button disabled while the request is in flight");
      assert.equal(btn.disabled, false);

      const rows = api.store.prepare("SELECT * FROM deliberations").all();
      assert.equal(rows.length, 1, "a double-click opens exactly one deliberation");
      const id = rows[0].id;
      assert.equal(rows[0].chamber_id, chamber);
      assert.equal(rows[0].question, "should we cache the chain?", "trimmed");
      assert.deepEqual(JSON.parse(rows[0].deliberators), ["codex", "fable"], "server-side default, the page sent none");
      assert.equal(el("delibQuestion").value, "", "composer cleared once accepted");
      assert.equal(storage.get("council.deliberation"), id, "the new row is selected and remembered");
      assert.match(el("log").textContent, new RegExp("deliberation " + id.slice(0, 8) + " opened \\(answer_1\\)"));
      assert.match(el("delibStatus").textContent, /^answer_1\n/);
      assert.match(el("delibStatus").textContent, /Q: should we cache the chain\?/);
      assert.equal(el("delibApprove").hidden, true, "nothing to approve yet");
      assert.equal(el("delibOverruleBox").hidden, false, "a live row can still be overruled");

      dispatcher.start();
      await waitFor(() => rowOf(api.store, id).state === "pending_owner", { label: "engine reaches pending_owner" });
      const row = rowOf(api.store, id);
      assert.equal(row.flag, "agreed");
      assert.equal(row.final_answer, "cache the chain in memory");

      // The poll the browser runs every 3 s (setInterval is stubbed out here).
      await sandbox.pollDeliberation();
      const status = el("delibStatus").textContent;
      assert.match(status, /^pending_owner \/ agreed\n/);
      assert.match(status, /ANSWER:\ncache the chain in memory/);
      assert.equal(el("delibApprove").hidden, false, "Approve offered for an agreed answer");
      const history = el("delibAnswers").children;
      assert.equal(history.length, 4, "two blind answers + one debate round of two replies");
      assert.match(history[0].textContent, /^\[answer_1\] codex\nindependent answer from codex <script>alert\(1\)<\/script>$/);
      assert.match(history[1].textContent, /^\[answer_2\] fable\n/);
      assert.match(history[2].textContent, /^\[debate r1\] (codex|fable) → AGREE\n/);
      for (const li of history) assert.equal(li.innerHTML, "", "model text is rendered as text, never HTML");
      assert.equal(el("delibAnswers").innerHTML, "", "the list itself is cleared then rebuilt with nodes");

      // Approve: first click arms, second click sanctions + settles.
      const approve = el("delibApprove");
      await approve.onclick();
      assert.match(approve.textContent, /Click again/);
      assert.equal(rowOf(api.store, id).state, "pending_owner", "one click does not approve");
      assert.equal(api.store.prepare("SELECT COUNT(*) AS c FROM sanctions").get().c, 0, "no sanction minted by arming");

      await approve.onclick();
      const settled = rowOf(api.store, id);
      assert.equal(settled.state, "settled");
      assert.equal(settled.content_hash, contentHash("cache the chain in memory"));
      const sanctions = api.store.prepare("SELECT * FROM sanctions").all();
      assert.equal(sanctions.length, 1, "exactly one sanction, minted for the approve");
      assert.equal(sanctions[0].content_hash, contentHash("cache the chain in memory"), "bound to the answer on screen");
      assert.ok(sanctions[0].used_at, "single use: consumed by the approve");
      assert.ok(sanctions[0].expires_at, "short-lived");
      assert.match(el("log").textContent, new RegExp("deliberation " + id.slice(0, 8) + " settled \\(sanction "));
      assert.match(el("delibStatus").textContent, /^settled \/ agreed\n/);
      assert.equal(el("delibApprove").hidden, true);
      assert.equal(el("delibOverruleBox").hidden, true, "closed rows cannot be overruled");
      assert.equal(api.store.verifyChain().ok, true);

      // A third click on a settled row is a no-op: no second sanction, no error.
      await approve.onclick();
      assert.equal(api.store.prepare("SELECT COUNT(*) AS c FROM sanctions").get().c, 1);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(b) a deadlock offers no Approve; Overrule posts the owner's own answer and closes the row; the list shows every row", async () => {
    const ctx = await boot();
    const { port, owner, api } = ctx;
    try {
      // Drive a row to deadlock without the dispatcher, then a second live row.
      const dl = startDeliberation(api.store, api.outbox, { chamber_id: "c1", question: "deadlock me", deliberators: ["codex", "fable"], limits: LIMITS });
      const first = api.store.prepare("SELECT * FROM messages WHERE idempotency_key = ?").get(deliberationKey(dl.id, "answer_1", 0, "codex"));
      advanceOnReply(api.store, api.outbox, { message: first, member: "codex", text: "A" });
      advanceOnReply(api.store, api.outbox, { message: latestTo(api.store, "fable"), member: "fable", text: "B" });
      for (let r = 0; r < 3; r++) {
        advanceOnReply(api.store, api.outbox, { message: latestTo(api.store, "codex"), member: "codex", text: "DISAGREE: no" });
        advanceOnReply(api.store, api.outbox, { message: latestTo(api.store, "fable"), member: "fable", text: "DISAGREE: no" });
      }
      assert.equal(rowOf(api.store, dl.id).flag, "deadlock", "setup");
      await sleep(5); // distinct `created` so the list order is deterministic
      const live = startDeliberation(api.store, api.outbox, { chamber_id: "c2", question: "still running", deliberators: ["codex", "fable"], limits: LIMITS });

      const { el, sandbox, storage } = loadFloor({ origin: `http://127.0.0.1:${port}`, ownerToken: owner, fetch });
      // Newest first; with nothing remembered the page selects the newest row.
      await waitFor(() => storage.get("council.deliberation") === live.id && /^answer_1\n/.test(el("delibStatus").textContent),
        { label: "initial list + auto-select poll" });
      const options = el("delibSelect").children;
      assert.equal(options.length, 2);
      assert.equal(options[0].value, live.id);
      assert.match(options[0].textContent, /^\[answer_1\] still running$/);
      assert.equal(options[1].value, dl.id);
      assert.match(options[1].textContent, /^\[pending_owner\/deadlock\] deadlock me$/);
      assert.equal(storage.get("council.deliberation"), live.id);

      // Pick the deadlocked row, as the <select> change handler does.
      await sandbox.selectDeliberation(dl.id);
      assert.match(el("delibStatus").textContent, /^pending_owner \/ deadlock\n/);
      assert.match(el("delibStatus").textContent, /No agreed answer \(deadlock\)\. Write your own below to overrule\./);
      assert.equal(el("delibApprove").hidden, true, "nothing to approve");
      assert.equal(el("delibOverruleBox").hidden, false);
      assert.equal(el("delibAnswers").children.length, 8, "2 blind + 3 rounds x 2 replies");
      assert.match(el("delibAnswers").children[7].textContent, /^\[debate r3\] fable → DISAGREE\nDISAGREE: no$/);

      // Overrule: empty text sends nothing.
      const overrule = el("delibOverrule");
      assert.equal(typeof overrule.onclick, "function");
      await overrule.onclick();
      assert.equal(rowOf(api.store, dl.id).state, "pending_owner");

      el("delibOverruleText").value = "  cache nothing; measure first  ";
      await overrule.onclick();
      const row = rowOf(api.store, dl.id);
      assert.equal(row.state, "overruled");
      assert.equal(row.final_answer, "cache nothing; measure first");
      assert.equal(row.content_hash, contentHash("cache nothing; measure first"));
      assert.equal(row.flag, "deadlock", "how it reached the owner is kept");
      assert.equal(api.store.prepare("SELECT COUNT(*) AS c FROM sanctions").get().c, 0, "overrule needs no sanction");
      assert.equal(el("delibOverruleText").value, "", "cleared once accepted");
      assert.match(el("log").textContent, new RegExp("deliberation " + dl.id.slice(0, 8) + " overruled \\(hash "));
      assert.match(el("delibStatus").textContent, /^overruled \/ deadlock\n/);
      assert.match(el("delibStatus").textContent, /ANSWER:\ncache nothing; measure first/);
      assert.equal(el("delibOverruleBox").hidden, true);
      assert.match(el("delibSelect").children[1].textContent, /^\[overruled\/deadlock\]/, "list label follows the state");

      // The list route: summary columns only, newest first, per-chamber filter.
      const headers = { Authorization: `Bearer ${owner}` };
      const all = await (await fetch(`http://127.0.0.1:${port}/owner/deliberations`, { headers })).json();
      assert.deepEqual(all.deliberations.map((d) => d.id), [live.id, dl.id]);
      assert.equal("answers" in all.deliberations[0], false, "answers stay on the per-row GET");
      assert.deepEqual(Object.keys(all.deliberations[1]).sort(), ["category", "chamber_id", "created", "final_answer", "flag", "id", "question", "round", "state", "updated"]);
      const c1 = await (await fetch(`http://127.0.0.1:${port}/owner/deliberations?chamber_id=c1`, { headers })).json();
      assert.deepEqual(c1.deliberations.map((d) => d.id), [dl.id]);
      const asMember = await fetch(`http://127.0.0.1:${port}/owner/deliberations`, { headers: { Authorization: `Bearer ${api.tokens.members.codex}` } });
      assert.equal(asMember.status, 403, "owner only");
      const noToken = await fetch(`http://127.0.0.1:${port}/owner/deliberations`);
      assert.equal(noToken.status, 401);
      assert.equal(api.store.verifyChain().ok, true);
    } finally {
      await shutdown(ctx);
    }
  });

  it("(c) engine refusals are readable on the Floor, and the page stays quiet when the API has no deliberations", async () => {
    const calls = [];
    const ok = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
    const fakeFetch = async (url, opts = {}) => {
      const path = new URL(url).pathname;
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method: opts.method || "GET", path, body });
      if (path === "/owner/deliberate") {
        return { ok: false, status: 409, text: async () => JSON.stringify({ ok: false, reason: "insufficient_budget", member: "fable", account: "anthropic", remaining: 3, needed: 4 }) };
      }
      if (path === "/owner/deliberations") return ok({ deliberations: [] });
      if (path === "/owner/messages") return ok({ messages: [] });
      return ok({ halt: false, chambers: [], members: [] });
    };
    const { el } = loadFloor({ origin: "http://127.0.0.1:1", ownerToken: "t".repeat(64), fetch: fakeFetch });
    await sleep(10);

    assert.equal(calls.filter((c) => c.path === "/owner/deliberations").length, 1, "the list is fetched once on load");
    assert.equal(calls.filter((c) => c.path.startsWith("/owner/deliberation/")).length, 0, "no row remembered, no row polled");

    el("chamberSelect").value = "budget";
    el("delibQuestion").value = "spend?";
    await el("deliberate").onclick();
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/owner/deliberate");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { chamber_id: "budget", content: "spend?" }, "no deliberators, no category: the server decides");
    assert.match(el("log").textContent, /deliberate error: insufficient_budget: fable has 3 run\(s\) left today on anthropic, needs 4/);
    assert.equal(el("delibQuestion").value, "spend?", "question kept so the owner can retry later");
  });
});
