# The Obsidian Council

Your AI agents, one shared room. Give Codex, Claude and Grok a question, let them pass work between themselves, and keep the decisions with you.

Council runs on your Windows PC. It stores conversation and work history locally and uses your installed, signed-in coding assistants. There is no Council account or hosted backend. Model calls still use each provider's subscription or allowance.

## Start here

Install **Node.js 24 or newer**, **Git**, and sign in to **Codex CLI**. Claude Code and Grok are optional. Current Claude Code must support restricted mode; version 2.1.286 was checked during release preparation.

```powershell
git clone https://github.com/Adamdesgns/obsidian-council.git
cd obsidian-council
npm run doctor
npm start
```

There are no runtime npm dependencies to install. The setup check is offline: it checks installed programs without starting agents or reading account credentials. Open the private link printed by Council and keep the terminal open. On later visits you can use `START-COUNCIL.cmd`.

See [setup and optional agents](docs/SETUP.md) for install locations, models, usage readings and troubleshooting.

## Work together

1. Create a chamber and send a message such as `@codex draft a plan @grok review it @codex revise it`.
2. Under **Delegate work**, choose Codex or Claude as planner, the coding agent, and the exact project folder. Describe the objective.
3. Read the plan. Send feedback until it is right, then approve that exact plan.
4. Codex can code inside its workspace sandbox. Grok and Cursor use read-only tools to propose a patch; Council validates the entire patch before applying it inside the approved folder.
5. The original planner reviews the result. Read the report and accept it when satisfied.

**HALT** stops member work and persists across restarts. Closing Council also stops its own running workers. Interrupted coding pauses for your attention; it is not silently rerun.

The optional **Deliberate** flow compares independent answers and brings the decision back to you. Replies and delivery acknowledgements are saved together so a failure cannot acknowledge work without saving its result.

## Optional phone access

Install Tailscale on your PC and phone, connect both to the same private network, and run `START-COUNCIL-PHONE.cmd`. Open its private HTTPS link on the phone. Keep the PC awake and Council running.

The launcher checks for conflicting routes and binds Council before configuring the private proxy. It refuses an existing public Funnel route. Council stays on `127.0.0.1`; do not publish its port. You can add the page to your home screen, but it needs the PC connection to work.

## Test without using model allowance

```powershell
npm test
npm run preview:fake
```

Both use fake providers and isolated temporary data. The preview labels simulated usage and responses. Optional browser acceptance uses `node scripts/qa-browser.mjs` with Playwright available and Edge installed; it also uses simulated providers.

The [release readiness report](docs/RELEASE-READINESS.md) separates fresh automated/browser evidence, historical real-provider evidence, and any remaining live/device checks. Older evidence folders are dated records, not fresh test results.

## Data and boundaries

- Runtime data lives in `%LOCALAPPDATA%\ObsidianCouncil`, outside the source checkout. `COUNCIL_HOME` selects a separate data directory.
- The private owner link grants control. Keep it private. Council removes its token from the address bar after opening it.
- A local SQLite record retains messages, runs and owner decisions with a verifiable event chain.
- Limits in `config/limits.json` are Council run counts, not provider subscription allowance.
- Cursor trust is optional, scoped to one exact folder, and off by default.
- Publishing, GitHub push, deployment, purchases and outreach are separate decisions. Review generated code and provider reports before accepting the result.

## License

MIT. Built by [Adam Designs](https://github.com/Adamdesgns).
