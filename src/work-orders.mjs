import {existsSync, statSync} from "node:fs";
import {isAbsolute, resolve, join} from "node:path";
import {homedir} from "node:os";
import {contentHash} from "./sanctions.mjs";
import {seatOf} from "./seats.mjs";
import {connection as cursorConnection} from "./adapters/cursor.mjs";

const ACTIVE=["planning","specialist","implementing","reviewing"];
const TERMINAL=["completed","cancelled"];
const phaseOf=row=>row.state==="stalled"?row.resume_state:row.state;

// Codex writes in its certified sandbox. Cursor and Grok can author a patch
// with read-only tools; Council validates and applies it in the worktree.
const CODING_WORKERS = new Set(["codex"]);

export function grokPatchConnection(env=process.env) {
  if (env.COUNCIL_GROK_PATCH_ENABLED!=="1") return {ok:false,reason:"grok-patch-not-enabled"};
  const model=env.COUNCIL_GROK_MODEL||"";
  if (!model || model==="auto") return {ok:false,reason:"grok-model-required"};
  const exe=join(env.USERPROFILE||homedir(),".grok","bin","grok.exe");
  if (!existsSync(exe)) return {ok:false,reason:"grok-cli-required"};
  return {ok:true,worker:"grok",model,mode:"checked-patch"};
}

export function resolveImplementWorker(worker,model) {
  const selected = String(worker || "").toLowerCase();
  if (!selected) return { ok: false, wait: true, reason: "no-worker-selected" };
  if (selected === "cursor") {
    const c=cursorConnection(process.env,{patchOnly:true});
    if(!c.ok)return {...c,wait:true,selected};
    if(process.env.COUNCIL_TEST_ONLY!=="1"&&process.env.COUNCIL_CURSOR_TRUST_APPROVED!=="1")return {ok:false,wait:true,reason:"cursor-workspace-trust-required",selected};
    if(model!==c.model)return {ok:false,wait:true,reason:"cursor-model-changed",selected};
    return {ok:true,worker:"cursor",model,mode:"checked-patch"};
  }
  if (selected === "grok") {
    const c=grokPatchConnection();
    if(!c.ok)return {...c,wait:true,selected};
    if(model!==c.model)return {ok:false,wait:true,reason:"grok-model-changed",selected};
    return c;
  }
  if (selected === "claude") return { ok: false, wait: true, reason: "claude-review-only", selected };
  if (!CODING_WORKERS.has(selected)) {
    return { ok: false, wait: true, reason: "no-transport", selected };
  }
  return { ok: true, worker: selected };
}

function enterWaitingWorker(api, row, reason, selected) {
  update(api, row, {
    state: "waiting_worker",
    stall_detail: JSON.stringify({
      honest: true,
      reason,
      selected: selected || null,
      message: `Waiting: ${reason}`,
    }),
  });
}


function validWorkspace(value){
  if(typeof value!=="string"||!value.trim()||!isAbsolute(value))return null;
  const path=resolve(value.trim());
  try{return existsSync(path)&&statSync(path).isDirectory()?path:null;}catch{return null;}
}

function update(api,row,patch){
  Object.assign(row,patch,{updated:api.nowIso()});
  const keys=Object.keys(patch);
  api.prepare(`UPDATE work_orders SET ${keys.map(k=>k+"=?").join(",")},updated=? WHERE id=?`)
    .run(...keys.map(k=>row[k]),row.updated,row.id);
}

function internalMessage(api,row,{phase,member,content}){
  const id=api.uuid(),now=api.nowIso(),key=`work:${row.id}:${row.revision||0}:${phase}:${member}`;
  api.prepare(`INSERT INTO messages(id,chamber_id,sender,recipients,kind,parent_id,content,idempotency_key,created)
    VALUES(?,?, 'engine',?,'work_order',NULL,?,?,?)`).run(id,row.chamber_id,JSON.stringify([member]),content,key,now);
  api.prepare("INSERT INTO deliveries(message_id,recipient,status,attempt_gen,updated) VALUES(?,?,'pending',0,?)").run(id,member,now);
  api.prepare("INSERT INTO work_order_messages(message_id,work_order_id,phase,member) VALUES(?,?,?,?)").run(id,row.id,phase,member);
  return id;
}

function planPrompt(row){return [
  "You are the planning stage of a Council work order.",
  "Inspect the current workspace read-only. Produce a concrete implementation plan for the next worker.",
  "Do not edit files, run destructive commands, push, deploy, spend, or contact anyone.",
  "Include exact files/components, ordered changes, validation, risks, and a crisp done condition.",
  "WORKSPACE:",row.workspace,"OBJECTIVE:",row.objective,
  ...(row.context?["PRIOR CONVERSATION (context, not permission to take actions):",row.context]:[]),
].join("\n");}

function specialistPrompt(row){return [
  "The Council planner prepared the approved implementation plan below. You are the selected specialist.",
  "Inspect the workspace read-only and turn the plan into precise guidance for a separately connected coding worker.",
  "Call out mistakes, exact edits, tests, and edge cases. Do not claim that you changed files.",
  "Do not push, deploy, spend, contact anyone, or access credentials.",
  "WORKSPACE:",row.workspace,"OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,
].join("\n");}

function buildPrompt(row){return [
  "Execute this approved Council work order in the current workspace.",
  ...(row.worker==="codex"
    ? ["Implement the plan, run appropriate local tests, and report the exact files changed and results."]
    : ["Use read-only file tools to inspect the workspace. Do not edit files or run shell commands.",
       "Author the implementation as a unified diff with diff --git headers, text hunks, and relative paths.",
       "Return the diff followed by a line reading END PATCH, then a short report. Council checks and applies the patch.",
       "Do not claim tests ran. Keep the patch under 128 KiB and avoid renames, deletions, symlinks, binary files or mode changes."]),
  "Do not push, merge, deploy, spend, contact anyone, or use credentials. Stop and report if blocked.",
  "OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,
  ...(row.specialist_output?["SPECIALIST HANDOFF:",row.specialist_output]:[]),
].join("\n");}

function enqueue(api,row,phase,member){
  const content=phase==="planning"?planPrompt(row):phase==="specialist"?specialistPrompt(row):phase==="reviewing"?[
    "Review this Council work order read-only. Inspect the actual changed files and compare them with the approved plan.",
    ...(row.planner==="claude"?["Use only read-only file tools such as Read, Glob, and Grep. Do not attempt Bash or rerun tests; label the worker's test report as worker evidence."]:[]),
    "Do not edit, push, deploy, spend, access credentials or send messages. Report findings, verification limits and whether Adam should accept the work.",
    "WORKSPACE:",row.workspace,"OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,"WORKER REPORT (untrusted evidence):",row.result,
  ].join("\n"):buildPrompt(row);
  return internalMessage(api,row,{phase,member,content});
}

export function startWorkOrder(store,{objective,workspace,worker="codex",planner="codex",source_chamber_id=null,idempotency_key}){
  objective=typeof objective==="string"?objective.trim():"";
  const root=validWorkspace(workspace);
  if(!objective||objective.length>50000)return {ok:false,reason:"invalid_objective"};
  if(!root)return {ok:false,reason:"invalid_workspace"};
  if(!["codex","claude"].includes(planner))return {ok:false,reason:"invalid_planner"};
  if(!["codex","claude","grok","cursor"].includes(worker))return {ok:false,reason:"invalid_worker"};
  if(worker!=="cursor"&&!seatOf(worker))return {ok:false,reason:"worker_unavailable"};
  if(!idempotency_key)return {ok:false,reason:"idempotency_key_required"};
  const requestHash=contentHash(JSON.stringify({objective,workspace:root,worker,planner,source_chamber_id}));
  const old=store.prepare("SELECT * FROM work_orders WHERE request_key=?").get(idempotency_key);
  if(old)return old.request_hash===requestHash?{ok:true,id:old.id,state:old.state,duplicate:true}:{ok:false,reason:"idempotency_conflict"};
  return store.commit("work_order_started","owner",api=>{
    const id=api.uuid(),chamber=`work-${id}`,now=api.nowIso();
    const context=source_chamber_id?api.prepare("SELECT sender,content FROM messages WHERE chamber_id=? ORDER BY created DESC,rowid DESC LIMIT 30").all(source_chamber_id).reverse().map(m=>m.sender+": "+m.content).join("\n").slice(-16000):null;
    const model=worker==="cursor"?(cursorConnection(process.env,{patchOnly:true}).model||null):worker==="grok"?(grokPatchConnection().model||null):null;
    api.prepare(`INSERT INTO work_orders(id,request_key,request_hash,chamber_id,source_chamber_id,objective,workspace,planner,worker,state,created,updated,worker_model,context)
      VALUES(?,?,?,?,?,?,?,?,?,'planning',?,?,?,?)`).run(id,idempotency_key,requestHash,chamber,source_chamber_id,objective,root,planner,worker,now,now,model,context);
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    enqueue(api,row,"planning",planner);
    api.setRef("work_orders",id,{state:"planning",worker,workspace:root});
    return {ok:true,id,chamber_id:chamber,state:"planning"};
  }).result;
}

export function workTaskFor(store,messageId){
  return store.prepare(`SELECT wm.*,w.state,w.resume_state,w.workspace,w.worker,w.worker_model,w.plan_hash FROM work_order_messages wm
    JOIN work_orders w ON w.id=wm.work_order_id WHERE wm.message_id=?`).get(messageId)||null;
}

export function canDispatchWork(store,messageId,member){
  const task=workTaskFor(store,messageId);if(!task)return false;
  const row=store.prepare("SELECT * FROM work_orders WHERE id=?").get(task.work_order_id);
  if(task.phase==="implementing"&&!resolveImplementWorker(row.worker,row.worker_model).ok)return false;
  return ACTIVE.includes(row.state)&&task.member===member&&task.response==null&&phaseOf(row)===task.phase;
}

export function completeWorkReply(store,{message,delivery,gen,member,text}){
  return store.commit("work_order_reply",member,api=>{
    const task=api.prepare("SELECT * FROM work_order_messages WHERE message_id=?").get(message.id);
    const row=task&&api.prepare("SELECT * FROM work_orders WHERE id=?").get(task.work_order_id);
    const lease=api.prepare("SELECT * FROM deliveries WHERE id=?").get(delivery.id);
    if(!row||!ACTIVE.includes(row.state)||task.member!==member||task.response!=null||phaseOf(row)!==task.phase||lease?.attempt_gen!==gen||lease?.status!=="leased"||lease?.message_id!==message.id||lease?.recipient!==member)
      return {ok:false,reason:"stale_work_result"};
    if(task.phase==="implementing"&&!resolveImplementWorker(row.worker,row.worker_model).ok)return {ok:false,reason:"worker_not_writable"};
    api.prepare("UPDATE deliveries SET status='answered',lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),delivery.id);
    api.prepare("UPDATE work_order_messages SET response=? WHERE message_id=?").run(text,message.id);
    if(task.phase==="planning")update(api,row,{plan:text,plan_hash:contentHash(text),state:"awaiting_approval"});
    else if(task.phase==="specialist"){
      update(api,row,{specialist_output:text});
      const routed=resolveImplementWorker(row.worker,row.worker_model);
      if(!routed.ok){
        enterWaitingWorker(api,row,routed.reason,routed.selected);
      }else{
        update(api,row,{state:"implementing"});
        enqueue(api,row,"implementing",routed.worker);
      }
    }else if(task.phase==="implementing"){
      update(api,row,{result:text,state:"reviewing"});enqueue(api,row,"reviewing",row.planner);
    }else update(api,row,{review:text,state:"awaiting_acceptance"});
    api.setRef("work_orders",row.id,{state:row.state,phase:task.phase,member});
    return {ok:true,state:row.state,id:row.id};
  }).result;
}

export function approveWorkPlan(store,id,{plan_hash}){
  return store.commit("work_plan_approved","owner",api=>{
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    if(!row)return {ok:false,reason:"not_found"};
    if(row.state!=="awaiting_approval")return {ok:false,reason:"not_awaiting_approval"};
    if(row.plan_hash!==plan_hash)return {ok:false,reason:"stale_plan"};
    const routed=resolveImplementWorker(row.worker,row.worker_model);
    if(!routed.ok){
      enterWaitingWorker(api,row,routed.reason,routed.selected);
    }else{
      update(api,row,{state:"implementing"});enqueue(api,row,"implementing",routed.worker);
    }
    api.setRef("work_orders",id,{state:row.state,worker:row.worker,plan_hash});
    return {ok:true,state:row.state};
  }).result;
}

export function stallWork(store,{message,delivery,gen,member,reason,result}){
  return store.commit("work_order_stalled",member,api=>{
    const task=api.prepare("SELECT * FROM work_order_messages WHERE message_id=?").get(message.id);
    const row=task&&api.prepare("SELECT * FROM work_orders WHERE id=?").get(task.work_order_id);
    const lease=api.prepare("SELECT * FROM deliveries WHERE id=?").get(delivery.id);
    if(!row||!ACTIVE.includes(row.state)||task.member!==member||task.response!=null||phaseOf(row)!==task.phase||lease?.attempt_gen!==gen||lease?.status!=="leased"||lease?.message_id!==message.id||lease?.recipient!==member)return {ok:false,reason:"stale_failure"};
    api.prepare("UPDATE deliveries SET status='pending',lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),delivery.id);
    update(api,row,{state:"stalled",resume_state:phaseOf(row),stall_detail:JSON.stringify({member,reason,stderr:String(result?.stderr||"").slice(0,1000)})});
    api.setRef("work_orders",row.id,{state:"stalled",phase:row.resume_state,member,reason});
    return {ok:true,state:"stalled"};
  }).result;
}

export function resumeWork(store,id){
  return store.commit("work_order_resumed","owner",api=>{
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    if(!row||row.state!=="stalled")return {ok:false,reason:"not_stalled"};
    update(api,row,{state:row.resume_state,resume_state:null,stall_detail:null});
    api.setRef("work_orders",id,{state:row.state});return {ok:true,state:row.state};
  }).result;
}

export function cancelWork(store,id,reason="cancelled"){
  return store.commit("work_order_cancelled","owner",api=>{
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    if(!row||TERMINAL.includes(row.state))return {ok:false,reason:"not_cancellable"};
    update(api,row,{state:"cancelled",stall_detail:reason});
    api.prepare(`UPDATE deliveries SET status='cancelled',attempt_gen=attempt_gen+1,lease_until=NULL,updated=?
      WHERE message_id IN (SELECT message_id FROM work_order_messages WHERE work_order_id=?) AND status NOT IN ('answered','cancelled')`).run(api.nowIso(),id);
    api.setRef("work_orders",id,{state:"cancelled"});return {ok:true,state:"cancelled"};
  }).result;
}

export function haltWorkOrders(store){
  for(const row of store.prepare("SELECT id FROM work_orders WHERE state NOT IN ('completed','cancelled')").all())cancelWork(store,row.id,"halted");
}

export function acceptWork(store,id,{plan_hash}){
  return store.commit("work_accepted","owner",api=>{
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    if(!row||row.state!=="awaiting_acceptance")return {ok:false,reason:"not_awaiting_acceptance"};
    if(plan_hash!==row.plan_hash)return {ok:false,reason:"stale_plan"};
    update(api,row,{state:"completed"});api.setRef("work_orders",id,{state:"completed"});return {ok:true,state:"completed"};
  }).result;
}

export function reviseWork(store,id,{feedback,idempotency_key}){
  if(typeof feedback!=="string"||!feedback.trim()||feedback.length>20000||typeof idempotency_key!=="string"||!idempotency_key)return {ok:false,reason:"revision_input_required"};
  return store.commit("work_revision_requested","owner",api=>{
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    if(!row)return {ok:false,reason:"not_found"};
    const hash=contentHash(feedback),old=api.prepare("SELECT * FROM work_order_revisions WHERE work_order_id=? AND request_key=?").get(id,idempotency_key);
    if(old)return old.feedback_hash===hash?{ok:true,duplicate:true,state:row.state}:{ok:false,reason:"idempotency_conflict"};
    if(!["awaiting_approval","awaiting_acceptance","handoff_ready","waiting_worker"].includes(row.state))return {ok:false,reason:"not_revisable"};
    const revision=row.revision+1;
    const context=[row.context||"","PREVIOUS PLAN:",row.plan||"","WORKER REPORT:",row.result||"","REVIEW:",row.review||"","OWNER FEEDBACK:",feedback].join("\n").slice(-32000);
    api.prepare("INSERT INTO work_order_revisions VALUES(?,?,?,?)").run(id,idempotency_key,hash,revision);
    update(api,row,{revision,context,plan:null,plan_hash:null,result:null,review:null,specialist_output:null,stall_detail:null,resume_state:null,state:"planning",worker_model:row.worker==="cursor"?(cursorConnection(process.env,{patchOnly:true}).model||null):row.worker==="grok"?(grokPatchConnection().model||null):null});
    enqueue(api,row,"planning",row.planner);api.setRef("work_orders",id,{revision,state:"planning"});return {ok:true,state:"planning"};
  }).result;
}

export function readWorkOrder(store,id){
  const row=store.prepare("SELECT * FROM work_orders WHERE id=?").get(id);if(!row)return null;
  return {...row,messages:store.prepare("SELECT phase,member,response FROM work_order_messages WHERE work_order_id=? ORDER BY rowid").all(id),
    handoff:["handoff_ready","waiting_worker"].includes(row.state)&&row.plan?["WORKER HANDOFF — not dispatched","WORK ORDER: "+row.id,"PLAN HASH: "+row.plan_hash,"WORKSPACE: "+row.workspace,"OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,...(row.specialist_output?["SPECIALIST GUIDANCE:",row.specialist_output]:[]),"Return worker/model, branch/commit, changed files, commands/results and remaining gates. Do not push, deploy, spend or use credentials."].join("\n\n"):null};
}

// Existing databases may contain an implementing job queued by an older build.
// Fence its delivery before the dispatcher can spend a run on a read-only worker.
export function recoverUnsupportedWork(store){
  for(const saved of store.prepare("SELECT * FROM work_orders WHERE state='implementing' OR (state='stalled' AND resume_state='implementing')").all()){
    const route=resolveImplementWorker(saved.worker,saved.worker_model);
    if(route.ok){
      const attempted=store.prepare("SELECT d.id FROM deliveries d JOIN work_order_messages wm ON wm.message_id=d.message_id WHERE wm.work_order_id=? AND wm.phase='implementing' AND wm.response IS NULL AND d.attempt_gen>0 LIMIT 1").get(saved.id);
      if(saved.state==="implementing"&&attempted)store.commit("work_interrupted","engine",api=>{
        update(api,saved,{state:"stalled",resume_state:"implementing",stall_detail:"Coding was interrupted. Inspect the workspace and confirm the previous worker has stopped before choosing Resume."});
        api.prepare("UPDATE deliveries SET status='pending',attempt_gen=attempt_gen+1,lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),attempted.id);
        api.setRef("work_orders",saved.id,{state:"stalled",reason:"interrupted_coding"});
      });
      continue;
    }
    store.commit("work_worker_unavailable","engine",api=>{
      enterWaitingWorker(api,saved,route.reason,route.selected);
      api.prepare("UPDATE deliveries SET status='cancelled',attempt_gen=attempt_gen+1,lease_until=NULL,updated=? WHERE message_id IN (SELECT message_id FROM work_order_messages WHERE work_order_id=? AND phase='implementing') AND status NOT IN ('answered','cancelled')").run(api.nowIso(),saved.id);
      api.setRef("work_orders",saved.id,{state:"waiting_worker",reason:route.reason});
    });
  }
}
