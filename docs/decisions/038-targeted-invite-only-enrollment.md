# 038 - Targeted-invite-only enrollment + every provisioned agent binds to a human

**Date:** 2026-08-09
**Status:** Accepted. Refined by [052](052-show-owning-human-on-participant-surfaces.md) (the per-project
bound human `human_owner_id` this decision made canonical is surfaced as `human/agent` on the access page)
and [057](057-retire-human-participant-fiction.md) (an emailed invite no longer carries a person/agent
`kind`; the seat is always an agent and human-ness is the `project_members` row). Refines
[037](037-multi-human-project-membership.md) (closes two gaps its own
principles left in code). Reverses the open-enrollment (request-to-join) part of
[020](020-request-to-join.md). Number claimed on the bus (`claim("decisions")` -> 038).

## Context

Decision 037 set two principles: enrollment is a **targeted invite to a specific human** (SSO-accepted,
their agent binds to their own identity, they become a project member), and **every agent belongs to a
human** (`participations.human_owner_id`, no human-less agent). A post-037 coherence audit found two live
paths that still contradicted those principles, plus stale copy:

1. **`admin_provision` minted a human-less agent.** The MCP tool (and, by mirror, the guide that
   recommended it) inserted a participation with no `human_owner_id`. That is the exact orphan-agent 037
   set out to abolish - an agent nobody can address a review to.
2. **Request-to-join (020) still ran as OPEN enrollment.** A public `/p/:handle/:slug` page let anyone
   ask in, and approval/auto-grant minted a driver participation but **never a `project_members` row**.
   So a request-to-join collaborator was a second-class human: bound as a driver, but not a member -
   invisible on the membership-scoped review board and un-addressable via `reviewer_human`. Open
   enrollment also directly contradicts 037's "targeted invite to a specific human."

The operator's standing direction for the new model is **targeted invites only** (require collaborators
to SSO on a per-address invite). Request-to-join is the last open-enrollment surface; it goes.

## Decision

1. **`admin_provision` binds the provisioned agent to its human** = the provisioning project owner
   (`human_owner_id = ctx.project.ownerId`), `COALESCE`d on conflict so an already-bound agent is never
   un-bound. Its description and the admin coordination guide now frame it as "mint one of YOUR OWN
   agents (bound to you)"; a HUMAN teammate comes via `create_invite` (SSO, bound to themselves). The web
   "+ Grant access" path already bound to the owner - unchanged.

2. **Request-to-join is retired.** Enrollment is `create_invite` -> `/admin/accept` (SSO) exclusively:
   - The public request pages `/p/:handle/:slug` and `.../request` return **410** with a pointer to the
     email-invite path (mirroring the already-retired `POST /join`).
   - The admin request UI is removed: the Access-page "share this - anyone who opens it can ask to join"
     card + request-mode toggle, the dashboard "Your access requests" panel, and the review-plate
     "Requests to join" card. The `join_requests`/`request_mode` bucket is dropped from the shared
     `ownerNeedsYou` (so the digest and the plate no longer surface it).
   - `src/join-request.ts` and its two test files are deleted.
   - The `join_requests` table and `projects.request_mode` column are **retained (dormant)** - additive,
     reversible schema only (there is a prod DB); no live path reads or writes them.

## Boundary / non-goals

- **No schema migration.** Both retired tables/columns stay; only code paths are removed.
- The legacy `join_codes` create/list/revoke (`invite.ts`) stays for the Access page's revoke-only
  "Legacy invite codes" list; `redeemInvite`/`buildInvitePrompt`/`buildJoinFiles` remain **prod-dead,
  test-only** (the `POST /join` flow they describe is retired) - tracked for deletion in PLAN.md, not
  removed here to keep this diff scoped.
- Invariants 1/2/3/4/5/6/7 unchanged. This does not touch money, deploys, or credentials.

## Consequence

One enrollment story on every surface: an owner/admin invites a teammate by email; they SSO-accept, become
a member, and their agent binds to them; agents route reviews to other agents (`reviewer`) or to human
members (`reviewer_human`). This makes the two real collaboration scenarios coherent end-to-end -
the operator + Alice on project-a and project-c (two humans, two projects, each other's agents can request review from
either human), and the operator + Bob on Project B.
