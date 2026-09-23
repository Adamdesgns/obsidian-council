// Read-only Claude account allowance via the signed-in Claude Code credential.
// The local credential is used only in the request header. It is never returned
// to the Council API, written to a log, or refreshed by an inference call.
import {readFileSync,lstatSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";

const URL = "https://api.anthropic.com/api/oauth/usage";
const unavailable = reason => ({
  accountId:"claude",service:"claude",status:"unavailable",sourceLabel:"Claude Code local sign-in",
  reason,checkedAt:null,pools:[],
});
const validPercent = value => typeof value==="number" && Number.isFinite(value) && value>=0 && value<=100;

export function claudeUsagePath(env=process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || homedir(),".claude"),".credentials.json");
}

export function parseClaudeUsage(data,checkedAt) {
  const windows=[];
  for(const [key,id,label,minutes] of [
    ["five_hour","five-hour","5 hours",300],
    ["seven_day","weekly","7 days",10080],
  ]) {
    const bucket=data?.[key];
    if(!validPercent(bucket?.utilization))continue;
    const reset=typeof bucket.resets_at==="string" && Number.isFinite(Date.parse(bucket.resets_at))
      ? new Date(bucket.resets_at).toISOString():null;
    windows.push({id,label,durationMinutes:minutes,usedPercent:bucket.utilization,resetsAt:reset});
  }
  if(!windows.length)return unavailable("Claude did not report a usable allowance.");
  return {accountId:"claude",service:"claude",status:"fresh",sourceLabel:"Claude Code signed-in usage",
    checkedAt,pools:[{id:"claude-shared",label:"Claude account",modelIds:[],windows}]};
}

export function claudeLocalAdapter({env=process.env,fetcher=globalThis.fetch,clock=Date.now}={}) {
  return {async fetch() {
    if(env.CLAUDE_LOCAL_USAGE_READER!=="1")return unavailable("Local Claude usage reader is disabled.");
    let auth;
    try {
      const path=claudeUsagePath(env);
      if(lstatSync(path).isSymbolicLink())return unavailable("Claude sign-in source is unavailable.");
      const oauth=JSON.parse(readFileSync(path,"utf8")).claudeAiOauth;
      if(typeof oauth?.accessToken!=="string" || !oauth.accessToken)return unavailable("Claude Code is not signed in.");
      if(typeof oauth.expiresAt==="number" && oauth.expiresAt<=clock()+60_000)return unavailable("Claude Code sign-in needs renewal.");
      auth=oauth.accessToken;
    } catch {return unavailable("Claude Code sign-in source is unavailable.");}
    try {
      const response=await fetcher(URL,{headers:{Authorization:"Bearer "+auth,"anthropic-beta":"oauth-2025-04-20"},signal:AbortSignal.timeout(10000)});
      auth=null;
      if(!response.ok)return unavailable(response.status===401||response.status===403?"Claude Code sign-in needs renewal.":"Claude usage endpoint is unavailable.");
      return parseClaudeUsage(await response.json(),new Date(clock()).toISOString());
    } catch {return unavailable("Claude usage endpoint is unavailable.");}
  }};
}
