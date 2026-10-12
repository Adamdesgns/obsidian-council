// Discover installed CLIs without running a shell, logging in, or calling a provider.
import { readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { connection as cursorConnection } from "./cursor.mjs";

const file = path => { try { return statSync(path).isFile(); } catch { return false; } };
const executable = path => isAbsolute(path) && /\.exe$/i.test(path) && file(path);

export function resolveCli(member, opts = {}, env = process.env) {
  if (opts.fakePath) return { exe: process.execPath, prefix: [opts.fakePath], found: true, fake: true };
  if (opts.exe) return { exe: opts.exe, prefix: opts.prefix || [], found: true };
  if (member === "cursor") {
    const c = cursorConnection(env, { patchOnly: opts.role === "build" });
    return c.ok ? { exe: c.exe, prefix: c.prefix, found: true } : { found: false, reason: c.reason };
  }
  if (!["codex", "claude", "grok"].includes(member)) return { found: false };
  const override = env[`COUNCIL_${member.toUpperCase()}_EXE`];
  if (override) return executable(override)
    ? { exe: override, prefix: [], found: true }
    : { found: false, reason: "invalid-executable-override" };
  const profile = env.USERPROFILE || env.HOME || "";
  const appData = env.APPDATA || join(profile, "AppData", "Roaming");
  const localData = env.LOCALAPPDATA || join(profile, "AppData", "Local");
  const pathDirs = (env.PATH || env.Path || "").split(delimiter).map(p => p.replace(/^"|"$/g, "")).filter(isAbsolute);
  const candidates = [];
  if (member === "codex") {
    const desktopBin = join(localData, "OpenAI", "Codex", "bin");
    try {
      candidates.push(...readdirSync(desktopBin).map(d => join(desktopBin, d, "codex.exe"))
        .filter(executable).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs));
    } catch { /* desktop installation is optional */ }
  }
  if (member === "claude") candidates.push(join(profile, ".local", "bin", "claude.exe"), join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  if (member === "grok") candidates.push(join(profile, ".grok", "bin", "grok.exe"));
  candidates.push(...pathDirs.map(p => join(p, `${member}.exe`)));
  const exe = candidates.find(executable);
  if (exe) return { exe, prefix: [], found: true };
  const packagePath = member === "codex" ? ["@openai", "codex", "bin", "codex.js"]
    : member === "claude" ? ["@anthropic-ai", "claude-code", "cli.js"] : null;
  if (packagePath) {
    const script = [join(appData, "npm"), ...pathDirs].map(p => join(p, "node_modules", ...packagePath)).find(file);
    if (script) return { exe: process.execPath, prefix: [script], found: true };
  }
  return { found: false, reason: "cli-not-installed" };
}
