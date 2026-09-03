# 073 - A blocked task says WHAT is blocking it

**Date:** 2026-08-23
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (which introduced the derived
`blocked` status and both blocking mechanisms) and [041](041-task-board-list-and-detail.md) (the detail
page this fixes). Refined by
[074](074-a-manual-block-says-what-would-lift-it.md) (the "Not done" half below - a manual block now has to
say what would lift it and name who owns lifting it). Number claimed on the bus
(`claim("decisions")` -> 073). Operator-reported (task #968).

## Context

The operator, looking at a task on the web board:

> It is not clear to me (human) what is blocking it. Presumably a block exists in relation to something
> else (otherwise its just manually blocked without any release mechanism and could stay blocked forever),
> how do we bind this and visually show it to a human (link to that witch is blocking? even if that is
> someone else's job).

The page rendered exactly one thing about a blocked task:

    Blocked - 2 manual blocker(s) - resolve the dependency/blocker before it can start.

A count. The reader's only question is WHICH, and the count is the one fact that cannot answer it.

**The reason text was there the whole time.** `task_blockers.reason` is written on every manual block and
the reasons in production are long and genuinely useful - who paused it, why, what has to happen first,
which PR is already merged. None of it was ever rendered.

**And there are TWO blocking mechanisms, in two different tables**, which is the part that made the display
actively misleading:

| written by | table | carries |
| --- | --- | --- |
| `task_block(reason)` | `task_blockers` | a reason, no target |
| `task_depend(depends_on)` | `task_deps` | a target, no reason |

`task_blockers.blocked_on_task_id` exists but nothing writes it - `task_depend` uses `task_deps` instead -
so it is vestigial, and production confirms it: **7 open manual blockers, every one with a null target.**
The detail query counted `task_blockers` only. A task blocked by a DEPENDENCY therefore had a count of
zero and rendered the fallback branch, "Blocked on a dependency", with no way to learn which one.
Production has **89 dependency edges, 15 of them currently unmet**, so 15 live tasks were in exactly that
state.

## Decision

**The blocked note shows the blockers themselves, from BOTH sources.**

- A DEPENDENCY names and LINKS its target task, with that task's status, and says it clears on its own when
  the target finishes.
- A MANUAL block shows its reason text in full, and says plainly that nothing will lift it automatically -
  someone has to decide it is over. That sentence is the operator's own worry made visible rather than
  argued about: a manual block with no release mechanism can sit blocked forever, and the page should not
  hide which kind it is looking at.
- Both are read in ONE query as a UNION of the two tables, so the surface cannot show one kind and silently
  drop the other again.

`blockerRows` is detail-loader-only, like `createdByPid` already was: the list board still renders a count,
because a board row has no space for a paragraph and the count is fine as a signal once the detail can
answer the question.

## Consequences

- 15 live dependency-blocked tasks stop being dead ends for the human reading them.
- The detail query does slightly more work: one aggregate over two small indexed tables, on a single-row
  page load.
- `task_blockers.blocked_on_task_id` is now formally dead. It is left in place (dropping a column is not
  additive) and the union does not read it, since `task_deps` is the real edge table.

**Not done - the operator's deeper question.** "Just manually blocked without any release mechanism" is a
real gap that rendering does not close: a manual block records a reason but no AUTHOR (`task_blockers` has
no created_by column, so "PAUSED by Bob" survives only as prose inside the reason) and no review date, and
nothing ever revisits it. Making blocks accountable - a required "what would lift this", an owner of the
unblock, or an expiry that returns the task to the board - is a product decision with several reasonable
shapes, so it is filed as its own decision task rather than guessed at here.

## Verification

`test/board.panel.test.ts`: a manual block's detail carries the row with its reason text and a null target,
and the rendered page shows the reason AND says the block will not lift itself; a dependency's detail
carries the target's id, title and status, and the rendered page LINKS to that task by URL and names it.

Confirmed to fail against both halves:

| mutation | what failed |
| --- | --- |
| drop the `task_deps` branch (the original bug) | 4 assertions; dependency rows come back `[]` |
| render a bare label instead of the reason | 3 assertions; no reason, no "by hand" warning, no link |

The first control reproduces the shipped behaviour exactly, which is what makes it a control rather than a
smoke test: before this change the query really did return `[]` for every dependency-blocked task.
