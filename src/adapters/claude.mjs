// src/adapters/claude.mjs
const CLAUDE_DENY = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent",
  "mcp__robinhood-trading", "mcp__financial-datasets",
];

export function describe() {
  return { id: "claude", kind: "cli" };
}

export function argsFor(packet, { resume = null, persist = false, newId = null, maxTurns = 1, model = null } = {}) {
  const prompt = typeof packet === "string" ? packet : packet.prompt || packet.text || "";
  return [
    "--print",
    prompt,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    // Restrict built-ins to file inspection and ignore inherited MCP/settings.
    // Only the Council MCP config, when explicitly added by prepareBridge,
    // may supply tools beyond this list. OAuth sign-in remains available.
    "--permission-mode", "dontAsk",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools", "Read,Glob,Grep",
    "--allowedTools", "Read,Glob,Grep,mcp__council__*",
    ...(model ? ["--model", model] : []),
    ...(resume ? ["--resume", resume] : []),
    "--disallowedTools", CLAUDE_DENY.join(","),
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
