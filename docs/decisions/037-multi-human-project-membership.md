# 037 - Multi-human project membership + human-addressable reviews

**Date:** 2026-08-09
**Status:** Accepted (operator cleared the architect checkpoint 2026-08-09). Refined by
[038](038-targeted-invite-only-enrollment.md) (closes two enforcement gaps: `admin_provision` binds the
agent to its human, and request-to-join is retired so enrollment is targeted-invite-only). Refined by
[039](039-llm-bus-v2-task-and-message-model.md) (the membership-scoped review board becomes the
membership-scoped TASK board - the decision-037 predicate survives, the surface changes). Amended by
[078](078-membership-means-seeing-the-project.md) (that predicate hid every task but a member's own while
this decision already let a member open the project, read its roster and CREATE tasks in it - so a member
could add a task to a board they could not read; the READ side now shows the project, the write side is
unchanged). Refined by
[052](052-show-owning-human-on-participant-surfaces.md) (the agent-to-human binding is surfaced as
`human/agent` on the project access page). Refined by
[061](061-assignee-routing-humans-visible.md) (human members become visible and addressable over MCP:
`list_participants` returns them with `assign_with`, and a mis-routed assign says so). Refines
[004](004-owner-participant-model-and-web-admin.md) (the single-owner model). Builds on the review loop
(033/034). Number claimed on the bus (`claim("decisions")` -> 037). Refined by [068](068-invite-never-rebinds-a-seat.md) (an invite could re-bind an existing
agent's seat, moving its bound human and therefore its actor).

## Decision

A project gains multiple first-class HUMAN members, so a review or task can be addressed to a specific
human (not only an agent), and each human sees a cross-project board of reviews awaiting THEM across every
project they belong to. This refines 004: `projects.owner_id` (one human) becomes owner + invited
co-humans, all first-class members.

**The identity model (ratifying + extending what exists):**
- **Human = a member** (an SSO `owners` row, email identity). The owner is a member with role `owner`;
  invited humans are members with role `member`. Humans act on the web Board, never via MCP (no token).
- **Agent = a participation** (token-bound, invariant 1). **Every agent belongs to a human**
  (`human_owner_id`), always. There is no human-less agent.
- **An invite is always for a human + their agent(s).** The invitee accepts by authenticating via SSO,
  which creates their membership; only then do they obtain the agent token, stamped `human_owner_id = them`.
  The OAuth authorization-server path (024) already works exactly this way and becomes the canonical shape;
  the raw `redeemInvite(code, name)` path that created an agent with no human is removed (or hard-gated to an
  authenticated human). Implementation must verify the live onboarding happy-path first and keep the
  human-first OAuth/self-serve flow primary, not break a working signup.
- **Anyone can ask anyone.** A `review()` targets any human member OR any agent in the project. Alice's
  agent can ask the operator (human) or the operator's agent; and the reverse. The awaited party is resolved
  server-side within the token-derived project (invariant 1); naming a target grants the caller no identity.

**Two mechanics resolved at the checkpoint:**
1. **Human vs agent addressing:** a dedicated `review(reviewer_human=<handle|email>)` param, distinct from
   the existing agent-targeting `reviewer`. A bare name could match both an agent label and a human handle;
   a dedicated param makes the target type explicit and collision-free. Exactly one of
   `{reviewer, reviewer_human}` may be supplied (else throw); omitting both preserves the 033 default (the
   caller's own human).
2. **`project_members` deletion:** `ON DELETE CASCADE` on both FKs. Membership is access-control state, not
   ledger, so invariant 6 (ledger preservation) does not apply; removing a human cleanly drops their
   memberships.

**The isolation reshape (invariant 3: owner isolation -> membership isolation) - the load-bearing part.**
For an SSO-authenticated human H, on the review surfaces ONLY:
- A project H owns (or is an `admin` member of): H sees EVERY open review (supervisor) - unchanged.
- A project H is a plain `member` of: H sees ONLY reviews awaiting H (`awaiting_owner_id = H`) - not other
  members' reviews, not agent-awaited reviews, not the owner's.
- A project H is not a member of: nothing.
- **Every non-review surface stays strictly owner-scoped** (Board, participants, settings, activity,
  join-requests, the digest's blocked/unacked buckets). A plain member's ONLY new surface is `/admin/review`.
- Id-routes re-prove membership and 404 on mismatch, no 403 oracle - the write re-prove (`answerReview`,
  `FOR UPDATE OF tr`) returns zero rows -> null -> 404 with no state change, exactly as owner isolation does
  today. Membership isolation is guarded by a new `membership.isolation` test mirroring `admin.isolation`.

**CLAUDE.md invariant 3 is refined by this decision** (owner -> membership isolation, with the exact
guarantee above). That is a constitution edit made as part of this decision, surfaced to the operator, not
slipped in.

## Context

Field reality (2026-08-09): the operator drives several projects with two collaborators (Alice, Bob).
Today a collaborator's agent joins via a raw invite code and lands under the project owner with NO human
behind it, so "nobody can assign to Alice the human" - she was never created as an addressable identity.
And the operator himself is three `owners` rows (daniel@example.com, daniel@project-b.ai, daniel@example.com),
which fragments the cross-project plate that 034 promises (it keys on one `owner_id`). Both are the same
root cause: the human was never first-class. Alice's canonical human is alice@example.com (she has SSO'd).

## Alternatives considered

- **Agent-as-proxy (model B):** don't model non-owner humans; "assign to Alice" means "assign to Alice's
  agent," which relays to her. Rejected: a collaborator never gets their own review queue, and the operator's
  explicit goal is to assign to and see reviews for the human.
- **Overload `reviewer` to resolve humans:** rejected - an agent labelled `alice` and a human handle
  `alice` collide, making the awaited party depend on lookup order.
- **Keep the human-less raw-join path:** rejected by the operator - every agent must belong to a human, so an
  invite is a human+agent unit; the human authenticates first.
- **Broaden all project surfaces to members:** rejected as unnecessary blast radius; a member's only new
  surface is the review board.

## Consequences

- Additive schema: a new `project_members` table with an idempotent backfill from `projects.owner_id` and
  existing `participations.human_owner_id`. Reversible (`DROP TABLE`). No destructive change to ship the code.
- `review()` gains `reviewer_human`; no new MCP tool (tool count stays 30).
- The review board queries move from `pr.owner_id`-scoped to the three-branch membership predicate; every
  other admin query stays owner-scoped. This is the highest-risk surface and carries a dedicated isolation
  test.
- The onboarding/invite copy and guide change (invite = human + agent); capability-surface sweep required.
- **Owner-gated prod migration (Stage F, the operator runs it):** consolidate the three `daniel@*` owners
  into daniel@example.com and backfill Alice's code-only agent to alice@example.com. Since nobody is paying,
  the Stripe/balance reconciliation step is dropped - it is a clean **remap-then-delete**: repoint every
  owner reference (projects, participants, participations.human_owner_id, task_reviews.awaiting/answered,
  join_requests, invites.accepted_by, owner_identities, credit_ledger, project_members) from each duplicate
  onto the canonical owner, then delete the empty duplicate row. NOT a cascade-delete (that would take the
  projects down). Guarded by a mandatory `--dry-run` -> `--commit` with a `pg_dump` first; runs with the
  operator's prod access. The collaborator-notification email is operator-executed (external send is
  owner-gated). Verify each duplicate account is empty of anything worth keeping before dropping it.

## Follow-ups

- A member spawning agents under their OWN `human_owner_id` in a project they do not own needs a
  member-scoped provisioning surface; scoped OUT of this pass, flagged for a later decision.
- An `admin`-role member (supervisor over a project they do not own) is carried in the schema
  (`role IN ('owner','admin','member')`) but no promote UI ships this pass.
- **Stage G (2026-08-09, operator-authorized at the joint deploy): both deferred items IMPLEMENTED.**
  (1) The open-code `/join` path is RETIRED - `create_invite` now requires a target email and mints a
  TARGETED invite (createOrgInvite) returning the `/admin/accept` SSO link; `POST /join` returns 410; the
  admin open-invite UI is retired in favour of the email-invite form. Every collaborator now SSO-accepts,
  binding their agent to their own identity. (2) The digest EMAIL now reaches pure members: `buildOwnerDigest`
  returns a reviews-only digest for a human who owns no project, so a member (e.g. Alice) is emailed the
  reviews awaiting them. The `/admin/review` board remains the primary member surface; the email is the nag.
- An `admin`-role promote UI (a member supervising a project they do not own) is still deferred; the schema
  carries the role but nothing writes it yet.
