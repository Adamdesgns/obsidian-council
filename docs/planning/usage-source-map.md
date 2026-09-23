# Usage panel: source map

Historical status before the evening update below: **no real reading was activated in that session.** The panel shipped with honest
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

## September 22 reader and routing correction

The default-off Codex metadata reader is wired through sources.mjs. Opt-in requires
CODEX_LOCAL_USAGE_READER=1; CODEX_USAGE_SESSION_DIR may name the sessions root.
It follows dated directories, reads bounded tails rather than skipping large logs,
and recognizes event_msg payload.type=token_count with rate_limits.primary/secondary.
Only quota numbers/timestamps are returned. Real activation was not performed at that time.

Codex/Claude coding fallback is removed. Both can plan and review. Grok's read-only
adapter cannot be a builder. Cursor's work lifecycle passes fake tests, but the live
native Windows CLI failed filesystem-containment preflight and stays blocked.
See evidence/2026-09-22-takeover/REPORT.md for actual connection state.

## September 22 evening update in this branch

Both Windows launchers now enable the read-only Codex and Claude allowance readers. The Claude adapter uses the signed-in Claude Code OAuth credential only in a request header to the Claude usage endpoint; it returns percentages and reset times, not the token. A live local preview showed Codex weekly and Claude five-hour/weekly readings. The app already running on port 4777 remains the older build until restarted.

Cursor and Grok still have no verified personal account allowance API. Their owner-authenticated manual entry accepts a 0–100 percentage and optional future reset time, stores it under the Council home, labels it **Manual entry**, and stops displaying it one hour later. It is never a live provider reading. Current provider pages remain the source of truth.

For coding, Grok Build and Cursor CLI can now author text patches using read-only tool modes. Council rejects unsafe paths, symlinks, binary/mode changes, renames/deletions, oversized patches, and patches that fail `git apply --check`. Council applies an accepted patch itself, records file hashes, and sends it to the chosen planner for review. Grok's CLI authored a disposable patch successfully. Cursor CLI is installed but its local status remains unauthenticated, so its live coding run is still unverified.
