// src/usage/codex-local-reader.mjs — OPTIONAL Codex local-session usage reader.
// Default OFF. Reads only token_count rate-limit metadata from synthetic JSONL
// fixtures (or bounded files when activated). Never logs conversation text,
// auth files, account identifiers, or paths.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ENABLED = false;
export const MAX_FILES = 8;
export const MAX_BYTES_PER_FILE = 256 * 1024;
export const MAX_TOTAL_BYTES = 1 * 1024 * 1024;
export const MAX_LINES_PER_FILE = 2_000;

const ALLOWED_RATE_KEYS = new Set([
  "used_percent", "remaining_percent", "window_minutes", "resets_at",
  "limit", "used", "remaining", "plan_type",
  "usedPercent", "remainingPercent", "windowMinutes", "resetsAt",
]);

export function isEnabled(env = process.env) {
  return env.CODEX_LOCAL_USAGE_READER === "1" || env.CODEX_LOCAL_USAGE_READER === "true";
}

export function extractTokenCountRates(event) {
  if (!event || (event.type !== "token_count" && event.kind !== "token_count")) return null;
  const src = event.rate_limit || event.rateLimit || event.rates || event.info || {};
  const out = {};
  for (const k of Object.keys(src)) {
    if (ALLOWED_RATE_KEYS.has(k)) out[k] = src[k];
  }
  return Object.keys(out).length ? out : null;
}

function eventTimestampMs(event) {
  if (!event) return NaN;
  if (typeof event.timestamp === "string") {
    const ms = Date.parse(event.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
    // epoch seconds vs ms
    return event.timestamp < 1e12 ? event.timestamp * 1000 : event.timestamp;
  }
  return NaN;
}

function ratesToWindows(rates, now) {
  const used = rates.used_percent ?? rates.usedPercent;
  const remaining = rates.remaining_percent ?? rates.remainingPercent;
  const windowMin = rates.window_minutes ?? rates.windowMinutes;
  const resetsAt = rates.resets_at ?? rates.resetsAt;
  const windows = [];
  if (used != null || remaining != null || windowMin != null) {
    windows.push({
      id: "session",
      label: windowMin ? `${windowMin} minutes` : "Session",
      durationMinutes: typeof windowMin === "number" ? windowMin : null,
      usedPercent: typeof used === "number" ? used : undefined,
      remainingPercent: typeof remaining === "number" ? remaining : undefined,
      resetsAt: typeof resetsAt === "string" ? resetsAt
        : typeof resetsAt === "number" ? new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt).toISOString()
        : undefined,
    });
  }
  return windows;
}

/** Scan JSONL content (string). Returns latest valid token_count snapshot or null. */
export function parseJsonlTokenCounts(text, { maxLines = MAX_LINES_PER_FILE } = {}) {
  if (typeof text !== "string") return null;
  let latest = null;
  let latestMs = -Infinity;
  const lines = text.split(/\r?\n/).slice(0, maxLines);
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const rates = extractTokenCountRates(event);
    if (!rates) continue;
    const ms = eventTimestampMs(event);
    if (!Number.isFinite(ms)) continue;
    if (ms >= latestMs) {
      latestMs = ms;
      latest = { checkedAt: new Date(ms).toISOString(), rates, simulated: true, source: "simulated" };
    }
  }
  return latest;
}

/**
 * Read usage from a directory of JSONL files. Default-off via isEnabled.
 * Never returns paths in the snapshot. Caps files/bytes/lines.
 */
export function readCodexLocalUsage({
  dir,
  env = process.env,
  now = Date.now(),
} = {}) {
  if (!isEnabled(env)) {
    return { enabled: false, snapshots: [], scannedFiles: 0, scannedBytes: 0 };
  }
  if (!dir || typeof dir !== "string") {
    return { enabled: true, snapshots: [], scannedFiles: 0, scannedBytes: 0, error: "no-dir" };
  }
  let names;
  try { names = readdirSync(dir); } catch {
    return { enabled: true, snapshots: [], scannedFiles: 0, scannedBytes: 0, error: "dir-unreadable" };
  }
  const files = names.filter(n => n.endsWith(".jsonl")).slice(0, MAX_FILES);
  let scannedBytes = 0;
  const snapshots = [];
  let scannedFiles = 0;
  for (const name of files) {
    if (scannedBytes >= MAX_TOTAL_BYTES) break;
    const full = join(dir, name);
    let size;
    try { size = statSync(full).size; } catch { continue; }
    if (size > MAX_BYTES_PER_FILE) continue;
    if (scannedBytes + size > MAX_TOTAL_BYTES) break;
    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    scannedFiles += 1;
    scannedBytes += text.length;
    const snap = parseJsonlTokenCounts(text);
    if (snap) snapshots.push(snap);
  }
  // Prefer latest across files
  snapshots.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  return { enabled: true, snapshots, scannedFiles, scannedBytes };
}

/** Adapter factory for createUsageService — only when env gate is on + fixtureDir set. */
export function codexLocalAdapter({ fixtureDir, env = process.env } = {}) {
  return {
    async fetch(now) {
      const result = readCodexLocalUsage({ dir: fixtureDir, env, now });
      if (!result.enabled) {
        return {
          accountId: "codex", service: "codex", status: "unavailable",
          sourceLabel: "Codex local reader (off)",
          reason: "CODEX_LOCAL_USAGE_READER is not enabled.",
          checkedAt: null, pools: [],
        };
      }
      const snap = result.snapshots[0];
      if (!snap) {
        return {
          accountId: "codex", service: "codex", status: "unavailable",
          sourceLabel: "Codex local reader",
          reason: "No token_count events found in bounded scan.",
          checkedAt: null, pools: [],
        };
      }
      return {
        accountId: "codex",
        service: "codex",
        status: "simulated",
        sourceLabel: "Simulated · Codex local-session reader",
        checkedAt: snap.checkedAt,
        pools: [{
          id: "codex-local",
          label: "Codex local session",
          modelIds: [],
          windows: ratesToWindows(snap.rates, now),
        }],
      };
    },
  };
}
