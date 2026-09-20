# Deliberation Engine — one question in, one agreed answer out

- Status: **spec locked, plan open.** Task 1 and the judge landed on `cursor/deliberation-engine-judge-task1-26e9`.
- Base: `main` at `dee4728` (PR #1: owner-say contract, chain routing, idempotency).
- Authority: Adam's overnight brief of 2026-09-20. Nothing here changes the loopback, routing, or
  ceiling rules already on `main`; it builds on them.

## What a Deliberation is

The owner asks one question on the Floor. Two members take it through a fixed exchange —
**plan → critique → revise** — and a **judge** decides whether the revision actually answers the
question. If it does, exactly one message of kind `answer` goes back to the owner. If it does not,
the exchange gets one more critique round; when rounds run out, or the judge cannot tell, or a
ceiling / HALT / blocked seat interrupts, the run **stalls with everything it has produced so far**
and waits for the owner to resume it. Nothing spent is thrown away.

This is the Phase 2 G2 loop (Codex plan → Grok critique → Codex revision, already proven live)
made into a first-class object with a name, a state, a checkpoint, and a verdict.

## Product rules (locked)

1. **Loopback only.** The Floor stays on `127.0.0.1:4777`. No port exposure, no tunnels, no
   weakening of the Host/Origin checks in `api.mjs`.
2. **Server-side routing only.** The Floor never parses `@mentions` for routing. The owner's raw
   line goes to `POST /owner/say` / `routeOwnerSay`; the routing contract in `src/routing.mjs`
   decides who speaks. The Deliberation Engine derives producer and reviewer from that same
   contract, never from the page.
3. **`@owner` is plain text, never a hop.** The owner is the floor, not a seat. `MEMBERS` in
   `routing.mjs` is the routable set; `owner` is not in it and cannot be a producer or reviewer.
4. **Free screen first; typed model only when needed; no live key tonight.** The judge
   (`src/judge.mjs`) decides the obvious cases with deterministic local heuristics. Only an
   `uncertain` screen may call the typed "Jev" client, and its `TypedVerdict` is validated before it
   is trusted. There is no live client in the repo; tests use `src/testutil/fake-jev.mjs`.
5. **Stall and resume, never discard.** A run that cannot continue keeps its plan, critique, and
   revision, records why it stopped and where, and resumes from exactly that state. Restarts fence
   open runs into `stalled`, the same way `fenceOpenRuns` fences open model runs.
6. **One question in → one agreed answer out.** A run ends `agreed` with a single `answer`, or it
   is `stalled` waiting for the owner. There is no third terminal state and no partial answer.

## The run (Task 1, landed)

`src/deliberation.mjs` is a pure reducer over a plain JSON object. It has no database, no clock
beyond an injectable `now`, and no I/O, so every later task can persist it, replay it, and test it
without a Floor.

```
open ──start──▶ planning ──plan──▶ critiquing ──critique──▶ revising ──revise──▶ judging
                                       ▲                                            │
                                       └──── verdict:unresponsive (round < max) ────┤
                                                                                    ├── verdict:responsive ──▶ agreed (answer set)
                                                                                    ├── verdict:unresponsive (rounds exhausted) ──▶ stalled
                                                                                    └── verdict:uncertain ──▶ stalled
any non-terminal ──stall(reason)──▶ stalled ──resume──▶ the state it stalled from
```

- `createDeliberation({ question, producer, reviewer, chamber_id?, max_rounds? })` validates:
  non-empty question; producer and reviewer are distinct members of `MEMBERS`; `owner` is refused.
- `advance(run, event)` returns a **new** run; the input is never mutated. Illegal transitions
  throw `DeliberationError` with `code: "illegal_transition"`; advancing an `agreed` run throws
  `code: "terminal"`.
- Artifacts (`plan`, `critique`, `revision`) accumulate per round in `run.rounds[]`; the current
  round's artifacts are also on `run.artifacts`.
- `stall` records `{ reason, from, at }`; `resume` clears it and returns to `from`. Artifacts and
  round count survive both.
- `agreed` sets `run.answer = { content, judged_by, round }` — the one answer out.
- `run.history[]` is an append-only log of every transition, ready to become `events` rows.

## Plan — 14 TDD tasks

Each task is one commit with its test written first. "Done" means `node --test` is green on a
clean checkout with `COUNCIL_HOME` at a temp folder, against fakes only.

| # | Task | Deliverable | Acceptance | Status |
|---|------|-------------|------------|--------|
| 1 | **Run state machine** | `src/deliberation.mjs`: `createDeliberation`, `advance`, `isTerminal`, `canResume`, `STATES`, `DeliberationError` | `test/deliberation.test.mjs`: happy path to `agreed`; second round on `unresponsive`; `rounds_exhausted` and `verdict_uncertain` stall rather than discard; stall from every non-terminal state and resume to the same state with artifacts intact; illegal transitions and terminal advances throw; input never mutated; `owner` and duplicate seats refused | **done** |
| 2 | **Seats from the routing contract** (retargeted to `routing.mjs` after PR #1) | `seatsFromLine(content, { default_pair })` in `routing.mjs`: first two distinct `MEMBERS` mentioned become producer/reviewer; fewer than two → `DEFAULT_BROADCAST` fills in; `@owner` never counted | `@codex … @grok` → codex/grok; `@grok … @codex` → grok/codex; `@codex only` → codex + first default that is not codex; `@owner and @codex` → same as `@codex`; no mentions → default pair | open |
| 3 | **Persistence** | `src/migrations/003_deliberations.sql` (`deliberations(id, chamber_id, question, producer, reviewer, state, round, max_rounds, stall_reason, stall_from, answer, run_json, created, updated)`); `saveDeliberation` / `loadDeliberation` inside `store.commit` with event kinds `deliberation_opened`, `deliberation_advanced`, `deliberation_stalled`, `deliberation_resumed`, `deliberation_agreed` | round-trip equals `advance` output; each transition is one event; `verifyChain` ok | open |
| 4 | **Open from the Floor** | `POST /owner/deliberate { content, chamber_id }` in `api.mjs`: seats via Task 2, run via Task 1, persisted via Task 3, then the plan request goes to the producer through `routeOwnerSay` with `kind: "plan"` and `deliberation_id` on the message | one message, one delivery, one `deliberation_opened`; member token → 403; non-loopback Host → 403 | open |
| 5 | **Plan → critique** | Dispatcher: when a `kind: "plan"` reply for a deliberation is acked, `advance(plan)` and send `kind: "critique"` to the reviewer with the plan as content | fake producer reply produces exactly one delivery to the reviewer; state `critiquing` | open |
| 6 | **Critique → revise** | Same hook: `kind: "critique"` reply → `advance(critique)` → `kind: "revise"` to the producer with plan + critique | one delivery to the producer; state `revising` | open |
| 7 | **Judge the revision** | On `kind: "revise"` reply: `advance(revise)` → `judge.judge(question, revision)` with `createJudge({ client: opts.jevClient ?? null, maxTypedCalls })` → `advance(verdict)` | responsive → `agreed`; unresponsive → round 2 critique; uncertain with no client → `stalled/verdict_uncertain`; fake Jev called only on an uncertain screen | open |
| 8 | **One answer out** | On `agreed`, one `kind: "answer"` message to `owner` with `deliberation_id`, idempotency key `delib:<id>:answer` | exactly one answer row even if the ack path re-runs; the Floor shows it as the answer, not as a reply | open |
| 9 | **Stall on interruption** | Dispatcher hooks: hop cap, `auto_reply_cap`, daily ceiling refusal, `blocked` presence, HALT file → `advance(stall, reason)` and persist | each cause yields `stalled` with the right `reason` and `from`; artifacts intact; no `answer` | open |
| 10 | **Resume from the Floor** | `POST /owner/deliberation/:id/resume`: `advance(resume)`, re-issue the pending request for `from` (plan/critique/revise/judge) with the **same** idempotency key so nothing is re-spent | resuming twice sends nothing new; a run stalled in `judging` re-judges without a model run; member token → 403 | open |
| 11 | **Fence on restart** | `fenceOpenRuns` also stalls every non-terminal deliberation with `reason: "restart"`; `start()` lists them for the Floor | kill between critique and revise → on restart the run is `stalled/restart` at `revising`, not lost, and resumes | open |
| 12 | **Floor** | `GET /owner/deliberations`; the page shows question, state, round, stall reason, the answer, and a Resume button that POSTs Task 10. No `@` parsing on the page. | HTTP test for the list route; page sends raw line + button only | open |
| 13 | **Typed-model budget and corpus** | `limits.json` gains `judge.max_typed_calls_per_run` and `judge.max_typed_calls_per_day`; `scripts/judge-coverage.mjs` gains `--from-db` to build fixtures from real `messages` rows so the free screen improves against actual member prose | budget refusal is a `stall/typed_budget`; coverage script stays at zero wrong decisions | open |
| 14 | **End to end** | `test/deliberation.e2e.test.mjs` with fake members and fake Jev: one question, stall by HALT mid-critique, resume, one answer; `docs/evidence/deliberation-e2e.md` | exactly one `answer` message; `verifyChain` ok; every deliberation event present in order | open |

## Out of scope for this branch

KEORIS, phone, Tailscale, any live Jev/TypeSafe call, secrets, exposing 4777, and tasks 2–14.
