#!/usr/bin/env node
// scripts/judge-coverage.mjs — how much of the labelled corpus does the FREE screen decide?
//
// Runs test/fixtures/judge-corpus.json through screenAnswer, then through a
// judge wired to the deterministic fake Jev client, and reports:
//   - screen_coverage_pct: fixtures decided without a typed call
//   - wrong_decisions:     screen decided (not uncertain) AND disagreed with the label
//   - typed_calls:         must equal the number of uncertain screens
// No network, no keys. Exit 1 if coverage < --min or any wrong decision.
//
//   node scripts/judge-coverage.mjs [--json] [--min 60] [--corpus path]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { screenAnswer, createJudge } from "../src/judge.mjs";
import { createFakeJev } from "../src/testutil/fake-jev.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const asJson = args.includes("--json");
const min = Number(flag("--min", "0"));
const corpusPath = flag("--corpus", join(ROOT, "test", "fixtures", "judge-corpus.json"));

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const jev = createFakeJev({ script: (req) => ({ verdict: "uncertain", confidence: 0.5, reason: `fake:${req.screen.reason}` }) });
const judge = createJudge({ client: jev });

const rows = [];
const byReason = {};
let decided = 0;
let uncertain = 0;
const wrong = [];

for (const fx of corpus) {
  const s = screenAnswer(fx.question, fx.answer);
  byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  if (s.verdict === "uncertain") uncertain++;
  else decided++;
  if (s.verdict !== "uncertain" && fx.expected && s.verdict !== fx.expected) {
    wrong.push({ id: fx.id, expected: fx.expected, got: s.verdict, reason: s.reason });
  }
  const j = await judge.judge(fx.question, fx.answer);
  rows.push({ id: fx.id, screen: s.verdict, reason: s.reason, expected: fx.expected ?? null, judged_by: j.by });
}

const total = corpus.length;
const report = {
  total,
  decided,
  uncertain,
  screen_coverage_pct: total ? Number(((decided / total) * 100).toFixed(1)) : 0,
  typed_calls: jev.calls.length,
  by_reason: byReason,
  wrong_decisions: wrong,
  rows,
};

const ok = report.wrong_decisions.length === 0 && report.screen_coverage_pct >= min;

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("id", 20) + pad("screen", 14) + pad("reason", 20) + pad("expected", 14) + "judged_by");
  for (const r of rows) {
    console.log(pad(r.id, 20) + pad(r.screen, 14) + pad(r.reason, 20) + pad(r.expected ?? "-", 14) + r.judged_by);
  }
  console.log("");
  console.log(`fixtures: ${total}  decided by free screen: ${decided} (${report.screen_coverage_pct}%)  uncertain -> typed: ${uncertain}`);
  console.log(`typed calls made (fake client): ${report.typed_calls}`);
  console.log(`wrong screen decisions: ${wrong.length}${wrong.length ? " " + JSON.stringify(wrong) : ""}`);
  if (min) console.log(`min coverage ${min}%: ${report.screen_coverage_pct >= min ? "PASS" : "FAIL"}`);
}

process.exit(ok ? 0 : 1);
