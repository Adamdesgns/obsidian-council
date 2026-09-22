// Opt-in local quota reader. Only numeric quota metadata is returned.
import {openSync,closeSync,readSync,fstatSync,lstatSync,opendirSync} from "node:fs";
import {join} from "node:path";
export const DEFAULT_ENABLED=false,MAX_FILES=8,MAX_BYTES_PER_FILE=256*1024,MAX_TOTAL_BYTES=1024*1024,MAX_LINES_PER_FILE=2000;
const MAX_ENTRIES=4096;
export function isEnabled(env=process.env){return ["1","true"].includes(env.CODEX_LOCAL_USAGE_READER);}
const finite=v=>typeof v==="number"&&Number.isFinite(v);
function cleanRates(raw){
  if(!raw||typeof raw!=="object")return null;
  const out={};for(const k of ["used_percent","remaining_percent","window_minutes","resets_at"])if(finite(raw[k]))out[k]=raw[k];
  if(!finite(out.used_percent)&&!finite(out.remaining_percent))return null;
  if(out.resets_at!=null&&!Number.isFinite(new Date(out.resets_at*1000).getTime()))delete out.resets_at;
  return out;
}
export function extractTokenCountRates(event){
  const p=event?.type==="event_msg"?event.payload:event;
  if(p?.type!=="token_count"&&p?.kind!=="token_count")return null;
  if(p.rate_limits){const primary=cleanRates(p.rate_limits.primary),secondary=cleanRates(p.rate_limits.secondary);return primary||secondary?{primary,secondary}:null;}
  return cleanRates(p.rate_limit||p.rateLimit||p.rates);
}
function windowsFor(rates){
  return ("primary" in rates?Object.entries(rates):[["primary",rates]]).filter(([,r])=>r).map(([id,r])=>({
    id,label:r.window_minutes>0?r.window_minutes+" minutes":id,durationMinutes:r.window_minutes>0?r.window_minutes:null,
    usedPercent:r.used_percent,remainingPercent:r.remaining_percent,resetsAt:r.resets_at==null?null:new Date(r.resets_at*1000).toISOString(),
  }));
}
export function parseJsonlTokenCounts(text,{maxLines=MAX_LINES_PER_FILE,simulated=true}={}){
  if(typeof text!=="string")return null;let latest=null,latestMs=-Infinity;
  for(const line of text.split(/\r?\n/).slice(-maxLines)){
    if(!/"(?:type|kind)"\s*:\s*"token_count"/.test(line))continue;
    let e;try{e=JSON.parse(line);}catch{continue;}
    const rates=extractTokenCountRates(e);if(!rates)continue;
    const ms=typeof e.timestamp==="string"?Date.parse(e.timestamp):finite(e.timestamp)?(e.timestamp<1e12?e.timestamp*1000:e.timestamp):NaN;
    if(!Number.isFinite(ms)||!Number.isFinite(new Date(ms).getTime())||ms<latestMs)continue;
    latestMs=ms;latest={checkedAt:new Date(ms).toISOString(),rates,simulated,source:simulated?"simulated":"local"};
  }
  return latest;
}
export function readCodexLocalUsage({dir,env=process.env,simulated=true}={}){
  const result={enabled:isEnabled(env),snapshots:[],scannedFiles:0,scannedBytes:0};if(!result.enabled)return result;
  if(typeof dir!=="string"||!dir)return {...result,error:"no-dir"};
  const candidates=[];let entries=0;
  function visit(path,depth){
    if(entries>=MAX_ENTRIES||depth>4)return;
    let handle;const children=[];
    try{
      if(lstatSync(path).isSymbolicLink())return;
      handle=opendirSync(path);let entry;
      while(entries<MAX_ENTRIES&&(entry=handle.readSync())){entries++;children.push(entry);}
    }catch{return;}finally{if(handle)handle.closeSync();}
    children.sort((a,b)=>b.name.localeCompare(a.name));
    for(const entry of children){
      if(entry.isSymbolicLink())continue;const full=join(path,entry.name);
      if(entry.isDirectory()&&/^\d{2,4}$/.test(entry.name))visit(full,depth+1);
      else if(entry.isFile()&&entry.name.endsWith(".jsonl")&&(simulated||entry.name.startsWith("rollout-"))){
        try{const s=lstatSync(full);if(!s.isSymbolicLink())candidates.push({full,mtime:s.mtimeMs});}catch{}
      }
    }
  }
  visit(dir,0);candidates.sort((a,b)=>b.mtime-a.mtime);
  for(const file of candidates.slice(0,MAX_FILES)){
    if(result.scannedBytes>=MAX_TOTAL_BYTES)break;let fd;
    try{
      fd=openSync(file.full,"r");const size=fstatSync(fd).size,length=Math.min(size,MAX_BYTES_PER_FILE,MAX_TOTAL_BYTES-result.scannedBytes);
      const buffer=Buffer.alloc(length),start=size-length,read=readSync(fd,buffer,0,length,start);
      result.scannedFiles++;result.scannedBytes+=read;
      let text=buffer.subarray(0,read).toString("utf8");
      if(start>0){const nl=text.indexOf("\n");text=nl<0?"":text.slice(nl+1);}
      const snap=parseJsonlTokenCounts(text,{simulated});if(snap)result.snapshots.push(snap);
    }catch{}finally{if(fd!==undefined)closeSync(fd);}
  }
  result.snapshots.sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));return result;
}
export function codexLocalAdapter({dir,fixtureDir,env=process.env}={}){
  const simulated=fixtureDir!=null;
  return {async fetch(){
    const result=readCodexLocalUsage({dir:fixtureDir??dir,env,simulated});
    const base={accountId:"codex",service:"codex",sourceLabel:simulated?"Simulated · Codex local reader":"Codex local session metadata",checkedAt:null,pools:[]};
    if(!result.enabled)return {...base,status:"unavailable",reason:"Local usage reader is disabled."};
    const snap=result.snapshots[0];if(!snap)return {...base,status:"unavailable",reason:"No quota metadata found in the bounded scan."};
    return {...base,status:simulated?"simulated":"fresh",simulated,checkedAt:snap.checkedAt,
      pools:[{id:"codex-shared",label:"Codex account",modelIds:[],windows:windowsFor(snap.rates)}]};
  }};
}
