// lib.mjs — shared helpers for the Phase 1 spike. Zero dependencies, Node 26.
//
// Everything here is read-only except: writing under spike/results/, writing the
// usage ledger, and creating disposable folders under %TEMP%\council-spike\.
// No credential is read, printed or written. Captured output is redacted before
// it is saved. Every model run is appended to the ledger and counted against
// spike/budget.json; the budget refuses runs beyond the ceiling.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export const SPIKE = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(SPIKE, "results");
export const LEDGER = join(RESULTS, "usage-ledger.jsonl");
export const SCRATCH = join(tmpdir(), "council-spike");
export const BUDGET = JSON.parse(readFileSync(join(SPIKE, "budget.json"), "utf8"));
export const DRY = process.argv.includes("--dry-run");

mkdirSync(RESULTS, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");

// Minimal environment for child processes: enough for the CLIs to find their own
// login files under the user profile, nothing else from this shell.
const KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "HOME",
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ComSpec", "PATHEXT", "USERNAME", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramData", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PUBLIC"];
export const MIN_ENV = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
MIN_ENV.NO_COLOR = "1";
MIN_ENV.PYTHONIOENCODING = "utf-8";

export function nowIso() { return new Date().toISOString(); }
export function hex(n = 6) { return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

// ---- CLI discovery ---------------------------------------------------------
export function resolveClis() {
  const out = {};
  // Claude Code: npm global install; the package ships a native bin\claude.exe (what claude.cmd calls).
  // Spawning the .exe directly avoids a cmd.exe shell layer.
  const claudeExe = join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const claudeCli = join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  out.claude = existsSync(claudeExe)
    ? { exe: claudeExe, prefix: [], path: claudeExe, found: true }
    : existsSync(claudeCli)
      ? { exe: process.execPath, prefix: [claudeCli], path: claudeCli, found: true }
      : { found: false, looked: [claudeExe, claudeCli] };
  // Codex: versioned hash directory under LocalAppData; pick the newest codex.exe.
  const codexBin = join(LOCALAPPDATA, "OpenAI", "Codex", "bin");
  let codex = { found: false, looked: [codexBin] };
  if (existsSync(codexBin)) {
    const cands = readdirSync(codexBin).map((d) => join(codexBin, d, "codex.exe")).filter(existsSync)
      .map((p) => ({ p, m: statSync(p).mtimeMs })).sort((a, b) => b.m - a.m);
    if (cands.length) codex = { exe: cands[0].p, prefix: [], path: cands[0].p, found: true, candidates: cands.length };
  }
  out.codex = codex;
  // Grok CLI.
  const grokExe = join(HOME, ".grok", "bin", "grok.exe");
  out.grok = existsSync(grokExe) ? { exe: grokExe, prefix: [], path: grokExe, found: true } : { found: false, looked: [grokExe] };
  // Cursor agent CLI: not expected on this PC as of 2026-09-14; record whatever is true today.
  const cursorCands = [join(HOME, ".local", "bin", "cursor-agent.exe"), join(HOME, ".local", "bin", "cursor-agent"),
    join(LOCALAPPDATA, "Programs", "cursor-agent", "cursor-agent.exe"), join(LOCALAPPDATA, "cursor-agent", "cursor-agent.exe")];
  const cursorHit = cursorCands.find(existsSync);
  const whereCursor = spawnSync("where.exe", ["cursor-agent"], { encoding: "utf8" });
  const wherePath = whereCursor.status === 0 ? whereCursor.stdout.trim().split(/\r?\n/)[0] : null;
  out.cursorAgent = cursorHit || wherePath
    ? { exe: cursorHit || wherePath, prefix: [], path: cursorHit || wherePath, found: true }
    : { found: false, looked: cursorCands.concat(["where.exe cursor-agent"]) };
  out.cursorDesktop = existsSync(join(LOCALAPPDATA, "Programs", "cursor", "Cursor.exe"))
    ? { path: join(LOCALAPPDATA, "Programs", "cursor", "Cursor.exe"), found: true } : { found: false };
  return out;
}

// ---- redaction -------------------------------------------------------------
const SECRET_RES = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /xai-[A-Za-z0-9_-]{12,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];
export function redact(s) {
  if (typeof s !== "string") return s;
  let t = s;
  for (const re of SECRET_RES) t = t.replace(re, (m, a, b) => (a && b ? `${a}${b}[redacted]` : "[redacted]"));
  return t;
}
function deepRedact(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(deepRedact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)]));
  return v;
}

// ---- ledger + budget -------------------------------------------------------
export function ledgerEntries() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function modelRunsUsed(cli) { return ledgerEntries().filter((e) => e.cli === cli && e.model).length; }
export function budgetLeft(cli) { return (BUDGET[cli] ?? 0) - modelRunsUsed(cli); }

// Pull whatever usage-looking fields the CLI printed, shallowly. Different CLIs use different names;
// recording what exists is itself an A2 deliverable.
const USAGE_KEYS = ["usage", "total_cost_usd", "cost_usd", "num_turns", "duration_ms", "duration_api_ms", "session_id", "thread_id",
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "tokens", "model", "id"];
export function extractUsage(stdout) {
  const found = {};
  for (const obj of jsonObjects(stdout)) {
    for (const k of USAGE_KEYS) if (obj[k] !== undefined && found[k] === undefined) found[k] = obj[k];
    if (obj.msg && typeof obj.msg === "object") for (const k of USAGE_KEYS) if (obj.msg[k] !== undefined && found[k] === undefined) found[k] = obj.msg[k];
  }
  return found;
}
export function jsonObjects(text) {
  const objs = [];
  const t = (text || "").trim();
  try { const whole = JSON.parse(t); return Array.isArray(whole) ? whole : [whole]; } catch { /* JSONL or prose */ }
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { objs.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return objs;
}

// ---- process control -------------------------------------------------------
export function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
}
// Find processes whose command line carries a marker we planted. Excludes the query itself.
export function findByMarker(marker) {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`],
    { encoding: "utf8" });
  return (ps.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name] = l.split("|"); return { pid: Number(pid), name }; });
}

// ---- the one way a model gets spawned in this spike ------------------------
// run(cli, argv, opts) -> { exit, stdout, stderr, ms, timedOut, refused }
export function run(cli, argv, { cwd = SCRATCH, timeoutMs = 240_000, stdin = null, label = "", model = true, clis = null } = {}) {
  const c = (clis || resolveClis())[cli];
  if (!c || !c.found) return Promise.resolve({ refused: `cli not found: ${cli}`, exit: null, stdout: "", stderr: "", ms: 0 });
  const full = [...c.prefix, ...argv];
  if (model && budgetLeft(cli) <= 0) {
    const msg = `BUDGET: ${cli} has used ${modelRunsUsed(cli)}/${BUDGET[cli]} model runs; refusing "${label}".`;
    console.error(msg);
    return Promise.resolve({ refused: msg, exit: null, stdout: "", stderr: "", ms: 0 });
  }
  const shown = `${c.exe} ${full.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  console.error(`[run ${cli}${label ? " " + label : ""}] ${redact(shown)}`);
  if (DRY) return Promise.resolve({ dry: true, exit: 0, stdout: "", stderr: "", ms: 0 });
  const started = nowIso();
  const t0 = Date.now();
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false;
    const child = spawn(c.exe, full, { cwd, env: MIN_ENV, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const cap = (s, add) => (s.length > 2_000_000 ? s : s + add);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString("utf8")); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString("utf8")); });
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const entry = { cli, label, model, started, ended: nowIso(), ms, exit: code, timedOut, argv: redact(shown), usage: deepRedact(extractUsage(stdout)) };
      appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
      resolve({ exit: code, stdout: redact(stdout), stderr: redact(stderr), ms, timedOut, usage: entry.usage });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      appendFileSync(LEDGER, JSON.stringify({ cli, label, model, started, ended: nowIso(), ms: Date.now() - t0, exit: null, error: String(err) }) + "\n");
      resolve({ exit: null, stdout: "", stderr: String(err), ms: Date.now() - t0, timedOut: false });
    });
  });
}

// Pull the model's final text out of each CLI's JSON shape.
export function finalText(cli, res) {
  const objs = jsonObjects(res.stdout);
  if (cli === "claude") { const r = objs.find((o) => o.type === "result"); if (r && typeof r.result === "string") return r.result; }
  if (cli === "grok") {
    for (const o of objs.slice().reverse()) {
      for (const k of ["result", "text", "content", "message", "output", "response"]) if (typeof o[k] === "string") return o[k];
      if (o.message && typeof o.message.content === "string") return o.message.content;
    }
  }
  if (cli === "codex") {
    for (const o of objs.slice().reverse()) {
      const it = o.item || o.msg || o;
      if (it && (it.type === "agent_message" || it.type === "message") && typeof it.text === "string") return it.text;
      if (typeof it.last_agent_message === "string") return it.last_agent_message;
      if (typeof it.message === "string" && it.type !== "error") return it.message;
    }
  }
  return res.stdout.trim().slice(-2000);
}

export function classify(res, text) {
  if (res.refused) return "refused:" + res.refused;
  if (res.dry) return "dry-run";
  if (res.timedOut) return "blocked:timeout (likely waiting on an interactive prompt)";
  const err = (res.stderr + "\n" + res.stdout).toLowerCase();
  if (/not authenticated|not logged in|unauthori[sz]ed|please log ?in|sign in|401|invalid api key|credential|login required|run .*login/.test(err) && !/pong/i.test(text || "")) return "blocked:not_authenticated";
  if (/rate limit|quota|too many requests|429|usage limit|out of credits/.test(err)) return "blocked:rate_limited";
  if (res.exit === 0) return "ok";
  return `blocked:exit_${res.exit}`;
}

export function save(name, obj) {
  const p = join(RESULTS, name);
  writeFileSync(p, JSON.stringify(deepRedact(obj), null, 2) + "\n");
  console.error(`[saved] ${p}`);
  return p;
}
export function load(name) { const p = join(RESULTS, name); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }
export function head(s, n = 1500) { return (s || "").slice(0, n); }
