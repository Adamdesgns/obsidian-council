# Council 0.2.0 release readiness — 2026-10-12

This is the 0.2.0 release candidate. Adam authorized publishing it to GitHub on 2026-10-12. It has not replaced the running private app. Fresh live-provider and physical-phone acceptance are still required before calling the release fully verified.

## What this candidate changes

- Replies and acknowledgements commit together. Stale leases and forged engine replies cannot advance work. Waiting messages cannot starve new owner requests.
- Approvals bind the revision, worker/model and physical workspace. Moved or retargeted workspaces stop immediately. Cursor trust applies to one exact physical folder.
- The patch reader validates every file and hunk, including traditional diff headers. Protected paths, uninspected trailing diffs and symlinks are refused. Nested Git workspaces apply to the intended directory.
- HALT and shutdown prevent retry spawns. Resume recovery saves the real replacement session. Each planner/reviewer uses its own model rather than inheriting the coding worker's model.
- Claude uses restricted mode, explicit read tools and only its Council bridge configuration.
- The Floor keeps its stop control reachable on phones, shows connection failures, prevents duplicate submissions and polls messages by a lossless sequence cursor.
- Setup supports standalone CLI installations and explicit executable overrides. Phone startup checks existing routes and binds Council before changing the private proxy. A failed bind closes its database.

## Evidence

**176/176 automated tests passed** on Windows with Node 26.1.0; see [tests.txt](../evidence/2026-10-12-release/tests.txt). All model execution in that suite is simulated and both account-usage readers are disabled. Earlier failed integration runs are preserved alongside the final result, including the defects they exposed and overly short Windows test deadlines.

The [browser report](../evidence/2026-10-12-release/browser-report.json) exercises the real page in Edge at desktop and 390-pixel phone widths, using temporary data and simulated agents. It covers directed handoff, plan feedback and approval, coding/review/acceptance, persistent HALT, token removal, chamber switching and page overflow. These screenshots show a local build; they are not proof of a physical iPhone connection.

The upgrade regression constructs the old 001/002 database, migrates it through the current schema, verifies historical messages/deliveries/sessions/event hashes and dummy credentials, creates a new work order, then reopens it. No production database was used.

CLI help confirmed the installed Claude restricted flags and Cursor Ask/sandbox/trust flags. `npm run doctor` checks executable discovery offline; it does not establish sign-in or model availability. The Windows Node 24/26 workflow runs on each push; check [GitHub Actions](https://github.com/Adamdesgns/obsidian-council/actions) for its result on the published commit.

Earlier real Codex/Claude workflow records remain in [the September 22 evidence](../evidence/2026-09-22-windows-codex/REPORT.md). Earlier Grok patch and usage-reader findings are in [the meters/coding report](../evidence/2026-09-22-meters-coding/REPORT.md). They establish historical results, not fresh validation of today's candidate.

## Remaining acceptance and publication steps

1. **Approve the prepared live check.** It uses two signed-in Codex calls and one Cursor `composer-2.5` call, trusts only one disposable folder and stops after ten minutes. The exact plan must be reviewed before coding. The verifier permits only the approved constant change and executes only the unchanged test. No actual project is edited. See [live-proof-plan.json](../evidence/2026-10-12-release/live-proof-plan.json).
2. **Check the private phone flow on an actual iPhone.** Open its private link through Tailscale, create a chamber, submit a message, review/approve a tiny work order, reload and operate HALT. A new private-app launch/replacement needs Adam's approval.
3. **Verify the authorized publication.** Adam's 2026-10-12 push instruction covers the tested candidate and these release records. Confirm GitHub main matches the release commit and both Windows CI jobs pass. Any launch-page deployment remains a separate decision.

Fresh Claude/Grok account behavior and live allowance readings were not exercised during this preparation. Cursor/Grok allowance remains manually entered and labeled; no automatic meter is promised for them. Jev remains deferred under the previous scope decision.

## Commands and operating guidance

```powershell
npm run doctor
npm test
node scripts/qa-browser.mjs
node scripts/prove-release.mjs
```

The browser command requires an existing Playwright installation (`PLAYWRIGHT_PATH`) and Edge (`BROWSER_EXE` can override its location). The last command only prepares the live fixture; `--run` additionally requires explicit approval and `COUNCIL_LIVE_PROOF_APPROVED=1`. Never add it to CI.

See [SETUP.md](SETUP.md) for model choices, scoped Cursor trust, phone prerequisites, runtime backup and rollback. Keep runtime tokens, account files and private conversations out of Git.
