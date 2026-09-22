# The Obsidian Council

A private Windows desk where Adam can talk with Codex or Claude, approve a plan, send the approved work to Codex for coding, have the original planner review the result, and make the final acceptance decision.

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
4. Codex edits only inside the approved workspace and runs appropriate local checks. Each coding run must prove that its effective sandbox policy was `workspace-write`; otherwise Council pauses the work.
5. The chosen planner reviews the actual files and verification evidence in a read-only Windows sandbox.
6. Read the report and click **Accept reviewed work** only when you agree.

Council prompts prohibit pushing, merging, deploying, spending, contacting anyone, and using credentials. Those remain separate owner decisions.

## Other Floor features

- Directed conversations such as `@codex plan this @grok critique it @codex revise it` survive restarts.
- **Deliberate** asks two members independently and brings the final answer to the Black Seat.
- **HALT** stops member work and survives restarts.
- Messages, runs, deliveries, and decisions are stored in a hash-chained local SQLite record under `%LOCALAPPDATA%\ObsidianCouncil`.
- The usage panel can read local Codex quota metadata when launched through `START-COUNCIL.cmd`; unavailable providers stay labeled unavailable.

## Requirements

- Windows and Node 24 or newer.
- The installed Codex CLI logged in with ChatGPT. This PC was verified on 2026-09-22.
- Claude Code logged in if Claude is selected as planner. This PC was verified on 2026-09-22.

## Commands

```powershell
npm start
npm test
npm run preview:fake
```

`npm start` uses the real configured CLIs. `npm run preview:fake` is a simulated walkthrough. The automated suite never starts real providers.

## Verification

- 125 automated tests pass.
- A real Windows proof completed `Codex plan → owner approval → Codex coding → Codex read-only review → owner acceptance`.
- A second real Windows proof completed the same lifecycle with Claude as planner/reviewer and Codex as coder.
- The build changed a disposable module from `1` to `2`, ran its test successfully, and recorded a verified `workspace-write` sandbox policy.
- The reviewer independently read the files and reran the test in a read-only elevated Windows sandbox.

Evidence: `evidence/2026-09-22-windows-codex/live-proof.json`.

## Main files

```text
START-COUNCIL.cmd       one-click Windows launcher
START-COUNCIL-PHONE.cmd one-click private Tailscale phone launcher
src/council.mjs         service and dispatcher entry point
src/api.mjs             loopback API, tokens, work-order endpoints and HALT
src/work-orders.mjs     plan, approval, coding, review and acceptance lifecycle
src/dispatcher.mjs      durable provider dispatch and recovery
src/adapters/           Codex, Claude, Grok and legacy Cursor adapters
src/store.mjs           SQLite record and hash chain
web/index.html          local Council interface
config/limits.json      run ceilings, timeouts and hop caps
```

## License

MIT.
