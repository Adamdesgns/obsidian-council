// src/adapters/codex.mjs — Review (read-only) and Build (workspace-write) roles.
// Build flags certified by spike/a3b-sandbox-explicit.mjs. Keep --ignore-user-config.
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function describe() {
  return { id: "codex", kind: "cli", roles: ["review", "build"] };
}

const BUILD_FLAGS = [
  "-s", "workspace-write",
  "-c", 'windows.sandbox="elevated"',
  "-c", 'approval_policy="never"',
  "-c", "sandbox_workspace_write.network_access=false",
  "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
];

/**
 * @param {string|object} packet
 * @param {{ resume?: string|null, persist?: boolean, newId?: string|null, cwd?: string, role?: "review"|"build" }} opts
 */
export function argsFor(packet, opts = {}) {
  const {
    resume = null,
    persist = false,
    cwd = process.cwd(),
    role = "review",
  } = opts;
  const prompt = typeof packet === "string" ? packet : packet.prompt || packet.text || "";
  const commonHead = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
  ];

  if (role === "build") {
    // Build: workspace-write + explicit Windows sandbox overrides (A3b).
    const build = [
      ...commonHead,
      ...BUILD_FLAGS,
      "-C", cwd,
      "--color", "never",
    ];
    if (resume) return [...build, "resume", resume, prompt];
    return [...build, ...(persist ? [] : ["--ephemeral"]), prompt];
  }

  // Review (default): read-only sandbox
  const review = [
    ...commonHead,
    "-s", "read-only",
    "-C", cwd,
    "--color", "never",
  ];
  if (resume) return [...review, "resume", resume, prompt];
  return [...review, ...(persist ? [] : ["--ephemeral"]), prompt];
}

/** Env overlay for Build: HOME/TEMP inside workspace (AppData EPERM under sandbox user). */
export function envFor(role, cwd) {
  if (role !== "build") return {};
  const home = join(cwd, ".council-codex-home");
  const temp = join(cwd, ".council-codex-temp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
  };
}

/**
 * Read effective sandbox_policy from Codex rollout JSONL for thread_id.
 * Mirrors spike/a3b-sandbox-explicit.mjs effectivePolicy (do not edit spike/).
 */
export function effectivePolicy(threadId, { now = new Date() } = {}) {
  if (!threadId) return { note: "no thread id" };
  const home = process.env.USERPROFILE || process.env.HOME;
  const dir = join(
    home,
    ".codex",
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  if (!existsSync(dir)) return { note: "sessions dir not found: " + dir };
  const file = readdirSync(dir)
    .filter((f) => f.includes(threadId))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file) return { note: "rollout not found for " + threadId };
  const out = { rollout: file };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!/sandbox_policy|approval_policy/.test(line)) continue;
    const m1 = line.match(/"sandbox_policy":\s*(\{[^}]*\})/);
    if (m1 && !out.sandbox_policy) out.sandbox_policy = m1[1];
    const m2 = line.match(/"approval_policy":\s*"([^"]+)"/);
    if (m2 && !out.approval_policy) out.approval_policy = m2[1];
    if (out.sandbox_policy && out.approval_policy) break;
  }
  return out;
}

/** True iff rollout sandbox_policy type is workspace-write. */
export function isWorkspaceWritePolicy(policy) {
  if (!policy || !policy.sandbox_policy) return false;
  const raw = policy.sandbox_policy;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj?.type === "workspace-write" || /"type"\s*:\s*"workspace-write"/.test(String(raw));
  } catch {
    return /"type"\s*:\s*"workspace-write"/.test(String(raw));
  }
}

/**
 * After a Build run: read rollout and refuse if not workspace-write.
 * @returns {{ ok: true, policy } | { ok: false, refused: string, policy }}
 */
export function verifyBuildResult(result) {
  const tid = sessionOf(result);
  const policy = effectivePolicy(tid);
  if (!isWorkspaceWritePolicy(policy)) {
    return {
      ok: false,
      refused: `codex build refused: effective sandbox_policy is not workspace-write (${JSON.stringify(policy)})`,
      policy,
      threadId: tid,
    };
  }
  return { ok: true, policy, threadId: tid };
}

export function sessionOf(result) {
  const m = String(result?.stdout || "").match(/"thread_id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function finalText(result) {
  const objs = jsonObjects(result?.stdout);
  for (const o of objs.slice().reverse()) {
    const it = o.item || o.msg || o;
    if (it && (it.type === "agent_message" || it.type === "message") && typeof it.text === "string") return it.text;
    if (typeof it.last_agent_message === "string") return it.last_agent_message;
    if (typeof it.message === "string" && it.type !== "error") return it.message;
  }
  return String(result?.stdout || "").trim().slice(-2000);
}

export function usageOf(result) {
  return result?.usage || {};
}

function jsonObjects(text) {
  const objs = [];
  const t = (text || "").trim();
  try {
    const whole = JSON.parse(t);
    return Array.isArray(whole) ? whole : [whole];
  } catch { /* */ }
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { objs.push(JSON.parse(l)); } catch { /* */ }
  }
  return objs;
}

export { BUILD_FLAGS };