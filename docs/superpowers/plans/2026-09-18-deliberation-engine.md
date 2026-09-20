# Deliberation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One owner question produces one agreed answer — two deliberators answer blind, debate to agreement under a hard round cap, and the result waits in the Black Seat for the owner.

**Architecture:** A `deliberations` table holds one row per question. The existing dispatcher tick drives it — no second loop. Three hook points in `src/dispatcher.mjs` (run success, run failure, HALT sweep) advance the state machine. A seat becomes an `(adapter, model, account)` triple resolved through a new `seatOf()` indirection, which is what lets `fable` exist at all.

**Tech Stack:** Node >= 24, ESM, zero dependencies. `node:sqlite` (`DatabaseSync`). Test runner is Node's built-in: `node --test`.

## Global Constraints

- **Zero dependencies.** `package.json` has no `dependencies` and no `devDependencies` key. Do not add either.
- **Node >= 24**, `"type": "module"`. ESM imports only.
- **Every test creates its own temp home** and sets `process.env.COUNCIL_HOME = home`, tearing down in `finally` with `try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }`.
- **No real model spend in tests.** Every test passes `useFake: true`.
- **Migrations must contain no `BEGIN`/`COMMIT`** — `store.mjs:64-74` already wraps each file in a transaction.
- **Migrations are tracked by filename only, no checksum** (`store.mjs:51-63`). After editing `003_deliberations.sql` on a dev machine you must delete the dev `council.db` or the edit silently no-ops.
- **`store.commit()` cannot nest** — `tx()` issues an unguarded `BEGIN IMMEDIATE` (`store.mjs:86`). Any helper called from inside another module's commit callback takes `api` as its first parameter. Convention: `fooIn(api, ...)` for inside-commit, `foo(store, ...)` for outside.
- **The owner is the only source of authority.** Do not weaken `assertSanction`.
- **Commit after every task.**

---

## Scope

This plan covers the deliberation loop only. Two things from the spec are **deliberately deferred**, each to its own plan:

- **Standing delegations / autopilot.** Blocked on an undefined category vocabulary (spec's own open question) and it is security-sensitive enough to deserve a focused plan. Task 11 here wires the owner gate properly, which is its prerequisite.
- **Cost-based executor selection.** Unimplementable today: `runs.tokens_in`, `tokens_out` and `cost_reported` are inserted `NULL` (`spawn.mjs:163-169`), the finalising UPDATE (`spawn.mjs:262-269`) never sets them, and `usageOf()` has zero callers on all three adapters. Needs usage plumbing first.

## Decisions locked before coding

| # | Decision | Why |
|---|---|---|
| 1 | Seat id **is** the member id; a `seatOf(id)` resolver maps it to `{adapter, model, account}` | `ADAPTERS` is keyed by member id in two places (`spawn.mjs:12`, `dispatcher.mjs:15`); a separate seat key would need a third mapping |
| 2 | Engine sends use the **real member** as `sender`, never `"owner"` | Stamping the owner as author of machine-generated packets would falsify the hash chain, which is the point of the system. Caps get an explicit exemption instead (Task 10) |
| 3 | **Three** hook points: run success, run failure, HALT sweep | `dispatcher.mjs:400-408` returns before the success hook; HALT returns at `:168-179` without entering `runOne` |
| 4 | Fake replies scripted via **`opts.scriptedReply` callback**, not an env var | `opts.env` is fixed at dispatcher construction, so an env var cannot vary per round or per member |
| 5 | Daily ceilings keyed by **account**, not member id | `fable` runs on the `claude` CLI and spends the same real Anthropic quota; per-member counters would double the real spend |
| 6 | Preflight threshold is **4 runs per deliberator** (8 total) | The state table is 1+1+2+2+2 = 8 total across two members |
| 7 | `state = "debate"` + separate `round` integer | Makes `debate_n → debate_n+1` arithmetic instead of string surgery |
| 8 | Verdict regex fixed in Task 6 | "Malformed → DISAGREE" is only testable against a fixed pattern |

## File Structure

| File | Responsibility |
|---|---|
| `src/seats.mjs` | **New.** `seatOf(id)`, `allSeats()`, `accountOf(id)`. The single source of truth for what a member *is*. |
| `src/verdict.mjs` | **New.** Parse a reply's final verdict line. Pure function, no I/O. |
| `src/deliberation.mjs` | **New.** State machine: `startDeliberation`, `advanceOnReply`, `abandon`, `preflight`. |
| `src/migrations/003_deliberations.sql` | **New.** The `deliberations` table. |
| `src/adapters/spawn.mjs` | Modify: adapter lookup via `seatOf`, `--model` threading, `runsToday` by account + exported. |
| `src/dispatcher.mjs` | Modify: second ADAPTERS map via `seatOf`, three hooks, cap exemption, `scriptedReply`. |
| `src/tokens.mjs` | Modify: backfill tokens for members missing from an existing `tokens.json`. |
| `src/api.mjs` | Modify: deliberation routes, server-side content hash, first `assertSanction` caller. |
| `config/council.json` | Modify: add `seats` array. |
| `test/seats.test.mjs`, `test/verdict.test.mjs`, `test/deliberation.test.mjs` | **New.** |

---

## Task 1: Seat resolution — DONE (2026-09-20, `cursor/deliberation-engine-judge-task1-26e9`)

A seat is an `(adapter, model, account)` triple. Today `fable` cannot spawn at all — `spawn.mjs:122` throws `unknown member adapter: fable`.

**Files:**
- Create: `src/seats.mjs`
- Create: `test/seats.test.mjs`
- Modify: `config/council.json`

**Interfaces:**
- Produces: `seatOf(id) -> {id, adapter, model|null, account, role}`, `allSeats() -> Array<seat>`, `accountOf(id) -> string`, `seatIds() -> string[]`

- [x] **Step 1: Write the failing test**

```js
// test/seats.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seatOf, accountOf, seatIds } from "../src/seats.mjs";

describe("seats", () => {
  it("resolves a built-in seat to its adapter", () => {
    const s = seatOf("codex");
    assert.equal(s.adapter, "codex");
    assert.equal(s.model, null);
    assert.equal(s.account, "codex");
  });

  it("resolves fable to the claude adapter with a model", () => {
    const s = seatOf("fable");
    assert.equal(s.adapter, "claude");
    assert.equal(s.model, "claude-fable-5-1");
  });

  it("puts fable and claude on the SAME account", () => {
    assert.equal(accountOf("fable"), accountOf("claude"));
  });

  it("throws on an unknown seat", () => {
    assert.throws(() => seatOf("nope"), /unknown seat: nope/);
  });

  it("lists every seat id", () => {
    assert.deepEqual(seatIds().sort(), ["claude", "codex", "fable", "grok"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/seats.test.mjs`
Expected: FAIL — `Cannot find module '../src/seats.mjs'`

- [x] **Step 3: Write the implementation**

```js
// src/seats.mjs — what a member IS. Adapter, model, and which real account it spends.
//
// A seat id is the member id everywhere (deliveries.recipient, runs.member,
// tokens.json keys). This module maps that id to the CLI that runs it.
//
// `account` is the REAL quota being spent. fable and claude are different seats
// but the same Anthropic account, so they share one daily ceiling.

const BUILT_IN = {
  codex: { adapter: "codex", model: null, account: "codex", role: "deliberator" },
  fable: { adapter: "claude", model: "claude-fable-5-1", account: "anthropic", role: "deliberator" },
  claude: { adapter: "claude", model: null, account: "anthropic", role: "arbiter" },
  grok: { adapter: "grok", model: null, account: "grok", role: "executor" },
};

let overrides = null;

/** Test seam: replace the seat table. Pass null to restore the built-ins. */
export function setSeats(seats) {
  overrides = seats;
}

function table() {
  return overrides || BUILT_IN;
}

export function seatOf(id) {
  const s = table()[id];
  if (!s) throw new Error("unknown seat: " + id);
  return { id, ...s };
}

export function seatIds() {
  return Object.keys(table());
}

export function allSeats() {
  return seatIds().map(seatOf);
}

export function accountOf(id) {
  return seatOf(id).account;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/seats.test.mjs`
Expected: PASS, 5 tests

- [x] **Step 5: Record the seats in config for visibility**

Add to `config/council.json` (read by nothing yet — Task 3 wires it; this keeps the file honest):

```json
{
  "host": "127.0.0.1",
  "port": 4777,
  "lease_ms": 60000,
  "seats": [
    { "id": "codex",  "adapter": "codex",  "account": "codex",     "role": "deliberator" },
    { "id": "fable",  "adapter": "claude", "account": "anthropic", "role": "deliberator", "model": "claude-fable-5-1" },
    { "id": "claude", "adapter": "claude", "account": "anthropic", "role": "arbiter" },
    { "id": "grok",   "adapter": "grok",   "account": "grok",      "role": "executor" }
  ]
}
```

- [x] **Step 6: Commit**

```bash
git add src/seats.mjs test/seats.test.mjs config/council.json
git commit -m "seats: a member is an (adapter, model, account) triple"
```

---

## Task 2: Spawn through the seat resolver — DONE (2026-09-20, `cursor/deliberation-engine-judge-task1-26e9`; Step 5b consumer flip deferred to Task 3, see below)

**Files:**
- Modify: `src/adapters/spawn.mjs:12` (ADAPTERS), `:60-95` (resolveCli), `:118-131` (lookup + argsFor)
- Modify: `src/dispatcher.mjs:15` (the second ADAPTERS map)
- Test: `test/seats.test.mjs` (append)

**Interfaces:**
- Consumes: `seatOf(id)` from Task 1
- Produces: a `fable` member that spawns the `claude` CLI with `--model claude-fable-5-1`

- [x] **Step 1: Write the failing test**

Append to `test/seats.test.mjs`:

```js
import { argsForSeat } from "../src/adapters/spawn.mjs";

describe("spawn via seats", () => {
  it("threads --model for a seat that has one", () => {
    const args = argsForSeat("fable", "hello packet", {});
    const i = args.indexOf("--model");
    assert.ok(i >= 0, "--model must be present");
    assert.equal(args[i + 1], "claude-fable-5-1");
  });

  it("omits --model for a seat without one", () => {
    const args = argsForSeat("claude", "hello packet", {});
    assert.equal(args.includes("--model"), false);
  });

  it("uses the codex adapter for the codex seat", () => {
    const args = argsForSeat("codex", "hello packet", {});
    assert.ok(Array.isArray(args));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/seats.test.mjs`
Expected: FAIL — `argsForSeat is not a function`

- [x] **Step 3: Add the resolver to spawn.mjs**

Replace the ADAPTERS constant at `src/adapters/spawn.mjs:12` and add the exported helper:

```js
import { seatOf } from "../seats.mjs";

const ADAPTERS = { claude: claudeAd, codex: codexAd, grok: grokAd };

/** Resolve the adapter module for a SEAT id (not an adapter id). */
export function adapterForSeat(id) {
  const seat = seatOf(id);
  const adapter = ADAPTERS[seat.adapter];
  if (!adapter) throw new Error("unknown member adapter: " + seat.adapter);
  return adapter;
}

/** Build argv for a seat, threading its model when it has one. */
export function argsForSeat(id, packet, opts = {}) {
  const seat = seatOf(id);
  const adapter = adapterForSeat(id);
  const args = adapter.argsFor(packet, opts);
  if (!seat.model) return args;
  return ["--model", seat.model, ...args];
}
```

- [x] **Step 4: Point the existing lookup at it**

At `src/adapters/spawn.mjs:118-122`, replace the direct `ADAPTERS[member]` lookup with `adapterForSeat(member)`, and replace the `adapter.argsFor(argvOrPacket, {...})` call at `:120-131` with `argsForSeat(member, argvOrPacket, {...})`, keeping the existing options object unchanged.

At `src/adapters/spawn.mjs:60-95`, `resolveCli(member, opts)` branches on member id (`:71` claude, `:78` codex, `:90` grok). Change each branch to test `seatOf(member).adapter` instead of `member`, leaving the `member === "fake" || opts.fakePath` short-circuit at `:60` exactly as it is.

At `src/dispatcher.mjs:15`, the second ADAPTERS map is used only for `finalText` at `:383`. Replace it:

```js
import { adapterForSeat } from "./adapters/spawn.mjs";
// ...and at :383, replace ADAPTERS[member].finalText(result) with:
const text = adapterForSeat(member).finalText(result);
```

- [x] **Step 5: Allow @fable in address chains**

> **This step targets `src/routing.mjs`, which exists only after PR #1 is merged.** PR #1 collapses three separate `@mention` parsers into that one file. Do not start this plan until it has landed — patching the dispatcher's copy while the Floor still client-parses would make `@fable` work in tests and silently bypass the chain contract in the real UI.

In `src/routing.mjs`, replace the hardcoded `KNOWN` array (`:17`) and `parseAddressChain` (`:19-27`) with the seat list, so `@fable` is not silently dropped:

```js
import { seatIds } from "./seats.mjs";

export function parseAddressChain(text) {
  const found = [];
  // "owner" is deliberately NOT routable. outbox.claim is recipient-scoped and
  // the dispatcher only loops real members, so a delivery addressed to "owner"
  // can never be claimed — it becomes a dead letter with no event recorded.
  // The final reply already returns to the owner via the `["owner"]` fallback
  // at dispatcher.mjs:522; the owner never needs to be a hop.
  const known = new Set(seatIds());
  const re = /@([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const id = m[1].toLowerCase();
    if (known.has(id)) found.push(id);
  }
  return found;
}
```

`src/dispatcher.mjs` re-exports `parseAddressChain` from `routing.mjs` on the PR head, so existing test imports keep working and the `dispatcher.mjs:482` fallback re-parse inherits the fix automatically.

- [x] **Step 5b: Derive the broadcast default from roles** — `defaultBroadcast()` landed and tested; the `routeOwnerSay` consumer is **deliberately still `DEFAULT_BROADCAST` (codex+grok)** until Task 3. Reason: `council.mjs` runs the dispatcher for codex/grok/claude, so a fable delivery today is a dead letter (the exact defect Step 5 describes), and fable has no daily ceiling until Task 3 keys ceilings by account. PR #1 also pinned codex+grok in `test/chain-routing.http.test.mjs` (d)/(e) to protect the anthropic budget. **Flipped in Task 3** (`routeOwnerSay` → `defaultBroadcast()`, chain-routing (d)/(e) updated, `council.mjs` members = `seatIds()`).

`src/routing.mjs:16` hardcodes `DEFAULT_BROADCAST = ["codex", "grok"]`. Under the seat table that is wrong — `grok` is an executor, not a deliberator. Replace it:

```js
import { allSeats } from "./seats.mjs";

/** Unaddressed owner messages go to the deliberators, never the executors. */
export function defaultBroadcast() {
  return allSeats().filter((s) => s.role === "deliberator").map((s) => s.id);
}
```

Update the single consumer in `routeOwnerSay` from `[...DEFAULT_BROADCAST]` to `defaultBroadcast()`.

- [x] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS — all pre-existing tests still green, plus 8 in `test/seats.test.mjs`

- [x] **Step 7: Commit**

```bash
git add src/adapters/spawn.mjs src/dispatcher.mjs test/seats.test.mjs
git commit -m "spawn: resolve adapter and model through seatOf"
```

---

## Task 3: Per-account daily ceilings — DONE (2026-09-20, `cursor/deliberation-engine-judge-task1-26e9`). Also landed here: the Task 2 Step 5b consumer flip (`routeOwnerSay` → `defaultBroadcast()`, chain-routing (d)/(e) updated), `council.mjs` dispatcher members = `seatIds()`, a peer-seat fallback in `ceilingFor` for member-keyed limits, and `timeoutFor` falling back seat → adapter so fable is not cut at the fake 5 s.

`spawn.mjs:111` reads `limits.daily_ceiling?.[member] ?? limits.daily_ceiling?.fake ?? 100`. A `fable` seat has no key, so it silently gets **100** — while spending the same Anthropic quota as `claude`.

**Files:**
- Modify: `src/adapters/spawn.mjs:97-115`
- Modify: `config/limits.json`
- Test: `test/seats.test.mjs` (append)

**Interfaces:**
- Produces: `runsTodayForAccount(store, account) -> number` (exported, read-only)

- [x] **Step 1: Write the failing test**

Append to `test/seats.test.mjs`:

```js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { runsTodayForAccount } from "../src/adapters/spawn.mjs";

describe("per-account ceilings", () => {
  it("counts fable and claude runs against ONE account", () => {
    const home = mkdtempSync(join(tmpdir(), "council-seats-"));
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const now = new Date().toISOString();
      for (const m of ["fable", "claude"]) {
        store.prepare(
          `INSERT INTO runs(id, member, chamber_id, message_id, argv, started)
           VALUES(?,?,?,?,?,?)`
        ).run(`run-${m}`, m, "c1", null, "[]", now);
      }
      assert.equal(runsTodayForAccount(store, "anthropic"), 2);
      assert.equal(runsTodayForAccount(store, "codex"), 0);
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/seats.test.mjs`
Expected: FAIL — `runsTodayForAccount is not a function`

- [x] **Step 3: Implement**

In `src/adapters/spawn.mjs`, add next to the existing private `runsToday` at `:97`:

```js
import { seatIds, accountOf } from "../seats.mjs";

/**
 * Runs started today across every seat sharing `account`.
 * READ-ONLY on purpose: no store.commit, because every commit advances the hash chain
 * and a preflight must not write history.
 */
export function runsTodayForAccount(store, account) {
  const members = seatIds().filter((id) => accountOf(id) === account);
  if (!members.length) return 0;
  const since = new Date().toISOString().slice(0, 10);
  const marks = members.map(() => "?").join(",");
  const row = store.prepare(
    `SELECT COUNT(*) AS c FROM runs WHERE member IN (${marks}) AND started >= ?`
  ).get(...members, since);
  return Number(row?.c || 0);
}
```

Then change the ceiling check at `:111` to resolve by account:

```js
const account = accountOf(member);
const ceiling = limits.daily_ceiling?.[account] ?? limits.daily_ceiling?.[member] ?? 100;
const used = runsTodayForAccount(store, account);
```

- [x] **Step 4: Re-key the limits file**

Replace `daily_ceiling` in `config/limits.json` with account keys:

```json
{
  "daily_ceiling": {
    "anthropic": 10,
    "codex": 15,
    "grok": 15
  },
  "timeout_ms": {
    "claude": 240000,
    "codex": 240000,
    "grok": 240000,
    "fake": 5000
  },
  "dispatcher": {
    "tick_ms": 2000,
    "max_member_hops": 2,
    "max_auto_replies_per_owner_turn": 4
  }
}
```

The `?? limits.daily_ceiling?.[member]` fallback keeps every existing test green — those pass member-keyed ceilings inline (e.g. `daily_ceiling: { codex: 100, grok: 100 }`).

- [x] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/adapters/spawn.mjs config/limits.json test/seats.test.mjs
git commit -m "limits: enforce daily ceilings per real account, not per seat"
```

---

## Task 4: Backfill tokens for new seats — DONE (2026-09-20, `cursor/deliberation-engine-judge-task1-26e9`). Deviation: a corrupt or non-object `tokens.json` is refused with a clear error and left on disk rather than replaced with a fresh owner token.

`src/tokens.mjs:17` returns early when `tokens.json` exists, so adding `fable` gives it **no token on any existing home** — including the real one. The seat is then mute: `prepareBridge` returns a no-op and `identityFromToken` never resolves it.

**Files:**
- Modify: `src/tokens.mjs:7-30`
- Test: `test/seats.test.mjs` (append)

**Interfaces:**
- Consumes: `seatIds()` from Task 1
- Produces: `loadOrCreateTokens(home)` now returns a token for every seat, adding missing ones in place

**Shape note — read this before writing the test.** `tokens.json` is **nested**, not flat:

```json
{ "owner": "<hex>", "members": { "claude": "<hex>", "codex": "<hex>", "grok": "<hex>" }, "created": "<iso>" }
```

`identityFromToken` (`tokens.mjs:33-38`) iterates `tokens.members`, so a backfilled seat must land **inside `members`**, not at the top level.

- [x] **Step 1: Write the failing test**

```js
import { writeFileSync, readFileSync } from "node:fs";
import { loadOrCreateTokens } from "../src/tokens.mjs";

describe("token backfill", () => {
  it("adds a token for a seat missing from an existing tokens.json", () => {
    const home = mkdtempSync(join(tmpdir(), "council-tok-"));
    try {
      writeFileSync(
        join(home, "tokens.json"),
        JSON.stringify({
          owner: "o".repeat(64),
          members: { codex: "c".repeat(64) },
          created: "2026-01-01T00:00:00.000Z",
        })
      );
      const t = loadOrCreateTokens(home);
      assert.ok(t.members.fable, "fable must get a token");
      assert.equal(t.members.codex, "c".repeat(64), "existing tokens must not change");
      assert.equal(t.owner, "o".repeat(64), "owner token must not change");
      const onDisk = JSON.parse(readFileSync(join(home, "tokens.json"), "utf8"));
      assert.ok(onDisk.members.fable, "backfill must persist");
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("still creates a complete file on a fresh home", () => {
    const home = mkdtempSync(join(tmpdir(), "council-tok2-"));
    try {
      const t = loadOrCreateTokens(home);
      assert.ok(t.owner);
      for (const id of ["codex", "fable", "claude", "grok"]) {
        assert.ok(t.members[id], `${id} must have a token`);
      }
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/seats.test.mjs`
Expected: FAIL — `fable must get a token`

- [x] **Step 3: Implement**

In `src/tokens.mjs`, delete the `MEMBERS` constant at `:7` and replace `loadOrCreateTokens` entirely. The early return at `:16-18` is what strands new seats:

```js
import { seatIds } from "./seats.mjs";

export function loadOrCreateTokens(home = councilHome()) {
  ensureHome(home);
  const path = tokensPath(home);

  let tokens = null;
  if (existsSync(path)) {
    try { tokens = JSON.parse(readFileSync(path, "utf8")); } catch { tokens = null; }
  }
  if (!tokens || typeof tokens !== "object") {
    tokens = { owner: null, members: {}, created: new Date().toISOString() };
  }
  if (!tokens.members || typeof tokens.members !== "object") tokens.members = {};

  // Backfill: a seat added after first run must still get a token, or it is mute —
  // prepareBridge returns a no-op and identityFromToken never resolves it.
  let changed = false;
  if (!tokens.owner) { tokens.owner = randomBytes(32).toString("hex"); changed = true; }
  for (const id of seatIds()) {
    if (!tokens.members[id]) {
      tokens.members[id] = randomBytes(32).toString("hex");
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* windows may ignore */ }
  }
  return tokens;
}
```

- [x] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/tokens.mjs test/seats.test.mjs
git commit -m "tokens: backfill seats added after first run"
```

---

## Task 5: The verdict parser — DONE (2026-09-20, `cursor/deliberation-engine-judge-task1-26e9`). Additions: an `AGREE:` with an empty body is not accepted (the last clean line wins), CRLF trimmed, matched `line` returned for the record; `VERDICT_KINDS` exported.

**Files:**
- Create: `src/verdict.mjs`
- Create: `test/verdict.test.mjs`

**Interfaces:**
- Produces: `parseVerdict(text) -> {kind: "AGREE"|"DISAGREE"|"ESCALATE", body: string, malformed: boolean}`

- [x] **Step 1: Write the failing test**

```js
// test/verdict.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/verdict.mjs";

describe("parseVerdict", () => {
  it("reads a clean AGREE", () => {
    const v = parseVerdict("Some reasoning.\nAGREE: use the outbox");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "use the outbox");
    assert.equal(v.malformed, false);
  });

  it("takes the LAST verdict line when several appear", () => {
    const v = parseVerdict("DISAGREE: no\nmore thought\nAGREE: yes");
    assert.equal(v.kind, "AGREE");
    assert.equal(v.body, "yes");
  });

  it("tolerates leading whitespace", () => {
    assert.equal(parseVerdict("   ESCALATE: unsafe").kind, "ESCALATE");
  });

  it("treats a missing verdict line as DISAGREE", () => {
    const v = parseVerdict("I think we should use the outbox.");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
  });

  it("treats lowercase as malformed, not agreement", () => {
    const v = parseVerdict("agree: yes");
    assert.equal(v.kind, "DISAGREE");
    assert.equal(v.malformed, true);
  });

  it("treats empty text as DISAGREE", () => {
    assert.equal(parseVerdict("").kind, "DISAGREE");
    assert.equal(parseVerdict(null).malformed, true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/verdict.test.mjs`
Expected: FAIL — `Cannot find module '../src/verdict.mjs'`

- [x] **Step 3: Implement**

```js
// src/verdict.mjs — read a deliberator's closing verdict line.
//
// Deliberately strict and deliberately pessimistic: anything we cannot read as
// explicit agreement counts as disagreement. A model that cannot follow the
// format has not demonstrated agreement, and a false "AGREE" is the one failure
// this whole engine exists to prevent.

const VERDICT_RE = /^[ \t]*(AGREE|DISAGREE|ESCALATE)[ \t]*:[ \t]*(.*)$/gm;

export function parseVerdict(text) {
  const s = String(text ?? "");
  let last = null;
  for (const m of s.matchAll(VERDICT_RE)) last = m;
  if (!last) return { kind: "DISAGREE", body: "", malformed: true };
  return { kind: last[1], body: last[2].trim(), malformed: false };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/verdict.test.mjs`
Expected: PASS, 6 tests

- [x] **Step 5: Commit**

```bash
git add src/verdict.mjs test/verdict.test.mjs
git commit -m "verdict: strict parser, malformed counts as disagreement"
```

---

## Task 6: The deliberations table

**Files:**
- Create: `src/migrations/003_deliberations.sql`
- Test: `test/deliberation.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/deliberation.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-delib-"));
}

describe("deliberations schema", () => {
  it("creates the table on open", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const row = store.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='deliberations'"
      ).get();
      assert.equal(row?.name, "deliberations");
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `expected undefined to equal 'deliberations'`

- [ ] **Step 3: Write the migration**

No `BEGIN`/`COMMIT` — the runner wraps it.

```sql
-- 003_deliberations.sql — one row per owner question under deliberation.
-- state is the phase; round is the debate round (0 until debate begins).

CREATE TABLE IF NOT EXISTS deliberations (
  id TEXT PRIMARY KEY,
  chamber_id TEXT,
  question TEXT NOT NULL,
  category TEXT,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  flag TEXT,
  deliberators TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  final_answer TEXT,
  content_hash TEXT,
  stall_detail TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delib_state ON deliberations(state);
CREATE INDEX IF NOT EXISTS idx_delib_chamber ON deliberations(chamber_id);
```

`deliberators` and `answers` are **JSON strings written with an explicit `JSON.stringify`**. Do not pass objects to `setRef` expecting them to land here — `setRef` stringifies into the *event payload*, not the row.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/migrations/003_deliberations.sql test/deliberation.test.mjs
git commit -m "schema: deliberations table"
```

---

## Task 7: Preflight budget check

**Files:**
- Create: `src/deliberation.mjs`
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `runsTodayForAccount` (Task 3), `accountOf` (Task 1)
- Produces: `preflight(store, {deliberators, limits}) -> {ok: true} | {ok: false, reason, member, remaining}`

- [ ] **Step 1: Write the failing test**

```js
import { preflight } from "../src/deliberation.mjs";

describe("preflight", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };

  it("allows a deliberation when both have 4 runs left", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
      assert.equal(r.ok, true);
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("refuses when one deliberator has fewer than 4 runs left", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const now = new Date().toISOString();
      for (let i = 0; i < 7; i++) {
        store.prepare(
          `INSERT INTO runs(id, member, chamber_id, message_id, argv, started)
           VALUES(?,?,?,?,?,?)`
        ).run(`r${i}`, "fable", "c1", null, "[]", now);
      }
      const r = preflight(store, { deliberators: ["codex", "fable"], limits: LIMITS });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "insufficient_budget");
      assert.equal(r.member, "fable");
      assert.equal(r.remaining, 3);
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `Cannot find module '../src/deliberation.mjs'`

- [ ] **Step 3: Implement**

```js
// src/deliberation.mjs — one question in, one agreed answer out.
import { accountOf } from "./seats.mjs";
import { runsTodayForAccount } from "./adapters/spawn.mjs";
import { parseVerdict } from "./verdict.mjs";

/** Worst case per deliberator: 1 blind answer + 3 debate rounds. */
export const RUNS_PER_DELIBERATOR = 4;
export const MAX_ROUNDS = 3;

/**
 * Read-only. Refuses up front rather than stranding a debate half-finished,
 * because a deliberation that dies at round 2 has spent real budget for nothing.
 */
export function preflight(store, { deliberators, limits }) {
  for (const member of deliberators) {
    const account = accountOf(member);
    const ceiling = limits?.daily_ceiling?.[account] ?? 100;
    const used = runsTodayForAccount(store, account);
    const remaining = ceiling - used;
    if (remaining < RUNS_PER_DELIBERATOR) {
      return { ok: false, reason: "insufficient_budget", member, account, remaining };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/deliberation.mjs test/deliberation.test.mjs
git commit -m "deliberation: preflight refuses before stranding a debate"
```

---

## Task 8: Start a deliberation, blind

**Files:**
- Modify: `src/deliberation.mjs`
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `outbox.send` (`src/outbox.mjs`), `preflight` (Task 7)
- Produces: `startDeliberation(store, outbox, {chamber_id, question, deliberators, limits, category}) -> {ok, id, state} | {ok:false, reason,...}`
- Produces: `deliberationKey(id, state, round, member) -> string` — the deterministic idempotency key

- [ ] **Step 1: Write the failing test**

```js
import { createOutbox } from "../src/outbox.mjs";
import { startDeliberation, deliberationKey } from "../src/deliberation.mjs";

describe("startDeliberation", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };

  it("asks only the FIRST deliberator, and the packet holds only the question", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, {
        chamber_id: "c1",
        question: "should we cache the chain?",
        deliberators: ["codex", "fable"],
        limits: LIMITS,
      });
      assert.equal(r.ok, true);
      assert.equal(r.state, "answer_1");

      const msgs = store.prepare("SELECT * FROM messages WHERE chamber_id = ?").all("c1");
      assert.equal(msgs.length, 1, "exactly one member is asked first");
      assert.deepEqual(JSON.parse(msgs[0].recipients), ["codex"]);
      assert.match(msgs[0].content, /should we cache the chain\?/);
    } finally {
      try { outbox.close(); } catch { /* */ }
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("uses a deterministic idempotency key", () => {
    assert.equal(deliberationKey("d1", "answer_1", 0, "codex"), "delib:d1:answer_1:0:codex");
  });

  it("refuses to start when budget is short", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const now = new Date().toISOString();
      for (let i = 0; i < 8; i++) {
        store.prepare(
          `INSERT INTO runs(id, member, chamber_id, message_id, argv, started)
           VALUES(?,?,?,?,?,?)`
        ).run(`r${i}`, "fable", "c1", null, "[]", now);
      }
      const r = startDeliberation(store, outbox, {
        chamber_id: "c1",
        question: "q",
        deliberators: ["codex", "fable"],
        limits: LIMITS,
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "insufficient_budget");
      assert.equal(store.prepare("SELECT COUNT(*) AS c FROM messages").get().c, 0);
    } finally {
      try { outbox.close(); } catch { /* */ }
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `startDeliberation is not a function`

- [ ] **Step 3: Implement**

Append to `src/deliberation.mjs`:

```js
/**
 * Deterministic. NOT derived from Date.now() or the claim generation —
 * both of those produce duplicate or colliding keys on retry.
 */
export function deliberationKey(id, state, round, member) {
  return `delib:${id}:${state}:${round}:${member}`;
}

/** Round one sees the question and nothing else. This is the whole point. */
export function blindPrompt(question) {
  return [
    "You are answering a Council question independently.",
    "No other member's answer is available to you, by design.",
    "Answer in your own words.",
    "",
    "QUESTION:",
    question,
  ].join("\n");
}

export function startDeliberation(store, outbox, opts) {
  const { chamber_id, question, deliberators, limits, category = null } = opts;
  if (!Array.isArray(deliberators) || deliberators.length !== 2) {
    return { ok: false, reason: "need_exactly_two_deliberators" };
  }

  const pre = preflight(store, { deliberators, limits });
  if (!pre.ok) return pre;

  const committed = store.commit("deliberation_started", "owner", (api) => {
    const id = api.uuid();
    const now = api.nowIso();
    api.prepare(
      `INSERT INTO deliberations(id, chamber_id, question, category, state, round, deliberators, answers, created, updated)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(id, chamber_id ?? null, question, category, "answer_1", 0,
          JSON.stringify(deliberators), JSON.stringify({}), now, now);
    api.setRef("deliberations", id, { state: "answer_1", deliberators });
    return { id };
  });

  const id = committed.result.id;
  outbox.send({
    sender: "owner",
    recipients: [deliberators[0]],
    chamber_id,
    kind: "deliberate",
    content: blindPrompt(question),
    idempotency_key: deliberationKey(id, "answer_1", 0, deliberators[0]),
  });

  return { ok: true, id, state: "answer_1" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/deliberation.mjs test/deliberation.test.mjs
git commit -m "deliberation: start blind, deterministic keys, budget-gated"
```

---

## Task 9: Advance the state machine on a reply

**Files:**
- Modify: `src/deliberation.mjs`
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `parseVerdict` (Task 5), `deliberationKey`/`blindPrompt` (Task 8)
- Produces: `findDeliberationFor(store, message) -> row|null`, `advanceOnReply(store, outbox, {message, member, text}) -> {state, round, flag}|null`, `abandon(store, id, reason)`

- [ ] **Step 1: Write the failing test**

```js
import { advanceOnReply, findDeliberationFor, abandon } from "../src/deliberation.mjs";

function rowOf(store, id) {
  return store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
}

describe("advanceOnReply", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };

  function setup() {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    const r = startDeliberation(store, outbox, {
      chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS,
    });
    return { home, store, outbox, id: r.id };
  }
  function teardown({ home, store, outbox }) {
    try { outbox.close(); } catch { /* */ }
    try { store.close(); } catch { /* */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  }

  it("moves to answer_2 and does NOT leak the first answer", () => {
    const ctx = setup();
    try {
      const msg = ctx.store.prepare("SELECT * FROM messages ORDER BY created ASC").get();
      const out = advanceOnReply(ctx.store, ctx.outbox, {
        message: msg, member: "codex", text: "cache it in memory",
      });
      assert.equal(out.state, "answer_2");

      const second = ctx.store.prepare(
        "SELECT * FROM messages ORDER BY created DESC"
      ).get();
      assert.deepEqual(JSON.parse(second.recipients), ["fable"]);
      assert.equal(
        second.content.includes("cache it in memory"), false,
        "the second deliberator must not see the first answer"
      );
    } finally { teardown(ctx); }
  });

  it("both AGREE in round 1 settles to pending_owner", () => {
    const ctx = setup();
    try {
      let msg = ctx.store.prepare("SELECT * FROM messages ORDER BY created ASC").get();
      advanceOnReply(ctx.store, ctx.outbox, { message: msg, member: "codex", text: "A" });
      msg = ctx.store.prepare("SELECT * FROM messages ORDER BY created DESC").get();
      advanceOnReply(ctx.store, ctx.outbox, { message: msg, member: "fable", text: "B" });

      // debate round 1
      for (const m of ["codex", "fable"]) {
        const cur = ctx.store.prepare(
          "SELECT * FROM messages WHERE recipients LIKE ? ORDER BY created DESC"
        ).get(`%${m}%`);
        advanceOnReply(ctx.store, ctx.outbox, {
          message: cur, member: m, text: "fine by me\nAGREE: cache it",
        });
      }
      const row = rowOf(ctx.store, ctx.id);
      assert.equal(row.state, "pending_owner");
      assert.equal(row.flag, "agreed");
      assert.equal(row.final_answer, "cache it");
    } finally { teardown(ctx); }
  });

  it("ESCALATE short-circuits straight to pending_owner", () => {
    const ctx = setup();
    try {
      let msg = ctx.store.prepare("SELECT * FROM messages ORDER BY created ASC").get();
      advanceOnReply(ctx.store, ctx.outbox, { message: msg, member: "codex", text: "A" });
      msg = ctx.store.prepare("SELECT * FROM messages ORDER BY created DESC").get();
      advanceOnReply(ctx.store, ctx.outbox, { message: msg, member: "fable", text: "B" });

      const cur = ctx.store.prepare(
        "SELECT * FROM messages WHERE recipients LIKE ? ORDER BY created DESC"
      ).get("%codex%");
      advanceOnReply(ctx.store, ctx.outbox, {
        message: cur, member: "codex", text: "ESCALATE: this would delete data",
      });
      const row = rowOf(ctx.store, ctx.id);
      assert.equal(row.state, "pending_owner");
      assert.equal(row.flag, "escalated");
    } finally { teardown(ctx); }
  });

  it("abandon marks the row and records why", () => {
    const ctx = setup();
    try {
      abandon(ctx.store, ctx.id, "halt");
      const row = rowOf(ctx.store, ctx.id);
      assert.equal(row.state, "abandoned");
      assert.equal(row.flag, "halt");
    } finally { teardown(ctx); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `advanceOnReply is not a function`

- [ ] **Step 3: Implement**

Append to `src/deliberation.mjs`:

```js
/**
 * Resolve the owning deliberation from the CLAIMED message, never from the row
 * the tick scanned — outbox.claim has no chamber filter and frequently returns a
 * different row than the one that was seen.
 */
export function findDeliberationFor(store, message) {
  if (!message?.idempotency_key) return null;
  const m = /^delib:([^:]+):/.exec(message.idempotency_key);
  if (!m) return null;
  return store.prepare("SELECT * FROM deliberations WHERE id = ?").get(m[1]) || null;
}

function debatePrompt(question, answers, round) {
  const lines = [
    `Council deliberation, debate round ${round} of ${MAX_ROUNDS}.`,
    "Every member's answer so far is below. Read them, then respond.",
    "",
    "You MUST end your reply with exactly one line:",
    "AGREE: <the answer you both now hold>",
    "DISAGREE: <what is still wrong>",
    "ESCALATE: <why this needs the owner now>",
    "",
    "QUESTION:",
    question,
    "",
  ];
  for (const [who, text] of Object.entries(answers)) {
    lines.push(`--- ${who} ---`, text, "");
  }
  return lines.join("\n");
}

export function abandon(store, id, reason) {
  return store.commit("deliberation_abandoned", "dispatcher", (api) => {
    api.prepare(
      "UPDATE deliberations SET state='abandoned', flag=?, updated=? WHERE id=? AND state NOT IN ('settled','overruled','abandoned')"
    ).run(reason, api.nowIso(), id);
    api.setRef("deliberations", id, { abandoned: reason });
    return { id, reason };
  }).result;
}

export function advanceOnReply(store, outbox, { message, member, text }) {
  const row = findDeliberationFor(store, message);
  if (!row) return null;
  if (["pending_owner", "settled", "overruled", "abandoned"].includes(row.state)) return null;

  const deliberators = JSON.parse(row.deliberators);
  const answers = JSON.parse(row.answers || "{}");
  answers[member] = String(text ?? "");

  // --- blind phase ---
  if (row.state === "answer_1") {
    persist(store, row.id, { state: "answer_2", answers });
    outbox.send({
      sender: "owner",
      recipients: [deliberators[1]],
      chamber_id: row.chamber_id,
      kind: "deliberate",
      content: blindPrompt(row.question), // NOT debatePrompt — round one stays blind
      idempotency_key: deliberationKey(row.id, "answer_2", 0, deliberators[1]),
    });
    return { state: "answer_2", round: 0, flag: null };
  }

  if (row.state === "answer_2") {
    persist(store, row.id, { state: "debate", round: 1, answers });
    for (const m of deliberators) {
      outbox.send({
        sender: "owner",
        recipients: [m],
        chamber_id: row.chamber_id,
        kind: "deliberate",
        content: debatePrompt(row.question, answers, 1),
        idempotency_key: deliberationKey(row.id, "debate", 1, m),
      });
    }
    return { state: "debate", round: 1, flag: null };
  }

  // --- debate phase ---
  const verdict = parseVerdict(text);
  const verdicts = JSON.parse(row.answers || "{}").__verdicts || {};
  verdicts[member] = verdict.kind;
  answers.__verdicts = verdicts;

  if (verdict.kind === "ESCALATE") {
    persist(store, row.id, {
      state: "pending_owner", flag: "escalated", answers, final_answer: verdict.body,
    });
    return { state: "pending_owner", round: row.round, flag: "escalated" };
  }

  const waiting = deliberators.filter((m) => !verdicts[m]);
  if (waiting.length) {
    persist(store, row.id, { answers });
    return { state: "debate", round: row.round, flag: null };
  }

  const allAgree = deliberators.every((m) => verdicts[m] === "AGREE");
  if (allAgree) {
    persist(store, row.id, {
      state: "pending_owner", flag: "agreed", answers, final_answer: verdict.body,
    });
    return { state: "pending_owner", round: row.round, flag: "agreed" };
  }

  const next = row.round + 1;
  if (next > MAX_ROUNDS) {
    persist(store, row.id, { state: "pending_owner", flag: "deadlock", answers });
    return { state: "pending_owner", round: row.round, flag: "deadlock" };
  }

  answers.__verdicts = {}; // fresh verdicts each round
  persist(store, row.id, { state: "debate", round: next, answers });
  for (const m of deliberators) {
    outbox.send({
      sender: "owner",
      recipients: [m],
      chamber_id: row.chamber_id,
      kind: "deliberate",
      content: debatePrompt(row.question, answers, next),
      idempotency_key: deliberationKey(row.id, "debate", next, m),
    });
  }
  return { state: "debate", round: next, flag: null };
}

function persist(store, id, patch) {
  return store.commit("deliberation_advanced", "dispatcher", (api) => {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(k === "answers" ? JSON.stringify(v) : v);
    }
    sets.push("updated = ?");
    vals.push(api.nowIso(), id);
    api.prepare(`UPDATE deliberations SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    api.setRef("deliberations", id, patch.state ? { state: patch.state } : { touched: true });
    return { id };
  }).result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/deliberation.mjs test/deliberation.test.mjs
git commit -m "deliberation: blind round one, verdict-driven debate, three-round cap"
```

---

## Task 10: Script the fake member's reply

The fake emits only `fake-ok mode=<mode> bytes=<n>` (`fake-member.mjs:47-55`) and `opts.env` is fixed at construction, so no env var can vary a reply per round. A callback is the only mechanism that can.

**Files:**
- Modify: `src/dispatcher.mjs:382-386`
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Produces: `createDispatcher({scriptedReply})` where `scriptedReply(member, message, result) -> string|null`; returning `null` falls through to the adapter's real `finalText`

- [ ] **Step 1: Write the failing test**

```js
import { createDispatcher } from "../src/dispatcher.mjs";

describe("scriptedReply", () => {
  it("overrides the fake's reply text per member", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const seen = [];
    const d = createDispatcher({
      home,
      useFake: true,
      members: ["codex", "fable"],
      tickMs: 40,
      timeoutMs: 3000,
      defaultRespond: true,
      scriptedReply: (member) => { seen.push(member); return `AGREE: from ${member}`; },
      limits: {
        daily_ceiling: { codex: 100, fable: 100, anthropic: 100 },
        timeout_ms: { codex: 3000, fable: 3000 },
        dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
      },
    });
    try {
      d.outbox.send({
        sender: "owner", recipients: ["codex"], chamber_id: "c1",
        kind: "say", content: "hi", idempotency_key: "k1",
      });
      d.start();
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(seen.includes("codex"), "scriptedReply must be consulted");
      const msg = d.store.prepare(
        "SELECT * FROM messages WHERE sender = 'codex' ORDER BY created DESC"
      ).get();
      assert.match(msg.content, /AGREE: from codex/);
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — the message content is `fake-ok mode=...`, not `AGREE: from codex`

- [ ] **Step 3: Implement**

In `src/dispatcher.mjs`, at the point where the final text is derived (`:383`, already changed in Task 2 to use `adapterForSeat`):

```js
let text = adapterForSeat(member).finalText(result);
// Test seam: a scripted reply lets a test drive verdict lines per member and per
// round. opts.env cannot do this — it is fixed when the dispatcher is constructed.
if (typeof opts.scriptedReply === "function") {
  const scripted = opts.scriptedReply(member, claimed.message, result);
  if (scripted != null) text = String(scripted);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher.mjs test/deliberation.test.mjs
git commit -m "dispatcher: scriptedReply test seam for verdict lines"
```

---

## Task 11: The three dispatcher hooks

`runOne` is fire-and-forget with no `.catch()` (`dispatcher.mjs:221`), so an unguarded throw in a hook becomes an unhandled rejection **and** leaves presence stuck at `"responding"`. Every hook is wrapped.

**Files:**
- Modify: `src/dispatcher.mjs` — success path (~`:521`), failure path (`:400-408`), HALT branch (`:168-179`)
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `advanceOnReply`, `abandon`, `findDeliberationFor` (Task 9)

- [ ] **Step 1: Write the failing test**

```js
import { startDeliberation } from "../src/deliberation.mjs";
import { writeFileSync } from "node:fs";

describe("dispatcher hooks", () => {
  const LIMITS = {
    daily_ceiling: { codex: 100, fable: 100, anthropic: 100 },
    timeout_ms: { codex: 3000, fable: 3000 },
    dispatcher: { tick_ms: 40, max_member_hops: 2, max_auto_replies_per_owner_turn: 4 },
  };

  it("drives a whole deliberation to pending_owner on agreement", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home, useFake: true, members: ["codex", "fable"], tickMs: 40, timeoutMs: 3000,
      defaultRespond: true, limits: LIMITS,
      scriptedReply: (member, message) =>
        /debate round/i.test(String(message?.content || ""))
          ? `looks right\nAGREE: cache it`
          : `my independent answer from ${member}`,
    });
    try {
      const r = startDeliberation(d.store, d.outbox, {
        chamber_id: "c1", question: "cache the chain?",
        deliberators: ["codex", "fable"], limits: LIMITS,
      });
      d.start();
      await new Promise((res) => setTimeout(res, 2000));
      const row = d.store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
      assert.equal(row.state, "pending_owner");
      assert.equal(row.flag, "agreed");
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("abandons an in-flight deliberation when HALT appears", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const d = createDispatcher({
      home, useFake: true, members: ["codex", "fable"], tickMs: 40, timeoutMs: 3000,
      defaultRespond: true, limits: LIMITS,
    });
    try {
      const r = startDeliberation(d.store, d.outbox, {
        chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS,
      });
      writeFileSync(d.haltPath(), new Date().toISOString());
      d.start();
      await new Promise((res) => setTimeout(res, 300));
      const row = d.store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
      assert.equal(row.state, "abandoned");
      assert.equal(row.flag, "halt");
    } finally {
      try { await d.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — state stays `answer_1`

- [ ] **Step 3: Hook the success path**

In `src/dispatcher.mjs`, immediately after the default-respond send (after `:519`, before the presence reset at `:522`):

```js
// Deliberation: advance the state machine on this member's reply.
// Wrapped because runOne is fire-and-forget — an escaping throw becomes an
// unhandled rejection AND leaves presence stuck at "responding".
try {
  advanceOnReply(store, outbox, { message: claimed.message, member, text });
} catch (e) {
  store.commit("deliberation_hook_failed", member, (api) => {
    api.setRef("deliberations", null, { error: String(e?.message || e) });
  });
}
```

- [ ] **Step 4: Hook the failure path — stall, do not abandon**

A member can run out of provider usage **mid-deliberation**. Abandoning would throw
away every run already spent — up to 6 real runs destroyed because the 7th hit a
wall. Stall instead: the row keeps its question, answers, verdicts and round, and
resumes when usage returns.

**We cannot reliably detect "out of usage" today.** `isCeilingOrAuth` (`dispatcher.mjs`)
is a regex guess — `/BUDGET|ceiling|auth|unauthorized|forbidden|401|403|token/i` — and
nobody here has seen what the Claude, Codex or Grok CLIs actually print when a
subscription limit is hit. So do **not** branch on it. Treat *every* run failure as a
stall, and record the raw signature so the real string is captured the first time it
happens.

At `src/dispatcher.mjs:400-408`, inside the run-failure branch before it returns:

```js
try {
  const delib = findDeliberationFor(store, claimed.message);
  if (delib) {
    stall(store, delib.id, {
      member,
      reason,
      // Captured verbatim so the first real usage-exhaustion teaches us its
      // signature. Truncated because provider stderr can be enormous.
      exit: result?.exit ?? null,
      stderr: String(result?.stderr || "").slice(0, 2000),
      stdout: String(result?.stdout || "").slice(0, 2000),
    });
  }
} catch { /* never let cleanup mask the original failure */ }
```

Add to `src/deliberation.mjs`:

```js
/**
 * Hold a deliberation intact after a failed run instead of destroying it.
 *
 * Every failure stalls, not just budget ones. A stall costs nothing to recover
 * from and a wrong abandon costs every run already spent, so the asymmetry
 * decides it. `detail` preserves the provider's own words for diagnosis.
 */
export function stall(store, id, detail) {
  return store.commit("deliberation_stalled", detail?.member || "dispatcher", (api) => {
    api.prepare(
      `UPDATE deliberations SET state='stalled', flag=?, stall_detail=?, updated=?
       WHERE id=? AND state IN ('answer_1','answer_2','debate')`
    ).run(String(detail?.reason || "run_failed"), JSON.stringify(detail ?? {}), api.nowIso(), id);
    api.setRef("deliberations", id, { stalled: detail?.reason || "run_failed", member: detail?.member });
    return { id, stalled: true };
  }).result;
}
```

Add the column to `src/migrations/003_deliberations.sql` (Task 6) — go back and add
it there rather than writing a fourth migration:

```sql
  stall_detail TEXT,
```

- [ ] **Step 5: Hook the HALT sweep**

At `src/dispatcher.mjs:168-179`, inside the `if (isHalted())` branch, after the existing presence loop and before `return`:

```js
// HALT never enters runOne, so an in-flight deliberation would sit in `debate`
// forever without this sweep.
try {
  const open = store.prepare(
    "SELECT id FROM deliberations WHERE state IN ('answer_1','answer_2','debate')"
  ).all();
  for (const row of open) abandon(store, row.id, "halt");
} catch { /* */ }
```

Add the import at the top of `src/dispatcher.mjs`:

```js
import { advanceOnReply, abandon, findDeliberationFor } from "./deliberation.mjs";
```

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/dispatcher.mjs test/deliberation.test.mjs
git commit -m "dispatcher: advance deliberations on reply, failure, and HALT"
```

---

## Task 12: Exempt deliberation sends from the reply caps

`max_auto_replies_per_owner_turn` is 4 (`dispatcher.mjs:39-40`), and a worst-case deliberation is 8 runs. Without this the engine dies at round 2. Worse, a tripped cap writes an event but never acks or expires the lease (`:203-218`), so the row stays selectable and re-logs `floor_returned` **every tick forever**, poisoning that chamber.

**Files:**
- Modify: `src/dispatcher.mjs` — **four** cap sites, not three (line numbers below are on the post-PR-#1 head)
- Test: `test/deliberation.test.mjs` (append)

> **Post-PR-#1 anchors.** PR #1 moves every line number in this task and adds a **fourth** cap site plus a second `hopCount` increment. Locate them by content, not by number:
>
> | Site | What to find |
> |---|---|
> | 1 | the `hops >= maxHops` refusal in `tick()` |
> | 2 | the `replies >= maxAuto` refusal in `tick()` |
> | 3 | the `autoReplies.set(...)` increment on the relay path |
> | 4 | **new in PR #1** — the chain-relay send guard `if (chainNext && chainNext !== "owner" && (hopCount.get(chamber) \|\| 0) >= maxHops)` and the `hopCount.set(...)` increment beside it |
>
> Site 4 must be exempted too, or the test below fails.
>
> **Prerequisite:** PR #1 commits `floor_returned` *outside* the branch that actually suppresses the relay, so it fires even when nothing was truncated. That is a blocker fix required before merge (see the merge review). If it somehow ships unfixed, the `floor_returned === 0` assertion below fails spuriously and the bug is in the dispatcher, not in this task.

- [ ] **Step 1: Write the failing test**

```js
it("survives three debate rounds without tripping the auto-reply cap", async () => {
  const home = tempHome();
  process.env.COUNCIL_HOME = home;
  let round = 0;
  const d = createDispatcher({
    home, useFake: true, members: ["codex", "fable"], tickMs: 40, timeoutMs: 3000,
    defaultRespond: true, limits: LIMITS,
    scriptedReply: (member, message) => {
      const c = String(message?.content || "");
      if (!/debate round/i.test(c)) return `answer from ${member}`;
      round++;
      return round > 4 ? "AGREE: settled late" : "DISAGREE: not yet";
    },
  });
  try {
    const r = startDeliberation(d.store, d.outbox, {
      chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS,
    });
    d.start();
    await new Promise((res) => setTimeout(res, 3000));
    const row = d.store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
    assert.equal(row.state, "pending_owner");
    assert.ok(["agreed", "deadlock"].includes(row.flag));
    const poisoned = d.store.prepare(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'floor_returned'"
    ).get().c;
    assert.equal(poisoned, 0, "no cap refusals during a deliberation");
  } finally {
    try { await d.close(); } catch { /* */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `floor_returned` events present, state stuck in `debate`

- [ ] **Step 3: Implement**

Add a helper near the top of `createDispatcher` in `src/dispatcher.mjs`:

```js
/**
 * Engine-issued deliberation traffic is exempt from the conversational caps.
 * The caps exist to stop members chatting in a loop; a deliberation is already
 * bounded by MAX_ROUNDS and by the preflight budget check.
 *
 * We do NOT stamp these sends as sender:"owner" to dodge the caps — that would
 * put the owner's name on machine-generated packets in the hash chain.
 */
function isDeliberationMessage(message) {
  return typeof message?.idempotency_key === "string"
    && message.idempotency_key.startsWith("delib:");
}
```

At `:203-218`, guard the cap check so an exempt message skips it entirely:

```js
if (!isDeliberationMessage(row) && hops >= maxHops) { /* existing refusal */ }
if (!isDeliberationMessage(row) && replies >= maxAuto) { /* existing refusal */ }
```

At `:449-451` and `:505-507`, skip the counter increments for exempt messages:

```js
if (!isDeliberationMessage(claimed.message)) {
  autoReplies.set(chamber, (autoReplies.get(chamber) || 0) + 1);
}
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher.mjs test/deliberation.test.mjs
git commit -m "dispatcher: exempt deliberation traffic from conversational caps"
```

---

## Task 13: Wire the owner gate

`assertSanction` has **zero call sites** outside its own test. `POST /owner/sanction` (`api.mjs:350-372`) stores `body.content_hash` verbatim and never imports `contentHash`, so the server has never verified that a hash matches what it is approving. `markUsed` is never called, so `used_at` is always NULL.

**Files:**
- Modify: `src/api.mjs:350-372` (hash server-side), add approve/overrule routes
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `contentHash`, `assertSanction`, `markUsed` (`src/sanctions.mjs`)
- Produces: `POST /owner/deliberate`, `GET /owner/deliberation/<id>`, `POST /owner/deliberation/<id>/approve`, `POST /owner/deliberation/<id>/overrule`

- [ ] **Step 1: Write the failing test**

```js
import { assertSanction, contentHash } from "../src/sanctions.mjs";

describe("owner gate", () => {
  it("approval requires a sanction whose hash matches the final answer", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const answer = "cache the chain in memory";
      const hash = contentHash(answer);
      store.commit("sanction_decided", "owner", (api) => {
        api.prepare(
          `INSERT INTO sanctions(id, content_hash, decided_by, decided_at, status)
           VALUES(?,?,?,?,?)`
        ).run(api.uuid(), hash, "owner", api.nowIso(), "approved");
      });
      assert.equal(assertSanction(store, { content: answer, actor: "owner" }).ok, true);
      assert.equal(
        assertSanction(store, { content: "something else", actor: "owner" }).ok, false
      );
      assert.equal(
        assertSanction(store, { content: answer, actor: "codex" }).reason,
        "member_cannot_approve"
      );
    } finally {
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: PASS for the first two assertions but the test documents current behaviour — run it to confirm the gate works standalone before wiring it.

- [ ] **Step 3: Compute the hash server-side**

In `src/api.mjs`, add `import { contentHash, assertSanction, markUsed } from "./sanctions.mjs";` and in the `POST /owner/sanction` handler at `:350`, replace the verbatim store of `body.content_hash`:

```js
// Never trust a client-supplied hash — derive it from the content being approved.
const hash = body.content != null ? contentHash(body.content) : String(body.content_hash || "");
if (!hash) return sendJson(res, 400, { error: "content or content_hash required" });
```

and use `hash` in the INSERT in place of `body.content_hash`.

- [ ] **Step 4: Add the deliberation routes**

There is no param router — follow the prefix form already used at `api.mjs:391`. Add inside the owner-routes section:

```js
if (req.method === "POST" && path === "/owner/deliberate") {
  const body = await readBody(req);
  const r = startDeliberation(store, outbox, {
    chamber_id: body.chamber_id,
    question: body.content || body.question || "",
    deliberators: body.deliberators || ["codex", "fable"],
    category: body.category ?? null,
    limits,
  });
  return sendJson(res, r.ok ? 200 : 409, r);
}

if (path.startsWith("/owner/deliberation/")) {
  const rest = path.slice("/owner/deliberation/".length);
  const [id, action] = rest.split("/");
  const row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(id);
  if (!row) return sendJson(res, 404, { error: "no such deliberation" });

  if (req.method === "GET" && !action) return sendJson(res, 200, row);

  if (req.method === "POST" && action === "approve") {
    const gate = assertSanction(store, { content: row.final_answer, actor: "owner" });
    if (!gate.ok) return sendJson(res, 403, gate);
    markUsed(store, gate.sanction.id, "owner");
    const out = store.commit("deliberation_settled", "owner", (api) => {
      api.prepare("UPDATE deliberations SET state='settled', updated=? WHERE id=?")
        .run(api.nowIso(), id);
      api.setRef("deliberations", id, { settled: true });
      return { id, state: "settled" };
    });
    return sendJson(res, 200, out.result);
  }

  if (req.method === "POST" && action === "overrule") {
    const body = await readBody(req);
    const out = store.commit("deliberation_overruled", "owner", (api) => {
      api.prepare(
        "UPDATE deliberations SET state='overruled', final_answer=?, updated=? WHERE id=?"
      ).run(String(body.content || ""), api.nowIso(), id);
      api.setRef("deliberations", id, { overruled: true });
      return { id, state: "overruled" };
    });
    return sendJson(res, 200, out.result);
  }
}
```

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/api.mjs test/deliberation.test.mjs
git commit -m "api: deliberation routes and the first real owner gate"
```

---

## Task 14: Resume a stalled deliberation

A stall that never resumes is just a slower abandon. The dispatcher tick re-checks
stalled rows and puts them back on the floor once the member can run again.

**Files:**
- Modify: `src/deliberation.mjs`
- Modify: `src/dispatcher.mjs` (tick, after the HALT check)
- Test: `test/deliberation.test.mjs` (append)

**Interfaces:**
- Consumes: `preflight` (Task 7), `deliberationKey`/`blindPrompt` (Task 8)
- Produces: `resumeStalled(store, outbox, {limits}) -> Array<{id, resumed}>`

- [ ] **Step 1: Write the failing test**

```js
import { stall, resumeStalled } from "../src/deliberation.mjs";

describe("resume after a stall", () => {
  const LIMITS = { daily_ceiling: { anthropic: 10, codex: 15 } };

  it("preserves the whole deliberation and re-sends the pending round", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, {
        chamber_id: "c1", question: "keep me", deliberators: ["codex", "fable"], limits: LIMITS,
      });
      const before = store.prepare("SELECT COUNT(*) AS c FROM messages").get().c;

      stall(store, r.id, { member: "codex", reason: "exit_1", stderr: "usage limit reached" });
      let row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
      assert.equal(row.state, "stalled");
      assert.equal(row.question, "keep me", "the question survives");
      assert.match(row.stall_detail, /usage limit reached/, "provider words are kept");

      const out = resumeStalled(store, outbox, { limits: LIMITS });
      assert.equal(out.length, 1);
      row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(r.id);
      assert.equal(row.state, "answer_1", "returns to the state it stalled in");
      const after = store.prepare("SELECT COUNT(*) AS c FROM messages").get().c;
      assert.equal(after, before, "the re-send is idempotent, not a duplicate");
    } finally {
      try { outbox.close(); } catch { /* */ }
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("stays stalled while the budget is still short", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const r = startDeliberation(store, outbox, {
        chamber_id: "c1", question: "q", deliberators: ["codex", "fable"], limits: LIMITS,
      });
      stall(store, r.id, { member: "fable", reason: "exit_1" });
      const now = new Date().toISOString();
      for (let i = 0; i < 8; i++) {
        store.prepare(
          `INSERT INTO runs(id, member, chamber_id, message_id, argv, started)
           VALUES(?,?,?,?,?,?)`
        ).run(`x${i}`, "fable", "c1", null, "[]", now);
      }
      assert.equal(resumeStalled(store, outbox, { limits: LIMITS }).length, 0);
      assert.equal(
        store.prepare("SELECT state FROM deliberations WHERE id = ?").get(r.id).state,
        "stalled"
      );
    } finally {
      try { outbox.close(); } catch { /* */ }
      try { store.close(); } catch { /* */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deliberation.test.mjs`
Expected: FAIL — `resumeStalled is not a function`

- [ ] **Step 3: Implement**

Append to `src/deliberation.mjs`:

```js
/** Where a stalled row goes back to. `debate` keeps its round. */
function stateBeforeStall(row) {
  const f = row.flag || "";
  if (row.round > 0) return "debate";
  // answers already holds whoever replied; one answer means answer_2 was pending.
  const answered = Object.keys(JSON.parse(row.answers || "{}")).filter((k) => k !== "__verdicts");
  return answered.length >= 1 ? "answer_2" : "answer_1";
}

/**
 * Put stalled deliberations back on the floor when their members can run again.
 *
 * Re-sending is safe because every engine send uses a deterministic idempotency
 * key — an already-delivered round is a no-op, not a duplicate. That is the whole
 * reason the keys are derived from (id, state, round, member) rather than a clock.
 */
export function resumeStalled(store, outbox, { limits }) {
  const rows = store.prepare("SELECT * FROM deliberations WHERE state = 'stalled'").all();
  const resumed = [];

  for (const row of rows) {
    const deliberators = JSON.parse(row.deliberators);
    const pre = preflight(store, { deliberators, limits });
    if (!pre.ok) continue; // still short — leave it stalled, try again next tick

    const state = stateBeforeStall(row);
    const answers = JSON.parse(row.answers || "{}");

    store.commit("deliberation_resumed", "dispatcher", (api) => {
      api.prepare(
        "UPDATE deliberations SET state=?, flag=NULL, stall_detail=NULL, updated=? WHERE id=? AND state='stalled'"
      ).run(state, api.nowIso(), row.id);
      api.setRef("deliberations", row.id, { resumed: state });
    });

    const targets = state === "answer_1" ? [deliberators[0]]
      : state === "answer_2" ? [deliberators[1]]
      : deliberators;

    for (const m of targets) {
      outbox.send({
        sender: "owner",
        recipients: [m],
        chamber_id: row.chamber_id,
        kind: "deliberate",
        content: state === "debate"
          ? debatePrompt(row.question, answers, row.round)
          : blindPrompt(row.question),
        idempotency_key: deliberationKey(row.id, state, row.round, m),
      });
    }
    resumed.push({ id: row.id, resumed: state });
  }
  return resumed;
}
```

- [ ] **Step 4: Call it from the tick**

In `src/dispatcher.mjs`, in `tick()` immediately after the `if (isHalted())` block
returns (so a HALTed council never resumes anything):

```js
try {
  resumeStalled(store, outbox, { limits });
} catch { /* a failed resume must never stop the tick */ }
```

and extend the import:

```js
import { advanceOnReply, abandon, stall, resumeStalled, findDeliberationFor } from "./deliberation.mjs";
```

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/deliberation.mjs src/dispatcher.mjs test/deliberation.test.mjs
git commit -m "deliberation: stall and resume instead of discarding spent runs"
```

---

## Task 15: Full-suite verification

- [ ] **Step 1: Run everything unpiped**

Run: `node --test`
Expected: PASS, zero failures. Read the exit code directly — do **not** pipe to `grep`, which masks the runner's exit status.

- [ ] **Step 2: Confirm the hash chain is intact**

```bash
node -e "import('./src/store.mjs').then(async (m)=>{const s=m.openStore({});console.log(s.verifyChain());s.close();})"
```

Expected: `{ ok: true, ... }`

- [ ] **Step 3: Commit any fixes and push the branch**

```bash
git add -A
git commit -m "deliberation: full suite green"
```

---

## Self-Review Notes

**Spec coverage:** state machine (Tasks 6–9), blindness (Tasks 8–9), verdict protocol (Task 5), three-round cap (Task 9), escalation (Task 9), preflight (Task 7), owner gate (Task 13), seats/model threading (Tasks 1–2). Deferred with reasons stated in Scope: delegations, cost-based executor selection.

**Known gaps carried forward:**
- Round-one blindness is asserted at the packet level only. The provider session is resumed per `(member, chamber_id)` (`dispatcher.mjs:248-251`), so a chamber with prior turns may carry context the packet does not. Deliberations should run in their own chamber id until a `noResume` spawn option exists.
- `defaultRespond: true` (production, `council.mjs:34`) sends each member reply to `["owner"]` *before* the deliberation hook, so the Floor sees both the raw reply and the engine's traffic. Cosmetic until the Floor UI work; note it there.
