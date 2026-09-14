#!/usr/bin/env node
// A1 — resolve every member CLI on this PC and record path + version.
// Read-only. No model runs. Safe to run any number of times.
//   node spike/a1-resolve.mjs

import { resolveClis, run, save, nowIso, head } from "./lib.mjs";
import { release, version as osVersion } from "node:os";

const clis = resolveClis();
const report = { assignment: "A1", at: nowIso(), node: process.version, os: `${osVersion()} ${release()}`, clis: {} };

for (const [name, c] of Object.entries(clis)) {
  if (!c.found) { report.clis[name] = { found: false, looked: c.looked || [] }; continue; }
  if (name === "cursorDesktop") { report.clis[name] = { found: true, path: c.path, note: "desktop app only; not a CLI" }; continue; }
  const res = await run(name, ["--version"], { label: "version", model: false, clis, timeoutMs: 60_000 });
  report.clis[name] = { found: true, path: c.path, exit: res.exit, version: head((res.stdout || res.stderr).trim(), 200), candidates: c.candidates };
}

report.summary = Object.entries(report.clis).map(([k, v]) => `${k}: ${v.found ? (v.version || "present") : "NOT FOUND"}`);
save("A1-resolve.json", report);
console.log(report.summary.join("\n"));
