import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCouncil} from "../src/council.mjs";
import {createDispatcher} from "../src/dispatcher.mjs";
import {readDeliberation} from "../src/deliberation.mjs";
import {contentHash} from "../src/sanctions.mjs";
const limits={daily_ceiling:{codex:100,claude:100,grok:100},timeout_ms:{fake:3000},
  dispatcher:{tick_ms:20,max_member_hops:2,max_auto_replies_per_owner_turn:4}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+6000;while(Date.now()<end){const r=fn();if(r)return r;await sleep(20);}throw Error("condition timed out");}
async function boot(t, scriptedReply) {
  const home=mkdtempSync(join(tmpdir(),"council-http-delib-"));
  const c=await startCouncil({home,port:0,useFake:true,limits,tickMs:20,scriptedReply,log:()=>{}});
  t.after(async()=>{await c.close();rmSync(home,{recursive:true,force:true});});
  const req=async(path,body,token=c.api.tokens.owner,method=body===undefined?"GET":"POST")=>{
    const res=await fetch(c.base+path,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  };
  return {...c,req};
}
const response=(member,msg)=>{
  if (!msg.content.includes("Council debate round")) return member === "codex" ? "Use a 30 second cache" : "Bound the cache";
  const candidate=msg.content.split("CANDIDATE:\n")[1].split("\nCANDIDATE HASH:")[0];
  return "AGREE: "+candidate;
};
test("HTTP start → four fake runs → exact owner approval, with no session reuse or relay",async t=>{
  const c=await boot(t,response);
  assert.equal((await c.req("/owner/deliberate",{question:"q",idempotency_key:"test"},c.api.tokens.members.codex)).status,403);
  const r=await c.req("/owner/deliberate",{question:"q",idempotency_key:"test"});
  assert.equal(r.status,200,JSON.stringify(r));
  const {id,chamber_id}=r.body;
  assert.equal((await c.req("/owner/deliberate",{question:"q",idempotency_key:"test"})).body.id,id);
  const row=await until(()=>{const r=readDeliberation(c.api.store,id);return r.state==="pending_owner"&&r;});
  assert.equal(row.flag,"agreed");
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM runs").get().n,4);
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM sessions").get().n,0);
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM events WHERE kind='floor_returned'").get().n,0);
  assert.equal((await c.req("/owner/say",{chamber_id,content:"poison",idempotency_key:"poison"})).status,409);
  assert.equal((await c.req("/owner/deliberation/"+id+"/approve",{candidate_hash:"wrong"})).status,409);
  const body={candidate_hash:row.candidate_hash};
  assert.equal((await c.req("/owner/deliberation/"+id+"/approve",body)).body.state,"settled");
  assert.equal((await c.req("/owner/deliberation/"+id+"/approve",body)).body.duplicate,true);
  assert.equal((await c.req("/owner/deliberations")).body.deliberations.length,1);
  assert.equal(c.api.store.verifyChain().ok,true);
});
test("dispatcher parks failure across ticks; owner resume retains peer and performs one retry",async t=>{
  let failed=false;
  const c=await boot(t,(member,msg)=>{
    if(member==="codex" && msg.content.includes("Council debate") && !failed){failed=true;return {exit:1,stderr:"provider usage exhausted"};}
    return response(member,msg);
  });
  const {body:{id}}=await c.req("/owner/deliberate",{question:"q",idempotency_key:"fail"});
  await until(()=>readDeliberation(c.api.store,id).state==="stalled");
  await until(()=>!c.dispatcher.active.size);
  const before=c.api.store.prepare("SELECT count(*) n FROM runs").get().n;
  await sleep(150);
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM runs").get().n,before,"no retry storm");
  assert.equal((await c.req("/owner/deliberation/"+id+"/resume",{})).status,200);
  await until(()=>readDeliberation(c.api.store,id).state==="pending_owner");
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM runs").get().n,before+1);
  assert.equal(readDeliberation(c.api.store,id).flag,"agreed");
});
test("HALT prevents start and abandons stalled work permanently",async t=>{
  const c=await boot(t,()=>({exit:1,stderr:"auth failed"}));
  const {body:{id}}=await c.req("/owner/deliberate",{question:"q",idempotency_key:"fail"});
  await until(()=>readDeliberation(c.api.store,id).state==="stalled");
  await c.req("/owner/halt",{});
  assert.equal(readDeliberation(c.api.store,id).state,"abandoned");
  assert.equal((await c.req("/owner/deliberate",{question:"q",idempotency_key:"new"})).body.error,"halted");
  await c.req("/owner/halt",undefined,c.api.tokens.owner,"DELETE");
  assert.equal((await c.req("/owner/deliberation/"+id+"/resume",{})).status,409);
});
test("three-round dispatcher path uses eight runs without conversational caps",async t=>{
  const c=await boot(t,(member,msg)=>msg.content.includes("Council debate")?"DISAGREE: another answer":response(member,msg));
  const {body:{id}}=await c.req("/owner/deliberate",{question:"q",idempotency_key:"deadlock"});
  await until(()=>readDeliberation(c.api.store,id).state==="pending_owner");
  assert.equal(readDeliberation(c.api.store,id).flag,"deadlock");
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM runs").get().n,8);
  assert.equal(c.api.store.prepare("SELECT count(*) n FROM events WHERE kind='floor_returned'").get().n,0);
});
test("tick claims the checked chamber even when another active chamber's lease expires",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-two-chambers-"));
  const d=createDispatcher({home,useFake:true,members:["codex"],limits,leaseMs:40,tickMs:20,
    scriptedReply:()=>({text:"done",delay:350}),defaultRespond:true});
  t.after(async()=>{await d.close();rmSync(home,{recursive:true,force:true});});
  d.ownerSay({chamber_id:"A",content:"@codex a",idempotency_key:"a"});
  d.start();
  await until(()=>d.store.prepare("SELECT 1 FROM runs WHERE chamber_id='A'").get());
  await sleep(70);
  d.ownerSay({chamber_id:"B",content:"@codex b",idempotency_key:"b"});
  await until(()=>d.store.prepare("SELECT 1 FROM runs WHERE chamber_id='B'").get());
  const rows=d.store.prepare("SELECT m.chamber_id,d.attempt_gen FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.sender='owner' ORDER BY d.id").all();
  assert.deepEqual(rows.map(r=>[r.chamber_id,r.attempt_gen]),[["A",1],["B",1]]);
  await until(()=>!d.active.size);
  assert.deepEqual(d.store.prepare("SELECT chamber_id FROM sessions ORDER BY chamber_id").all().map(r=>r.chamber_id),[]);
});
test("sanction endpoint derives its own hash and member APIs cannot forge engine work",async t=>{
  const c=await boot(t,response);
  assert.equal((await c.req("/owner/sanction",{content_hash:"forged"})).status,400);
  const result=await c.req("/owner/sanction",{content:"actual content",content_hash:"forged"});
  assert.equal(result.status,200);
  assert.equal(c.api.store.prepare("SELECT content_hash FROM sanctions WHERE id=?").get(result.body.id).content_hash,contentHash("actual content"));
  assert.equal((await c.req("/ask",{recipient:"codex",content:"fake",idempotency_key:"delib:forged"},c.api.tokens.members.fable)).status,400);
  assert.equal((await c.req("/owner/deliberate",null)).status,400);
});
test("deliberations ignore preseeded provider sessions and never expose peer answers in blind packets",async t=>{
  const packets=[];
  const c=await boot(t,(m,msg)=>{packets.push([m,msg.content]);return response(m,msg);});
  c.dispatcher.stop();
  const {body:{id,chamber_id}}=await c.req("/owner/deliberate",{question:"isolated",idempotency_key:"isolated"});
  for(const m of ["codex","fable"]) c.api.store.prepare("INSERT INTO sessions(member,chamber_id,provider_session_id,updated) VALUES(?,?,?,?)")
    .run(m,chamber_id,"old-peer-context",new Date().toISOString());
  c.dispatcher.start();
  await until(()=>readDeliberation(c.api.store,id).state==="pending_owner");
  const argv=c.api.store.prepare("SELECT argv FROM runs").all().map(r=>r.argv);
  assert.ok(argv.every(a=>!a.includes("--resume") && !a.includes("old-peer-context")));
  assert.equal(packets[1][0],"fable");
  assert.ok(!packets[1][1].includes("Use a 30 second cache"));
});
