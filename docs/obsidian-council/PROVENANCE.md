# Provenance — Council planning docs

These planning documents have lived in three places. This note records the trail so the
older paths inside the documents themselves stay readable as history rather than as bugs.

| When | Where | Why it moved |
|---|---|---|
| until 2026-09-14 | `Projects/docs/obsidian-council/` | original home |
| 2026-09-14 | `OneDrive/Documents/ChatGPT/The OBSIDIAN COUNCIL/docs/obsidian-council/` | Adam's call — "Dissent 3 (one home) is resolved: this workspace" |
| 2026-09-18 | here, in the code repo | the OneDrive copy had **no git remote**, so Council routing work was accumulating in a repo that was never backed up and that Cursor does not build against |

Any path inside these documents that still reads `Projects/docs/obsidian-council/...` is
historical. The bytes were never rewritten, so the published hashes below remain valid.

## Hash verification

Carried over from the 2026-09-14 pointer file and re-verified on 2026-09-18 after the copy
into this repo. All three matched exactly:

| File | SHA256 |
|---|---|
| `proposals/claude-plan.md` | `B63DEFE687CE4BB1780380A1597CBBFFD850154EB89E37F834A31999E055BAC4` |
| `reviews/claude-review-of-codex.md` | `62851E7E5FA077391702709B974B43235D8D61214B1BF360E8AA07B3A90789AE` |
| `recommendations/claude-revised-recommendation.md` | `8ADEFF6BC097AA20646DA3D69AAA881B3A1222500D757DB464057813FBA7F346` |

`proposals/codex-plan.md`, `upstream-scope.md` and `README.md` are Codex's and were never
modified by Claude.

## Two files that existed nowhere else

`LIVE-SESSION-PROCEDURE.md` and `reviews/grok-review.md` were untracked in the OneDrive
workspace — never committed, in a repo with no remote. This commit is the first time either
has been under version control anywhere.

## Still outside this repo

The illustrated article (`article/ARTICLE.md`, `article/MEDIA-AND-FACTS.md`,
`article/preview.html` and its image/video assets) remains in the OneDrive workspace. It is a
separate publication rather than project documentation, and several of its assets are still
uncommitted there. That workspace has no remote, so those assets are currently unbacked-up —
worth resolving separately.
