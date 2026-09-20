# The Obsidian Council — Claude's independent proposal

- Participant: `claude` (Claude Code, Fable 5.1)
- Date: 2026-09-13 (America/Chicago)
- Status: Independent proposal. Not reviewed by Codex yet. No implementation started.
- Planning limits honoured: this is my one proposal. My one review goes to `docs/obsidian-council/reviews/claude-review-of-codex.md` when `codex-plan.md` exists. My one revision follows the review.
- Rule reminder: nothing in this document is permission. Adam holds the Black Seat.

---

## 1. Executive summary

The Council's only hard requirement is the one the directive underlines: **AI systems talk to each other without Adam carrying messages between apps.** Everything else (chambers, registry, dashboard, language) is scaffolding around that one loop.

Today this PC already has three of the four pieces of that loop, but none of them are wired to each other:

1. **A working message convention** — the handoff bus at `docs/handoffs/` (`to-claude/`, `to-codex/`, `to-grok/`, `worklog/`) with a readable envelope (From / To / Date / Topic / What happened / What you need done / What NOT to do / Done looks like / HANDBACK) and a machine-checkable "unread" rule (`inbox-check.mjs`).
2. **Headless, scriptable AI members** — the Grok CLI (`grok -p`, JSON output, JSON-schema output, ACP stdio, MCP servers, hooks) is installed and logged in; Claude Code (`claude -p`, MCP, hooks, agents) is installed. Codex runs on this PC with MCP and scheduled automations. Nobody has ever spawned one of these from another one's turn.
3. **Proven approval and audit patterns** — AUTOPILOT's typed policy engine (`authority.ts`, `approval.ts`), the Bench's hash-chained audit ledger (`server/audit.js`), the per-row self-expiring executor arm, the x-poster `approved/` + `HALT` + `posted/` idempotency pattern, and BotDesk's credential separation and one-command-in-flight relay.

The missing fourth piece is a **dispatcher**: a small always-on local process that reads a structured message store, notices "member X owes member Y a response," spawns member X headlessly with the right context, and writes the response back. That is the whole product. It is roughly one week of Codex implementation for the MVP loop, because the transports, envelopes and guard patterns already exist.

**Recommendation in one paragraph:** build a single Node process (`council-daemon`, zero external dependencies, Node 26 has SQLite built in) that owns one SQLite file, exposes the same ten member operations three ways (a stdio MCP server, a loopback HTTP API, and a Markdown mirror into the existing `docs/handoffs/` folders), and dispatches turns to Claude and Grok headlessly first, Codex second, with Morgan/ChatGPT/Grok-web bots joining through the file mirror and phone until they have a machine transport. Owner Sanction is a signed one-time approval bound to a directive ID and a content hash, granted only from the dashboard. Prove the twelve-step MVP with Claude ↔ Grok CLI before touching visuals.

---

## 2. What I inspected

All read-only, on this PC, 2026-09-13 evening. Nothing was modified, launched or reconfigured.

| Area | What I read | What it told me |
|---|---|---|
| Handoff bus | `docs/handoffs/README.md`, `CODEX-BUS.md`, `TEMPLATE.md`, `to-claude/` (9 files), `to-codex/` (~80 files), `to-grok/` (~35 files), `worklog/` (17 days) | The bus works but is human-paced. ~80 drops in `to-codex/` over 5 days for the Last Word / BotDesk pilots shows how much traffic already flows; most of it needed Adam to say "check it now". |
| Bus tooling | `apps/the-bench/scripts/inbox-check.mjs` | Zero-dep unread detector. Unread = no `[Claude]` tag in the HANDBACK. Walks `worklog/` for `CLAIMED:` lines. This is a working "inbox + claim" primitive. |
| Morgan's seat map | `to-claude/2026-08-28-grok-seats.md` (33 KB) | Full Grok roster and who may write to the bus (Morgan only). Grok bots draft; they do not send, post, push, or spend. Grant has his own Robinhood connector and approval system. Rooms already deleted must not be rebuilt. |
| Grok CLI | `~/.grok/README.md`, `grok --help`, `grok 0.2.99`, `~/.grok/config.toml` (redacted read) | Installed and authenticated. Headless `-p` with `--output-format json`, `--json-schema`, `--tools` allowlist, `--deny` rules, `--max-turns`, session resume by ID, ACP stdio agent mode, MCP servers, project hooks, subagents. This is the strongest machine transport on the PC after Claude Code itself. |
| Claude Code | `claude 2.1.207`, `~/.claude/settings.json` (hooks/permissions counts only) | Headless `-p`, MCP, hooks, 91 allow / 46 deny rules, bypass mode in this desk. Two MCP servers configured (Robinhood, financial-datasets). |
| Codex | `~/.codex/config.toml` (model `gpt-6-astra`, `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`, a `notify` hook on `turn-ended`), `~/.codex/automations/` (3 scheduled automations exist), `~/.codex/AGENTS.md` | Codex has MCP, hooks, scheduled automations, sandboxing. **`codex` is not on PATH** — the Codex CLI (`codex exec`) is not installed globally; only the desktop app is. Headless Codex is therefore an unknown until Codex confirms. |
| BotDesk / Bot Door | `apps/botdesk/README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `AGENTS.md`; handoff `2026-09-10-botdoor-studio-support-handoff.md` | A Cloudflare relay + Windows host + MCP adapter letting an approved Grok bot operate one app window inside an owner-armed time window. Separate host/owner/bot credentials, hashes only on the relay, one command in flight, generation counters, replay rejection, STOP always wins. Relay not deployed. This is the *only* existing path for a Grok web bot to act on this PC programmatically. |
| AUTOPILOT | `apps/autopilot/README.md`, `AUTOPILOT_BUILD_PLAN.md`, `packages/policy-engine/src/{authority,approval}.ts` | Typed authority levels 0–5, risk levels, `evaluateApproval()` binding an approval to proposal ID + content version + decider + scopes + expiry. Tested. Directly reusable as the Owner Sanction check. |
| The Bench | `server/mcp.js` (dependency-free stdio MCP), `server/audit.js` (hash-chained append-only JSONL ledger), `scripts/executor-arm.mjs` (per-row self-expiring arm over ntfy), `scripts/ntfy-read.mjs` (phone delivery, 4096-byte split) | Patterns for: MCP without dependencies, tamper-evident Record, expiring sanction, phone notification. |
| x-poster | `apps/x-poster/README.md` | `approved/` is a live queue drained by a scheduled task; `HALT` file kills all sends; `posted/` archive; always-on gates that cannot be switched off. The idempotent external-action pattern. |
| Vault | `Open Loops.md` (108 KB), `Daily/2026-09-12.md`, `Daily/2026-09-13.md`, `Adam AI Stack.md` | Codex's own note on LibreChat: *"live model-to-model conversation still requires a separately designed turn-taking orchestrator."* That orchestrator is this project. LibreChat is not needed for the MVP. |
| vault-check | `tools/vault-check/check.mjs` | Verifies claims against reality. Same idea the Council needs for completion reports. |
| Scheduled tasks | Task Scheduler root | Bench close/hourly runners, X Poster Daily, Vault Auto-Push, Graphify refresh, GitHub Backup Nightly. The PC already runs unattended AI work on a clock. |
| ChatGPT folder | `OneDrive\Documents\ChatGPT\The OBSIDIAN COUNCIL\` | Empty git repo created 23:46 tonight. Someone (Codex or ChatGPT) initialised it. I did not write there. Flagged in §21. |
| Prior art (Adam's link) | github.com/karpathy/llm-council (read via Jina) | Three stages: parallel first opinions → anonymised peer ranking → chairman synthesis. Stateless Q&A over OpenRouter, JSON files, no tasks, tools, memory or approvals. Useful for one thing (the anonymised review round); it is otherwise exactly the "screen of independent answers" the directive rules out. |
| Slack MCP | `slack_search_channels` | No workspace channels returned. Not a viable transport. |

**What I could not verify:** Codex headless invocation; whether Morgan (Grok Bot desktop app + grokbot.dev agent computer) can call an MCP server on this PC without the BotDoor relay; Grok CLI usage limits; whether Claude headless runs launched by a daemon inherit this desk's permission allowlist cleanly; whether Adam has an OpenAI or xAI API key for image/video generation (env vars `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY` are all unset in this shell; `~/.codex/auth.json` exists, so Codex/ChatGPT login is present).

---

## 3. Reusable existing components

Ranked by how much they save.

| # | Component | Where | Reuse as | Change needed |
|---|---|---|---|---|
| 1 | Handoff bus + envelope + HANDBACK rule | `docs/handoffs/` | Human-readable mirror of the message store; fallback transport for members with no API (ChatGPT, Grok web bots, Morgan when BotDoor is off) | Add a machine header line (`council-msg: <id>`) so the mirror can be re-imported; nothing else. Existing files untouched. |
| 2 | `inbox-check.mjs` | `apps/the-bench/scripts/` | Template for the member-side `council inbox` command; its unread rule becomes `status != acknowledged` | Rewrite against the DB, keep the output shape. |
| 3 | Worklog `CLAIMED / TOUCHED / PRODUCED / LEFT` | `docs/handoffs/worklog/` | Task claim semantics: first `CLAIMED` owns it; daemon enforces uniqueness | None; the DB `tasks.claimed_by` is the enforced version. |
| 4 | Grok CLI headless | `~/.grok/bin/grok` | First non-Claude machine member. `--json-schema` gives typed responses; `--tools` and `--deny` give per-task sandboxes; `--session-id` gives resumption | None. |
| 5 | Claude Code headless | `claude -p` | Planner, spec reviewer, limit tester | Per-run `--allowedTools` and `--mcp-config` pointing at the council MCP. |
| 6 | AUTOPILOT policy engine | `apps/autopilot/packages/policy-engine/src/{authority,approval,execution}.ts` | Owner Sanction validation: proposal ID + content version + decider + scopes + expiry | Copy the two files (MIT-internal, Adam's code); the Council daemon is plain JS, so strip types or run through `tsc` once. |
| 7 | Bench `audit.js` | `apps/the-bench/server/audit.js` | The Record: hash-chained append-only event log with secret-key redaction | Copy; change the directory. |
| 8 | Bench `mcp.js` | `apps/the-bench/server/mcp.js` | Skeleton for `council-mcp` (stdio JSON-RPC, no dependencies) | Copy the transport; replace the tools. |
| 9 | `executor-arm.mjs` | `apps/the-bench/scripts/` | Pattern for time-boxed sanctions ("armed for one directive for N hours, disarms after one use") | Reimplement in DB; drop ntfy as the state store (a public topic is not a sanction store). |
| 10 | `ntfy-read.mjs` | `apps/the-bench/scripts/` | Phone notifications for escalations and sanction requests | Copy; new topic; body split logic kept. |
| 11 | x-poster `approved/`, `HALT`, `posted/` | `apps/x-poster/` | Idempotent external-action executor pattern and global kill switch | Pattern only. A `HALT` row/file stops every dispatch. |
| 12 | BotDesk relay + MCP adapter + guard | `apps/botdesk/` | The Grok-web-bot execution lane (Automation Chamber); credential separation; one-command-in-flight; generation counters; replay rejection | None for Council v1; the Council calls it as an external tool once the relay is deployed (separate owner decision, per BotDesk `AGENTS.md`). |
| 13 | `vault-check` | `tools/vault-check/` | Evidence verification pattern: claims in text checked against git/filesystem reality | Extend to check completion reports (commit exists, file exists, test log hash matches). |
| 14 | Obsidian vault rituals | `Daily/`, `Open Loops.md`, hubs | Permanent truth + history export target; both assistants already read it | Daemon writes a `[Council]`-tagged bullet on directive close. |
| 15 | Graphify | `~/.graphify/global-graph.json` | Context packs: `affected` output attached to build tasks so implementers get the blast radius, not the whole repo | None. |
| 16 | Codex automations | `~/.codex/automations/` | If Codex headless is unavailable, a Codex automation can poll `council inbox` on a schedule | Codex to confirm. |
| 17 | llm-council | external | Anonymised peer-ranking round for Deliberations and the Tribunal | Pattern only; no code taken. |

Not reused: LibreChat (Codex's own note says it needs an orchestrator; the orchestrator is the product), Agentic Inbox (unguarded mutation tools, wrong domain), Open-LLM-VTuber, Camofox, Fincept, Lovable.

---

## 4. Minimum viable architecture

```
                 ┌──────────────────────── Adam (Black Seat) ─────────────────────────┐
                 │  dashboard (localhost)            phone (ntfy cards, read-only)     │
                 └───────────────▲──────────────────────────▲─────────────────────────┘
                                 │ HTTP loopback              │ notify only
┌────────────────────────────────┴────────────────────────────┴───────────────────────┐
│  council-daemon (one Node process, zero deps, Windows service/scheduled task)        │
│                                                                                     │
│   store: SQLite (node:sqlite)  ─ messages, tasks, directives, sanctions, runs, ...  │
│   record: hash-chained events.jsonl (append-only)                                   │
│   registry: council/registry/*.json (human-editable, hot-reloaded)                  │
│   dispatcher: polls "owed responses" → spawns a member run → writes result back      │
│   mirror: writes/reads Markdown drops in docs/handoffs/{to-claude,to-codex,to-grok} │
│   api: loopback HTTP + SSE for the dashboard; stdio MCP server for members          │
└───────┬──────────────────┬───────────────────┬───────────────────┬──────────────────┘
        │ spawn             │ spawn             │ spawn (when CLI    │ file drop + ntfy
        │ claude -p         │ grok -p           │  verified)         │ (manual transport)
   ┌────▼─────┐        ┌────▼─────┐        ┌────▼─────┐        ┌────▼──────────────────┐
   │ Claude   │        │ Grok CLI │        │ Codex    │        │ Morgan / ChatGPT /    │
   │ (MCP →   │        │ (MCP →   │        │ (MCP →   │        │ Grok web bots         │
   │ council) │        │ council) │        │ council) │        │ read/write drops;     │
   └──────────┘        └──────────┘        └──────────┘        │ BotDoor MCP later     │
                                                               └───────────────────────┘
```

Design rules:

1. **One store, three views.** SQLite is the truth. The Markdown mirror is a projection for humans and for members that can only touch files. The dashboard is a projection for Adam. No view is ever the only copy.
2. **Members never talk to each other directly.** Every message goes through the store. This is what makes the exchange auditable, resumable and independent of which member happens to be online.
3. **The dispatcher is dumb on purpose.** It does not reason. It reads "who owes what to whom," spawns the owed member with a bounded context pack, and records the run (start, end, exit code, tokens if reported, cost estimate, artifacts). All reasoning is inside member runs, including the Steward's.
4. **Headless first, chat second.** A member that can be spawned from the command line is a first-class member. A member that can only be reached by a person is a manual-transport member and is labelled that way in the registry so the router never puts it on the critical path of an unattended loop.
5. **Zero external dependencies for the core.** Node 26 ships `node:sqlite`, `fetch`, `crypto`, `fs/promises`. The Bench already proves a dependency-free MCP server. No npm install for the daemon means no supply-chain surface and no "works on one PC" drift.
6. **Fail closed.** A missing sanction, an expired sanction, a content-hash mismatch, a HALT file, or an unknown member all stop the action and open an escalation.

Location: `C:\Users\steam\Projects\apps\obsidian-council\` (code, git-tracked, private repo `Adamdesgns/obsidian-council`) and `C:\Users\steam\Projects\council\` (state: `council.db`, `events.jsonl`, `artifacts/`, `registry/`; **not** in git except `registry/`, which is exported to the repo as the editable capability file).

---

## 5. Communication architecture

### 5.1 Transport evaluation

| Option | Verdict | Why |
|---|---|---|
| Repository-backed handoff files (today) | Keep as mirror + fallback | Works for every member including humans and web bots. Fails as the *primary* because nobody is notified and "read" is a convention, not a state. ~80 drops in five days in `to-codex/` shows the volume; Adam was the bus. |
| **SQLite (node:sqlite)** | **Primary store** | Zero deps, single file, transactional claims (no double-claim), queryable for the dashboard, trivially backed up. Everything on this PC is one machine, so a network database buys nothing. |
| Lightweight local HTTP API | Yes, loopback only | Needed for the dashboard (SSE) and for members that prefer HTTP to MCP. Bound to `127.0.0.1`, bearer token per member from the registry. |
| Event queue (Redis/NATS) | No | A second process to babysit for a workload of dozens of messages per day. SQLite `messages` table with `status` *is* the queue. |
| **MCP tools** | **Primary member interface** | Claude Code, Grok CLI and Codex all speak MCP natively. One `council-mcp` server gives all three the same ten operations. |
| Provider APIs (Anthropic/OpenAI/xAI) | Later, and only for image/video | The CLIs already run on Adam's subscriptions with his permissions, sandboxes and hooks. Raw API calls would re-implement all of that and cost per token. |
| Webhooks | No inbound | Nothing external should be able to POST into the Council. Outbound webhooks (ntfy) only. |
| Filesystem watchers | Yes, for the mirror | `fs.watch` on `docs/handoffs/to-*` so a drop from Morgan or Codex becomes a DB message within seconds without Adam saying "check it now". |
| Hybrid | This is the hybrid | SQLite truth + MCP/HTTP access + file mirror + fs watcher + ntfy notify. |

**Smallest reliable solution:** the daemon, the SQLite file, the MCP server and the file watcher. The dashboard is a static HTML page over the HTTP API. That is four source files before any chamber logic.

### 5.2 Message envelope

Every message has exactly the fields the directive lists, stored as columns plus a JSON `body`:

```json
{
  "id": "msg_01J8Q2K7...",           
  "chamber_id": "chm_...", "project_id": "prj_...",
  "sender": "claude", "recipients": ["grok-cli"],
  "type": "review_request",
  "ts": "2026-09-14T02:10:00-05:00",
  "parent_id": "msg_...", "task_id": "tsk_...",
  "summary": "Critique plan v1 for the Council MVP",
  "content": "…markdown…", "artifacts": ["art_..."],
  "response_required": true, "respond_by": "2026-09-14T03:10:00-05:00",
  "priority": "normal", "status": "sent",
  "permission_level": "read_only", 
  "expires": "2026-09-15T02:10:00-05:00", "fresh_as_of": "2026-09-14T02:10:00-05:00",
  "evidence": ["art_..."], "content_hash": "sha256:…"
}
```

Message types (closed set, validated): `dm`, `group`, `question`, `answer`, `assign`, `accept`, `reject`, `review_request`, `review`, `status`, `artifact`, `test_result`, `correction`, `dissent`, `sanction_request`, `complete`, `failed`, `escalate`.

Status lifecycle: `sent → delivered → acknowledged → answered | expired`. `delivered` is set when the recipient's run reads it or when the mirror file is written; `acknowledged` when the member calls `ack` (or a `[Member]` HANDBACK appears in the mirror).

IDs are ULIDs (time-sortable, no coordination). The `content_hash` is over `content + artifacts` and is what a sanction binds to.

### 5.3 The ten member operations (MCP tools = HTTP routes = CLI subcommands)

| Op | MCP tool | What it does |
|---|---|---|
| 1 | `council_inbox(member)` | Unacknowledged messages for me, newest first, with task context. |
| 2 | `council_claim(task_id)` | Atomic claim; fails if someone else holds it. |
| 3 | `council_ask(to, question, task_id?)` | Sends a `question`; returns the message ID to await. |
| 4 | `council_submit(task_id, content, artifacts[], evidence[])` | Marks the task `submitted`; triggers the reviewer's turn. |
| 5 | `council_attach(path|url, kind)` | Registers an artifact, copies it under `council/artifacts/<id>/`, hashes it. |
| 6 | `council_request_review(task_id, reviewer?)` | Explicit review round (router picks reviewer if omitted). |
| 7 | `council_respond(parent_id, content)` | Answer, rebuttal, or revision reply. |
| 8 | `council_update_task(task_id, state, note)` | `in_progress`, `blocked`, `needs_owner`, `done`. |
| 9 | `council_notify_steward(reason)` | Escalate to the Steward run (never to Adam directly). |
| 10 | `council_resume(member)` | Returns my open tasks, last messages, and last run checkpoint. |

Plus one read-only context call, `council_context(task_id)`, that returns the assembled context pack (§8) so members do not paste files into prompts.

### 5.4 The dispatch loop (how a message becomes a turn without Adam)

```
every 5 s (or on fs/DB change):
  HALT file present?              → do nothing, log once
  for each message with response_required and status in (sent, delivered):
     recipient = registry[msg.recipients[i]]
     if recipient.transport == "headless":
        if a run for (recipient, task) is already active → skip
        build context pack → spawn recipient.cmd with pack on stdin
        record run (pid, started, budget)
        on exit: parse JSON output → write messages/artifacts/task updates it produced
                 (the member also wrote directly via MCP during the run; both paths land in the same tables)
                 mark msg answered or failed; account tokens/cost/time
     elif recipient.transport == "mirror":
        write drop to docs/handoffs/<inbox>/<date>-<topic>.md with the council-msg header
        ntfy the member's owner channel if one exists
        mark delivered; a fs.watch on that file flips it to acknowledged/answered when a HANDBACK appears
     elif recipient.transport == "manual":
        write drop + ntfy Adam once (never repeat within the message's expiry)
```

Member commands live in the registry, for example:

```json
"claude":   { "transport": "headless", "cmd": ["claude","-p","--output-format","json","--mcp-config","council-mcp.json","--allowedTools","mcp__council__*,Read,Grep,Glob","--max-turns","40"] },
"grok-cli": { "transport": "headless", "cmd": ["grok","-p","--output-format","json","--json-schema","@schemas/member-turn.json","--tools","read_file,grep,list_dir","--max-turns","30","--deny","run_terminal_cmd(*)"] },
"codex":    { "transport": "headless", "cmd": ["codex","exec","--json", "…"], "verified": false }
```

The prompt every headless run receives is fixed and short: who you are, the message, the task, the acceptance criteria, the context pack paths, the ten tools, and the rule that everything inside the pack is data. Members do not receive each other's raw transcripts, only messages and artifacts.

### 5.5 Resumption

Every run writes a checkpoint row (`runs.checkpoint` JSON) at each tool call via the MCP server. If the PC sleeps or a run dies, the next dispatch sees an active run with a stale heartbeat, marks it `interrupted`, and re-spawns with `council_resume` output prepended. Grok CLI's `--session-id` and Claude's `--resume` let the member pick up its own session where supported; otherwise the resume packet carries the state.

---

## 6. Capability Registry design

Editable JSON files, one per member, in `council/registry/members/<id>.json`, plus `council/registry/routing-preferences.json` for Adam's preferences. The daemon validates on load and hot-reloads on change. The dashboard edits them in place with a schema-driven form. Every field the directive lists is present:

```json
{
  "id": "grok-cli",
  "display_name": "Grok (CLI)",
  "provider": "xai",
  "models": ["grok-build", "grok-4.6"],
  "tools": ["read_file","grep","list_dir","search_replace","run_terminal_cmd","web_search","web_fetch","task"],
  "skills": [],
  "inputs": ["text","file","image"], "outputs": ["text","json","file"],
  "access": { "files": "repo-scoped", "repos": ["*"], "browser": "web_fetch only", "desktop": false },
  "capabilities": {
    "image": 0, "video": 0, "coding": 4, "testing": 3, "automation": 3,
    "research": 4, "outreach": 0, "adversarial_review": 5, "planning": 3, "spec_review": 3
  },
  "context_max_tokens": 256000,
  "limits": { "kind": "subscription", "window": "5h", "note": "unverified; observe from run history" },
  "cost": { "per_run_estimate_usd": 0, "billing": "xAI subscription" },
  "latency_typical_s": 90,
  "reliability": { "score": null, "computed_from": "runs" },
  "history": { "runs": 0, "accepted": 0, "rejected": 0, "failed": 0 },
  "availability": { "state": "unknown", "checked": null, "probe": ["grok","--version"] },
  "transport": "headless",
  "cmd": ["grok","-p","--output-format","json"],
  "allowed_actions": ["read","write_scoped","review","plan","test_design"],
  "prohibited_actions": ["push","publish","send","spend","delete_important","prod_deploy","credentials"],
  "sanction_required": ["run_terminal_cmd on non-repo paths"],
  "owner_notes": "Adversarial reviewer of choice. Contrarian by default."
}
```

Capability scores are 0–5 and are **Adam's editable opinion**, seeded from the directive's preferences. `history` and `reliability` are computed by the daemon from `runs` and never hand-edited. `availability` is probed every 15 minutes with the `probe` command and by the last run outcome.

Seed registry from the directive: `claude`, `codex`, `grok-cli`, `chatgpt` (manual), `grok-web` (manual, covers Riley/Grant/etc. through Morgan), `morgan` (mirror; BotDoor MCP when armed), plus `local-ollama` (headless, disabled by default; Ollama is installed) so the "add a local model later" path is exercised on day one.

Adding a member is adding a file. Removing is setting `"enabled": false`; history is kept.

---

## 7. Task-routing design

The Steward converts an objective into a task graph. Two layers:

1. **Steward brain (a member run).** Configurable in the registry (`steward.brain = "claude"` by default; can be `grok-cli`, later `codex`). Receives the objective, the chamber type, the registry summary and the project's permanent memory; returns a JSON task graph against a fixed schema (enforced by `--json-schema` on Grok or a schema-validated retry on Claude). Nothing else about the Steward is model-driven.
2. **Router (deterministic code).** For each task it scores every enabled member:

```
score = Σ capability_weight[required] × member.capabilities[required]
      − unavailability_penalty − limit_penalty − cost_penalty − risk_mismatch_penalty
      + owner_preference_bonus (from routing-preferences.json)
      + history_bonus (accepted / runs, damped for small samples)
```

and picks primary = top score, reviewer = top score among members that are **not the primary and not the same provider** (so Claude never reviews Claude), backup = next. It writes a `routing_reason` string per pick ("grok-cli: adversarial_review 5/5, available, 0 cost, owner preference +2; codex excluded: unverified transport"). Adam can override any pick in the dashboard; overrides are recorded as `owner_override` events and feed the preference file if he ticks "remember this".

Task record fields: required capability, required context (paths/graphify nodes), required tools, deliverable type, risk level (`low|medium|high|protected`), primary, reviewer, backup, acceptance criteria (list of checkable statements), owner approval required (bool + reason), dependencies, max revision cycles (default 2), budget (tokens/time).

Default routing table (seeded, editable):

| Task type | Primary | Reviewer | Notes |
|---|---|---|---|
| product_architecture | claude | codex (feasibility) | grok-cli backup reviewer |
| repository_implementation | codex | claude (spec compliance) | grok-cli backup implementer only for narrow scripts |
| limit_testing | claude designs | codex reproduces and repairs | |
| image_generation | chatgpt (manual) | claude (brand check) | spend → sanction |
| video_generation | grok-web (manual) | chatgpt or claude | spend → sanction |
| procedural_regression | morgan via BotDoor | codex diagnoses | requires armed window |
| outreach_prep | grok-web (manual) | claude | send → sanction, always |
| positioning | chatgpt + grok-web propose | claude tests claims | |
| deployment | codex prepares/verifies | claude checks evidence | prod → sanction |

---

## 8. Shared-memory design

Three tiers, three storage rules.

| Tier | Where | Written by | Read by |
|---|---|---|---|
| **Permanent project truth** | `council/projects/<project>/truth.md` (versioned, git-tracked in the council repo) + the vault project hub (`status/version/next`) | Adam, or a closed Directive with Adam's sanction | Every run, as the first section of its context pack |
| **Working memory** | SQLite tables `tasks`, `messages`, `artifacts`, `drafts`, `questions` | Members during runs | The owning task's members only |
| **Historical record** | `council/events.jsonl` (hash-chained) + `directives` table + vault `Daily/` bullets tagged `[Council]` | Daemon only | Dashboard, exports, Steward brain (summarised) |

Every record row carries `version`, `provenance` (member, run ID, source message), `created_at`, `updated_at`, `fresh_until`. A context pack refuses to include a working-memory item past `fresh_until` without a "STALE" banner.

**Context packs** are how members get relevant context without the whole world: the daemon assembles `truth.md` (always), the task and its parent messages, artifacts referenced by ID (paths, not contents, except small text), the graphify `affected` list for named files, and the last checkpoint. Everything else must be asked for with `council_ask` or read with the member's own tools inside its allowed scope. Sensitive project truth (customer names, credentials, Robinhood state) lives in files the pack never touches; the registry's `access.files` scope excludes them per member.

The vault stays the human-facing long-term memory and the only ground shared with assistants that never touch the daemon. The daemon appends to `Daily/` and updates `Open Loops.md` rows tagged `**[Council]**`; it never rewrites another author's line (append-only rule preserved).

---

## 9. Artifact-exchange design

`council/artifacts/<art_id>/` holds the bytes (or a `pointer.json` for URLs and deployment previews). The `artifacts` table holds `id, kind, path, sha256, bytes, mime, producer, run_id, task_id, created_at, fresh_until, label`.

Kinds: `source`, `patch` (unified diff, applied only by the Build Chamber's implementer against a named commit), `spec`, `screenshot`, `image`, `video`, `test_report` (JSON with pass/fail counts and the command that produced it), `research`, `json`, `handoff_md`, `preview_url`, `url`, `log`, `build`.

Rules: messages reference artifacts by ID; a run receives paths, never inlined blobs over 8 KB; the reviewer's context pack includes the artifact's hash so "the thing I reviewed" is provable; artifacts are immutable (a revision is a new artifact with `supersedes`). Large binaries (video) stay where they were produced and get a `pointer.json` with hash and size.

The Markdown mirror embeds artifacts as relative links into `council/artifacts/`, so a human reading a drop can open them.

---

## 10. Permission and approval system

Three permission classes, taken from the directive:

- **Regular**: reads, scoped writes in a repo worktree, running tests, drafting anything, asking anyone. No gate.
- **Protected**: publish, outreach/send, external message, production deploy, spend, delete important data, modify production, credentials/customer accounts, anything with external consequence. **Owner Sanction required, every time.**
- **Prohibited**: entering credentials, orders on any brokerage, force-push/hard-reset/`rm -rf`, self-granting permissions, editing `settings.json`/`config.toml` of any member. Never executed by the Council even with a sanction; Adam does these by hand (matches the existing house rules and the 46 deny rules already in Claude's settings).

**Owner Sanction** reuses AUTOPILOT's `evaluateApproval()` semantics:

```
sanction = { id, directive_id, content_hash, scopes[], decided_by: "adam", decided_at, expires_at, used: false, single_use: true }
```

Valid only if: directive matches, `content_hash` equals the current directive's hash (any edit after approval invalidates it), decider is Adam, required scope is present, not expired (default 4 h, like the executor arm), not already used. Granted only from the dashboard on `127.0.0.1` with the owner token; the phone gets a card saying a sanction is waiting, never a button that grants it (an ntfy topic is not an authentication system). Every sanction check, pass or fail, goes to the Record.

Protected actions are executed by a single `actions` executor in the daemon (not by member runs), which checks the sanction, writes an `action_attempt` event with an idempotency key, performs the action, writes the result, and marks the sanction used. Members can only *request* protected actions (`sanction_request` message). That is the same shape as the Bench executor: the model proposes, the gated code acts.

Morgan as Steward cannot approve anything; the Steward brain has no `actions` scope in the registry. Hard-coded, not configurable.

---

## 11. Provider and tool integration strategy

| Member | v1 transport | How the daemon reaches it | Blockers / unknowns |
|---|---|---|---|
| Claude | headless | `claude -p --output-format json --mcp-config … --allowedTools …` | Must confirm headless runs from a service account context see the same login; run as Adam's user via Task Scheduler "run whether user is logged on or not" only if the token survives — test in phase 1. |
| Grok CLI | headless | `grok -p --output-format json --json-schema … --tools … --deny …` | Usage limits unknown; observe. |
| Codex | headless (target) | `codex exec` once the CLI is installed (`npm i -g @openai/codex`, same ChatGPT login); until then a Codex automation polling `council inbox` | **Codex to confirm** in its plan. |
| Morgan / Grok web bots | mirror + ntfy; BotDoor MCP later | Drops in `to-grok/`; fs.watch for HANDBACK; BotDoor when relay is deployed and a window is armed | Relay deployment is a separate owner decision. |
| ChatGPT | manual | Drop + ntfy; Adam pastes into ChatGPT and drops the result back (or the OpenAI Images API with a sanction per spend) | No CLI exists. Label honestly as manual. |
| Local model (Ollama) | headless, disabled | `ollama run` or Grok CLI custom model endpoint | Zero cost, useful for classification/summaries, weak for the rest. |
| Tools (git, gh, node, npm, Playwright, ffmpeg, HyperFrames) | inside member runs | Members' own tool access, bounded by registry `allowed_actions` and CLI `--deny` rules | Git push stays a protected action. |

MCP is the member-facing contract; the daemon is the only thing that touches the store directly. New providers are new registry files plus, if needed, a small adapter that turns "spawn with prompt, read JSON" into the provider's shape.

---

## 12. Interface structure

One static page served by the daemon at `http://127.0.0.1:4777/` (port configurable), vanilla HTML/JS with SSE, no build step (same discipline as PipeForge). Dark, quiet, "command chamber" look comes from CSS variables and typography, not from a framework, and only after the MVP loop passes.

Panes:

1. **Chambers** — create a chamber (type, project, objective, attached files/paths), list active ones with status and cost.
2. **Council** — every member card: availability, limits, capability scores (editable), history, transport, last run.
3. **Floor** — live message stream for the selected chamber; each message shows sender → recipients, type, summary, artifacts, and the routing reason if it was an assignment. This is the "watch messages pass" view.
4. **Directives** — task graph with owners, reviewer, state, revision count, evidence links; reassign, pause, cancel; compare competing plans side by side (two artifacts, diff view).
5. **Black Seat** — pending sanction requests with the exact content hash and scope; Approve / Reject; open Dissents with both positions.
6. **Record** — the event ledger with filters; export a project handoff to `docs/handoffs/<date>-<project>-council-export.md`.
7. **Meters** — tokens, runs, wall time, failures, cost estimate per chamber and per member.

Phone: ntfy cards for "sanction waiting", "dissent opened", "directive closed", "member unavailable". Read-only.

---

## 13. Data models

SQLite tables (columns abbreviated; every table has `id`, `created_at`, `updated_at`, `version`, `provenance` JSON):

- `members` — cached view of the registry files + computed `reliability`, `availability`.
- `projects` — `name, root_path, repo, truth_version, vault_hub`.
- `chambers` — `project_id, type (planning|build|red|limit|visual|motion|automation|outreach|launch|tribunal), objective, state (open|paused|closed), budget JSON, spent JSON`.
- `tasks` — `chamber_id, parent_task_id, title, capability, context JSON, tools JSON, deliverable, risk, primary, reviewer, backup, routing_reason, acceptance JSON, sanction_required, depends_on JSON, max_revisions, revisions, state, claimed_by, claimed_at`.
- `messages` — the envelope from §5.2.
- `artifacts` — from §9.
- `directives` — `chamber_id, title, content_hash, plan_artifact, state (draft|proposed|approved|rejected|executing|closed|dissent), producer, reviewer, tests JSON, evidence JSON, escalation JSON`.
- `sanctions` — from §10.
- `dissents` — `directive_id, parties JSON, positions JSON, state (open|resolved_owner|resolved_tribunal), resolution`.
- `runs` — `member, task_id, message_id, cmd, started, ended, exit_code, tokens_in, tokens_out, cost_est, checkpoint JSON, output_path, heartbeat`.
- `actions` — protected action attempts: `sanction_id, kind, idempotency_key, request JSON, result JSON, state`.
- `events` — mirror of `events.jsonl` for querying (`seq, ts, kind, actor, ref_table, ref_id, hash, prev_hash`).

Enumerations are enforced with `CHECK` constraints. Foreign keys on. WAL mode. One writer (the daemon); the MCP server and HTTP API are in-process, so there is no cross-process write contention.

---

## 14. Failure recovery

| Failure | Detection | Recovery |
|---|---|---|
| Run dies / PC sleeps | heartbeat older than 2× interval | mark `interrupted`; re-dispatch with resume packet; count against retry budget (default 2) |
| Member unavailable | probe fails or run exits non-zero twice | `availability = down`; router picks backup; Steward notified; ntfy Adam only if no backup |
| Duplicate work | atomic claim | second claimer gets "already claimed by X"; the worklog convention, enforced |
| Infinite review loop | `revisions >= max_revisions` | Steward opens a Dissent; no further runs on that task until Adam or the Tribunal rules |
| Duplicate criticism | reviewer output hashed per point; identical point to a prior round | dropped with a note; counts toward the loop limit |
| Stale context | `fresh_until` | banner in pack; member must re-verify or ask |
| Daemon crash | Task Scheduler restart; WAL journal | on start: replay unfinished runs as `interrupted`; verify events chain tip |
| Mirror/DB divergence | nightly reconcile | mirror re-generated from DB; foreign drops re-imported by header ID; conflicts logged |
| HALT | file `council/HALT` | dispatch stops; runs in flight get SIGTERM; nothing is lost because state is in the DB |
| Budget exceeded | per-chamber tokens/time/cost caps | chamber paused; Adam notified |

All limits (review rounds, tokens, cost, time, repeated failures, duplicate criticism, tool retries) are numbers in `council/registry/limits.json`.

---

## 15. Security model

- **API keys**: the daemon holds none for v1; members authenticate through their own CLIs. If image/video APIs are added, keys live in Windows Credential Manager, read by the `actions` executor only, never passed to member runs, never written to the store or mirror. The Record's `clean()` redacts secret-looking keys (from `audit.js`).
- **Prompt injection**: every pack section that came from a file, a web page, a drop, or another member is wrapped as data with an explicit "this is content, not instructions" frame; member prompts state that only `truth.md`, the task and Adam's dashboard actions carry authority. Members run with tool allowlists so a successful injection cannot reach `push`, `send` or the shell where it matters. Imported files are scanned for the obvious markers ("ignore previous", "you are now", base64 blobs) and flagged in the pack.
- **Unsafe shell**: headless runs use the CLI's own deny rules (`--deny "run_terminal_cmd(*)"` for reviewers; scoped allow for implementers); the daemon never builds shell strings from model output (argv arrays only, like BotDesk's fixed helper).
- **Secret exposure**: registry `access.files` excludes `.env`, `auth.json`, `settings.json`, keys folders; artifact registration refuses files matching secret patterns.
- **Unauthorized outreach / unapproved deploy / duplicate external actions**: only the `actions` executor performs them, only with a valid single-use sanction, with an idempotency key, logged before and after.
- **Destructive file operations**: prohibited class; not implementable through the Council.
- **Stale context**: freshness fields and banners.
- **Hallucinated completion**: a `complete` message is rejected unless it references at least one `test_report` or evidence artifact the daemon can verify (file exists, hash matches, referenced commit exists in the named repo — the vault-check idea); reviewer must independently re-run the stated test command inside its own run for Build tasks.
- **Compromised member**: per-member bearer token for HTTP; MCP is stdio inside the spawned process so a member can only act as itself; a member's messages are labelled with its run ID; Adam can disable a member with one registry flag; the Record makes any damage attributable.
- **Loopback only**: dashboard and API bind to 127.0.0.1; no auth bypass for "localhost" — the owner token is still required for sanctions.

---

## 16. Testing strategy

1. **Unit** (node:test, no deps): envelope validation, claim atomicity, router scoring and reasons, sanction validation (port AUTOPILOT's test cases), events chain verify, mirror round-trip (DB → Markdown → DB) including a real Morgan drop from `to-claude/` as a fixture.
2. **Fake members**: a `fake-member` script that reads the pack from stdin and emits scripted JSON; the whole twelve-step MVP runs against two fakes in under ten seconds. This is the regression suite for the loop.
3. **Real-member smoke** (manual, once per phase): Claude ↔ Grok CLI on a toy objective ("plan a `hello` CLI"); assert the critique references the plan's artifact hash and the revision references the critique's message ID.
4. **Adversarial**: a fixture drop containing injected instructions; assert no `sanction_request` or protected action results and the flag appears in the pack.
5. **Recovery**: kill the daemon mid-run; restart; assert `interrupted` + resume; verify chain tip.
6. **Limits**: a fake reviewer that always rejects; assert Dissent after `max_revisions` and no further runs.
7. **Evidence**: a fake implementer that claims completion without a test report; assert rejection.
8. **Dashboard**: Playwright over the static page for create-chamber → approve-sanction → export.

Acceptance for the MVP is the twelve-step list in the directive, executed with real Claude and Grok CLI, with the Record showing every hop and Adam approving the directive from the dashboard.

---

## 17. Phased implementation plan

Sessions are Codex-sized units (a few hours). Each phase ends with tests green and a vault Dev Log line.

| Phase | Deliverable | Owner (primary / reviewer) | Est. |
|---|---|---|---|
| 0 — Contract | Schemas (`member-turn.json`, envelope, task, registry), seed registry, `limits.json`, repo skeleton, this plan frozen as `truth.md` v1 | Claude / Codex | 1 session |
| 1 — Store + Record + CLI | `council.db` migrations, events chain, `council` CLI (inbox/claim/ask/submit/attach/…), mirror writer + fs.watch importer, unit tests, fake members | Codex / Claude | 2 sessions |
| 2 — MCP + dispatcher | `council-mcp` stdio server, dispatcher loop, headless adapters for Claude and Grok CLI, run accounting, resume, HALT | Codex / Claude | 2–3 sessions |
| 3 — Steward + router | Steward brain prompt + schema, deterministic router with reasons, Directive lifecycle, sanction table + executor stub | Claude (prompt, schema, router spec) → Codex (code) / Grok CLI (adversarial review of the router) | 2 sessions |
| 4 — MVP proof | The twelve steps with real Claude ↔ Grok CLI; Adam approves from a minimal dashboard (Chambers, Floor, Black Seat only) | Codex / Claude; Adam runs it | 1–2 sessions |
| 5 — Codex as member | `codex exec` adapter (or automation-poll fallback), Build Chamber with evidence verification, reviewer re-runs tests | Codex / Claude | 2 sessions |
| 6 — Full dashboard | Council, Directives (compare plans), Record, Meters, registry editor, export | Codex / ChatGPT (visual direction, manual) / Claude (spec) | 2–3 sessions |
| 7 — Mirror members | Morgan lane (drops + ntfy + HANDBACK watcher), ChatGPT manual lane, Grok web bots through Morgan | Claude / Codex | 1 session |
| 8 — Chambers | Red, Limit, Tribunal (anonymised peer-ranking round, from llm-council), budgets and duplicate-criticism guard | Claude / Grok CLI | 2 sessions |
| 9 — Automation lane | BotDoor as an external tool for procedural regression, behind its own arm window | Codex / Morgan | after relay deployment (Adam) |
| later | Visual/Motion chambers via APIs with spend sanctions; local models; second PC | — | — |

Total to a working, auditable AI-to-AI loop with Adam in the Black Seat: phases 0–4, about 8–10 Codex sessions.

---

## 18. Estimated complexity and operating costs

- **Code size**: ~3–4k lines of dependency-free Node for daemon + MCP + CLI + dashboard through phase 6. Comparable to The Bench's server folder.
- **Running cost**: near zero in dollars. Headless Claude and Grok runs bill against existing subscriptions; the cost is usage-limit consumption. Expect a Deliberation (plan + critique + revision) to consume 3 runs of 5–20 minutes each. The daemon idles at a few MB of RAM.
- **Real money only enters** with image/video APIs (per generation, sanctioned) and if the BotDesk relay is deployed (Cloudflare Durable Object connected time, which BotDesk's docs already flag).
- **Adam's time**: the dashboard should take under a minute per sanction; the rest is optional watching.
- **Risk of overbuild**: high if chambers and visuals come before phase 4. The phase order is the mitigation.

---

## 19. Features that should be deferred

- Any "command chamber" visual polish before the MVP loop passes.
- Visual and Motion chambers (they depend on paid APIs or manual members).
- LibreChat or any chat UI as a member surface.
- Cloud sync of the store (the vault already syncs the human summaries).
- Multi-PC members (the Grok Build agent computer, the second PC brain).
- Automatic registry re-scoring from history beyond the simple accepted/runs ratio.
- Voice, JARVIS/KEORIS integration.
- Anything that lets a phone action grant a sanction.

---

## 20. Recommended division of work

| Work | Owner | Why (capability, not name) |
|---|---|---|
| Contract: schemas, envelope, registry format, router spec, Steward prompt, acceptance tests | Claude | Spec depth, edge-case hunting, and I already hold the full context of the bus, the seat map and the guard patterns |
| Daemon, store, MCP server, CLI, adapters, dashboard code, tests | Codex | Implementation, command execution, build verification, repo work |
| Adversarial review of router and sanction logic; contrarian review of this plan | Grok CLI | Headless, available now, zero cost, strongest "why will this fail" reviewer on the PC |
| Steward voice on the phone; Grok roster relay; mirror-lane member; BotDoor lane owner | Morgan | Only member that reaches Adam's phone and executes on the PC from there; already owns the Grok side of the bus |
| Dashboard visual direction and naming/copy of the Council language | ChatGPT (manual lane) | Visual ideation and copy, per preferences; not on the critical path |
| Pick the lead plan, approve directives, grant sanctions, run the MVP proof | Adam | Black Seat |

Explicitly **not** a permanent assignment: if Codex headless cannot be verified in phase 5, Grok CLI takes narrow implementation tasks under Claude review, and the registry says so.

---

## 21. Decisions Adam must make

1. **Planning lead** (§22) and **implementation lead** (§23).
2. **Where the Council repo lives.** I propose `Projects\apps\obsidian-council` (private repo) with state in `Projects\council\`. An empty git repo already exists at `OneDrive\Documents\ChatGPT\The OBSIDIAN COUNCIL\` (created 23:46 tonight, not by me). One home, not two; the OneDrive one syncs binaries and would fight `council.db`.
3. **Install the Codex CLI** (`@openai/codex`) so Codex can be a headless member, or accept the automation-poll fallback.
4. **Steward brain default**: Claude (my recommendation, because the Steward mostly writes structured task graphs and reads long context) or Grok CLI. Morgan keeps the Steward *seat* toward Adam either way; see the note below.
5. **Sanction expiry default** (I propose 4 hours, single-use) and the **daily budget caps** (runs per member, tokens per chamber).
6. **Whether headless runs may use `--always-approve`/bypass** inside their tool allowlists. Without it, unattended runs stall on permission prompts; with it, the allowlists and deny rules are the only guard. I recommend yes, with reviewer runs restricted to read-only tools.
7. **BotDesk relay deployment** for the Automation lane (its own owner decision, unchanged).
8. **ntfy topic** for Council cards (new secret topic, separate from the Bench topics).

**A note on "Morgan Sterling may serve as The Steward."** The Steward has to be summonable by a program at 3 a.m. Morgan today is reachable only by file drop plus Adam's phone, which puts the coordinator on the weakest transport in the room and puts Adam back in the loop for every routing decision. My recommendation keeps Morgan as the Steward *seat* Adam talks to (briefs, roster, phone), and makes the Steward *runtime* code plus a configurable model brain. If Morgan gains a machine transport (BotDoor MCP or a Grok CLI session on his side), the registry flips one field and Morgan's brain can take the role.

---

## 22. Recommended planning lead

**Claude**, for the reasons in the directive's own preference table (architecture, specification depth, limit testing), and because this proposal already carries the inspected context. The honest counter-case: Codex is the one who will build it and has run more of the recent pilots (BotDesk, Last Word, Kingsmarch) hands-on; if Codex's plan shows a simpler dispatcher or a verified headless path I missed, the lead should follow the better plan, not the preference table. I will say so in my review if that is what I find.

## 23. Recommended implementation lead

**Codex**, with Claude as the specification-compliance and limit reviewer on every Directive, and Grok CLI as the standing adversarial reviewer. Gate: nothing in phases 0–4 is "done" until the fake-member suite is green and the real Claude ↔ Grok twelve-step proof has run once with Adam approving the directive from the dashboard.

---

## Appendix A — the twelve-step MVP mapped to this design

| Step | Mechanism |
|---|---|
| 1. Adam creates a Chamber, submits an objective | Dashboard → `chambers` row + `truth.md` snapshot |
| 2. Steward breaks it into tasks | Steward brain run (schema-validated JSON) → `tasks` rows |
| 3. Router selects two members by capability | Deterministic scoring, reasons stored per task |
| 4. First member creates a plan | Dispatcher spawns primary; plan lands as `artifact(kind=spec)` + `submit` |
| 5. Second automatically receives and critiques | `review_request` message → dispatcher spawns reviewer with the plan's hash in its pack |
| 6. First receives the critique and revises | `review` message → dispatcher spawns primary with `resume` + critique → new artifact with `supersedes` |
| 7. Steward creates a final Directive | Steward run assembles directive, `content_hash` computed |
| 8. Adam approves or rejects | Black Seat pane → `sanctions` row bound to the hash |
| 9. Codex receives the approved implementation task | Dispatcher (headless) or drop + automation poll |
| 10. Codex returns implementation and test evidence | `submit` with `test_report` artifact; daemon verifies the report's command and hash |
| 11. A reviewer receives the result automatically | `review_request` → Claude run re-runs the test command read-only, files `review` |
| 12. Complete exchange visible, auditable, resumable | Floor + Record + `events.jsonl` chain + mirror files in `docs/handoffs/` |

## Appendix B — what llm-council contributes

Take: anonymised peer ranking (members review each other's Deliberation outputs without seeing who wrote them) for the Tribunal and for Red/Limit chambers, and the "show every opinion in tabs, then the synthesis" layout for the Directives compare view. Leave: OpenRouter billing, stateless conversations, JSON-file storage, no tasks/tools/approvals. Adam's directive already rejects the "several independent answers on one screen" product; llm-council is that product, done well, for a different purpose.

## Appendix C — files I would write in phase 0 (for Codex's review, not started)

```
apps/obsidian-council/
  README.md                      what it is, how to run, the twelve steps
  schemas/envelope.json          message envelope (§5.2)
  schemas/member-turn.json       what a headless run must return
  schemas/task.json  schemas/registry-member.json  schemas/directive.json
  registry/members/*.json        seeded from the directive's preferences
  registry/routing-preferences.json  registry/limits.json
  docs/truth.md                  permanent project truth v1 (this plan, trimmed)
  src/                           (phase 1+, Codex)
```
