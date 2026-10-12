// Disposable browser acceptance. Real UI/API; simulated providers; no real Council data.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { startCouncil } from "../src/council.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
process.env.COUNCIL_TEST_ONLY="1";
process.env.CODEX_LOCAL_USAGE_READER="0";
process.env.CLAUDE_LOCAL_USAGE_READER="0";
process.env.COUNCIL_CURSOR_ENABLED="0";
process.env.COUNCIL_GROK_PATCH_ENABLED="0";
const temporary = mkdtempSync(join(tmpdir(), "council-browser-"));
const workspace = join(temporary,"workspace"); mkdirSync(workspace);
const out = resolve("evidence/2026-10-12-release"); mkdirSync(out,{recursive:true});
const council=await startCouncil({home:join(temporary,"home"),port:0,useFake:true,usageFixture:true,tickMs:50,disableBridge:true,log:()=>{},
  limits:{daily_ceiling:{codex:100,claude:100,grok:100,cursor:0},timeout_ms:{fake:15000},dispatcher:{tick_ms:50,max_member_hops:2,max_auto_replies_per_owner_turn:4}},
  scriptedReply:(member,msg)=>{
    if(msg.content.includes("planning stage of a Council work order"))return "SIMULATED PLAN: inspect the named module, update it, run its regression test, and return evidence. Only the approved workspace is in scope.";
    if(msg.content.includes("Review this Council work order"))return "SIMULATED REVIEW: the fixture worker returned a report. No real provider or real implementation was used.";
    if(msg.content.includes("Execute this approved Council work order"))return "SIMULATED BUILD: completed fixture work and tests. No real source files changed.";
    if(msg.content.includes("Council debate round"))return "AGREE: "+msg.content.split("CANDIDATE:\n")[1].split("\nCANDIDATE HASH:")[0];
    return "SIMULATED RESPONSE from "+member+": keep the plan narrow and verify it.";
  }});
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXE?{executablePath:process.env.BROWSER_EXE}:{channel:"msedge"})});
const report={date:new Date().toISOString(),providerMode:"simulated",checks:[],screenshots:[],consoleErrors:[]};
async function check(label,run){await run();report.checks.push(label);console.log("PASS "+label);}
async function status(page,text){await page.waitForFunction(value=>document.getElementById("workStatus").textContent.includes(value),text,{timeout:60000});}
try {
  for(const [name,viewport,mobile] of [["desktop",{width:1440,height:1100},false],["phone",{width:390,height:844},true]]) {
    const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile});
    const page=await context.newPage();page.on("pageerror",error=>report.consoleErrors.push(error.message));
    await page.goto(`${council.base}/#owner=${council.api.tokens.owner}`);
    await page.locator("#connectionStatus").filter({hasText:"Connected"}).waitFor();
    await check(name+": private link is scrubbed",async()=>assert.equal(new URL(page.url()).hash,""));
    await page.locator("#chamberTitle").fill("Release QA "+name);await page.locator("#createChamber").click();
    await page.waitForFunction(()=>!!document.getElementById("chamberSelect").value);
    await check(name+": directed conversation completes",async()=>{
      await page.locator("#say").fill("@codex draft @grok review @codex revise");await page.locator("#send").click();
      await page.waitForFunction(()=>{const text=document.getElementById("log").textContent;return (text.match(/SIMULATED RESPONSE from codex/g)||[]).length>=2&&text.includes("SIMULATED RESPONSE from grok");},null,{timeout:60000});
    });
    await page.locator("#workObjective").fill("Fixture acceptance: update a tiny module and show evidence");
    await page.locator("#workWorkspace").fill(workspace);await page.locator("#workPlanner").selectOption(name==="desktop"?"codex":"claude");
    await page.locator("#startWork").click();await status(page,"Plan ready");
    await check(name+": plan waits for approval",async()=>{assert.equal(council.api.store.prepare("SELECT COUNT(*) AS n FROM runs WHERE json_extract(checkpoint,'$.role')='build'").get().n,name==="desktop"?0:1);});
    await page.locator("#workFeedback").fill("Add explicit regression evidence to the plan.");await page.locator("#reviseWork").click();await status(page,"Plan ready");
    await page.locator("#approveWork").click();await status(page,"Review ready");
    await check(name+": plan, revision, coding, review and acceptance",async()=>{await page.locator("#acceptWork").click();await status(page,"Work accepted by you");});
    await check(name+": HALT survives reload and can be cleared",async()=>{
      await page.locator("#haltToggle").click();await page.waitForFunction(()=>document.getElementById("haltPill").textContent==="HALTED");
      await page.reload();await page.waitForFunction(()=>document.getElementById("haltPill").textContent==="HALTED");
      await page.locator("#haltToggle").click();await page.waitForFunction(()=>document.getElementById("haltPill").textContent==="running");
    });
    await check(name+": mobile-safe page width",async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:join(out,`${name}-fixture.png`),fullPage:true});report.screenshots.push(`${name}-fixture.png`);
    await check(name+": changing chambers clears old replies",async()=>{
      await page.locator("#chamberTitle").fill("Empty "+name);await page.locator("#createChamber").click();
      await page.waitForFunction(()=>!document.getElementById("log").textContent.includes("SIMULATED RESPONSE"));
    });
    await context.close();
  }
  assert.deepEqual(report.consoleErrors,[]);report.passed=true;
} catch(error) {report.passed=false;report.failure=error.stack;throw error;}
finally {
  writeFileSync(join(out,"browser-report.json"),JSON.stringify(report,null,2)+"\n");
  await browser.close();await council.close();rmSync(temporary,{recursive:true,force:true});
}
