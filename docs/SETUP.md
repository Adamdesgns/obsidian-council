# Setup and operation

## Requirements and discovery

Windows, Node.js 24+, Git, and an installed, signed-in Codex CLI are required. `npm run doctor` checks executable discovery offline. It cannot prove sign-in, account allowance or model availability.

Claude planning/review needs Claude Code supporting `--restricted`, `--strict-mcp-config` and `--tools` (installed version 2.1.286 checked). Council exposes Read/Glob/Grep plus its explicitly configured conversation bridge; it does not inherit other MCP connections or browser tools. Grok requires the signed-in Grok Build CLI. An ambiguous executable named `agent` is never assumed to be either Grok or Cursor.

Codex discovery supports the desktop app, standalone npm installation, or an absolute PATH directory containing `codex.exe`. Claude supports `.local/bin`, npm, or a named PATH executable. Grok supports `.grok/bin/grok.exe` or a named PATH executable. Set `COUNCIL_CODEX_EXE`, `COUNCIL_CLAUDE_EXE` or `COUNCIL_GROK_EXE` to an exact absolute `.exe` when necessary. Invalid overrides fail without silently choosing a different program.

Custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are preserved without copying their contents into Council's record. Seat models are set in `config/council.json`; an omitted model uses the CLI default. Grok patch coding requires `COUNCIL_GROK_PATCH_ENABLED=1` and an exact `COUNCIL_GROK_MODEL`. Launchers default to `grok-4.7-build-fast` but preserve explicit environment choices. Select models your signed-in CLI actually offers.

## Optional Cursor patch coding

Before starting Council, set `COUNCIL_CURSOR_ENABLED=1`, `COUNCIL_CURSOR_EXE` to its exact absolute executable, and `COUNCIL_CURSOR_MODEL` to an available exact model (the existing setup uses `composer-2.5`). For a portable Node installation, the executable is its `node.exe` and `COUNCIL_CURSOR_ENTRYPOINT` is its absolute `index.js`.

The Windows launchers default to `%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI`. They do not install it or sign you in. To authorize one exact workspace:

```powershell
$env:COUNCIL_CURSOR_TRUST_APPROVED = '1'
$env:COUNCIL_CURSOR_TRUST_WORKSPACE = 'C:\Projects\my-approved-worktree'
```

This names one physical directory, not a recursive allowlist of projects. A different or retargeted folder is refused. Each job still needs approval of its plan. Cursor uses Ask mode with sandboxing enabled; no force/yolo flag is used. It proposes a patch rather than editing files itself. Council rejects unchecked diffs, protected paths, symlinks, binary patches, renames, deletions and stale context.

## Usage readings

`npm start` leaves optional usage sources off unless enabled in the environment. Windows launchers enable the Codex local quota reader and Claude signed-in usage reader. Set `CODEX_LOCAL_USAGE_READER=0` or `CLAUDE_LOCAL_USAGE_READER=0` beforehand to opt out.

Codex reads bounded local session metadata. Claude uses its local sign-in only for the provider's usage endpoint; secrets are never returned to the page. Cursor/Grok readings are manual and expire after one hour. Unavailable, stale, manual and simulated readings remain labeled.

## Backup and update

Stop Council before copying its complete runtime directory, `%LOCALAPPDATA%\ObsidianCouncil` or your custom `COUNCIL_HOME`. The backup contains private tokens and conversations; never commit it. Do not copy only the SQLite file while Council is running.

Keep the backup and previous source revision. Test a new release on a copy of the data first. When rolling back source, restore its corresponding complete data backup too; an older release may not read a newer schema. Never run two instances against the same data directory.

## Troubleshooting

- **Cannot connect:** keep the launcher running and open its latest private link. Check the connection indicator.
- **Port occupied:** Council leaves the other app alone. Stop your old Council yourself or choose `COUNCIL_PORT`. Phone mode requires a fixed port from 1 to 65535.
- **CLI/model missing:** open the named CLI, sign in and check its models; correct the executable/model settings.
- **Work paused:** read the reason. Restore a moved workspace or revise/reapprove the work. Do not accept an unverified provider claim.
- **Phone:** connect Tailscale on both devices, keep the PC awake and use the printed HTTPS hostname. A phone-sized browser test does not prove a real iPhone connection.

## Release checks

`npm test` serializes test files because Windows process startup can otherwise cause recovery-test contention. It disables real providers and both usage readers. `scripts/prove-release.mjs` is a separate live check: preparing its disposable workspace is offline; running it requires explicit approval, a process-local opt-in and review of the generated plan before coding starts.
