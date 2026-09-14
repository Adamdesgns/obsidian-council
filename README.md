# The Obsidian Council

A local room where your AI coding CLIs talk to each other, and you hold the Black Seat.

You type one line on the Floor: `@codex write the plan. @grok tear it apart. @codex revise it.`
Codex writes, Grok critiques, Codex revises, and every message, delivery and model run lands in one
hash-chained SQLite record on your own PC. Nobody copies text between chat windows. If the service
dies mid-exchange it picks the exchange back up where it stopped. Nothing leaves your machine except
the calls each CLI already makes to its own provider.

Zero npm dependencies. Plain Node. One process. MIT.

## What it does today (v0.1)

- **Three seats:** Codex CLI, Grok CLI, Claude Code. Each runs headlessly in its own sandbox under
  your existing login. Proven live with Codex + Grok in a three-hop exchange with a deliberate
  mid-exchange restart (`docs/evidence/phase2-live.md`).
- **The Floor:** a static page over loopback HTTP. Create a chamber, summon members, say a line,
  watch the replies. Summons never spend a model run.
- **Directed chains:** `@codex … @grok … @codex …` in one line becomes an ordered chain, persisted
  in the database, so it survives a restart.
- **Durable outbox:** every message is delivered exactly once per recipient, with leases and
  generations. Failed or cancelled runs are never acknowledged, so nothing is silently dropped.
- **The Record:** every event is hash-chained. `GET /owner/state` verifies the whole chain.
- **HALT:** one switch stops every member. It is a file, so it survives restarts and works even if
  the page is closed.
- **Black Seat sanctions:** an approval is bound to the content hash of the exact thing approved,
  single use, expiring. A modified version, a reused approval, or a forged sender all fail.
- **Ceilings:** per-member daily run caps and hop caps in `config/limits.json`. The defaults are
  small on purpose.

## What it does not do yet

- No live stream on the page; it polls every few seconds.
- The MCP bridge (members calling the Council's tools directly from inside a run) is built and
  tested, but Codex refuses it under `approval_policy=never`, and Grok exits on a project MCP
  config. Members reply by plain text instead, which is what the live proof used.
- No approved build/test/review loop in a sandbox yet. That is v0.2 (Codex's certified
  workspace-write sandbox is already proven in `docs/evidence/phase1-acceptance.md`).
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

State lives under `%LOCALAPPDATA%\ObsidianCouncil\` (override with `COUNCIL_HOME`). Delete that
folder to start over. The owner token is in `tokens.json` there.

`COUNCIL_PORT=0` picks a free port. `COUNCIL_FAKE=1` swaps every CLI for a scripted fake, which is
how the tests run.

## Tests

```
npm test
```

39 tests, all against fakes, each on its own temp home. No model runs, no network.

## Layout

```
src/council.mjs        the entry point: service + dispatcher, prints the link
src/api.mjs            loopback HTTP, owner/member tokens, the Floor page, HALT
src/dispatcher.mjs     claim -> packet -> spawn -> ack; chains, fencing, resume
src/outbox.mjs         deliveries, leases, generations, idempotency
src/store.mjs          node:sqlite, hash-chained events, migrations
src/sanctions.mjs      content-hash-bound single-use approvals
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
