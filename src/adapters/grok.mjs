// src/adapters/grok.mjs
// Never emit -s together with --resume.
export function describe() {
  return { id: "grok", kind: "cli" };
}

export function argsFor(packet, { resume = null, persist = false, newId = null, cwd = process.cwd(), maxTurns = 1 } = {}) {
  const prompt = typeof packet === "string" ? packet : packet.prompt || packet.text || "";
  const common = [
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--tools", "read_file",
    "--no-memory",
    "--no-subagents",
    "--disable-web-search",
    "--cwd", cwd,
  ];
  if (resume) {
    // continue only — never -s with resume
    return ["-p", prompt, "--resume", resume, ...common];
  }
  if (newId) {
    return ["-p", prompt, "-s", newId, ...common];
  }
  return ["-p", prompt, ...common];
}

export function sessionOf(result, newId = null) {
  if (newId) return newId;
  const m = String(result?.stdout || "").match(/"sessionId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

export function finalText(result) {
  const objs = jsonObjects(result?.stdout);
  for (const o of objs.slice().reverse()) {
    for (const k of ["result", "text", "content", "message", "output", "response"]) {
      if (typeof o[k] === "string") return o[k];
    }
    if (o.message && typeof o.message.content === "string") return o.message.content;
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