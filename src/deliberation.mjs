// src/deliberation.mjs — Deliberation Engine, Task 1: the run state machine.
//
// One question in, one agreed answer out. A run is a plain JSON object and
// advance() is a pure reducer over it: no database, no I/O, no clock except the
// injectable `now`. Later tasks persist it, drive it from the dispatcher, and
// show it on the Floor; this file only says what a run IS and how it may move.
//
//   open -start-> planning -plan-> critiquing -critique-> revising -revise-> judging
//   judging -verdict:responsive-> agreed                       (answer set, terminal)
//   judging -verdict:unresponsive, round < max_rounds-> critiquing (round + 1)
//   judging -verdict:unresponsive, rounds exhausted-> stalled  (reason rounds_exhausted)
//   judging -verdict:uncertain-> stalled                        (reason verdict_uncertain)
//   any non-terminal -stall(reason)-> stalled; stalled -resume-> the state it came from
//
// Stalling keeps every artifact and the round count. Nothing spent is discarded.
// The owner is the floor, not a seat: "owner" can never be producer or reviewer.
import { randomUUID } from "node:crypto";
import { MEMBERS } from "./routing.mjs";
import { VERDICTS } from "./judge.mjs";

export const STATES = ["open", "planning", "critiquing", "revising", "judging", "agreed", "stalled"];
export const DEFAULT_MAX_ROUNDS = 2;

export class DeliberationError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DeliberationError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const EMPTY_ARTIFACTS = Object.freeze({ plan: null, critique: null, revision: null });

function isoNow(opts) {
  const fn = opts && typeof opts.now === "function" ? opts.now : () => new Date().toISOString();
  return String(fn());
}

function assertSeat(name, role) {
  if (typeof name !== "string" || !MEMBERS.includes(name)) {
    throw new DeliberationError("bad_seat", `${role} must be one of ${MEMBERS.join(", ")}; got ${JSON.stringify(name)}`, { role, seat: name });
  }
}

export function createDeliberation(opts = {}) {
  const question = typeof opts.question === "string" ? opts.question.trim() : "";
  if (!question) throw new DeliberationError("bad_question", "question must be a non-empty string");
  assertSeat(opts.producer, "producer");
  assertSeat(opts.reviewer, "reviewer");
  if (opts.producer === opts.reviewer) {
    throw new DeliberationError("same_seat", "producer and reviewer must be different members");
  }
  const maxRounds = opts.max_rounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new DeliberationError("bad_max_rounds", "max_rounds must be a positive integer");
  }
  const at = isoNow(opts);
  return {
    id: opts.id || randomUUID(),
    chamber_id: opts.chamber_id ?? null,
    question,
    producer: opts.producer,
    reviewer: opts.reviewer,
    state: "open",
    round: 0,
    max_rounds: maxRounds,
    artifacts: { ...EMPTY_ARTIFACTS },
    rounds: [],
    answer: null,
    stall: null,
    history: [{ type: "opened", from: null, to: "open", at }],
    created: at,
    updated: at,
  };
}

export function isTerminal(run) {
  return !!run && run.state === "agreed";
}

export function canResume(run) {
  return !!run && run.state === "stalled" && !!run.stall && STATES.includes(run.stall.from);
}

function illegal(run, event) {
  return new DeliberationError(
    "illegal_transition",
    `cannot apply "${event.type}" while ${run.state}`,
    { from: run.state, event: event.type }
  );
}

function requireContent(event) {
  const c = typeof event.content === "string" ? event.content.trim() : "";
  if (!c) throw new DeliberationError("bad_event", `${event.type} needs non-empty content`, { event: event.type });
  return event.content;
}

function moved(run, event, to, patch, at) {
  return {
    ...run,
    ...patch,
    state: to,
    updated: at,
    history: [...run.history, { type: event.type, from: run.state, to, at }],
  };
}

function stallTo(run, event, reason, at, detail) {
  const stall = { reason, from: run.state, at, ...(detail != null ? { detail } : {}) };
  return moved(run, event, "stalled", { stall }, at);
}

/**
 * advance(run, event, { now? }) -> a new run. Never mutates `run`.
 * Events: start | plan{content} | critique{content} | revise{content}
 *         | verdict{verdict, by, reason} | stall{reason, detail?} | resume
 */
export function advance(run, event, opts = {}) {
  if (!run || typeof run !== "object" || !STATES.includes(run.state)) {
    throw new DeliberationError("bad_run", "advance needs a deliberation run");
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new DeliberationError("bad_event", "event must be an object with a string type");
  }
  if (isTerminal(run)) {
    throw new DeliberationError("terminal", `run is ${run.state}; no further transitions`, { from: run.state, event: event.type });
  }
  const at = isoNow(opts);

  switch (event.type) {
    case "stall": {
      if (run.state === "stalled") throw illegal(run, event);
      const reason = typeof event.reason === "string" ? event.reason.trim() : "";
      if (!reason) throw new DeliberationError("bad_event", "stall needs a reason", { event: "stall" });
      return stallTo(run, event, reason, at, event.detail);
    }

    case "resume": {
      if (!canResume(run)) throw illegal(run, event);
      return moved(run, event, run.stall.from, { stall: null }, at);
    }

    case "start": {
      if (run.state !== "open") throw illegal(run, event);
      return moved(run, event, "planning", { round: 1 }, at);
    }

    case "plan": {
      if (run.state !== "planning") throw illegal(run, event);
      const content = requireContent(event);
      return moved(run, event, "critiquing", { artifacts: { ...run.artifacts, plan: content } }, at);
    }

    case "critique": {
      if (run.state !== "critiquing") throw illegal(run, event);
      const content = requireContent(event);
      return moved(run, event, "revising", { artifacts: { ...run.artifacts, critique: content } }, at);
    }

    case "revise": {
      if (run.state !== "revising") throw illegal(run, event);
      const content = requireContent(event);
      return moved(run, event, "judging", { artifacts: { ...run.artifacts, revision: content } }, at);
    }

    case "verdict": {
      if (run.state !== "judging") throw illegal(run, event);
      if (!VERDICTS.includes(event.verdict)) {
        throw new DeliberationError("bad_event", `verdict must be one of ${VERDICTS.join(", ")}`, { event: "verdict" });
      }
      const closedRound = { round: run.round, ...run.artifacts, verdict: event.verdict };
      const rounds = [...run.rounds, closedRound];

      if (event.verdict === "responsive") {
        const answer = {
          content: run.artifacts.revision,
          judged_by: event.by ?? null,
          reason: event.reason ?? null,
          round: run.round,
        };
        return moved(run, event, "agreed", { rounds, answer }, at);
      }

      if (event.verdict === "uncertain") {
        // The owner (or a typed judge on resume) decides; the revision stays put.
        return stallTo({ ...run, rounds }, event, "verdict_uncertain", at, event.reason);
      }

      // unresponsive
      if (run.round >= run.max_rounds) {
        return stallTo({ ...run, rounds }, event, "rounds_exhausted", at, event.reason);
      }
      // Another round: the rejected revision is what the reviewer critiques next.
      return moved(
        run,
        event,
        "critiquing",
        { rounds, round: run.round + 1, artifacts: { plan: run.artifacts.revision, critique: null, revision: null } },
        at
      );
    }

    default:
      throw new DeliberationError("bad_event", `unknown event type "${event.type}"`, { event: event.type });
  }
}
