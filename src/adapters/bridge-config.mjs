// src/adapters/bridge-config.mjs — per-run MCP bridge wiring (temp files; token not logged)
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(ROOT, "src", "mcp-bridge.mjs");

export function prepareBridge(member, { cwd, token, apiBase }) {
  const dir = join(cwd, ".council-bridge");
  mkdirSync(dir, { recursive: true });
  const result = { bridge: "none", dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };

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
    result.logPath = cfg; // path only
    return result;
  }

  if (member === "codex") {
    // Best-effort -c flags; verify at runtime. Token in env overlay, not argv string logged.
    result.bridge = "codex-c-flags";
    result.extraArgs = [
      "-c", `mcp_servers.council.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.council.args=${JSON.stringify([BRIDGE])}`,
      "-c", `mcp_servers.council.env={COUNCIL_MEMBER_TOKEN=${JSON.stringify(token)}}`,
    ];
    result.env = { COUNCIL_MEMBER_TOKEN: token, COUNCIL_API_BASE: apiBase || "" };
    result.logPath = "codex:-c mcp_servers.council.*";
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
    return result;
  }

  return result;
}