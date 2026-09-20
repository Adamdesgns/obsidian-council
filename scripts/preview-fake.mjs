// Local, temporary, fake-provider UI acceptance fixture. Never reads the real Council home.
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCouncil} from "../src/council.mjs";
const home=mkdtempSync(join(tmpdir(),"council-floor-preview-"));
const failed=new Set();
const c=await startCouncil({home,port:0,useFake:true,tickMs:100,disableBridge:true,
  limits:{daily_ceiling:{codex:1000,claude:1000,grok:1000},timeout_ms:{fake:5000}},
  scriptedReply:(member,msg)=>{
    if(msg.content.includes("planning stage of a Council work order")) return "1. Inspect the requested feature and current tests.\n2. Update the named implementation modules.\n3. Add focused regression coverage.\n4. Run the local test suite and report changed files, results, and remaining gates.";
    if(msg.content.includes("selected specialist")) return `${member} reviewed the approved plan: preserve existing behavior, add failure-path coverage, and keep push/deploy outside this work order.`;
    if(msg.content.includes("Execute this approved Council work order")) return "SIMULATED BUILD COMPLETE\nFiles: example implementation + focused tests\nValidation: simulated local suite passed\nNo push, merge, deploy, spend, or external action performed.";
    if(msg.content.includes("[fail]") && member==="codex" && !failed.has(msg.chamber_id)){
      failed.add(msg.chamber_id);return {exit:1,stderr:"Simulated allowance exhausted; Resume retries this step."};
    }
    if(!msg.content.includes("Council debate round")) return member==="codex" ? "Use a 30-second cache and invalidate it after writes." : "Keep freshness bounded and test invalidation.";
    if(msg.content.includes("[deadlock]")) return "DISAGREE: Ask Adam to choose the tradeoff.";
    const candidate=msg.content.split("CANDIDATE:\n")[1].split("\nCANDIDATE HASH:")[0];
    return "AGREE: "+candidate;
  }});
console.log("FAKE PROVIDERS ONLY. Type stop to close this fixture. Home retained as test evidence.");
process.stdin.setEncoding("utf8");
process.stdin.on("data",text=>{if(text.trim()==="stop")c.close().then(()=>process.exit(0));});
const timer=setTimeout(()=>c.close().then(()=>process.exit(0)),30*60*1000);
process.on("SIGTERM",()=>{clearTimeout(timer);c.close().then(()=>process.exit(0));});
