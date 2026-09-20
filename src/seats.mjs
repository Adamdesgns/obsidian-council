// src/seats.mjs — what a member IS. Adapter, model, and which real account it spends.
//
// A seat id is the member id everywhere (deliveries.recipient, runs.member,
// tokens.json keys). This module maps that id to the CLI that runs it.
//
// `account` is the REAL quota being spent. fable and claude are different seats
// but the same Anthropic account, so they share one daily ceiling.
//
// "owner" is not a seat. The owner is the floor: nothing spawns for it and it is
// never a hop (see routing.mjs). Asking for it here throws like any unknown id.

const BUILT_IN = {
  codex: { adapter: "codex", model: null, account: "codex", role: "deliberator" },
  fable: { adapter: "claude", model: "claude-fable-5-1", account: "anthropic", role: "deliberator" },
  claude: { adapter: "claude", model: null, account: "anthropic", role: "arbiter" },
  grok: { adapter: "grok", model: null, account: "grok", role: "executor" },
};

let overrides = null;

/** Test seam: replace the seat table. Pass null to restore the built-ins. */
export function setSeats(seats) {
  overrides = seats;
}

function table() {
  return overrides || BUILT_IN;
}

export function seatOf(id) {
  const t = table();
  // hasOwn, not `t[id]`: "constructor" or "__proto__" would otherwise resolve
  // through Object.prototype and come back as a truthy non-seat.
  if (typeof id !== "string" || !Object.hasOwn(t, id)) throw new Error("unknown seat: " + id);
  return { id, ...t[id] };
}

export function seatIds() {
  return Object.keys(table());
}

export function allSeats() {
  return seatIds().map(seatOf);
}

export function accountOf(id) {
  return seatOf(id).account;
}
