# The Obsidian Council — Cursor handoff, 2026-09-16

## Request and outcome
Adam requested a current inspection and a handoff for Cursor. This was a read-only application inspection, not implementation. The Council is a working v0.1 conversation prototype, not the complete approved build/test/review environment. Do not rebuild it from scratch.

## Ownership and reconciliation
Claude remains lead. Morgan coordinates Cursor; Codex reviews the candidate independently. First read C:/Users/steam/Projects/docs/handoffs/to-grok/2026-09-16-council-v02-cursor.md. That existing assignment still says HANDBACK pending. This document supplements it with current source findings, not a second competing task. Confirm existing task ownership before editing. Adam says Cursor usually uses Fable 5; record the actual model, do not guess availability.

## Verified starting point
- Canonical app: C:/Users/steam/Projects/apps/obsidian-council.
- Local branch main, HEAD 6de92ed, clean working tree. Local origin/main also 6de92ed; no remote fetch performed.
- One app worktree. Local phase2/floor branch remains at 63d2eed; inspect ancestry before reusing it. Do not delete it.
- package.json version 0.1.0; plain Node with built-in SQLite, zero dependencies.
- Floor reply fetch/polling already exists (47a5d54); no-store fix a42decc; default-limit restoration a4f69b1. Do not repeat the old missing-message fix blindly.
- Limits: Claude 10, Codex 15, Grok 15 daily; two member hops, four automatic replies per owner turn. Preserve them.
- Historical evidence: docs/evidence/phase2-live.md describes the September 14 restart proof. Not a fresh test of current provider health.

## First defect to reproduce and fix
src/api.mjs:335 POST /owner/say calls outbox.send directly. It uses supplied recipients or defaults to codex and grok. It does not call the dispatcher's ownerSay routine.

src/dispatcher.mjs ownerSay parses @ mentions, routes the root only to the first member, and persists chain/hop state. The dispatcher also independently resolves chains from owner content and relays subsequent replies. The web API path therefore bypasses the ordered root routing and can produce parallel initial delivery plus later relay—the reported duplicate/confused reply mechanism. This is source confirmation; this inspection did not reproduce the defect in a live room.

Trace the actual Floor POST payload and entry-point wiring before patching. Prefer one shared routing contract rather than two slightly different parsers. Add a regression test through the HTTP endpoint, not only direct calls to ownerSay. Establish expected behavior for repeated mentions, unknown or unavailable members and unaddressed broadcast with Claude.

Acceptance: @codex plan @grok critique @codex revise reaches only Codex initially, then Grok receives the plan, then Codex receives the critique. One visible reply per completed hop. Repeat submissions, retry, stale generation and restart must not create unintended duplicate visible replies. Record provider invocation count separately from message delivery count; do not promise exactly-once external execution.

## Remaining work in order
1. Fix API/dispatcher chain routing with a failing-before/passing-after fake-provider HTTP regression.
2. Reliability checks in temporary homes: interruption, restart/leases, HALT, timeout cleanup, stale completion, budget exhaustion, malformed output and missing authentication. Never reuse Adam's real database or tokens.
3. Floor status clarity: queued/running/blocked/failed, actionable errors, remaining budgets, clear HALT and named coordinator. Desktop and narrow-layout browser proof; narrow layout does not establish remote phone support.
4. Follow Claude's acceptance contract for the isolated v0.2 build/test/review fixture. Exact-content, expiring single-use sanction; changed content invalidates approval. Verify effective sandbox before writes. Claude/Grok must not be assumed sandboxed on Windows. No blanket approval bypass; MCP stays off until separately certified.
5. Correct documentation overclaims: README currently says every CLI has its own sandbox and every recipient delivery is exactly once. Qualify these against actual guarantees. Its three-independent-proposals history also conflicts with the recorded two planners plus Morgan review.

## Validation performed here
Read README, package manifest, limits, dispatcher chain code, owner-say API, shared hub, relevant Open Loops and daily entries, existing Morgan assignment; inspected git status/log/branches/worktrees. No app launched, real provider run, configuration change, push or deployment.

Started node --test in the app. Initial adapter ceiling case passed; the suite had not completed at the handoff preparation checkpoint. Do not cite this as a fresh 39/39 pass. README's 39 tests is historical documentation. Check the eventual run result or rerun safely with fakes before claiming a green baseline.

Commands: git status --short; git log -6 --oneline; git branch -av; git worktree list (all app git reads used per-command safe.directory); rg over api.mjs and dispatcher.mjs; node --test. Git emitted inability to read the user's global ignore file under this sandbox; no global config changed.

## Boundaries and next action
Use an isolated worktree after reconciling existing work. Existing assignment authorizes local implementation/tests/commits; this handoff adds no push, merge, deployment, spending, installation, limit increase, account setup, remote exposure or running-app reconfiguration authority. Live provider proof requires verified remaining authorized budget. Keep the service loopback-only.

Append receipt to the existing Morgan assignment: task ID, owner, model, worktree, branch, base SHA and first milestone. Return candidate SHA, changed files, before/after reproduction, exact test results, browser evidence, remaining gates and next action for Codex review. A file on the bus is not proof Cursor started.

## Files from this inspection
This handoff is saved in the planning workspace and copied to C:/Users/steam/Projects/docs/handoffs/2026-09-16-obsidian-council-cursor-handoff.md. Shared vault Daily, hub next field and Open Loops receive attributed status notes. No application source changed. Existing article work and other agents' untracked files are preserved.
