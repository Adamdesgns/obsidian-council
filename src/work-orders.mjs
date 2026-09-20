import {existsSync, statSync} from "node:fs";
import {isAbsolute, resolve} from "node:path";
import {contentHash} from "./sanctions.mjs";
import {seatOf} from "./seats.mjs";

const ACTIVE=["planning","specialist","implementing"];
const TERMINAL=["completed","cancelled"];
const phaseOf=row=>row.state==="stalled"?row.resume_state:row.state;

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
  const id=api.uuid(),now=api.nowIso(),key=`work:${row.id}:${phase}:${member}`;
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
].join("\n");}

function specialistPrompt(row){return [
  "Codex prepared the approved implementation plan below. You are the selected specialist.",
  "Inspect the workspace read-only and turn the plan into precise implementation guidance for the sandboxed Codex builder.",
  "Call out mistakes, exact edits, tests, and edge cases. Do not claim that you changed files.",
  "Do not push, deploy, spend, contact anyone, or access credentials.",
  "WORKSPACE:",row.workspace,"OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,
].join("\n");}

function buildPrompt(row){return [
  "Execute this approved Council work order in the current workspace.",
  "Implement the plan, run appropriate local tests, and report the exact files changed and results.",
  "Do not push, merge, deploy, spend, contact anyone, or use credentials. Stop and report if blocked.",
  "OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan,
  ...(row.specialist_output?["SPECIALIST HANDOFF:",row.specialist_output]:[]),
].join("\n");}

function enqueue(api,row,phase,member){
  const content=phase==="planning"?planPrompt(row):phase==="specialist"?specialistPrompt(row):buildPrompt(row);
  return internalMessage(api,row,{phase,member,content});
}

export function startWorkOrder(store,{objective,workspace,worker="codex",source_chamber_id=null,idempotency_key}){
  objective=typeof objective==="string"?objective.trim():"";
  const root=validWorkspace(workspace);
  if(!objective||objective.length>50000)return {ok:false,reason:"invalid_objective"};
  if(!root)return {ok:false,reason:"invalid_workspace"};
  if(!["codex","claude","grok","cursor"].includes(worker))return {ok:false,reason:"invalid_worker"};
  if(worker!=="cursor"&&!seatOf(worker))return {ok:false,reason:"worker_unavailable"};
  if(!idempotency_key)return {ok:false,reason:"idempotency_key_required"};
  const requestHash=contentHash(JSON.stringify({objective,workspace:root,worker,source_chamber_id}));
  const old=store.prepare("SELECT * FROM work_orders WHERE request_key=?").get(idempotency_key);
  if(old)return old.request_hash===requestHash?{ok:true,id:old.id,state:old.state,duplicate:true}:{ok:false,reason:"idempotency_conflict"};
  return store.commit("work_order_started","owner",api=>{
    const id=api.uuid(),chamber=`work-${id}`,now=api.nowIso();
    api.prepare(`INSERT INTO work_orders(id,request_key,request_hash,chamber_id,source_chamber_id,objective,workspace,planner,worker,state,created,updated)
      VALUES(?,?,?,?,?,?,?,'codex',?,'planning',?,?)`).run(id,idempotency_key,requestHash,chamber,source_chamber_id,objective,root,worker,now,now);
    const row=api.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
    enqueue(api,row,"planning","codex");
    api.setRef("work_orders",id,{state:"planning",worker,workspace:root});
    return {ok:true,id,chamber_id:chamber,state:"planning"};
  }).result;
}

export function workTaskFor(store,messageId){
  return store.prepare(`SELECT wm.*,w.state,w.resume_state,w.workspace,w.worker FROM work_order_messages wm
    JOIN work_orders w ON w.id=wm.work_order_id WHERE wm.message_id=?`).get(messageId)||null;
}

export function canDispatchWork(store,messageId,member){
  const task=workTaskFor(store,messageId);if(!task)return false;
  const row=store.prepare("SELECT * FROM work_orders WHERE id=?").get(task.work_order_id);
  return ACTIVE.includes(row.state)&&task.member===member&&task.response==null&&phaseOf(row)===task.phase;
}

export function completeWorkReply(store,{message,delivery,gen,member,text}){
  return store.commit("work_order_reply",member,api=>{
    const task=api.prepare("SELECT * FROM work_order_messages WHERE message_id=?").get(message.id);
    const row=task&&api.prepare("SELECT * FROM work_orders WHERE id=?").get(task.work_order_id);
    const lease=api.prepare("SELECT * FROM deliveries WHERE id=?").get(delivery.id);
    if(!row||TERMINAL.includes(row.state)||task.member!==member||task.response!=null||phaseOf(row)!==task.phase||lease?.attempt_gen!==gen||lease?.status!=="leased")
      return {ok:false,reason:"stale_work_result"};
    api.prepare("UPDATE deliveries SET status='answered',lease_until=NULL,updated=? WHERE id=?").run(api.nowIso(),delivery.id);
    api.prepare("UPDATE work_order_messages SET response=? WHERE message_id=?").run(text,message.id);
    if(task.phase==="planning")update(api,row,{plan:text,plan_hash:contentHash(text),state:"awaiting_approval"});
    else if(task.phase==="specialist"){
      update(api,row,{specialist_output:text,state:"implementing"});enqueue(api,row,"implementing","codex");
    }else update(api,row,{result:text,state:"completed"});
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
    if(row.worker==="cursor"){
      update(api,row,{state:"handoff_ready"});
    }else if(row.worker==="codex"){
      update(api,row,{state:"implementing"});enqueue(api,row,"implementing","codex");
    }else{
      update(api,row,{state:"specialist"});enqueue(api,row,"specialist",row.worker);
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
    if(!row||TERMINAL.includes(row.state)||lease?.attempt_gen!==gen)return {ok:false,reason:"stale_failure"};
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
  for(const row of store.prepare("SELECT id FROM work_orders WHERE state IN ('planning','specialist','implementing','stalled','awaiting_approval')").all())cancelWork(store,row.id,"halted");
}

export function readWorkOrder(store,id){
  const row=store.prepare("SELECT * FROM work_orders WHERE id=?").get(id);if(!row)return null;
  return {...row,messages:store.prepare("SELECT phase,member,response FROM work_order_messages WHERE work_order_id=? ORDER BY rowid").all(id),
    handoff:row.worker==="cursor"&&row.plan?["CURSOR HANDOFF","WORKSPACE: "+row.workspace,"OBJECTIVE:",row.objective,"APPROVED PLAN:",row.plan].join("\n\n"):null};
}
