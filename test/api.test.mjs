// test/api.test.mjs — P2-3 acceptance
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApi } from "../src/api.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-api-"));
}

async function req(port, { method = "GET", path = "/", token, headers = {}, body } = {}) {
  const h = {
    Host: `127.0.0.1:${port}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
}

describe("P2-3 loopback API", () => {
  let home, api, port, owner, member;

  before(async () => {
    home = tempHome();
    process.env.COUNCIL_HOME = home;
    api = createApi({
      home,
      config: { host: "127.0.0.1", port: 0 },
    });
    // listen on ephemeral: patch server
    await new Promise((resolve, reject) => {
      api.server.listen(0, "127.0.0.1", () => resolve());
      api.server.once("error", reject);
    });
    port = api.server.address().port;
    owner = api.tokens.owner;
    member = api.tokens.members.codex;
  });

  after(async () => {
    try { await api.close(); } catch { /* ignore */ }
    // Give libuv a tick to finish handle close before the process exits.
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("(a) member token on /owner/sanction is 403", async () => {
    const r = await req(port, {
      method: "POST",
      path: "/owner/sanction",
      token: member,
      body: { content_hash: "abc", approve: true },
    });
    assert.equal(r.status, 403);
  });

  it("(b) body sender differing from token is overwritten; sender_spoof_attempt recorded", async () => {
    const r = await req(port, {
      method: "POST",
      path: "/submit",
      token: member,
      body: {
        sender: "evil-impersonator",
        content: "hi",
        idempotency_key: "spoof-test-1",
        recipients: ["owner"],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.sender, "codex");
    const events = api.store.getEvents().filter((e) => e.kind === "sender_spoof_attempt");
    assert.ok(events.length >= 1, "expected sender_spoof_attempt event");
  });

  it("(c) Host: evil.example is 403", async () => {
    // fetch API always sets Host from URL; use http.request for custom Host
    const http = await import("node:http");
    const result = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/owner/state",
          method: "GET",
          headers: {
            Host: "evil.example",
            Authorization: `Bearer ${owner}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 403);
  });

  it("(d) missing token is 401", async () => {
    const r = await req(port, { path: "/inbox" });
    assert.equal(r.status, 401);
  });
});