// src/deliberation.mjs — one question in, one agreed answer out.
import { accountOf } from "./seats.mjs";
import { runsTodayForAccount, ceilingFor, loadLimits } from "./adapters/spawn.mjs";

/** Worst case per deliberator: 1 blind answer + 3 debate rounds. */
export const RUNS_PER_DELIBERATOR = 4;
export const MAX_ROUNDS = 3;

/**
 * Read-only. Refuses up front rather than stranding a debate half-finished,
 * because a deliberation that dies at round 2 has spent real budget for nothing.
 *
 * Budget is counted per ACCOUNT, with the same ceiling rule spawnMember
 * enforces (ceilingFor), so preflight can never approve a run spawn would
 * refuse. Two deliberators on one account need 2 x RUNS_PER_DELIBERATOR from
 * that account; checking each alone would pass at 7 remaining and strand at 8.
 *
 * @returns {{ok: true} | {ok: false, reason: string, member?: string, account?: string, remaining?: number, needed?: number}}
 */
export function preflight(store, { deliberators, limits } = {}) {
  if (!Array.isArray(deliberators) || deliberators.length === 0) {
    return { ok: false, reason: "no_deliberators" };
  }
  const lim = limits || loadLimits();

  // account -> { members (in list order), needed }
  const byAccount = new Map();
  for (const member of deliberators) {
    let account;
    try { account = accountOf(member); } catch { return { ok: false, reason: "unknown_seat", member }; }
    const slot = byAccount.get(account) || { members: [], needed: 0 };
    slot.members.push(member);
    slot.needed += RUNS_PER_DELIBERATOR;
    byAccount.set(account, slot);
  }

  for (const [account, { members, needed }] of byAccount) {
    const ceiling = ceilingFor(lim, members[0]);
    const used = runsTodayForAccount(store, account);
    const remaining = ceiling - used;
    if (remaining < needed) {
      return { ok: false, reason: "insufficient_budget", member: members[0], account, remaining, needed };
    }
  }
  return { ok: true };
}
