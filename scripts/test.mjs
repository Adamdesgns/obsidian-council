// Enforce fake-only provider execution for the entire suite, including subprocesses.
import {spawnSync} from "node:child_process";
import {readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const tests=readdirSync(new URL("../test/",import.meta.url)).filter(f=>f.endsWith(".test.mjs")).map(f=>"test/"+f);
const r=spawnSync(process.execPath,["--test",...tests],{
  cwd:root,env:{...process.env,COUNCIL_TEST_ONLY:"1",CODEX_LOCAL_USAGE_READER:"0",COUNCIL_CURSOR_ENABLED:"0"},stdio:"inherit",windowsHide:true,
});
if(r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
