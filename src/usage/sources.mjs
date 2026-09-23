// src/usage/sources.mjs — real-source seam for the usage panel.
//
// Providers without a verified reader report "unavailable". Manual readings
// for Cursor/Grok are handled separately by service.mjs and stay labeled manual.
import {join} from "node:path";
import {homedir} from "node:os";
import {codexLocalAdapter,isEnabled} from "./codex-local-reader.mjs";
import {claudeLocalAdapter} from "./claude-local-reader.mjs";
export const SERVICES = ["codex", "claude", "cursor", "grok"];

const REASONS = {
  codex: "Local Codex usage reader is disabled in this launch.",
  claude: "Local Claude usage reader is disabled in this launch.",
  cursor: "Not connected. Cursor shows usage on its account dashboard only; no local source is known.",
  grok: "Not connected. No local usage source is known for the Grok CLI.",
};

export function unconnectedAdapters(env = process.env) {
  const adapters = Object.fromEntries(SERVICES.map(service => [service, {
    async fetch() {
      return { accountId: service, service, status: "unavailable", sourceLabel: "Not connected", reason: REASONS[service], checkedAt: null, pools: [] };
    },
  }]));
  if(isEnabled(env))adapters.codex=codexLocalAdapter({env,dir:env.CODEX_USAGE_SESSION_DIR||join(env.CODEX_HOME||join(homedir(),".codex"),"sessions")});
  if(env.CLAUDE_LOCAL_USAGE_READER==="1")adapters.claude=claudeLocalAdapter({env});
  return adapters;
}
