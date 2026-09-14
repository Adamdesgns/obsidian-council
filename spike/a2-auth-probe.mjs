#!/usr/bin/env node
// A2 — headless authentication probe. One trivial model run per CLI, from a
// minimal environment with stdin closed (the closest we can get to a scheduled
// task without registering one). Records: exit code, whether the reply was PONG,
// the usage fields each CLI actually reports, and a verdict.
//
//   node spike/a2-auth-probe.mjs [--only claude|codex|grok] [--dry-run]
//
// Budget: 1 model run per CLI (3 total). Ambient tools are excluded where the
// CLI allows it (Codex --ignore-user-config; Claude --disallowedTools list;
// Grok --tools read_file --no-memory --no-subagents --disable-web-search).

import { resolveClis, run, save, finalText, classify, nowIso, head, SCRATCH, DRY } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PROMPT = "Reply with exactly the single word PONG and nothing else.";
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const clis = resolveClis();
const cwd = join(SCRATCH, "a2"); mkdirSync(cwd, { recursive: true });

const plans = {
  claude: ["--print", "--output-format", "json", "--max-turns", "1", "--permission-mode", "default",
    "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent",
    "mcp__robinhood-trading", "mcp__financial-datasets", "--", PROMPT],
  codex: ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-C", cwd, "--color", "never", PROMPT],
  grok: ["-p", PROMPT, "--output-format", "json", "--max-turns", "1", "--tools", "read_file", "--no-memory", "--no-subagents", "--disable-web-search", "--cwd", cwd],
};

const report = { assignment: "A2", at: nowIso(), dryRun: DRY, results: {} };
for (const [cli, argv] of Object.entries(plans)) {
  if (only && only !== cli) continue;
  if (!clis[cli].found) { report.results[cli] = { verdict: "blocked:cli_not_found" }; continue; }
  const res = await run(cli, argv, { cwd, label: "A2 auth probe", clis, timeoutMs: 180_000 });
  const text = res.dry ? "" : finalText(cli, res);
  const pong = /\bPONG\b/i.test(text);
  const cls = classify(res, text);
  report.results[cli] = {
    verdict: res.dry ? "dry-run" : pong ? "ready_candidate (auth works headless; isolation NOT yet certified)" : cls,
    exit: res.exit, ms: res.ms, timedOut: res.timedOut, replied: head(text, 200),
    usageFieldsReported: res.usage || {}, stderrHead: head(res.stderr, 600), stdoutHead: head(res.stdout, 800),
  };
}
report.summary = Object.entries(report.results).map(([k, v]) => `${k}: ${v.verdict}`);
save("A2-auth-probe.json", report);
console.log(report.summary.join("\n"));
