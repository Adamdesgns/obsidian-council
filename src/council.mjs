// src/council.mjs — the one process to run. Service + dispatcher, one link to open.
//
//   npm start            (or: node src/council.mjs)
//
// Prints exactly one local link carrying the owner token. Open it, and the Floor
// remembers the token in this browser. Everything lives under COUNCIL_HOME
// (default %LOCALAPPDATA%\ObsidianCouncil), never in the repo.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.mjs";
import { createDispatcher } from "./dispatcher.mjs";
import { councilHome } from "./home.mjs";
import { seatIds } from "./seats.mjs";

/**
 * Every seat gets a dispatcher loop. routing.mjs may address any seat (and
 * broadcasts to the deliberators by default), and a delivery to a seat the
 * dispatcher does not loop can never be claimed, so the two lists must match.
 */
export function defaultMembers() {
  return seatIds();
}

export async function startCouncil(opts = {}) {
  const home = opts.home || councilHome();
  const config = { ...(opts.config || {}) };
  if (opts.port != null) config.port = opts.port;
  else if (process.env.COUNCIL_PORT) config.port = Number(process.env.COUNCIL_PORT);

  const api = createApi({ home, config });
  const bound = await api.listen();
  const port = api.server.address().port;
  const base = `http://${bound.host}:${port}`;

  const dispatcher = createDispatcher({
    home,
    store: api.store,
    outbox: api.outbox,
    members: opts.members || defaultMembers(),
    tokens: api.tokens.members,
    apiBase: base,
    useFake: opts.useFake ?? process.env.COUNCIL_FAKE === "1",
    defaultRespond: true,
  });
  dispatcher.start();

  const haltFile = join(home, "HALT");
  const halted = existsSync(haltFile);
  const haltSince = halted ? readFileSync(haltFile, "utf8").trim() : null;

  const out = opts.log || ((s) => process.stdout.write(s + "\n"));
  out("");
  out("  The Obsidian Council is up.");
  out("");
  out(`  Open this link (it carries your owner token, keep it private):`);
  out(`  ${base}/#owner=${api.tokens.owner}`);
  out("");
  out(`  Home:   ${home}`);
  out(`  Halt:   ${halted ? `HALTED since ${haltSince}` : "clear (members may run)"}`);
  out(`  Stop:   Ctrl+C`);
  out("");

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    dispatcher.stop();
    try { await dispatcher.close(); } catch { /* */ }
    try { await api.close(); } catch { /* */ }
  }

  return { api, dispatcher, home, port, base, halted, close };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const council = await startCouncil();
  const bye = () => council.close().then(() => process.exit(0));
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
