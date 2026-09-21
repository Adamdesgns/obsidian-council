# Council continuation from Claude — 2026-09-21

From: Codex. To: Morgan Sterling, to route to Cursor.
Authorization: Adam said Claude is out of usage and asked Codex to inspect his stopping point and pass the remaining work to Cursor. Codex plans/reviews; use an available lower-cost implementation model, not the exhausted Claude allowance. No push, merge, deploy, paid usage purchase, or live provider activation is authorized.

## Exact resume point

Worktree: C:/Users/steam/.codex/visualizations/2026/09/19/01a0ba30-bf1d-7fe2-8ee5-b5c6f9beae52/council-build

Branch: codex/council-deliberation-complete. Source base: 31f65f2. It was clean on inspection before this document. Canonical checkout remains jev-judge at 4127206; leave it alone. Local branch/worktree inventory checked, no newer local Council implementation branch found. Remote state was not refreshed. Cloud Cursor cannot assume it has this local base: return a transfer blocker if necessary; do not push it without Adam's explicit word.

Claude's 31f65f2 adds the usage panel, src/usage/service.mjs, fixtures.mjs, sources.mjs, GET /owner/usage, fake-preview flag, two test files and docs/planning/usage-source-map.md. Earlier de724ec implements work orders, ec19b6e the deliberation engine. Preserve these changes; do not rebuild the panel from scratch.

All four real usage sources currently return unavailable. Claude reported 100/100 tests and browser checks, but his screenshots were not saved to disk. Codex inspected current source; no independent browser proof or complete security review is claimed. Jev and KEORIS remain out of scope.

## Execute in order

1. Acknowledge with the actual worker/model, task ID, checkout, and base SHA. Verify no competing worker owns the checkout. Report unavailable capacity rather than silently choosing an expensive model. A bus file is not evidence of execution.
2. Review and finish the usage panel. In service.mjs maxAgeMs currently schedules refresh but does not age an adapter's checkedAt into stale status. An adapter can return an old timestamp marked fresh, or a passed reset can remain fresh while refreshDue is true. Add source-timestamp-based freshness and regression tests before connecting any real reader. Preserve last-good timestamps on failure, distinguish missing readings from zero, and keep simulated data unmistakable.
3. Build the Codex local-session usage reader against synthetic JSONL fixtures, default disabled. Read only token_count rate-limit metadata; never expose or log conversation text, auth files, account identifiers or paths. Bound file scanning/bytes, handle malformed/truncated records, select the latest valid event timestamp, convert epoch seconds, and preserve real window durations. Reading real session files from Council remains a separate activation gate. Claude/Cursor/Grok stay honestly unavailable until a verified authorized source exists; no invented dashboard API.
4. Correct the actual delegation route in a separate commit. src/work-orders.mjs currently sends specialist results back to Codex for implementation. Codex/Claude are planners; an explicitly selected available lower-cost worker owns coding. If no worker transport is available, stop in an honest waiting/handoff state instead of falling back to Codex. Preserve exact-plan approval, idempotency, durable recovery, cancel/HALT, and workspace boundaries. Keep Cursor packet readiness distinct from accepted/running/completed. Select the transport only after inspecting the available local Cursor integration; do not claim cloud dispatch from a saved packet.
5. Run the existing fake-provider suite plus meaningful freshness, reader and routing tests. Verify no implementation enqueue targets Codex/Claude under the cost-first default, unavailable workers cannot fall back, and duplicate approvals/resume cannot dispatch twice. Save desktop and 390px browser screenshots to the repo evidence folder with simulated state labeled. Do not terminate or reconfigure Adam's running apps.
6. Return an evidence-bearing handback for Codex review: worker/model, branch/commits, changed paths, exact commands/results, screenshots, actual connection status per provider, and remaining gates. No real provider calls to test routing or meter behavior.

## Completion boundary

Local implementation and fake tests can finish now. Live usage activation, real worker dispatch proof, owner Floor acceptance, and landing/release are distinct gates. Do not mark the entire Council complete based on a fixture demo. No further Claude work is expected while his allowance is exhausted.

## Session actions and file inventory

Independent validation on 2026-09-21: `npm test` completed with exit 0; 100 tests passed, 0 failed. This proves the existing fake-provider suite, not live integrations or the missing freshness behavior. No browser session was launched during this handoff.

Codex read the existing Morgan handback, vault rulebook/current project notes, usage source map and service/source implementations; ran git status/log/branch/worktree/diff-stat and npm test. No application source changed in this handoff session. This document is the only new tracked repository file; the full handoff copy, Morgan bus routing note, and append-only vault updates are outside the repo. The handoff commit records this document locally; no push is authorized.
