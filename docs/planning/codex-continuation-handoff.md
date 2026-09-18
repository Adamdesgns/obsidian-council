# The Obsidian Council — continuation handoff
Date: 2026-09-14. Author: [Codex]. Status: planning complete; implementation not started.

## Latest owner direction — overrides older staffing recommendations
Adam wants to conserve Codex and Claude usage for the week. He said Claude should build when the plan is selected, then clarified that Grok bots come with a Cursor Ultra plan and that available usage should be used before spending the two heavy hitters on routine work.

Proposed operating split reflecting that direction: Claude leads/specifies and supervises the future build; Morgan/Grok routes routine implementation, fixes and repeated testing through Cursor Ultra where access is verified. Claude and Codex handle architecture, difficult debugging, security questions and milestone/final acceptance. Codex is no longer the default bulk implementation worker. This is a staffing preference, not permission to start building or assume a working Cursor bridge.

Track each actual account's allowance, reset window, supported tools, availability and verified task results. Unknown quota is unknown, not unlimited. Optimize useful accepted work per quota/time; do not burn tokens or run redundant reviews merely to exhaust subscriptions. Cursor Ultra access is Adam-reported; automated invocation, current quota, model entitlements and isolated execution are unverified. No account, credential or provider check was performed in this handoff.

## Project and intended experience
A local shared room where Adam summons selected AI members into a chat. Members talk to Adam and each other, exchange artifacts, plan, assign approved work, test and repair it, and resume after interruptions without manual message copying. Adam occupies the Black Seat and approves protected actions.

Shared planning repository:
C:/Users/steam/OneDrive/Documents/ChatGPT/The OBSIDIAN COUNCIL

Future application home proposed, not created:
C:/Users/steam/Projects/apps/obsidian-council

## Planning checkpoint
Both Codex and Claude have completed their one independent proposal, one peer review and one revised recommendation. Preserve them; do not start another full planning cycle. The latest vault entry records Claude accepting Codex's nine corrections. Local commits before this handoff: f4f4470 (Codex proposal), 5a1a719 (Claude documents), 88dc9b4 (Codex review/revision). Working tree was clean. No push or implementation.

Under the shared repository's docs/obsidian-council/:
- proposals/codex-plan.md
- proposals/claude-plan.md
- reviews/codex-review-of-claude.md
- reviews/claude-review-of-codex.md
- recommendations/codex-revised-recommendation.md
- recommendations/claude-revised-recommendation.md
- reviews/grok-review-brief.md — prepared only, not dispatched
- upstream-scope.md — Karpathy/efficiency/live Summons context
- codex-peer-review-handoff.md — earlier detailed evidence and commands
- README.md — planning navigation/history

## Combined technical direction
Plain Node modules, built-in SQLite, one static local dashboard initially. One service owns the database. Messages, task transitions and pending deliveries commit together; attempt generations reject stale results. Per-run MCP bridges expose scoped member operations. Artifacts are immutable/hash-identified; JSONL and handoff files are exports, not a second authoritative store. Runtime state belongs under LocalAppData, outside OneDrive and the auto-synced vault.

Default one producer and one reviewer. A materially revised plan must receive final independent review, even if that requires a fourth call. Live Summons uses dedicated Chamber sessions, directed replies and bounded automatic exchanges; control of these existing desktop chats is not established.

Grok CLI 0.2.99 is installed. Resume existing sessions with --resume, not --session-id. Installation does not prove current auth, free unattended entitlement or quota. Node 26.1.0 loads built-in SQLite; production/runtime qualification remains future work.

No blanket permission bypass. Read-only labels do not prevent secret reads or inherited hooks/MCP access. Certify scoped review tools/configuration and the actual sandbox for Build/tests. HALT must stop Council-owned work without touching other apps. Protected operations require content/scope-bound Owner Sanction; uncertain external outcomes must not be retried blindly.

Karpathy's llm-council genuinely cross-reviews model answers. Reuse its discussion pattern; the added task, execution, approval and recovery requirements motivate the small independent core. Preserve the option discussion without claiming the upstream misrepresented its function.

## Pending decisions and exact next steps
1. Adam selects the combined plan and first bounded proof scope. Do not treat this handoff as build approval.
2. If Adam wants the proposed one-off Grok adversarial review, use the prepared brief after confirming safe invocation and account/usage scope. It has NOT run. No automatic follow-up debate.
3. Claude converts the selected plan into bounded assignments and acceptance criteria. Morgan/Grok/Cursor handles routine work where access and isolation are verified; heavy-hitter calls are reserved for hard tasks and checkpoints.
4. First authorized proof: two actual members join one Chamber, exchange and review work without copying, and recover after interruption. Then prove the complete approved local build/test/review loop. Simulated adapters do not prove real integration.
5. Verify accounts, allowance/reset dates and execution scopes before routing. Do not install, reconfigure running apps, register background tasks, invoke paid APIs, send externally, push or deploy without the applicable owner authorization.

## This handoff's changes and verification
Created docs/obsidian-council/codex-continuation-handoff.md and its matching external copy at C:/Users/steam/Projects/docs/handoffs/2026-09-14-obsidian-council-continuation-handoff.md. Updated the Council vault hub's status/version/next and appended attributed Daily/Open Loops notes. No code shipped, so no release Dev Log entry. Commit this documentation locally only; final commit ID is supplied with delivery.

Read-only checks used git status --short, git log -3 --oneline, Get-Content on the previous handoff and current vault notes, and targeted rg for Council open loops. Check matching handoff hashes and a clean local commit. No new runtime tests, model calls, launches, installs or account access.

The full preceding peer-review handoff follows as historical evidence. Its older default-Codex staffing and pending-review statements are superseded by the owner direction and current status above.

---
# Codex peer-review handoff — 2026-09-14

Author: **[Codex]**. Phase Zero; no implementation.

## Request and continuation

Adam pasted Claude's completion notice, said both planners were working concurrently, then asked whether Grok should review for missed issues. Completed Codex's one peer review and one revised recommendation; prepared a single bounded third-review brief. Grok has not been invoked. Owner selection and any real review invocation remain separate next steps.

## Files written in the shared Council workspace

Root: `C:/Users/steam/OneDrive/Documents/ChatGPT/The OBSIDIAN COUNCIL`.

- `docs/obsidian-council/reviews/codex-review-of-claude.md`: full peer review, nine material findings, adopted decisions, source evidence and remaining Dissent.
- `docs/obsidian-council/recommendations/codex-revised-recommendation.md`: one final Codex revision; plain Node/built-in SQLite/static Floor, scoped MCP early, discovered Grok candidate, durable state and evidence, bounded Summons, safe review/Build separation.
- `docs/obsidian-council/reviews/grok-review-brief.md`: one concrete text-only third-review assignment, at most eight findings, no tool/runtime actions, source hashes at dispatch, no retry loop. Prepared only.
- `docs/obsidian-council/codex-peer-review-handoff.md`: this handoff.
- `docs/obsidian-council/README.md`: appended completion/navigation section; prior planning text retained as history.

Shared writes on closure: identical copy of this handoff at `C:/Users/steam/Projects/docs/handoffs/2026-09-14-obsidian-council-codex-peer-review-handoff.md`; attributed HANDBACK appended to the incoming `to-codex/2026-09-13-obsidian-council-claude-plan-01.md`; unique notice in `to-claude/2026-09-14-obsidian-council-codex-review-01.md`; vault hub frontmatter/attributed addition, today's Daily bullets, Open Loops addition. Verify these writes before claiming delivery. No Dev Log release entry: no code shipped.

## Important conclusions

Accept Claude's lighter pilot stack and include MCP in the first working loop. Grok CLI is installed; my original discovery missed it. Do not claim its current auth or cost from help output. Correct Grok resumption: `--resume`, not `--session-id`. Three specialist calls cannot cover a material revision and its final independent review; allocate four or pause pending review.

Read-only/patch labels alone do not protect secrets or block inherited integrations. Review workers need brokered context/tools and certified configuration; Build and test commands run in the verified sandbox. Reject blanket bypass as the automation solution. A Codex sandbox setting is a candidate to test, not completed proof.

Reuse Bench audit/MCP and x-poster HALT ideas only with changes: SQLite is authoritative, events/outbox commit together, exports follow; caller actor fields are not identity; x-poster's own source warns rerunning a partial thread can duplicate posts. No trading database or account operation was used.

## Verification performed

Read all three Claude documents in full, fetching the omitted middle section separately after initial large output truncation. Hashes match its bus notice; repeated checks after the move match unchanged bytes. Claude independently committed its copies here as `5a1a719` while this review was running. Original Codex proposal remains `6626412E2C6E4B145137F326DD8C11A485DDF80203F4D6A89BE2124859803E47`. No Claude-owned file was edited.

Commands: `Get-Content`, targeted `rg -n`, `Get-ChildItem`, `Get-FileHash`, `git status --short`, `git log -3 --oneline`; Grok `--version` and `--help`; `node --version`; `node -e "const s=require('node:sqlite'); console.log('DatabaseSync:',typeof s.DatabaseSync)"`. Node 26.1.0 loads built-in SQLite. Grok 0.2.99 help establishes output and session flags. Read relevant noncredential Grok README excerpts and named Bench/x-poster source files without executing them. A private topic happened to appear in a source-search output; it is not reproduced in any artifact, used, or contacted.

Browsed official Node SQLite and release documentation; citations in review/revision. No paid model calls, auth inspection, live Grok run, sandbox test, app test suite, startup task, app launch, install, push, deployment or reconfiguration. Planning validation checks hashes, expected document coverage and Git whitespace, not runtime functionality.

## Concurrent-work discipline

Claude's proposal/review/revision stay unchanged. Our current local checkout was clean at `5a1a719` before Codex's new review files. Stage only Codex's five named documentation files. Do not commit other concurrent files or change branches. Shared notes are append-only; update only hub status/version/next values and preserve Claude's entries. Do not change private memories.

## Exact next steps

1. Present Adam the small combined recommendation and remaining permission/review/record corrections.
2. If Adam approves the proposed Grok review, verify the constrained CLI invocation/account mode, supply both revised recommendations as text, invoke once with no tools, record usage/output and source hashes. If safe invocation is unavailable, say so rather than bypassing controls.
3. Grok writes at most eight concrete findings. Do not start another full planning cycle; Adam decides which findings change the approved implementation contract.
4. Adam selects the planning/implementation leads, future code home and first bounded adapter/containment proof with data/account/usage scope.
5. Only then build. No current document or peer verdict grants production/external-action authority.

All three Codex planning slots are now used. Claude's three slots were already used. Proposed leads remain Claude for specification, Codex for implementation, and certified Grok for optional adversarial review. No assertion that Claude has read this handback until acknowledgment exists.
