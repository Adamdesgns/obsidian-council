// test/council.test.mjs — v0.1 first-run: `node src/council.mjs` prints one link,
// the link's token works, HALT state is visible and survives a restart.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(ROOT, "src", "council.mjs");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-v01-"));
}

/** Spawn the real entry point on an ephemeral port; resolve once the link line prints. */
function boot(home) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, COUNCIL_HOME: home, COUNCIL_PORT: "0", COUNCIL_FAKE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("boot timeout\n" + out + err)), 20_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/(http:\/\/127\.0\.0\.1:(\d+))\/#owner=([0-9a-f]{64})/);
      const haltLine = out.match(/Halt:\s+(.+)/);
      if (m && haltLine) {
        clearTimeout(timer);
        resolve({ child, base: m[1], port: Number(m[2]), owner: m[3], stdout: out, haltLine: haltLine[1].trim() });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`council exited early (${code})\n${out}\n${err}`));
    });
  });
}

function kill(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", () => resolve());
    // Windows: SIGINT is not deliverable; SIGTERM maps to TerminateProcess.
    try { child.kill("SIGTERM"); } catch { /* */ }
    setTimeout(resolve, 3000);
  });
}

async function api(base, token, path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

describe("v0.1 first run (src/council.mjs)", () => {
  let home;
  before(() => { home = tempHome(); });
  after(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* */ } });

  it("(a) prints exactly one link, the token in it is the owner token, HALT is clear", async () => {
    const b = await boot(home);
    try {
      const links = b.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#owner=/g) || [];
      assert.equal(links.length, 1, "one link only");
      assert.match(b.haltLine, /^clear/);

      const st = await api(b.base, b.owner, "/owner/state");
      assert.equal(st.status, 200, st.text);
      assert.equal(st.json.halt, false);
      assert.equal(st.json.events.ok, true, "record chain verifies on a fresh home");
      assert.deepEqual(st.json.members.map((m) => m.id).sort(), ["claude", "codex", "grok"]);

      const bad = await api(b.base, "0".repeat(64), "/owner/state");
      assert.equal(bad.status, 401);

      const page = await fetch(b.base + "/");
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /#owner=|owner=/, "Floor page knows how to read the link token");
      assert.match(html, /HALT/);

      // Set HALT through the API; the file is the source of truth the dispatcher reads.
      const h = await api(b.base, b.owner, "/owner/halt", { method: "POST", body: {} });
      assert.equal(h.status, 200);
      assert.equal(existsSync(join(home, "HALT")), true);
    } finally {
      await kill(b.child);
    }
  });

  it("(b) restart on the same home: same owner token, HALT reported as HALTED", async () => {
    const b = await boot(home);
    try {
      assert.match(b.haltLine, /^HALTED since /);
      const st = await api(b.base, b.owner, "/owner/state");
      assert.equal(st.status, 200, "token from tokens.json still valid after restart");
      assert.equal(st.json.halt, true);
      const clear = await api(b.base, b.owner, "/owner/halt", { method: "DELETE" });
      assert.equal(clear.status, 200);
      assert.equal(existsSync(join(home, "HALT")), false);
    } finally {
      await kill(b.child);
    }
  });
});
