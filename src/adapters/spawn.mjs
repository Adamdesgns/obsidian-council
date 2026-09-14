// src/adapters/spawn.mjs — the one place a member process is started.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as grok from "./grok.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ADAPTERS = { claude, codex, grok };

const KEEP = [
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP",
  "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
  "ComSpec", "PATHEXT", "USERNAME", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramData", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PUBLIC",
];

export function minEnv(extra = {}) {
  const base = Object.fromEntries(
    KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])
  );
  base.NO_COLOR = "1";
  base.PYTHONIOENCODING = "utf-8";
  return { ...base, ...extra };
}

function secretPatterns() {
  return [
    /sk-[A-Za-z0-9_-]{12,}/g,
    /xai-[A-Za-z0-9_-]{12,}/g,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    /\b(api[_-]?key|token|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  ];
}

export function redact(s) {
  if (typeof s !== "string") return s;
  let t = s;
  for (const re of secretPatterns()) {
    t = t.replace(re, (m, a, b) => (typeof a === "string" && typeof b === "string" ? `${a}${b}[redacted]` : "[redacted]"));
  }
  return t;
}

export function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
}

export function loadLimits() {
  const p = join(ROOT, "config", "limits.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

function resolveCli(member, opts = {}) {
  if (opts.exe) return { exe: opts.exe, prefix: opts.prefix || [], found: true };
  if (member === "fake" || opts.fakePath) {
    return {
      exe: process.execPath,
      prefix: [opts.fakePath],
      found: true,
      fake: true,
    };
  }
  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
  const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
  if (member === "claude") {
    const exe = join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const cli = join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(exe)) return { exe, prefix: [], found: true };
    if (existsSync(cli)) return { exe: process.execPath, prefix: [cli], found: true };
    return { found: false };
  }
  if (member === "codex") {
    const bin = join(LOCALAPPDATA, "OpenAI", "Codex", "bin");
    if (existsSync(bin)) {
      const cands = readdirSync(bin)
        .map((d) => join(bin, d, "codex.exe"))
        .filter(existsSync)
        .map((p) => ({ p, m: statSync(p).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (cands.length) return { exe: cands[0].p, prefix: [], found: true };
    }
    return { found: false };
  }
  if (member === "grok") {
    const exe = join(HOME, ".grok", "bin", "grok.exe");
    return existsSync(exe) ? { exe, prefix: [], found: true } : { found: false };
  }
  return { found: false };
}

function runsToday(store, member) {
  const day = new Date().toISOString().slice(0, 10);
  return store.prepare(
    `SELECT COUNT(*) AS c FROM runs WHERE member = ? AND started >= ?`
  ).get(member, day + "T00:00:00.000Z").c;
}

/**
 * spawnMember — write runs row before spawn, finalise after; budget refuse; redact.
 * opts.role: "review" | "build" (codex only)
 * opts.fakePath: path to fake-member.mjs for tests
 */
export async function spawnMember(store, member, argvOrPacket, opts = {}) {
  const limits = opts.limits || loadLimits();
  const ceiling = limits.daily_ceiling?.[member] ?? limits.daily_ceiling?.fake ?? 100;
  const timeoutMs = opts.timeoutMs
    ?? limits.timeout_ms?.[member]
    ?? limits.timeout_ms?.fake
    ?? 240_000;
  const role = opts.role || "review";
  const cwd = opts.cwd || process.cwd();
  const adapter = ADAPTERS[member];

  let argv = argvOrPacket;
  if (argvOrPacket && !Array.isArray(argvOrPacket)) {
    if (!adapter) throw new Error("unknown member adapter: " + member);
    argv = adapter.argsFor(argvOrPacket, {
      resume: opts.resume,
      persist: opts.persist,
      newId: opts.newId,
      cwd,
      role,
    });
  }

  // Budget check before spawn
  const used = runsToday(store, member);
  if (used >= ceiling) {
    const runId = randomUUID();
    const started = new Date().toISOString();
    const refused = `BUDGET: ${member} has used ${used}/${ceiling} model runs today; refusing.`;
    store.commit("run_refused", member, (api) => {
      api.prepare(
        `INSERT INTO runs(id, member, chamber_id, message_id, argv, started, ended, exit, tokens_in, tokens_out, cost_reported, checkpoint)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        runId, member, opts.chamber_id ?? null, opts.message_id ?? null,
        redact(JSON.stringify(argv)), started, started, null,
        null, null, null, JSON.stringify({ refused })
      );
      api.setRef("runs", runId, { refused: true, used, ceiling });
    });
    return { refused, runId, exit: null, stdout: "", stderr: "", timedOut: false, ms: 0 };
  }

  const cli = resolveCli(member, opts);
  if (!cli.found) {
    return { refused: `cli not found: ${member}`, exit: null, stdout: "", stderr: "", timedOut: false, ms: 0 };
  }

  const fullArgv = [...cli.prefix, ...argv, ...(opts.extraArgs || [])];
  const runId = randomUUID();
  const started = new Date().toISOString();
  const shown = redact(`${cli.exe} ${fullArgv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);

  store.commit("run_started", member, (api) => {
    api.prepare(
      `INSERT INTO runs(id, member, chamber_id, message_id, argv, started, ended, exit, tokens_in, tokens_out, cost_reported, checkpoint)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      runId, member, opts.chamber_id ?? null, opts.message_id ?? null,
      shown, started, null, null, null, null, null, null
    );
    api.setRef("runs", runId, { member, role });
  });

  let envExtra = {};
  if (member === "codex" && role === "build" && typeof codex.envFor === "function") {
    envExtra = codex.envFor("build", cwd);
  }
  if (opts.memberToken) {
    envExtra.COUNCIL_MEMBER_TOKEN = opts.memberToken;
  }
  if (opts.env) Object.assign(envExtra, opts.env);

  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false;
    const child = spawn(cli.exe, fullArgv, {
      cwd,
      env: minEnv(envExtra),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cap = (s, add) => (s.length > 2_000_000 ? s : s + add);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString("utf8")); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString("utf8")); });
    if (opts.stdin != null) child.stdin.write(opts.stdin);
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    if (opts.onSpawn) opts.onSpawn(child);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit: code,
        stdout: redact(stdout),
        stderr: redact(stderr),
        ms: Date.now() - t0,
        timedOut,
        pid: child.pid,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit: null,
        stdout: "",
        stderr: redact(String(err)),
        ms: Date.now() - t0,
        timedOut: false,
      });
    });
  });

  // Codex Build: verify effective sandbox_policy from rollout
  let buildCheck = null;
  if (member === "codex" && role === "build" && !result.timedOut && !opts.skipBuildVerify) {
    buildCheck = codex.verifyBuildResult(result);
    if (!buildCheck.ok) {
      result.refused = buildCheck.refused;
      result.buildPolicy = buildCheck.policy;
    } else {
      result.buildPolicy = buildCheck.policy;
    }
  }

  const ended = new Date().toISOString();
  const checkpoint = {
    timedOut: result.timedOut,
    refused: result.refused || null,
    role,
    buildPolicy: result.buildPolicy || null,
  };
  store.commit("run_finished", member, (api) => {
    api.prepare(
      `UPDATE runs SET ended=?, exit=?, checkpoint=? WHERE id=? AND ended IS NULL`
    ).run(
      ended,
      result.exit,
      JSON.stringify(checkpoint),
      runId
    );
    api.setRef("runs", runId, {
      exit: result.exit,
      timedOut: result.timedOut,
      refused: !!result.refused,
    });
  });

  return { ...result, runId, argv: shown, role };
}

export { ADAPTERS, resolveCli };