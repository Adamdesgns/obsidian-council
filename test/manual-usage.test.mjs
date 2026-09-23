import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createUsageService} from "../src/usage/service.mjs";
import {createApi} from "../src/api.mjs";

test("manual Cursor and Grok readings are labeled and expire after one hour",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-manual-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  let now=Date.parse("2026-09-22T20:00:00Z");
  const file=join(home,"manual-usage.json");
  const make=()=>createUsageService({manualPath:file,clock:()=>now,minRefreshMs:0});
  const service=make();
  assert.equal(service.setManual({service:"codex",remainingPercent:20}).ok,false);
  assert.equal(service.setManual({service:"grok",remainingPercent:101}).ok,false);
  assert.equal(service.setManual({service:"grok",remainingPercent:25,resetsAt:"2026-09-23T20:00:00Z"}).ok,true);
  let account=(await service.read()).accounts.find(a=>a.service==="grok");
  assert.equal(account.status,"manual");assert.equal(account.pools[0].windows[0].remainingPercent,25);
  assert.equal(make().setManual({service:"cursor",remainingPercent:0}).ok,true);
  account=(await make().read()).accounts.find(a=>a.service==="cursor");
  assert.equal(account.status,"manual");assert.equal(account.pools[0].windows[0].remainingPercent,0);
  now+=60*60_000;
  account=(await service.read()).accounts.find(a=>a.service==="grok");
  assert.equal(account.status,"unavailable");
});

test("manual usage write requires owner token",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-manual-http-"));
  const api=createApi({home,config:{host:"127.0.0.1",port:0}});
  await api.listen();t.after(async()=>{await api.close();rmSync(home,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+api.server.address().port;
  const body=JSON.stringify({service:"grok",remainingPercent:12});
  const post=token=>fetch(base+"/owner/usage/manual",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body});
  assert.equal((await post(null)).status,401);
  assert.equal((await post(api.tokens.members.grok)).status,403);
  assert.equal((await post(api.tokens.owner)).status,200);
  const result=await fetch(base+"/owner/usage",{headers:{Authorization:"Bearer "+api.tokens.owner}});
  assert.equal((await result.json()).accounts.find(a=>a.service==="grok").status,"manual");
});
