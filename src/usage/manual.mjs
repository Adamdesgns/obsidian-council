// Owner-entered allowance for providers without a verified account reader.
// This is never presented as a live provider measurement.
import {readFileSync,writeFileSync,renameSync,mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";

const ALLOWED = new Set(["cursor","grok"]);
const TTL_MS = 60 * 60_000;

export function createManualUsage({file,clock=Date.now}) {
  function readAll() {
    try {const value=JSON.parse(readFileSync(file,"utf8"));return value&&typeof value==="object"?value:{};}
    catch{return {};}
  }
  function get(service) {
    if(!ALLOWED.has(service))return null;
    const value=readAll()[service];
    if(!value || typeof value.remainingPercent!=="number" || value.remainingPercent<0 || value.remainingPercent>100 ||
      !Number.isFinite(value.checkedAt) || clock()-value.checkedAt>=TTL_MS || value.checkedAt>clock()+60_000)return null;
    return {accountId:service,service,status:"manual",sourceLabel:"Owner-entered reading",
      reason:"Manual reading; expires one hour after entry.",checkedAt:new Date(value.checkedAt).toISOString(),
      pools:[{id:service+"-manual",label:"Account allowance",modelIds:[],windows:[{
        id:"manual",label:"Account allowance",durationMinutes:null,remainingPercent:value.remainingPercent,
        resetsAt:value.resetsAt||null,
      }]}]};
  }
  function set({service,remainingPercent,resetsAt=null}) {
    if(!ALLOWED.has(service))return {ok:false,reason:"manual-service-refused"};
    if(remainingPercent===null){const all=readAll();delete all[service];save(all);return {ok:true};}
    if(typeof remainingPercent!=="number" || !Number.isFinite(remainingPercent) ||remainingPercent<0||remainingPercent>100)
      return {ok:false,reason:"manual-percent-invalid"};
    if(resetsAt!==null && (typeof resetsAt!=="string" || !Number.isFinite(Date.parse(resetsAt)) ||
      Date.parse(resetsAt)<=clock()))return {ok:false,reason:"manual-reset-invalid"};
    const all=readAll();all[service]={remainingPercent,checkedAt:clock(),resetsAt:resetsAt?new Date(resetsAt).toISOString():null};
    save(all);return {ok:true};
  }
  function save(all) {
    mkdirSync(dirname(file),{recursive:true});
    const temp=file+"."+randomUUID()+".tmp";
    writeFileSync(temp,JSON.stringify(all));renameSync(temp,file);
  }
  return {get,set};
}
