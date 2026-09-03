# 052 - Show the owning human (`human/agent`) on the project access surface

**Date:** 2026-08-13
**Status:** Accepted (operator-directed, 2026-08-13). Refines
[037](037-multi-human-project-membership.md)/[038](038-targeted-invite-only-enrollment.md) (makes
the agent-to-human binding those decisions introduced *visible* on the access surface). Number claimed on the
bus (`claim("decisions")` -> 052). Refined by
[054](054-unify-qualified-actor-on-bound-human.md) (the tracked follow-up: the three sibling surfaces + the
deferred `auth.ts`/`owner_name` Part B).

## Context

The project **Access** page (`/admin/projects/:id/access`, "Participants in this project") listed each agent by
its bare name (`ai-claude-bob`), with no indication of **which human it belongs to**. In a multi-human project
(decision 037 - e.g. the operator + Bob on Project B) that hides exactly the fact the operator needs: whose agent is
whose. The task board already shows this (the `from`/`for` glance is `human/agent`); the operator asked to use
that convention "everywhere." This surfaced while fixing a real mis-binding (see the operator record for the
OI-7 Bob follow-up, closed 2026-08-13): a bare name made `ai-claude-bob` sitting under the wrong human
invisible.

## Decision

Presentation only, in `src/admin/queries.ts` + `src/admin/html.ts` (no schema change):

1. **`listParticipations` returns the owning human.** A new `owner_handle` column =
   `COALESCE(ho.username, po.username)` - prefer the **per-project bound human**
   (`participations.human_owner_id`, the canonical "belongs to a human" of decision 038), fall back to the
   **provisioner** (`participants.owner_id`) when an agent is unbound. `ParticipationRow` gains `ownerHandle`.

2. **The access page qualifies each agent as `human/agent`.** `projectAccessPage` renders
   `<span class="owner-prefix">${ownerHandle}/</span>${participantName}` for an agent (the human muted so the
   agent name reads first); a human participant renders bare.

## Non-goals / boundary

Presentation only; no schema, no query semantics change (the participant listing is still owner-scoped to the
project owner, invariant 3 untouched). The account-level Participants page is left as-is - it lists the owner's
OWN agents and already frames them as "addressed `<you>/<label>`" (single-human context). The task board keeps
its `owner_name` snapshot (built from the provisioner at assign time); after the OI-7 data fix the two agree,
and unifying the board's snapshot onto `human_owner_id` is a possible follow-up, not done here. This surface
now reads the CANONICAL bound-human field, so a future mis-binding shows up here immediately.

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` extended: the access page
qualifies an agent with its owning human (muted `human/agent`); a human participant renders bare. Rendered and
screenshotted (Project B access page: `owner/project-b-platform-dev`, `bob/ai-claude-bob`, `owner/project-b-marketing`).

## Reviews

Gatekeeper + code-review, both **CLEAN for merge** (no HIGH/MEDIUM): owner-scoping predicate unchanged (the two
`LEFT JOIN owners` are PK lookups, no fan-out, invariant 3 intact), both interpolations `esc()`'d (invariant 4),
no schema change, verify green with the load-bearing tests unweakened, the COALESCE null-paths and the
agent-vs-human render guard correct.

**Fixed-before-merge:** the docs named the query `listProjectParticipations`; the real function is
`listParticipations` - corrected in the decision file, index, and PLAN. Added a test for the defensive
null-`ownerHandle` bare branch.

**Accepted-no-fix (tracked follow-up):** three OTHER qualified-name surfaces still derive the human from the
**provisioner** (`participants.owner_id`), not the bound human: the `list_participants` MCP tool
(`src/mcp.ts`), `connectionStatus` (`src/admin/queries.ts`), and the domain presence actor; plus the task
board's denormalized `owner_name` snapshot. All are **currently correct** - the OI-7 rebind made
`owner_id == human_owner_id` for every live agent - so this is latent, not a live misattribution. Unifying every
qualified-name derivation on `COALESCE(human_owner_id, owner_id)` (and backfilling the board snapshot) is a
coherent follow-up refactor, tracked in PLAN.md, deliberately NOT sprawled into this access-page decision.
**Accepted-no-fix:** if a bound human owner had no username (unreachable - `resolveOwner` assigns one on the
sole login path), the value-level COALESCE would fall back to the provisioner; practically impossible.

Refines 037, 038.
