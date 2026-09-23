# The Obsidian Council

A private Windows desk where Adam can talk with Codex or Claude, approve a plan, choose Codex, Grok, or Cursor for coding, have the original planner review the result, and make the final acceptance decision.

## Use it on this PC

Double-click `START-COUNCIL.cmd`. The terminal prints one private local link. Open that link and leave the terminal running.

The page remembers the owner token in that browser and removes it from the address bar. Council listens only on `127.0.0.1`; do not expose its port.

## Use it from your phone

Install Tailscale on this PC and your phone, sign both into the same tailnet, then double-click `START-COUNCIL-PHONE.cmd`. It starts a private HTTPS Tailscale Serve address and prints the one owner link to open on your phone. Keep the PC awake and the launcher window open.

Council still listens only on `127.0.0.1`. The phone launcher admits only this PC's exact MagicDNS hostname through Tailscale; it does not use Tailscale Funnel or publish Council to the public internet. After the first visit, use the browser's **Add to Home Screen** action for an app icon.

## Work-order flow

1. Create a chamber and discuss the work with `@codex` or `@claude` in Conversation.
2. Under **Delegate work**, choose that assistant as Planner, enter the exact project or isolated worktree path, and describe the objective.
3. Read the implementation plan. Send feedback for a revision, or click **Approve plan and start coding**.
4. Choose a coding lane. Codex edits inside the approved workspace and proves its effective `workspace-write` sandbox. Grok and Cursor inspect files with read-only tools and return a bounded text patch; Council checks its paths and context before applying it. Their lane pauses if no valid patch returns.
5. The chosen planner reviews the actual files and verification evidence in a read-only Windows sandbox.
6. Read the report and click **Accept reviewed work** only when you agree.

Council prompts prohibit pushing, merging, deploying, spending, contacting anyone, and using credentials. Those remain separate owner decisions.

## Other Floor features

- Directed conversations such as `@codex plan this @grok critique it @codex revise it` survive restarts.
- **Deliberate** asks two members independently and brings the final answer to the Black Seat.
- **HALT** stops member work and survives restarts.
- Messages, runs, deliveries, and decisions are stored in a hash-chained local SQLite record under `%LOCALAPPDATA%\ObsidianCouncil`.
- The usage panel reads local Codex quota metadata and Claude Code's signed-in allowance when launched through either Windows launcher. Cursor and Grok can take an owner-entered reading that expires after one hour; this is always labeled manual.

## Requirements

- Windows and Node 24 or newer.
- The installed Codex CLI logged in with ChatGPT. This PC was verified on 2026-09-22.
- Claude Code logged in if Claude is selected as planner. This PC was verified on 2026-09-22.
- Grok Build CLI signed in if Grok is selected for coding. The launcher pins `grok-4.7-build-fast`.
- Cursor CLI signed in and `COUNCIL_CURSOR_ENABLED=1`, `COUNCIL_CURSOR_EXE`, `COUNCIL_CURSOR_ENTRYPOINT`, and `COUNCIL_CURSOR_MODEL` set to the verified local CLI paths and model if Cursor is selected. Council shows setup needed until these are set.

## Commands

```powershell
npm start
npm test
npm run preview:fake
```

`npm start` uses the real configured CLIs. `npm run preview:fake` is a simulated walkthrough. The automated suite never starts real providers.

## Verification

- 134 automated tests pass in this branch.
- A real Windows proof completed `Codex plan → owner approval → Codex coding → Codex read-only review → owner acceptance`.
- A second real Windows proof completed the same lifecycle with Claude as planner/reviewer and Codex as coder.
- The build changed a disposable module from `1` to `2`, ran its test successfully, and recorded a verified `workspace-write` sandbox policy.
- The reviewer independently read the files and reran the test in a read-only elevated Windows sandbox.
- Grok's CLI authored a patch in a disposable folder and Council's checked patch applier applied it. The full work-order lifecycle passed fake-provider tests. Cursor's local CLI is installed but was not signed in during this verification; its live path remains unverified.

Evidence: `evidence/2026-09-22-windows-codex/live-proof.json`.

## Main files

```text
START-COUNCIL.cmd       one-click Windows launcher
START-COUNCIL-PHONE.cmd one-click private Tailscale phone launcher
src/council.mjs         service and dispatcher entry point
src/api.mjs             loopback API, tokens, work-order endpoints and HALT
src/work-orders.mjs     plan, approval, coding, review and acceptance lifecycle
src/dispatcher.mjs      durable provider dispatch and recovery
src/adapters/           Codex, Claude, Grok and Cursor adapters
src/patch-worker.mjs    checked application of Cursor/Grok text patches
src/usage/              live and manual usage readings
src/store.mjs           SQLite record and hash chain
web/index.html          local Council interface
config/limits.json      run ceilings, timeouts and hop caps
```

## License

MIT.
