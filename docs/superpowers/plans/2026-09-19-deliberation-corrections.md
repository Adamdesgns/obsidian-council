# Deliberation implementation corrections — 2026-09-19

Adam authorized Codex to take over and complete the local build after the cold review. This amendment supersedes conflicting recipes in the September 18 plan. Original planning documents remain unchanged for provenance. Human Floor acceptance and permission to push/merge remain outstanding; they do not block this explicitly authorized isolated local implementation.

Jev access is deferred by Adam. No live client, key configuration, cost routing, or model-based arbitration is part of this build. The local judge stays optional/advisory.

Tasks 1–4: configurable seats resolve adapter/model/account, with shared account ceilings and token backfill. No hardcoded fourth adapter. Keep existing Claude ceiling compatible; deliberation uses dedicated sessions and bridge disabled.

Tasks 5–9: strict final-line verdict parser, three debate rounds, unique isolated chamber per question. Both AGREE bodies must match the server's identified candidate answer; inconsistent agreement continues debate. Store engine messages as engine, never owner. The original owner's question is its own record. Store message membership, phase, round and recipient server-side. Commit successful delivery acknowledgment, reply text, transition and all next deliveries together. Stale generations/rounds cannot advance. No network or process spawn inside a transaction.

Tasks 10–12: fake-provider scripting only via explicit test options. Claim the exact delivery tick checked. Authenticate engine membership from stored rows, not caller keys. Engine replies bypass normal relay paths entirely. Failures park deliveries and stall the deliberation; no background provider retry. Owner resume checks remaining account budget and requeues only unfinished work. HALT/cancel also abandon stalled work and fence all outstanding generations. In-flight peer successes may be retained while stalled but cannot start a next round until resumed.

Task 13: owner-only routes to start/list/read/approve/overrule/cancel/resume. Limits are explicitly shared with dispatcher. Approval requires pending_owner and the displayed candidate hash; create/validate/consume a scoped sanction and settle in one transaction. Retry is idempotent. No execution of the accepted answer in this scope.

Task 14: explicit owner resume, not polling for hypothetical provider availability. Recheck remaining work, preserve completed responses, never repeat a completed member merely because its peer failed. Recovery after process death reclaims the unacknowledged generation; already committed responses and next messages survive.

Task 15: run hermetic fake-provider suite, fault-injection/reopen tests, two-chamber lease test and local browser proof. Remove real-profile fixture writes from tests. No installed CLI invocation. Keep raw results and distinguish automation from Adam's acceptance.

Floor: add the minimal Deliberate + Black Seat controls so the implementation is usable, preserving ordinary Say/routing. Show pending answer, both responses, round/flag and failures. Resume requires a user click; approval identifies the exact displayed answer. No phone redesign or KEORIS changes.
