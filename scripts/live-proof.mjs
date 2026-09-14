// scripts/live-proof.mjs — P2-6b official live runner.
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

const home = process.env.COUNCIL_HOME || join(process.env.LOCALAPPDATA, "ObsidianCouncil", "live-proof-" + Date.now());
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

let d = createDispatcher({
  home,
  store: api.store,
  outbox: api.outbox,
  useFake: false,
  members: ["codex", "grok"],
  tokens,
  apiBase,
  tickMs: 2000,
  timeoutMs: 180000,
  limits,
  defaultRespond: true,
});

const log = [];
const note = (s) => { log.push(new Date().toISOString() + " " + s); console.error(s); };

const chamber = await (async () => {
  // use store commit via owner path
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
  const toOwner = api.store.prepare(
    `SELECT COUNT(*) AS c FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE d.recipient='owner' AND m.chamber_id=? AND m.kind IN ('respond','relay')`
  ).get(chamber).c;
  note(`runs=${runs} toOwner=${toOwner} restarted=${restarted}`);
  if (runs >= MAX) { note("hit run cap"); break; }
  if (!restarted && toOwner >= 1) {
    note("restart after first reply");
    d.stop();
    await d.close();
    restarted = true;
    d = createDispatcher({
      home,
      useFake: false,
      members: ["codex", "grok"],
      tokens,
      apiBase,
      tickMs: 2000,
      timeoutMs: 180000,
      limits,
      defaultRespond: true,
    });
    d.start();
    note("dispatcher restarted");
  }
  // done when chain complete: last respond to owner after 3 member hops
  const memberMsgs = api.store.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE chamber_id=? AND sender IN ('codex','grok')"
  ).get(chamber).c;
  if (restarted && memberMsgs >= 3 && toOwner >= 1) {
    // wait one more settle
    await new Promise((r) => setTimeout(r, 3000));
    break;
  }
}

d.stop();
try { await d.close(); } catch { /* */ }

const store = openStore({ home });
const runs = store.prepare("SELECT id, member, started, ended, exit, checkpoint FROM runs ORDER BY started").all();
const messages = store.prepare(
  "SELECT id, kind, sender, substr(content,1,300) AS content FROM messages WHERE chamber_id=? ORDER BY created"
).all(chamber);
const chain = store.verifyChain();
store.close();
await api.close();

const md = `# Phase 2 live proof (P2-6b runner)

- At: ${new Date().toISOString()} (UTC)
- Home: \`${home}\`
- Line: ${LINE}
- Restarted after first reply: ${restarted}
- Runs: ${runs.length} / ${MAX}
- Chain ok: ${chain.ok}

## Run IDs

${runs.map((r) => `- ${r.id} ${r.member} exit=${r.exit} checkpoint=${r.checkpoint}`).join("\n") || "(none)"}

## Floor messages

${messages.map((m) => `- **${m.kind}** from ${m.sender}: ${JSON.stringify(m.content)}`).join("\n")}

## Log

\`\`\`
${log.join("\n")}
\`\`\`
`;
writeFileSync(EVIDENCE, md.replace(/\r?\n/g, "\n"), "utf8");
console.log(md);
console.error("wrote " + EVIDENCE);
console.error("(This script was committed for Claude; do not run a second live without asking.)");