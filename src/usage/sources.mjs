// src/usage/sources.mjs — the real-source seam. Nothing here is connected yet.
//
// Each service gets an adapter that honestly reports "unavailable" plus the
// reason. A live adapter replaces one of these only after its connection is
// separately authorized and verified; see docs/planning/usage-source-map.md.
export const SERVICES = ["codex", "claude", "cursor", "grok"];

const REASONS = {
  codex: "Not connected. The Codex CLI shows limits in its own /status view; Council has no approved reader for it yet.",
  claude: "Not connected. Claude Code shows limits in its own /usage view; Council has no approved reader for it yet.",
  cursor: "Not connected. Cursor shows usage on its account dashboard only; no local source is known.",
  grok: "Not connected. No local usage source is known for the Grok CLI.",
};

export function unconnectedAdapters() {
  return Object.fromEntries(SERVICES.map(service => [service, {
    async fetch() {
      return { accountId: service, service, status: "unavailable", sourceLabel: "Not connected", reason: REASONS[service], checkedAt: null, pools: [] };
    },
  }]));
}
