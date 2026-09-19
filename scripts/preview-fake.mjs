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
