import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {connection,argsFor,finalText,trustsWorkspace} from "../src/adapters/cursor.mjs";
test("Cursor requires activation, exact executable and explicit model",()=>{
  assert.equal(connection({}).reason,"cursor-not-enabled");
  assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1"}).reason,"cursor-model-required");
  assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"auto"}).ok,false);
  assert.equal(connection({COUNCIL_TEST_ONLY:"1",COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"fixture",COUNCIL_CURSOR_EXE:"agent"}).reason,"cursor-cli-required");
});
test("native Windows coding stays disconnected when containment is unavailable",()=>{
  if(process.platform==="win32")assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"fixture",COUNCIL_CURSOR_EXE:process.execPath}).reason,"cursor-windows-isolation-unavailable");
});
test("Cursor patch lane stays in Ask mode even when the Council role is build",()=>{
  const args=argsFor("author a patch",{cwd:"C:/isolated",model:"fixture",role:"build"});
  assert.equal(args[args.indexOf("--mode")+1],"ask");
});
test("Cursor command keeps sandbox and permissions enabled and pins the model",()=>{
  const args=argsFor("implement",{cwd:"C:/isolated",model:"fixture",role:"build"});
  assert.equal(args[args.indexOf("--sandbox")+1],"enabled");
  assert.equal(args[args.indexOf("--model")+1],"fixture");
  for(const flag of ["--force","--yolo","--approve-mcps","--trust"])assert.equal(args.includes(flag),false);
});
test("Cursor workspace trust is used only for an explicitly approved build in its exact directory",t=>{
  const cwd=realpathSync(mkdtempSync(join(tmpdir(),"council-cursor-trust-")));
  const other=realpathSync(mkdtempSync(join(tmpdir(),"council-cursor-other-")));
  t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});});
  const env={COUNCIL_CURSOR_TRUST_APPROVED:"1",COUNCIL_CURSOR_TRUST_WORKSPACE:cwd};
  const build=argsFor("patch",{cwd,model:"fixture",role:"build",trustApproved:true,env});
  const review=argsFor("review",{cwd,model:"fixture",role:"review",trustApproved:true,env});
  assert.equal(build.includes("--trust"),true);
  assert.equal(review.includes("--trust"),false);
  assert.equal(build[build.indexOf("--mode")+1],"ask");
  assert.equal(build.includes("--force"),false);
  assert.equal(trustsWorkspace(cwd,env),true);
  assert.equal(trustsWorkspace(other,env),false);
  assert.equal(trustsWorkspace(cwd,{COUNCIL_CURSOR_TRUST_APPROVED:"1"}),false);
  assert.equal(argsFor("patch",{cwd:other,model:"fixture",role:"build",trustApproved:true,env}).includes("--trust"),false);
});
test("Cursor reports require structured success, not arbitrary stdout",()=>{
  assert.equal(finalText({stdout:'{"type":"result","is_error":true,"result":"oops"}'}),"");
  assert.equal(finalText({stdout:"probably done"}),"");
  assert.equal(finalText({stdout:JSON.stringify({type:"result",subtype:"success",is_error:false,result:"evidence"})}),"evidence");
});
