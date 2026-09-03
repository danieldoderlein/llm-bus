# 078 - Membership means seeing the project

**Date:** 2026-08-30
**Status:** Accepted, refined by [080](080-granting-the-project-admin-role.md) - which supplies the grant path this decision assumed existed; its admin half could not fire until then. Amends [037](037-multi-human-project-membership.md)'s membership scoping and the
membership half of [039](039-v2-tasks-decisions-as-tasks.md). Number claimed on the bus
(`claim("decisions")` -> 078). Operator-raised and operator-ruled (ruling 2026-08-30-3, bus task #1323).

## Context

Raised by the operator against a much smaller question I had put to him. I had filed OI-35: a block naming
a plain member emails that person "you are blocking this" and deep-links to a task their board will not open,
so the link 404s. I offered three ways to patch it. His reply went past the patch to the premise:

> If somebody is invited into a project, why would they not see all tasks in that project? I would assumed a
> project member can see everything but only edit their own tasks. Hence, seeing a task they are reffered to
> should not be a problem. However, if someone needs Bob to do something, they should give him a task. I
> fail to see the problem. But the access concept needs to change. Why would you grant someone access to a
> project and hide the project from them?

He is right, and what shipped in 037/039 is **incoherent rather than deliberate**. Today a plain `member`
can already:

- resolve and open the project (`queries.ts` project gate, `pm.role IN ('admin','member')`),
- read its roster of agents and people (`listProjectMembersForAssign`, same gate),
- **CREATE tasks in it** (`task-writes.ts` create gate, same gate),

while the two READ predicates - the board list and the task detail - filtered to
`pm.role = 'member' AND t.assignee_owner_id = <them>`. **A member could add a task to a board they were not
allowed to read.** The write side and the read side had been built to different rules and nobody had put
them side by side.

## Decision

**A member READS the project; they still only WRITE their own.**

- The two read predicates become `pm.role IN ('admin', 'member')`. A member sees every task in the project
  and can open any task's detail.
- **No write path moves at all.** `task-writes.ts` still admits a member only to tasks assigned to them, and
  the board's `mine` flag still marks which rows are actually theirs. Seeing is not owning.
- **"They see tasks only, if admin, everything"** (his words). A `project_members` row with role `admin`
  also READS the project's own pages - overview, access, settings.

### The admin half, and the mistake it took two passes to get right

The route gate was the easy part and it was not the whole thing. First pass added a separate
`loadProjectForAdminRead` for the three GETs - correct as far as it went, and deliberately NOT a widening of
`loadOwnedProject`, which gates this project's **mutations** as well as its pages (granting an agent,
revoking a participation, writing settings). Widening that in place would have handed a project admin the
power to **mint and revoke credentials** as a side effect of a ruling about visibility - the exact read/write
coupling [077](077-a-token-is-its-agent-not-its-human.md) was about, one day earlier.

But `/security-review` caught that gating the ROUTE is not enough: every loader BEHIND those pages was
independently scoped `pr.owner_id = $2`. A project admin would have reached the overview, Access and settings
pages and seen **blank ones** - failing closed, so never a leak, but a worse answer than the honest 404 they
had before. The tests missed it because they asserted the LOADER returned a row and never that the PAGE had
anything on it: a check that would look identical if the feature were broken.

So the access rule is now defined **once**, as `projectReadClause()` beside `reachClause()`, and used by all
six read sites: the route loader, `listParticipations`, `listInvites`, `loadProjectActivity`, and **both**
queries inside `loadProjectBoard` - the second of which was nearly missed, because widening one half of a
two-query page renders half a page. Four copies of an access rule is four chances for a page and its data to
disagree about who may see it.

Every mutation stays on `loadOwnedProject`. Reading is not administering.

## Consequences

- **The problem in OI-35 is deleted, not carved around.** Once a member can open any task in the project, the
  daily brief's deep link resolves and the dead-link case does not exist. The operator's second point stands
  on its own and is recorded as ruling 2026-08-30-3: **if you need a person to act, give them a task.** A
  block naming a human is an agent reporting that it is stuck; it is not a way to assign work.
- **Blast radius: ~~one person~~ THREE memberships across two people. CORRECTED 2026-08-31, and the
  original number here was wrong.** What this file said, and what the operator was told before he ruled:
  "one person, `bob@example.com` - the only non-owner membership on prod. Alice holds agents but has no
  `project_members` row at all, so none of this reaches her." **False.** `alice@example.com` has held
  `member` rows on BOTH `project-a` and `project-c` since 2026-08-09, three weeks before this decision. They were
  there the whole time.
  - **What the change actually did, measured on prod:** Bob goes 2 tasks to 122 in `project-b`. Alice goes
    **6 tasks to 447** across `project-a` (191) and `project-c` (256). The operator ruled on a stated impact roughly
    seventy times smaller than the real one.
  - **The behaviour is still exactly what he ruled** - "if somebody is invited into a project, why would
    they not see all tasks in that project" - and Alice is a legitimate member he added himself, so
    nothing here is undone by the correction. What is wrong is the record, and a ruling given on a wrong
    number deserves to be re-offered rather than quietly relied on. Filed as **OI-38**.
  - **How it happened, since the mechanism is the reusable part:** the "no `project_members` row" claim was
    itself issued as a CORRECTION to an earlier mistake, and being framed as the careful second look is
    what stopped it from being checked a third time. A confident correction is not evidence; the row list
    is. Nobody re-ran the one query between stating it and shipping on it.
  - Nobody holds `role = 'admin'` today, so that half serves no one yet and is built to the ruling rather
    than to a caller. That part was checked and stands.
- **Billing and project settings WRITES stay owner-only**, unchanged, behind `loadOwnedProject`.
- **Two tests were reversed, and the reversal IS the decision.** `membership.isolation` and
  `admin.taskwrites` asserted "member M sees ONLY the task assigned to M". Those assertions were rewritten to
  the new contract with the isolation half untouched: a NON-member still sees nothing and is refused with the
  same null as a bad id, and a member still cannot write to a task that is not theirs. A test bent to fit a
  new feature stops meaning anything; a test rewritten because the operator changed the contract is the
  record of that change.

## Verification

| Claim | How it is held |
| --- | --- |
| a member reads every task in the project, list and detail alike | `membership.isolation`; **mutation-controlled** - restoring the old predicate fails 4 assertions |
| the two surfaces cannot disagree | list and detail assertions are paired on the same rows, so one lying about visibility fails |
| seeing is not owning | `mine` is asserted true only on M's own row; every write assertion is unchanged and still green |
| a non-member still sees nothing, with no existence oracle | `membership.isolation`, unchanged |
| a plain member does NOT reach the project's own pages | `membership.isolation`; **mutation-controlled** - admitting `member` to `projectReadClause` fails 2 assertions |
| a project admin's pages have CONTENT, not just permission | each asserted equal to the OWNER's view and non-empty: participations, board tasks, board decisions, activity events. Every loader independently mutation-controlled - reverting any one to `pr.owner_id` fails its own assertion |
| the two-query Board page cannot be half-widened | tasks AND decisions asserted separately; reverting only the decisions query fails on its own |
| the decision-record assertion can actually fail | a claim event is seeded so it is not comparing 0 to 0 |
| a project admin still cannot mutate | promoted in-test: `loadProjectForAdminRead` returns, `loadOwnedProject` still returns null |
| the Access page hands over token STATUS, never a token value | asserted on the returned row shape |
