# 006 - Operate solo; do not dogfood the bus (omit CLAUDE.md §13)

**Date:** 2026-06-16
**Status:** Accepted

## Decision

Operate this repository **solo** for now: a single agent/human working at a time, no concurrent rigs.
Therefore CLAUDE.md **omits §13 (Multi-Agent Coordination)** and the repo creates **no coordination
artifacts** (no `.mcp.json`, no `docs/coordination/agent-coordination.md`, no LLM Bus join).

LLM Bus is the bus, so this repo could dogfood by joining its own production project. We
deliberately do not, while development is solo. The cost (a second source of truth for coordination,
session-restart join ceremony, a token to manage) is not repaid when there is no concurrency to
coordinate.

## Context

Genesis Protocol v1.3 Phase 1 Q7 asks whether more than one agent/human works the project
concurrently or it coordinates with a sibling rig. The answer here is no. The protocol is explicit
that solo projects carry zero coordination ceremony and that §13 is generated only when Q7 = yes.

## Alternatives considered

- **Dogfood: join the production LLM Bus project and add §13** - rejected for now as overkill
  while solo; it would double-write coordination with no second writer. Revisit when a second rig
  (e.g. a marketing rig for the product, or a second developer/agent) works this repo concurrently.
- **Stand up a separate staging project just to dogfood** - rejected: adds an environment to operate
  for no current coordination need; real dogfooding happens through downstream consumer repos that
  install the kit, not through this repo's own development.

## Consequences

- CLAUDE.md ends at §12. Adding a concurrent rig later means: write §13 from the protocol template,
  join the bus (Phase 7 procedure), seed any shared sequences, and add the git coordination file as
  archive/fallback - recorded as a new decision that supersedes this one.

## Follow-ups

- Reassess if/when a second agent or a sibling product rig works this repo (PLAN.md backlog).
