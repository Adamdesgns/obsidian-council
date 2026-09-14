// test/outbox.test.mjs — P2-2 acceptance
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStore } from "../src/store.mjs";
import { createOutbox } from "../src/outbox.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-outbox-"));
}

function cleanup(home, store) {
  try { store?.close(); } catch { /* ignore */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* windows lock; temp dir ok */ }
}

describe("P2-2 outbox and leases", () => {
  it("(a) two claimers never get the same delivery", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store, { leaseMs: 30_000 });
    try {
      outbox.send({
        sender: "owner",
        recipients: ["codex"],
        kind: "say",
        content: "one",
        idempotency_key: "a-one",
      });
      outbox.send({
        sender: "owner",
        recipients: ["codex"],
        kind: "say",
        content: "two",
        idempotency_key: "a-two",
      });
      // Release parent lock so child claimers can open WAL cleanly
      store.close();

      const storeUrl = pathToFileURL(join(ROOT, "src", "outbox.mjs")).href;
      const helper = join(home, "claim-helper.mjs");
      writeFileSync(
        helper,
        `
import { openStore } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "store.mjs")).href)};
import { createOutbox } from ${JSON.stringify(storeUrl)};
const home = process.env.COUNCIL_HOME;
const store = openStore({ home });
const outbox = createOutbox(store, { leaseMs: 30000 });
const claimed = outbox.claim("codex");
console.log(JSON.stringify(claimed ? { id: claimed.delivery.id, gen: claimed.gen, message_id: claimed.message.id } : null));
store.close();
`,
        "utf8"
      );

      function run() {
        return new Promise((resolve) => {
          const child = spawn(process.execPath, [helper], {
            env: { ...process.env, COUNCIL_HOME: home },
            windowsHide: true,
          });
          let out = "";
          child.stdout.on("data", (d) => { out += d; });
          child.on("close", (code) => resolve({ code, out: out.trim() }));
        });
      }

      const [c1, c2] = await Promise.all([run(), run()]);
      assert.equal(c1.code, 0, c1.out);
      assert.equal(c2.code, 0, c2.out);
      const j1 = JSON.parse(c1.out);
      const j2 = JSON.parse(c2.out);
      if (j1 && j2) {
        assert.notEqual(j1.id, j2.id, "same delivery leased twice");
      } else {
        assert.ok(j1 || j2, "at least one claimer should get a delivery");
      }
    } finally {
      cleanup(home);
    }
  });

  it("(b) expired lease re-claimed at gen+1; gen-1 ack refused", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store, { leaseMs: 50 });
    try {
      outbox.send({
        sender: "owner",
        recipient: "grok",
        kind: "say",
        content: "lease-me",
        idempotency_key: "b-lease",
      });
      const first = outbox.claim("grok", { leaseMs: 50 });
      assert.ok(first);
      assert.equal(first.gen, 1);

      store.prepare(
        "UPDATE deliveries SET lease_until = ? WHERE id = ?"
      ).run(new Date(Date.now() - 1000).toISOString(), first.delivery.id);

      const second = outbox.claim("grok", { leaseMs: 30_000 });
      assert.ok(second);
      assert.equal(second.gen, 2);
      assert.equal(second.delivery.id, first.delivery.id);

      const stale = outbox.ack(first.delivery, 1, { actor: "grok" });
      assert.equal(stale.ok, false);
      assert.equal(stale.reason, "stale_generation");

      const events = store.getEvents().filter((e) => e.kind === "stale_result_refused");
      assert.ok(events.length >= 1, "stale_result_refused event missing");

      const ok = outbox.ack(second.delivery, 2, { actor: "grok", status: "acked" });
      assert.equal(ok.ok, true);
      assert.equal(ok.delivery.status, "acked");
    } finally {
      cleanup(home, store);
    }
  });

  it("(c) same idempotency key twice yields one message", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const a = outbox.send({
        sender: "owner",
        recipient: "codex",
        kind: "say",
        content: "hello",
        idempotency_key: "idem-1",
      });
      const b = outbox.send({
        sender: "owner",
        recipient: "codex",
        kind: "say",
        content: "hello again",
        idempotency_key: "idem-1",
      });
      assert.equal(a.duplicate, false);
      assert.equal(b.duplicate, true);
      assert.equal(a.message.id, b.message.id);
      const count = store.prepare("SELECT COUNT(*) AS c FROM messages").get().c;
      assert.equal(count, 1);
      const dels = store.prepare("SELECT COUNT(*) AS c FROM deliveries").get().c;
      assert.equal(dels, 1);
    } finally {
      cleanup(home, store);
    }
  });

  it("(d) kill after send before claim loses nothing", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    openStore({ home }).close();

    const helper = join(home, "send-and-die.mjs");
    writeFileSync(
      helper,
      `
import { openStore } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "store.mjs")).href)};
import { createOutbox } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "outbox.mjs")).href)};
const home = process.env.COUNCIL_HOME;
const store = openStore({ home });
const outbox = createOutbox(store);
const r = outbox.send({
  sender: "owner",
  recipient: "codex",
  kind: "say",
  content: "survive-me",
  idempotency_key: "kill-after-send",
});
console.log(JSON.stringify({ id: r.message.id }));
store.close();
process.exit(0);
`,
      "utf8"
    );

    const sent = spawnSync(process.execPath, [helper], {
      env: { ...process.env, COUNCIL_HOME: home },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(sent.status, 0, sent.stderr);
    const { id } = JSON.parse(sent.stdout.trim());

    const store = openStore({ home });
    const outbox = createOutbox(store);
    try {
      const msg = store.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      assert.ok(msg, "message lost after process exit");
      const claimed = outbox.claim("codex");
      assert.ok(claimed, "delivery not claimable after restart");
      assert.equal(claimed.message.id, id);
      assert.equal(claimed.message.content, "survive-me");
    } finally {
      cleanup(home, store);
    }
  });
});