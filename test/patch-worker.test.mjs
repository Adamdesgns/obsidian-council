import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
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
  for (const name of ["CON.txt","folder./answer.mjs",".GIT/config",".ENV/private",".env.local",".env.production"]) {
    const unsafe=`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-x\n+y\n`;
    assert.throws(()=>inspectPatch(root,unsafe),/patch-path-refused/);
  }
  const symlink="diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+other\n";
  assert.equal(applyWorkerPatch(root,symlink).ok,false);
  const stale="diff --git a/answer.mjs b/answer.mjs\n--- a/answer.mjs\n+++ b/answer.mjs\n@@ -1 +1 @@\n-missing\n+two\n";
  assert.equal(applyWorkerPatch(root,stale).ok,false);
  assert.equal(readFileSync(join(root,"answer.mjs"),"utf8"),"one\n");
});

test("an appended traditional diff cannot edit an uninspected protected file",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"safe.txt"),"one\n");
  writeFileSync(join(root,".env"),"secret=old\n");
  const safe="diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-one\n+two\n";
  const hidden="--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-secret=old\n+secret=overwritten\n";
  for(const prefix of ["",'diff --git "a/.env" "b/.env"\n']) {
    assert.equal(applyWorkerPatch(root,safe+prefix+hidden).ok,false);
    assert.equal(readFileSync(join(root,"safe.txt"),"utf8"),"one\n");
    assert.equal(readFileSync(join(root,".env"),"utf8"),"secret=old\n");
  }
});

test("complete patch parsing supports multiple files, context and no-newline markers",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"existing.txt"),"keep\nbefore");
  const patch=[
    "diff --git a/existing.txt b/existing.txt","index 1234567..7654321 100644",
    "--- a/existing.txt","+++ b/existing.txt","@@ -1,2 +1,3 @@",
    " keep","-before","\\ No newline at end of file","+after","+--- text, not another patch",
    "diff --git a/new.txt b/new.txt","new file mode 100644","index 0000000..1234567",
    "--- /dev/null","+++ b/new.txt","@@ -0,0 +1 @@","+added","",
  ].join("\n");
  const result=applyWorkerPatch(root,patch);
  assert.equal(result.ok,true,result.reason);
  assert.deepEqual(result.paths,["existing.txt","new.txt"]);
  assert.equal(readFileSync(join(root,"existing.txt"),"utf8").replace(/\r\n/g,"\n"),"keep\nafter\n--- text, not another patch\n");
  assert.equal(readFileSync(join(root,"new.txt"),"utf8").trim(),"added");
});

test("patch extraction preserves a trailing unchanged empty context line",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-context-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"context.txt"),"one\n\n");
  const patch="diff --git a/context.txt b/context.txt\n--- a/context.txt\n+++ b/context.txt\n@@ -1,2 +1,2 @@\n-one\n+two\n \nEND PATCH\nReport";
  const result=applyWorkerPatch(root,patch);
  assert.equal(result.ok,true,result.reason);
  assert.equal(readFileSync(join(root,"context.txt"),"utf8").replace(/\r\n/g,"\n"),"two\n\n");
});

test("patch parser rejects incomplete hunks and Windows path aliases",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const patch=name=>`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-one\n+two\n`;
  assert.throws(()=>inspectPatch(root,patch("safe.txt").replace("@@ -1 +1 @@","@@ -1,2 +1 @@")),/patch-hunk-refused/);
  assert.throws(()=>inspectPatch(root,patch("safe\t.txt")),/patch-path-refused/);
  if(process.platform==="win32")assert.throws(()=>inspectPatch(root,patch("safe.txt")+patch("SAFE.txt")),/patch-duplicate-refused/);
});

test("patches apply inside an approved Git subdirectory instead of silently skipping it",t=>{
  const root=mkdtempSync(join(tmpdir(),"council-patch-git-")),workspace=join(root,"nested app");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const init=spawnSync("git",["init","--quiet"],{cwd:root,encoding:"utf8",windowsHide:true});
  assert.equal(init.status,0,init.stderr);
  mkdirSync(workspace);
  writeFileSync(join(root,"same.txt"),"outside approved workspace\n");
  writeFileSync(join(workspace,"same.txt"),"one\n");
  const result=applyWorkerPatch(workspace,"diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-one\n+two\n");
  assert.equal(result.ok,true,result.reason);
  assert.equal(readFileSync(join(workspace,"same.txt"),"utf8").replace(/\r\n/g,"\n"),"two\n");
  assert.equal(readFileSync(join(root,"same.txt"),"utf8"),"outside approved workspace\n");
});
