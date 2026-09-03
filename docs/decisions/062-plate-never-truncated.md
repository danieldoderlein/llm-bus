# 062 - Two budgets, not one: the plate is never truncated, and a cap that bites says so

**Date:** 2026-08-19
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (the board this read
serves), [048](048-task-queue-ergonomics-and-toasts.md) (which set the within-column sort this
preserves) and [050](050-task-board-at-scale.md) (whose render-level terminal cap this finally makes
true at the query). Refined by [064](064-task-list-is-an-index.md) (this decision fixed WHICH rows a list
returns; 064 fixes HOW MUCH each row costs - bodies are previewed, and `task_ids` is the precise read).
Number claimed on the bus (`claim("decisions")` -> 062).

## Context

The operator reported that a task filed for him was "not on the bus for me", and suspected work was
being lost across projects. The filing agent had done everything right: task 829 was `todo`, carried
`assignee_owner_id = 1`, and sat correctly on the human namespace that [061](061-assignee-routing-humans-visible.md)
had just hardened. Nothing was mis-addressed and nothing was mis-stored.

It was unreadable. `listTasksForOwnerBoard` ran `ORDER BY pr.id, t.id DESC LIMIT 300` over EVERY status.
Two properties combined into data loss:

- **No status filter.** Terminal rows are the fast-growing majority (447 of 494 fleet-wide), so the
  archive consumed the budget that open work needed.
- **Ordered by project id.** The oldest projects ate the budget first, so the newest projects starved
  ENTIRELY rather than partially - the failure was not "some rows missing", it was "this project does
  not exist".

Measured on prod before the fix (2026-08-19):

    494 visible rows, 300 rendered -> 194 never reached the renderer, 47 of them OPEN
    six entire projects invisible: owner-workspace, project-a, llm-bus, kvad-studio, minter, ai-coding-genesis
    task 829 sat at row 327

The same class was live on two more surfaces, both found by asking "what else answers *what is on me?*":

    list_tasks()        LIMIT 50, ORDER BY id DESC, no status filter. Agents ship constantly, so done
                        rows pile on top and open work ages off the bottom of the DEFAULT documented
                        call: 10 open tasks hidden in project-c, 10 in project-b, 1 in project-a.
    whats_new           my_open_tasks LIMIT 20, no total. One agent (project-c-dev-agent) sat at exactly 20,
                        one task from silently losing work on the channel agents are told to trust
                        INSTEAD of polling.

Two things this was NOT, both checked rather than assumed. No task is assigned to a human who cannot
see its project (0 rows). No task sits in an agent queue nothing polls (0 rows) - the phantom-queue
sweep 061 left open came back clean. The ledger was correct throughout; only the reads were lying.

## Decision

**Actionable work is returned in full. Only the archive is bounded. A cap that bites reports itself.**

The board query splits into two budgets in one statement: a `scoped` CTE applies the unchanged
decision-037 membership predicate, then a `ranked` CTE numbers rows WITHIN a terminal column
(`PARTITION BY status ORDER BY id DESC`) and assigns 0 to everything actionable. Filtering `trank <=
cap` therefore passes every actionable row through whatever the cap is - the plate cannot be truncated
by construction, not merely by a limit chosen to be big enough. `count(*) OVER (PARTITION BY status)`
rides along as `groupTotal`, giving each column its true pre-cap depth for free (window functions are
evaluated before `LIMIT`).

`list_tasks` sorts `(status IN ('done','cancelled')) ASC` before `id DESC`, so a page limit can only
ever cut archive, and probes one row past the limit to report `truncated` exactly rather than leaving a
caller to guess whether a full page means "that is all" or "there is more". `whats_new` reports
`my_open_tasks_truncated` with the true total.

The ordering that caused this was never a display order: `tasksPage` re-sorts every column itself
(decision 048). It was only ever deciding what to throw away, by a rule unrelated to importance.

## Consequences

- No data migration. Nothing was lost, so nothing needs repair - the 47 open tasks and six projects
  reappear on the next page load. This is the rare defect where measuring first saved the work.
- The board's Done/Cancelled headers now state true depth rather than however many rows loaded. Under
  an assignee lens the pre-cap total does not describe the narrowed set, so the loaded count stays -
  the header never states a number it cannot stand behind.
- `?alldone=1` now lifts the FETCH cap as well as the render cap; previously "Load more" could expand
  into rows that were never loaded.
- Cost: the board read is now unbounded in its actionable half. That is the right shape - a plate is
  bounded by how much work exists, not by a page size - and 91 rows fleet-wide is not a page-weight
  problem. If it ever becomes one, the answer is paging the ARCHIVE further, never the plate.
- `test/board.truncation.test.ts` pins all three surfaces against an archive 7x deeper than the retired
  limit, with archive rows both older and newer than the open work. Confirmed to FAIL against the old
  query shape before being accepted - a truncation test that passes both ways guards nothing.

## Same-class flaw, found by dogfooding: you are not unread mail to yourself

Reading my own inbox after posting the handoff for this decision returned ten unread posts, six of them
mine. A lane post fans out to everyone in the lane INCLUDING its author, and neither `unreadCount` nor
`unread_only` excluded the sender - so an agent's own handoff sat in its inbox permanently, rode every
tool response as `_unread_posts: N`, and produced a counter that could not be cleared by doing the thing
it asked for. Same family as the rest of this decision: a surface stating a number that is not true.

Fixed with `p.from_participation_id IS DISTINCT FROM $2` on both. The interesting part is what the test
suite then caught: `smoke.mcp` FAILED, because its unread fixture was the caller's own post - the test
had quietly pinned the buggy semantics as correct. The fixture now posts from a second participation,
which is what the push channel exists for; the assertion is unchanged. A test that encodes the bug is
worse than no test, and the only reason this one was visible is that it broke when the bug was fixed.

## The lesson worth carrying

A `LIMIT` with no ordering discipline is a silent data-loss bug wearing the costume of a safety
guardrail. It was added to keep a page cheap and it ended up deciding, by project creation order, which
of the operator's projects existed. Two rules follow, and they are cheap to apply anywhere:

**Never let the archive share a budget with the plate.** Terminal rows grow without bound and actionable
rows do not; one budget across both means the part that grows always wins.

**A truncating read must say it truncated.** Every surface here failed silently, which is why the
detector was a human saying "it is not there" rather than any test, alert, or number on a page.

This is the same wrong-surface discipline as CLAUDE.md §06, applied to a read path: the surface that
would have shown the problem was the rendered board's row count against the ledger's, and nobody was
comparing them.
