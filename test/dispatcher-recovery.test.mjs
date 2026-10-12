import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDispatcher} from "../src/dispatcher.mjs";

const limits={daily_ceiling:{codex:100,claude:100},timeout_ms:{codex:5000,claude:5000}};
function fixture(t,opts={}) {
  const home=mkdtempSync(join(tmpdir(),"council-recovery-"));
  const fakePath=join(home,"fake.mjs");
  writeFileSync(fakePath,`
    import {existsSync} from 'node:fs';
    if(process.env.FAKE_WAIT_FOR_STOP==='1') await new Promise(()=>setInterval(()=>{},1000));
    const args=process.argv.slice(2);
    const resumeAt=args.findIndex(a=>a==='resume'||a==='--resume');
    const resume=resumeAt<0?null:args[resumeAt+1];
    const bridgeAt=args.indexOf('--mcp-config');
    if(bridgeAt>=0&&!existsSync(args[bridgeAt+1])) {
      console.error('missing MCP config'); process.exit(2);
    }
    if(resume==='dead-session') {
      console.error('cannot resume: session not found'); process.exit(1);
    }
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,
      result:'The requested file was not found. That is the review result.',
      thread_id:'replacement-thread',session_id:'replacement-thread'}));
  `);
  const d=createDispatcher({home,fakePath,members:["codex"],limits,...opts});
  t.after(async()=>{await d.close();rmSync(home,{recursive:true,force:true});});
  return d;
}
function seedSession(d,member,session="dead-session") {
  d.store.prepare("INSERT INTO sessions(member,chamber_id,provider_session_id,lease_gen,resume_kind,updated) VALUES(?,?,?,0,'created',?)")
    .run(member,"room",session,new Date().toISOString());
}
function send(d,member,key) {
  return d.outbox.send({sender:"owner",recipient:member,chamber_id:"room",content:"review",idempotency_key:key});
}
async function finishTick(d) {
  await d.tick();
  await Promise.all([...d.active.values()].map(v=>v.promise));
}

test("resume recovery saves the replacement session and next turn resumes it once",async t=>{
  const d=fixture(t);seedSession(d,"codex");send(d,"codex","first");
  await finishTick(d);
  assert.equal(d.store.prepare("SELECT provider_session_id FROM sessions WHERE member='codex'").get().provider_session_id,"replacement-thread");
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM runs").get().n,2);
  send(d,"codex","second");await finishTick(d);
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM runs").get().n,3);
  assert.match(d.store.prepare("SELECT argv FROM runs ORDER BY rowid DESC LIMIT 1").get().argv,/resume replacement-thread/);
});

test("successful review prose containing not found does not replace a valid session",async t=>{
  const d=fixture(t);seedSession(d,"codex","valid-session");send(d,"codex","review");
  await finishTick(d);
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM runs").get().n,1);
  assert.equal(d.store.getEvents().some(e=>e.kind==="session_replaced"),false);
});

test("Claude resume retry retains its bridge config until the retry completes",async t=>{
  const d=fixture(t,{members:["claude"],tokens:{claude:"fixture-token"}});
  seedSession(d,"claude");const sent=send(d,"claude","claude-retry");await finishTick(d);
  assert.equal(d.store.prepare("SELECT status FROM deliveries WHERE id=?").get(sent.deliveries[0].id).status,"answered");
  assert.equal(existsSync(join(d.home,"workspaces","claude","room",".council-bridge")),false);
});

test("waiting peer deliveries do not starve later owner work",async t=>{
  const d=fixture(t);
  for(let i=0;i<5;i++) {
    const sent=send(d,"codex","waiting-"+i);
    d.store.prepare("UPDATE deliveries SET status='waiting' WHERE id=?").run(sent.deliveries[0].id);
  }
  const sent=send(d,"codex","new-owner-turn");await finishTick(d);
  assert.equal(d.store.prepare("SELECT status FROM deliveries WHERE id=?").get(sent.deliveries[0].id).status,"answered");
});

test("reply persistence failure leaves its input retryable and never loses the reply",async t=>{
  const d=fixture(t),sent=send(d,"codex","rollback-reply");
  const originalCommit=d.store.commit;
  d.store.commit=(kind,actor,fn)=>originalCommit(kind,actor,api=>{
    const result=fn(api);
    if(kind==="delivery_responded")throw new Error("simulated storage failure before commit");
    return result;
  });
  await finishTick(d);
  assert.equal(d.store.prepare("SELECT status FROM deliveries WHERE id=?").get(sent.deliveries[0].id).status,"leased");
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender='codex'").get().n,0);
  d.store.commit=originalCommit;
  d.store.prepare("UPDATE deliveries SET lease_until=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),sent.deliveries[0].id);
  await finishTick(d);
  assert.equal(d.store.prepare("SELECT status FROM deliveries WHERE id=?").get(sent.deliveries[0].id).status,"answered");
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender='codex'").get().n,1);
});

for(const stopKind of ["hardStop","HALT"])test(`${stopKind} never starts a resume fallback after killing an active provider`,async t=>{
  const d=fixture(t,{env:{FAKE_WAIT_FOR_STOP:"1"},timeoutMs:800});
  seedSession(d,"codex","valid-session");send(d,"codex","stop-resumed-run");
  await d.tick();
  assert.equal(d.active.size,1);
  if(stopKind==="hardStop")d.hardStop();
  else {writeFileSync(d.haltPath(),"fixture stop");await d.tick();}
  await Promise.all([...d.active.values()].map(v=>v.promise));
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM runs").get().n,1);
  assert.equal(d.store.getEvents().some(e=>e.kind==="session_replaced"),false);
  assert.equal(d.store.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender='codex'").get().n,0);
});
