# 007 - OKF knowledge-layer support: produce and discover, never store

**Date:** 2026-06-16
**Status:** Accepted

## Decision

Add **OKF (Open Knowledge Format)** support to LLM Bus as an **advisory, fail-open** capability
that helps projects **produce and discover** OKF-shaped knowledge wikis. LLM Bus does **not** become
a knowledge store: the wiki lives as files in each project's git repo; the bus stores nothing.

Scope built (operator-approved):
1. **Onboarding declares the division of labor.** The shared `coordinationGuide` (which flows into the
   web-admin hand-out card and the `/join` redeem guide) and `buildInvitePrompt` now carry a short
   "Knowledge layer (OKF)" pointer: the bus is live coordination only; durable knowledge lives as an
   OKF wiki in git (`docs/wiki/` standard repo, `wiki/` platform repo, per the consuming repo's Genesis
   v1.4 §14); link decisions, do not restate them. The kit blocks
   (`kit/CLAUDE.md.block.md`, `kit/CLAUDE.md.admin-block.md`) carry the same paragraph so it persists in
   the consuming repo.
2. **Optional structure-only scaffold.** `kit/install.sh --with-okf` seeds a starter wiki
   (`kit/okf/`: `index.md` with no frontmatter, `log.md`, an `overview.md` node with only `type`, and a
   README) into `docs/wiki/`, idempotent and never-clobber.

Deferred (operator-approved): a **cross-rig knowledge index tool** (`register_wiki`/`list_wikis`). It
would either breach multi-tenant isolation (cross-project discovery) or duplicate the wiki's own
`index.md` (one-source-of-truth violation), and the existing bus already carries a within-project
pointer via `post(ref=..., tag=...)`. Revisit only if multiple wikis per project proliferate and the
post-a-ref pattern proves insufficient.

## Context

The DRD Genesis Protocols now mandate OKF as the optional knowledge layer (claude-code v1.4 Phase 9,
commercialization v0.5; ai-coding-startkit decision 011). That decision's sub-decision 6 resolves Agent
Sync's old deferred "Slice 2 semantic knowledge layer" as **OKF-as-files**, not a bespoke store, and
marks LLM Bus OKF support as propose-only, designed in this repo. This decision is that design,
approved and built. LLM Bus had no knowledge domain (confirmed: claim/presence/post/lease/task/
digest/query) and gains none.

## Alternatives considered

- **Build a knowledge store / the old Slice 2 in LLM Bus.** Rejected: violates the division of
  labor; OKF-as-files needs no server, survives outside any tool, and is human- and agent-readable.
- **Build the cross-rig index tool now.** Rejected (deferred): isolation breach or `index.md`
  duplication; the bus's `post`+`ref` covers the within-project need.
- **Hardcode OKF v0.1's frontmatter field list into the prompts/scaffold.** Rejected: OKF is a young,
  single-vendor v0.1 spec, and its own README/SPEC already disagree on the history-node name
  (README `change-log` vs SPEC `log.md`). Per the Currency Rule, the prompts and scaffold pin only the
  structure (typed nodes + a `type` field + an index node + a history node + cross-links) and tell the
  reader to verify reserved filenames/fields against the upstream spec at setup.

## Consequences

- New surfaces are text-only and advisory: no schema change, no new MCP tool (surface stays 26), no new
  runtime dependency, no runtime network calls, no change to identity/isolation or any §02 invariant.
- `test/invite.redeem` and `test/admin.crud` assert the onboarding output now carries the OKF pointer;
  `npm run verify` stays green (12 tests). The `--with-okf` scaffold is verified manually out-of-suite
  (idempotent, never-clobber, bad-arg rejected); no shell-test harness was added.
- USING.md/README may later document the `--with-okf` flag; tracked in PLAN.md.

## Follow-ups

- Reassess the deferred cross-rig index tool if within-project `post`+`ref` proves insufficient.
- Revisit if the OKF spec moves materially past v0.1 (reserved names/fields are verify-at-setup, so the
  prompts and scaffold need no code change for additive field changes).
