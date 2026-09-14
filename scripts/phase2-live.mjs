// scripts/phase2-live.mjs — ONE live P2-6 proof. Cap 6 Codex+Grok runs. Do not re-run.
// COUNCIL_LIVE=1 node scripts/phase2-live.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDispatcher } from "../src/dispatcher.mjs";
import { finalText as codexFinal } from "../src/adapters/codex.mjs";
import { finalText as grokFinal } from "../src/adapters/grok.mjs";

if (process.env.COUNCIL_LIVE !== "1") {
  console.error("Refusing: set COUNCIL_LIVE=1 to run the live proof.");
  process.exit(2);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(ROOT, "docs", "evidence", "phase2-live.md");
const home = process.env.COUNCIL_HOME || mkdtempSync(join(tmpdir(), "council-live-"));
process.env.COUNCIL_HOME = home;
mkdirSync(home, { recursive: true });

const LINE = "Codex and Grok, plan a CLI that prints the date, then critique each other";
const MAX_RUNS = 6;
const limits = {
  daily_ceiling: { codex: MAX_RUNS, grok: MAX_RUNS, claude: 0 },
  timeout_ms: { codex: 180_000, grok: 180_000 },
  dispatcher: { tick_ms: 1500, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
};

const state = { phase: "plan", planText: "", critiqueText: "", revisionText: "", restarted: false };

function extract(member, result) {
  if (member === "codex") return codexFinal(result) || (result.stdout || "").slice(0, 2000);
  return grokFinal(result) || (result.stdout || "").slice(0, 2000);
}

function scriptedOutbound(member, message, result) {
  const text = (result.stdout || "").slice(0, 4000);
  const runs = countRuns();
  if (runs >= MAX_RUNS) return [];

  if (message.kind === "say" && member === "codex" && state.phase === "plan") {
    state.planText = text;
    state.phase = "critique";
    return [{
      kind: "plan",
      recipient: "grok",
      content: text,
      idempotency_key: "live-plan",
    }];
  }
  if (message.kind === "plan" && member === "grok" && state.phase === "critique") {
    state.critiqueText = text;
    state.phase = "revise";
    return [{
      kind: "critique",
      recipient: "codex",
      content: text,
      idempotency_key: "live-critique",
    }];
  }
  if (message.kind === "critique" && member === "codex" && state.phase === "revise") {
    state.revisionText = text;
    state.phase = "done";
    return [{
      kind: "revision",
      recipient: "owner",
      content: text,
      idempotency_key: "live-revision",
    }];
  }
  return [];
}

function countRuns() {
  try {
    return d.store.prepare(
      `SELECT COUNT(*) AS c FROM runs WHERE member IN ('codex','grok') AND checkpoint NOT LIKE '%BUDGET%'`
    ).get().c;
  } catch { return 0; }
}

let d = createDispatcher({
  home,
  useFake: false,
  members: ["codex", "grok"],
  tickMs: 1500,
  timeoutMs: 180_000,
  defaultRespond: false,
  scriptedOutbound,
  limits,
});

const log = [];
function note(s) { log.push(`${new Date().toISOString()} ${s}`); console.error(s); }

note(`live home=${home}`);
note(`line=${LINE}`);

d.outbox.send({
  sender: "owner",
  recipients: ["codex"],
  chamber_id: "live-floor",
  kind: "say",
  content: LINE + "\n\nCodex: write a short numbered plan (5 lines). Grok will critique next; you will revise after.",
  idempotency_key: "live-owner-say",
});

d.start();
note("dispatcher started");

const deadline = Date.now() + 12 * 60_000;
let midRestartDone = false;

while (Date.now() < deadline && state.phase !== "done") {
  await new Promise((r) => setTimeout(r, 2000));
  const runs = countRuns();
  note(`tick phase=${state.phase} runs=${runs}`);
  if (runs >= MAX_RUNS) {
    note("hit MAX_RUNS cap; stopping");
    break;
  }
  // One restart after plan exists, before critique acked
  if (!midRestartDone && state.phase === "critique" && state.planText) {
    note("mid-exchange dispatcher restart");
    d.stop();
    await d.close();
    midRestartDone = true;
    state.restarted = true;
    d = createDispatcher({
      home,
      useFake: false,
      members: ["codex", "grok"],
      tickMs: 1500,
      timeoutMs: 180_000,
      defaultRespond: false,
      scriptedOutbound,
      limits,
    });
    d.start();
    note("dispatcher restarted");
  }
}

d.stop();
await d.close();

const { openStore } = await import("../src/store.mjs");
const store = openStore({ home });
const runs = {
  rows: store.prepare("SELECT id, member, started, ended, exit, checkpoint FROM runs ORDER BY started").all(),
  messages: store.prepare("SELECT id, kind, sender, substr(content,1,400) AS content FROM messages ORDER BY created").all(),
  chain: store.verifyChain(),
};
store.close();

const pass =
  state.planText &&
  state.critiqueText &&
  state.revisionText &&
  state.restarted &&
  runs.chain.ok &&
  runs.rows.filter((r) => r.member === "codex" || r.member === "grok").length <= MAX_RUNS;

const md = `# Phase 2 live proof

- At: ${new Date().toISOString()} (UTC)
- Home: \`${home}\`
- Owner line: ${LINE}
- Restarted mid-exchange: ${state.restarted}
- Verdict: ${pass ? "PASS" : "FAIL"}
- Run count (codex+grok): ${runs.rows.filter((r) => r.member === "codex" || r.member === "grok").length} / ${MAX_RUNS} cap
- Chain ok: ${runs.chain.ok}

## Run IDs

${runs.rows.map((r) => `- ${r.id} member=${r.member} exit=${r.exit} started=${r.started}`).join("\n") || "(none)"}

## Messages (ledger)

${runs.messages.map((m) => `- ${m.kind} from ${m.sender}: ${JSON.stringify(m.content)}`).join("\n")}

## Artifacts (truncated)

### Plan
${state.planText.slice(0, 1500) || "(missing)"}

### Critique
${state.critiqueText.slice(0, 1500) || "(missing)"}

### Revision
${state.revisionText.slice(0, 1500) || "(missing)"}

## Log

\`\`\`
${log.join("\n")}
\`\`\`
`;

writeFileSync(EVIDENCE, md.replace(/\r?\n/g, "\n"), "utf8");
console.log(md);
console.error(pass ? "LIVE PASS" : "LIVE FAIL");
process.exit(pass ? 0 : 1);