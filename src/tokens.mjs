// src/tokens.mjs — owner + member bearer tokens under COUNCIL_HOME/tokens.json
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { councilHome, ensureHome } from "./home.mjs";

const MEMBERS = ["claude", "codex", "grok"];

export function tokensPath(home = councilHome()) {
  return join(home, "tokens.json");
}

export function loadOrCreateTokens(home = councilHome()) {
  ensureHome(home);
  const path = tokensPath(home);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const tokens = {
    owner: randomBytes(32).toString("hex"),
    members: Object.fromEntries(MEMBERS.map((m) => [m, randomBytes(32).toString("hex")])),
    created: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* windows may ignore */ }
  return tokens;
}

/** Resolve Authorization bearer to { role, member? } or null. */
export function identityFromToken(tokens, bearer) {
  if (!bearer) return null;
  const t = String(bearer).trim();
  if (!t) return null;
  if (t === tokens.owner) return { role: "owner", member: "owner" };
  for (const [member, tok] of Object.entries(tokens.members || {})) {
    if (tok === t) return { role: "member", member };
  }
  return null;
}

export function parseBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}