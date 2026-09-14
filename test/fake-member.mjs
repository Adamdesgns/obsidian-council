#!/usr/bin/env node
// test/fake-member.mjs — scripted member for P2-4..P2-6 tests (reads packet on stdin).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_MODE || "echo";
const delayMs = Number(process.env.FAKE_DELAY_MS || "0");
const planted = process.env.FAKE_PLANT_SECRET || "";

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.resume();
  });
}

const stdin = await readStdin();

if (delayMs > 0) {
  await new Promise((r) => setTimeout(r, delayMs));
}

if (mode === "hang") {
  // Keep event loop alive without unsettled TLA (Node 26 exits those with code 13).
  await new Promise((resolve) => { const i = setInterval(() => {}, 1000); setTimeout(() => { clearInterval(i); resolve(); }, 600000); });
}

if (mode === "refuse-resume") {
  console.log(JSON.stringify({ type: "error", message: "cannot resume session", refuse_resume: true }));
  process.exit(1);
}

const out = {
  type: "result",
  result: mode === "secret"
    ? `ok planted=${planted || "sk-testSECRETVALUE999"}`
    : `fake-ok mode=${mode} bytes=${stdin.length}`,
  session_id: process.env.FAKE_SESSION_ID || "fake-session-1",
  thread_id: process.env.FAKE_THREAD_ID || "fake-thread-1",
  sessionId: process.env.FAKE_SESSION_ID || "fake-session-1",
};

if (mode === "build-ok") {
  // Emit a thread id so verifyBuildResult can look up a planted rollout
  out.thread_id = process.env.FAKE_THREAD_ID || "fake-build-thread";
}

console.log(JSON.stringify(out));
process.exit(0);