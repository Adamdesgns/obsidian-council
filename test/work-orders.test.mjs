import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore} from "../src/store.mjs";
import {createOutbox} from "../src/outbox.mjs";
import {startWorkOrder,readWorkOrder,workTaskFor,canDispatchWork,completeWorkReply,approveWorkPlan,stallWork,resumeWork,cancelWork,haltWorkOrders,recoverUnsupportedWork,acceptWork,reviseWork} from "../src/work-orders.mjs";
import {startCouncil} from "../src/council.mjs";

test("restart pauses an attempted coding run instead of automatically editing twice",t=>{
  configuredCursor(t);const c=fixture(t),a=startWorkOrder(c.store,{objective:"Restart proof",workspace:c.workspace,worker:"cursor",idempotency_key:"restart"});
  reply(c,a.id,"codex","Plan");const row=readWorkOrder(c.store,a.id);
  approveWorkPlan(c.store,row.id,{plan_hash:row.plan_hash});const lease=claim(c,row.id,"cursor");
  recoverUnsupportedWork(c.store);
  assert.equal(readWorkOrder(c.store,row.id).state,"stalled");
  assert.equal(canDispatchWork(c.store,lease.message.id,"cursor"),false);
  assert.equal(completeWorkReply(c.store,{...lease,member:"cursor",text:"late completion"}).ok,false);
  assert.equal(resumeWork(c.store,row.id).state,"implementing");
  assert.equal(canDispatchWork(c.store,lease.message.id,"cursor"),true);
});

test("old Grok implementation queues recover to a visible waiting state",t=>{
  const c=fixture(t),a=startWorkOrder(c.store,{objective:"Legacy",workspace:c.workspace,worker:"grok",idempotency_key:"legacy"});
  c.store.prepare("UPDATE work_orders SET state='implementing' WHERE id=?").run(a.id);
  recoverUnsupportedWork(c.store);
  assert.equal(readWorkOrder(c.store,a.id).state,"waiting_worker");
  assert.match(readWorkOrder(c.store,a.id).stall_detail,/grok-patch-not-enabled/);
});

function configuredCursor(t){
  const keys=["COUNCIL_CURSOR_ENABLED","COUNCIL_CURSOR_EXE","COUNCIL_CURSOR_MODEL","COUNCIL_CURSOR_ENTRYPOINT","COUNCIL_TEST_ONLY"],before=keys.map(k=>process.env[k]);
  process.env.COUNCIL_TEST_ONLY="1";
  delete process.env.COUNCIL_CURSOR_ENTRYPOINT;
  process.env.COUNCIL_CURSOR_ENABLED="1";process.env.COUNCIL_CURSOR_EXE=process.execPath;process.env.COUNCIL_CURSOR_MODEL="fixture-worker";
  t.after(()=>keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]));
}

test("either planner carries conversation through coding, review, and exact owner acceptance",t=>{
  for(const planner of ["codex","claude"]){
    const c=fixture(t);
    c.outbox.send({sender:"owner",recipients:[planner],chamber_id:"chat",content:"Keep the button blue",idempotency_key:"chat"});
    const started=startWorkOrder(c.store,{objective:"Implement agreed button",workspace:c.workspace,planner,worker:"codex",source_chamber_id:"chat",idempotency_key:planner});
    let lease=claim(c,started.id,planner);assert.match(lease.message.content,/Keep the button blue/);
    completeWorkReply(c.store,{...lease,member:planner,text:"Exact blue-button plan"});
    let row=readWorkOrder(c.store,started.id);
    assert.equal(row.planner,planner);assert.equal(row.worker,"codex");
    assert.equal(approveWorkPlan(c.store,row.id,{plan_hash:row.plan_hash}).state,"implementing");
    assert.equal(approveWorkPlan(c.store,row.id,{plan_hash:row.plan_hash}).ok,false);
    const build=claim(c,row.id,"codex");assert.equal(canDispatchWork(c.store,build.message.id,"codex"),true);
    completeWorkReply(c.store,{...build,member:"codex",text:"Changed button.js. Tests: 2 passed."});
    assert.equal(readWorkOrder(c.store,row.id).state,"reviewing");
    assert.equal(acceptWork(c.store,row.id,{plan_hash:row.plan_hash}).ok,false);
    lease=claim(c,row.id,planner);assert.match(lease.message.content,/Changed button.js/);
    completeWorkReply(c.store,{...lease,member:planner,text:"Reviewed actual button.js; tests corroborated"});
    assert.equal(readWorkOrder(c.store,row.id).state,"awaiting_acceptance");
    assert.equal(acceptWork(c.store,row.id,{plan_hash:"wrong"}).reason,"stale_plan");
    assert.equal(acceptWork(c.store,row.id,{plan_hash:row.plan_hash}).state,"completed");
    assert.equal(c.store.verifyChain().ok,true);
  }
});

test("feedback is deduplicated and requires approval of the revised plan",t=>{
  const c=fixture(t),a=startWorkOrder(c.store,{objective:"Build it",workspace:c.workspace,planner:"claude",idempotency_key:"revision"});
  reply(c,a.id,"claude","Plan A");const previous=readWorkOrder(c.store,a.id).plan_hash;
  const request={feedback:"Use a blue button",idempotency_key:"feedback-1"};
  assert.equal(reviseWork(c.store,a.id,request).state,"planning");
  assert.equal(reviseWork(c.store,a.id,request).duplicate,true);
  assert.equal(reviseWork(c.store,a.id,{...request,feedback:"different"}).reason,"idempotency_conflict");
  reply(c,a.id,"claude","Plan B");
  assert.equal(approveWorkPlan(c.store,a.id,{plan_hash:previous}).reason,"stale_plan");
  assert.equal(readWorkOrder(c.store,a.id).revision,1);
});

test("HALT cancels undispatched packets and late results cannot resurrect cancelled work",t=>{
  const c=fixture(t),a=startWorkOrder(c.store,{objective:"Packet",workspace:c.workspace,idempotency_key:"halt"});
  reply(c,a.id,"codex","Plan");let row=readWorkOrder(c.store,a.id);
  approveWorkPlan(c.store,row.id,{plan_hash:row.plan_hash});assert.equal(readWorkOrder(c.store,row.id).state,"implementing");
  haltWorkOrders(c.store);assert.equal(readWorkOrder(c.store,row.id).state,"cancelled");
  assert.equal(readWorkOrder(c.store,row.id).handoff,null);
  const b=startWorkOrder(c.store,{objective:"Late",workspace:c.workspace,idempotency_key:"late"});
  const lease=claim(c,b.id,"codex");cancelWork(c.store,b.id);
  assert.equal(completeWorkReply(c.store,{...lease,member:"codex",text:"late"}).ok,false);
  assert.equal(stallWork(c.store,{...lease,member:"codex",reason:"late"}).ok,false);
});

test("a model change cannot silently dispatch approved coding to another model",t=>{
  configuredCursor(t);const c=fixture(t),a=startWorkOrder(c.store,{objective:"Pinned",workspace:c.workspace,worker:"cursor",idempotency_key:"pinned"});
  reply(c,a.id,"codex","Plan");const row=readWorkOrder(c.store,a.id);
  process.env.COUNCIL_CURSOR_MODEL="different";
  assert.equal(approveWorkPlan(c.store,row.id,{plan_hash:row.plan_hash}).state,"waiting_worker");
  assert.match(readWorkOrder(c.store,row.id).stall_detail,/cursor-model-changed/);
});

test("HTTP fake Codex worker automatically returns to the chosen planner for review",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-loop-")),workspace=mkdtempSync(join(tmpdir(),"council-loop-ws-"));
  const c=await startCouncil({home,port:0,useFake:true,tickMs:20,log:()=>{},
    limits:{daily_ceiling:{codex:100,claude:100,grok:100,cursor:100},timeout_ms:{fake:3000}},
    scriptedReply:(member,msg)=>msg.content.includes("planning stage")?"Plan for fixture":msg.content.includes("Review this Council work order")?"Planner reviewed fixture evidence":"Fixture worker report"});
  t.after(async()=>{await c.close();rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});});
  const req=async(path,body,token=c.api.tokens.owner)=>{const r=await fetch(c.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const until=async state=>{const end=Date.now()+5000;while(Date.now()<end){const row=readWorkOrder(c.api.store,id);if(row.state===state)return row;await new Promise(r=>setTimeout(r,20));}throw Error("timeout waiting for "+state);};
  const start=await req("/owner/delegate",{objective:"Build fixture",workspace,planner:"claude",worker:"codex",idempotency_key:"loop"});
  const id=start.body.id;assert.equal(start.status,200);let row=await until("awaiting_approval");
  assert.equal((await req("/owner/work-order/"+id+"/approve",{plan_hash:row.plan_hash},c.api.tokens.members.codex)).status,403);
  assert.equal((await req("/owner/work-order/"+id+"/approve",{plan_hash:row.plan_hash})).status,200);
  row=await until("awaiting_acceptance");assert.equal(row.review,"Planner reviewed fixture evidence");
  assert.deepEqual(c.api.store.prepare("SELECT member FROM runs ORDER BY started").all().map(r=>r.member),["claude","codex","claude"]);
  assert.equal((await req("/owner/work-order/"+id+"/accept",{plan_hash:row.plan_hash})).body.state,"completed");
});

test("fake Grok authors a checked patch and returns to Codex review",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-grok-loop-"));
  const workspace=mkdtempSync(join(tmpdir(),"council-grok-ws-"));
  const profile=mkdtempSync(join(tmpdir(),"council-grok-profile-"));
  mkdirSync(join(profile,".grok","bin"),{recursive:true});
  writeFileSync(join(profile,".grok","bin","grok.exe"),"fixture");
  writeFileSync(join(workspace,"answer.mjs"),"export const answer = 1;\n");
  const keys=["COUNCIL_GROK_PATCH_ENABLED","COUNCIL_GROK_MODEL","USERPROFILE"],before=keys.map(k=>process.env[k]);
  process.env.COUNCIL_GROK_PATCH_ENABLED="1";process.env.COUNCIL_GROK_MODEL="fixture-fast";process.env.USERPROFILE=profile;
  const diff=["diff --git a/answer.mjs b/answer.mjs","--- a/answer.mjs","+++ b/answer.mjs",
    "@@ -1 +1 @@","-export const answer = 1;","+export const answer = 2;","END PATCH","Made the requested change."].join("\n");
  const c=await startCouncil({home,port:0,useFake:true,tickMs:20,log:()=>{},
    limits:{daily_ceiling:{codex:100,claude:100,grok:100,cursor:100},timeout_ms:{fake:3000}},
    scriptedReply:(member,msg)=>member==="grok"?diff:msg.content.includes("planning stage")?"Exact plan":"Review confirms answer is 2."});
  t.after(async()=>{await c.close();keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]);
    for(const path of [home,workspace,profile])rmSync(path,{recursive:true,force:true});});
  const req=async(path,body)=>{const r=await fetch(c.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.api.tokens.owner},body:body===undefined?undefined:JSON.stringify(body)});return r.json();};
  const started=await req("/owner/delegate",{objective:"Change answer to 2",workspace,planner:"codex",worker:"grok",idempotency_key:"grok-loop"});
  const until=async state=>{const end=Date.now()+5000;while(Date.now()<end){const row=readWorkOrder(c.api.store,started.id);if(row.state===state)return row;await new Promise(r=>setTimeout(r,20));}throw Error("timeout waiting for "+state);};
  let row=await until("awaiting_approval");
  assert.equal((await req("/owner/work-order/"+row.id+"/approve",{plan_hash:row.plan_hash})).state,"implementing");
  row=await until("awaiting_acceptance");
  assert.match(row.result,/checked text patch/);
  assert.equal(readFileSync(join(workspace,"answer.mjs"),"utf8").replace(/\r\n/g,"\n"),"export const answer = 2;\n");
  assert.deepEqual(c.api.store.prepare("SELECT member FROM runs ORDER BY started").all().map(r=>r.member),["codex","grok","codex"]);
});

test("fake Cursor authors a checked patch and returns to Claude review",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-cursor-loop-"));
  const workspace=mkdtempSync(join(tmpdir(),"council-cursor-ws-"));
  writeFileSync(join(workspace,"answer.mjs"),"export const answer = 1;\n");
  const keys=["COUNCIL_CURSOR_ENABLED","COUNCIL_CURSOR_EXE","COUNCIL_CURSOR_ENTRYPOINT","COUNCIL_CURSOR_MODEL"],before=keys.map(k=>process.env[k]);
  process.env.COUNCIL_CURSOR_ENABLED="1";process.env.COUNCIL_CURSOR_EXE=process.execPath;
  delete process.env.COUNCIL_CURSOR_ENTRYPOINT;process.env.COUNCIL_CURSOR_MODEL="fixture-composer";
  const diff=["diff --git a/answer.mjs b/answer.mjs","--- a/answer.mjs","+++ b/answer.mjs",
    "@@ -1 +1 @@","-export const answer = 1;","+export const answer = 2;","END PATCH"].join("\n");
  const c=await startCouncil({home,port:0,useFake:true,tickMs:20,log:()=>{},
    limits:{daily_ceiling:{codex:100,claude:100,grok:100,cursor:100},timeout_ms:{fake:3000}},
    scriptedReply:(member,msg)=>member==="cursor"?diff:msg.content.includes("planning stage")?"Exact plan":"Review confirms answer is 2."});
  t.after(async()=>{await c.close();keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]);
    for(const path of [home,workspace])rmSync(path,{recursive:true,force:true});});
  const req=async(path,body)=>{const r=await fetch(c.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.api.tokens.owner},body:body===undefined?undefined:JSON.stringify(body)});return r.json();};
  const started=await req("/owner/delegate",{objective:"Change answer to 2",workspace,planner:"claude",worker:"cursor",idempotency_key:"cursor-loop"});
  const until=async state=>{const end=Date.now()+5000;while(Date.now()<end){const row=readWorkOrder(c.api.store,started.id);if(row.state===state)return row;await new Promise(r=>setTimeout(r,20));}throw Error("timeout waiting for "+state);};
  let row=await until("awaiting_approval");
  assert.equal((await req("/owner/work-order/"+row.id+"/approve",{plan_hash:row.plan_hash})).state,"implementing");
  row=await until("awaiting_acceptance");
  assert.match(row.result,/checked text patch/);
  assert.equal(readFileSync(join(workspace,"answer.mjs"),"utf8").replace(/\r\n/g,"\n"),"export const answer = 2;\n");
  assert.deepEqual(c.api.store.prepare("SELECT member FROM runs ORDER BY started").all().map(r=>r.member),["claude","cursor","claude"]);
});

function fixture(t){
  // Each test owns both its database and writable target.
  const home=mkdtempSync(join(tmpdir(),"council-work-home-")),workspace=mkdtempSync(join(tmpdir(),"council-workspace-"));
  const store=openStore({home}),outbox=createOutbox(store);
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});});
  return {home,workspace,store,outbox};
}
function claim(c,id,member){
  const d=c.store.prepare(`SELECT d.id FROM deliveries d JOIN work_order_messages wm ON wm.message_id=d.message_id
    WHERE wm.work_order_id=? AND wm.member=? AND wm.response IS NULL ORDER BY d.id DESC LIMIT 1`).get(id,member);
  return d&&c.outbox.claim(member,{deliveryId:d.id});
}
function reply(c,id,member,text){const lease=claim(c,id,member);assert.ok(lease);return completeWorkReply(c.store,{...lease,member,text});}

test("Codex plan is exact-approved, implemented by Codex, and returned for review",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Build the feature",workspace:c.workspace,worker:"codex",idempotency_key:"one"});
  assert.equal(start.ok,true);
  assert.equal(startWorkOrder(c.store,{objective:"Build the feature",workspace:c.workspace,worker:"codex",idempotency_key:"one"}).duplicate,true);
  const first=claim(c,start.id,"codex");
  assert.equal(workTaskFor(c.store,first.message.id).phase,"planning");
  assert.equal(canDispatchWork(c.store,first.message.id,"codex"),true);
  completeWorkReply(c.store,{...first,member:"codex",text:"Plan A"});
  let row=readWorkOrder(c.store,start.id);assert.equal(row.state,"awaiting_approval");
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:"wrong"}).reason,"stale_plan");
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"implementing");
  reply(c,start.id,"codex","Codex implementation report");
  row=readWorkOrder(c.store,start.id);
  assert.equal(row.state,"reviewing");
  assert.equal(row.result,"Codex implementation report");
  assert.equal(c.store.verifyChain().ok,true);
});

test("read-only Grok cannot be dispatched as a coding worker",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Build via grok",workspace:c.workspace,worker:"grok",idempotency_key:"grok-build"});
  assert.equal(start.ok,true);
  reply(c,start.id,"codex","Plan for grok");
  let row=readWorkOrder(c.store,start.id);
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"waiting_worker");
  assert.equal(claim(c,start.id,"grok"),undefined);
  assert.match(readWorkOrder(c.store,start.id).stall_detail,/grok-patch-not-enabled/);
});

test("worker=codex starts implementing after exact plan approval",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Build it",workspace:c.workspace,worker:"codex",idempotency_key:"codex-build"});
  reply(c,start.id,"codex","A plan");
  const row=readWorkOrder(c.store,start.id);
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"implementing");
  assert.ok(claim(c,start.id,"codex"));
});

test("failures pause without retry storms; Cursor route produces an honest external packet",t=>{
  const c=fixture(t),a=startWorkOrder(c.store,{objective:"Plan it",workspace:c.workspace,worker:"cursor",idempotency_key:"cursor"});
  const lease=claim(c,a.id,"codex");
  stallWork(c.store,{...lease,member:"codex",reason:"auth",result:{stderr:"login needed"}});
  assert.equal(readWorkOrder(c.store,a.id).state,"stalled");
  assert.equal(resumeWork(c.store,a.id).state,"planning");
  reply(c,a.id,"codex","Cursor-ready plan");
  const row=readWorkOrder(c.store,a.id);approveWorkPlan(c.store,a.id,{plan_hash:row.plan_hash});
  const done=readWorkOrder(c.store,a.id);assert.equal(done.state,"waiting_worker");assert.match(done.handoff,/Cursor-ready plan/);
});

test("HTTP delegation runs Claude plan, Codex coding, and Claude review",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-work-http-")),workspace=mkdtempSync(join(tmpdir(),"council-work-http-ws-"));
  const limits={daily_ceiling:{codex:100,claude:100,grok:100},timeout_ms:{fake:3000},dispatcher:{tick_ms:20,max_member_hops:2,max_auto_replies_per_owner_turn:4}};
  const response=(member,msg)=>msg.content.includes("planning stage")?"Exact plan":msg.content.includes("Review this Council work order")?"Review complete":"Build complete";
  const c=await startCouncil({home,port:0,useFake:true,limits,tickMs:20,scriptedReply:response,log:()=>{}});
  t.after(async()=>{await c.close();rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});});
  const req=async(path,body)=>{const r=await fetch(c.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.api.tokens.owner},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const started=await req("/owner/delegate",{objective:"Build it",workspace,planner:"claude",worker:"codex",idempotency_key:"http"});assert.equal(started.status,200);
  const until=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const r=fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw Error("timeout");};
  let row=await until(()=>{const r=readWorkOrder(c.api.store,started.body.id);return r.state==="awaiting_approval"&&r;});
  assert.equal((await req(`/owner/work-order/${row.id}/approve`,{plan_hash:row.plan_hash})).status,200);
  row=await until(()=>{const r=readWorkOrder(c.api.store,started.body.id);return r.state==="awaiting_acceptance"&&r;});
  assert.equal(row.result,"Build complete");
  assert.equal(row.review,"Review complete");
  assert.deepEqual(c.api.store.prepare("SELECT member FROM runs ORDER BY started").all().map(r=>r.member),["claude","codex","claude"]);
});
