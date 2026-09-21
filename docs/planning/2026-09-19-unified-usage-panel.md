# Council unified usage panel

Status: implementation brief; not implemented or connected.
Owner: Morgan routes implementation through Cursor; Codex plans and reviews.
Date: 2026-09-19, America/Chicago.

## Owner request

Adam wants one place to plan and delegate work, with remaining model allowances visible before choosing who does the work. Codex or Claude should plan; lower-cost models should do approximately 98% of coding. Debate is optional. Jev is deferred.

The design reference is the GitHub app installed today, Codex Usage 1.9.1: https://github.com/upstream-ray/codex-usage-monitor . Borrow the compact service columns, remaining-allowance bars, and reset countdown pattern. Adapt it to the existing Council dark interface. This is not a request to install another tracker or replace the Windows widget.

## Checkout and current truth

- Work locally from `C:/Users/steam/.codex/visualizations/2026/09/19/01a0ba30-bf1d-7fe2-8ee5-b5c6f9beae52/council-build`, branch `codex/council-deliberation-complete`, starting commit `de724ec`.
- Canonical checkout `C:/Users/steam/Projects/apps/obsidian-council` is a different working copy on `jev-judge`; preserve it.
- These changes are not on the remote. A Cursor cloud worker cannot assume this base exists remotely. Use an authorized local worker or report the transfer dependency; do not push to solve it.
- `web/index.html` is a dependency-free HTML/CSS/JS Floor. Add the panel above Delegate work, below the header. Keep the owner controls accessible.
- `src/api.mjs` already enforces owner authentication and loopback access. There is no usage endpoint yet.
- `src/adapters/spawn.mjs` counts Council runs per account for local daily ceilings. That is not remaining subscription allowance.
- `src/seats.mjs` maps seat aliases to accounts. Group aliases only when their actual quota source establishes a shared pool; the Claude/Fable account mapping is a starting point, not proof of a subscription product.
- `src/work-orders.mjs` currently routes implementation back to Codex for non-Cursor workers. This does NOT meet Adam's cost-first policy. Do not claim this panel fixes routing, and do not trigger that route while verifying the panel. Morgan must track the routing correction as a separate prerequisite before real work delegation.

## Interface

1. A compact **Usage left** panel shows configured accounts/services together, initially Codex, Claude, Cursor, and Grok. Display provider-reported model pools under their account where available; do not invent independent allowances for every model.
2. Each known window has a label, percentage remaining, horizontal bar, reset countdown, and accessible text. Use the actual duration returned by the source; do not hardcode every provider to 5 hours/7 days. Multiple windows stay separate, never averaged.
3. A small status line gives the source and last checked time. Refresh is read-only. Expanding the panel reveals details without hiding the work composer.
4. Distinguish fresh, stale, unavailable, manual, and simulated readings. Unknown is shown as **Unavailable**, not 0% or 100%. A true zero says **0% left**. Reset passing means a refresh is due, not proof of a replenished quota.
5. For unsupported providers show **Usage unavailable** and a short reason. An explicitly labeled manual reading may be offered, with its own recorded time, but it never becomes a verified reading.
6. Council's own run ceilings appear separately as **Council run cap** if shown. Do not relabel those counts as subscription balance, dollars, or tokens.
7. Low remaining allowance is visible through text plus color. No pop-up notifications, automatic credit redemption, paid fallback, or model dispatch. These meters support the user's choice; availability does not establish that a model is suitable for a task.
8. Keep the layout compact on desktop and stack cleanly at 390px. Use semantic progress labels, keyboard-operable details/refresh, and no color-only status.

## Data boundary

Create a small server-side usage module and owner-authenticated read endpoint. Suggested response: account display ID, service, pool ID, covered model IDs when known, status, source label, checkedAt, and windows containing durationMinutes, usedPercent or remainingPercent, and resetsAt. Timestamps use a documented format; normalize provider units in the adapter. Do not expose account email, credentials, raw provider errors, or local auth file paths.

Normalization must reject non-finite/malformed values, keep missing windows unknown, and derive remaining percentage as `100 - usedPercent` only from a valid used percentage. Clamp valid numbers to the display range. Stable pool/window IDs prevent accidental duplication. Catch each source independently so one failed provider does not erase other readings.

Start with an injectable fixture adapter for local proof plus honest unavailable states. Production never silently falls back to fixture data. Cache successful readings with their original timestamps; an unsuccessful refresh marks them stale and preserves the last-good timestamp. Coalesce refreshes and use a bounded polling interval/backoff rather than calling providers on every existing three-second UI poll. A client refresh cannot bypass the server throttle.

The installed tracker's README documents Codex, Claude Code, and optional Antigravity monitoring. It is not evidence of Cursor/Grok support, nor an established data-export service for Council. Inspect the actual adapter/export interface before proposing reuse. Do not import an imaginary tracker API. If copying source rather than the general visual pattern, inspect its license and retain required notices.

Codex's app usage tool was able to return an account-level reading in this planning session. That tool belongs to the assistant host and is not an API the standalone Council server automatically has. Do not hardcode that snapshot as a live integration or claim the panel refreshes it.

The initial coding pass uses fake data and local source inspection only. Return a concrete source map for each service: supported access method, units/window semantics, auth requirements, and remaining connection gate. Credential access, provider connections, and live verification require the existing owner authorization. No paid inference requests are needed to test a meter.

## Completion evidence

- Focused tests: used-to-remaining conversion; actual window labels; zero versus unknown; duplicate/shared pools; stale cache and failure isolation; reset passage; auth rejection; refresh throttling; fixture mode cannot appear as live data.
- Existing regression suite passes with the repo's Node 24+ test command (`npm test`). Do not invoke real provider adapters.
- Browser proof on the fake preview: all four service cards, multiple windows, a zero reading, unavailable service, stale reading, refresh/details, and a 390px layout. Capture proof with fixtures labeled simulated. Starting a new temporary preview is permitted only under the existing test authorization; do not stop or reconfigure Adam's running apps.
- Return changed files, local branch/commit, exact test results, screenshot paths, and a per-service connected/unconnected table. State clearly if browser verification could not run.
- No push, merge, deploy, spend, Jev connection, production changes, or unsolicited app launches.

## Delivery stages

First return a receipt with worker/model, local checkout/base, and scope. Implement and return the panel with simulated proof plus the source map. Codex reviews the evidence. Only a separately authorized, successfully verified provider connection may be labeled live. Until then the feature is a UI implementation with explicit unavailable readings, not an all-provider live usage dashboard.
