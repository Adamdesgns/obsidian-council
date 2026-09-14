# The Obsidian Council

Local coordination service that lets Adam's AI members (Claude, Codex, Grok CLI, Morgan's Grok bots, ChatGPT) talk to each other, exchange artifacts, review and repair work, and resume after interruptions, without Adam copying messages between apps. Adam holds the Black Seat.

Planning record (proposals, reviews, revised recommendations, Grok's adversarial review, the approved decision sheet): `C:\Users\steam\OneDrive\Documents\ChatGPT\The OBSIDIAN COUNCIL\docs\obsidian-council\`.

## Status

Phase 1 spike (approved 2026-09-14). No daemon, no dashboard yet. See `spike/PHASE1-ASSIGNMENTS.md`.

Runtime state, when it exists, lives under `%LOCALAPPDATA%\ObsidianCouncil\`, never in this repo and never in OneDrive.

## Spike

```
spike/budget.json            per-CLI ceiling for model runs (Adam: 10 each, $0 API)
spike/lib.mjs                shared: CLI discovery, minimal-env spawn, ledger, budget, redaction
spike/a1-resolve.mjs         A1 paths + versions (read-only)
spike/a2-auth-probe.mjs      A2 headless auth probe, 1 run per CLI
spike/a3-sandbox-negative.mjs A3 Codex sandbox escapes + STOP, 2 runs
spike/a4-grok-sessions.mjs   A4 Grok -s vs --resume proof, 4 runs
spike/a5-stub-exchange.mjs   A5 two sessions, node:sqlite outbox, crash + resume
spike/results/               reports + usage-ledger.jsonl (git-ignored)
```

Zero dependencies. Node 26.
