# Deliberation Engine local acceptance — 2026-09-19 — [Codex]

Status: local implementation verified; not merged, pushed or deployed. Adam's human Floor acceptance is still separate. User authorized takeover after the cold review and explicitly deferred Jev access.

Base main: dee4728. The six existing jev-judge commits were cherry-picked onto isolated branch codex/council-deliberation-complete, preserving both original branches. Corrected design: ../superpowers/plans/2026-09-19-deliberation-corrections.md. Original plan/spec remain historical; conflicting recipes are superseded by that amendment.

## Implemented scope

- Tasks 1–4: configured seat/adapter/account/model resolution; shared Claude/Fable quota; token backfill without changing existing tokens; server-side mentions.
- Tasks 5–9: strict last-line verdicts, isolated blind packets and fresh provider sessions, durable deliberation/message membership, account preflight and reservations, three-round cap, exact-candidate agreement, escalation/deadlock to owner.
- Tasks 10–12: scripted fake-provider output; precise delivery claims across chambers; transactional reply/ack/advance/outbox writes; state-based dispatch exclusion; failure stalls; HALT/cancel generation fencing; honest engine attribution.
- Tasks 13–14: owner-only start/list/read/approve/overrule/cancel/resume; hash-scoped approval consumed in the same commit as settlement; request/approval retry safety; explicit resume preserves completed peers. Generic sanction requests now require content; server derives the hash.
- Task 15: test isolation, failure/reopen tests and actual local browser exercise. npm test enforces fake-only execution. Old Codex policy fixtures now write to temporary homes, not the user's profile.
- Floor controls: Deliberate, displayed answer/discussion, approve, replacement answer, pause/resume and cancel. Internal engine packets stay in the database, not the ordinary chat view. Composer remains visible after a long discussion.
- Standalone local responsiveness screen hardened for quoted/conditional absence and invalid results. Injected fake client errors/timeouts are covered. No real Jev client, key setup or live call exists.

## Evidence

Final npm test: **86 tests passed, zero failed/skipped/cancelled**, around 9 seconds, Windows Node. Includes all existing routing, double-click, restart, API, MCP bridge, sanctions and outbox tests plus new deliberation/seat/judge tests.

New checks explicitly cover:

1. Conflicting AGREE answers do not become agreement.
2. Crash injection after reply acknowledgment and after advancement rolls the whole transition back; reopening recovers.
3. Successful peers are preserved while stalled; repeated ticks spend no additional runs; explicit resume retries unfinished work.
4. HALT abandons stalled work, and stale generations/rounds cannot advance.
5. Exactly eight successful fake runs reach the three-round deadlock without conversational caps.
6. Approval transaction rollback leaves neither a consumed sanction nor a settled row; repeat approval is a no-op.
7. Forged engine keys/identities are rejected; member APIs cannot claim engine-managed work.
8. Two active chambers with an expired lease claim the correct delivery and retain the correct chamber identity.
9. Provider sessions seeded with old context are never resumed by deliberation; the second blind packet excludes the first answer.
10. Fable/Claude share one quota, pending deliberations reserve capacity, and existing bearer tokens survive backfill.
11. Generic sanction endpoint derives the content hash and rejects hash-only requests.

The first broad run exposed the expected new-seat assertion plus an older Windows taskkill failure. The assertion now reflects four seats, and failed taskkill falls back to direct child termination. Interrupted runs also fence their delivery generation immediately. The following full run passed 82/82; after extra negative tests the final run passed 86/86. Historical failed output is retained in the external review folder.

## Browser proof

Actual Codex in-app browser against scripts/preview-fake.mjs, a separate temporary home and random loopback port:

- Typed a question and clicked Deliberate; saw independent responses and ready-for-owner agreement.
- Clicked Approve this answer; saw Approved (stored state settled).
- Submitted a simulated failure; saw paused status and provider reason.
- Clicked Resume; reached owner review.
- Entered a replacement answer and clicked Use my answer; saw it saved, and it survived reload.
- Submitted a deadlock fixture; three rounds stopped at the owner.
- Clicked Cancel; approval and replacement controls became disabled.
- Screenshot retained outside the repository in the review evidence directory.

This is real UI with simulated providers. It does not prove live model access/quality or replace Adam's acceptance. The preview never touches the real Council home and is closed after verification.

## Boundaries and next steps

- No Jev access required. No live provider was called, no account/key/port-exposure change, no KEORIS/phone work.
- The Fable seat resolves to Claude's configured default model unless a model is explicitly set in config/council.json; no particular live model/version was certified here.
- Approval records the decision only; it does not execute it. Delegations, automatic execution, model cost routing and phone voice remain separate.
- Local replies are durable and fenced; an interrupted external provider can be invoked again if its reply was never committed. This is not an exactly-once provider execution claim.
- Next: Adam reviews the local Floor and explicitly authorizes landing/release. Main and the original jev-judge checkout are unchanged.

External evidence directory:
C:/Users/steam/.codex/visualizations/2026/09/19/01a0ba30-bf1d-7fe2-8ee5-b5c6f9beae52/council-review/

Raw final test log: build-suite-final.txt. Browser screenshot: floor-final.png.
