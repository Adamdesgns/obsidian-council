// Resolve COUNCIL_HOME / default runtime directory. Zero deps.
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function councilHome() {
  const override = process.env.COUNCIL_HOME;
  if (override && String(override).trim()) return String(override).trim();
  const base = process.env.LOCALAPPDATA
    || join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local");
  return join(base, "ObsidianCouncil");
}

export function ensureHome(home = councilHome()) {
  for (const sub of ["", "artifacts", "checkpoints", "logs"]) {
    mkdirSync(sub ? join(home, sub) : home, { recursive: true });
  }
  return home;
}