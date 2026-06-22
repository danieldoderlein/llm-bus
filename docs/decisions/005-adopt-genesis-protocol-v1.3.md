# 005 - Adopt the Genesis Protocol v1.3 and lock the existing architecture

**Date:** 2026-06-16
**Status:** Accepted

## Decision

Bring this already-deployed repository under **Claude Code Genesis Protocol v1.3** governance and, in
the same act, **lock the existing architecture** as the baseline. This is a fresh bootstrap of an
existing codebase, not a greenfield scaffold and not a migration from a prior protocol.

Concretely:
- The architecture of record is the system that already ships: TypeScript / Node >= 22 (ESM,
  NodeNext, `.js` specifiers), the official MCP SDK over Streamable HTTP, PostgreSQL via `pg`, `zod`,
  no web framework, a server-rendered admin behind Google SSO, deployed to the shared `odina-vm`.
  It is described - not redesigned - in [docs/architecture.md](../architecture.md).
- The Definition of Done and Verification Mandate bind to the **real suite**: `npm run typecheck`
  plus the 12 existing tests (including the 500-concurrency proof and the fail-open hook test) via
  `npm run verify`. Governance does not add a doc-coherence check as the gate.
- The seven existing invariants (token-derived identity, atomic gap-free claim, owner isolation, the
  Caddy-stripped admin header, fail-open posture, ledger-preserving deletes, hashed tokens) are
  carried verbatim into CLAUDE.md and treated as load-bearing.
- Governance substrate generated: a sectioned `CLAUDE.md` (00-12), `.claude/agents/` for
  planner/gatekeeper/drift-checker, `.claude/skills/` for repair and bootstrap-stack,
  `.claude/settings.json` (scoped permissions + verification-reminder hook), `PLAN.md`, and this
  decision log.

The protocol normally seeds decision 001 from the Phase 1 architecture choice. Here the origin
decisions were backfilled chronologically as 001-004, so the architecture-lock decision lands at 005;
the protocol's intent (a decision records the locked architecture) is satisfied.

## Context

The repo was live in production with full git history but no Genesis governance (it had a good
hand-written `CLAUDE.md`, but not in the protocol's sectioned form, and no `docs/decisions`,
`PLAN.md`, or `.claude/agents`). The conception decisions lived only in the `ai-coding-startkit`
method library. Bootstrapping makes the repo self-contained and cross-rig portable.

## Alternatives considered

- **Leave the hand-written CLAUDE.md as-is** - rejected: it lacked the planning gate, independent
  review agents, drift triggers, and a durable task ledger; its strong content was folded in, not
  discarded.
- **Treat this as a migration** - rejected: there was no prior protocol to migrate from; this is a
  first bootstrap.
- **Redesign anything during the bootstrap** - rejected: the constraint is to describe and lock what
  runs, never to churn the live app.

## Consequences

- Future work runs through the planning gate, the gatekeeper Definition-of-Done review, and the
  drift-checker on its triggers; the four documents (README/PLAN/architecture/decisions) form a
  closed loop.
- Architecture changes now require a new decision file plus an architecture.md update.
- The protocol generation followed the Currency Rule: native frontmatter/hook formats were verified
  against current Claude Code docs at bootstrap (agents use `tools`; skills use `allowed-tools`).

## Follow-ups

- Coordination posture (whether to dogfood the bus) recorded separately in
  [006](006-solo-operation-no-self-dogfooding.md).
