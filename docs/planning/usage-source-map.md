# Usage panel: source map

Status as of 2026-09-20: **nothing is connected.** The panel ships with honest
"Unavailable" readings for all four services. The numbers in the fake preview
are fixtures and are labelled SIMULATED on screen and in the API (`mode`,
per-account `simulated`, `status`).

A live adapter goes in `src/usage/sources.mjs`, replacing that service's
unconnected adapter. It returns the raw account shape and the service
normalizes it; it must never return an account email, a credential, a raw
provider error, or a local auth path (normalization also strips these).

| Service | Connected | Where the number lives | Units / windows | Needs | Remaining gate |
|---|---|---|---|---|---|
| Codex | No | Local session files `~/.codex/sessions/**/rollout-*.jsonl`. Verified on this PC 2026-09-20: `token_count` events carry `rate_limits.primary` / `.secondary` with `used_percent`, `window_minutes`, `resets_at`. | Used percent, per window. Window length is reported, not fixed: the file inspected had one 10080-minute window and `secondary: null`. `resets_at` is epoch seconds. | File read only. No login, key or network. | Owner OK to read Codex's session folder from the Council process. Reading is only as fresh as the last Codex run, so `checkedAt` must be the event's own timestamp, not "now". |
| Claude | No | Claude Code shows limits in its `/usage` view. No local file with the percentage was found in `~/.claude`. | Unknown from local inspection. | Would need the signed-in account's own usage endpoint, i.e. credential use. | Credential access is an owner decision. Until then: Unavailable, or a labelled manual reading. |
| Cursor | No | Account dashboard on the web. Local `state.vscdb` exists but was not opened; no documented usage field. | Unknown. | Signed-in web session. | Same as Claude. |
| Grok | No | `~/.grok` holds auth and session files; no usage figure found by name. | Unknown. | Unknown. | Find a documented source first. |

## Not sources

- **Council run caps** (`config/limits.json`, counted in `src/adapters/spawn.mjs`)
  are the Council's own daily run ceilings. They are not subscription balance
  and the panel does not show them as such.
- **Codex Usage 1.9.1** (upstream-ray/codex-usage-monitor) is the visual
  reference only. No code was copied and it is not called as an API.
- **The Codex assistant's usage tool** belongs to the assistant host, not to
  the standalone Council server.

## Known gap, tracked separately

`src/work-orders.mjs` still routes non-Cursor implementation back to Codex.
That conflicts with the cost-first policy (Codex/Claude plan, lower-cost models
code). This panel does not change it.
