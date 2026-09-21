import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccount, createUsageService } from "../src/usage/service.mjs";

const NOW = Date.parse("2026-09-20T03:00:00.000Z");

test("normalization derives remaining, preserves labels, and distinguishes zero from unknown", () => {
  const account = normalizeAccount({
    accountId: "codex-main",
    service: "codex",
    status: "fresh",
    sourceLabel: "Test source",
    checkedAt: "2026-09-20T02:59:00.000Z",
    pools: [{
      id: "codex-shared",
      modelIds: ["gpt-5"],
      windows: [
        { id: "five-hour", label: "5 hours", durationMinutes: 300, usedPercent: 100, resetsAt: "2026-09-20T04:00:00.000Z" },
        { id: "weekly", label: "7 days", durationMinutes: 10080, remainingPercent: undefined, resetsAt: "2026-09-19T03:00:00.000Z" },
      ],
    }],
  }, NOW);
  assert.equal(account.pools[0].windows[0].remainingPercent, 0);
  assert.equal(account.pools[0].windows[0].display, "zero");
  assert.equal(account.pools[0].windows[0].label, "5 hours");
  assert.equal(account.pools[0].windows[1].remainingPercent, null);
  assert.equal(account.pools[0].windows[1].display, "unknown");
  assert.equal(account.pools[0].windows[1].refreshDue, true);
});

test("normalization rejects malformed values, clamps valid values, and merges duplicate shared pools", () => {
  const account = normalizeAccount({
    accountId: "claude-main",
    service: "claude",
    status: "simulated",
    sourceLabel: "Fixture",
    checkedAt: "2026-09-20T02:59:00.000Z",
    pools: [
      { id: "claude-shared", modelIds: ["claude"], windows: [{ id: "daily", label: "Daily", durationMinutes: 1440, remainingPercent: 140 }] },
      { id: "claude-shared", modelIds: ["fable"], windows: [{ id: "weekly", label: "Weekly", durationMinutes: 10080, usedPercent: Number.NaN }] },
    ],
  }, NOW);
  assert.equal(account.pools.length, 1);
  assert.deepEqual(account.pools[0].modelIds, ["claude", "fable"]);
  assert.equal(account.pools[0].windows[0].remainingPercent, 100);
  assert.equal(account.pools[0].windows[1].remainingPercent, null);
});

test("source failures are isolated and preserve last-good readings as stale", async () => {
  let codexFails = false;
  const adapters = {
    codex: { async fetch() {
      if (codexFails) throw new Error("secret provider detail");
      return { accountId: "codex", service: "codex", status: "fresh", sourceLabel: "Injected", checkedAt: "2026-09-20T02:59:00.000Z", pools: [] };
    }},
    claude: { async fetch() { throw new Error("offline"); } },
    cursor: { async fetch() { return { accountId: "cursor", service: "cursor", status: "unavailable", sourceLabel: "Not connected", checkedAt: "2026-09-20T02:59:00.000Z", pools: [] }; } },
    grok: { async fetch() { return { accountId: "grok", service: "grok", status: "unavailable", sourceLabel: "Not connected", checkedAt: "2026-09-20T02:59:00.000Z", pools: [] }; } },
  };
  const service = createUsageService({ adapters, minRefreshMs: 0, clock: () => NOW });
  const first = await service.read({ refresh: true });
  assert.equal(first.accounts.find(a => a.service === "codex").status, "fresh");
  assert.equal(first.accounts.find(a => a.service === "claude").status, "unavailable");
  codexFails = true;
  const second = await service.read({ refresh: true });
  const stale = second.accounts.find(a => a.service === "codex");
  assert.equal(stale.status, "stale");
  assert.equal(stale.checkedAt, "2026-09-20T02:59:00.000Z");
  assert.equal(JSON.stringify(second).includes("secret provider detail"), false);
});

const unavailable = (service) => ({ async fetch() {
  return { accountId: service, service, status: "unavailable", sourceLabel: "Not connected", checkedAt: "2026-09-20T02:59:00.000Z", pools: [] };
}});

test("fixture mode can never be reported as a live reading", async () => {
  const adapters = {
    codex: { async fetch() {
      return { accountId: "codex", service: "codex", status: "fresh", sourceLabel: "Pretends to be live", checkedAt: "2026-09-20T02:59:00.000Z",
        pools: [{ id: "p", windows: [{ id: "w", label: "5 hours", durationMinutes: 300, usedPercent: 40 }] }] };
    }},
    claude: unavailable("claude"), cursor: unavailable("cursor"), grok: unavailable("grok"),
  };
  const service = createUsageService({ adapters, fixtureMode: true, minRefreshMs: 0, clock: () => NOW });
  const r = await service.read({ refresh: true });
  const codex = r.accounts.find(a => a.service === "codex");
  assert.equal(r.mode, "simulated");
  assert.equal(codex.status, "simulated");
  assert.equal(codex.simulated, true);
  assert.match(codex.sourceLabel, /simulated/i);
  assert.equal(r.accounts.some(a => a.status === "fresh"), false);
});

test("concurrent refreshes are coalesced into one fetch per source", async () => {
  let fetches = 0, release;
  const gate = new Promise(r => { release = r; });
  const adapters = {
    codex: { async fetch() { fetches++; await gate;
      return { accountId: "codex", service: "codex", status: "fresh", sourceLabel: "Injected", checkedAt: "2026-09-20T02:59:00.000Z", pools: [] }; } },
    claude: unavailable("claude"), cursor: unavailable("cursor"), grok: unavailable("grok"),
  };
  const service = createUsageService({ adapters, minRefreshMs: 0, clock: () => NOW });
  const a = service.read({ refresh: true }), b = service.read({ refresh: true });
  release();
  await Promise.all([a, b]);
  assert.equal(fetches, 1);
});

test("account email, local paths and unknown statuses never reach the response", () => {
  const account = normalizeAccount({
    accountId: "adam@example.com", service: "claude", status: "totally-live",
    sourceLabel: "C:\\Users\\someone\\.claude\\auth.json", reason: "token at /home/someone/.claude/auth.json expired",
    checkedAt: "not a date", pools: [{ id: "p", windows: [{ id: "w", label: "Daily", durationMinutes: "soon", usedPercent: "12" }] }],
  }, NOW);
  const text = JSON.stringify(account);
  assert.equal(text.includes("example.com"), false);
  assert.equal(text.includes("auth.json"), false);
  assert.equal(account.status, "unavailable");
  assert.equal(account.checkedAt, null);
  assert.equal(account.pools[0].windows[0].durationMinutes, null);
  assert.equal(account.pools[0].windows[0].remainingPercent, null, "a string is not a valid percentage");
});

test("a failing source backs off instead of being retried on every refresh", async () => {
  let now = NOW, attempts = 0;
  const adapters = {
    codex: { async fetch() { attempts++; throw new Error("down"); } },
    claude: unavailable("claude"), cursor: unavailable("cursor"), grok: unavailable("grok"),
  };
  const service = createUsageService({ adapters, minRefreshMs: 1000, clock: () => now });
  await service.read({ refresh: true });
  now += 1500; await service.read({ refresh: true });
  assert.equal(attempts, 1, "second refresh is past the throttle but inside the source's backoff");
  now += 1000; await service.read({ refresh: true });
  assert.equal(attempts, 2);
});
