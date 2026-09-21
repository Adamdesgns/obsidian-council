import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore} from "../src/store.mjs";
import {createOutbox} from "../src/outbox.mjs";
import {startWorkOrder,readWorkOrder,workTaskFor,canDispatchWork,completeWorkReply,approveWorkPlan,stallWork,resumeWork} from "../src/work-orders.mjs";
import {startCouncil} from "../src/council.mjs";

function fixture(t){
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

test("Codex plan is exact-approved and handed to specialist; coding does not fall back to Codex",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Build the feature",workspace:c.workspace,worker:"claude",idempotency_key:"one"});
  assert.equal(start.ok,true);
  assert.equal(startWorkOrder(c.store,{objective:"Build the feature",workspace:c.workspace,worker:"claude",idempotency_key:"one"}).duplicate,true);
  const first=claim(c,start.id,"codex");
  assert.equal(workTaskFor(c.store,first.message.id).phase,"planning");
  assert.equal(canDispatchWork(c.store,first.message.id,"codex"),true);
  completeWorkReply(c.store,{...first,member:"codex",text:"Plan A"});
  let row=readWorkOrder(c.store,start.id);assert.equal(row.state,"awaiting_approval");
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:"wrong"}).reason,"stale_plan");
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"specialist");
  reply(c,start.id,"claude","Claude implementation guidance");
  row=readWorkOrder(c.store,start.id);
  assert.equal(row.state,"waiting_worker");
  assert.equal(row.specialist_output,"Claude implementation guidance");
  assert.match(row.stall_detail,/will not fall back to Codex\/Claude/);
  assert.equal(c.store.verifyChain().ok,true);
});

test("selected low-cost worker owns implementing; Codex is never the builder",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Build via grok",workspace:c.workspace,worker:"grok",idempotency_key:"grok-build"});
  assert.equal(start.ok,true);
  reply(c,start.id,"codex","Plan for grok");
  let row=readWorkOrder(c.store,start.id);
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"implementing");
  const build=claim(c,start.id,"grok");
  assert.ok(build);
  assert.equal(workTaskFor(c.store,build.message.id).phase,"implementing");
  assert.equal(workTaskFor(c.store,build.message.id).member,"grok");
  completeWorkReply(c.store,{...build,member:"grok",text:"Grok built it"});
  row=readWorkOrder(c.store,start.id);
  assert.equal(row.state,"completed");
  assert.equal(row.result,"Grok built it");
});

test("worker=codex after plan approval waits honestly instead of implementing",t=>{
  const c=fixture(t),start=startWorkOrder(c.store,{objective:"Plan only",workspace:c.workspace,worker:"codex",idempotency_key:"codex-wait"});
  reply(c,start.id,"codex","A plan");
  const row=readWorkOrder(c.store,start.id);
  assert.equal(approveWorkPlan(c.store,start.id,{plan_hash:row.plan_hash}).state,"waiting_worker");
  assert.match(readWorkOrder(c.store,start.id).stall_detail,/coding-must-not-use-premium-worker/);
});

test("failures pause without retry storms; Cursor route produces an honest external packet",t=>{
  const c=fixture(t),a=startWorkOrder(c.store,{objective:"Plan it",workspace:c.workspace,worker:"cursor",idempotency_key:"cursor"});
  const lease=claim(c,a.id,"codex");
  stallWork(c.store,{...lease,member:"codex",reason:"auth",result:{stderr:"login needed"}});
  assert.equal(readWorkOrder(c.store,a.id).state,"stalled");
  assert.equal(resumeWork(c.store,a.id).state,"planning");
  reply(c,a.id,"codex","Cursor-ready plan");
  const row=readWorkOrder(c.store,a.id);approveWorkPlan(c.store,a.id,{plan_hash:row.plan_hash});
  const done=readWorkOrder(c.store,a.id);assert.equal(done.state,"handoff_ready");assert.match(done.handoff,/Cursor-ready plan/);
});

test("HTTP delegation runs fake Codex plan, Claude handoff, and Codex build end to end",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-work-http-")),workspace=mkdtempSync(join(tmpdir(),"council-work-http-ws-"));
  const limits={daily_ceiling:{codex:100,claude:100,grok:100},timeout_ms:{fake:3000},dispatcher:{tick_ms:20,max_member_hops:2,max_auto_replies_per_owner_turn:4}};
  const response=(member,msg)=>msg.content.includes("planning stage")?"Exact plan":msg.content.includes("selected specialist")?"Specialist notes":"Build complete";
  const c=await startCouncil({home,port:0,useFake:true,limits,tickMs:20,scriptedReply:response,log:()=>{}});
  t.after(async()=>{await c.close();rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});});
  const req=async(path,body)=>{const r=await fetch(c.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.api.tokens.owner},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const started=await req("/owner/delegate",{objective:"Build it",workspace,worker:"claude",idempotency_key:"http"});assert.equal(started.status,200);
  const until=async fn=>{const end=Date.now()+5000;while(Date.now()<end){const r=fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw Error("timeout");};
  let row=await until(()=>{const r=readWorkOrder(c.api.store,started.body.id);return r.state==="awaiting_approval"&&r;});
  assert.equal((await req(`/owner/work-order/${row.id}/approve`,{plan_hash:row.plan_hash})).status,200);
  row=await until(()=>{const r=readWorkOrder(c.api.store,started.body.id);return r.state==="waiting_worker"&&r;});
  assert.equal(row.specialist_output,"Specialist notes");
  assert.match(row.stall_detail,/will not fall back to Codex\/Claude/);
  assert.deepEqual(c.api.store.prepare("SELECT member FROM runs ORDER BY started").all().map(r=>r.member),["codex","claude"]);
});
