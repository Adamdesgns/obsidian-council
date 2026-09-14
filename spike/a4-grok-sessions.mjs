#!/usr/bin/env node
// A4 — Grok session semantics: create with -s, continue with --resume, and prove
// the wrong flag and a missing session are detectable rather than silent.
//   node spike/a4-grok-sessions.mjs [--dry-run]
//
// Run 1: -s <uuid>          "remember AMBER-xxxx"           -> OK, session created
// Run 2: --resume <uuid>    "what was the code word?"       -> must contain AMBER-xxxx
// Run 3: -s <same uuid>     "reply OK"                      -> must ERROR (session exists); silent success = FAIL
// Run 4: --resume <random>  "reply OK"                      -> must ERROR (not found); silent new session = FAIL
// Budget: 4 Grok model runs (runs 3 and 4 should fail fast without a model call, but are counted anyway).

import { resolveClis, run, save, finalText, nowIso, head, hex, SCRATCH, DRY } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const clis = resolveClis();
if (!clis.grok.found) { console.error("grok.exe not found; run A1 first"); process.exit(2); }
const cwd = join(SCRATCH, "a4"); mkdirSync(cwd, { recursive: true });
const sid = randomUUID(), word = "AMBER-" + hex(4).toUpperCase();
const common = ["--output-format", "json", "--max-turns", "1", "--tools", "read_file", "--no-memory", "--no-subagents", "--disable-web-search", "--cwd", cwd];
const report = { assignment: "A4", at: nowIso(), dryRun: DRY, sessionId: sid, codeWord: word, runs: {} };

const r1 = await run("grok", ["-p", `Remember the code word ${word}. Reply with only the word OK.`, "-s", sid, ...common], { cwd, label: "A4 create", clis });
report.runs.create = { exit: r1.exit, ms: r1.ms, replied: head(finalText("grok", r1), 200), stderrHead: head(r1.stderr, 400) };

const r2 = await run("grok", ["-p", "What was the code word I gave you? Reply with only the code word.", "--resume", sid, ...common], { cwd, label: "A4 resume", clis });
const t2 = finalText("grok", r2);
report.runs.resume = { exit: r2.exit, ms: r2.ms, replied: head(t2, 200), verdict: DRY ? "dry-run" : t2.includes(word) ? "PASS (resumed the same session)" : "FAIL (did not recall the code word; resume did not restore the session)", stderrHead: head(r2.stderr, 400) };

const r3 = await run("grok", ["-p", "Reply with only the word OK.", "-s", sid, ...common], { cwd, label: "A4 wrong-flag", clis });
report.runs.wrongFlag = { exit: r3.exit, ms: r3.ms, verdict: DRY ? "dry-run" : r3.exit !== 0 ? "PASS (reusing -s on an existing id errors, so the wrong flag is detectable)" : "FAIL (silently accepted -s on an existing session)", stderrHead: head(r3.stderr, 400), stdoutHead: head(r3.stdout, 300) };

const r4 = await run("grok", ["-p", "Reply with only the word OK.", "--resume", randomUUID(), ...common], { cwd, label: "A4 missing", clis });
report.runs.missing = { exit: r4.exit, ms: r4.ms, verdict: DRY ? "dry-run" : r4.exit !== 0 ? "PASS (resuming an unknown id errors; no silent replacement)" : "FAIL (resume of an unknown id succeeded silently)", stderrHead: head(r4.stderr, 400), stdoutHead: head(r4.stdout, 300) };

report.summary = Object.entries(report.runs).map(([k, v]) => `${k}: ${v.verdict || ("exit " + v.exit)}`);
save("A4-grok-sessions.json", report);
console.log(report.summary.join("\n"));
