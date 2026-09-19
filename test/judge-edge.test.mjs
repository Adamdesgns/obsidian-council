import test from "node:test";
import assert from "node:assert/strict";
import {createJudge} from "../src/judge.mjs";
const input={received:"Review authentication",reply:"ok"};
test("malformed choices/confidence and UNCLEAR always escalate",async()=>{
  for(const [choice,confidence] of [["INVALID",.99],["RESPONSIVE","oops"],["RESPONSIVE",2],["RESPONSIVE",NaN],["UNCLEAR",1]]){
    const r=await createJudge({jev:{evaluate:async()=>({responsive:{choice,confidence}})}}).judge(input);
    assert.equal(r.decision,"UNCLEAR");assert.equal(r.escalate,true);assert.ok(Number.isFinite(r.confidence));
  }
});
test("injected client rejection and timeout return diagnostic uncertainty",async()=>{
  for(const evaluate of [async()=>{throw Error("offline")},()=>new Promise(()=>{})]){
    const r=await createJudge({jev:{evaluate},timeoutMs:10}).judge(input);
    assert.equal(r.decision,"UNCLEAR");assert.equal(r.escalate,true);assert.equal(r.rule,"client_error");
  }
});
test("quoted and conditional absence abstains, with no client or key",async()=>{
  for(const reply of ['The fallback correctly shows "no plan was provided" when input is empty.',"If no plan was provided, show the empty state."]){
    const r=await createJudge().judge({received:"Review the fallback plan for missing input.",reply});
    assert.equal(r.decision,"UNCLEAR");assert.equal(r.escalate,true);
  }
});
