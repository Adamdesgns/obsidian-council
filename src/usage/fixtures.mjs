// src/usage/fixtures.mjs — SIMULATED readings for local proof of the usage panel.
// Only reachable through createUsageService({ fixtureMode: true }); the service
// stamps everything from here as simulated. None of these numbers are real.
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

export function fixtureAdapters() {
  return {
    codex: { async fetch(now) {
      return { accountId: "codex", service: "codex", status: "fresh", sourceLabel: "Simulated fixture", checkedAt: iso(now - 1 * MIN),
        pools: [{ id: "codex-shared", label: "All Codex models", modelIds: ["gpt-5-codex"], windows: [
          { id: "five-hour", label: "5 hours", durationMinutes: 300, usedPercent: 38, resetsAt: iso(now + 134 * MIN) },
          { id: "weekly", label: "7 days", durationMinutes: 10080, usedPercent: 71, resetsAt: iso(now + 3 * 1440 * MIN) },
        ] }] };
    } },
    claude: { async fetch(now) {
      // Two seats (claude, fable) draw on one account, so they are one pool.
      return { accountId: "claude", service: "claude", status: "fresh", sourceLabel: "Simulated fixture", checkedAt: iso(now - 2 * MIN),
        pools: [
          { id: "claude-shared", label: "Shared by claude + fable seats", modelIds: ["claude"], windows: [
            { id: "session", label: "5 hours", durationMinutes: 300, usedPercent: 100, resetsAt: iso(now + 47 * MIN) } ] },
          { id: "claude-shared", modelIds: ["fable"], windows: [
            { id: "weekly", label: "7 days", durationMinutes: 10080, usedPercent: 88, resetsAt: iso(now + 5 * 1440 * MIN) } ] },
        ] };
    } },
    cursor: { async fetch(now) {
      return { accountId: "cursor", service: "cursor", status: "stale", sourceLabel: "Simulated fixture", reason: "Last refresh failed; showing the last good reading.",
        checkedAt: iso(now - 190 * MIN),
        pools: [{ id: "cursor-plan", label: "Monthly plan", modelIds: [], windows: [
          { id: "monthly", label: "30 days", durationMinutes: 43200, usedPercent: 54, resetsAt: iso(now - 20 * MIN) } ] }] };
    } },
    grok: { async fetch() {
      return { accountId: "grok", service: "grok", status: "unavailable", sourceLabel: "Not connected", reason: "No local usage source is known for the Grok CLI.", checkedAt: null, pools: [] };
    } },
  };
}
