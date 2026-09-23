# Council usage and coding lanes — local proof

Date: 2026-09-22 America/Chicago. Branch: `codex/council-meters-coding-20260923`, base `4a12ede`.

Adam requested Cursor and Grok coding alongside Codex and working usage meters. This branch keeps Codex's direct, sandbox-verified coding path and adds read-only patch authoring for Grok and Cursor. Council checks the patch, applies it inside the approved workspace, records file hashes, and returns the result to the chosen planner. No push or deploy occurred during implementation.

## Verified

- `npm test`: 136 passed, 0 failed on the latest complete run. Includes owner-only manual usage write, one-hour expiry, unsafe patch rejection, and fake end-to-end Grok/Cursor patch → planner review. One preceding parallel run hit a 5-second timeout; the isolated work-order file and following full suite passed.
- Isolated local preview at port 4888: `/owner/work-orders` showed Codex and Grok ready, Cursor setup needed. `/owner/usage` returned fresh Codex weekly and Claude five-hour/weekly percentages. The browser showed the three coding choices and both live meters.
- Browser manual Grok entry displayed 12.5% with **Manual entry** and a clear button; the disposable test value was cleared.
- Grok Build CLI, signed in on this PC, returned a unified diff with `END PATCH` under the final read-only tool flags, including denials for Bash, Edit, MCP, web fetch, and web search. The earlier disposable proof applied its patch and changed `answer.mjs` from `1` to `2`.
- Claude reader returned only percentages and reset timestamps to Council; the OAuth credential remained in the request header and was not printed.

## Open gates

- Cursor CLI is now authenticated after Adam completed its browser sign-in. A stable copy of the same official runtime is at `%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI`; `status` reports authenticated and `models` lists `composer-2.5`, which both launchers now pin. A real read-only patch attempt stopped at Cursor's workspace-trust gate before a model call. The trust setting remains off pending Adam's decision; Cursor's live patch path is unverified.
- Cursor and Grok personal allowance have no verified automatic source in this branch. Their owner-entered reading expires after one hour and is always labeled manual. An unavailable state is displayed until Adam enters a real value from the provider UI.
- No existing work orders were active in the phone app's store when checked. Automatic approval review initially rejected the replacement launch under Adam's standing app-start rule. Adam then explicitly approved it. The `0e47c1e` build is running again at the existing private URL, serving the three-lane picker and fresh Codex/Claude readings; Cursor remains disabled in that running process until its trust gate is settled and the updated branch is restarted.
