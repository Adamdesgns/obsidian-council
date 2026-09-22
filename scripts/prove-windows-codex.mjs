import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {startCouncil} from "../src/council.mjs";
import {readWorkOrder} from "../src/work-orders.mjs";

const root=resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const workspace=join(root,"evidence","2026-09-22-windows-codex","proof-workspace");
const planner=process.env.COUNCIL_PROOF_PLANNER||"codex";
if(!["codex","claude"].includes(planner))throw new Error("COUNCIL_PROOF_PLANNER must be codex or claude");
const reportPath=join(root,"evidence","2026-09-22-windows-codex",planner==="codex"?"live-proof.json":"live-proof-claude-planner.json");
const home=mkdtempSync(join(tmpdir(),"council-real-proof-"));
const limits={daily_ceiling:{codex:10,claude:10,grok:10,cursor:0},timeout_ms:{codex:600000,claude:600000,grok:600000,fake:5000},dispatcher:{tick_ms:100,max_member_hops:2,max_auto_replies_per_owner_turn:4}};
const council=await startCouncil({home,port:0,members:[...new Set([planner,"codex"])],limits,tickMs:100,log:()=>{}});

async function request(path,body){
  const response=await fetch(council.base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+council.api.tokens.owner},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new Error(path+": "+JSON.stringify(data));
  return data;
}
async function until(id,state,ms=900000){
  const end=Date.now()+ms;
  while(Date.now()<end){
    const row=readWorkOrder(council.api.store,id);
    if(row?.state===state)return row;
    if(["stalled","waiting_worker","cancelled"].includes(row?.state))throw new Error("work stopped in "+row.state+"/"+(row.resume_state||"none")+": "+row.stall_detail);
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error("timeout waiting for "+state);
}

try{
  writeFileSync(join(workspace,"answer.mjs"),"export const answer = 1;\n");
  const started=await request("/owner/delegate",{objective:"Change answer.mjs so the exported answer is 2, then run npm test. Make no other product change.",workspace,planner,worker:"codex",idempotency_key:`windows-${planner}-planner-live-proof`});
  let row=await until(started.id,"awaiting_approval");
  await request(`/owner/work-order/${row.id}/approve`,{plan_hash:row.plan_hash});
  row=await until(row.id,"awaiting_acceptance");
  const source=readFileSync(join(workspace,"answer.mjs"),"utf8");
  const runs=council.api.store.prepare("SELECT member,exit,checkpoint FROM runs ORDER BY started").all().map(run=>({member:run.member,exit:run.exit,checkpoint:JSON.parse(run.checkpoint||"{}")}));
  const report={provedAt:new Date().toISOString(),route:[`${planner}-plan`,"owner-approval","codex-build",`${planner}-review`,"owner-acceptance"],stateBeforeAcceptance:row.state,source,result:row.result,review:row.review,runs:runs.map(run=>({member:run.member,exit:run.exit,role:run.checkpoint.role,workspaceWrite:run.checkpoint.buildPolicy?.sandbox_policy?.includes?.("workspace-write")||false,refused:run.checkpoint.refused||null,timedOut:run.checkpoint.timedOut}))};
  await request(`/owner/work-order/${row.id}/accept`,{plan_hash:row.plan_hash});
  report.finalState=readWorkOrder(council.api.store,row.id).state;
  writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
}finally{
  await council.close();
  rmSync(home,{recursive:true,force:true});
  rmSync(join(workspace,".council-codex-home"),{recursive:true,force:true});
  rmSync(join(workspace,".council-codex-temp"),{recursive:true,force:true});
}
