// Offline prerequisites only: no account files, model runs, or runtime changes.
import { resolveCli } from "../src/adapters/resolve-cli.mjs";
import { pathToFileURL } from "node:url";

export function diagnose(env = process.env) {
  const providers = ["codex", "claude", "grok", "cursor"].map(id => {
    const resolved = resolveCli(id, { role: "build" }, env);
    return { id, installed: resolved.found, reason: resolved.reason || null };
  });
  return {
    platform: process.platform, node: process.versions.node,
    supported: process.platform === "win32" && Number(process.versions.node.split(".")[0]) >= 24,
    providers,
    ready: process.platform === "win32" && Number(process.versions.node.split(".")[0]) >= 24 && providers.some(p => p.id === "codex" && p.installed),
    authentication: "Not checked. Sign in to each selected CLI before using Council.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = diagnose();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Council setup check: ${report.platform}, Node ${report.node}`);
    console.log(report.supported ? "Windows / Node requirement: OK" : "Windows and Node 24 or newer are required.");
    for (const p of report.providers) console.log(`${p.id}: ${p.installed ? "installed" : p.reason || "not installed"}`);
    console.log(report.authentication);
    console.log("Optional providers can be configured later. See docs/SETUP.md.");
    console.log("This check does not start Council, contact providers, or change your PC.");
  }
  if (!report.ready) process.exitCode = 1;
}
