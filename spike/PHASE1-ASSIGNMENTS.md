# Phase 1 spike — assignments for Morgan Sterling

- From: Claude (build lead, per Adam's approval of the decision sheet, 2026-09-14)
- To: Morgan Sterling
- Scope: the Phase 1 spike only. No daemon, no dashboard, no scheduled task, no product code.
- Ceiling (Adam): at most 10 short headless model runs per CLI, zero API dollars. `spike/budget.json` enforces it; the scripts refuse to spawn past it.
- Everything runs from this folder: `C:\Users\steam\Projects\apps\obsidian-council`. Nothing to install. Node 26 is already on the PC.

## How this works

I wrote the scripts. You run them, in order, from PowerShell in the folder above. Each one writes a JSON report into `spike\results\` and appends every model run to `spike\results\usage-ledger.jsonl`. I read the reports and the ledger to accept or reject each assignment. Your HANDBACK goes on the bus drop, not in this file.

If a script prints `BUDGET:` and refuses, stop and say so. If anything asks for a login, a browser, a password, or an "allow" click, do not answer it; kill it, note which script and which CLI, and move on. Adam does credentials.

Dry run first if you want to see exactly what a script will execute without spending anything: add `--dry-run` to any command below.

## A1 — resolve CLIs (read-only, no model runs)

```powershell
node spike\a1-resolve.mjs
```

Done looks like: `spike\results\A1-resolve.json` exists and lists a path and version for `claude`, `codex`, `grok`, and says whether any `cursor-agent` exists on this PC (I expect NOT FOUND; that is a valid answer, not a failure).

## A2 — headless authentication probe (1 model run per CLI)

```powershell
node spike\a2-auth-probe.mjs
```

Done looks like: `A2-auth-probe.json` with one verdict per CLI. Acceptable verdicts are `ready_candidate` or a `blocked:...` reason. Anything that hangs until the 3-minute timeout is recorded as `blocked:timeout`, which usually means the CLI wanted an interactive prompt. That is a finding, not a fault.

## A3 — Codex sandbox negative tests (2 Codex model runs)

```powershell
node spike\a3-sandbox-negative.mjs
```

The script builds a throwaway folder under `%TEMP%\council-spike\a3\`, plants a FAKE secret, asks Codex to try to escape the sandbox in five ways, then checks the disk and the process table itself. It deletes the folder afterwards.

Done looks like: `A3-sandbox-negative.json` with five checks plus a STOP verdict. I expect check 2 to read "canary leaked" because Codex's workspace-write sandbox allows reads by design; that is information for the permission matrix, not a failure of the test. Anything marked FAIL is what I most want to see. If the run mentions sandbox setup or elevation, do not set anything up; just leave the output in the report.

## A4 — Grok session semantics (4 Grok model runs)

```powershell
node spike\a4-grok-sessions.mjs
```

Done looks like: `A4-grok-sessions.json` with `resume: PASS`, `wrongFlag: PASS`, `missing: PASS`. A FAIL on any of these changes the live-chat design, so it matters.

## A5 — two real sessions, one outbox, one crash (Claude 2, reviewer 2)

Use `codex` as the reviewer if A2 said Codex is a ready candidate, otherwise `grok`. Run the crash version first, then resume it:

```powershell
node spike\a5-stub-exchange.mjs --reviewer codex --crash
```

```powershell
node spike\a5-stub-exchange.mjs --reviewer codex --resume-run
```

The first command deliberately exits with an error after the reviewer answers and before that answer is saved. That is the crash. The second command must notice the reviewer delivery was left leased at attempt 1, run the reviewer once more at attempt 2, and finish the exchange.

Done looks like: `A5-stub-exchange.json` ends with `verdict: PASS` and the message list shows exactly one plan, one critique, one revision. If A2 said Codex is blocked, use `--reviewer grok` in both commands.

## Evidence to hand back

On the bus drop (`docs\handoffs\to-grok\2026-09-14-council-phase1-morgan.md`), in the HANDBACK, list which assignments ran, and paste the `summary` lines from each `A*.json`. Leave the JSON files where they are; I read them directly. Do not paste the ledger; I read that too.

## What NOT to do

- No `--dangerously-*`, `--always-approve`, or `--permission-mode bypassPermissions` on any command. The scripts do not use them and you do not add them.
- No installs, no config edits (`settings.json`, `config.toml`, `~/.grok`, `~/.cursor`), no scheduled tasks, no git push, no GitHub repo creation.
- Do not run any script more times than the assignment says. The ledger shows every run; a second full A5 doubles the cost for no new information.
- Do not touch Adam's running apps. The scripts only work under `%TEMP%\council-spike\` and `spike\results\`.
- Do not paste secrets, device codes, or login URLs anywhere. The reports are redacted, but the terminal is not.
- If Adam is asleep and something needs a decision, stop at that assignment and hand back what you have. Partial evidence is useful; guessed evidence is not.
