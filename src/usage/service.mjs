// src/usage/service.mjs — remaining subscription allowance, per account, for the Floor.
//
// This is NOT the Council's own daily run ceiling (adapters/spawn.mjs). A run
// count is never turned into a subscription percentage here.
//
// Every source is an injected adapter: { async fetch(now) -> raw account }.
// Whatever an adapter returns is untrusted and goes through normalizeAccount.
// Whatever an adapter THROWS is dropped: provider error text never reaches a
// response. Timestamps are ISO 8601 UTC strings, or null when unknown.
import { fixtureAdapters } from "./fixtures.mjs";
import { unconnectedAdapters, SERVICES } from "./sources.mjs";
import {createManualUsage} from "./manual.mjs";

const STATUSES = ["fresh", "stale", "unavailable", "manual", "simulated"];
const LOW_PERCENT = 20;
const MAX_BACKOFF_MS = 15 * 60_000;

function cleanText(value, max = 120) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[A-Za-z]:\\\S+/g, "[path]")
    .replace(/(?:~|\/(?:Users|home))\/\S+/g, "[path]")
    .replace(/\S+@\S+\.\S+/g, "[account]")
    .trim()
    .slice(0, max);
}

function cleanId(value, fallback) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^[\w.-]{1,64}$/.test(s) ? s : fallback;
}

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function percentOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function normalizeWindow(raw, index, now) {
  const w = raw && typeof raw === "object" ? raw : {};
  const used = percentOrNull(w.usedPercent);
  const remaining = percentOrNull(w.remainingPercent) ?? (used == null ? null : 100 - used);
  const resetsAt = isoOrNull(w.resetsAt);
  const duration = typeof w.durationMinutes === "number" && Number.isFinite(w.durationMinutes) && w.durationMinutes > 0
    ? Math.round(w.durationMinutes) : null;
  return {
    id: cleanId(w.id, "window-" + index),
    label: cleanText(w.label, 40) || "Window",
    durationMinutes: duration,
    remainingPercent: remaining == null ? null : Math.round(remaining * 10) / 10,
    display: remaining == null ? "unknown" : remaining === 0 ? "zero" : remaining <= LOW_PERCENT ? "low" : "ok",
    resetsAt,
    // A reset time in the past means the reading is out of date. It is NOT
    // proof the allowance came back, so the number is left as reported.
    refreshDue: resetsAt != null && Date.parse(resetsAt) <= now,
  };
}

export function normalizeAccount(raw, now = Date.now()) {
  const a = raw && typeof raw === "object" ? raw : {};
  const service = cleanId(a.service, "unknown");
  const pools = new Map();
  for (const [i, rawPool] of (Array.isArray(a.pools) ? a.pools : []).entries()) {
    const p = rawPool && typeof rawPool === "object" ? rawPool : {};
    const id = cleanId(p.id, "pool-" + i);
    // Same pool id = one shared quota. Merge instead of drawing it twice.
    const pool = pools.get(id) || { id, label: cleanText(p.label, 40), modelIds: [], windows: [] };
    for (const m of Array.isArray(p.modelIds) ? p.modelIds : []) {
      const model = cleanId(m, null);
      if (model && !pool.modelIds.includes(model)) pool.modelIds.push(model);
    }
    for (const [j, rawWindow] of (Array.isArray(p.windows) ? p.windows : []).entries()) {
      const w = normalizeWindow(rawWindow, pool.windows.length + j, now);
      if (!pool.windows.some(x => x.id === w.id)) pool.windows.push(w);
    }
    pools.set(id, pool);
  }
  return {
    accountId: cleanId(a.accountId, service),
    service,
    status: STATUSES.includes(a.status) ? a.status : "unavailable",
    sourceLabel: cleanText(a.sourceLabel, 80) || "Unknown source",
    reason: cleanText(a.reason, 160) || null,
    checkedAt: isoOrNull(a.checkedAt),
    simulated: a.simulated === true || a.status === "simulated",
    pools: [...pools.values()],
  };
}


/** Age a normalized account from its own checkedAt. maxAgeMs currently only
 *  drove refresh scheduling; an adapter could return an old checkedAt still
 *  marked fresh. Source-timestamp freshness closes that gap. */
export function ageAccount(account, now = Date.now(), maxAgeMs = 5 * 60_000) {
  if (!account || account.status === "unavailable") return account;
  account = {...account, pools: account.pools.map(p => ({...p, windows:p.windows.map(w => ({...w,
    refreshDue:w.resetsAt != null && Date.parse(w.resetsAt) <= now,
  }))}))};
  if(account.pools.some(p=>p.windows.some(w=>w.refreshDue)))return {...account,status:"stale",reason:"Reset time passed; refresh the source before trusting this reading."};
  const checkedMs = account.checkedAt ? Date.parse(account.checkedAt) : NaN;
  if(checkedMs > now + 60_000)return {...account,status:"stale",reason:"Source timestamp is in the future."};
  if (!Number.isFinite(checkedMs)) {
    if (account.status === "fresh" || account.status === "simulated" || account.status === "manual") {
      return {
        ...account,
        status: "stale",
        reason: account.reason || "Reading has no usable timestamp.",
      };
    }
    return account;
  }
  if (now - checkedMs > maxAgeMs && (account.status === "fresh" || account.status === "simulated" || account.status === "manual")) {
    return {
      ...account,
      status: "stale",
      reason: account.reason || "Reading older than freshness window; showing last good data.",
    };
  }
  return account;
}

function unavailableAccount(service, reason) {
  return { accountId: service, service, status: "unavailable", sourceLabel: "Not connected", reason, checkedAt: null, pools: [] };
}

export function createUsageService(opts = {}) {
  const fixtureMode = opts.fixtureMode === true;
  const clock = opts.clock || Date.now;
  const minRefreshMs = opts.minRefreshMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  // Fixture data is opt-in only. Without the flag an unconfigured Council
  // reports every service as unavailable; it never falls back to a demo.
  const adapters = opts.adapters || (fixtureMode ? fixtureAdapters() : unconnectedAdapters());
  const manual = !fixtureMode && opts.manualPath ? createManualUsage({file:opts.manualPath,clock}) : null;
  const services = [...new Set([...SERVICES, ...Object.keys(adapters)])];
  const cache = new Map();   // service -> last normalized account
  const sources = new Map(); // service -> { failures, nextAttemptAt }
  let lastRefreshAt = null;
  let inFlight = null;

  function asSimulated(account) {
    if (!fixtureMode || account.status === "unavailable") return account;
    return {
      ...account,
      simulated: true,
      status: account.status === "fresh" ? "simulated" : account.status,
      sourceLabel: /simulated/i.test(account.sourceLabel) ? account.sourceLabel : "Simulated · " + account.sourceLabel,
    };
  }

  async function refreshOne(service, now) {
    const src = sources.get(service) || { failures: 0, nextAttemptAt: 0 };
    sources.set(service, src);
    if (now < src.nextAttemptAt) return;
    const adapter = adapters[service];
    try {
      if (!adapter || typeof adapter.fetch !== "function") throw new Error("no adapter");
      const account = asSimulated(normalizeAccount({ ...(await adapter.fetch(now)), service }, now));
      cache.set(service, account);
      src.failures = 0;
      src.nextAttemptAt = 0;
    } catch {
      // The thrown error is deliberately not recorded anywhere a client can read.
      src.failures += 1;
      src.nextAttemptAt = now + Math.min(MAX_BACKOFF_MS, minRefreshMs * 2 ** src.failures);
      const last = cache.get(service);
      if (last && last.status !== "unavailable") {
        cache.set(service, { ...last, status: "stale", reason: "Last refresh failed; showing the last good reading." });
      } else {
        cache.set(service, asSimulated(normalizeAccount(unavailableAccount(service, "Source could not be read."), now)));
      }
    }
  }

  function refreshAll() {
    if (!inFlight) {
      const now = clock();
      lastRefreshAt = now;
      inFlight = Promise.all(services.map(s => refreshOne(s, now))).finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  async function read({ refresh = false } = {}) {
    const now = clock();
    const age = lastRefreshAt == null ? Infinity : now - lastRefreshAt;
    let throttled = false;
    if (inFlight) await inFlight;
    else if (lastRefreshAt == null || (refresh ? age >= minRefreshMs : age >= Math.max(maxAgeMs, minRefreshMs))) await refreshAll();
    else if (refresh) throttled = true;
    const now2 = clock();
    const accounts = services.map(s => {
      const account=cache.get(s);
      return account?.status==="unavailable" && manual?.get(s) || account;
    }).filter(Boolean).map(a => ageAccount(a, now2, a.status==="manual"?60*60_000:maxAgeMs));
    return {
      mode: fixtureMode ? "simulated" : accounts.some(a => a.status !== "unavailable") ? "connected" : "unconnected",
      throttled,
      servedAt: new Date(clock()).toISOString(),
      lastRefreshAt: lastRefreshAt == null ? null : new Date(lastRefreshAt).toISOString(),
      nextRefreshAt: lastRefreshAt == null ? null : new Date(lastRefreshAt + minRefreshMs).toISOString(),
      accounts,
    };
  }

  return { read, setManual: entry => manual?.set(entry) || {ok:false,reason:"manual-reading-disabled"} };
}
