#!/usr/bin/env node
// A5 — two real sessions exchange a plan and a critique through a stub outbox
// (node:sqlite, one transaction per hop), survive a crash, and resume without
// duplicating or losing a message.
//
//   node spike/a5-stub-exchange.mjs --producer codex --reviewer grok            # full run, fresh DB
//   node spike/a5-stub-exchange.mjs --producer codex --reviewer grok --crash    # crashes AFTER the reviewer answered, BEFORE the commit
//   node spike/a5-stub-exchange.mjs --producer codex --reviewer grok --resume-run  # continues from the DB; must re-run the reviewer once
//   add --dry-run to print commands only
//
// Producer and reviewer may be any two of claude | codex | grok that A2 marked ready.
// If omitted, producer = first ready of [claude, codex, grok], reviewer = first ready of the others.
// The producer's session is created in step 1 and RESUMED in step 3 (claude --resume,
// codex exec resume <thread_id>, grok --resume <uuid>).
// Expected DB at the end: exactly 1 plan, 1 critique, 1 revision; deliveries all "answered";
// the crash run leaves the reviewer delivery "leased" with attempt_gen 1 and no critique row,
// and the resume run answers it with attempt_gen 2.
// Budget for the full crash proof: producer 2, reviewer 2 (one answer is deliberately thrown away by the crash).

import { resolveClis, run, save, finalText, nowIso, head, SCRATCH, DRY, load } from "./lib.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const CRASH = process.argv.includes("--crash"), RESUME = process.argv.includes("--resume-run");
const cwd = join(SCRATCH, "a5"); mkdirSync(cwd, { recursive: true });
const dbPath = join(cwd, "outbox.db");
if (!RESUME) for (const f of ["outbox.db", "outbox.db-wal", "outbox.db-shm"]) if (existsSync(join(cwd, f))) rmSync(join(cwd, f));
const clis = resolveClis();
const a2 = load("A2-auth-probe.json");
const ready = (m) => !!(a2 && /ready/.test(a2.results?.[m]?.verdict || ""));
const producer = arg("--producer") || ["claude", "codex", "grok"].find(ready) || "claude";
const reviewer = arg("--reviewer") || ["codex", "grok", "claude"].find((m) => m !== producer && ready(m)) || (producer === "grok" ? "codex" : "grok");
if (producer === reviewer) { console.error("producer and reviewer must differ"); process.exit(2); }
if (!clis[producer]?.found || !clis[reviewer]?.found) { console.error(`need ${producer} and ${reviewer} on this PC; run A1 first`); process.exit(2); }
console.error(`[A5] producer=${producer} reviewer=${reviewer} crash=${CRASH} resume=${RESUME}`);

const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, chamber TEXT, sender TEXT, recipient TEXT, type TEXT, parent_id TEXT, content TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS deliveries(message_id TEXT PRIMARY KEY REFERENCES messages(id), recipient TEXT, status TEXT, attempt_gen INTEGER DEFAULT 0, updated TEXT);
CREATE TABLE IF NOT EXISTS sessions(member TEXT PRIMARY KEY, session_id TEXT);`);
const chamber = "spike-a5";
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const tx = (fn) => { db.exec("BEGIN IMMEDIATE"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
const insertMsg = (m) => db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(m.id, chamber, m.sender, m.recipient, m.type, m.parent_id, m.content, nowIso());
const insertDel = (id, to) => db.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?)").run(id, to, "pending", 0, nowIso());

// ---- per-member command shapes ----
const CLAUDE_DENY = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "mcp__robinhood-trading", "mcp__financial-datasets"];
const GROK_COMMON = ["--output-format", "json", "--max-turns", "1", "--tools", "read_file", "--no-memory", "--no-subagents", "--disable-web-search", "--cwd", cwd];
const CODEX_COMMON = ["--json", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-C", cwd, "--color", "never"];
// persist: keep the session so it can be resumed later (producer step 1). ephemeral otherwise.
function memberArgs(member, prompt, { resume = null, persist = false, newId = null } = {}) {
  if (member === "claude") return ["--print", "--output-format", "json", "--max-turns", "1", "--permission-mode", "default", ...(resume ? ["--resume", resume] : []), "--disallowedTools", ...CLAUDE_DENY, "--", prompt];
  if (member === "codex") return resume ? ["exec", ...CODEX_COMMON, "resume", resume, prompt] : ["exec", ...CODEX_COMMON, ...(persist ? [] : ["--ephemeral"]), prompt];
  if (member === "grok") return ["-p", prompt, ...(resume ? ["--resume", resume] : newId ? ["-s", newId] : []), ...GROK_COMMON];
  throw new Error("unknown member " + member);
}
function sessionOf(member, res, newId) {
  if (member === "claude") return (res.stdout.match(/"session_id"\s*:\s*"([^"]+)"/) || [])[1] || null;
  if (member === "codex") return (res.stdout.match(/"thread_id"\s*:\s*"([^"]+)"/) || [])[1] || null;
  if (member === "grok") return newId || (res.stdout.match(/"sessionId"\s*:\s*"([^"]+)"/) || [])[1] || null;
  return null;
}

const log = [];
// ---- step 1: plan (skipped on resume if it already exists) ----
let plan = one("SELECT * FROM messages WHERE type='plan'");
if (!plan) {
  const newId = producer === "grok" ? randomUUID() : null;
  const r = await run(producer, memberArgs(producer, "Write a 5-line plan for a Node CLI that prints today's date in ISO format. Plain text, numbered 1 to 5, nothing else.", { persist: true, newId }), { cwd, label: "A5 plan", clis });
  if (DRY) { log.push("dry-run: plan"); } else {
    const text = finalText(producer, r), sid = sessionOf(producer, r, newId);
    tx(() => { const id = randomUUID(); insertMsg({ id, sender: producer, recipient: reviewer, type: "plan", parent_id: null, content: text }); insertDel(id, reviewer);
      if (sid) db.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)").run(producer, sid); });
    plan = one("SELECT * FROM messages WHERE type='plan'"); log.push(`plan saved (${r.ms} ms, exit ${r.exit}, session ${sid ? "recorded" : "MISSING"})`);
  }
}
// ---- step 2: dispatch the pending/leased reviewer delivery ----
let critique = one("SELECT * FROM messages WHERE type='critique'");
if (!critique && plan) {
  const del = one("SELECT * FROM deliveries WHERE message_id=? ", plan.id);
  const gen = (del?.attempt_gen || 0) + 1;
  db.prepare("UPDATE deliveries SET status='leased', attempt_gen=?, updated=? WHERE message_id=?").run(gen, nowIso(), plan.id);
  log.push(`reviewer lease attempt_gen=${gen} (previous status ${del?.status})`);
  const r = await run(reviewer, memberArgs(reviewer, `Critique this plan in at most 5 numbered points, plain text, nothing else:\n\n${plan.content}`), { cwd, label: `A5 critique gen${gen}`, clis });
  if (DRY) log.push("dry-run: critique");
  else {
    const text = finalText(reviewer, r);
    if (CRASH) { log.push("CRASH injected after the reviewer answered and before the commit"); save("A5-stub-exchange.json", { assignment: "A5", at: nowIso(), producer, reviewer, phase: "crashed", log, db: dump() }); process.exit(1); }
    tx(() => { const id = randomUUID(); insertMsg({ id, sender: reviewer, recipient: producer, type: "critique", parent_id: plan.id, content: text }); insertDel(id, producer);
      db.prepare("UPDATE deliveries SET status='answered', updated=? WHERE message_id=?").run(nowIso(), plan.id); });
    critique = one("SELECT * FROM messages WHERE type='critique'"); log.push(`critique saved (${r.ms} ms, exit ${r.exit})`);
  }
} else if (critique) log.push("critique already present; reviewer NOT re-run (dedupe by parent_id)");
// ---- step 3: producer resumed with the critique ----
let revision = one("SELECT * FROM messages WHERE type='revision'");
if (!revision && critique) {
  const sid = one("SELECT session_id FROM sessions WHERE member=?", producer)?.session_id;
  db.prepare("UPDATE deliveries SET status='leased', attempt_gen=attempt_gen+1, updated=? WHERE message_id=?").run(nowIso(), critique.id);
  const r = await run(producer, memberArgs(producer, `A reviewer critiqued your plan:\n\n${critique.content}\n\nRevise the plan in 5 numbered lines, plain text, nothing else.`, { resume: sid }), { cwd, label: "A5 revise", clis });
  if (!DRY) {
    const text = finalText(producer, r);
    tx(() => { const id = randomUUID(); insertMsg({ id, sender: producer, recipient: reviewer, type: "revision", parent_id: critique.id, content: text }); insertDel(id, reviewer);
      db.prepare("UPDATE deliveries SET status='answered', updated=? WHERE message_id=?").run(nowIso(), critique.id); });
    log.push(`revision saved (${r.ms} ms, exit ${r.exit}, resumed session ${sid ? "yes" : "NO"})`);
  }
}
function dump() { return { messages: q("SELECT id,type,sender,recipient,parent_id,substr(content,1,300) AS content,created FROM messages ORDER BY created"), deliveries: q("SELECT * FROM deliveries"), sessions: q("SELECT member, CASE WHEN session_id IS NULL THEN 'none' ELSE 'recorded' END AS session FROM sessions") }; }
const d = DRY ? null : dump();
const counts = DRY ? {} : Object.fromEntries(["plan", "critique", "revision"].map((t) => [t, d.messages.filter((m) => m.type === t).length]));
const verdict = DRY ? "dry-run" : counts.plan === 1 && counts.critique === 1 && counts.revision === 1 ? "PASS (exactly one plan, one critique, one revision; no duplicates, nothing lost)" : `FAIL (counts ${JSON.stringify(counts)})`;
save("A5-stub-exchange.json", { assignment: "A5", at: nowIso(), producer, reviewer, crash: CRASH, resumeRun: RESUME, log, counts, verdict, db: d });
console.log(log.concat([verdict]).join("\n"));
