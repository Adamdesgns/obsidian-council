# HANDBACK — Council usage freshness + routing (2026-09-21)

Worker: Morgan Sterling (applied on AlienAdam; Grok browser drafted shapes only)
Branch: `codex/council-deliberation-complete`
Base: `8be90b9` (panel base `31f65f2`)
Tip: `88c3691`
jev-judge: untouched

## Commits (local only — no push)

1. `eb71f76` fix(usage): age checkedAt into stale; default-off Codex local reader
2. `88c3691` fix(work-orders): route coding to selected low-cost worker

## Changed paths

- `src/usage/service.mjs` — `ageAccount`, apply on `read()`
- `src/usage/codex-local-reader.mjs` — NEW (default OFF via `CODEX_LOCAL_USAGE_READER`)
- `test/fixtures/codex-token-count.jsonl` — synthetic token_count only
- `test/usage.test.mjs` — freshness + reader tests
- `web/index.html` — banner `SIMULATED USAGE — not live provider data`
- `src/work-orders.mjs` — no Codex/Claude implementing fallback; `waiting_worker`
- `test/work-orders.test.mjs` — routing assertions updated

## Commands / results

```
npm test
# 107 pass / 0 fail (was 100; +7 freshness/reader/routing)
```

## Provider connection status

All four still honestly unavailable unless fixtureMode. Codex local reader OFF by default. No live provider calls.

## Remaining gates

- Desktop + 390px screenshots of simulated/stale usage panel (not captured this pass — do not kill running apps)
- Live reader activation (separate gate)
- Live worker dispatch proof
- Owner Floor acceptance
- Push / merge / deploy — not authorized

## Notes

Browser Grok produced patch shapes but could not write the worktree. Applied and adapted against real files from Morgan seat via AlienAdam Shell.
