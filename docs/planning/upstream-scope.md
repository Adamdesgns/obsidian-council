# What Karpathy's llm-council does

Source clarification, 2026-09-13. This explains the independent proposal; it is not a peer review or a second/revised proposal.

Adam asked: “Why can't you just use that github? does it not do what it claims?”

It does what it claims. It collects model answers, supplies them for model-to-model critique and ranking, and asks a chairman model to synthesize a response. This is real cross-model review, not merely several disconnected answers displayed together. Its documented backend uses OpenRouter; the app provides a local interface for that process. [Upstream README](https://github.com/karpathy/llm-council)

We can use it as the starting point for the Council's discussion experience. The architectural question is how much to extend it, not whether its basic claim is false. My recommendation to avoid adopting the entire application wholesale concerns the larger execution and reliability requirements in Adam's directive.

Concrete extension points, if Adam selects an upstream-based build:

| Existing seam | Council addition |
|---|---|
| `backend/council.py` stages | Retain the answer/review/synthesis flow as one Deliberation template; add explicit revision tasks and evidence-based acceptance. |
| `backend/openrouter.py` | Keep as an optional API connector; add independent CLI adapters for real repository work. |
| `backend/storage.py` | Replace operational JSON read/modify/write with transactional tasks, deliveries, approvals and attempts. Preserve readable conversation exports. |
| `backend/main.py` | Dispatch durable jobs and stream their persisted events instead of making job lifetime depend on the request handler. Add authenticated local owner controls. |
| Frontend | Keep the concept of inspecting each response, then add assignments, artifacts, tests, approvals and recovery controls. Frontend source was not fully audited in this planning pass. |

These seams are established by the inspected [orchestration](https://github.com/karpathy/llm-council/blob/master/backend/council.py), [provider client](https://github.com/karpathy/llm-council/blob/master/backend/openrouter.py), [storage](https://github.com/karpathy/llm-council/blob/master/backend/storage.py), and [request handlers](https://github.com/karpathy/llm-council/blob/master/backend/main.py). An upstream-based choice could retain Python/FastAPI rather than rewriting the orchestration in TypeScript; a narrow CLI bridge can work with either. The competing plans should compare actual extension effort before selecting the stack.

Remaining diligence before copying code: establish an applicable upstream license, pin the selected commit, inspect dependencies and frontend, and preserve attribution. Public source visibility alone is not a confirmed license grant. No code was copied, installed or run in this session.

The first integration test remains the same whichever base Adam chooses: a real producer receives a task, another participant receives and critiques the output automatically, the first revises it, and the exchange survives an interruption. Later gates add local code changes, tests and Owner Sanction.

## Owner steering: efficiency

After this explanation, Adam said: “ahh make it more efficient. yes!” Record that preference in the plan comparison. The efficiency target is useful verified work per dollar and minute, not merely fewer tokens regardless of quality.

- Default to one producer and one reviewer. Summon additional expertise for a stated capability gap or material Dissent; do not send every request to every model.
- Send a pinned context manifest, relevant excerpts and artifact IDs. Do not replay entire vaults or duplicate large media across prompts. Retrieve additional evidence when needed.
- Review against acceptance criteria first. Revise only specific unresolved findings; stop when the required evidence passes. Do not require another all-member ranking round for routine repairs.
- Use deterministic code for scheduling, permissions, formatting and state changes. Spend model calls on planning, implementation and judgment. Use simpler eligible models for bounded tasks, with the same acceptance gate.
- Reuse a prior result only when its task, context, artifact hashes, model/configuration and freshness requirements still match. Never reuse a stale approval or assume a prior external action should run again.
- Measure accepted results, total tokens/cost, elapsed time and rework against an all-member discussion baseline on the same small fixture set. Retain the cheaper route only if required quality and safety checks still pass.

This is a recorded preference and evaluation checklist. It is not the peer-reviewed revised recommendation or authorization to bypass the requested lead/ownership selection.

## Owner steering: wake members into a shared chat

Adam: “that would be nuts if I could just wake ya'll to jump into a chat with me”.

Make Summons an explicit first-class interaction: Adam opens a Chamber and invites available members by name or capability. The coordinator starts or resumes that Chamber's dedicated supported sessions, supplies scoped history, records acknowledgments and presents their messages in one shared timeline. Adam can address everyone, one member, or a reviewer; a member can ask another for help and return to Adam without manual copying.

Use directed turns and a bounded automatic-reply policy. Do not wake every member for every message. Show invited, joining, present, thinking, unavailable and asleep states honestly; missing authentication or quota produces a clear blocked Summons. Preserve the room while workers are asleep, and restore only authorized relevant context when they return. A normal conversation message does not authorize a protected action.

The practical first target is dedicated Codex and Claude CLI sessions, not a claim that we can attach to these exact existing desktop chats. Session identity, tools, provider/account mode and permissions are visible. An existing-session bridge can be evaluated later. This turn expresses a desired product experience; no agents were launched, provider calls spent or background wakeup automation installed.
