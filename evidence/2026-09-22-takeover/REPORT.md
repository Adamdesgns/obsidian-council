# Council takeover — 2026-09-22

Owner instruction: finish the Council and take over. Clarification: Adam messages Codex or Claude, plans with them, sends coding to lower-cost programs, and receives the reviewed result in the Council. A packet alone is insufficient.

## Current conclusion

Local workflow implemented; live coding is NOT complete. The prior 107-test build was not proof of a writable coding connection. Grok exposes read_file only. The original usage fixture did not match nested Codex event_msg/token_count records. Shared notes claiming Morgan's work was queued were stale: commits eb71f76/88c3691/9a3f049 and later uncommitted screenshots exist in the old worktree and were preserved untouched.

Current branch: codex/council-finish-20260922, based on 9a3f049. Worktree: C:/Users/steam/.codex/visualizations/2026/09/22/01a0c982-91e9-7920-bd85-e069fee3e8f3/council-finish. Canonical jev-judge and earlier worktree remain untouched. No push or main merge.

## Implemented

- Select Codex or Claude as planner. Capture bounded chamber conversation as context. Send feedback, get a revised plan, require fresh approval, reject duplicate feedback/submissions.
- Configured Cursor adapter pins the coding model to the work order. No auto model, forced permissions, MCP auto-approval, or premium fallback. Successful structured worker output returns to the original planner for read-only review; Adam accepts or asks for another revision.
- HALT includes prepared packets and review stages. Cancel stops the active owned child and fences late results. Restart pauses an attempted coding run to avoid silently repeating edits. Existing unsupported Grok implementation jobs become waiting_worker.
- Fix misleading Floor copy and show actual connection state. A provider report is not owner acceptance.
- Read real-shaped nested Codex quota records, both windows and the latest bounded tail of large logs in dated directories. Reader stays off by default. Refresh past reset times and future-dated readings become stale; simulated provenance survives aging. No conversation or auth content is returned.

## Evidence

`npm test` runs only fake providers; its process environment disables the local usage reader and real Cursor activation. Final count and output are in tests.txt. Tests cover full HTTP Claude → Cursor → Claude → owner acceptance, both planners, feedback idempotency, exact plan/model approval, unsupported workers, HALT/late results, interrupted coding, source timestamps and realistic usage logs.

Browser: isolated `npm run preview:fake`, temporary Council home, no provider calls. Created a chamber, selected Claude, requested a plan, sent feedback, approved the revised plan, observed simulated worker report and planner review, and clicked acceptance. Visible terminal state: Work accepted by you. This is a simulated local exercise, not Adam's product acceptance or real coding evidence.

Desktop and 390px viewport evidence is saved here. Full-page captures exhibit a browser capture scaling/stitching defect and are not visual acceptance proof; prefer viewport images. Mobile DOM measurement: innerWidth 390; document scrollWidth 375; no horizontal overflow. No real phone-device test.

## Live preflight — concrete blocker

- Downloaded the official Windows CLI 2026.09.18-9a7762b from the URL provided by https://cursor.com/install?win32=true. Inspected installer instead of running its directory deletion/PATH mutation. Extracted separately under ../cursor-runtime/dist-package, outside Git. Bundled node.exe Authenticode status: Valid.
- Exact portable entry: bundled node.exe + bundled index.js. `--help` confirms --print, --model, --sandbox enabled, --workspace and JSON output. PATH's `agent.exe` belongs to Grok; it must never be used for Cursor by name.
- `status --format json`: unauthenticated. No login attempted; no account secret inspected.
- `sandbox run` on a disposable inside/outside write probe refuses before running it: `SandboxUnsupportedError` / Windows sandbox helper only provides network proxy, not filesystem isolation. We did not disable the sandbox or retry unrestricted.
- Elevated read-only `wsl.exe --list --quiet` returned no installed distributions. A contained Linux worker needs setup and separate certification. Adam was asked for permission because Windows components may change and a restart may be required.
- Native Windows live coding is deliberately refused before provider spend. Test-only activation cannot invoke real providers (spawn guard).

## Next

1. Obtain Adam's answer on contained Linux setup; do not install or enable Windows components before permission.
2. If approved, establish the isolated worker, certify inside/outside write boundaries and cancellation, sign in through Cursor's normal login, inspect available model/allowance, and choose an explicitly approved lower-cost model. No credential extraction, new paid service or overage.
3. Implement the actual Linux transport and path mapping; current adapter is native-only groundwork. Run one small permitted real coding job and verify files/tests, planner review, restart handling and cancellation. Do not call a fake loop live proof.
4. Adam's Floor acceptance and explicit main landing/push/release remain separate. Claude/Cursor/Grok usage sources are unavailable; Codex metadata reader is implemented but not activated against real sessions.

Sources: https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/reference/permissions, https://cursor.com/docs/cli/reference/output-format. Installed CLI help and the failed containment probe take precedence over assumptions from docs.
