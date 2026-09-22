# Windows Codex work-order acceptance

Date: 2026-09-22

## Result

Council completed the intended local Windows lifecycle:

1. Codex produced an implementation plan in a read-only sandbox.
2. The owner API approved the exact plan hash.
3. Codex changed `proof-workspace/answer.mjs` from `1` to `2` and ran `npm test`.
4. Council verified the coding rollout's effective sandbox policy was `workspace-write`.
5. Codex reviewed the actual files and independently reran the test in a read-only elevated Windows sandbox.
6. The work order reached `awaiting_acceptance`, then the owner API accepted it and recorded `completed`.

The installed Claude CLI is also logged in. `live-proof-claude-planner.json` records the second real route with Claude planning/reviewing and Codex coding.

`live-proof.json` contains the sanitized run summary. It contains no owner token or provider credential.

## Automated and visible checks

- `npm test`: 121 passed, 0 failed.
- The browser displayed only **Codex coding lane** for implementation.
- The route displayed `codex plan → your approval → Codex coding → codex review → your acceptance`.
- Clicking **Approve plan and start coding** moved the simulated browser fixture through coding and planner review to **Accept reviewed work**.
- The page identified the fake preview as simulated; the live proof used the real installed Codex CLI logged in with ChatGPT.

## Boundaries

- No push, deploy, purchase, credential use, or external communication was performed by a work order.
- The proof workspace is intentionally disposable and untracked, so the live reviewer recorded that it could verify behavior but not a tracked before/after change set.
- Normal Codex builds now remove their two workspace-local runtime folders after exit; an automated regression covers that cleanup.
