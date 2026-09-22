# The Obsidian Council

A local delegation desk where your AI coding CLIs pass real work to each other, and you hold the Black Seat.

## Local Work Orders (not released)

The primary workflow is **Conversation → plan together → approve → lower-cost coding → planner review → owner acceptance**. Choose Codex or Claude as planner. The selected chamber's recent conversation follows the work order. Feedback requests a revised plan and invalidates the old approval.

- **Codex and Claude plan and review.** Neither is an automatic coding fallback.
- **Cursor connection:** the local adapter pins an explicitly configured model, dispatches an approved plan, and returns its report to the original planner. The complete sequence passes fake-provider HTTP and browser tests. **Live native Windows execution is blocked:** the official 2026.09.18 agent reports no filesystem isolation. Its separate runtime is downloaded, but is not signed in. A contained Linux worker is the proposed next connection, not an implemented transport.
- **Grok:** its current adapter is read-only, so coding waits honestly. A prepared packet is never shown as a running or completed worker.

Work orders reject duplicate submissions, pause on provider failure, and stop under HALT. Interrupted coding pauses for inspection before an owner explicitly resumes it. Live provider runs use the CLI's normal login and allowance; the Council's run ceilings are not a dollar budget. Work prompts prohibit push, merge, deploy, purchases and external communication. Worker permissions and workspace containment must be certified before enabling a real coding transport.

You type one line on the Floor: `@codex write the plan. @grok tear it apart. @codex revise it.`
Codex writes, Grok critiques, Codex revises, and every message, delivery and model run lands in one
hash-chained SQLite record on your own PC. Nobody copies text between chat windows. If the service
dies mid-exchange it picks the exchange back up where it stopped. Nothing leaves your machine except
the calls each CLI already makes to its own provider.

Zero npm dependencies. Plain Node. One process. MIT.

## Optional Deliberation Engine (not released)

The local build adds **Deliberate**: two members answer independently, compare answers for up to three rounds, then bring an exact candidate answer to the Black Seat. Approve it, replace it, or cancel. Failed runs pause; Resume retries only unfinished work. No Jev account or key is needed. Approval records a decision; it does not execute it.

Run `npm run preview:fake` for a safe local walkthrough with simulated providers and a fresh temporary home. The printed link opens that fixture; type `stop` in its terminal to close it. Ordinary `npm start` uses your real configured CLIs and home.

Five seats use four adapters: `codex`, `grok`, `claude`, `fable` (another Claude seat sharing the same quota), and opt-in `cursor`. The `fable` seat uses the installed Claude CLI default unless you set its `model` in `config/council.json`; no specific live model version is certified by fake tests.

See [local acceptance evidence](docs/evidence/deliberation-local-2026-09-19.md) and [corrected implementation contract](docs/superpowers/plans/2026-09-19-deliberation-corrections.md). Main/release and Adam's human acceptance remain separate gates.

## Existing Floor and routing

- **Three CLI adapters:** Codex CLI, Grok CLI, Claude Code, using your existing logins and
  their configured review restrictions. Proven live with Codex + Grok in a three-hop exchange with a deliberate
  mid-exchange restart (`docs/evidence/phase2-live.md`).
- **The Floor:** a static page over loopback HTTP. Create a chamber, summon members, say a line,
  watch the replies. Summons never spend a model run.
- **Directed chains:** `@codex … @grok … @codex …` in one line becomes an ordered chain, persisted
  in the database, so it survives a restart.
- **Durable outbox:** idempotent messages with leased deliveries and generation fencing.
  Interrupted provider execution may retry; it is not exactly once. Deliberation replies, acknowledgment
  and next steps commit together. Failed deliberations pause for explicit resume.
- **The Record:** every event is hash-chained. `GET /owner/state` verifies the whole chain.
- **HALT:** one switch stops every member. It is a file, so it survives restarts and works even if
  the page is closed.
- **Black Seat sanctions:** an approval is bound to the content hash of the exact thing approved,
  single use, expiring. A modified version, a reused approval, or a forged sender all fail.
- **Ceilings:** per-account daily run caps and hop caps in `config/limits.json`. The defaults are
  small on purpose.

## What it does not do yet

- No live stream on the page; it polls every few seconds.
- The MCP bridge (members calling the Council's tools directly from inside a run) is built and
  tested, but Codex refuses it under `approval_policy=never`, and Grok exits on a project MCP
  config. Members reply by plain text instead, which is what the live proof used.
- Claude and Grok remain read-only on Windows; only Codex has the certified workspace-write sandbox.
- Cursor's lifecycle is implemented and fixture-tested, but its native Windows coding connection remains blocked on workspace containment and login. See [takeover evidence](evidence/2026-09-22-takeover/REPORT.md).
- No phone, no remote access, no auth beyond the loopback bearer tokens. Do not expose the port.
- Windows only for now. The spawn code uses `taskkill` and Windows paths.

## Quickstart

You need Node 24 or newer (`node:sqlite`) and at least two of these CLIs installed and logged in:
`codex`, `grok`, `claude`.

```
git clone https://github.com/Adamdesgns/obsidian-council
cd obsidian-council
npm start
```

It prints one link:

```
  Open this link (it carries your owner token, keep it private):
  http://127.0.0.1:4777/#owner=…
```

Open it. The Floor keeps the token in that browser and scrubs it from the address bar. Then:

1. **Create** a chamber.
2. **Summon** the members (free, no model run).
3. **Say** a line with `@` names. Replies appear on the Floor as each run finishes.

State lives under `%LOCALAPPDATA%\ObsidianCouncil\` (override with `COUNCIL_HOME`). The owner token is in `tokens.json` there.

`COUNCIL_PORT=0` picks a free port. `COUNCIL_FAKE=1` swaps every CLI for a scripted fake, which is
how the tests run.

## Tests

```
npm test
```

86 tests against fake providers and temporary homes. The test launcher refuses live provider execution.
HTTP tests use loopback only; no external API calls.

## Layout

```
src/council.mjs        the entry point: service + dispatcher, prints the link
src/api.mjs            loopback HTTP, owner/member tokens, the Floor page, HALT
src/dispatcher.mjs     claim -> packet -> spawn -> ack; chains, fencing, resume
src/outbox.mjs         deliveries, leases, generations, idempotency
src/store.mjs          node:sqlite, hash-chained events, migrations
src/sanctions.mjs      content-hash-bound single-use approvals
src/deliberation.mjs   durable blind/debate/owner/resume state machine
src/seats.mjs          configured adapter/model/account roles
src/verdict.mjs        strict final-line debate verdicts
src/mcp-bridge.mjs     stdio MCP server over the HTTP API (off by default)
src/adapters/          one spawn path; claude / codex / grok argv and sandbox flags
web/index.html         the Floor
config/limits.json     daily ceilings, timeouts, hop caps
config/council.json    host, port, lease
spike/                 Phase 1 evidence scripts (kept as-is)
docs/evidence/         acceptance tables and the live proof
```

## How it was built

Planned by three assistants (Claude, Codex, a Grok bot) each writing an independent proposal,
reviewing each other's, and revising. Built overnight on 2026-09-13/14 by Claude as lead with a
Grok bot doing the tasks through Cursor, every commit checked out cold and tested before the next
task was posted. The acceptance tables in `docs/evidence/` are the audit trail.

## License

MIT.
