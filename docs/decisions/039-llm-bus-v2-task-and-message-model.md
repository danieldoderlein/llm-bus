# 039 - LLM Bus v2: unified task + message model, human task control surface

**Date:** 2026-08-11
**Status:** Accepted. Reverses [033](033-human-in-the-loop-review-surface.md) and
[034](034-unified-review-board.md) (the review surface is retired - a decision/signoff is now an ordinary
task carrying options). Refines [037](037-multi-human-project-membership.md) (the membership-scoped review
board becomes the membership-scoped TASK board; the predicate survives, the surface changes). Amended by
[078](078-membership-means-seeing-the-project.md) (the predicate that survived here hid every task but a
member's own, while the same membership already permitted creating tasks in that project; the read side now
shows the whole board). Refined by
[040](040-v2-migration-hardening.md) (the flush-and-announce migration is hardened against the cold-reconnect
failure modes a consuming rig hit: authoritative `latest_claims`, seed guard, retirement tombstones, guide
banner) and [041](041-task-board-list-and-detail.md) (the human `/admin/tasks` board becomes a scannable
status-grouped list plus a task detail/working page; artifact links first-class - presentation only, same
data model) and [042](042-human-task-response-and-lifecycle-controls.md) (restores the human "ask me" round
trip the harmonization dropped: a prose response on every task, delivered back to the asking agent, plus a
Hand-to-agent action, an explicit Status control, and task `#id`s) and
[074](074-a-manual-block-says-what-would-lift-it.md) (of the two blocking mechanisms introduced here, the
manual one now has to carry an exit condition and an owner of the unblock). Number claimed on the bus
(`claim("decisions")` -> 039). Architect spec:
[docs/specs/llm-bus-v2.md](../specs/llm-bus-v2.md) (operator-approved Stage-1 artifact). Refined by
[064](064-task-list-is-an-index.md) (list_tasks becomes an index: bodies previewed, `task_ids` reads them in
full, open-only by default) and
[062](062-plate-never-truncated.md) (the Board's promise that it shows the plate is enforced at the query:
actionable rows are returned in full and only the terminal archive is bounded, after a flat row limit was
measured hiding 47 open tasks and six entire projects). Refined by [069](069-deleting-an-agent-keeps-its-mail-and-hands-over-its-work.md)
(owner-leave gains a named successor, and a post keeps its addressee's name so the delete can happen at
all).
Refined by [073](073-a-blocked-task-says-what-is-blocking-it.md) (a blocked task now shows WHICH of its two
blocking mechanisms applies, and names the blocker rather than counting them).

## Context

By decision 038 the coordination model had grown a 7-state task machine
(`open, assigned, in_progress, blocked, review_requested, review_answered, done`), a separate `review`
concept with its own tools (`review`/`answer_review`), its own table (`task_reviews`), its own web board
(`/admin/review`), and a separate `ack` verb for messages. The operator's read (2026-08-10): too many
concepts for what is, underneath, one thing - a graph of work with an assignee and a status, plus messages
that are either read or not. A review is just a task that needs an answer; an "assigned" status is just an
assignee field; "review_answered" is just a message. The bus has always been a **shadow ledger** (every
project treats git as the durable record), so a clean break is cheaper than carrying the accreted surface.

## Decision

Collapse to one task graph and a two-state message, and give the human a first-class web surface to drive it.

1. **Five-state task machine, `blocked` DERIVED.** Persisted base status is `{todo, in_progress, done,
   cancelled}`. `blocked` is never stored - a task is effectively blocked when its base status is
   todo/in_progress AND it has an unmet dependency edge (a `task_deps` target not yet `done`) OR an open
   manual `task_blockers` row. One shared SQL expression (`IS_BLOCKED_SQL`/`EFFECTIVE_STATUS_SQL` in
   `src/domain/task.ts`) derives it everywhere (list_tasks, the board, whats_new, the digest, the start
   guard), so they cannot disagree.

2. **Assignee is an editable, polymorphic FIELD, not a status.** A task is assigned to an AGENT
   (`owner_participation_id`) OR a HUMAN member (`assignee_owner_id` -> `owners`), or is unassigned (both
   null - the grabbable backlog). "Exactly one of the two" is an APP-CODE rule, never a CHECK: an XOR CHECK
   re-evaluated by `ON DELETE SET NULL` would block a ledger-preserving delete (invariant 6). Reassigning an
   in-flight task is a hand-off (reverts to `todo` under the new assignee). `owner_name` stays the display
   snapshot (survives the assignee's deletion).

3. **Dependencies are first-class edges.** `task_deps(task_id, depends_on_task_id, ...)` (both FKs CASCADE -
   an edge is coordination state scoped to its tasks). Resolution is DERIVED (target `status='done'`), never
   a stored flag, so auto-return is correct by construction: completing a dependency unblocks its waiters.
   Self-deps and cycles are rejected (a recursive-reachability guard).

4. **Options + answer REPLACE the review.** A "decide this" task carries `options` (JSONB). Completing it is
   `task_answer(task_id, option?, note?)`: it records `selected_option`/`answer_note` +
   `answered_by_participation_id`/`answered_by_owner_id`, moves the task to `done`, and DELIVERS the decision
   to the assignee of every dependent task (which also unblocks them). This folds decisions 033/034 entirely:
   the `review`/`answer_review` tools, the `task_reviews` machinery, the `/admin/review` board, and the
   `review_requested`/`review_answered`/`open`/`assigned` statuses are all retired. `task_reviews` is
   **retained DORMANT** (kept, additive/reversible - precedent 038).

5. **Messages are two-state: unread -> read; `ack` is retired.** Reading a post addressed to you (via
   `read_posts`) writes a `post_reads` receipt - reading IS the acknowledgment. The `ack` tool and domain
   `ack()` are removed; `post_acks` goes dormant. `unread_only` narrows to still-unread mail;
   `whats_new.unread_posts` + the `_unread_posts` nudge + the owner digest's "needs you" bucket all key on
   unread (was unacked). A per-owner `post_reads_owner` table backs future human-web read-state.

6. **Multi-artifact links.** Tasks and posts carry `links JSONB` (`[{label,url}]`, capped). Rendered ONLY
   through `esc()` + the `isHttpUrl` scheme guard (invariant 4); a non-http(s) url renders as escaped text.
   "Attach a link, not a blob" - the bus stores urls + labels, never the artifact.

7. **A human task control surface on `/admin`.** `/admin/tasks` is the cross-project, membership-scoped board
   where a human creates/assigns/edits/answers/cancels/reopens tasks, declares dependencies, and sends
   messages - so a human can drive a headless agent through the bus alone. Owner-authored writes live in
   `src/admin/task-writes.ts` (a human holds no token, so this is the owner-keyed twin of `postFromOwner`,
   NOT Ctx-keyed `domain/`). `/admin/review` 302-redirects here; the per-project Board becomes read-only
   (5 effective columns, blocked derived).

8. **Migration is flush-and-announce (owner-gated), NOT a data migration.** The schema landed additive +
   reversible (the status/event CHECKs widened to a SUPERSET of old + new; every new table/column is
   `IF NOT EXISTS`), so prod keeps running on legacy rows until the operator flushes. The **flush + deploy +
   rebuild broadcast** is a single owner-gated ASK-class step (real prod data + live deploy): a
   `--dry-run`->`pg_dump`->`--commit` script flushes `tasks/task_reviews/task_blockers/task_deps/post_reads*/
   posts/post_acks/events/presence/actor_cursors/leases` and PRESERVES `owners/projects/participants/
   participations/project_members/tokens/invites/sequences/billing`; a launch announcement tells every agent
   to rebuild its task list. Tracked as operator open-item OI-8; the build stops at verify-green.

## Invariants held

1 (identity from token/SSO): naming an assignee/dependency/reviewer is INPUT and grants no identity - the
assignee dropdown tag (`agent:<pid>`/`human:<ownerId>`) is re-proven in-project before any write; the writer
is always the SSO owner. 2 (atomic gap-free claim): untouched. 3 (owner/membership isolation): the highest
risk here - every task-write and the `/admin/tasks` read re-prove the decision-037 membership predicate in
the SAME SQL (owner/admin -> any task; plain member -> only tasks assigned to them; zero rows -> null -> the
handler 404s, no 403 oracle); guarded by `admin.taskwrites` (new, the load-bearing test) + the rewritten
`membership.isolation`. 4 (esc/analytics/CSRF/HEAD): every new page via `layout()`, CSRF on every POST, links
behind `isHttpUrl`. 5 (fail-open): untouched. 6 (ledger-preserving deletes): no cascade on any actor/owner
link; cancel/reopen are soft; `task_reviews`/`post_acks` retained dormant, not dropped. 7 (hashed tokens /
parameterized SQL): no token handling added; all SQL parameterized.

## Constitution edit (operator-surfaced)

CLAUDE.md still describes the retired review flow in several places, and every one is an operator-gated edit
(surfaced here rather than slipped into a code commit, per the decision-037 precedent; the code carries the
new model regardless). Full scope of the deferred edit:
- **§02 invariant 3** names the review board as the membership-scoped surface (`membership.isolation`); it
  becomes the membership-scoped **task board** (the guard test keeps the name `membership.isolation`,
  rewritten onto the task board, so no test-name reference breaks).
- **§13** (the coordination protocol) describes the review loop, `review()`, `answer_review`, and `ack`
  (e.g. the "review loop" paragraph, the ack "closes the loop" rule): reword to the v2 model - a decision is
  a task with options answered by `task_answer`; reading a post marks it read (no ack).
- **§15** ("an agent never answers a review addressed to the human") - the ASK-class boundary is now "an
  agent never answers a task/decision assigned to the human"; reword.
- **§04.7** capability-surface sweep references the review board as an example surface; refresh.
Until the operator applies these, the constitution instructs agents toward retired tools - a known, gated
gap, not a silent one.

## Consequences

- MCP surface: 34 -> 33 tools (`ack` retired; `review`/`answer_review` were already gone; `task_edit/answer/
  depend/undepend/cancel/reopen` added earlier in the v2 line). `ack` stays in the `query_events` enum +
  `EventType` (dormant history).
- Testing: `review.statemachine` deleted (its subject retired; `task.statemachine` covers options/answer);
  `admin.taskwrites` added; `membership.isolation` rewritten onto the task board; 47 test files.
- What we accept: a plain member can act only on tasks assigned to THEM (not on tasks assigned to agents they
  own) - the safe under-grant; broadening is a future decision. A human-assigned task whose member is later
  removed is not auto-unassigned (no member-removal UI in v2) - a follow-up.

## Staging (built, verify-green on `feature/llm-bus-v2`)

A (5-state model + deps + options/answer + MCP surface), B (multi-links on posts), C1 (owner write layer +
isolation test), C2 (the `/admin/tasks` surface + board read), C3 (message read-state + ack retirement), C4/C5
(review-feature retirement), C6 (capability-copy sweep), D (this decision + architecture/README/USING +
announcement). Each sub-step reached a green `npm run verify`.
