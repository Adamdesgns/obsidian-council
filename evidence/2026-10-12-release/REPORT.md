# Local release-candidate evidence

Date: 2026-10-12. Platform: Windows, Node 26.1.0, installed Edge.

This folder contains simulated-provider tests and local browser screenshots. No account credentials or production database are included. The live proof is prepared, awaiting approval; a prepared plan is not a completed run.

## Validation artifacts

- `tests.txt`: final full regression result: **176 passed, 0 failed**, 365.8 seconds.
- `doctor.json`: offline setup passed for Windows/Node and required Codex discovery. Optional Cursor was disabled in this plain command environment; no sign-in or quota check was performed.
- `tests-integration-before-final-fixes.txt`: retained integration failures that led to stop/retry and browser/error handling repairs.
- `tests-before-wait-fix.txt`: 173/175; two workflow waits used an unrealistic six-second total budget for four/eight Windows process launches.
- `tests-before-startup-budget.txt`: 175/176; diagnostics showed one fake process exceeded the three-second startup allowance. The behavior test now allows ten seconds per fake process; production timeouts and timeout-enforcement tests are unchanged.
- `browser-report.json`: assertions against the actual Floor at desktop and phone viewport sizes.
- `desktop-fixture.png`, `phone-fixture.png`: local-build screenshots with simulated responses.
- `live-proof-plan.json`: fixed disposable task, model, maximum run counts and ten-minute cutoff. No provider was called to prepare it.

## Important reproduced defects repaired

- A trailing traditional diff could modify a protected `.env` after an innocuous Git-style header. The parser now validates the complete patch.
- A patch in a nested Git directory could report success without changing the target. Application now uses the repository-relative directory explicitly.
- Removing trailing whitespace from a patch erased a legitimate final empty context line. Extraction now preserves context whitespace.
- Cancelling a resumed provider could immediately trigger a fresh retry. Stop checks now fence retry and result processing.
- Work approvals could survive an identical-text revision or workspace retarget. Approval hashes and dispatch/completion checks now bind the full approved context.
- The coding worker's model could leak into planner/reviewer calls. Only the implementation phase receives that model.
- Phone startup could configure a route before discovering the port belonged to another app. Binding now precedes proxy configuration, and failed binding closes resources.

## Isolation and limits

Automated tests force fake providers and disable both usage readers. Tests use disposable data/workspaces, including temporary Git repositories and junctions. The browser proof uses headless Edge and isolated data. No existing Council process, Tailscale route or user project was changed.

The live harness is separate from CI. It requires explicit owner approval, process-local opt-in, an exact scoped trust path and plan review. Its local verifier refuses unexpected files or any content beyond the approved constant change before executing the fixed test.

See [release readiness](../../docs/RELEASE-READINESS.md) for the outstanding live, physical-phone and publication steps. Historical provider proofs are not presented as fresh runs.
