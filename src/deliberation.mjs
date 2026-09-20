// src/deliberation.mjs — one question in, one agreed answer out.
import { accountOf } from "./seats.mjs";
import { runsTodayForAccount, ceilingFor, loadLimits } from "./adapters/spawn.mjs";
import { parseVerdict } from "./verdict.mjs";

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

/** Inverse of deliberationKey. null for anything that is not a full engine key. */
export function parseDeliberationKey(key) {
  if (typeof key !== "string") return null;
  const m = /^delib:([^:]+):([^:]+):(\d+):([^:]+)$/.exec(key);
  if (!m) return null;
  return { id: m[1], state: m[2], round: Number(m[3]), member: m[4] };
}

/**
 * Resolve the owning deliberation from the CLAIMED message, never from the row
 * the tick scanned — outbox.claim has no chamber filter and frequently returns a
 * different row than the one that was seen.
 */
export function findDeliberationFor(store, message) {
  const key = parseDeliberationKey(message?.idempotency_key);
  if (!key) return null;
  return store.prepare("SELECT * FROM deliberations WHERE id = ?").get(key.id) || null;
}

/** Debate packets show every member's latest reply, labelled, plus the protocol. */
export function debatePrompt(question, answers, round) {
  const lines = [
    `Council deliberation, debate round ${round} of ${MAX_ROUNDS}.`,
    "Every member's answer so far is below. Read them, then respond.",
    "",
    "You MUST end your reply with exactly one line:",
    "AGREE: <the answer you both now hold>",
    "DISAGREE: <what is still wrong>",
    "ESCALATE: <why this needs the owner now>",
    "",
    "QUESTION:",
    question,
    "",
  ];
  for (const [who, text] of Object.entries(answers)) {
    if (who.startsWith("__")) continue;
    lines.push(`--- ${who} ---`, text, "");
  }
  return lines.join("\n");
}

const CLOSED = ["pending_owner", "settled", "overruled", "abandoned"];
const PATCHABLE = new Set(["state", "round", "flag", "answers", "final_answer", "stall_detail"]);

function persist(store, id, patch) {
  return store.commit("deliberation_advanced", "dispatcher", (api) => {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) throw new Error("deliberation: not a patchable column: " + k);
      sets.push(`${k} = ?`);
      vals.push(k === "answers" ? JSON.stringify(v) : v);
    }
    sets.push("updated = ?");
    vals.push(api.nowIso(), id);
    api.prepare(`UPDATE deliberations SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    api.setRef("deliberations", id, patch.state ? { state: patch.state, flag: patch.flag ?? null } : { touched: true });
    return { id };
  }).result;
}

function sendPacket(outbox, row, { to, from, parent, content, state, round }) {
  return outbox.send({
    // The member whose reply produced this packet, never "owner": stamping the
    // owner on machine-generated packets would falsify the chain (Task 12 exempts
    // delib:* traffic from the conversational caps instead).
    sender: from,
    recipients: [to],
    chamber_id: row.chamber_id,
    kind: "deliberate",
    content,
    parent_id: parent?.id ?? null,
    idempotency_key: deliberationKey(row.id, state, round, to),
  });
}

const LIVE = ["answer_1", "answer_2", "debate"];

/**
 * Hold a deliberation intact after a failed run instead of destroying it.
 *
 * Every failure stalls, not just budget ones. A stall costs nothing to recover
 * from and a wrong abandon costs every run already spent, so the asymmetry
 * decides it. `detail` preserves the provider's own words for diagnosis, and
 * from_state / from_round record where the row was so a later successful retry
 * of the same packet (advanceOnReply) or resumeStalled (Task 14) can return it.
 */
export function stall(store, id, detail = {}) {
  return store.commit("deliberation_stalled", detail?.member || "dispatcher", (api) => {
    const row = api.prepare("SELECT state, round FROM deliberations WHERE id = ?").get(id);
    if (!row || !LIVE.includes(row.state)) {
      api.setRef("deliberations", id, { stalled: false, state: row?.state ?? null });
      return { id, stalled: false };
    }
    const reason = String(detail?.reason || "run_failed");
    const full = { ...detail, reason, from_state: detail.from_state ?? row.state, from_round: detail.from_round ?? row.round };
    api.prepare(
      `UPDATE deliberations SET state='stalled', flag=?, stall_detail=?, updated=?
       WHERE id=? AND state IN ('answer_1','answer_2','debate')`
    ).run(reason, JSON.stringify(full), api.nowIso(), id);
    api.setRef("deliberations", id, { stalled: reason, member: detail?.member ?? null, from_state: full.from_state });
    return { id, stalled: true };
  }).result;
}

/** HALT or owner cancel. Never a run failure — those stall. */
export function abandon(store, id, reason) {
  return store.commit("deliberation_abandoned", "dispatcher", (api) => {
    const info = api.prepare(
      "UPDATE deliberations SET state='abandoned', flag=?, updated=? WHERE id=? AND state NOT IN ('settled','overruled','abandoned')"
    ).run(reason, api.nowIso(), id);
    api.setRef("deliberations", id, { abandoned: reason });
    return { id, reason, changed: info.changes > 0 };
  }).result;
}

/**
 * Drive the state machine with one member reply to one engine packet.
 *
 *   answer_1 --reply--> answer_2 (second deliberator asked BLIND)
 *   answer_2 --reply--> debate round 1 (both asked, both answers shown)
 *   debate   --both verdicts--> AGREE+AGREE: pending_owner/agreed
 *                               any ESCALATE: pending_owner/escalated (immediately)
 *                               otherwise:    round+1, or pending_owner/deadlock past MAX_ROUNDS
 *
 * Returns null and writes nothing when the message is not an engine packet, the
 * row is closed or stalled, or the packet's (state, round, member) does not match
 * the row and the replier — a stale re-delivery or a misrouted reply must not
 * count as a verdict for the current round.
 *
 * @returns {{state: string, round: number, flag: string|null} | null}
 */
export function advanceOnReply(store, outbox, { message, member, text }) {
  const key = parseDeliberationKey(message?.idempotency_key);
  if (!key) return null;
  let row = store.prepare("SELECT * FROM deliberations WHERE id = ?").get(key.id);
  if (!row) return null;
  if (CLOSED.includes(row.state)) return null;
  if (row.state === "stalled") {
    // The dispatcher keeps retrying an expired lease on its own. If the packet
    // the row stalled on finally succeeds, that reply resumes the row in place
    // instead of being dropped. Anything else stays ignored until Task 14 resumes.
    let detail = {};
    try { detail = JSON.parse(row.stall_detail || "{}"); } catch { detail = {}; }
    if (!LIVE.includes(detail.from_state) || key.state !== detail.from_state || key.round !== Number(detail.from_round)) return null;
    row = { ...row, state: detail.from_state, round: Number(detail.from_round), flag: null, stall_detail: null, __resumed: true };
  }
  if (key.member !== member || key.state !== row.state || key.round !== row.round) return null;

  const deliberators = JSON.parse(row.deliberators);
  if (!deliberators.includes(member)) return null;
  const answers = JSON.parse(row.answers || "{}");
  const reply = String(text ?? "");
  const history = Array.isArray(answers.__history) ? answers.__history : [];
  const current = () => ({ state: row.state, round: row.round, flag: row.flag ?? null });
  // Leaving a stall clears its marker; a caller's own flag (agreed/…) still wins.
  const save = (patch) => persist(store, row.id, row.__resumed ? { flag: null, stall_detail: null, state: row.state, round: row.round, ...patch } : patch);

  // --- blind phase ---
  if (row.state === "answer_1") {
    if (member !== deliberators[0]) return null;
    answers[member] = reply;
    answers.__history = [...history, { state: "answer_1", round: 0, member, text: reply }];
    save({ state: "answer_2", answers });
    // NOT debatePrompt — round one stays blind.
    sendPacket(outbox, row, { to: deliberators[1], from: member, parent: message, content: blindPrompt(row.question), state: "answer_2", round: 0 });
    return { state: "answer_2", round: 0, flag: null };
  }

  if (row.state === "answer_2") {
    if (member !== deliberators[1]) return null;
    answers[member] = reply;
    answers.__history = [...history, { state: "answer_2", round: 0, member, text: reply }];
    answers.__verdicts = {};
    save({ state: "debate", round: 1, answers });
    for (const m of deliberators) {
      sendPacket(outbox, row, { to: m, from: member, parent: message, content: debatePrompt(row.question, answers, 1), state: "debate", round: 1 });
    }
    return { state: "debate", round: 1, flag: null };
  }

  // --- debate phase ---
  if (row.state !== "debate") return null;
  const verdicts = answers.__verdicts && typeof answers.__verdicts === "object" ? answers.__verdicts : {};
  if (verdicts[member]) {
    // Duplicate reply this round: first verdict stands. Still un-stall if this
    // was the retried packet the row stalled on.
    if (row.__resumed) save({});
    return current();
  }

  const verdict = parseVerdict(reply);
  verdicts[member] = verdict.kind;
  answers[member] = reply;
  answers.__verdicts = verdicts;
  answers.__history = [...history, { state: "debate", round: row.round, member, text: reply, verdict: verdict.kind, malformed: verdict.malformed }];

  if (verdict.kind === "ESCALATE") {
    // The reason is not an answer; the owner writes their own from the Black Seat.
    answers.__escalation = { member, body: verdict.body, round: row.round };
    save({ state: "pending_owner", flag: "escalated", answers, final_answer: null });
    return { state: "pending_owner", round: row.round, flag: "escalated" };
  }

  const waiting = deliberators.filter((m) => !verdicts[m]);
  if (waiting.length) {
    save({ answers });
    return { state: "debate", round: row.round, flag: null };
  }

  if (deliberators.every((m) => verdicts[m] === "AGREE")) {
    save({ state: "pending_owner", flag: "agreed", answers, final_answer: verdict.body });
    return { state: "pending_owner", round: row.round, flag: "agreed" };
  }

  const next = row.round + 1;
  if (next > MAX_ROUNDS) {
    save({ state: "pending_owner", flag: "deadlock", answers });
    return { state: "pending_owner", round: row.round, flag: "deadlock" };
  }

  answers.__verdicts = {}; // fresh verdicts each round
  save({ state: "debate", round: next, answers });
  for (const m of deliberators) {
    sendPacket(outbox, row, { to: m, from: member, parent: message, content: debatePrompt(row.question, answers, next), state: "debate", round: next });
  }
  return { state: "debate", round: next, flag: null };
}
