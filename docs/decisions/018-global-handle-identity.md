# 018 - Global handle identity model

Status: Accepted (2026-06-20). Supersedes the participant-naming clauses of
[004](004-owner-participant-model-and-web-admin.md) and the displayed-actor clause of
[006](006-no-section-13-solo.md). Spec: [docs/specs/global-handle-identity.md](../specs/global-handle-identity.md).

## Context

Participant names were unique only within an owner (`UNIQUE(owner_id, name)`), so the displayed bus
actor was an owner-local label. That makes cross-owner collaboration ambiguous (two owners can both
have `backend-agent`) and forces the invite/accept path to derive collision-prone names like
`human-<email-local>`. It also blocks the planned cross-owner "request to join" feature, where a
joiner must be unambiguous on someone else's bus.

## Decision

Promote the human to a globally-unique **handle** and make participants sub-identities under it.

- Every owner gets `owners.username` (a handle), globally unique (case-insensitive), seeded from the
  GitHub login or the email local-part, confirmable on first run. Email stays private (billing/auth);
  the handle is the public identity.
- A participant is addressed `handle/label` (separator `/`). Bare `handle` is the human as a
  first-class actor. Labels are freeform, unique within the owner's namespace (reuse
  `UNIQUE(owner_id, name)`), user-chosen - general (`claude-1`) or project-scoped (`claude-acme-dev`).
- The displayed and written bus actor is the qualified `handle/label`, composed in exactly one place:
  `src/auth.ts` `authenticateResult` (the `ctx` composition point). Identity is still token-derived,
  never from input (invariant 1).

## Rulings

- R1 - keep `participants.name`; add `label` mirrored to it (reversible, low-risk).
- R2 - grandfather historical `actor_name` strings; do NOT rewrite ledger history (protects invariant
  6; reversible). History shows the bare label; new rows show `handle/label`.
- R3 - invite/accept participants stay under the PROJECT owner (invariant 3 unchanged). A joiner
  keeping their own global handle (`alice/agent-1` in bob's project) is the deferred join feature; it
  needs cross-owner participation and gets its own decision.
- R4 - the bare-handle human actor is a reserved self-label rendering as the bare handle.
- R5 - `query_events` / `list_tasks` exact-match filters now expect the qualified `handle/label`;
  documented in README/USING.

## Consequences

- Cross-owner identity is unambiguous for free (the handle prefix disambiguates the owner-scoped
  label), which is what makes the future join feature collision-safe.
- Billing is unchanged: the project owner pays for all events in their project. "Bring your own
  tokens" is a separate future concept.
- Schema deltas are additive, idempotent, and reversible; the rollout is phased (A schema + dual-read,
  B backfill, C write-path cutover, D UI), each phase independently green and reversible.
- The exact-match query/filter contract changes (R5) - a behavior change documented for callers.

## Non-goals

Org/multi-human accounts; the request-to-join feature; bring-your-own-tokens; any change to the atomic
claim (invariant 2), the fail-open posture (invariant 5), or project-scoped billing.
