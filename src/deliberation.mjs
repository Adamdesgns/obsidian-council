// src/deliberation.mjs — one question in, one agreed answer out.
import { accountOf } from "./seats.mjs";
import { runsTodayForAccount, ceilingFor, loadLimits } from "./adapters/spawn.mjs";

/** Worst case per deliberator: 1 blind answer + 3 debate rounds. */
export const RUNS_PER_DELIBERATOR = 4;
export const MAX_ROUNDS = 3;

/**
 * Read-only. Refuses up front rather than stranding a debate half-finished,
 * because a deliberation that dies at round 2 has spent real budget for nothing.
 *
 * Budget is counted per ACCOUNT, with the same ceiling rule spawnMember
 * enforces (ceilingFor), so preflight can never approve a run spawn would
 * refuse. Two deliberators on one account need 2 x RUNS_PER_DELIBERATOR from
 * that account; checking each alone would pass at 7 remaining and strand at 8.
 *
 * @returns {{ok: true} | {ok: false, reason: string, member?: string, account?: string, remaining?: number, needed?: number}}
 */
export function preflight(store, { deliberators, limits } = {}) {
  if (!Array.isArray(deliberators) || deliberators.length === 0) {
    return { ok: false, reason: "no_deliberators" };
  }
  const lim = limits || loadLimits();

  // account -> { members (in list order), needed }
  const byAccount = new Map();
  for (const member of deliberators) {
    let account;
    try { account = accountOf(member); } catch { return { ok: false, reason: "unknown_seat", member }; }
    const slot = byAccount.get(account) || { members: [], needed: 0 };
    slot.members.push(member);
    slot.needed += RUNS_PER_DELIBERATOR;
    byAccount.set(account, slot);
  }

  for (const [account, { members, needed }] of byAccount) {
    const ceiling = ceilingFor(lim, members[0]);
    const used = runsTodayForAccount(store, account);
    const remaining = ceiling - used;
    if (remaining < needed) {
      return { ok: false, reason: "insufficient_budget", member: members[0], account, remaining, needed };
    }
  }
  return { ok: true };
}

/**
 * Deterministic. NOT derived from Date.now() or the claim generation —
 * both of those produce duplicate or colliding keys on retry. The same
 * (deliberation, state, round, member) always yields the same key, so a
 * re-send after a crash or a resume is a no-op in the outbox.
 */
export function deliberationKey(id, state, round, member) {
  return `delib:${id}:${state}:${round}:${member}`;
}

/** Round one sees the question and nothing else. This is the whole point. */
export function blindPrompt(question) {
  return [
    "You are answering a Council question independently.",
    "No other member's answer is available to you, by design.",
    "Answer in your own words.",
    "",
    "QUESTION:",
    question,
  ].join("\n");
}

/**
 * Open a deliberation: preflight the budget, persist the row in answer_1, then
 * ask the FIRST deliberator with a packet that holds only the question.
 *
 * Two commits, row first: outbox.send() commits on its own and store.commit
 * cannot nest. A crash between them leaves a row in answer_1 with no delivery;
 * the deterministic key lets a resume re-send without duplicating.
 *
 * @returns {{ok: true, id: string, state: "answer_1", message_id: string} | {ok: false, reason: string}}
 */
export function startDeliberation(store, outbox, opts = {}) {
  const { chamber_id = null, deliberators, limits, category = null } = opts;
  const question = typeof opts.question === "string" ? opts.question.trim() : "";

  if (!Array.isArray(deliberators) || deliberators.length !== 2) {
    return { ok: false, reason: "need_exactly_two_deliberators" };
  }
  if (deliberators[0] === deliberators[1]) {
    return { ok: false, reason: "duplicate_deliberator", member: deliberators[0] };
  }
  if (!question) return { ok: false, reason: "empty_question" };

  const pre = preflight(store, { deliberators, limits });
  if (!pre.ok) return pre;

  const committed = store.commit("deliberation_started", "owner", (api) => {
    const id = api.uuid();
    const now = api.nowIso();
    api.prepare(
      `INSERT INTO deliberations(id, chamber_id, question, category, state, round, deliberators, answers, created, updated)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(id, chamber_id, question, category, "answer_1", 0,
      JSON.stringify(deliberators), JSON.stringify({}), now, now);
    api.setRef("deliberations", id, { state: "answer_1", deliberators });
    return { id };
  });

  const id = committed.result.id;
  const sent = outbox.send({
    sender: "owner",
    recipients: [deliberators[0]],
    chamber_id,
    kind: "deliberate",
    content: blindPrompt(question),
    idempotency_key: deliberationKey(id, "answer_1", 0, deliberators[0]),
  });

  return { ok: true, id, state: "answer_1", message_id: sent.message.id };
}
