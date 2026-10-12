import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolveCli } from "../src/adapters/resolve-cli.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "council-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (...parts) => { const p = join(root, ...parts); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "fixture only"); return p; };
  const env = { USERPROFILE: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), PATH: "" };
  return { root, put, env };
}
test("finds standalone Codex npm installs without requiring the desktop app", t => {
  const { put, env } = fixture(t);
  const script = put("roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  const result = resolveCli("codex", {}, env);
  assert.equal(result.exe, process.execPath); assert.deepEqual(result.prefix, [script]);
});
test("finds Claude native and exact named PATH executables, never ambiguous agent", t => {
  const { root, put, env } = fixture(t);
  const claude = put(".local", "bin", "claude.exe");
  assert.equal(resolveCli("claude", {}, env).exe, claude);
  put("bin", "agent.exe"); env.PATH = join(root, "bin");
  assert.equal(resolveCli("grok", {}, env).found, false);
  const grok = put("bin", "grok.exe");
  assert.equal(resolveCli("grok", {}, env).exe, grok);
});
test("an invalid explicit executable does not fall back silently", t => {
  const { put, env } = fixture(t); put(".grok", "bin", "grok.exe");
  env.COUNCIL_GROK_EXE = "grok.exe";
  assert.equal(resolveCli("grok", {}, env).reason, "invalid-executable-override");
});
