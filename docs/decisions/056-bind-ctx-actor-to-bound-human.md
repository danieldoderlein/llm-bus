# 056 - Bind ctx.actor to the bound human (Part B of 054)

**Date:** 2026-08-13
**Status:** Accepted (operator-approved via bus task #525, option a: "Bind ctx.actor to the human +
backfill snapshots"). Refines [018](018-global-handle-identity.md) (the single identity composition
point) and [054](054-unify-qualified-actor-on-bound-human.md) (its Part B, tracked in OI-11). Number
claimed on the bus (`claim("decisions")` -> 056). Refined by
[061](061-assignee-routing-humans-visible.md) (composes the ASSIGNEE snapshot from the assignee's own
bound human, closing the `qualifyActor` caller-handle quirk this decision left as-is).

## Context

Decision 054 Part A aligned all SEVEN live-derived qualified-actor READ projections on
`COALESCE(participation.human_owner_id, participants.owner_id)`. It deliberately deferred the ROOT:
`ctx.actor` is composed in `src/auth.ts` (decision 018's architecture-locked "single identity
composition point") by joining `owners o ON o.id = pr.owner_id` - the **project owner**, a third owner
reference distinct from the provisioner and the bound human. `ctx.actor` feeds `whoami`, `register`,
and the denormalized SNAPSHOTS written once from it: `tasks.owner_name`, `posts.from_actor_name`,
`events.actor_name`.

Consequence (the regression vector OI-11 flagged): for an agent bound to a project MEMBER who is not
the project owner (Bob's agent in a the operator-owned Project B project), `whoami`/`owner_name`/`from` read
`owner/ai-claude-bob` while every 052/054 roster surface reads `bob/ai-claude-bob`. And because
`owner_name` is re-derived from `ctx.actor` on every task grab/assign, the OI-7 hand-patch of Bob's 17
`tasks.owner_name` rows would silently REGRESS to `owner/` on the next touch.

The operator ruled option (a): make the composition coherent AND backfill the snapshots.

## Decision

1. **`ctx.actor` prefers the bound human (`src/auth.ts`).** The auth query resolves ONE participation
   (the token's), so add `LEFT JOIN owners ho ON ho.id = pa.human_owner_id`, select `ho.username AS
   bound_handle`, and compose `handle = bound_handle ?? username` (bound human, then project owner, then
   the bare-label dual-read). Still derived only from the token-resolved row (invariant 1). This stays
   the single composition point (only `auth.ts` changed).

2. **Backfill the mutable snapshots (`scripts/backfill-actor-snapshots.ts`, owner-gated `--commit`).**
   Repoint `tasks.owner_name` (agent assignees, keyed on `owner_participation_id`) and
   `posts.from_actor_name` (agent authors, keyed on `from_participation_id`) onto the canonical
   `COALESCE(COALESCE(ho.username, po.username) || '/' || pt.name, pt.name)` where they DIFFER
   (`IS DISTINCT FROM`). Dry-run-first (tx + rollback + printed counts), `--commit` after a `pg_dump`.

## Non-goals / boundary

- **`ctx.project.ownerHandle` stays the PROJECT owner** (`o.username` on `pr.owner_id`) - it is decision
  044's cross-project qualifier (`owner/<slug>#id`); changing it would corrupt qualified ids. Likewise
  `ctx.owner`, `ctx.participant.ownerId`, `ctx.project.ownerId`, and the non-payment suspension gate
  (decision 016) stay keyed on the project owner (who pays). ONLY the DISPLAYED/written actor moves.
- **`events.actor_name` is NOT backfilled** - the ledger is append-only, grandfathered (decision 018
  R2, invariant 6). New events naturally carry the new `ctx.actor`; history is left alone.
- **`leases.actor_name`** (TTL-ephemeral, default 1800s) is not backfilled - it self-heals; new leases
  are correct.
- Pre-existing `qualifyActor` caller-handle quirk (`src/domain/task.ts`: an agent assignee's
  `owner_name` is qualified with the CALLER's handle, not the assignee's) is left as-is - a latent
  inaccuracy only under cross-human ASSIGNMENT, deferred to its own decision. The grab path (`ctx.actor`)
  is correct.
- No schema change; additive query join; no dependency/framework/state change.

## Key insight (a coincidence to preserve)

`auth.ts` falls back to the PROJECT owner (`o` on `projects.owner_id`); the backfill and the 052/054 read
projections fall back to the PROVISIONER (`po` on `participants.owner_id`). These produce identical strings
today ONLY because `participants.owner_id == projects.owner_id` is a structural invariant - enforced at every
participation-creation site (`grant`, `grantParticipation`, `admin_provision`, `createOwnerParticipation`) and
`projects.owner_id` is immutable (no ownership-transfer path). If a project-ownership-transfer feature is ever
added, it MUST also repoint `participants.owner_id` (or these fallbacks would diverge for a `human_owner_id`-NULL
agent). Not reachable today; flagged so a future transfer feature keeps the two in step.

## Verification

`npm run verify` green. `test:identity` extended with a cross-human case: an agent under project-owner A
rebound to human B renders `ctx.actor` = `B/label`, `ctx.participant.handle` = B, the ledger writes B -
while `ctx.project.ownerHandle` = A and `ctx.owner.id` = A (proving the 044 qualifier + billing/suspension
stay the project owner). `test:auth-suspension` stays green (suspension still keys on the project owner
after the added join). `test:concurrency` (500-concurrency) + `test:failopen` unweakened. Backfill script
dry-run exercised (tx + rollback).

## Owner-gated boundary (the backfill --commit)

The `auth.ts` change is ACT-tier (reversible, verified-green) and deploys under the standing mandate. The
backfill `--commit` is ASK-class (§01 authority axis: irreversible prod identity data): it runs only with
the operator's prod access + a fresh `pg_dump`, and the auto-mode classifier blocks it until re-approved
(the same guard as the OI-7 write). Parked in `docs/operator/open-items.md` OI-11; the dry-run is built +
runnable autonomously. On live data the count is expected near-zero (OI-7 already patched Bob's rows and
every live agent has `owner_id == human_owner_id`); the backfill is durability + belt-and-suspenders.

## Reviews

Gatekeeper on the diff (identity spine, decision-018 change, §11). [Filled in at review.]

Refines 018, 054.
