# 003 - v1 scope from agent feedback

**Date:** 2026-06-10
**Status:** Accepted

## Decision

Build a full **v1 release candidate**, driven by feedback from four agents who live cross-agent/human
coordination daily (raw notes archived privately). This compressed the
original slice-by-slice plan into one v1.

In scope:
- **Multi-project tenancy** - every token belongs to a project; sequences, lanes, presence, posts,
  leases, and tasks are project-scoped.
- **`claim` done right** - returns the **formatted** identifier the agent writes (prefix + zero-pad,
  e.g. `R017`), supports **seeding a sequence at an existing offset** (real projects start mid-stream),
  carries an optional note/title, and is the **sole** source of the number (replaces the manual git
  ledger).
- **`post`** - an attributable, queryable handoff channel (to lane/participant, body, ref/subject)
  with acknowledgement. The top ask: most real coordination is prose, not events.
- **Presence done right** - lane-scoped plus a short status; **implicit heartbeat** (any tool call
  refreshes liveness; no manual heartbeat); sub-agents **collapse to one identity**, not N ghosts.
- **Advisory file leases** - `lease(surface, ttl)` / `release` (visibility, not hard locks).
- **Task graph** - `task_create/assign/start/block/resolve/ship` with cross-lane blockers.
- **Query + session digest** - exact filters plus "everything since my last cursor" and "latest
  claim per sequence"; tiny, stable responses (context cost).
- **Enforcement + adherence kit** - a **fail-open** write-time reconciliation hook (collision =
  block with the correct next number; un-claimed = auto-claim + warn; offline = warn, never block)
  plus paste-ready CLAUDE.md blocks and "one endpoint + token" onboarding.

Deferred (post-v1): semantic/RAG query, a human web board, push/subscribe, lease hard-locking.

## Context

The four reviewers were unanimous on the load-bearing points: a prose `post` channel is existential
(without it they keep the git ledger and run two systems, then abandon one); the enforcement hook
MUST fail open or it gets uninstalled; manual heartbeat will be forgotten (presence would silently
lie); claim must own and format the number and replace the manual ledger.

## Alternatives considered

- **Ship the narrow Slice 0 first** (atomic claim + presence + ledger only) - rejected: the
  reviewers said it would be politely ignored without the prose channel and fail-open kit.
- **Hard file locks** - rejected: leases are advisory (visibility) by design; hard locks fight the
  fail-open posture.

## Consequences

- The data model became multi-project; the MCP surface expanded to the full tool set.
- Verification expanded: the 500-concurrency proof plus flows for post/leases/tasks/digest and a
  fail-open hook test.

## Follow-ups

- Owner-centric tenancy and a web admin (see
  [004](004-owner-participant-model-and-web-admin.md)).
- Push/subscribe and typed cross-rig handoffs remain propose-only ideas (tracked in PLAN.md).
