import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.mjs";
import { createUsageService } from "../src/usage/service.mjs";

async function boot(t, usageOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), "council-usage-http-"));
  const usageService = createUsageService({ fixtureMode: true, minRefreshMs: 0, ...usageOpts });
  const api = createApi({ home, config: { host: "127.0.0.1", port: 0 }, usageService });
  await new Promise((resolve, reject) => {
    api.server.listen(0, "127.0.0.1", () => resolve());
    api.server.once("error", reject);
  });
  const port = api.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await api.close();
    rmSync(home, { recursive: true, force: true });
  });
  const req = async (path, token = api.tokens.owner) => {
    const res = await fetch(base + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
    return { status: res.status, body: await res.json() };
  };
  return { api, req, base };
}

test("GET /owner/usage rejects missing and member tokens", async (t) => {
  const { api, req, base } = await boot(t);
  const noAuth = await fetch(base + "/owner/usage");
  assert.equal(noAuth.status, 401);
  // The member token must belong to THIS server: a token minted by a second
  // boot is simply unknown here (401) and would never reach the owner-only gate.
  assert.ok(api.tokens.members.codex, "member token exists");
  const member = await req("/owner/usage", api.tokens.members.codex);
  assert.equal(member.status, 403);
});

test("GET /owner/usage returns simulated fixture data for owner", async (t) => {
  const { req } = await boot(t);
  const r = await req("/owner/usage?refresh=1");
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "simulated");
  const services = r.body.accounts.map((a) => a.service).sort();
  assert.deepEqual(services, ["claude", "codex", "cursor", "grok"]);
  assert.ok(r.body.accounts.some((a) => a.pools.some((p) => p.windows.length > 1)), "multiple windows present");
  assert.ok(r.body.accounts.some((a) => a.pools.some((p) => p.windows.some((w) => w.display === "zero"))));
  assert.ok(r.body.accounts.some((a) => a.status === "unavailable"));
});

test("production usage service without fixture flag never reports simulated mode", async (t) => {
  const { req } = await boot(t, { fixtureMode: false });
  const r = await req("/owner/usage?refresh=1");
  assert.equal(r.status, 200);
  assert.notEqual(r.body.mode, "simulated");
  assert.ok(r.body.accounts.every((a) => a.status === "unavailable"));
});

test("refresh throttling is enforced server-side", async (t) => {
  let fetches = 0;
  const { req } = await boot(t, {
    minRefreshMs: 120_000,
    fixtureMode: true,
    adapters: {
      codex: {
        async fetch() {
          fetches++;
          return { accountId: "codex", service: "codex", status: "simulated", sourceLabel: "Simulated fixture", checkedAt: new Date().toISOString(), pools: [] };
        },
      },
      claude: { async fetch() { return { accountId: "claude", service: "claude", status: "unavailable", sourceLabel: "Not connected", checkedAt: new Date().toISOString(), pools: [] }; } },
      cursor: { async fetch() { return { accountId: "cursor", service: "cursor", status: "unavailable", sourceLabel: "Not connected", checkedAt: new Date().toISOString(), pools: [] }; } },
      grok: { async fetch() { return { accountId: "grok", service: "grok", status: "unavailable", sourceLabel: "Not connected", checkedAt: new Date().toISOString(), pools: [] }; } },
    },
  });
  await req("/owner/usage?refresh=1");
  assert.equal(fetches, 1);
  const again = await req("/owner/usage?refresh=1");
  assert.equal(again.body.throttled, true);
  assert.equal(fetches, 1);
});
