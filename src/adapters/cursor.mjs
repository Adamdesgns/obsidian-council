// Cursor's native CLI is opt-in. Never resolve the ambiguous `agent` on PATH:
// on Adam's PC that executable belongs to Grok.
import {existsSync,statSync} from "node:fs";
import {isAbsolute} from "node:path";
export function connection(env=process.env){
  const model=env.COUNCIL_CURSOR_MODEL||"";
  const exe=env.COUNCIL_CURSOR_EXE||"";
  const entrypoint=env.COUNCIL_CURSOR_ENTRYPOINT||"";
  if(env.COUNCIL_CURSOR_ENABLED!=="1")return {ok:false,reason:"cursor-not-enabled",model};
  if(!model||model==="auto")return {ok:false,reason:"cursor-model-required",model};
  // Verified with native 2026.09.18-9a7762b: Windows helper supplies a network
  // proxy, not filesystem isolation. Test mode cannot spawn a real provider.
  if(process.platform==="win32"&&env.COUNCIL_TEST_ONLY!=="1")return {ok:false,reason:"cursor-windows-isolation-unavailable",model};
  try{if(!isAbsolute(exe)||!exe.toLowerCase().endsWith(".exe")||!existsSync(exe)||!statSync(exe).isFile())return {ok:false,reason:"cursor-cli-required",model};}catch{return {ok:false,reason:"cursor-cli-required",model};}
  if(entrypoint){try{if(!isAbsolute(entrypoint)||! /\.(?:m?js)$/i.test(entrypoint)||!statSync(entrypoint).isFile())return {ok:false,reason:"cursor-entrypoint-required",model};}catch{return {ok:false,reason:"cursor-entrypoint-required",model};}}
  return {ok:true,exe,model,prefix:entrypoint?[entrypoint]:[]};
}
export function argsFor(packet,{cwd,model,role="review"}={}){
  if(!model)throw Error("Cursor requires an explicitly selected model");
  const prompt=typeof packet==="string"?packet:packet.prompt||packet.text||"";
  return ["--print","--output-format","json","--sandbox","enabled","--workspace",cwd,"--model",model,
    ...(role==="build"?[]:["--mode","ask"]),prompt];
}
function parsed(result){try{return JSON.parse(result?.stdout||"");}catch{return null;}}
export function finalText(result){const r=parsed(result);return r?.type==="result"&&r.subtype==="success"&&r.is_error===false&&typeof r.result==="string"?r.result:"";}
export function sessionOf(result){return parsed(result)?.session_id||null;}
export function usageOf(){return {};}
