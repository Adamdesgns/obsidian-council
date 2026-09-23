import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {applyWorkerPatch,inspectPatch} from "../src/patch-worker.mjs";

test("checked patch changes one text file and records its hash",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"answer.mjs"),"export const answer = 1;\n");
  const reply=[
    "diff --git a/answer.mjs b/answer.mjs",
    "--- a/answer.mjs",
    "+++ b/answer.mjs",
    "@@ -1 +1 @@",
    "-export const answer = 1;",
    "+export const answer = 2;",
    "END PATCH",
    "Changed the answer.",
  ].join("\n");
  const result=applyWorkerPatch(root,reply);
  assert.equal(result.ok,true);
  assert.deepEqual(result.paths,["answer.mjs"]);
  assert.equal(readFileSync(join(root,"answer.mjs"),"utf8").replace(/\r\n/g,"\n"),"export const answer = 2;\n");
  assert.match(result.hashes["answer.mjs"],/^[a-f0-9]{64}$/);
});

test("patch worker rejects path escape, symlink mode and stale context",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"answer.mjs"),"one\n");
  const escape="diff --git a/../other b/../other\n--- a/../other\n+++ b/../other\n@@ -1 +1 @@\n-x\n+y\n";
  assert.throws(()=>inspectPatch(root,escape),/patch-path-refused/);
  for (const name of ["CON.txt","folder./answer.mjs",".GIT/config",".ENV/private"]) {
    const unsafe=`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-x\n+y\n`;
    assert.throws(()=>inspectPatch(root,unsafe),/patch-path-refused/);
  }
  const symlink="diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+other\n";
  assert.equal(applyWorkerPatch(root,symlink).ok,false);
  const stale="diff --git a/answer.mjs b/answer.mjs\n--- a/answer.mjs\n+++ b/answer.mjs\n@@ -1 +1 @@\n-missing\n+two\n";
  assert.equal(applyWorkerPatch(root,stale).ok,false);
  assert.equal(readFileSync(join(root,"answer.mjs"),"utf8"),"one\n");
});
