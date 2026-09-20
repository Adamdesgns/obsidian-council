// test/judge.test.mjs — Deliberation judge: free local screen first, typed model only when needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { screenAnswer, createJudge, validateTypedVerdict, VERDICTS } from "../src/judge.mjs";
import { createFakeJev } from "../src/testutil/fake-jev.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const Q = "Write a five-line plan for a Node CLI that prints today's date in ISO format.";
const GOOD =
  "Plan: 1) create cli.mjs with a shebang. 2) read new Date() and call toISOString(). " +
  "3) print the ISO date to stdout. 4) add a --utc flag. 5) add a node --test for the format.";

describe("judge: free screen", () => {
  it("(a) empty or placeholder answer is unresponsive without any model call", () => {
    for (const a of ["", "   ", "(empty)", null, undefined]) {
      const v = screenAnswer(Q, a);
      assert.equal(v.verdict, "unresponsive", JSON.stringify({ a, v }));
      assert.equal(v.reason, "empty");
      assert.equal(v.by, "screen");
    }
  });

  it("(b) a refusal is unresponsive", () => {
    const v = screenAnswer(Q, "I'm sorry, I can't help with that request.");
    assert.equal(v.verdict, "unresponsive");
    assert.equal(v.reason, "refusal");
  });

  it("(c) tool/runtime error output is unresponsive", () => {
    assert.equal(screenAnswer(Q, 'Error: Failed while loading mcp').reason, "error_output");
    assert.equal(screenAnswer(Q, '{"type":"error","message":"cannot resume session"}').reason, "error_output");
    assert.equal(screenAnswer(Q, 'Traceback (most recent call last):\n  File "x.py"').verdict, "unresponsive");
  });

  it("(d) an answer made only of questions back is unresponsive", () => {
    const v = screenAnswer(Q, "Which Node version? Do you want UTC or local time? Should it be a package?");
    assert.equal(v.verdict, "unresponsive");
    assert.equal(v.reason, "question_back");
  });

  it("(e) a substantive answer that covers the question's terms is responsive", () => {
    const v = screenAnswer(Q, GOOD);
    assert.equal(v.verdict, "responsive");
    assert.equal(v.reason, "keyword_overlap");
    assert.ok(v.score.overlap >= 0.5, JSON.stringify(v.score));
  });

  it("(e2) a yes/no question answered yes/no with a reason is responsive; a bare 'No.' is not decided", () => {
    const yq = "Should the Floor ever parse @mentions client-side for routing?";
    const v = screenAnswer(yq, "No. Routing is server-side only; the Floor sends the raw line.");
    assert.equal(v.verdict, "responsive");
    assert.equal(v.reason, "direct_answer");
    assert.equal(screenAnswer(yq, "No.").verdict, "uncertain");
    // Not a yes/no question: the rule must not fire.
    assert.notEqual(screenAnswer(Q, "No. Routing is server-side only; the Floor sends the raw line.").reason, "direct_answer");
  });

  it("(f) a very short answer is uncertain, not decided", () => {
    const v = screenAnswer(Q, "Sure thing.");
    assert.equal(v.verdict, "uncertain");
    assert.equal(v.reason, "too_short");
  });

  it("(g) a long answer that shares nothing with the question is uncertain", () => {
    const v = screenAnswer(
      Q,
      "The quarterly budget review moved to Thursday. Please bring the vendor spreadsheets and the signed contracts."
    );
    assert.equal(v.verdict, "uncertain");
    assert.equal(v.reason, "no_overlap");
  });

  it("(h) the screen is deterministic: same input, same output", () => {
    const a = screenAnswer(Q, GOOD);
    const b = screenAnswer(Q, GOOD);
    assert.deepEqual(a, b);
  });
});

describe("judge: typed model only when needed", () => {
  it("(a) clear cases never call the typed client", async () => {
    const jev = createFakeJev();
    const judge = createJudge({ client: jev });
    const r1 = await judge.judge(Q, GOOD);
    const r2 = await judge.judge(Q, "");
    assert.equal(r1.verdict, "responsive");
    assert.equal(r2.verdict, "unresponsive");
    assert.equal(r1.by, "screen");
    assert.equal(jev.calls.length, 0, "typed client must not be called for screened cases");
    assert.deepEqual(judge.stats(), { screened: 2, typed: 0, typed_invalid: 0, typed_error: 0 });
  });

  it("(b) an uncertain screen calls the typed client exactly once and uses its verdict", async () => {
    const jev = createFakeJev({ script: [{ verdict: "unresponsive", confidence: 0.8, reason: "off-topic" }] });
    const judge = createJudge({ client: jev });
    const r = await judge.judge(Q, "Sure thing.");
    assert.equal(jev.calls.length, 1);
    assert.equal(jev.calls[0].question, Q);
    assert.equal(jev.calls[0].screen.reason, "too_short", "typed client receives the screen result");
    assert.equal(r.verdict, "unresponsive");
    assert.equal(r.by, "typed");
    assert.equal(r.confidence, 0.8);
    assert.equal(r.reason, "off-topic");
    assert.equal(r.screen.reason, "too_short");
  });

  it("(c) no client + uncertain screen -> uncertain with needs_typed, no throw", async () => {
    const judge = createJudge();
    const r = await judge.judge(Q, "Sure thing.");
    assert.equal(r.verdict, "uncertain");
    assert.equal(r.needs_typed, true);
    assert.equal(r.by, "screen");
  });

  it("(d) a malformed typed verdict is rejected, never trusted", async () => {
    const jev = createFakeJev({ mode: "malformed" });
    const judge = createJudge({ client: jev });
    const r = await judge.judge(Q, "Sure thing.");
    assert.equal(jev.calls.length, 1);
    assert.equal(r.verdict, "uncertain");
    assert.equal(r.reason, "typed_invalid");
    assert.equal(judge.stats().typed_invalid, 1);
  });

  it("(e) a typed client that throws yields uncertain/typed_error, judge does not throw", async () => {
    const jev = createFakeJev({ mode: "throw", error: "socket hang up" });
    const judge = createJudge({ client: jev });
    const r = await judge.judge(Q, "Sure thing.");
    assert.equal(r.verdict, "uncertain");
    assert.equal(r.reason, "typed_error");
    assert.match(r.error, /socket hang up/);
    assert.equal(judge.stats().typed_error, 1);
  });

  it("(f) maxTypedCalls caps typed spend; beyond it the judge stays uncertain", async () => {
    const jev = createFakeJev();
    const judge = createJudge({ client: jev, maxTypedCalls: 1 });
    const r1 = await judge.judge(Q, "Sure thing.");
    const r2 = await judge.judge(Q, "Sure thing.");
    assert.equal(r1.by, "typed");
    assert.equal(r2.verdict, "uncertain");
    assert.equal(r2.reason, "typed_budget");
    assert.equal(jev.calls.length, 1);
  });

  it("(g) validateTypedVerdict accepts only the typed shape", () => {
    assert.equal(validateTypedVerdict({ verdict: "responsive", confidence: 1, reason: "ok" }).ok, true);
    for (const bad of [
      null,
      "responsive",
      { verdict: "maybe", confidence: 0.5, reason: "x" },
      { verdict: "responsive", confidence: 1.5, reason: "x" },
      { verdict: "responsive", confidence: "0.5", reason: "x" },
      { verdict: "responsive", confidence: 0.5 },
      { verdict: "responsive", confidence: NaN, reason: "x" },
    ]) {
      assert.equal(validateTypedVerdict(bad).ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(VERDICTS, ["responsive", "unresponsive", "uncertain"]);
  });
});

describe("judge: coverage script", () => {
  it("runs the fixture corpus, decides most of it on the free screen, and makes zero wrong decisions", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "judge-coverage.mjs"), "--json", "--min", "60"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.ok(report.total >= 10, "corpus should have at least 10 fixtures");
    assert.equal(report.wrong_decisions.length, 0, JSON.stringify(report.wrong_decisions));
    assert.ok(report.screen_coverage_pct >= 60, `coverage ${report.screen_coverage_pct}`);
    assert.equal(report.typed_calls, report.uncertain, "typed calls happen only for uncertain screens");
  });
});
