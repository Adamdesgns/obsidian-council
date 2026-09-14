// test/adapters.test.mjs — P2-4 acceptance (fake members only; no live Codex Build)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";
import { spawnMember, redact } from "../src/adapters/spawn.mjs";
import * as grok from "../src/adapters/grok.mjs";
import * as codex from "../src/adapters/codex.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE = join(ROOT, "test", "fake-member.mjs");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "council-p2-adapt-"));
}

function cleanup(home, store) {
  try { store?.close(); } catch { /* */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
}

describe("P2-4 adapters and spawn", () => {
  it("(a) run that exceeds ceiling is refused before spawn and recorded", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const limits = {
        daily_ceiling: { codex: 0, grok: 0, claude: 0, fake: 0 },
        timeout_ms: { codex: 5000 },
      };
      const r = await spawnMember(store, "codex", "hello", {
        fakePath: FAKE,
        limits,
        role: "review",
        skipBuildVerify: true,
      });
      assert.ok(r.refused, "expected budget refusal");
      assert.match(r.refused, /BUDGET/);
      const row = store.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId);
      assert.ok(row, "runs row missing");
      assert.match(String(row.checkpoint), /refused|BUDGET/i);
    } finally {
      cleanup(home, store);
    }
  });

  it("(b) run that exceeds timeout is killed and runs row says so", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const r = await spawnMember(store, "codex", "hang please", {
        fakePath: FAKE,
        timeoutMs: 200,
        env: { FAKE_MODE: "hang" },
        limits: { daily_ceiling: { codex: 100 }, timeout_ms: { codex: 200 } },
        skipBuildVerify: true,
      });
      assert.equal(r.timedOut, true);
      const row = store.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId);
      assert.ok(row);
      const cp = JSON.parse(row.checkpoint || "{}");
      assert.equal(cp.timedOut, true);
    } finally {
      cleanup(home, store);
    }
  });

  it("(c) planted token-like string is redacted in the stored row", async () => {
    const home = tempHome();
    process.env.COUNCIL_HOME = home;
    const store = openStore({ home });
    try {
      const secret = "sk-livePLANTEDSECRET9999";
      const r = await spawnMember(store, "grok", "say hi", {
        fakePath: FAKE,
        env: { FAKE_MODE: "secret", FAKE_PLANT_SECRET: secret },
        limits: { daily_ceiling: { grok: 100 }, timeout_ms: { grok: 5000 } },
      });
      assert.ok(!r.refused);
      assert.ok(!r.stdout.includes(secret), "stdout still contains secret");
      assert.ok(r.stdout.includes("[redacted]") || redact(secret) === "[redacted]");
      const row = store.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId);
      assert.ok(row);
      // argv / checkpoint path should not contain raw secret from output capture
      // (secret is in stdout which we don't store wholesale in runs; argv is command)
      assert.ok(!JSON.stringify(row).includes(secret));
    } finally {
      cleanup(home, store);
    }
  });

  it("(d) argsFor for Grok never emits -s together with resume", () => {
    const withResume = grok.argsFor("continue", { resume: "uuid-abc" });
    assert.ok(withResume.includes("--resume"));
    assert.ok(!withResume.includes("-s"), "Grok resume must not include -s: " + withResume.join(" "));

    const withNew = grok.argsFor("start", { newId: "uuid-new" });
    assert.ok(withNew.includes("-s"));
    assert.ok(!withNew.includes("--resume"));
  });

  it("Codex Build args include A3b flags; review stays read-only", () => {
    const build = codex.argsFor("build me", { role: "build", cwd: "C:\\ws" });
    assert.ok(build.includes("workspace-write"));
    assert.ok(build.includes('windows.sandbox="elevated"'));
    assert.ok(build.includes('approval_policy="never"'));
    assert.ok(build.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(build.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
    assert.ok(build.includes("sandbox_workspace_write.exclude_slash_tmp=true"));
    assert.ok(build.includes("--ignore-user-config"));

    const review = codex.argsFor("review me", { role: "review", cwd: "C:\\ws" });
    assert.ok(review.includes("read-only"));
    assert.ok(!review.includes("workspace-write"));
  });

  it("Codex Build envFor points HOME/TEMP inside workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "council-build-cwd-"));
    try {
      const env = codex.envFor("build", cwd);
      assert.ok(env.HOME.startsWith(cwd));
      assert.ok(env.TEMP.startsWith(cwd));
      assert.ok(env.TMP.startsWith(cwd));
      assert.equal(Object.keys(codex.envFor("review", cwd)).length, 0);
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("Build verifyBuildResult refuses when rollout is not workspace-write", () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    const day = new Date();
    const dir = join(
      home, ".codex", "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0")
    );
    mkdirSync(dir, { recursive: true });
    const tid = "council-test-tid-" + Date.now();
    const bad = join(dir, `rollout-${tid}-bad.jsonl`);
    writeFileSync(
      bad,
      JSON.stringify({
        sandbox_policy: { type: "read-only" },
        approval_policy: "never",
      }) + "\n",
      "utf8"
    );
    try {
      const result = { stdout: JSON.stringify({ type: "thread.started", thread_id: tid }) };
      const v = codex.verifyBuildResult(result);
      assert.equal(v.ok, false);
      assert.match(v.refused, /not workspace-write/);
    } finally {
      try { rmSync(bad, { force: true }); } catch { /* */ }
    }
  });

  it("Build verifyBuildResult accepts workspace-write rollout", () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    const day = new Date();
    const dir = join(
      home, ".codex", "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0")
    );
    mkdirSync(dir, { recursive: true });
    const tid = "council-test-tid-ok-" + Date.now();
    const good = join(dir, `rollout-${tid}-ok.jsonl`);
    // Match a3b regex: "sandbox_policy":\{...\}
    writeFileSync(
      good,
      `{"foo":1,"sandbox_policy":{"type":"workspace-write","writable_roots":[]},"approval_policy":"never"}\n`,
      "utf8"
    );
    try {
      const result = { stdout: JSON.stringify({ type: "thread.started", thread_id: tid }) };
      const v = codex.verifyBuildResult(result);
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.ok(codex.isWorkspaceWritePolicy(v.policy));
    } finally {
      try { rmSync(good, { force: true }); } catch { /* */ }
    }
  });
});