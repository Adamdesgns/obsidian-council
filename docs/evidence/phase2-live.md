# Phase 2 live proof (P2-6c attempt 2)

- At: 2026-09-14T10:57:06.989Z (UTC)
- Home: `C:\Users\steam\AppData\Local\ObsidianCouncil\live-phase2-20260914-012631`
- Line: @codex write a 5-line plan for a Node CLI that prints today's date in ISO format. @grok critique that plan in at most 5 numbered points. @codex revise the plan in 5 lines using the critique.
- Restarted after first chain reply: false
- Runs: 6 / 6 (model runs excl. interrupted: 6)
- Chain ok: true
- **Verdict: FAIL**
  - FAIL condition: every codex/grok run exit===0 (excl. interrupted); got: codex:0, grok:1, codex:0, codex:0, grok:1, grok:1
  - FAIL condition: three member messages with adapter final text (len>=40, not JSON); got 1 of 1
  - FAIL condition: at least one delivery answered with attempt_gen>=2

## Run IDs (with bridge status)

- ebbcb142-9bc2-408c-87a8-cd28e91d0955 codex exit=0 bridge=unknown started=2026-09-14T06:26:41.413Z
- 50401f92-be9e-46eb-b36b-01439870a330 grok exit=1 bridge=unknown started=2026-09-14T06:27:07.011Z
- fb38be5b-bca6-4ed4-adcf-b886da2672ec codex exit=0 bridge=unknown started=2026-09-14T06:27:17.604Z
- 66aac6a4-1cde-4b6f-bf09-60a780189f54 codex exit=0 bridge=codex-c-flags started=2026-09-14T10:56:52.019Z
- 5c1f7fea-a19a-484f-8f4d-cc001d0b2db8 grok exit=1 bridge=unknown started=2026-09-14T10:56:52.035Z
- bca6b5a7-21af-4936-97a5-d6751d53dadd grok exit=1 bridge=unknown started=2026-09-14T10:56:58.047Z

## Floor messages (first 300 chars)

- **summon** from owner: "You are summoned."
- **say** from owner: "@codex write a 5-line plan for a Node CLI that prints today's date in ISO format. @grok critique that plan in at most 5 numbered points. @codex revise the plan in 5 lines using the critique."
- **respond** from codex: "Council context and inbox calls were blocked: “MCP tool call requires approval, but approval policy is never.” I can’t retrieve or acknowledge the summons until bridge access is enabled."

## Deliveries (answered / gens)

- id=5 recipient=codex status=answered gen=1
- id=6 recipient=grok status=leased gen=2
- id=7 recipient=codex status=pending gen=0
- id=8 recipient=owner status=pending gen=0

## Log

```
2026-09-14T10:56:52.011Z chamber c356fa42-561d-4964-ab14-63205d36287b
2026-09-14T10:56:52.166Z dispatcher started
2026-09-14T10:56:54.180Z runs=5 chainMemberMsgs=0 toOwner=0 restarted=false
2026-09-14T10:56:56.188Z runs=5 chainMemberMsgs=0 toOwner=0 restarted=false
2026-09-14T10:56:58.201Z runs=6 chainMemberMsgs=0 toOwner=0 restarted=false
2026-09-14T10:56:58.201Z hit run cap
```

## Attempt-2 notes (Morgan / executor)

- Verdict FAIL as recorded above. **No re-run** (authority: one attempt).
- Shell had stale `COUNCIL_HOME=C:\Users\steam\AppData\Local\ObsidianCouncil\live-phase2-20260914-012631` from the early P2-6 live; the runner reused that DB, so run counts included 3 prior rows and the cap tripped after only 3 new spawns.
- New-spawn outcomes still weak: Grok `exit=1` (cancelled-class), Codex summon reply cited MCP approval policy `never`; chain never advanced; no `attempt_gen>=2` answered delivery.
- `live-proof.mjs` will be patched to always mint a fresh home (ignore inherited `COUNCIL_HOME`) so a future authorised attempt cannot hit this footgun.
