# The Obsidian Council — decision sheet for Adam

- Author: `claude`, 2026-09-14 ~01:00 CT. Consolidation for selection, not a new planning cycle. All six planning documents plus Grok's review are preserved unchanged.
- Status: planning complete on all three seats (Claude, Codex, Grok). Nothing built. This sheet is not build approval; your answer to §6 is.

## 1. The combined plan (what all three seats now agree on)

- **Core:** plain Node, built-in SQLite, one static local dashboard. One service owns the database. Message + deliveries + task transition commit together; attempt generations reject stale results. Per-run stdio MCP bridges for members; no bridge opens the database. State under `%LOCALAPPDATA%\ObsidianCouncil\`. JSONL and handoff files are exports.
- **Authority:** Black Seat sanctions bound to exact content and scope, one-use, dashboard-only. Global HALT stops Council-owned work only. No blanket permission bypass. Build and tests run only inside a certified sandbox (Codex's Windows sandbox is the first candidate, to be proven by negative tests). Reviewers get scoped Council tools and inert patches, never a shell "to re-run tests"; a separately recorded contained runner executes approved tests.
- **Efficiency:** one producer + one reviewer by default; a material revision gets its own final review (2 calls if the first plan passes, 4 if revised). Any Directive touching Build, credentials, egress or external send requires a different-provider review or your recorded waiver.
- **Live Summons:** dedicated resumable session per (member, chamber); directed replies; at most 2 member-to-member hops and 4 automatic replies per owner turn; one run per session at a time; honest presence; failed resume is disclosed as `session_replaced`. Grok resumes with `--resume`, never `-s`. No attaching to these existing desktop chats in the MVP.
- **Record:** hash-linked events inside the SQLite transaction; edit-detecting, not tamper-proof.
- **Deferred until after the first proof:** phone/ntfy, Markdown mirror into the bus, Morgan as Steward dependency, BotDesk lane, image/video, Tribunal, local Ollama, extending llm-council.

Grok's eight findings (F1–F8 in `reviews/grok-review.md`) are accepted by me as contract locks and acceptance criteria. None changes the architecture.

## 2. Staffing under your latest direction

**Three core communicators, confirmed by Adam 2026-09-14:** Morgan (Grok, with Cursor as part of Morgan's own setup), Codex, and Claude. Cursor is not a fourth member. ChatGPT and other bots are not core seats; they join later only as certified adapters. Adam holds the Black Seat and directs all three.

| Role | Who | Verified? |
|---|---|---|
| Build lead: specs, bounded assignments, acceptance criteria, milestone acceptance | Claude | yes (this seat) |
| Architecture escalations, hard debugging, security questions, second acceptance signature | Codex | yes (CLI 0.153.4 present; headless auth unverified) |
| Routine implementation, fixes, repeated tests | Morgan's Grok bots via Cursor Ultra | **partly.** Cursor 3.20.17 desktop is installed here; a Cursor agent CLI is **not** on this PC (`cursor-agent` not found; `~/.cursor/cli-config.json` exists with sandbox disabled). Morgan has driven Cursor from his side before (Iron Man rescue, 2026-09-12). So the Cursor lane runs through Morgan, not through a daemon on this PC, until a CLI here is verified. |
| Adversarial review | Grok (Morgan's seat, text-only) | yes, just proven by `grok-review.md`; Grok CLI 0.2.99 installed here, headless auth unverified |
| Black Seat | Adam | — |

Working pattern that conserves Claude and Codex: Claude writes a readable script or a bounded assignment with acceptance criteria; Morgan runs it (on this PC or through Cursor); results come back as files and commits on a named branch; Claude verifies against the criteria rather than trusting the report. That is the standing workaround already proven on 2026-08-28. Codex is called only when something fails in a way the criteria cannot diagnose.

Quota tracking: every assignment records which account ran it, the reported usage, and the reset window if known. Unknown stays unknown. API dollars default to zero.

## 3. First proof (recommended scope): Phase 1 spike, no product UI

Disposable folder, no daemon, no dashboard, no scheduled task. Exit: two callable identities with honest scopes, or a named blocker.

1. Resolve and record paths and versions for `claude`, `codex.exe`, `grok`, and whether any Cursor CLI exists on this PC.
2. Headless auth probe per CLI from a non-interactive context (a scheduled-task-style launch): each must answer one trivial prompt with JSON output, or report `blocked:not_authenticated`. Record usage fields each CLI actually returns.
3. Codex sandbox negative tests on a disposable repo: write outside root, read a planted fake secret path, open network when forbidden, spawn a child that outlives the run, STOP mid-run. Each must fail closed with a structured reason.
4. Grok session behaviour: create with `-s`, continue with `--resume`, prove that the wrong flag is detectable and that a failed resume is reported, not silently replaced.
5. Two dedicated sessions (Codex + Claude if both pass step 2, else Claude + Grok) exchange one plan and one critique through a 200-line stub outbox script, survive a kill of the script between save and delivery, and resume without duplicating either message.

Producer: Morgan/Cursor executes scripts Claude writes. Acceptance: Claude checks the recorded outputs. Codex: only if step 3 fails. Estimated cost to Claude and Codex: a few short runs each.

## 4. Second proof (after the spike passes)

Floor + outbox/leases + two adapters + sanctions + artifacts, then the twelve-step build/test/review loop on a disposable app (Codex's gates G1–G6). Assignments written only after §3 passes.

## 5. Code home

`C:\Users\steam\Projects\apps\obsidian-council`, private repo `Adamdesgns/obsidian-council`. This OneDrive repo stays as the planning record. Runtime state never lives in either.

## 6. Your decisions (one answer covers them)

**"Approve the decision sheet"** means: the combined plan in §1, the staffing in §2, the Phase 1 spike in §3 as the first proof, the code home in §5, and a usage ceiling for the spike of at most ten short headless runs per CLI with zero API dollars. Anything you want changed, say which section.

Separately, whenever you like: whether Morgan should install a Cursor agent CLI on this PC so the Council daemon can spawn Cursor directly later.
