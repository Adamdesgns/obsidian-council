# Council usage and coding lanes — local proof

Date: 2026-09-22 America/Chicago. Branch: `codex/council-meters-coding-20260923`, base `4a12ede`.

Adam requested Cursor and Grok coding alongside Codex and working usage meters. This branch keeps Codex's direct, sandbox-verified coding path and adds read-only patch authoring for Grok and Cursor. Council checks the patch, applies it inside the approved workspace, records file hashes, and returns the result to the chosen planner. No push or deploy occurred during implementation.

## Verified

- `npm test`: 134 passed, 0 failed. Includes owner-only manual usage write, one-hour expiry, unsafe patch rejection, and fake end-to-end Grok patch → planner review.
- Isolated local preview at port 4888: `/owner/work-orders` showed Codex and Grok ready, Cursor setup needed. `/owner/usage` returned fresh Codex weekly and Claude five-hour/weekly percentages. The browser showed the three coding choices and both live meters.
- Browser manual Grok entry displayed 12.5% with **Manual entry** and a clear button; the disposable test value was cleared.
- Grok Build CLI, signed in on this PC, returned a unified diff with `END PATCH` under the final read-only tool flags, including denials for Bash, Edit, MCP, web fetch, and web search. The earlier disposable proof applied its patch and changed `answer.mjs` from `1` to `2`.
- Claude reader returned only percentages and reset timestamps to Council; the OAuth credential remained in the request header and was not printed.

## Open gates

- Cursor CLI is installed but `status --format json` reports `unauthenticated`; `models` refuses without sign-in. Its exact model and live patch path remain unverified. The picker shows setup needed until a signed-in, pinned model is configured.
- Cursor and Grok personal allowance have no verified automatic source in this branch. Their owner-entered reading expires after one hour and is always labeled manual. An unavailable state is displayed until Adam enters a real value from the provider UI.
- No existing work orders were active in the phone app's store when checked. The old process was stopped for a controlled switch, but automatic approval review rejected launching this new build because Adam's standing instructions require explicit approval before starting or reconfiguring the app. The private URL is currently offline and restart approval is pending. Do not bypass the rejection.
