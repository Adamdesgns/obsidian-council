// scripts/live-proof.mjs — P2-6c official live runner (attempt 2).
// Run ONCE with COUNCIL_LIVE=1. Hard cap 6 Codex+Grok runs. Do not re-run without Claude.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "../src/api.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { openStore } from "../src/store.mjs";

if (process.env.COUNCIL_LIVE !== "1") {
  console.error("Refusing: set COUNCIL_LIVE=1");
  process.exit(2);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(ROOT, "docs", "evidence", "phase2-live.md");
const MAX = 6;
const LINE = "@codex write a 5-line plan for a Node CLI that prints today's date in ISO format. @grok critique that plan in at most 5 numbered points. @codex revise the plan in 5 lines using the critique.";

const home = join(process.env.LOCALAPPDATA, "ObsidianCouncil", "live-proof-" + Date.now()); // always fresh; ignore inherited COUNCIL_HOME
mkdirSync(home, { recursive: true });
process.env.COUNCIL_HOME = home;

const limits = {
  daily_ceiling: { claude: 0, codex: MAX, grok: MAX },
  timeout_ms: { codex: 180000, grok: 180000 },
  dispatcher: { tick_ms: 2000, max_member_hops: 4, max_auto_replies_per_owner_turn: 6 },
};

const api = createApi({ home, config: { host: "127.0.0.1", port: 0 } });
await new Promise((resolve, reject) => {
  api.server.listen(0, "127.0.0.1", resolve);
  api.server.once("error", reject);
});
const port = api.server.address().port;
const apiBase = `http://127.0.0.1:${port}`;
process.env.COUNCIL_API_BASE = apiBase;

const tokens = {
  codex: api.tokens.members.codex,
  grok: api.tokens.members.grok,
};

function makeDispatcher(store, outbox) {
  return createDispatcher({
    home,
    store: store || undefined,
    outbox: outbox || undefined,
    useFake: false,
    members: ["codex", "grok"],
    tokens,
    apiBase,
    tickMs: 2000,
    timeoutMs: 180000,
    limits,
    defaultRespond: true,
  });
}

let d = makeDispatcher(api.store, api.outbox);

const log = [];
const note = (s) => { log.push(new Date().toISOString() + " " + s); console.error(s); };

const chamber = await (async () => {
  const r = api.store.commit("chamber_created", "owner", (a) => {
    const id = a.uuid();
    a.prepare("INSERT INTO chambers(id,title,created,status) VALUES(?,?,?,?)").run(id, "live-proof", a.nowIso(), "open");
    a.setRef("chambers", id, {});
    return { id };
  });
  return r.result.id;
})();

note("chamber " + chamber);
d.outbox.send({
  sender: "owner",
  recipients: ["codex", "grok"],
  chamber_id: chamber,
  kind: "summon",
  content: "You are summoned.",
  idempotency_key: "live-summon",
});

d.ownerSay({
  chamber_id: chamber,
  content: LINE,
  idempotency_key: "live-owner-chain",
});

d.start();
note("dispatcher started");

let restarted = false;
const t0 = Date.now();
while (Date.now() - t0 < 15 * 60_000) {
  await new Promise((r) => setTimeout(r, 2000));
  const runs = api.store.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE member IN ('codex','grok')"
  ).get().c;
  const chainMemberMsgs = api.store.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE chamber_id=? AND sender IN ('codex','grok') AND kind IN ('respond','relay')
       AND idempotency_key NOT LIKE 'live-summon%'`
  ).get(chamber).c;
  const toOwner = api.store.prepare(
    `SELECT COUNT(*) AS c FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE d.recipient='owner' AND m.chamber_id=? AND m.kind IN ('respond','relay')
       AND m.sender IN ('codex','grok')`
  ).get(chamber).c;
  note(`runs=${runs} chainMemberMsgs=${chainMemberMsgs} toOwner=${toOwner} restarted=${restarted}`);
  if (runs >= MAX) { note("hit run cap"); break; }
  // Restart after the first chain reply lands, once a follow-on run is in flight.
  if (!restarted && chainMemberMsgs >= 1) {
    const inflight = api.store.prepare(
      "SELECT id FROM runs WHERE ended IS NULL AND member IN ('codex','grok') LIMIT 1"
    ).get();
    if (!inflight) {
      // give the next hop a moment to spawn
      continue;
    }
    note("restart after first chain reply (hardStop mid follow-on run " + inflight.id + ")");
    d.hardStop();
    restarted = true;
    d = makeDispatcher(api.store, api.outbox);
    d.start();
    note("dispatcher restarted");
  }
  if (restarted && chainMemberMsgs >= 3 && toOwner >= 1) {
    await new Promise((r) => setTimeout(r, 3000));
    break;
  }
}

d.stop();
try { await d.close(); } catch { /* */ }

const store = openStore({ home });
const runs = store.prepare(
  "SELECT id, member, started, ended, exit, checkpoint FROM runs WHERE member IN ('codex','grok') ORDER BY started"
).all();
const messages = store.prepare(
  "SELECT id, kind, sender, content FROM messages WHERE chamber_id=? ORDER BY created"
).all(chamber);
const memberMsgs = messages.filter((m) => m.sender === "codex" || m.sender === "grok").filter((m) => m.kind === "respond" || m.kind === "relay");
const deliveries = store.prepare(
  `SELECT d.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.chamber_id=?`
).all(chamber);
const chain = store.verifyChain();

function bridgeOf(run) {
  try {
    const cp = JSON.parse(run.checkpoint || "{}");
    return cp.bridge || "unknown";
  } catch {
    return "unknown";
  }
}

function isAdapterFinalText(content) {
  const t = String(content || "").trim();
  if (t.length < 40) return false;
  if (t.startsWith("{") || t.startsWith("[")) return false;
  return true;
}

const failed = [];
// Fence markers (exit=interrupted) are not model completions; require exit===0 on the rest.
const modelRuns = runs.filter((r) => String(r.exit) !== "interrupted");
if (!modelRuns.every((r) => Number(r.exit) === 0)) {
  failed.push("every codex/grok run exit===0 (excl. interrupted); got: " + modelRuns.map((r) => `${r.member}:${r.exit}`).join(", "));
}
const textMsgs = memberMsgs.filter((m) => isAdapterFinalText(m.content));
if (textMsgs.length < 3) {
  failed.push(`three member messages with adapter final text (len>=40, not JSON); got ${textMsgs.length} of ${memberMsgs.length}`);
}
const gen2 = deliveries.some((d) => d.status === "answered" && Number(d.attempt_gen) >= 2);
if (!gen2) {
  failed.push("at least one delivery answered with attempt_gen>=2");
}
if (!chain.ok) {
  failed.push("verifyChain().ok");
}
if (modelRuns.length > MAX) {
  failed.push(`runs <= ${MAX} (got ${modelRuns.length} model runs, ${runs.length} total incl interrupted)`);
}

const verdict = failed.length === 0 ? "PASS" : "FAIL";

const md = `# Phase 2 live proof (P2-6c attempt 2)

- At: ${new Date().toISOString()} (UTC)
- Home: \`${home}\`
- Line: ${LINE}
- Restarted after first chain reply: ${restarted}
- Runs: ${runs.length} / ${MAX} (model runs excl. interrupted: ${modelRuns.length})
- Chain ok: ${chain.ok}
- **Verdict: ${verdict}**
${failed.length ? failed.map((f) => `  - FAIL condition: ${f}`).join("\n") : "  - all strict PASS conditions met"}

## Run IDs (with bridge status)

${runs.map((r) => `- ${r.id} ${r.member} exit=${r.exit} bridge=${bridgeOf(r)} started=${r.started}`).join("\n") || "(none)"}

## Floor messages (first 300 chars)

${messages.map((m) => {
  const snippet = String(m.content || "").slice(0, 300);
  return `- **${m.kind}** from ${m.sender}: ${JSON.stringify(snippet)}`;
}).join("\n")}

## Deliveries (answered / gens)

${deliveries.map((d) => `- id=${d.id} recipient=${d.recipient} status=${d.status} gen=${d.attempt_gen}`).join("\n")}

## Log

\`\`\`
${log.join("\n")}
\`\`\`
`;
writeFileSync(EVIDENCE, md.replace(/\r?\n/g, "\n"), "utf8");
store.close();
await api.close();
console.log(md);
console.error("wrote " + EVIDENCE);
console.error("Verdict: " + verdict);
process.exit(verdict === "PASS" ? 0 : 1);