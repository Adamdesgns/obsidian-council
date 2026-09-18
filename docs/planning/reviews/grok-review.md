# Grok adversarial review — The Obsidian Council

- Reviewer: Morgan Sterling / Grok Bot (third independent seat)
- Date: 2026-09-14, America/Chicago
- Mode: text-only architecture review; no build, spend, web fetch, CLI spawn, or credential inspection
- Evaluated sources (SHA-256):
  - `claude-revised-recommendation.md` — `8ADEFF6BC097AA20646DA3D69AAA881B3A1222500D757DB464057813FBA7F346`
  - `codex-revised-recommendation.md` — `A843235FFCA96E5983B4FAD969EFD77F871D019CC7759FA1A543008326E35449`
- Invocation note: review performed in the existing Grok Bot seat with only read access to the two supplied documents after coordinator copy. No ambient Grok CLI hooks, plugins, or privileged MCP tools were loaded for this review. Advisory only — does not authorize implementation or protected actions.

## Verdict

**Revise specific contracts, then proceed to a bounded Phase 1 spike.**

Both revised plans converge on a sound minimal shape (local Floor + durable outbox/leases + two-member default + Black Seat content-bound sanctions + `%LOCALAPPDATA%\ObsidianCouncil\` + independent Node core). They are not ready to implement until the remaining hard dissents below are locked as acceptance criteria. This is not a block of the product idea; it is a block on coding until those contracts stop contradicting each other.

## Ranked findings (max 8)

### F1 — Unattended permission policy still conflicts (escape / false autonomy)
- **Affected:** Claude §6 decision 5; Codex §6; Claude Phase 3 Build loop
- **Failure sequence:** Adam accepts “unattended permissions” language from Claude (`--dangerously-skip-permissions` / `--always-approve` / Codex exec noninteractive). A review or repair run inherits ambient tools or expands beyond the allowlist. A “read-only review” executes package install scripts or network from a test harness and mutates the disposable repo or leaks tokens from a helper.
- **Impact:** Member escapes intended tool/data boundary; protected work can happen without a Black Seat sanction.
- **Evidence basis:** Direct text conflict between the two revisions. Codex explicitly rejects blanket bypass and requires negative containment tests; Claude still lists skip/always-approve as needed to avoid prompt stalls.
- **Confidence:** High
- **New vs already addressed:** **New as a locked dissent.** Both mention boundaries; neither revision fully closes the other.
- **Smallest correction:** One owner-approved matrix: for each role (Build / Review / Adversarial / Floor reply), list exact noninteractive flags, tool allow/deny, sandbox class, and forbidden ambient integrations. Default = refuse run if isolation cannot be certified. No blanket skip flags.
- **Proof test:** Disposable repo negative suite: denied path read, ambient MCP/plugin present, credential-helper probe, network when forbidden — each must fail closed with a structured reason, not a prompt and not a silent success.

### F2 — “Read-only review re-runs tests” is still a false boundary
- **Affected:** Claude §5 Phase 3 (“Claude review re-runs the test read-only”); Codex §6 (tests are not read-only)
- **Failure sequence:** Reviewer is granted shell “only to re-run tests.” Tests write caches, download deps, open sockets, or touch sibling folders. Report shows green; workspace is dirtied; later Build resumes against polluted evidence.
- **Impact:** False completion, poisoned workspace, boundary escape.
- **Evidence basis:** Claude still uses “read-only” for test re-run; Codex correctly forbids uncontained reviewer shell for that purpose.
- **Confidence:** High
- **New vs already addressed:** Partially known in Codex review of Claude; **still open in Claude’s revision.**
- **Smallest correction:** Adopt Codex: independent reviewer selects evidence; a separately recorded contained runner executes approved tests; reports bind command, env, input revision, artifacts, exit, output hashes.
- **Proof test:** Fixture test that writes outside the worktree or opens network — reviewer path must not execute it directly; contained runner either blocks or records the escape attempt.

### F3 — Live Floor session resume semantics are underspecified across three CLIs
- **Affected:** Claude §4; Codex §4 items 6–7
- **Failure sequence:** Adam summons Codex + Claude. Dispatcher uses wrong resume flag (e.g. Grok `--session-id` creates a new session). Member “remembers” a different Chamber or duplicates identity. Second Summons races the same session. Adam sees continuity that is actually a replacement session without disclosure.
- **Impact:** Lost context, duplicated work, resumed against stale/wrong room; violates “no copy between apps” by forcing Adam to reconcile ghosts.
- **Evidence basis:** Claude asserts per-CLI resume commands; Codex warns Grok `--resume` vs `--session-id` and forbids promising desktop-chat attachment. Neither provides a single session-lease state machine across providers.
- **Confidence:** Medium-high
- **New vs already addressed:** Codex improved this; Claude still over-promises “remembers the room.” **Improved mitigation still needed as a shared contract.**
- **Smallest correction:** Chamber session table: `(member, chamber) → provider_session_id, lease_gen, resume_kind`. Failed resume → explicit `session_replaced` event + scoped history manifest only. Never attach to existing desktop GUI chats in MVP.
- **Proof test:** Kill mid-Floor; restart daemon; prove exact resume OR disclosed replacement. Inject wrong resume flag and assert no silent new session labeled as the old one.

### F4 — Efficiency defaults can skip required adversarial quality under pressure
- **Affected:** Claude §3 rules 1–2; Codex §5 call budgets
- **Failure sequence:** Two-member default (producer + same-pair reviewer) ships a Directive. Grok adversarial seat is “optional/certified later.” Material risk (auth, sandbox, spend) is marked accepted without a different-provider critique. Efficiency meters reward fewer calls.
- **Impact:** Required quality of the original Directive loop is weakened exactly where efficiency is celebrated.
- **Evidence basis:** Both keep two-member default and third only for gap/Dissent. Codex is clearer that exhausted allowance pauses rather than dropping final review; Claude’s meters keep “cheaper mode if G-gates pass,” which can ratify under-review.
- **Confidence:** Medium
- **New vs already addressed:** Efficiency policy exists in both; **risk of skipping different-provider critique is still soft.**
- **Smallest correction:** Hard rule: any Directive that touches Build, credentials, egress, or external send requires a different-provider review (or recorded Adam waiver) before Black Seat. Efficiency experiments cannot disable that gate.
- **Proof test:** Fixture Directive with Build scope + only same-provider review must refuse closure.

### F5 — Member-to-member Floor hops can deadlock or loop without a shared capacity model
- **Affected:** Claude §4 “reply once”; Codex §4 depth limits + one-slot ask/resume
- **Failure sequence:** Member A asks B; B asks A; or A waits on B while holding the only worker slot for that session. Outbox delivers forever. Adam’s next line queues behind an automatic chain that never returns the Floor.
- **Impact:** Uncontrolled reply/review loop; Adam loses the live shared chat.
- **Evidence basis:** Codex specifies hop/reply caps and worker-slot release; Claude’s “once then return” is weaker and lacks the one-slot resume test.
- **Confidence:** Medium
- **New vs already addressed:** Codex largely addresses; **Claude revision does not fully adopt the capacity model.**
- **Smallest correction:** Adopt Codex defaults (≤2 m2m hops, ≤4 auto replies per owner turn) plus one-slot session lock with checkpoint-and-release on peer ask.
- **Proof test:** Codex’s added acceptance case: one-slot worker asks peer and resumes without deadlock; mutual ask fixtures terminate and return Floor to Adam.

### F6 — False completion via duplicate submissions / stale generation still needs one shared schema
- **Affected:** Both outbox/lease stories; Codex §9 extra cases; Claude §1 dispatch/lease
- **Failure sequence:** Crash after result save before review row; MCP final JSON + tool result double-submit; late output from dead lease generation marks task complete; material revision closes without reviewing new hash.
- **Impact:** Work lost, duplicated, or falsely completed; resume against stale evidence.
- **Evidence basis:** Both revised toward transactional outbox + lease generations (strong agreement). Codex adds explicit duplicate and revision-hash cases Claude’s revision does not list.
- **Confidence:** High that the *mechanism class* is right; Medium that schemas match until written once.
- **New vs already addressed:** **Largely addressed in both** — remaining gap is single contract text, not a new design.
- **Smallest correction:** One `task_attempt` / `outbox` / `lease_generation` schema owned by Claude, feasibility-checked by Codex, including Codex’s duplicate and revision-hash gates.
- **Proof test:** Crash injection between save and review; duplicate MCP+JSON; stale generation write — only one accepted submission; stale refused.

### F7 — Auth, quota, and dollar cost remain unproved; “installed” language can still mislead
- **Affected:** Claude §1 Codex path / Grok verified; Codex §1–2, §5, §9
- **Failure sequence:** Phase 1 marks three CLIs “callable” because binaries resolve. Headless scheduled context has no auth; quota exhausted; API fallback silently bills; dashboard shows Available.
- **Impact:** Deadlock on prompts, unexpected spend, false readiness.
- **Evidence basis:** Codex repeatedly separates install from account mode; Claude claims Codex path and Grok CLI “verified” more strongly than Codex does for operational auth/quota.
- **Confidence:** High
- **New vs already addressed:** Known; **Claude’s revision still overstates operational verification.**
- **Smallest correction:** Presence ≠ ready. Ready requires recorded account mode, metering path, isolation cert, and last successful headless probe. Unknown cost stays unknown; default API spend = 0.
- **Proof test:** Adapter probe with missing auth must report `blocked:not_authenticated`, never join Floor as present.

### F8 — Complexity still sneaking in before first two-member proof
- **Affected:** Claude §2 Steward brain, ntfy, Morgan seat, mirror bus early; Codex defers phone/Morgan
- **Failure sequence:** Phase 2 tries Floor + outbox + MCP + mirror + Steward model + notifications. First G2 fails under integration noise; schedule slips; Adam never gets the live Summons experience.
- **Impact:** Unnecessary delay and failure modes unrelated to Adam’s stated efficiency goal.
- **Evidence basis:** Both say independent small core; Claude’s one-pager still loads more peripherals earlier.
- **Confidence:** Medium
- **New vs already addressed:** Codex already pushes deferral; **reinforce as owner constraint.**
- **Smallest correction:** MVP critical path = Floor + two adapters + outbox/leases + sanctions + artifacts. Mirror/ntfy/Morgan/BotDesk/Tribunal/local-Ollama are Phase 5 (or later Phase 4) only.
- **Proof test:** Phase 2 exit checklist forbids those adapters as dependencies of G1–G3.

## Strong decisions worth retaining

- Shared product shape: Black Seat ≠ Floor chat; content-bound one-use sanctions; global HALT; state under `%LOCALAPPDATA%\ObsidianCouncil\`; OneDrive/vault only get curated exports.
- Transactional outbox + lease generations (both now agree) — keep Codex’s stricter generation fencing language.
- Two-member default with measured efficiency — keep, with F4’s hard review gate.
- Build containment on Windows via Codex sandbox candidate; Claude/Grok as review/adversarial with inert patches — keep Codex’s negative-test requirement.
- Karpathy as pattern prior art, not a codebase to extend — both sound; no forced disagreement.
- Leads: Claude plans/specs, Codex implements, Grok adversarially reviews — both recommend; Adam still chooses.

## Defer

Phone/ntfy, BotDesk automation lane, Morgan Steward dependency, image/video spend paths, all-member Tribunal, extending llm-council/OpenRouter, automatic Git push as “witness,” attaching to existing desktop GUI chats.

## Recommended first experiment

**Phase 1 disposable spike (no product UI):** resolve three CLI paths/versions; probe approved account mode + metering with spend ceiling $0 API; certify isolation (no ambient MCP/hooks); open two real dedicated Chamber sessions (prefer Codex+Claude if both pass); run Codex sandbox negative tests on a disposable repo; prove Grok resume-vs-new-session behavior. Exit: two callable identities with honest scopes **or** an explicit blocker. No scheduled startup, no daemon product yet.

## Remaining owner decisions

1. Lock F1 permission matrix (no blanket skip flags).
2. Lock F2: contained test runner ≠ reviewer shell.
3. Confirm leads and code home `Projects\apps\obsidian-council`.
4. Authorize Phase 1 spike with exact account/data scope and usage ceiling.
5. Whether Grok is required on the first Build Directive or only after certification (F4).
6. Stack nuance: dependency-free `node:sqlite` pilot vs pinned runtime — treat as Phase 1 measurement, not a debate blocker.

## Uncertainty list (did not verify)

- Live auth/quota of Claude, Codex, or Grok in a headless/scheduled context
- Actual Codex Windows sandbox negative-test results on this machine
- Whether `node:sqlite` on local Node 26 is acceptable for durable release
- Real token accounting fields returned by each CLI
- Contents of any credential store, BotDesk relay, or ntfy topic
- Whether either planner’s peer review files beyond these two revisions contain further mitigations

No code was run. No credentials were inspected. No architecture rewrite is proposed beyond the contract locks above.
