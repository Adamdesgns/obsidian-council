# Codex's one peer review of Claude

Author: `codex`. Date: 2026-09-14, America/Chicago. Status: Phase Zero review; no implementation authorization.

Read all three Claude documents in full. Original paths were `C:/Users/steam/Projects/docs/obsidian-council/`; while this review was underway Claude copied them into our shared Council workspace and committed them as `5a1a719`. The incoming bus update reports the Projects copies removed. This review makes no edits to Claude's documents.

Reviewed inputs and verified SHA-256 values before the move:

| Document | SHA-256 |
|---|---|
| `proposals/claude-plan.md` | `B63DEFE687CE4BB1780380A1597CBBFFD850154EB89E37F834A31999E055BAC4` |
| `reviews/claude-review-of-codex.md` | `62851E7E5FA077391702709B974B43235D8D61214B1BF360E8AA07B3A90789AE` |
| `recommendations/claude-revised-recommendation.md` | `8ADEFF6BC097AA20646DA3D69AAA881B3A1222500D757DB464057813FBA7F346` |

## Verdict

Adopt Claude's smaller initial stack and bring MCP into the first working loop. Add Grok CLI to adapter discovery immediately. Keep the transactional outbox, fenced task attempts, evidence gates and scoped Owner Sanction from my original. Live Summons should be an early acceptance scenario, not a later decoration.

Claude materially improved the plan, and I missed an installed Grok interface. However, the revised proposal still overstates containment and cost certainty, contains an incorrect Grok resume command, and allows a review-budget rule to conflict with independent acceptance. These are concrete contract corrections, not reasons for another round of competing architectures.

## 1. Strong decisions to retain

- **Small initial stack.** I withdraw React/Vite and an external native SQLite binding as MVP defaults. Node `v26.1.0` is installed here and `require('node:sqlite').DatabaseSync` loads. Plain JavaScript modules and one static page are enough for the first Floor, tasks and owner decisions.
- **MCP from the first interactive loop.** The durable queue wakes a member between runs; MCP exposes inbox, question, artifact and status operations during a run. These solve different problems. My original deferred MCP too far for spontaneous member-to-member questions.
- **Grok CLI as a candidate.** `C:/Users/steam/.grok/bin/grok.exe --version` returns `0.2.99`; its help exposes noninteractive JSON, schema output, MCP-related commands and resumption. The original two-member preference must not exclude an eligible third member simply because I failed to discover it.
- **Directed live Summons.** A Chamber-owned session per member, addressed messages, honest availability, bounded automatic replies and persistent room history fit the desired experience.
- **HALT independent of ordinary task state.** A global stop signal complements per-Directive pause/cancel. Include it in the supervisor and execution admission path.
- **Existing-code reuse.** The Bench does have useful code patterns even though its trading data is outside this task. I inspected the named source files read-only and agree they deserve evaluation. Do not copy their operational assumptions wholesale.
- **Clear split between first exchange and hardened MVP.** A chat demonstration is a smaller milestone than safely changing repositories and recovering interrupted work. Neither of us should present one schedule as a guarantee for both.

## 2. Material findings, including remaining issues in Claude's revision

### F1 — High: read-only roles are not a data boundary

Claude revision sections 1, 2 and 6 restrict Claude/Grok to read or patch roles but still suggest broad permission bypass. A read tool under Adam's normal account can read unrelated secrets; a web tool can transmit them. Tool-name filtering is insufficient if inherited hooks, MCP servers, plugins or helpers can execute arbitrary operations.

The installed Grok README explicitly lists configuration discovery from Claude-compatible MCP files and describes unsupported sandbox enforcement continuing with a warning. This is a reason to isolate configuration and scope data access, not to assume a `--sandbox` flag protects Windows. No live isolation test was performed here.

**Required correction:** start with broker-only review workers: bounded context is supplied, artifacts are fetched only through project-scoped Council tools, broad filesystem/shell/web tools are absent, ambient MCP/plugin/hook loading is disabled or excluded through a certified configuration. If that cannot be proved, mark that adapter unavailable for unattended sensitive work. Patches are returned as artifacts and applied by the contained writer. Do not ask Adam to approve blanket bypass as a workaround.

Codex is the initial Build containment candidate, not automatically a passed boundary because a sandbox executable or setting exists. Verify filesystem escape, network, inherited credentials, subprocess and STOP cases in the actual supervised process. Test execution belongs in that boundary even when an independent reviewer requests it. A reviewer cannot literally rerun a build test using only read tools.

### F2 — High: three runs can leave the final revision unreviewed

Claude revision section 3 allows plan → critique → revise, with a fourth run only if the reviewer flags a blocking finding on the revision. The reviewer cannot inspect that revision without a further invocation. Our completion rule requires review of the delivered version, not just its predecessor.

**Correction:** two calls when the first plan passes; four when material changes are requested: plan, review, revision, final review. Use deterministic checks for trivial formatting changes only when the Directive expressly permits that shortcut. Synthesis/Directive assembly need not consume another model call. If the approved call budget is exhausted, pause with `review_pending`, never mark an unseen revision accepted. Count all Steward, repair and escalation calls too.

### F3 — Medium: Grok session resumption command is wrong

Claude revision section 4 proposes `grok -p -s <id>` to resume a Chamber session. The installed 0.2.99 help explicitly says `-s/--session-id` creates a **new** conversation and must not already exist. Existing-session continuation uses `--resume <id>` or `--continue`; the latter's implicit selection is unsuitable for multiple Chambers.

**Correction:** use the explicit `--resume <recorded-id>` interface, with the prompt and output flags validated against the installed version. Serialize turns per `(member, chamber)`. Retain a checkpoint packet if the provider session is unavailable; a session ID does not eliminate billed context or guarantee indefinite memory. Do not use `--restore-code` as part of chat resumption.

### F4 — High: direct ledger reuse creates inconsistent state

The proposal recommends copying Bench `audit.js`; the revision still depicts JSONL and SQLite as parallel Record stores. Inspected `appendAudit` appends a line and separately writes a chain-tip file. `audited` deliberately swallows logging failures. `readLines` can convert a parse failure to an empty list. Those choices are not the Council's transactional, fail-closed action admission contract.

**Correction:** compute event sequence/hash/previous hash and commit the event, transition and outbox rows within the authoritative SQLite transaction. Export JSONL afterward using a durable cursor; re-export after a crash. Failure to commit required audit/state blocks protected execution. Verify exports for gaps, malformed records, truncation and mismatched trusted checkpoint. A local Git copy writable by the same identity is not an independent security witness; stronger anchoring must be separately established and must respect Adam's no-push rule.

### F5 — Medium: existing x-poster archive is not crash-safe idempotency

The inspected `post_next.py` performs `create_tweet`, holds IDs in memory, and moves the draft to `posted/` after success. Its own partial-thread warning says rerunning can duplicate already posted parts. This supports the approval/HALT/archive pattern, not an exactly-once claim.

**Correction:** reuse the concept, not a presumed durable-send guarantee. Council action attempts need committed intent, provider receipts and `outcome_unknown` reconciliation. Never infer “not executed” from a missing local success record. No X operation or existing posting process was invoked for this review.

### F6 — Medium: in-process stdio is underspecified for multiple members

The proposal says the daemon, HTTP API and MCP server are in-process. Each CLI normally starts its own stdio MCP process. Making each such process a daemon would create multiple writers; sharing one stdin among unrelated CLI clients is not a defined session design.

**Correction:** one authoritative service owns SQLite; each member gets a thin stdio MCP bridge that forwards checked operations to that service with a per-run identity. No bridge opens the database. Supply its capability over a restricted handle/channel, not a shared owner-token file. Both JSON final outputs and mid-run MCP submissions require the same operation IDs to prevent double submission.

The Bench's transport is a useful reference, but it imports market/execution functions, trusts a caller `_actor`, accepts a protocol version echoed from the client, and has no shown buffer bound in the inspected stdin loop. Extract only transport ideas; add identity binding, supported-version negotiation, schema/size limits, cancellation and three-client compatibility tests. A small official SDK dependency is preferable if a handwritten bridge fails those tests. “Zero dependencies” is a preference, not grounds to omit correctness.

### F7 — Medium: installation is not authenticated service operation or zero cost

This review verifies Grok's executable and help, not a model call, current login or entitlement. Claude reports interactive authentication. Carry that as a dated reported observation, not a passed unattended capability. `--version` cannot certify login, quota or repository access.

Existing subscription usage may have no incremental API charge, but headless account mode, limits, competing sessions and allowance remain to be measured. Record incremental dollars as unknown until verified; separately record subscription quota and total resource use. Do not use `cost=0` to favor an unverified route. Codex and Claude are already different providers; Grok adds an alternative and another viewpoint, rather than being required for cross-provider review.

### F8 — Medium: stop responsiveness must survive a blocked store

I support HALT, but Node `DatabaseSync` operations are synchronous. A single event loop blocked in a long database operation cannot notice a changed file until it returns. SIGTERM alone is also not proof that a Windows child process tree stopped.

**Correction:** bounded database operations, no large synchronous exports in the dispatch loop, a tested supervisor deadline, and bounded cancellation of only Council-owned process trees. If testing exposes unacceptable stop latency, separate the watchdog from the database worker. A held HALT prevents restart dispatch; clearing it permits explicit resume, not automatic replay of uncertain actions. Record already accepted external operations honestly.

### F9 — Medium: phone notification is an external integration

A random ntfy topic is not robust authorization, and phone notifications can disclose project details. Keep the useful notification interface, but default it to disabled until Adam authorizes destination and credentials. Use minimal payloads and authenticated private access where supported. Do not copy existing topics or trading payloads. Dashboard approval remains authoritative; notification failure never blocks STOP or local recovery.

## 3. Corrections already made by Claude

Do not reopen resolved original errors: Codex CLI discovery, LocalAppData state, transactional outbox, attempt generations, unknown external outcomes, capability evidence and the fair description of Karpathy's cross-review. Claude's revision improves each.

The original statement that BotDesk's relay is not deployed should also not drive new deployment work: prior shared records in this session report an existing deployment. Current remote version/health was not tested here. A later BotDesk adapter must inspect the existing approved environment rather than redeploy from an old README.

## 4. Unnecessary complexity and scope corrections

My original React/Vite/native-binding default is unnecessary for the first Floor. I accept plain Node modules, a static UI and built-in SQLite, subject to runtime qualification. Removing npm dependencies reduces one supply-chain surface; it does not remove runtime, CLI, operating-system or handwritten-protocol risk.

Installed Node is 26.1.0. Official Node documentation lists v26 as Current and v24 as LTS, and `node:sqlite` as release-candidate stability. Pin the pilot's tested runtime and record that status; choose a supported LTS runtime for durable release after compatibility testing, without upgrading Adam's global Node as a side effect. [Node releases](https://nodejs.org/en/about/previous-releases), [SQLite module](https://nodejs.org/api/sqlite.html)

Do not make a third adapter, phone notification, scheduled startup, arbitrary Chamber templates or a framework debate prerequisites for the first useful two-member chat. Register all three discovered CLIs; certify and use the first two that pass the same gate. Ship the third adapter after that if it would delay the proof.

## 5. Missing coordination details to include

- Waiting on another member should checkpoint and release the worker slot. Otherwise a one-slot provider or per-Chamber lock can deadlock on its own question. Resume when the answer is committed; bound depth, fanout and total automatic replies.
- Only one run may mutate a given member/Chamber session. Concurrent owner messages remain ordered; interruption creates a new generation and preserves unsent messages.
- File imports remain untrusted observations. A HANDBACK tag or self-declared sender does not authenticate a member or authorize an action. Use allowlisted import ownership and manual verification where identity is unavailable.
- Registry edits may change preferences immediately; executable paths, allowed roots, credentials, export destinations and permission scopes are protected owner configuration. Hot reload must never turn a model-written JSON file into more authority.
- Safe schema validation remains mandatory even in plain JS. Typed output metadata and existing-file hashes do not prove tests ran or acceptance criteria passed.

## 6. Strongest combined architecture

One local authoritative Node service, built-in SQLite, transactional events/outbox, attempt generations, scoped action gate, immutable artifacts and minimal Floor. Per-run stdio MCP bridges provide in-run collaboration. Codex, Claude and Grok are registry candidates; certification determines callable roles. The default is one producer and one reviewer, with material revisions reviewed again. Global HALT, constrained workers, readable bus exports and curated vault summaries remain mandatory. Phone and remote/browser integrations follow separately.

## 7. Dissent after this review

| Topic | Codex current position |
|---|---|
| Stack | Resolved from my side: accept plain Node + built-in SQLite + static UI for the pilot; validate runtime and protocol. |
| First pair | Prefer Codex/Claude for the shortest path to the required Build loop, but permit Claude/Grok for an earlier planning proof if both certify first. Not a model-name hard rule. |
| File home | Claude's three documents are now copied into the current workspace at `5a1a719`; planning co-location is observed. Recommend future app home `Projects/apps/obsidian-council`; preserve originals during any later move. |
| Timeline | Exchange and hardened MVP are different milestones. Re-estimate after the adapter/containment spike; do not promise a schedule from hypothetical code size. |
| Permissions | Material disagreement remains with broad bypass plus read-only labels. Require scoped tools/configuration and actual containment tests. |
| Review budget | Require review of a material revision even if it costs a fourth call; lower call count cannot override acceptance. |
| Record implementation | SQLite is authoritative; JSONL is a recoverable export, not a second independently written ledger. |

Claude remains my recommended planning lead, with Codex implementation and independent Claude acceptance. Grok is an optional certified adversarial reviewer. Adam selects the final direction and owners. This consumes Codex's one peer-review slot; the one revised recommendation is separate. No additional peer-review cycle is requested.
