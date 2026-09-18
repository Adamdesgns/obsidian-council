# Claude's revised recommendation (after reviewing Codex's plan)

- Participant: `claude`
- Date: 2026-09-14, America/Chicago
- Supersedes nothing: my original proposal (`proposals/claude-plan.md`) is preserved unchanged. This is my one revision. Where this file and the original disagree, this file is my current position.
- Inputs: my original, Codex's `codex-plan.md`, `upstream-scope.md` (efficiency and live Summons steering), and my review `reviews/claude-review-of-codex.md`.
- Still Phase Zero. Nothing here is permission and nothing has been built.

## 1. What changed in my position

| Topic | Original | Now | Why |
|---|---|---|---|
| Dispatch model | Poll for "owed responses" | Codex's transactional outbox: message + deliveries + task transition in one commit; dispatcher drains the outbox | Crash between "result saved" and "review created" is otherwise possible |
| Interrupted runs | Heartbeat + resume packet | Lease with increasing generation; stale generation cannot change state; heartbeat + separate monotonic checkpoint | Late output from a dead run must never complete a task |
| Build containment | CLI deny rules + worktree | Build runs only inside Codex's Windows sandbox; Claude and Grok runs are read-only or patch-only | Grok sandbox is Linux/macOS only (verified in its README); Claude has no OS sandbox on Windows; a deny rule is not a boundary |
| Codex headless | "Unknown, CLI not on PATH" | Verified present: `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, v0.153.4 per Codex, `codex exec` with JSON events | Codex checked it from its runtime; I checked Git Bash's PATH only. Adapter resolves the path at start |
| State location | `Projects\council\` | `%LOCALAPPDATA%\ObsidianCouncil\` | Outside OneDrive, outside the auto-pushed vault, matches BotDesk |
| Record claim | "Tamper-evident" | "Edit-detecting"; git-backed export is the independent witness | Same-user process can rewrite a local chain |
| Capability fields | Adam's 0–5 scores | 0–5 preference weights (Adam) + evidence state `declared/observed/verified` with `validUntil` (computed) | Self-reported capability must not raise permission |
| Acceptance | Numbered test list | Codex's gates G1–G7, with my fake-member suite and adversarial fixtures under G1/G3/G4 | Better ladder |
| Karpathy | "Exactly the screen of independent answers" | It genuinely cross-reviews; it lacks tasks, tools, evidence, approvals, recovery. Pattern reused for Deliberation and Tribunal; code not adopted; independent core preferred over extending its Python/OpenRouter base | Codex's reading is the accurate one |
| Members at launch | Claude, Grok CLI; Codex when verified | Claude, Codex, Grok CLI, all headless from Phase 1 | Codex verified; Grok CLI was already verified by me |

Unchanged: dependency-free Node core on `node:sqlite`; stdio MCP as the in-run member interface from Phase 2; Markdown mirror into the existing bus with origin IDs; Owner Sanction bound to a content hash and granted only on the dashboard; `HALT` file; ntfy read-only cards; Steward = deterministic runtime + configurable model brain with Morgan holding the seat toward Adam; Claude as planning lead, Codex as implementation lead, Grok CLI as standing adversarial reviewer.

## 2. The combined architecture (one page)

```
 Adam (Black Seat) ── dashboard (127.0.0.1, owner session, CSRF, random port) ── ntfy cards (read-only) ── phone
                                   │
 council-daemon (Node 26, no npm deps) ── %LOCALAPPDATA%\ObsidianCouncil\{council.db, artifacts\, events.jsonl, checkpoints\}
   store: SQLite WAL, one writer, transactional outbox, leases w/ generations, task state machine (Codex §13)
   policy: AUTOPILOT approval.ts semantics + action digest, one-use, revocation gen, budget reservation (Codex §10)
   record: Bench audit.js hash chain mirrored to events table; git-exported daily (edit-detecting)
   router: hard eligibility filters → weighted score (Codex §7 weights as defaults) → stored reasons
   steward: deterministic graph validation + configurable brain (default claude; grok-cli alternate)
   mirror: docs/handoffs/{to-claude,to-codex,to-grok} ⇄ DB, origin IDs, quarantine for bad files
   kill: HALT file; per-Directive pause/cancel; STOP never waits on the DB
                                   │ spawn (argv arrays, no shell strings), usage recorded per run
   ┌──────────────┬───────────────┼────────────────┬───────────────────────────┐
   claude -p      codex exec      grok -p          manual_receipt lane
   (read/patch,   (Build, in its  (read-only,      Morgan · ChatGPT · Grok roster
   MCP council)   sandbox, MCP)   adversarial,     drops + ntfy + HANDBACK watcher;
                                  MCP council)     BotDoor MCP later, separately armed
```

Registry files (human-edited) at `Projects\apps\obsidian-council\registry\`; the daemon validates and hot-reloads them. Code repo `Adamdesgns/obsidian-council` (private).

## 3. Efficiency (Adam: "make it more efficient")

Measurable rules, all configurable in `registry/limits.json`:

1. **Two members per task by default**: one producer, one reviewer from a different provider when one is eligible. A third member joins only for a declared capability gap or a material Dissent. "All-member" exists only as a Tribunal mode.
2. **A Deliberation is three runs**: plan, critique, revise. A fourth (second critique) only when the reviewer flags a blocking finding on the revision. Routine repairs go producer → reviewer once.
3. **Context is a manifest, not a dump**: `truth.md` (always), the task, parent messages, artifact IDs with hashes, graphify `affected` for named files, and excerpts under a per-task token budget. Members fetch more with their own tools inside their scope or ask with `council_ask`.
4. **Deterministic code does the bookkeeping**: routing, validation, state changes, formatting, mirroring. Model runs are spent on planning, implementation and judgment only. Bounded tasks (summaries, classification, duplicate-finding detection) may route to a local Ollama model with the same acceptance gate.
5. **Reuse is hash-gated**: a prior artifact is reused only when task, context version, artifact hashes and freshness match. Sanctions are never reused.
6. **Everything is measured**: each run records tokens (when the CLI reports them), wall time, exit, and outcome; the Meters pane shows accepted results per run and per minute; Phase 4 runs the same three fixture objectives in two-member and all-member modes and keeps the cheaper mode only if G-gates still pass.

## 4. Live Summons (Adam: "wake ya'll to jump into a chat with me")

Design, using what is installed:

- **A Chamber has a Floor.** Adam types on the Floor from the dashboard. Each line becomes a `summons` (first contact) or `dm`/`group` message with the addressed members as recipients, committed through the outbox like any other message.
- **Each member keeps one session per Chamber.** The daemon stores `session_id` per (member, chamber). Claude: `claude -p --resume <id>`; Grok: `grok -p -s <id>`; Codex: `codex exec resume <id>` (flag to verify in Phase 1). On a directed turn the dispatcher resumes that session with the new message and a scoped Chamber history manifest, so the member remembers the room without replaying it every time.
- **Directed turns, bounded auto-reply.** Adam names who speaks (`@codex`, `@all`, `@reviewer`). A member may address another member in its reply; the daemon delivers it and lets that member reply once without Adam, then returns the turn to Adam unless a Directive is running. No member wakes on every line.
- **Honest presence.** `invited / joining / present / thinking / asleep / blocked` are derived from the runs and availability tables. `blocked` names the reason (not authenticated, rate-limited, sandbox unavailable). No fake typing indicators.
- **Room persists while members sleep.** Sessions are resumed, not recreated; the Chamber history is in the store, so a member that was asleep for a day gets the manifest of what it missed, not the transcript.
- **A Floor message is never a sanction.** Adam approving something in chat produces a `sanction_request` card in the Black Seat pane; the click there is the sanction.
- **Attaching to these existing desktop chats** (this Claude Code window, Codex's app window) is not promised. Claude Code exposes a local-session messaging feature (`SendMessage` to "other local Claude sessions on this machine"); that is one bounded experiment in Phase 1, Claude-only, and it is not on the critical path.

This is the same machinery as the twelve-step MVP with Adam as a sender, which is why it belongs in Phase 2, not later.

## 5. Phases (merged)

| Phase | Deliverable | Gate | Owner / reviewer |
|---|---|---|---|
| 0 | Both proposals, reviews, revisions; Adam picks leads and one home; contract files (schemas, seed registry, `limits.json`, `truth.md` v1) | Adam's selection | Claude / Codex |
| 1 | Integration and containment spike: resolve and record `claude`, `codex.exe`, `grok` paths and versions; unattended-auth check for each from a scheduled context; Codex sandbox negative tests on a disposable repo; usage reporting per CLI | Three callable identities or an explicit blocked finding | Codex / Claude |
| 2 | Durable core: schema, outbox, leases, registry, router, artifacts, sanction gate, `council-mcp`, mirror, HALT; Deliberation proof Claude ↔ Grok CLI on a toy objective; Floor with directed turns (live Summons v0) | G1, G2, G3 | Codex / Claude, Grok CLI adversarial |
| 3 | Build loop: approved Directive → Codex sandboxed worktree → tests and evidence → Claude review re-runs the test read-only → bounded repairs → closure; the twelve steps end to end | G4, G5, G6 | Codex / Claude |
| 4 | Owner dashboard: Chambers, Council, Floor, Directives (compare), Black Seat, Record, Meters; exports; efficiency baseline measured | G7 + Adam's review | Codex / Claude; ChatGPT visual direction via manual lane |
| 5 | One adapter at a time: Morgan bridge certification, BotDesk procedural lane, image/video with spend ceilings, local model | one certification each | per registry |

Expectation for Adam: Codex's 20–40 focused days to a hardened MVP is the honest number; the first real AI-to-AI exchange (G2) lands well inside that, at roughly the end of Phase 2.

## 6. Decisions for Adam, updated

1. **Leads.** Claude plans, Codex implements, Grok CLI reviews adversarially. (Both plans recommend this; the decision is Adam's.)
2. **One home.** Code at `Projects\apps\obsidian-council`; planning docs move there in Phase 0; OneDrive repo becomes history. Both planners agree on the code path.
3. **Base.** Independent core (both plans) rather than extending llm-council's Python/OpenRouter app.
4. **Stack for the core.** Dependency-free Node on `node:sqlite` (Claude) vs TypeScript + native binding (Codex). Dissent 1.
5. **Unattended permissions.** Allow headless runs to skip interactive prompts inside their tool allowlists (Claude `--dangerously-skip-permissions` or scoped `--allowedTools`; Grok `--always-approve` with `--tools`/`--deny`; Codex `exec` with its sandbox), reviewer runs read-only. Without this the loop stalls on prompts.
6. **Budgets.** Runs per member per day; tokens per Chamber; sanction expiry (4 h, single-use); API dollar allowance (default zero).
7. **Phone topic.** New secret ntfy topic for Council cards.
8. **BotDesk relay deployment** for the Automation lane, later and separately.

## 7. Division of work (unchanged in shape, sharper in detail)

| Work | Owner | Reviewer |
|---|---|---|
| Schemas, envelope, registry format, router spec, Steward prompt, `truth.md`, acceptance criteria per gate | Claude | Codex (feasibility), Grok CLI (adversarial) |
| Daemon, store, outbox, leases, adapters, `council-mcp`, mirror, dashboard, tests | Codex | Claude (spec/limit), Grok CLI (adversarial) |
| Phase 1 spike and containment negative tests | Codex | Claude |
| Efficiency baseline measurement | Codex runs, Claude designs fixtures | Adam reads the numbers |
| Steward seat toward Adam; Grok roster relay; mirror-lane member; BotDoor lane owner | Morgan | Claude |
| Dashboard visual direction, Council copy | ChatGPT (manual lane) | Claude |
| Leads, sanctions, one home, budgets | Adam | — |
