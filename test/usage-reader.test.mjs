import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readCodexLocalUsage,codexLocalAdapter,MAX_TOTAL_BYTES,MAX_BYTES_PER_FILE} from "../src/usage/codex-local-reader.mjs";
import {createUsageService} from "../src/usage/service.mjs";
const now=Date.parse("2026-09-22T15:00:00Z");
const event=(time,used)=>JSON.stringify({timestamp:new Date(time).toISOString(),type:"event_msg",payload:{type:"token_count",info:{private:"not returned"},rate_limits:{primary:{used_percent:used,window_minutes:300,resets_at:now/1000+60},secondary:{used_percent:30,window_minutes:10080,resets_at:now/1000+3600}}}});
test("reader handles nested records, large-file tails, dated folders and both windows",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"council-quota-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const day=join(dir,"2026","09","22");mkdirSync(day,{recursive:true});
  writeFileSync(join(day,"rollout-synthetic.jsonl"),'x'.repeat(MAX_BYTES_PER_FILE+10)+'\n'+event(now-30000,40)+'\n'+event(now-20000,45)+'\n{"truncated":');
  const env={CODEX_LOCAL_USAGE_READER:"1"};
  const raw=readCodexLocalUsage({dir,env,simulated:false});
  assert.equal(raw.snapshots[0].rates.primary.used_percent,45);assert.ok(raw.scannedBytes<=MAX_TOTAL_BYTES);
  assert.equal(JSON.stringify(raw).includes(dir),false);assert.equal(JSON.stringify(raw).includes("not returned"),false);
  const adapter=codexLocalAdapter({dir,env}),account=await adapter.fetch();
  assert.equal(account.status,"fresh");assert.equal(account.simulated,false);assert.deepEqual(account.pools[0].windows.map(w=>w.durationMinutes),[300,10080]);
});
test("cached reset crossing and future timestamps mark readings stale without inventing remaining allowance",async()=>{
  let clock=now;
  const service=createUsageService({clock:()=>clock,minRefreshMs:999999,adapters:{codex:{fetch:async()=>({service:"codex",status:"fresh",checkedAt:new Date(now).toISOString(),pools:[{id:"p",windows:[{id:"w",remainingPercent:12,resetsAt:new Date(now+1000).toISOString()}]}]})}}});
  assert.equal((await service.read()).accounts[0].status,"fresh");clock+=2000;
  const stale=(await service.read()).accounts[0];assert.equal(stale.status,"stale");assert.equal(stale.pools[0].windows[0].refreshDue,true);assert.equal(stale.pools[0].windows[0].remainingPercent,12);
  const future=createUsageService({clock:()=>now,adapters:{codex:{fetch:async()=>({status:"fresh",checkedAt:new Date(now+3600000).toISOString(),pools:[]})}}});
  assert.equal((await future.read()).accounts[0].status,"stale");
});
