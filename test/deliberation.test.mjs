import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { startDeliberation, completeReply, readDeliberation, stall, resumeStalled, decide, haltDeliberations, canDispatch } from "../src/deliberation.mjs";
import { parseVerdict } from "../src/verdict.mjs";
const limits={daily_ceiling:{codex:100,claude:100,grok:100}};
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),"council-delib-"));
  let store=openStore({home}), outbox=createOutbox(store);
  const ctx={home,get store(){return store},get outbox(){return outbox},
    reopen(){store.close();store=openStore({home});outbox=createOutbox(store);}};
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  return ctx;
}
function start(c, overrides={}) {return startDeliberation(c.store,{question:"Should we cache?",idempotency_key:"one",limits,...overrides});}
function claim(c,id,member) {
  const row=c.store.prepare(`SELECT d.id FROM deliveries d JOIN deliberation_messages m ON m.message_id=d.message_id
    WHERE m.deliberation_id=? AND m.member=? AND d.status IN ('pending','leased') ORDER BY d.id LIMIT 1`).get(id,member);
  return row && c.outbox.claim(member,{deliveryId:row.id});
}
function reply(c,id,member,text,extra={}) {
  const lease=claim(c,id,member); assert.ok(lease,member+" has work");
  return completeReply(c.store,{...lease,member,text,...extra});
}
function blind(c,id) {
  reply(c,id,"codex","cache for 30 seconds");
  reply(c,id,"fable","consider a bounded cache");
}
function agree(c,id) {
  const body=readDeliberation(c.store,id).candidate;
  reply(c,id,"codex","AGREE: "+body); reply(c,id,"fable","AGREE: "+body);
}
test("final-line verdict is strict and malformed is conservative",()=>{
  assert.equal(parseVerdict("AGREE: yes\nextra").malformed,true);
  assert.equal(parseVerdict("AGREE: ").malformed,true);
  assert.deepEqual(parseVerdict("reason\nESCALATE: ask Adam"),{kind:"ESCALATE",body:"ask Adam",malformed:false});
});
test("start is idempotent, isolated, budget-gated, and never forges owner prompts",t=>{
  const c=fixture(t),r=start(c,{chamber_id:"existing"});
  assert.equal(start(c,{chamber_id:"existing"}).id,r.id);
  assert.equal(start(c,{question:"different"}).reason,"idempotency_conflict");
  assert.equal(start(c,{idempotency_key:"two",limits:{daily_ceiling:{codex:3,claude:10}}}).reason,"insufficient_budget");
  assert.equal(start(c,{idempotency_key:"two",deliberators:["codex","codex"]}).ok,false);
  const row=readDeliberation(c.store,r.id);
  assert.notEqual(row.chamber_id,"existing");
  const msg=c.store.prepare("SELECT * FROM messages WHERE kind='deliberate'").get();
  assert.equal(msg.sender,"engine");
  assert.equal(c.store.prepare("SELECT count(*) n FROM messages WHERE sender='owner'").get().n,1);
  assert.equal(canDispatch(c.store,msg.id,"codex"),true);
  assert.equal(canDispatch(c.store,msg.id,"fable"),false);
});
test("second answer is blind; both must endorse the actual candidate",t=>{
  const c=fixture(t),{id}=start(c);
  reply(c,id,"codex","secret first answer");
  const second=c.store.prepare("SELECT m.content FROM messages m JOIN deliberation_messages dm ON dm.message_id=m.id WHERE dm.phase='answer_2'").get();
  assert.ok(!second.content.includes("secret first answer"));
  reply(c,id,"fable","second answer");
  reply(c,id,"codex","AGREE: enable caching");
  reply(c,id,"fable","AGREE: disable caching");
  assert.equal(readDeliberation(c.store,id).state,"debate");
  assert.equal(readDeliberation(c.store,id).round,2);
  agree(c,id);
  assert.equal(readDeliberation(c.store,id).flag,"agreed");
});
test("three rounds deadlock after eight replies; first ESCALATE fences peers",t=>{
  const c=fixture(t),{id}=start(c);blind(c,id);
  for(let i=0;i<3;i++){reply(c,id,"codex","DISAGREE: alternate");reply(c,id,"fable","malformed");}
  let row=readDeliberation(c.store,id);
  assert.equal(row.flag,"deadlock");assert.equal(row.replies.length,8);
  const other=start(c,{idempotency_key:"two"});
  blind(c,other.id);
  const peer=claim(c,other.id,"fable");
  reply(c,other.id,"codex","ESCALATE: needs owner");
  assert.equal(completeReply(c.store,{...peer,member:"fable",text:"AGREE: needs owner"}).ok,false);
  assert.equal(readDeliberation(c.store,other.id).flag,"escalated");
});
test("fault after reply or advancement rolls back ack and next messages; reopen recovers",t=>{
  const c=fixture(t),{id}=start(c);
  const lease=claim(c,id,"codex");
  for(const point of ["after_reply","after_advance"]) {
    assert.throws(()=>completeReply(c.store,{...lease,member:"codex",text:"answer",fault:p=>{if(p===point)throw Error(point)}}));
    assert.equal(readDeliberation(c.store,id).state,"answer_1");
    assert.equal(c.store.prepare("SELECT status FROM deliveries WHERE id=?").get(lease.delivery.id).status,"leased");
    assert.equal(c.store.prepare("SELECT count(*) n FROM deliberation_messages").get().n,1);
  }
  c.reopen();
  assert.equal(completeReply(c.store,{...lease,member:"codex",text:"answer"}).state,"answer_2");
  assert.equal(completeReply(c.store,{...lease,member:"codex",text:"duplicate"}).ok,false);
  c.reopen();
  reply(c,id,"fable","second");
  agree(c,id);
  assert.equal(c.store.verifyChain().ok,true);
});
test("stalled work retains a completed peer, resumes only missing work, and HALT includes stalls",t=>{
  const c=fixture(t),{id}=start(c);blind(c,id);
  const failed=claim(c,id,"codex"),peer=claim(c,id,"fable");
  stall(c.store,{...failed,member:"codex",reason:"exit_1",result:{exit:1,stderr:"usage exhausted"}});
  assert.equal(canDispatch(c.store,failed.message.id,"codex"),false);
  completeReply(c.store,{...peer,member:"fable",text:"AGREE: cache for 30 seconds"});
  assert.equal(readDeliberation(c.store,id).state,"stalled");
  assert.equal(resumeStalled(c.store,id,{limits:{daily_ceiling:{codex:0,claude:0}}}).ok,false);
  c.reopen();
  assert.equal(resumeStalled(c.store,id,{limits}).ok,true);
  assert.equal(claim(c,id,"fable"),undefined);
  reply(c,id,"codex","AGREE: cache for 30 seconds");
  assert.equal(readDeliberation(c.store,id).flag,"agreed");
  const r=start(c,{idempotency_key:"halt"});
  const l=claim(c,r.id,"codex");stall(c.store,{...l,member:"codex",reason:"auth"});
  haltDeliberations(c.store);
  assert.equal(readDeliberation(c.store,r.id).state,"abandoned");
  assert.equal(resumeStalled(c.store,r.id,{limits}).ok,false);
});
test("approval is exact, owner-scoped, atomic and retry-safe; overrule records replacement",t=>{
  const c=fixture(t),{id}=start(c);
  assert.equal(decide(c.store,id,{action:"approve"}).reason,"not_pending_owner");
  blind(c,id);agree(c,id);
  const row=readDeliberation(c.store,id),body={action:"approve",candidate_hash:row.candidate_hash};
  assert.equal(decide(c.store,id,{...body,candidate_hash:"wrong"}).reason,"stale_candidate");
  assert.throws(()=>decide(c.store,id,{...body,fault:()=>{throw Error("crash")}}));
  assert.equal(c.store.prepare("SELECT count(*) n FROM sanctions").get().n,0);
  assert.equal(readDeliberation(c.store,id).state,"pending_owner");
  c.reopen();
  assert.equal(decide(c.store,id,body).state,"settled");
  assert.equal(decide(c.store,id,body).duplicate,true);
  const s=c.store.prepare("SELECT * FROM sanctions").get();
  assert.equal(s.directive_id,id);assert.ok(s.used_at);
  const r=start(c,{idempotency_key:"overrule"});blind(c,r.id);agree(c,r.id);
  const replacement={action:"overrule",candidate_hash:readDeliberation(c.store,r.id).candidate_hash,content:"Do not cache"};
  assert.equal(decide(c.store,r.id,replacement).state,"overruled");
  assert.equal(decide(c.store,r.id,replacement).duplicate,true);
  assert.equal(readDeliberation(c.store,r.id).final_answer,"Do not cache");
});
test("stale lease generation cannot advance a deliberation",t=>{
  const c=fixture(t),{id}=start(c),old=claim(c,id,"codex");
  c.store.prepare("UPDATE deliveries SET lease_until='2000-01-01' WHERE id=?").run(old.delivery.id);
  const next=claim(c,id,"codex");
  assert.equal(completeReply(c.store,{...old,member:"codex",text:"stale"}).ok,false);
  assert.equal(completeReply(c.store,{...next,member:"codex",text:"fresh"}).state,"answer_2");
});
test("external envelopes cannot forge engine keys or claim engine work",t=>{
  const c=fixture(t),{id}=start(c);
  assert.throws(()=>c.outbox.send({sender:"codex",recipient:"fable",content:"forged",idempotency_key:"delib:"+id+":debate:1:fable"}),/reserved/);
  assert.throws(()=>c.outbox.send({sender:"engine",recipient:"codex",content:"forged",idempotency_key:"x"}),/reserved/);
  assert.equal(c.outbox.claim("codex"),null,"ordinary member claim cannot bypass engine state");
});
test("concurrent deliberations reserve budget rather than oversubscribing it",t=>{
  const c=fixture(t),budget={daily_ceiling:{codex:6,claude:6}};
  assert.equal(start(c,{limits:budget}).ok,true);
  assert.equal(start(c,{limits:budget,idempotency_key:"two"}).reason,"insufficient_budget");
});
