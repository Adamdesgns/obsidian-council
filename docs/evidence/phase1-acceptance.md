# Phase 1 spike — acceptance record

- Accepting: Claude (build lead). Evidence read directly from `spike/results/*.json` and `usage-ledger.jsonl`, not from summaries.
- Runner: Morgan Sterling, 2026-09-14 00:39–00:46 CT, from the bus drop `to-grok/2026-09-14-council-phase1-morgan.md`.
- Ceiling: 10 model runs per CLI, $0 API. Used at this point: Claude 3, Codex 5, Grok 5.

| Assignment | Verdict | What the evidence says |
|---|---|---|
| A1 resolve | **ACCEPTED** | Claude 2.1.207 at the npm package's `bin\claude.exe`; Codex 0.153.4 at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`; Grok **1.0.30** (self-updated from 0.2.99 during the evening); no `cursor-agent` CLI; Cursor desktop 3.20.17 present. |
| A2 auth probe | **ACCEPTED with one blocker** | Codex: PONG in 7.1 s, 23,316 input tokens (11,776 cached), reports `thread_id` and `usage`. Grok: PONG in 6.8 s, 18,758 input tokens, reports `sessionId`, `usage` and **`total_cost_usd: 0.0128`**. Claude: exit 1 in 2 s, `Failed to authenticate: OAuth session expired and could not be refreshed`. Blocker is Adam's to clear (`claude auth` login in a terminal). |
| A3 sandbox | **ACCEPTED as a finding, not as a pass** | Under `codex exec -s workspace-write --ignore-user-config`, Codex reported a *read-only* filesystem policy and every command was `rejected: blocked by policy` at CreateProcess, including `Get-Content`, `curl.exe`, the process launch, and the intended write of `inside-ok.txt`. Checks 1 and 4 pass by that blanket rejection; check 5 fails; STOP test inconclusive because the sleeper was never allowed to start. Conclusion: containment held, but Codex cannot do Build work in this configuration. Either the Windows sandbox is not set up or `--ignore-user-config` drops the sandbox mode. Sent to Codex as a hard-debugging question. |
| A4 Grok sessions | **ACCEPTED** | create OK; `--resume` recalled the code word; `-s` on an existing id: `Session ID … is already in use` (exit 1); `--resume` on an unknown id: tried a remote restore, then `Error: Failed` (exit 1). Wrong flag and missing session are both loud. |
| A5 stub exchange | **REJECTED, rerun required** | Ran before the producer/reviewer patch, with Claude as producer while Claude was blocked, so the "plan" was an auth error string. Ledger shows the crash and resume mechanics fired (critique gen1, crash, critique gen2) but the content is invalid. Rerun: `--producer codex --reviewer grok --crash` then `--resume-run`. |

## Decisions and follow-ups

1. **Claude CLI login (Adam).** Until renewed, the Council's two live members are Codex and Grok.
2. **Codex Build lane (Codex to diagnose).** Question sent on the bus with the exact rejection text. Until answered, Codex is review-only; nobody gets a Build lane.
3. **Grok reports dollars.** `total_cost_usd` was non-zero on every Grok run (about 1.3 cents per PONG). Whether that is informational under a subscription or actual API billing is unknown from here; `grok inspect` shows `api_key_auth_disabled: false`. Adam to confirm in the morning; total exposure so far is under 10 cents, and Grok runs stay capped by the ledger.
4. **Bus file encoding.** Morgan's tooling re-saved the drop with em-dashes mangled (UTF-8 read as cp1252). Harmless here; the Council's own exports must write UTF-8 explicitly.
5. **Context cost.** Each Codex PONG costs ~23k input tokens (skills context) and each Grok PONG ~19k. Phase 2 packets must be short; the session-resume path matters for cost, not just memory.

Phase 2 opens for Morgan once A5 passes on the rerun.
