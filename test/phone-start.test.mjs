import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startPhoneCouncil } from "../scripts/phone-council.mjs";

test("phone proxy is configured only after Council owns a working port",async()=>{
  const home=mkdtempSync(join(tmpdir(),"council-phone-start-"));let configured=false;
  const c=await startPhoneCouncil({councilOptions:{home,port:0,useFake:true},log:()=>{},serve:async base=>{assert.equal((await fetch(base)).status,200);configured=true;}});
  try {assert.equal(configured,true);} finally {await c.close();rmSync(home,{recursive:true,force:true});}
});
test("an occupied Council port cannot cause a proxy change",async()=>{
  const server=http.createServer((_req,res)=>res.end("unrelated app"));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const home=mkdtempSync(join(tmpdir(),"council-phone-busy-"));let changed=false;
  try {
    await assert.rejects(()=>startPhoneCouncil({councilOptions:{home,port:server.address().port,useFake:true},serve:()=>{changed=true;},log:()=>{}}),/EADDRINUSE/);
    assert.equal(changed,false);
  }finally {await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});}
});
