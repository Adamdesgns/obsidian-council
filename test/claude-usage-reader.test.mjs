import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {claudeLocalAdapter,parseClaudeUsage} from "../src/usage/claude-local-reader.mjs";
import {createUsageService} from "../src/usage/service.mjs";

test("Claude signed-in usage gives two real windows without exposing the token",async t=>{
  const root=mkdtempSync(join(tmpdir(),"council-claude-usage-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,"claude");mkdirSync(config);
  const now=Date.parse("2026-09-23T02:00:00Z");
  writeFileSync(join(config,".credentials.json"),JSON.stringify({claudeAiOauth:{accessToken:"fixture-only-secret",expiresAt:now+3600000}}));
  let calls=0;
  const adapter=claudeLocalAdapter({env:{CLAUDE_CONFIG_DIR:config,CLAUDE_LOCAL_USAGE_READER:"1"},clock:()=>now,
    fetcher:async(url,opts)=>{calls++;assert.equal(new URL(url).hostname,"api.anthropic.com");assert.equal(opts.headers.Authorization,"Bearer fixture-only-secret");
      return {ok:true,json:async()=>({five_hour:{utilization:23,resets_at:"2026-09-23T04:00:00Z"},seven_day:{utilization:81,resets_at:"2026-09-27T02:00:00Z"}})};}});
  const result=await createUsageService({adapters:{claude:adapter},clock:()=>now}).read();
  const account=result.accounts.find(a=>a.service==="claude");
  assert.equal(calls,1);assert.equal(account.status,"fresh");
  assert.deepEqual(account.pools[0].windows.map(w=>w.remainingPercent),[77,19]);
  assert.equal(JSON.stringify(result).includes("fixture-only-secret"),false);
});

test("expired Claude sign-in and malformed usage fail closed",async t=>{
  const root=mkdtempSync(join(tmpdir(),"council-claude-usage-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,".credentials.json"),JSON.stringify({claudeAiOauth:{accessToken:"fixture-only-secret",expiresAt:1}}));
  let called=false;
  const account=await claudeLocalAdapter({env:{CLAUDE_CONFIG_DIR:root,CLAUDE_LOCAL_USAGE_READER:"1"},clock:()=>1000,
    fetcher:async()=>{called=true;throw Error("must not fetch");}}).fetch();
  assert.equal(account.status,"unavailable");assert.equal(called,false);
  assert.equal(parseClaudeUsage({five_hour:{utilization:Infinity}},"2026-09-23T02:00:00Z").status,"unavailable");
});
