// test/store.test.mjs — P2-1 acceptance
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { openStore } from "../src/store.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-store-"));
}

describe("P2-1 store and record", () => {
  it("(a) thrown error inside commit rolls back — no event, no partial rows", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      assert.throws(() => {
        store.commit("member_add", "test", (api) => {
          api.prepare(
            "INSERT INTO members(id, kind, display_name, created) VALUES(?,?,?,?)"
          ).run("codex", "cli", "Codex", api.nowIso());
          api.setRef("members", "codex", { id: "codex" });
          throw new Error("boom");
        });
      }, /boom/);

      const members = store.prepare("SELECT * FROM members").all();
      const events = store.getEvents();
      assert.equal(members.length, 0, "member row must not persist");
      assert.equal(events.length, 0, "event must not persist");
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("(b) events chain verifies from seq 1", () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      for (let i = 0; i < 5; i++) {
        store.commit("ping", "actor-" + i, (api) => {
          api.setRef(null, null, { i });
          return i;
        });
      }
      const v = store.verifyChain();
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.count, 5);
      const rows = store.getEvents();
      assert.equal(rows[0].seq, 1);
      assert.equal(rows[0].prev_hash, "0".repeat(64));
      for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i].prev_hash, rows[i - 1].hash);
      }
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("(c) two-process concurrent commit serialize with winner + clean retry", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const seed = openStore({ home });
    seed.close();

    const storeUrl = pathToFileURL(join(ROOT, "src", "store.mjs")).href;
    const helper = join(home, "concurrent-helper.mjs");
    writeFileSync(
      helper,
      `
import { openStore } from ${JSON.stringify(storeUrl)};
const home = process.env.COUNCIL_HOME;
const label = process.argv[2] || "A";
const store = openStore({ home });
let attempts = 0;
let done = false;
let lastErr = null;
while (!done && attempts < 40) {
  attempts++;
  try {
    store.commit("concurrent", label, (api) => {
      const n = api.prepare("SELECT COUNT(*) AS c FROM members").get().c;
      const end = Date.now() + 40;
      while (Date.now() < end) {}
      api.prepare(
        "INSERT INTO members(id, kind, display_name, created) VALUES(?,?,?,?)"
      ).run(label + "-" + process.pid + "-" + attempts, "cli", label, api.nowIso());
      api.setRef("members", label, { attempts, n });
      return { attempts, n };
    });
    done = true;
  } catch (e) {
    lastErr = e;
    const msg = String(e && e.message || e);
    if (/busy|locked|SQLITE_BUSY/i.test(msg)) continue;
    store.close();
    console.log(JSON.stringify({ ok: false, label, attempts, error: msg }));
    process.exit(2);
  }
}
const events = store.getEvents().length;
const members = store.prepare("SELECT COUNT(*) AS c FROM members").get().c;
const chain = store.verifyChain();
store.close();
if (!done) {
  console.log(JSON.stringify({ ok: false, label, attempts, error: String(lastErr) }));
  process.exit(3);
}
console.log(JSON.stringify({ ok: true, label, attempts, events, members, chainOk: chain.ok }));
`,
      "utf8"
    );

    function runChild(label) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [helper, label], {
          env: { ...process.env, COUNCIL_HOME: home },
          windowsHide: true,
        });
        let out = "", err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => resolve({ code, out: out.trim(), err }));
      });
    }

    const [a, b] = await Promise.all([runChild("A"), runChild("B")]);
    assert.equal(a.code, 0, "A failed: " + a.out + a.err);
    assert.equal(b.code, 0, "B failed: " + b.out + b.err);
    const ja = JSON.parse(a.out);
    const jb = JSON.parse(b.out);
    assert.equal(ja.ok, true);
    assert.equal(jb.ok, true);

    const store = openStore({ home });
    try {
      const chain = store.verifyChain();
      assert.equal(chain.ok, true, JSON.stringify(chain));
      const events = store.getEvents();
      assert.equal(events.length, 2, "exactly two concurrent commits");
      const members = store.prepare("SELECT * FROM members ORDER BY id").all();
      assert.equal(members.length, 2);
      // At least one process may have retried under lock contention
      const totalAttempts = ja.attempts + jb.attempts;
      assert.ok(totalAttempts >= 2, "both attempted");
      // Serialize: chain prev links
      assert.equal(events[1].prev_hash, events[0].hash);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});