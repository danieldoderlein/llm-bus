# 080 - Granting the project-admin role: the control 078 assumed existed

**Date:** 2026-08-31
**Status:** Accepted. Refines [078](078-membership-means-seeing-the-project.md) - supplies the grant path 078 assumed existed. Number claimed on the bus (`claim("decisions")` -> 080). Operator-ruled: option A on bus task #1377.

## Context

Decision 078 shipped the operator's ruling *"They see tasks only, if admin, everything"*: a plain member
reads every task in a project, and a project ADMIN also reads the project's own pages. It was built,
reviewed, deployed and verified on production rows.

**It could never have fired.** There is no code path in the product that writes
`project_members.role = 'admin'`. Exactly two writes to that table exist: `createProject` inserts the
creator as `'owner'`, and `acceptInvite` inserts `'member'`. Production bears it out - 16 owner rows, 3
member rows, zero admin rows.

I noticed the empty state while building 078 and wrote it down as *"serves nobody today, which is why it
was safe to remove rather than rush"*. That read an empty table as a fact about adoption when it was a
fact about the schema. The tests passed because they insert the row by hand, so nothing anywhere
exercised the path a real admin would have to travel to exist. **A capability gated on a state the system
cannot produce, with a green suite over it.** Same family as everything else this week: the check and the
thing it checks were never connected.

Surfaced by the project-b rig, which was asked to make Bob an admin, found no way to do it, and correctly
refused to reach for `admin_provision` - that tool mints a token and re-tokens the participant, which is
the instrument for agents. A human seat has no token at all; it is an SSO identity.

## Decision

**A People section on the project Access page**, with a promote/demote control per member. The page listed
agents and pending invites and never showed people at all, which is why there was nowhere for this to
live: you cannot promote someone who is not on the screen.

**Owner-only, deliberately narrower than the read it unlocks.** A project ADMIN cannot mint more admins.
Promotion decides who else can see an entire project, so it runs through `loadOwnedProject` like every
other mutation rather than through 078's wider `projectReadClause`. Without this the grant would be
self-propagating.

**No bus tool** (the operator chose option A). Handing "decide who can see this project" to an agent, in
the same week an agent answered seven decisions addressed to a human, is the wrong order. A tool stays
available the moment there is a real need; **OI-40** should close first. **[RETIRED 2026-09-01 - ruling 2026-09-01-3 closed OI-40 as INTENDED behaviour ("a coordination rig, not a dictatorship"), so this is no longer a live gate; kept as the reasoning at the time.]**

**The owner row is untouchable in SQL, not merely hidden in the UI.** `AND m.role <> 'owner'` is in the
statement. Demoting it would leave a project whose owner cannot administer it, with no path back, and a
UI-only guard is one crafted POST away from that.

Refusals return false with the row untouched and no oracle: a project you do not own is indistinguishable
from one that does not exist (invariant 3).

## Consequences

- 078's admin half becomes reachable for the first time. Its behaviour is unchanged; only its
  precondition is now constructible.
- **The test asserts rendered HTML, not the loader.** That is the specific lesson from OI-37, where 078's
  first admin attempt passed a loader test and would have rendered blank pages. Every case here goes
  through the real mutation; none inserts a role row directly, which is what let 078's suite pass over a
  feature that could not exist.
- Mutation-controlled: neutering the owner-only gate fails three assertions, and allowing the owner row to
  be demoted fails two.
- **A control that appeared to work and did not, worth recording.** The first two attempts at the
  owner-only mutation edited a *different function* - that exact SQL predicate appears three times in
  `queries.ts` and a naive `replace(..., 1)` hit the first. The suite stayed green and the control looked
  like a passing negative. It only resolved by asserting the occurrence count before mutating. A mutation
  control that silently targets the wrong code is indistinguishable from a guard that works.
- Applied immediately: `bob@example.com` promoted to admin in `project-b` through this control (operator's
  instruction, task #1356), rather than by a direct database write.
