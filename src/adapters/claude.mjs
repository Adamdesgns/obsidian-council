// src/adapters/claude.mjs
const CLAUDE_DENY = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent",
  "mcp__robinhood-trading", "mcp__financial-datasets",
];

export function describe() {
  return { id: "claude", kind: "cli" };
}

export function argsFor(packet, { resume = null, persist = false, newId = null, maxTurns = 1 } = {}) {
  const prompt = typeof packet === "string" ? packet : packet.prompt || packet.text || "";
  return [
    "--print",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--permission-mode", "default",
    ...(resume ? ["--resume", resume] : []),
    "--disallowedTools", ...CLAUDE_DENY,
    "--",
    prompt,
  ];
}

export function sessionOf(result) {
  const m = String(result?.stdout || "").match(/"session_id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function finalText(result) {
  for (const obj of jsonObjects(result?.stdout)) {
    if (obj.type === "result" && typeof obj.result === "string") return obj.result;
  }
  return String(result?.stdout || "").trim().slice(-2000);
}

export function usageOf(result) {
  return result?.usage || {};
}

function jsonObjects(text) {
  const objs = [];
  const t = (text || "").trim();
  try { const whole = JSON.parse(t); return Array.isArray(whole) ? whole : [whole]; } catch { /* */ }
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { objs.push(JSON.parse(l)); } catch { /* */ }
  }
  return objs;
}