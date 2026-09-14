// test/mcp-bridge.test.mjs — P2-5 acceptance
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createApi } from "../src/api.mjs";
import {
  createBridgeHandlers,
  attachStdio,
  TOOL_DEFS,
  LINE_CAP,
  setWriteSink,
} from "../src/mcp-bridge.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-mcp-"));
}

describe("P2-5 MCP bridge", () => {
  let home, api, port, memberToken, base;

  before(async () => {
    home = tempHome();
    process.env.COUNCIL_HOME = home;
    api = createApi({ home, config: { host: "127.0.0.1", port: 0 } });
    await new Promise((resolve, reject) => {
      api.server.listen(0, "127.0.0.1", () => resolve());
      api.server.once("error", reject);
    });
    port = api.server.address().port;
    memberToken = api.tokens.members.codex;
    base = `http://127.0.0.1:${port}`;
    process.env.COUNCIL_API_BASE = base;
  });

  after(async () => {
    delete process.env.COUNCIL_API_BASE;
    setWriteSink(null);
    try { await api.close(); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 40));
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  });

  function withCapture(fn) {
    const outputs = [];
    setWriteSink((msg) => { outputs.push(msg); });
    return { outputs, run: fn };
  }

  it("(a) tools/list returns exactly the ten tools plus council_context", async () => {
    const handlers = createBridgeHandlers({ token: memberToken, base });
    const { outputs } = withCapture();
    await handlers.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(outputs.length, 1);
    const tools = outputs[0].result.tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOL_DEFS.map((t) => t.name).sort());
    assert.equal(tools.length, 11);
    assert.ok(names.includes("council_context"));
    assert.equal(names.filter((n) => n !== "council_context").length, 10);
  });

  it("(b) tool call with bad token gets structured error not a crash", async () => {
    const handlers = createBridgeHandlers({ token: "bad-token", base });
    const { outputs } = withCapture();
    await handlers.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "council_inbox", arguments: {} },
    });
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].result.isError, true);
    const body = JSON.parse(outputs[0].result.content[0].text);
    assert.equal(body.error, true);
    assert.ok(body.status === 401 || /token|invalid|missing/i.test(JSON.stringify(body)));
  });

  it("(c) 2 MB line is rejected and the bridge keeps serving", async () => {
    const handlers = createBridgeHandlers({ token: memberToken, base });
    const outputs = [];
    setWriteSink((msg) => { outputs.push(msg); });
    const stdin = new PassThrough();
    attachStdio(handlers, { stdin });

    stdin.write("x".repeat(LINE_CAP + 50));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(outputs.some((o) => o.error && /1MB|exceeds/i.test(o.error.message)));

    const before = outputs.length;
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 80));
    const after = outputs.slice(before);
    assert.ok(after.some((o) => o.id === 9 && o.result?.tools?.length === 11), JSON.stringify(after));
    stdin.end();
  });

  it("(d) same operation_id via MCP then again yields one accepted submission", async () => {
    const handlers = createBridgeHandlers({ token: memberToken, base });
    const outputs = [];
    setWriteSink((msg) => { outputs.push(msg); });
    const op = "op-dup-" + Date.now();
    const call = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "council_submit",
        arguments: {
          operation_id: op,
          content: "plan v1",
          recipients: ["owner"],
        },
      },
    };
    await handlers.handle({ ...call, id: 10 });
    await handlers.handle({ ...call, id: 11 });
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].result.isError, false);
    assert.equal(outputs[1].result.isError, false);
    const bodyA = JSON.parse(outputs[0].result.content[0].text);
    const bodyB = JSON.parse(outputs[1].result.content[0].text);
    assert.equal(bodyA.message.id, bodyB.message.id);
    assert.equal(bodyB.duplicate, true);
    const count = api.store.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE idempotency_key = ?"
    ).get(`mcp:council_submit:${op}`).c;
    assert.equal(count, 1);
  });
});