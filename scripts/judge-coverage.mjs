// scripts/judge-coverage.mjs — measure what share of real replies the free screen decides.
// Read-only. No network. No API key. Never calls a model.
//
//   node scripts/judge-coverage.mjs
//   node scripts/judge-coverage.mjs --db "C:\\path\\to\\council.db" --json
//
// Prints the split between the free local screen and the cases that would need a typed
// model, plus what those cases would actually cost at Jev's list price. This replaces
// the estimate; run it before believing any number about savings.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { councilHome } from "../src/home.mjs";
import { createJudge } from "../src/judge.mjs";

const JEV_PER_INPUT_TOKEN = 0.042 / 1_000_000; // output is not metered
const CHARS_PER_TOKEN = 4;                     // rough, and stated as rough

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const asJson = argv.includes("--json");
const dbPath = flag("--db") || join(councilHome(), "council.db");

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}\nPass --db <path>, or set COUNCIL_HOME.`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

// A reply is a member message with a parent. The parent's content is the material
// the member was responding to. That pairing is the whole measurement.
const rows = db.prepare(`
  SELECT  r.id        AS reply_id,
          r.sender    AS member,
          r.content   AS reply,
          r.created   AS created,
          p.content   AS material
  FROM messages r
  JOIN messages p ON p.id = r.parent_id
  WHERE r.sender != 'owner'
    AND r.content IS NOT NULL
  ORDER BY r.created
`).all();

if (rows.length === 0) {
  console.error("No parented member replies found yet. Run a few exchanges first.");
  process.exit(1);
}

const judge = createJudge();          // no client injected: cannot spend, by construction
const needsModel = [];
const decided = [];

for (const row of rows) {
  const v = await judge.judge({
    received: row.material,
    reply: row.reply,
    member: row.member,
    messageId: row.reply_id,
  });
  if (v.needsJev) needsModel.push({ ...row, verdict: v });
  else decided.push({ ...row, verdict: v });
}

const stats = judge.stats();
const total = rows.length;
const freeShare = decided.length / total;

// What the cases the screen could not decide would cost, if a typed model saw them.
const tokens = needsModel.reduce(
  (n, r) => n + Math.ceil((String(r.material).length + String(r.reply).length) / CHARS_PER_TOKEN) + 120,
  0
);
const cost = tokens * JEV_PER_INPUT_TOKEN;
const perDay = (() => {
  const days = new Set(rows.map((r) => String(r.created).slice(0, 10))).size || 1;
  return { days, replies: total / days, cost: cost / days };
})();

const flagged = decided.filter((d) => d.verdict.decision === "NOT_RESPONSIVE");

const report = {
  db: dbPath,
  replies: total,
  decidedFree: decided.length,
  freeSharePct: +(freeShare * 100).toFixed(1),
  needsTypedModel: needsModel.length,
  byRule: stats.byRule,
  flaggedNotResponsive: flagged.length,
  estimatedTokensIfTyped: tokens,
  estimatedCostIfTyped: +cost.toFixed(4),
  perDay: { days: perDay.days, replies: +perDay.replies.toFixed(1), cost: +perDay.cost.toFixed(4) },
  projectedMonthlyCost: +(perDay.cost * 30).toFixed(2),
  caveat: "Token counts are chars/4. Cost is Jev list price for input only. Nothing was sent anywhere.",
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = report.freeSharePct.toFixed(1);
  console.log(`\nObsidian Council — judge coverage`);
  console.log(`  ${dbPath}\n`);
  console.log(`  replies examined        ${total}`);
  console.log(`  decided free            ${decided.length}  (${pct}%)`);
  console.log(`  would need the model    ${needsModel.length}`);
  console.log(`  flagged NOT_RESPONSIVE  ${flagged.length}`);
  console.log(`\n  free screen breakdown`);
  for (const [k, n] of Object.entries(stats.byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(34)} ${n}`);
  }
  console.log(`\n  if every undecided case went to a typed model`);
  console.log(`    input tokens          ~${tokens.toLocaleString()}`);
  console.log(`    cost for this history  $${cost.toFixed(4)}`);
  console.log(`    projected per month    $${report.projectedMonthlyCost.toFixed(2)}   (${perDay.days} day(s) of history)`);
  console.log(`\n  ${report.caveat}\n`);

  if (flagged.length) {
    console.log(`  replies the free screen says ignored their material:`);
    for (const f of flagged.slice(0, 10)) {
      console.log(`    ${f.created}  ${f.member.padEnd(8)} ${f.verdict.rule}`);
      console.log(`      ${String(f.reply).replace(/\s+/g, " ").slice(0, 100)}`);
    }
    if (flagged.length > 10) console.log(`    ... and ${flagged.length - 10} more`);
    console.log();
  }
}

db.close();
