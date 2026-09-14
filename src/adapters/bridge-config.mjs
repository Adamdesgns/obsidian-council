// src/adapters/bridge-config.mjs -- per-run MCP bridge wiring (temp files; token not logged)
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(ROOT, "src", "mcp-bridge.mjs");

/** No-op bridge (Codex until approval-key answered; Grok fallback). */
export function noneBridge() {
  return { bridge: "none", extraArgs: [], env: {}, cleanup() {} };
}

export function prepareBridge(member, { cwd, token, apiBase, disabled = false }) {
  if (disabled || member === "codex") {
    // Codex: bridge disabled until approval-key question is answered (P2-6d).
    return noneBridge();
  }

  const dir = join(cwd, ".council-bridge");
  mkdirSync(dir, { recursive: true });
  const result = {
    bridge: "none",
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    },
  };

  if (!token) return result;

  if (member === "claude") {
    const cfg = join(dir, "council-mcp.json");
    writeFileSync(cfg, JSON.stringify({
      mcpServers: {
        council: {
          command: process.execPath,
          args: [BRIDGE],
          env: { COUNCIL_MEMBER_TOKEN: token, COUNCIL_API_BASE: apiBase || "" },
        },
      },
    }, null, 2), "utf8");
    result.bridge = "claude-mcp-config";
    result.extraArgs = ["--mcp-config", cfg];
    result.logPath = cfg;
    return result;
  }

  if (member === "grok") {
    const grokDir = join(cwd, ".grok");
    mkdirSync(grokDir, { recursive: true });
    const toml = join(grokDir, "config.toml");
    writeFileSync(toml, [
      "[mcp_servers.council]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(BRIDGE)}]`,
      "",
      "[mcp_servers.council.env]",
      `COUNCIL_MEMBER_TOKEN = ${JSON.stringify(token)}`,
      apiBase ? `COUNCIL_API_BASE = ${JSON.stringify(apiBase)}` : "",
      "",
    ].filter(Boolean).join("\n"), "utf8");
    result.bridge = "grok-project-config";
    result.env = { COUNCIL_MEMBER_TOKEN: token, COUNCIL_API_BASE: apiBase || "" };
    result.logPath = toml;
    result.grokToml = toml;
    const baseCleanup = result.cleanup;
    result.cleanup = () => {
      baseCleanup();
      try { unlinkSync(toml); } catch { /* */ }
    };
    return result;
  }

  return result;
}

/** Remove project-scoped Grok MCP config so a retry runs without the bridge. */
export function removeGrokBridgeConfig(cwd) {
  const toml = join(cwd, ".grok", "config.toml");
  try { unlinkSync(toml); } catch { /* */ }
  return toml;
}
