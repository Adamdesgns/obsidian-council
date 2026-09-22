import { readFileSync } from "node:fs";

const configured = JSON.parse(readFileSync(new URL("../config/council.json", import.meta.url), "utf8"));
export function validateSeats(seats) {
  if (!Array.isArray(seats) || !seats.length) throw new Error("seats required");
  const seen = new Set();
  for (const s of seats) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id) || ["owner", "engine"].includes(s.id) || seen.has(s.id))
      throw new Error("invalid or duplicate seat");
    if (!["claude", "codex", "grok", "cursor"].includes(s.adapter) || !s.account || !["deliberator", "executor"].includes(s.role))
      throw new Error("invalid seat adapter, account or role");
    if (s.model != null && (typeof s.model !== "string" || !s.model.trim())) throw new Error("invalid model");
    seen.add(s.id);
  }
  return seats.map(s => Object.freeze({ ...s }));
}
const seats = validateSeats(configured.seats);
export function seatOf(id) { return seats.find(s => s.id === id) || null; }
export function seatIds() { return seats.map(s => s.id); }
export function allSeats() { return [...seats]; }
export function accountOf(id) {
  const seat = seatOf(id);
  if (!seat) throw new Error("unknown seat: " + id);
  return seat.account;
}
export function defaultDeliberators() { return seats.filter(s => s.role === "deliberator").slice(0, 2).map(s => s.id); }
