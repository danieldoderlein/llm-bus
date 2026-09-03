# 061 - Humans visible in the roster; the assignee snapshot derives from the assignee; silent mis-addressing made loud

**Date:** 2026-08-19
**Status:** Accepted. Refines [037](037-multi-human-project-membership.md),
[054](054-unify-qualified-actor-on-bound-human.md) and
[056](056-bind-ctx-actor-to-bound-human.md) (it closes the `qualifyActor` caller-handle quirk 056
explicitly deferred "to its own decision"). Refined by
[065](065-lane-delivery-reads-both-columns.md) (which moves the lane DELIVERY surface its section 5 rule
points at, and refuses a typo'd lane instead of warning). Continues the identity lineage 018 -> 037 -> 038 -> 052 ->
054 -> 056 -> 057. Number claimed on the bus (`claim("decisions")` -> 061). Ships the cross-rig defect
report filed by `owner/project-a-dev-agent`, 2026-08-19.

## Context

A human teammate on the `project-a` project reported her `/admin/tasks` board was empty. Two tasks were
unambiguously hers - collecting written customer consent, and a design decision the project owner had
handed her in writing. Both existed. Both were assigned. Neither reached her.

`task_assign` exposes two owner fields addressing two different namespaces, one keyword apart:
`owner:` names an AGENT participation (a process, which only sees the task if it polls
`list_tasks(mine=true)`); `human:` names a project MEMBER (a person, whose work reaches them on the web
board, which filters `assignee_owner_id`). Both calls succeed. Both return a result naming an owner.
Nothing warned that people-work had just gone into a queue with no runner. The only detector that
worked was a person saying "my board is empty".

The distinction WAS documented, in `guide()` and in the tool description. This was not primarily a docs
gap - it was an affordance gap, and the model was already right elsewhere: the WEB assign roster
already joins `project_members` (`src/admin/queries.ts`) and the board already filters
`assignee_owner_id`. The agent-facing MCP surface had drifted from a model the web implements.

## The four defects (all verified against the code before fixing)

1. **Humans were invisible in the roster.** `list_participants` queried `participations` only, so it
   could only ever return agents. The only assignable-to-a-person string was undiscoverable, while the
   string that mis-routes was a first-class `name`. The API listed the value that breaks and hid the
   value that works. Root cause of the whole report.

2. **The assignee snapshot was qualified with the CALLER's handle.** `qualifyActor(ctx, label)` returned
   `${ctx.participant.handle}/${label}` - the caller's. Its single call site stamped `tasks.owner_name`,
   so `owner/project-a-dev-agent` assigning to `project-a-alice-agent` (bound to `alice`) wrote
   `owner/project-a-alice-agent`, while `list_participants` said `alice/project-a-alice-agent`. Decision 054
   Part A aligned seven live-derived READ projections; this WRITE path was missed because it composes
   the ASSIGNEE, a different participation from the caller. Measured cost beyond cosmetics: the
   reporting agent found two further tasks in that wrong-looking queue and DECLINED to re-route them,
   because it could not establish from the API whether the queue was live or phantom.

3. **The same bug on the web write path.** `resolveAssigneeTag` (`src/admin/task-writes.ts`) joined the
   PROVISIONER (`participants.owner_id`) with no `human_owner_id` join, feeding three `owner_name`
   writes. Fixing only the MCP path would have left the reported symptom reproducible from
   `/admin/tasks` on the next reassign. Not in the original report; found while verifying it.

4. **The failure was silent.** A mis-routed task read as correctly assigned in `list_tasks`, in the
   events feed, and in every summary built from them.

**One report claim is refuted, recorded so nobody re-chases it:** `human:` DOES validate. It requires a
`project_members` row, matches case-insensitively on username OR email, and throws on a non-member. So
`human:"Alice"` and `human:"alice@example.com"` both resolve; a junk string is rejected. It is not a
second silent mis-route.

## Decision

1. **`list_participants` returns the whole roster**: agents (from `participations`) AND human members
   (from `project_members`), as one `UNION ALL` with an explicit source rank so agents sort first. Each
   row carries **`assign_with`** naming the field that actually routes to it (`owner` / `human`), derived
   from the ROW SOURCE rather than from `kind`, so it cannot lie even for a legacy `kind='human'`
   participation. A human's `name`/`actor` are both the bare handle (a person has no `handle/label`
   structure, and the bare handle is exactly what `human:` accepts), falling back to email so a
   handle-less member stays assignable; humans carry no token. Both branches are pinned to
   `ctx.project.id` (token-derived), so invariant 3 is untouched and no new table becomes reachable.

2. **The assignee snapshot derives from the ASSIGNEE's own bound human.** `findAgent` returns the
   agent's own qualified actor via `COALESCE(COALESCE(ho.username, o.username) || '/' || pt.name,
   pt.name)` - the identical COALESCE `list_participants`, the access page, and
   `scripts/backfill-actor-snapshots.ts` use, so the ASSIGNEE write path and the repair tool converge on
   one canonical string. `qualifyActor` is DELETED (zero callers): its name advertised exactly the wrong
   contract and invited a future caller to reintroduce the bug. `taskStart`'s self-grab still stamps
   `ctx.actor`, which is correct - there the caller really is the assignee. The web path gets the same
   `human_owner_id` join.
   **Precisely scoped claim (gatekeeper F4):** `ctx.actor` itself is composed in `src/auth.ts` as
   `bound_handle ?? <PROJECT owner>.username` (decision 056), whereas this path falls back to the
   PROVISIONER. Those differ only for an agent with `human_owner_id IS NULL` AND
   `participants.owner_id <> projects.owner_id`. Every current creation path (`admin_provision`, `grant`,
   invite-accept, the OAuth AS) sets `human_owner_id` and creates the participant under the project
   owner, so the divergence is unreachable for rows written by today's code - but there are FOUR
   composition points, not one, and a future creation path that breaks either assumption would split them
   again. Unifying them is a separate, larger change; recorded here so the claim is not read as broader
   than it is.

3. **Cross-namespace mistakes are loud and directive.** A miss in one namespace probes the OTHER and
   throws an error naming the exact corrective call ("... is a HUMAN MEMBER of project N, not an agent -
   assign it with `human:"alice"`"), echoing the RESOLVED handle so the suggested call is guaranteed to
   work. Both probes are pinned to `ctx.project.id`, so a name belonging to another tenant matches
   neither and yields the byte-identical GENERIC message: "exists elsewhere" and "does not exist" stay
   indistinguishable (invariant 3, guarded by a new cross-project test). The probe runs only on the
   already-failing path, so the happy path costs nothing.

4. **A dormant agent queue warns, because the probe cannot catch the reported case.** The
   cross-namespace probe in (3) only fires when the name MISSES the agent namespace. In the actual
   incident the agent label RESOLVED - `owner:"project-a-alice-agent"` is a real agent - so the assign
   succeeded and the work still landed in a queue no process reads. Nothing was missing to probe for, so
   liveness carries this signal instead: assigning to an agent never seen on the bus, or silent for 14
   days, returns a `warning` naming the human it is bound to and the corrective `human:"<handle>"` call.
   It reads the agent's `presence` row through a PK join in a lookup already being performed, so it costs
   no extra query, and an active agent never trips it - a signal that fires on every assign would be
   worthless. This is a narrowed form of the report's suggestion 4: at the assign moment, where the
   mistake is made, rather than as a standing background detector.

5. **Same-class sweep, from a review of the surrounding surfaces.** Three more silent mis-addressing
   paths, all fixed the same way - break the silence, never reject legitimate use:
   - `claim()` is an upsert, so a typo'd sequence name silently forked a brand-new namespace and returned
     a confident-looking `1`. Since CLAUDE.md §02 requires decision numbers to come from
     `claim("decisions")`, one typo could fork the numbering a whole fleet shares. The result now carries
     `created`, plus a `warning` naming the project's existing sequences when a new one is created beside
     them. Detected with `(xmax = 0)` in the existing `RETURNING` - a pure projection, so the row lock and
     the gap-free serialization of concurrent claimers (invariant 2) are untouched.
   - `post(to_lane:)` was unvalidated free text, so a typo'd lane reached nobody, forever silently. The
     post is still ACCEPTED (posting ahead of an agent joining a lane is legitimate) but returns a
     `warning` naming the lanes actually in use. **The check reads `presence.lane`, the surface lane
     DELIVERY matches** (`register()` writes it), NOT `participations.lane`, which is set once at
     provision time and never updated. The first cut of this warning read the provisioning column and the
     security review caught it: it would have false-alarmed on every lane post in a project provisioned
     without lanes, and stayed silent in exactly the case it guards - the §06 wrong-surface trap, inside
     the fix for a wrong-surface bug. The same stale framing was corrected on the operator's grant form,
     which told operators the provisioning lane "powers who's active".
   - `post(to_actor:)` resolves AGENTS only, so naming a human member returned a bare "not found" about
     someone who demonstrably IS in the project. It now says what they are and where their work actually
     lands (`task_assign(human:)`, the board, the daily digest).

## Consequences

- The affordance is self-describing end to end: the roster shows both namespaces and which field each
  takes, the guide states the routing rule, and getting it wrong produces the corrective call.
- New, deliberate exposure: any agent in a project can now see its human members' handles (email only in
  the no-username case, unreachable in prod since `resolveOwner` always allocates a username). This is
  the same string `task_assign(human:)` already accepted and the web roster already shows, and it is the
  point of the fix. `list_participants` has no admin gate; that is unchanged and intended.
- No schema change; `db/schema.sql` untouched and `npm run migrate` is a no-op. Rollback is a code
  revert. `tasks.owner_name` stays the preserved display snapshot (invariant 6); only what NEW writes
  stamp changes. Existing divergent rows are repaired by the EXISTING
  `scripts/backfill-actor-snapshots.ts`, whose scope is literally `tasks.owner_name (agent assignees)` -
  a prod data write, so it is ASK-class and parked as OI-14, not run here.
- Tests: roster union + `assign_with` + ordering + email fallback (`test:smoke`); assignee-derived
  qualification + both directive errors + bare-handle human assign (`test:task`); the no-oracle guarantee
  (`test:isolation`); the web assign snapshot (`test:taskwrites`); claim typo signal
  (`test:migration-hardening`); lane warning + human-post directive (`test:post`). No new test file, so
  the `verify` chain and the test-file count are unchanged.
- **Not done, deliberately.** The report's suggestion 4 is IMPLEMENTED in narrowed form (point 4 above:
  at the assign moment, not as a standing background detector); what is NOT built is the fleet-wide sweep
  that surfaces already-mis-routed tasks on the lead's board or in `whats_new` - a one-off audit query
  covers that today. Its suggestion 5 (collapse `owner`/`human` into one `assignee`
  field) is the structural fix that removes the class rather than the instance, but it is a breaking MCP
  input change affecting every connected rig, the kit, and the guide. RECOMMENDATION: do not do it - the
  two-field split is now self-describing plus self-correcting, which buys most of the benefit at zero
  breakage. If the operator still wants it, it needs its own decision and a migration window (the
  decision-040 tombstone pattern).

Refines 037, 054, 056.
