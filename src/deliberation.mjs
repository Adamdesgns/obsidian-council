// One durable transition owns acknowledgment, reply and next messages. No model calls here.
import { contentHash, assertSanction } from "./sanctions.mjs";
import { seatOf, defaultDeliberators } from "./seats.mjs";
import { runsTodayForAccount, redact } from "./adapters/spawn.mjs";
import { parseVerdict } from "./verdict.mjs";

export const MAX_ROUNDS = 3;
const ACTIVE = ["answer_1", "answer_2", "debate"];
const TERMINAL = ["pending_owner", "settled", "overruled", "abandoned"];
const normalize = text => String(text ?? "").trim().replace(/\s+/g, " ");
export const answerHash = text => contentHash(normalize(text));
const get = (db, id) => db.prepare("SELECT * FROM deliberations WHERE id=?").get(id);
const pairOf = row => JSON.parse(row.deliberators);
const phaseOf = row => row.state === "stalled" ? row.resume_state : row.state;

export function remainingWork(store, row) {
  const done = store.prepare(
    "SELECT member, COUNT(*) AS n FROM deliberation_messages WHERE deliberation_id=? AND response IS NOT NULL GROUP BY member"
  ).all(row.id);
  return Object.fromEntries(pairOf(row).map(m => [m, 4 - (done.find(d => d.member === m)?.n || 0)]));
}

// Reserve worst-case remaining capacity of other active deliberations, by account.
export function preflight(store, { deliberators, limits, row = null }) {
  const required = {};
  const work = row ? remainingWork(store, row) : Object.fromEntries(deliberators.map(m => [m, 4]));
  for (const m of deliberators) {
    const s = seatOf(m);
    if (!s || s.role !== "deliberator") return { ok: false, reason: "invalid_deliberator" };
    required[s.account] = (required[s.account] || 0) + work[m];
  }
  const reserved = {};
  for (const other of store.prepare("SELECT * FROM deliberations WHERE state IN ('answer_1','answer_2','debate')").all()) {
    if (other.id === row?.id) continue;
    for (const [m, n] of Object.entries(remainingWork(store, other))) {
      const account = seatOf(m).account;
      reserved[account] = (reserved[account] || 0) + n;
    }
  }
  for (const [account, n] of Object.entries(required)) {
    const remaining = (limits?.daily_ceiling?.[account] ?? 0) - runsTodayForAccount(store, account) - (reserved[account] || 0);
    if (remaining < n) return { ok: false, reason: "insufficient_budget", account, remaining, required: n };
  }
  return { ok: true };
}

function update(api, row, patch) {
  Object.assign(row, patch, { updated: api.nowIso() });
  api.prepare("UPDATE deliberations SET " + Object.keys(patch).map(k => k + "=?").join(",") + ", updated=? WHERE id=?")
    .run(...Object.values(patch), row.updated, row.id);
}
function messageIn(api, { row, sender, recipient, content, key, kind, parent = null }) {
  const id = api.uuid(), now = api.nowIso();
  api.prepare("INSERT INTO messages(id,chamber_id,sender,recipients,kind,parent_id,content,idempotency_key,created) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, row.chamber_id, sender, JSON.stringify([recipient]), kind, parent, content, key, now);
  api.prepare("INSERT INTO deliveries(message_id,recipient,status,attempt_gen,updated) VALUES(?,?,'pending',0,?)")
    .run(id, recipient, now);
  return id;
}
function prompt(row) {
  if (row.state !== "debate") return "Answer this question independently. Do not request tools or other members.\nQUESTION:\n" + row.question;
  const answers = JSON.parse(row.answers);
  return [
    "Council debate round " + row.round + " of " + MAX_ROUNDS + ".",
    "This is a decision only. Do not execute actions or request tools.",
    "End with exactly one final line:",
    "AGREE: <copy the CANDIDATE answer exactly if you endorse it>",
    "DISAGREE: <your proposed replacement answer>",
    "ESCALATE: <why Adam must decide>",
    "QUESTION:", row.question, "CANDIDATE:", row.candidate,
    "CANDIDATE HASH: " + row.candidate_hash,
    "MEMBER ANSWERS:", ...Object.entries(answers).map(([m,t]) => m + ": " + t),
  ].join("\n");
}
function enqueue(api, row, member) {
  const id = messageIn(api, {
    row, sender: "engine", recipient: member, kind: "deliberate", content: prompt(row),
    key: `delib:${row.id}:${row.state}:${row.round}:${member}`,
  });
  api.prepare("INSERT INTO deliberation_messages(message_id,deliberation_id,phase,round,member) VALUES(?,?,?,?,?)")
    .run(id, row.id, row.state, row.round, member);
}
function fenceIn(api, row) {
  api.prepare(`UPDATE deliveries SET status='cancelled', attempt_gen=attempt_gen+1, lease_until=NULL, updated=?
    WHERE message_id IN (SELECT message_id FROM deliberation_messages WHERE deliberation_id=?)
      AND status NOT IN ('answered','cancelled')`).run(api.nowIso(), row.id);
}
function pendingIn(api, row, flag) {
  update(api, row, { state: "pending_owner", flag, final_answer: row.candidate || row.question });
  update(api, row, { candidate_hash: answerHash(row.final_answer) });
  fenceIn(api, row);
}
function advanceIn(api, row) {
  if (!ACTIVE.includes(row.state)) return;
  const tasks = api.prepare("SELECT * FROM deliberation_messages WHERE deliberation_id=? AND phase=? AND round=?")
    .all(row.id, row.state, row.round);
  const escalated = tasks.find(t => t.response != null && parseVerdict(t.response).kind === "ESCALATE");
  if (escalated) {
    update(api, row, { candidate: parseVerdict(escalated.response).body });
    return pendingIn(api, row, "escalated");
  }
  if (!tasks.length || tasks.some(t => t.response == null)) return;
  const pair = pairOf(row);
  if (row.state === "answer_1") {
    update(api, row, { state: "answer_2" }); enqueue(api, row, pair[1]); return;
  }
  if (row.state === "answer_2") {
    const candidate = JSON.parse(row.answers)[pair[0]];
    update(api, row, { state: "debate", round: 1, candidate, candidate_hash: answerHash(candidate) });
  } else {
    const verdicts = pair.map(m => parseVerdict(tasks.find(t => t.member === m).response));
    if (verdicts.every(v => !v.malformed && v.kind === "AGREE" && answerHash(v.body) === row.candidate_hash)) {
      return pendingIn(api, row, "agreed");
    }
    if (row.round >= MAX_ROUNDS) return pendingIn(api, row, "deadlock");
    const proposal = verdicts.find(v => !v.malformed && v.kind === "DISAGREE")?.body;
    const candidate = proposal || row.candidate;
    update(api, row, { round: row.round + 1, candidate, candidate_hash: answerHash(candidate) });
  }
  for (const m of pair) enqueue(api, row, m);
}

export function startDeliberation(store, { question, chamber_id = null, deliberators = defaultDeliberators(), idempotency_key, limits }) {
  question = typeof question === "string" ? question.trim() : "";
  if (!question || question.length > 50000) return { ok: false, reason: "invalid_question" };
  if (chamber_id !== null && (typeof chamber_id !== "string" || chamber_id.length > 200))
    return { ok: false, reason: "invalid_source_chamber" };
  if (!Array.isArray(deliberators) || deliberators.length !== 2 || new Set(deliberators).size !== 2 ||
      deliberators.some(m => seatOf(m)?.role !== "deliberator")) return { ok: false, reason: "need_two_distinct_deliberators" };
  if (typeof idempotency_key !== "string" || !idempotency_key || idempotency_key.length > 200) return { ok: false, reason: "idempotency_key_required" };
  const requestHash = contentHash(JSON.stringify({ question, chamber_id, deliberators }));
  return store.commit("deliberation_started", "owner", api => {
    const existing = api.prepare("SELECT * FROM deliberations WHERE request_key=?").get(idempotency_key);
    if (existing) return existing.request_hash === requestHash
      ? { ok: true, id: existing.id, duplicate: true, state: existing.state }
      : { ok: false, reason: "idempotency_conflict" };
    const check = preflight(store, { deliberators, limits });
    if (!check.ok) return check;
    const id = api.uuid(), chamber = "deliberation-" + id, now = api.nowIso();
    api.prepare("INSERT INTO chambers(id,title,created,status) VALUES(?,?,?,'open')").run(chamber, question.slice(0, 80), now);
    api.prepare(`INSERT INTO deliberations(id,request_key,request_hash,chamber_id,source_chamber_id,question,deliberators,state,created,updated)
      VALUES(?,?,?,?,?,?,?,'answer_1',?,?)`).run(id,idempotency_key,requestHash,chamber,chamber_id,question,JSON.stringify(deliberators),now,now);
    const row = get(api,id);
    // Human question is recorded once, distinctly from the engine's prompts.
    messageIn(api, {row,sender:"owner",recipient:"owner",kind:"deliberation_question",content:question,key:"delib-question:"+id});
    enqueue(api,row,deliberators[0]);
    api.setRef("deliberations",id,{state:"answer_1"});
    return {ok:true,id,chamber_id:chamber,state:"answer_1"};
  }).result;
}

export function taskFor(store, messageId) {
  return store.prepare("SELECT * FROM deliberation_messages WHERE message_id=?").get(messageId) || null;
}
export function canDispatch(store, messageId, member) {
  const task = taskFor(store,messageId);
  if (!task) return false;
  const row = get(store,task.deliberation_id);
  return ACTIVE.includes(row.state) && task.member === member && task.response == null &&
    row.state === task.phase && row.round === task.round;
}
export function completeReply(store, { message, delivery, gen, member, text, fault = null }) {
  return store.commit("deliberation_reply",member,api => {
    const task = taskFor(api,message.id);
    const row = task && get(api,task.deliberation_id);
    const lease = api.prepare("SELECT * FROM deliveries WHERE id=?").get(delivery.id);
    if (!row || TERMINAL.includes(row.state) || task.member !== member || task.response != null ||
        phaseOf(row) !== task.phase || row.round !== task.round || lease?.recipient !== member ||
        lease.message_id !== message.id || lease.attempt_gen !== gen || lease.status !== "leased")
      return {ok:false,reason:"stale_reply"};
    text = redact(String(text ?? ""));
    api.prepare("UPDATE deliveries SET status='answered',lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),delivery.id);
    api.prepare("UPDATE deliberation_messages SET response=? WHERE message_id=?").run(text,message.id);
    const answers = JSON.parse(row.answers); answers[member] = text;
    update(api,row,{answers:JSON.stringify(answers)});
    messageIn(api,{row,sender:member,recipient:"owner",kind:"deliberation_reply",content:text,parent:message.id,key:"delib-reply:"+message.id});
    fault?.("after_reply");
    advanceIn(api,row);
    fault?.("after_advance");
    api.setRef("deliberations",row.id,{state:row.state,round:row.round,member});
    return {ok:true,state:row.state,round:row.round,flag:row.flag};
  }).result;
}

export function stall(store, { message, delivery, gen, member, reason, result }) {
  return store.commit("deliberation_stalled",member,api => {
    const task = taskFor(api,message.id), row = task && get(api,task.deliberation_id);
    const lease = api.prepare("SELECT * FROM deliveries WHERE id=?").get(delivery.id);
    if (!row || TERMINAL.includes(row.state) || lease?.attempt_gen !== gen || lease?.status !== "leased") return {ok:false,reason:"stale_failure"};
    api.prepare("UPDATE deliveries SET status='parked',lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),delivery.id);
    const detail = {member,reason,exit:result?.exit ?? null,stderr:redact(String(result?.stderr || "")).slice(0,2000)};
    update(api,row,{state:"stalled",resume_state:phaseOf(row),stall_detail:JSON.stringify(detail)});
    api.setRef("deliberations",row.id,detail);
    return {ok:true,state:"stalled"};
  }).result;
}
export function resumeStalled(store,id,{limits}) {
  return store.commit("deliberation_resumed","owner",api => {
    const row=get(api,id);
    if (!row || row.state !== "stalled") return {ok:false,reason:"not_stalled"};
    const check=preflight(store,{deliberators:pairOf(row),limits,row});
    if (!check.ok) return check;
    update(api,row,{state:row.resume_state,resume_state:null,stall_detail:null});
    api.prepare(`UPDATE deliveries SET status='pending',lease_until=NULL,updated=?
      WHERE status='parked' AND message_id IN (SELECT message_id FROM deliberation_messages WHERE deliberation_id=? AND response IS NULL)`)
      .run(api.nowIso(),id);
    advanceIn(api,row);
    api.setRef("deliberations",id,{state:row.state});
    return {ok:true,state:row.state};
  }).result;
}
export function abandon(store,id,reason="cancelled") {
  return store.commit("deliberation_abandoned","owner",api => {
    const row=get(api,id);
    if (!row || ["settled","overruled","abandoned"].includes(row.state)) return {ok:false,reason:"not_cancellable"};
    update(api,row,{state:"abandoned",flag:reason});
    fenceIn(api,row); api.setRef("deliberations",id,{reason});
    return {ok:true,state:"abandoned"};
  }).result;
}
export function haltDeliberations(store) {
  for (const row of store.prepare("SELECT id FROM deliberations WHERE state IN ('answer_1','answer_2','debate','stalled')").all())
    abandon(store,row.id,"halt");
}
export function decide(store,id,{action,candidate_hash,content,fault=null}) {
  return store.commit("deliberation_decided","owner",api => {
    const row=get(api,id);
    if (!row) return {ok:false,reason:"not_found"};
    const target=action === "approve" ? "settled" : "overruled";
    if (!["approve","overrule"].includes(action)) return {ok:false,reason:"invalid_action"};
    if (row.state === target && row.candidate_hash === candidate_hash &&
        (action === "approve" || row.final_answer === String(content ?? "").trim())) return {ok:true,state:target,duplicate:true};
    if (row.state !== "pending_owner") return {ok:false,reason:"not_pending_owner"};
    if (row.candidate_hash !== candidate_hash) return {ok:false,reason:"stale_candidate"};
    const answer=action === "approve" ? row.final_answer : String(content ?? "").trim();
    if (!answer || answer.length > 50000) return {ok:false,reason:"invalid_answer"};
    const hash=contentHash(answer), sanctionId=api.uuid();
    api.prepare(`INSERT INTO sanctions(id,directive_id,content_hash,scopes,decided_by,decided_at,status)
      VALUES(?,?,?,?,'owner',?,'approved')`).run(sanctionId,id,hash,JSON.stringify(["deliberation:"+id]),api.nowIso());
    const gate=assertSanction(store,{content:answer,sanction_id:sanctionId,actor:"owner"});
    if (!gate.ok) throw new Error("sanction validation failed");
    api.prepare("UPDATE sanctions SET used_at=? WHERE id=?").run(api.nowIso(),sanctionId);
    fault?.("after_sanction");
    update(api,row,{state:target,final_answer:answer});
    api.setRef("deliberations",id,{state:target,sanction_id:sanctionId,content_hash:hash});
    return {ok:true,state:target,sanction_id:sanctionId};
  }).result;
}
export function readDeliberation(store,id) {
  const row=get(store,id);
  if (!row) return null;
  return {...row,answers:JSON.parse(row.answers),deliberators:pairOf(row),
    replies:store.prepare("SELECT phase,round,member,response FROM deliberation_messages WHERE deliberation_id=? ORDER BY rowid").all(id)};
}
