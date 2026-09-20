// test/deliberation.test.mjs — Deliberation Engine Task 1: the run state machine.
// Pure reducer, no DB, no clock. Stall/resume keeps spent work; one answer out.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDeliberation,
  advance,
  isTerminal,
  canResume,
  STATES,
  DeliberationError,
} from "../src/deliberation.mjs";

const Q = "Write a five-line plan for a Node CLI that prints today's date in ISO format.";
const T0 = "2026-09-20T04:00:00.000Z";
let tick = 0;
const now = () => new Date(Date.parse(T0) + 1000 * tick++).toISOString();

function open() {
  return createDeliberation({ question: Q, producer: "codex", reviewer: "grok", chamber_id: "c1", now });
}

function toJudging(run) {
  run = advance(run, { type: "start" }, { now });
  run = advance(run, { type: "plan", content: "plan v1" }, { now });
  run = advance(run, { type: "critique", content: "critique v1" }, { now });
  run = advance(run, { type: "revise", content: "revision v1" }, { now });
  return run;
}

describe("deliberation Task 1: create", () => {
  it("(a) a new run is open, round 0, no artifacts, no answer, with an opened history entry", () => {
    const run = open();
    assert.equal(run.state, "open");
    assert.equal(run.round, 0);
    assert.equal(run.max_rounds, 2);
    assert.deepEqual(run.artifacts, { plan: null, critique: null, revision: null });
    assert.deepEqual(run.rounds, []);
    assert.equal(run.answer, null);
    assert.equal(run.stall, null);
    assert.equal(run.producer, "codex");
    assert.equal(run.reviewer, "grok");
    assert.equal(run.chamber_id, "c1");
    assert.match(run.id, /^[0-9a-f-]{36}$/);
    assert.equal(run.history.length, 1);
    assert.equal(run.history[0].type, "opened");
    assert.equal(run.history[0].to, "open");
    assert.equal(run.created, run.history[0].at);
  });

  it("(b) refuses an empty question", () => {
    for (const q of ["", "   ", null, undefined, 42]) {
      assert.throws(
        () => createDeliberation({ question: q, producer: "codex", reviewer: "grok" }),
        (e) => e instanceof DeliberationError && e.code === "bad_question"
      );
    }
  });

  it("(c) @owner is the floor, never a seat; seats must be distinct known members", () => {
    const bad = (producer, reviewer, code) =>
      assert.throws(
        () => createDeliberation({ question: Q, producer, reviewer }),
        (e) => e instanceof DeliberationError && e.code === code,
        `${producer}/${reviewer} -> ${code}`
      );
    bad("owner", "codex", "bad_seat");
    bad("codex", "owner", "bad_seat");
    bad("codex", "codex", "same_seat");
    bad("codex", "mystery", "bad_seat");
    bad(undefined, "grok", "bad_seat");
  });

  it("(d) max_rounds is configurable and must be a positive integer", () => {
    const run = createDeliberation({ question: Q, producer: "codex", reviewer: "grok", max_rounds: 1 });
    assert.equal(run.max_rounds, 1);
    for (const m of [0, -1, 1.5, "2"]) {
      assert.throws(
        () => createDeliberation({ question: Q, producer: "codex", reviewer: "grok", max_rounds: m }),
        (e) => e.code === "bad_max_rounds"
      );
    }
  });

  it("(e) STATES is the full set", () => {
    assert.deepEqual(STATES, ["open", "planning", "critiquing", "revising", "judging", "agreed", "stalled"]);
  });
});

describe("deliberation Task 1: happy path", () => {
  it("(a) start -> plan -> critique -> revise -> responsive verdict = agreed with one answer", () => {
    let run = open();
    run = advance(run, { type: "start" }, { now });
    assert.equal(run.state, "planning");
    assert.equal(run.round, 1);

    run = advance(run, { type: "plan", content: "plan v1" }, { now });
    assert.equal(run.state, "critiquing");
    assert.equal(run.artifacts.plan, "plan v1");

    run = advance(run, { type: "critique", content: "critique v1" }, { now });
    assert.equal(run.state, "revising");
    assert.equal(run.artifacts.critique, "critique v1");

    run = advance(run, { type: "revise", content: "revision v1" }, { now });
    assert.equal(run.state, "judging");
    assert.equal(run.artifacts.revision, "revision v1");

    run = advance(run, { type: "verdict", verdict: "responsive", by: "screen", reason: "keyword_overlap" }, { now });
    assert.equal(run.state, "agreed");
    assert.deepEqual(run.answer, { content: "revision v1", judged_by: "screen", reason: "keyword_overlap", round: 1 });
    assert.equal(isTerminal(run), true);
    assert.equal(canResume(run), false);
    assert.equal(run.rounds.length, 1);
    assert.deepEqual(run.rounds[0], { round: 1, plan: "plan v1", critique: "critique v1", revision: "revision v1", verdict: "responsive" });
  });

  it("(b) an unresponsive verdict with rounds left opens a second critique round and keeps round 1", () => {
    let run = toJudging(open());
    run = advance(run, { type: "verdict", verdict: "unresponsive", by: "typed", reason: "off-topic" }, { now });
    assert.equal(run.state, "critiquing");
    assert.equal(run.round, 2);
    assert.equal(run.answer, null);
    // Round 2 critiques the revision: it becomes the round's plan.
    assert.deepEqual(run.artifacts, { plan: "revision v1", critique: null, revision: null });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.rounds[0].verdict, "unresponsive");

    run = advance(run, { type: "critique", content: "critique v2" }, { now });
    run = advance(run, { type: "revise", content: "revision v2" }, { now });
    run = advance(run, { type: "verdict", verdict: "responsive", by: "screen", reason: "keyword_overlap" }, { now });
    assert.equal(run.state, "agreed");
    assert.equal(run.answer.content, "revision v2");
    assert.equal(run.answer.round, 2);
    assert.equal(run.rounds.length, 2);
  });

  it("(c) history records every transition in order with timestamps from the injected clock", () => {
    let run = toJudging(open());
    run = advance(run, { type: "verdict", verdict: "responsive", by: "screen", reason: "x" }, { now });
    assert.deepEqual(
      run.history.map((h) => [h.type, h.from, h.to]),
      [
        ["opened", null, "open"],
        ["start", "open", "planning"],
        ["plan", "planning", "critiquing"],
        ["critique", "critiquing", "revising"],
        ["revise", "revising", "judging"],
        ["verdict", "judging", "agreed"],
      ]
    );
    for (let i = 1; i < run.history.length; i++) {
      assert.ok(run.history[i].at > run.history[i - 1].at, "monotonic timestamps");
    }
    assert.equal(run.updated, run.history.at(-1).at);
  });
});

describe("deliberation Task 1: stall and resume instead of discard", () => {
  it("(a) rounds exhausted stalls with everything kept; it does not discard or invent an answer", () => {
    let run = createDeliberation({ question: Q, producer: "codex", reviewer: "grok", max_rounds: 1, now });
    run = toJudging(run);
    run = advance(run, { type: "verdict", verdict: "unresponsive", by: "screen", reason: "refusal" }, { now });
    assert.equal(run.state, "stalled");
    assert.equal(run.stall.reason, "rounds_exhausted");
    assert.equal(run.stall.from, "judging");
    assert.equal(run.answer, null);
    assert.equal(run.artifacts.revision, "revision v1");
    assert.equal(run.rounds.length, 1);
    assert.equal(isTerminal(run), false);
    assert.equal(canResume(run), true);
  });

  it("(b) an uncertain verdict stalls at judging for the owner; resume re-enters judging with the revision intact", () => {
    let run = toJudging(open());
    run = advance(run, { type: "verdict", verdict: "uncertain", by: "screen", reason: "too_short" }, { now });
    assert.equal(run.state, "stalled");
    assert.equal(run.stall.reason, "verdict_uncertain");
    assert.equal(run.stall.from, "judging");
    assert.equal(run.stall.detail, "too_short");

    run = advance(run, { type: "resume" }, { now });
    assert.equal(run.state, "judging");
    assert.equal(run.stall, null);
    assert.equal(run.artifacts.revision, "revision v1");
    // Owner may now supply a verdict (or a typed judge may). Either ends the run.
    run = advance(run, { type: "verdict", verdict: "responsive", by: "owner", reason: "looks right" }, { now });
    assert.equal(run.state, "agreed");
    assert.equal(run.answer.judged_by, "owner");
  });

  it("(c) stall from every non-terminal state, resume returns to exactly that state with artifacts intact", () => {
    const steps = [
      { type: "start" },
      { type: "plan", content: "plan v1" },
      { type: "critique", content: "critique v1" },
      { type: "revise", content: "revision v1" },
    ];
    let run = open();
    const visited = [];
    for (let i = 0; i <= steps.length; i++) {
      const before = run;
      const stalled = advance(before, { type: "stall", reason: "halt" }, { now });
      assert.equal(stalled.state, "stalled");
      assert.equal(stalled.stall.reason, "halt");
      assert.equal(stalled.stall.from, before.state);
      assert.deepEqual(stalled.artifacts, before.artifacts);
      assert.equal(stalled.round, before.round);
      assert.equal(canResume(stalled), true);

      const resumed = advance(stalled, { type: "resume" }, { now });
      assert.equal(resumed.state, before.state);
      assert.equal(resumed.stall, null);
      assert.deepEqual(resumed.artifacts, before.artifacts);
      assert.equal(resumed.round, before.round);
      assert.deepEqual(resumed.rounds, before.rounds);
      assert.equal(resumed.history.length, before.history.length + 2);
      visited.push(before.state);

      if (i < steps.length) run = advance(resumed, steps[i], { now });
    }
    assert.deepEqual(visited, ["open", "planning", "critiquing", "revising", "judging"]);
  });

  it("(d) every dispatcher interruption reason is accepted verbatim", () => {
    for (const reason of ["hop_cap", "auto_reply_cap", "daily_ceiling", "blocked", "halt", "restart", "typed_budget"]) {
      const run = advance(open(), { type: "stall", reason }, { now });
      assert.equal(run.stall.reason, reason);
    }
    assert.throws(() => advance(open(), { type: "stall" }, { now }), (e) => e.code === "bad_event");
  });

  it("(e) resume on a run that is not stalled, and stall on a stalled run, are illegal", () => {
    assert.throws(() => advance(open(), { type: "resume" }, { now }), (e) => e.code === "illegal_transition");
    const stalled = advance(open(), { type: "stall", reason: "halt" }, { now });
    assert.throws(() => advance(stalled, { type: "stall", reason: "halt" }, { now }), (e) => e.code === "illegal_transition");
    assert.throws(() => advance(stalled, { type: "plan", content: "x" }, { now }), (e) => e.code === "illegal_transition");
  });
});

describe("deliberation Task 1: guards", () => {
  it("(a) agreed is terminal: any further event throws code terminal, including stall", () => {
    let run = toJudging(open());
    run = advance(run, { type: "verdict", verdict: "responsive", by: "screen", reason: "x" }, { now });
    for (const ev of [{ type: "stall", reason: "halt" }, { type: "resume" }, { type: "start" }, { type: "verdict", verdict: "responsive", by: "screen", reason: "x" }]) {
      assert.throws(() => advance(run, ev, { now }), (e) => e instanceof DeliberationError && e.code === "terminal", ev.type);
    }
  });

  it("(b) out-of-order events are illegal transitions with from/event in the error", () => {
    const run = open();
    const err = (() => { try { advance(run, { type: "plan", content: "x" }, { now }); } catch (e) { return e; } })();
    assert.ok(err instanceof DeliberationError);
    assert.equal(err.code, "illegal_transition");
    assert.equal(err.from, "open");
    assert.equal(err.event, "plan");
    assert.throws(() => advance(advance(run, { type: "start" }, { now }), { type: "critique", content: "x" }, { now }), (e) => e.code === "illegal_transition");
    assert.throws(() => advance(run, { type: "verdict", verdict: "responsive", by: "screen", reason: "x" }, { now }), (e) => e.code === "illegal_transition");
  });

  it("(c) artifact events need non-empty content; verdict events need a known verdict", () => {
    const planning = advance(open(), { type: "start" }, { now });
    for (const content of ["", "   ", null, undefined]) {
      assert.throws(() => advance(planning, { type: "plan", content }, { now }), (e) => e.code === "bad_event");
    }
    const judging = toJudging(open());
    assert.throws(() => advance(judging, { type: "verdict", verdict: "maybe", by: "screen", reason: "x" }, { now }), (e) => e.code === "bad_event");
    assert.throws(() => advance(judging, { type: "nonsense" }, { now }), (e) => e.code === "bad_event");
    assert.throws(() => advance(judging, null, { now }), (e) => e.code === "bad_event");
  });

  it("(d) advance never mutates its input", () => {
    const run = open();
    const snapshot = JSON.stringify(run);
    const next = advance(run, { type: "start" }, { now });
    assert.notEqual(next, run);
    assert.equal(JSON.stringify(run), snapshot);
    const stalled = advance(next, { type: "stall", reason: "halt" }, { now });
    assert.equal(next.state, "planning");
    assert.equal(next.stall, null);
    assert.notEqual(stalled.history, next.history);
  });

  it("(e) a run is plain JSON: it survives a round trip through JSON.stringify", () => {
    let run = toJudging(open());
    run = advance(run, { type: "stall", reason: "restart" }, { now });
    const copy = JSON.parse(JSON.stringify(run));
    assert.deepEqual(copy, run);
    const resumed = advance(copy, { type: "resume" }, { now });
    assert.equal(resumed.state, "judging");
  });
});
