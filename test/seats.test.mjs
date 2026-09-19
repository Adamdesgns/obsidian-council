import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {seatOf,seatIds,validateSeats} from "../src/seats.mjs";
import {loadOrCreateTokens} from "../src/tokens.mjs";
import {openStore} from "../src/store.mjs";
import {runsTodayForAccount,spawnMember} from "../src/adapters/spawn.mjs";
import {argsFor} from "../src/adapters/claude.mjs";
import {parseAddressChain} from "../src/routing.mjs";
test("seat resolves adapter/account; model can be passed explicitly; owner is never routable",()=>{
  assert.equal(seatOf("fable").adapter,"claude");
  assert.equal(seatOf("fable").account,seatOf("claude").account);
  assert.ok(argsFor("q",{model:"test-model"}).includes("test-model"));
  assert.deepEqual(parseAddressChain("@owner @fable @codex"),["fable","codex"]);
  assert.throws(()=>validateSeats([{id:"owner",adapter:"claude",account:"claude",role:"deliberator"}]));
});
test("token backfill preserves all existing credentials",t=>{
  const home=mkdtempSync(join(tmpdir(),"council-seats-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  writeFileSync(join(home,"tokens.json"),JSON.stringify({owner:"owner-token",members:{codex:"codex-token",claude:"claude-token"}}));
  const r=loadOrCreateTokens(home);
  assert.equal(r.owner,"owner-token");assert.equal(r.members.codex,"codex-token");
  assert.equal(Object.keys(r.members).length,seatIds().length);
  assert.deepEqual(loadOrCreateTokens(home),r);
});
test("fable and claude share the same enforced daily ceiling",async t=>{
  const home=mkdtempSync(join(tmpdir(),"council-account-")),store=openStore({home});
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  for(const member of ["claude","fable"])store.prepare("INSERT INTO runs(id,member,started) VALUES(?,?,?)").run(member,member,new Date().toISOString());
  assert.equal(runsTodayForAccount(store,"claude"),2);
  const fakePath=new URL("../src/testutil/fake-member.mjs",import.meta.url).pathname.replace(/^\/([A-Z]:)/i,"$1");
  const r=await spawnMember(store,"fable","q",{fakePath,limits:{daily_ceiling:{claude:2}}});
  assert.match(r.refused,/BUDGET/);
  assert.equal(runsTodayForAccount(store,"claude"),2,"refusals do not consume provider runs");
});
