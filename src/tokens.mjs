// src/tokens.mjs — owner + member bearer tokens under COUNCIL_HOME/tokens.json
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { councilHome, ensureHome } from "./home.mjs";
import { seatIds } from "./seats.mjs";

export function tokensPath(home = councilHome()) {
  return join(home, "tokens.json");
}

/**
 * Load tokens.json, minting whatever is missing: the owner token on a fresh
 * home, and a member token for every seat in seats.mjs. A seat added after
 * first run (fable) would otherwise have no token on any existing home and be
 * mute: prepareBridge returns a no-op and identityFromToken never resolves it.
 *
 * Existing tokens are never changed. A file that exists but cannot be read as
 * a JSON object is refused, not overwritten: silently minting a new owner token
 * would destroy the owner's link and every member identity in one step.
 */
export function loadOrCreateTokens(home = councilHome()) {
  ensureHome(home);
  const path = tokensPath(home);

  let tokens = null;
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    try {
      tokens = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${path}: tokens.json is not valid JSON (${e.message}); refusing to overwrite it`);
    }
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
      throw new Error(`${path}: tokens.json is not an object; refusing to overwrite it`);
    }
  } else {
    tokens = { owner: null, members: {}, created: new Date().toISOString() };
  }
  if (!tokens.members || typeof tokens.members !== "object" || Array.isArray(tokens.members)) tokens.members = {};

  let changed = false;
  if (!tokens.owner) { tokens.owner = randomBytes(32).toString("hex"); changed = true; }
  for (const id of seatIds()) {
    if (!tokens.members[id]) {
      tokens.members[id] = randomBytes(32).toString("hex");
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* windows may ignore */ }
  }
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