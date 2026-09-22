import test from "node:test";
import assert from "node:assert/strict";
import {connection,argsFor,finalText} from "../src/adapters/cursor.mjs";
test("Cursor requires activation, exact executable and explicit model",()=>{
  assert.equal(connection({}).reason,"cursor-not-enabled");
  assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1"}).reason,"cursor-model-required");
  assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"auto"}).ok,false);
  assert.equal(connection({COUNCIL_TEST_ONLY:"1",COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"fixture",COUNCIL_CURSOR_EXE:"agent"}).reason,"cursor-cli-required");
});
test("native Windows coding stays disconnected when containment is unavailable",()=>{
  if(process.platform==="win32")assert.equal(connection({COUNCIL_CURSOR_ENABLED:"1",COUNCIL_CURSOR_MODEL:"fixture",COUNCIL_CURSOR_EXE:process.execPath}).reason,"cursor-windows-isolation-unavailable");
});
test("Cursor command keeps sandbox and permissions enabled and pins the model",()=>{
  const args=argsFor("implement",{cwd:"C:/isolated",model:"fixture",role:"build"});
  assert.equal(args[args.indexOf("--sandbox")+1],"enabled");
  assert.equal(args[args.indexOf("--model")+1],"fixture");
  for(const flag of ["--force","--yolo","--approve-mcps","--trust"])assert.equal(args.includes(flag),false);
});
test("Cursor reports require structured success, not arbitrary stdout",()=>{
  assert.equal(finalText({stdout:'{"type":"result","is_error":true,"result":"oops"}'}),"");
  assert.equal(finalText({stdout:"probably done"}),"");
  assert.equal(finalText({stdout:JSON.stringify({type:"result",subtype:"success",is_error:false,result:"evidence"})}),"evidence");
});
