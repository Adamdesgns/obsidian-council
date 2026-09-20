# Council planning record — index

Consolidated here on 2026-09-18. **This directory is the single home for Council
planning documents.** Before that they lived in a second git repo under
`OneDrive\Documents\ChatGPT\The OBSIDIAN COUNCIL`, with a pointer file in a third
place — three addresses for one project, and the newest handoff sitting in the repo
that had no remote and was not the one anyone builds against.

`README.md` beside this file is Codex's Phase Zero record, left exactly as written.
This index is navigation only.

## Integrity

Three files were published with SHA256 hashes that Codex and Grok were given. The
bytes were preserved through the move and re-verified after it:

| File | SHA256 |
|---|---|
| `proposals/claude-plan.md` | `B63DEFE687CE4BB1780380A1597CBBFFD850154EB89E37F834A31999E055BAC4` |
| `reviews/claude-review-of-codex.md` | `62851E7E5FA077391702709B974B43235D8D61214B1BF360E8AA07B3A90789AE` |
| `recommendations/claude-revised-recommendation.md` | `8ADEFF6BC097AA20646DA3D69AAA881B3A1222500D757DB464057813FBA7F346` |

Any path inside those three files that still reads `Projects/docs/obsidian-council/...`
or points at OneDrive is historical. It was left untouched on purpose so the published
hashes keep verifying.

## The planning exchange

Both sides produced one proposal, one peer review of the other, and one revised
recommendation. Grok reviewed the pair.

| | Codex | Claude | Grok |
|---|---|---|---|
| Proposal | [codex-plan.md](proposals/codex-plan.md) | [claude-plan.md](proposals/claude-plan.md) | — |
| Peer review | [codex-review-of-claude.md](reviews/codex-review-of-claude.md) | [claude-review-of-codex.md](reviews/claude-review-of-codex.md) | [grok-review.md](reviews/grok-review.md) |
| Revised recommendation | [codex-revised-recommendation.md](recommendations/codex-revised-recommendation.md) | [claude-revised-recommendation.md](recommendations/claude-revised-recommendation.md) | — |

- [decision-sheet.md](decision-sheet.md) — what Adam approved on 2026-09-14: combined
  plan, staffing, the Phase 1 spike, code home, and run ceilings.
- [upstream-scope.md](upstream-scope.md) — Codex's clarification of the supplied GitHub project.
- [grok-review-brief.md](reviews/grok-review-brief.md) — the brief Grok was given.
- [LIVE-SESSION-PROCEDURE.md](LIVE-SESSION-PROCEDURE.md) — running a live Summon.

## Session handoffs

- [codex-phase-zero-handoff.md](codex-phase-zero-handoff.md)
- [codex-peer-review-handoff.md](codex-peer-review-handoff.md)
- [codex-continuation-handoff.md](codex-continuation-handoff.md)
- [2026-09-16-cursor-handoff.md](2026-09-16-cursor-handoff.md)

## Where the rest lives

- **Current design work** — `docs/superpowers/specs/` and `docs/superpowers/plans/`.
  The Deliberation Engine spec and its 15-task plan are on branch `council/deliberation`.
- **Phase evidence** — `docs/evidence/` (Phase 1 acceptance, Phase 2 live proof).
- **The illustrated build story** — its own private repo,
  `Adamdesgns/obsidian-council-article`, working copy still in OneDrive. Kept separate
  because it is ~6 MB of images and video that does not belong in an app repo.
- **Live handoffs between assistants** — `Projects\docs\handoffs\`, not here. This
  directory is the planning record; the bus is for traffic.
