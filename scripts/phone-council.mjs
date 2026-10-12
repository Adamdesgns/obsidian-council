// Bind Council successfully before making any change to the private proxy.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startCouncil } from "../src/council.mjs";

function configureServe(base) {
  const result=spawnSync(process.env.COUNCIL_TAILSCALE_EXE || "C:\\Program Files\\Tailscale\\tailscale.exe",
    ["serve","--bg","--yes",base],{encoding:"utf8",windowsHide:true,timeout:30000});
  if(result.error || result.status!==0)throw new Error("Tailscale Serve could not start. Council has stopped; check your Tailscale setup.");
}
export async function startPhoneCouncil({councilOptions={},serve=configureServe,log=console.log}={}) {
  const lines=[];
  const council=await startCouncil({...councilOptions,log:line=>lines.push(line)});
  try {await serve(council.base);} catch(error) {await council.close();throw error;}
  for(const line of lines)log(line);
  return council;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const council=await startPhoneCouncil();
  const stop=()=>council.close().then(()=>process.exit(0));
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
