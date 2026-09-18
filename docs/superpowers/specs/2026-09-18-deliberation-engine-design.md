# The Deliberation Engine — design

**Date:** 2026-09-18
**Status:** approved design, not yet implemented
**Branch:** `council/deliberation`

## The problem

Today the Floor is a relay. You say something, members answer, the answers land in a log.
Nothing reconciles two answers that disagree, and nothing stops a weaker model's confident
wrong answer from being the last word.

This spec adds one loop: **one question in, one agreed answer out, with you holding veto.**

## Roles, not seats

Members are assigned roles in config. Roles are what the engine reasons about; names are
data.

| Role | Members today | What it does |
|---|---|---|
| Deliberator | `codex`, `fable` | Answers blind, then debates to agreement. The pair whose disagreement is worth paying for. |
| Executor | `grok`, `jev` (later) | Does not deliberate. Carries out the settled decision and does the talking. |
| Arbiter | **owner (Adam)** | Breaks deadlocks. No model arbiter — see Decisions. |
| Black Seat | owner (Adam) | Final approval on every settled answer. |

### A seat is an (adapter, model) pair

A seat is not a hardcoded name. It is an adapter plus an optional model:

```json
{ "id": "fable", "adapter": "claude", "model": "claude-fable-5-1", "role": "deliberator" }
{ "id": "codex", "adapter": "codex", "role": "deliberator" }
{ "id": "grok",  "adapter": "grok",  "role": "executor" }
```

`src/adapters/claude.mjs#argsFor` gains `--model <model>` when a model is set. This is how
Fable exists at all, and how an Opus seat or JEV slots in later without touching the engine.

### Executor selection

Executors are a pool, not a seat. When the engine needs work carried out it picks the
executor with the lowest measured cost per run, read from the existing `runs` table
(`tokens_in`, `tokens_out`, `cost_reported`). The owner can pin a specific executor per
deliberation. JEV's claimed token advantage gets measured here rather than assumed.

## The state machine

One `deliberations` row per question, driven by the existing dispatcher tick. No second
loop, no new process.

| State | What happens | Runs |
|---|---|---|
| `answer_1` | First deliberator answers the question alone | 1 |
| `answer_2` | Second deliberator answers the same question alone | 1 |
| `debate_1` … `debate_3` | Both see the full chamber; each must end with a verdict line | 2 each |
| `pending_owner` | Sits in the Black Seat awaiting approval | 0 |
| `settled` | Approved (by owner, or by proxy under a standing delegation) | 0 |
| `overruled` | Owner replaced the answer with their own | 0 |
| `stalled` | A run failed mid-deliberation. Question, answers, verdicts and round are all preserved; resumes when the member can run again | 0 |
| `abandoned` | HALT or owner cancel. **Never** a run failure — those stall | 0 |

Transitions:

- `answer_1` → `answer_2` → `debate_1`
- `debate_n`: both `AGREE` → `pending_owner`
- `debate_n`: otherwise → `debate_n+1`
- `debate_3` ends without agreement → `pending_owner`, flagged `deadlock`
- any `ESCALATE` at any point → `pending_owner`, flagged `escalated`, remaining rounds skipped

## Blindness in round one

`answer_1` and `answer_2` receive packets containing **only the owner's question**. The
second deliberator cannot see the first's answer because the engine does not put it in the
packet — `buildPacket` renders whatever message text it is handed
(`src/adapters/packet.mjs`).

This is the property that makes two opinions worth more than one, so it is asserted
directly: a test builds the `answer_2` packet and asserts the first answer's text does not
appear in it. If the packet builder is later widened, that test fails.

## The verdict protocol

Every debate reply must end with exactly one line:

```
AGREE: <the answer both now hold>
DISAGREE: <what is still wrong>
ESCALATE: <why this needs the owner now>
```

Parsing rules:

- Last matching line in the reply wins.
- **A missing or malformed verdict line is treated as `DISAGREE`.** Conservative by
  design: a model that cannot follow the format has not demonstrated agreement.
- `ESCALATE` from either deliberator short-circuits to the owner immediately.

## The owner gate

Every settled answer becomes a pending sanction using the existing content-hash gate
(`src/sanctions.mjs`). The Black Seat shows the question, both answers, the debate, and the
flag (`agreed` / `deadlock` / `escalated`). The owner approves, or writes their own answer
to overrule.

Nothing is the answer until it clears this gate.

### Standing delegations (autopilot)

For routine work the owner can pre-authorize a deliberator to approve on their behalf.

**`assertSanction` is not weakened.** Owner remains the only source of authority. A
delegation is an owner-signed grant recorded in advance; a proxy approval is checked
against it.

A delegation row carries:

- `grantee` — which member may approve (`fable` or `codex`)
- `scope` — what kinds of decisions, matched against the deliberation's declared category
- `expires_at` — wall-clock expiry, required
- `max_uses` / `uses` — bounded count, required
- `granted_by` — always `owner`, enforced
- `revoked` — instant kill

Every proxy approval is recorded in the hash chain as
`approved by <grantee> under delegation <id> granted by owner at <ts>` — the chain shows
both the proxy and the authority it acted under, always.

**Never delegable**, regardless of scope: anything that sends, posts, pushes, publishes,
spends, or places an order; and any change to the delegation system itself. These are
refused even with a matching delegation. (House rule: the owner owns send, post, push,
publish, spend and every order.)

HALT disables all proxy approval. Revocation is immediate and retroactive for unused
grants.

## Budget

Runs per deliberation:

- **Floor** — agreement in `debate_1`: **4 runs** (2 deliberators × 2 turns)
- **Ceiling** — three rounds without agreement: **8 runs**

There is no cheaper path. OpenThink's zero-cost fast path exits on *identical* answers,
which does not occur with prose; it is not adopted.

Against current ceilings (`config/limits.json`: codex 15, claude 10, grok 15) with Fable on
the `claude` CLI, the claude ceiling of 10 binds first: roughly **2 deliberations a day**
worst case, 5 at the floor. Grok's 15 now goes largely unused.

**Rebalancing those ceilings is an owner spend decision and is out of scope here.**

**Preflight:** a deliberation refuses to start unless the remaining daily budget covers the
worst case (4 runs per deliberator). Declining up front beats stranding a debate
half-finished.

**Running out mid-deliberation.** Preflight only knows this Council's own daily counters.
It cannot see the provider's real subscription limit, which can be exhausted at any
moment by work done outside the Council entirely. So a run *will* sometimes fail partway
through a debate.

When that happens the deliberation **stalls, it does not abandon.** The row keeps its
question, both answers, the verdicts so far and the round; `resumeStalled` puts it back
on the floor once the member can run again, and the deterministic idempotency keys make
the re-send a no-op rather than a duplicate. Abandoning would destroy up to six runs of
real spend because the seventh hit a wall.

Every run failure stalls, not only budget-shaped ones. Nobody here has yet seen what the
Claude, Codex or Grok CLIs actually print when a subscription limit is hit, so branching
on a guessed error string would silently mis-handle the real thing. The raw exit code,
stdout and stderr are recorded in `stall_detail` so the first genuine exhaustion teaches
us its signature.

**Substituting a different seat mid-debate is deliberately not automatic.** Swapping a
deliberator changes who agreed to what, which is exactly the kind of quiet rewrite this
system exists to prevent. If a seat is out for the day, the owner reassigns or cancels.

## Data model

New migration `003_deliberations.sql`:

```sql
CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  chamber_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  flag TEXT,
  deliberators TEXT NOT NULL,
  answer_ids TEXT,
  final_answer TEXT,
  content_hash TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  grantee TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
```

## Files

| File | Change |
|---|---|
| `src/deliberation.mjs` | New. State machine, verdict parsing, preflight, executor selection. |
| `src/delegation.mjs` | New. Grant, check, revoke, never-delegable list. |
| `src/migrations/003_deliberations.sql` | New. |
| `src/adapters/claude.mjs` | Add `--model` to `argsFor`. |
| `src/dispatcher.mjs` | Hook: on member reply, advance the owning deliberation. |
| `src/api.mjs` | `POST /owner/deliberate`, `GET /owner/deliberation/:id`, delegation grant/revoke. |
| `config/council.json` | Seat definitions with adapter, model, role. |
| `test/deliberation.test.mjs` | New. |
| `test/delegation.test.mjs` | New. |

## Testing

All headless against `src/testutil/fake-member.mjs`, temp home per test, zero spend.

1. Round-one blindness: first answer's text absent from second packet
2. Both `AGREE` in `debate_1` → `pending_owner`, 4 runs total
3. Persistent `DISAGREE` → three rounds → `pending_owner` flagged `deadlock`
4. `ESCALATE` in `debate_1` → immediate `pending_owner`, remaining rounds skipped
5. Malformed verdict line → treated as `DISAGREE`
6. Preflight refuses when remaining budget < 8 runs
7. Owner approval settles; owner overrule replaces the answer
8. Proxy approval succeeds under a valid delegation, chain records grantee + delegation
9. Proxy approval refused: expired, over `max_uses`, revoked, wrong scope, HALT active
10. Proxy approval refused for a never-delegable category even with matching scope
11. Non-owner grant attempt refused

## Decisions

- **No model arbiter.** A Codex↔Fable deadlock goes straight to the owner. Fable cannot
  neutrally rule on a debate it is half of, and the owner is the final word regardless. An
  Opus arbiter seat can be added later if deadlocks become frequent enough to be a nuisance.
- **Deliberators blind in round one.** Sequential in order, blind to each other's content.
- **Malformed verdict = disagree.** Bias toward escalation over false consensus.
- **Delegation by standing grant, not by weakening the gate.**

## Out of scope

- The round table and orb visual (next piece, builds on this)
- Voice control
- JEV wiring — the role slot exists; the seat is added when access exists
- Rebalancing `config/limits.json` — owner spend decision
- Live SSE on the Floor — still polling

## Open question

`scope` matching is specified as a declared category per deliberation matched against the
delegation's scope. The category vocabulary itself is not yet defined — it needs one pass
with the owner once real deliberations exist and the routine ones are identifiable.
Until then, delegations can be granted only with explicit scope strings and no wildcard.
