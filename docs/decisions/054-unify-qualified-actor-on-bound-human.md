# 054 - Unify the qualified-actor derivation on the bound human (finish 052's follow-up)

**Date:** 2026-08-13
**Status:** Accepted. Refines [052](052-show-owning-human-on-participant-surfaces.md) (executes the
tracked follow-up 052 deliberately left out), transitively 037/038 (lineage - bare numbers). Number
claimed on the bus (`claim("decisions")` -> 054). Refined by
[056](056-bind-ctx-actor-to-bound-human.md) (Part B: binds the ROOT `ctx.actor` composition point to the
bound human + backfills the `owner_name`/`from_actor_name` snapshots). Refined by
[061](061-assignee-routing-humans-visible.md) (extends the bound-human derivation from the READ
projections to the ASSIGNEE write path and the web board's assign snapshot).

## Context

Decision 052 made the project **Access** page (`listParticipations`) derive an agent's owning human as
`COALESCE(participations.human_owner_id, participants.owner_id)` - prefer the per-project **bound human**
(canonical per 038), fall back to the **provisioner**. It flagged, as an Accepted-no-fix tracked follow-up,
that sibling surfaces still derived the qualified actor from the provisioner (`participants.owner_id`) only.
A `grep` of `src/` for the `username || '/' || name` derivation (plus the gatekeeper's §04 capability-surface
sweep of the same class) found **every** remaining live-derived qualified-actor read projection:

- `connectionStatus` (`src/admin/queries.ts`) - the connect-indicator's backing endpoint.
- the `list_participants` MCP tool (`src/mcp.ts`) - the over-the-wire roster agents read.
- `whoIsActive` / `who_is_active` domain presence (`src/domain/presence.ts`).
- `active_peers` in `whatsNew` (`src/domain/digest.ts`) - the session-digest presence roster (mirrors `whoIsActive`).
- `created_by_name` on the task board list + detail (`src/admin/queries.ts`, two queries) - "who asked" the task.
- `to_actor` on a targeted post (`src/domain/post.ts`) - the qualified name of a post's recipient.

All were **correct only because the OI-7 rebind made `owner_id == human_owner_id` for every live agent** -
latent, not a live misattribution. A future agent **provisioned by human A but bound to human B** (the normal
invite-accept path: `grantParticipation` sets `participants.owner_id` = the project owner but
`participations.human_owner_id` = the accepting member) would render under the wrong human on these surfaces
while the 052 access page rendered it correctly - i.e. the "who belongs to whom" family would disagree with
itself. (Initial scope was the first three; the gatekeeper found the other three same-class surfaces, so Part
A was widened to cover them all rather than leave a second silent gap against 052's word "every.")

## Decision

**Part A (this decision).** Align **every** live-derived qualified-actor read projection (the seven above)
onto the derivation 052 shipped: the actor handle is
`COALESCE(COALESCE(ho.username, po.username) || '/' || pt.name, pt.name)`, where `ho` LEFT JOINs `owners` on
the participation's own `human_owner_id` (bound human) and `po` on `participants.owner_id` (provisioner); if
both are null the outer COALESCE falls back to the bare label. The `human_owner_id` was already in scope of
each query (each already joins the relevant `participations` row - `pn`/`pa`/`pa2`/`tpa`), so each change is
one added `LEFT JOIN owners <ho>` plus the wrapped projection - the WHERE predicates are byte-identical.

## Non-goals / boundary

Read-projection only: no schema, no dependency, no change to any owner/membership isolation predicate
(invariant 3 - the added joins are PK lookups with no fan-out), no HTML surface (all seven return JSON). On
today's live data it is a **no-op** (every agent has `owner_id == human_owner_id`); the change only manifests
for a future cross-human-provisioned agent, toward the canonical value.

**The denormalized SNAPSHOTS are NOT touched here - they are Part B.** A stored actor string is written once
from `ctx.actor` and never re-derived at read: `tasks.owner_name` (the board assignee, invariant 6),
`posts.from_actor_name` (a post's author), and `events.actor_name` (the ledger). These are deliberately left
on the composition-point value so a single decision (Part B) moves them together with `ctx.actor` and a
backfill. (The post `to_actor` IS live-derived and so is fixed here; the post `from` is a snapshot and is not.)

**Part B is explicitly deferred to an operator decision, NOT done here.** The *root* actor composition is
`ctx.actor` in `src/auth.ts`, which derives from `pr.owner_id` (the **project owner** - a third reference,
distinct from provisioner and bound human) and is decision 018's architecture-locked "single identity
composition point" (`docs/architecture.md`). It feeds `whoami`, `register`, and every snapshot above. Changing
it would (a) touch decision 018 + need an architecture.md update, and (b) require a prod backfill of
`tasks.owner_name` (+ `posts.from_actor_name`) - an owner-gated live-data write, invariant-6-adjacent, that
would re-touch the 17 rows the OI-7 fix hand-patched, which otherwise silently regress to the project owner
the next time the affected agent touches a task. That is an ASK-tier bundle filed as an operator decision task
+ open-item OI-11. Part A does not block on it and does not worsen it: the `whoami`/snapshot-vs-roster
divergence it leaves is pre-existing and owned entirely by Part B.

## Verification

`npm run verify` green (no test-file / tool-count change). Guards added/strengthened that **seed the
divergence explicitly** (the 052 gap was that live data masks it) - one per surface family:
- `test:connection-status` rebinds an agent's `human_owner_id` to a second human and asserts `connectionStatus`
  renders the bound human while the project owner still sees the row via the reprove predicate's project-owner branch.
- `test:smoke` rebinds the provisioned `teammate` and asserts BOTH `list_participants` and `who_is_active`
  render `member/teammate` while the bare-label `tester` (owner with no handle) stays bare.
- `test:digest` binds the active peer to a second human and asserts `active_peers` renders `member/peer-agent`
  (was a weak `endsWith("peer-agent")` assertion that passed on the bare label).
- `test:post` rebinds a targeted post's recipient and asserts `to_actor` renders the bound human.
- `test:taskwrites` rebinds the task creator and asserts the board's `created_by_name` renders the bound human
  (capture-and-restore, so the downstream isolation/handoff assertions are unperturbed).

`test:identity` stays green unchanged (proof Part A did not touch the decision-018 `ctx.actor`/ledger path).

## Reviews

Gatekeeper on the first commit (multi-file, behavior-changing on an MCP surface, §11): verified all seven
enumerated safety claims PASS (WHERE predicates byte-identical, LEFT joins are PK lookups, null-handling
correct, `auth.ts`/decision-018 untouched, JSON surfaces so invariant 4 N/A, doc loop consistent, SQL correct)
and re-ran `npm run verify` EXIT 0. **Verdict: CHANGES-REQUESTED**, a single scope/completeness finding.

**Fixed-before-merge (the finding):** the initial commit fixed three surfaces, but 052's follow-up said unify
"EVERY" derivation and three MORE same-class live projections still read the provisioner - `active_peers`
(`digest.ts`), `created_by_name` (`queries.ts` ×2), `to_actor` (`post.ts`) - a second silent narrowing.
Resolved by **widening Part A to all seven** (a `grep` of `src/` confirms no eighth), each the identical
one-line `LEFT JOIN` + wrapped projection, plus a dedicated divergence test per surface family (see
Verification). The stored snapshots (`owner_name`/`from_actor_name`/`actor_name`) were correctly identified as
Part B (composition-point + backfill), not this class.

Refines 052.
