# OKF wiki starter (LLM Bus kit)

A structure-only starter for an **OKF** (Open Knowledge Format) knowledge wiki. LLM Bus ships this
template but never stores or hosts the content: the wiki lives as files in your project's git repo.

## Division of labor

- **LLM Bus (the bus)** = live coordination only: claims, leases, posts/acks, presence.
- **This OKF wiki (files in git)** = durable knowledge: runbooks, living specs, glossary,
  current-state, how-it-works.
- **`docs/decisions/`** = the immutable rationale spine. Link decisions from the wiki; do not restate
  them.

## Placement

Per the consuming repo's Genesis v1.4 §14: `docs/wiki/` for a standard repo, `wiki/` for a platform
repo. `install.sh --with-okf` seeds into `docs/wiki/` by default and never clobbers existing files;
move it to `wiki/` for a platform repo.

## What is pinned vs verified (the Currency Rule)

This template pins only the STRUCTURE: typed markdown nodes (frontmatter with a `type` field), a
reserved index node (`index.md`, no frontmatter), a reserved history node (`log.md`), and markdown
cross-links forming a knowledge graph. OKF is v0.1 and moving. **Verify the current reserved
filenames and frontmatter fields against the upstream spec at setup:**
`github.com/GoogleCloudPlatform/knowledge-catalog` -> `okf/SPEC.md`. Do not assume a fixed field list.
