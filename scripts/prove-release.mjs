// Explicitly authorized live smoke test. Never run as part of npm test.
// Prepare is offline. --run uses signed-in Codex + Cursor, pauses for plan review.
import { mkdirSync, existsSync, writeFileSync, readFileSync, mkdtempSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { startCouncil } from "../src/council.mjs";
import { readWorkOrder } from "../src/work-orders.mjs";

const output=resolve("evidence/2026-10-12-release");mkdirSync(output,{recursive:true});
const planPath=join(output,"live-proof-plan.json");
const fixtureTest='import assert from "node:assert/strict";\nimport { answer } from "./answer.mjs";\nassert.equal(answer, 2);\n';
function verifyFixture(workspace,answer) {
  const files=readdirSync(workspace).filter(name=>name!==".git").sort();
  if(JSON.stringify(files)!==JSON.stringify(["answer.mjs","answer.test.mjs"]))throw Error("Proof workspace contains unexpected files");
  for(const [name,expected] of [["answer.mjs",`export const answer = ${answer};\n`],["answer.test.mjs",fixtureTest]]) {
    const path=join(workspace,name);
    if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || readFileSync(path,"utf8").replace(/\r\n/g,"\n")!==expected)throw Error("Proof fixture differs from the exact approved content: "+name);
  }
}
if(!process.argv.includes("--run")) {
  if(existsSync(planPath)) {console.log(readFileSync(planPath,"utf8"));process.exit(0);}
  const workspace=mkdtempSync(join(tmpdir(),"council-approved-release-proof-"));
  writeFileSync(join(workspace,"answer.mjs"),"export const answer = 1;\n");
  writeFileSync(join(workspace,"answer.test.mjs"),fixtureTest);
  const git=spawnSync("git",["init","--quiet"],{cwd:workspace,encoding:"utf8",windowsHide:true});if(git.status!==0)throw Error("Cannot prepare proof workspace");
  const plan={workspace,planner:"codex",worker:"cursor",workerModel:"composer-2.5",objective:"In this disposable test only, change answer.mjs to export answer = 2. Do not change answer.test.mjs. Return a checked patch, then verify with node --test answer.test.mjs.",maximumRuns:{codex:2,cursor:1},maximumSeconds:600,trust:"Only this exact disposable directory, only during this process",status:"prepared; no provider calls"};
  writeFileSync(planPath,JSON.stringify(plan,null,2)+"\n");console.log(JSON.stringify(plan,null,2));process.exit(0);
}
if(process.env.COUNCIL_LIVE_PROOF_APPROVED!=="1")throw Error("Explicit owner approval is required: set COUNCIL_LIVE_PROOF_APPROVED=1 only after approval of live-proof-plan.json.");
const plan=JSON.parse(readFileSync(planPath,"utf8"));
verifyFixture(plan.workspace,1);
process.env.COUNCIL_TEST_ONLY="0";process.env.CODEX_LOCAL_USAGE_READER="0";process.env.CLAUDE_LOCAL_USAGE_READER="0";
process.env.COUNCIL_CURSOR_ENABLED="1";process.env.COUNCIL_CURSOR_MODEL=plan.workerModel;
if(!process.env.COUNCIL_CURSOR_EXE) {
  process.env.COUNCIL_CURSOR_EXE=join(process.env.LOCALAPPDATA,"Programs","ObsidianCouncilCursorCLI","node.exe");
  process.env.COUNCIL_CURSOR_ENTRYPOINT ||= join(process.env.LOCALAPPDATA,"Programs","ObsidianCouncilCursorCLI","index.js");
}
process.env.COUNCIL_CURSOR_TRUST_APPROVED="1";process.env.COUNCIL_CURSOR_TRUST_WORKSPACE=plan.workspace;
const home=mkdtempSync(join(tmpdir(),"council-release-proof-home-"));
const report={started:new Date().toISOString(),route:["codex-plan","reviewed-test-approval","cursor-checked-patch","codex-review","test-acceptance"],workerModel:plan.workerModel,passed:false};
const council=await startCouncil({home,port:0,useFake:false,members:["codex","cursor"],disableBridge:true,log:()=>{},tickMs:100,
  limits:{daily_ceiling:{codex:2,cursor:1,claude:0,grok:0},timeout_ms:{codex:180000,cursor:180000},dispatcher:{tick_ms:100,max_member_hops:2,max_auto_replies_per_owner_turn:4}}});
const input=createInterface({input:process.stdin,output:process.stdout});
const deadline=Date.now()+600000;
let deadlineTimer;
const timedOut=new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(Error("Live proof ten-minute cutoff")),600000);deadlineTimer.unref();});
let cancelProof;
const cancelled=new Promise((_,reject)=>{cancelProof=()=>reject(Error("Live proof cancelled by owner"));});
process.once("SIGINT",cancelProof);process.once("SIGTERM",cancelProof);
input.once("SIGINT",cancelProof);input.once("close",cancelProof);
async function request(path,body) {const response=await fetch(council.base+path,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+council.api.tokens.owner},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||response.status);return data;}
async function until(id,state) {while(Date.now()<deadline){const row=readWorkOrder(council.api.store,id);if(row.state===state)return row;if(["stalled","waiting_worker","cancelled"].includes(row.state))throw Error(row.stall_detail||row.state);await new Promise(r=>setTimeout(r,500));}throw Error("Proof deadline exceeded");}
try {
  await Promise.race([(async()=>{
    const started=await request("/owner/delegate",{objective:plan.objective,workspace:plan.workspace,planner:plan.planner,worker:plan.worker,idempotency_key:"release-proof"});
    let row=await until(started.id,"awaiting_approval");report.plan=row.plan;
    console.log("PLAN FOR REVIEW\n"+row.plan+"\nType approve to run this exact disposable plan, or stop to cancel.");
    const response=await new Promise(resolve=>input.once("line",resolve));
    if(response.trim()!=="approve")throw Error("Proof cancelled before coding");
    await request(`/owner/work-order/${row.id}/approve`,{plan_hash:row.plan_hash});
    row=await until(row.id,"awaiting_acceptance");report.result=row.result;report.review=row.review;
    // Never execute a model-authored test or arbitrary returned program on the host.
    // This proof authorizes exactly one constant change in exactly two fixed files.
    verifyFixture(plan.workspace,2);
    const verify=spawnSync(process.execPath,["--test","answer.test.mjs"],{cwd:plan.workspace,encoding:"utf8",timeout:30000,windowsHide:true});
    report.independentTest={exit:verify.status,output:verify.stdout};if(verify.status!==0)throw Error("Proof module verification failed");
    await request(`/owner/work-order/${row.id}/accept`,{plan_hash:row.plan_hash});report.finalState=readWorkOrder(council.api.store,row.id).state;
    report.passed=report.finalState==="completed";
  })(),timedOut,cancelled]);
}catch(error){report.error=error.message;process.exitCode=1;}
finally {
  clearTimeout(deadlineTimer);process.removeListener("SIGINT",cancelProof);process.removeListener("SIGTERM",cancelProof);
  input.removeListener("SIGINT",cancelProof);input.removeListener("close",cancelProof);
  report.runs=council.api.store.prepare("SELECT member,exit,checkpoint FROM runs ORDER BY started").all().map(r=>{const c=JSON.parse(r.checkpoint||"{}");return {member:r.member,exit:r.exit,role:c.role,timedOut:c.timedOut,refused:c.refused||null};});
  input.close();await council.close();report.finished=new Date().toISOString();
  writeFileSync(join(output,"live-proof-report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({passed:report.passed,error:report.error||null,runs:report.runs}));
}
