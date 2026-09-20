# Delegation workflow local acceptance — 2026-09-19 — [Codex]

Status: implemented and verified locally; not merged, pushed, released, or proven with live providers.

The Council's primary flow is now a durable work order rather than deliberation. Adam supplies an objective, an absolute project/worktree path, and a destination lane. Codex inspects that workspace read-only and writes the implementation plan. Adam approves the exact plan hash. The Council then routes it as follows:

- Codex: certified workspace-write Codex build lane.
- Claude or Grok: read-only specialist handoff, followed automatically by the sandboxed Codex build lane.
- Cursor: complete visible handoff packet with state `handoff_ready`. No callable Cursor agent CLI was found on this PC, so the application does not claim Cursor executed it.

The work order stores the plan, specialist response, build report, workspace, worker and state in SQLite. It is idempotent, fences engine messages from ordinary member claims, pauses on failure, resumes only the unfinished delivery, cancels outstanding generations, and obeys global HALT. Build prompts forbid push, merge, deploy, spending, credential access and external communication.

Verification:

- Final full fake-provider suite: 89 passed, 0 failed/skipped/cancelled.
- Focused browser-script suite: 2 passed after the workspace-link compatibility correction.
- Focused adapter suite: 8 passed after routing Codex build-policy verification to the run's isolated HOME.
- Live local preview server completed a simulated `Codex plan → Claude specialist → Codex build` work order and displayed the plan, handoff and build report in the same record.

The preview makes no provider calls and changes no project files. Real provider quality and the live Codex workspace-write run remain separate acceptance gates. Claude and Grok stay read-only on Windows because they do not have the certified OS boundary. Cursor remains an exported handoff until a supported agent CLI or bridge exists.
