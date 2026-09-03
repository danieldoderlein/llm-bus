# 074 - A manual block says what would lift it, and who owns lifting it

**Date:** 2026-08-23
**Status:** Accepted. Refines [073](073-a-blocked-task-says-what-is-blocking-it.md) (which made the block
VISIBLE and left this half open) and [039](039-llm-bus-v2-task-and-message-model.md) (which introduced the
two blocking mechanisms). Uses [061](061-assign-routing-and-the-participant-roster.md)'s `owner:`/`human:`
addressing. Number claimed on the bus (`claim("decisions")` -> 074). Operator ruling on task #980.

## Context

Decision 073 rendered a block's reason and, in doing so, had to print the honest sentence:

> Blocked BY HAND, not by another task. Nothing will lift this automatically - someone has to decide it is
> over and unblock it.

That sentence was the operator's worry made visible, not solved. 073 filed the rest as its own decision
task rather than guessing, and the ruling came back **A and B together**:

> if you mark something a blocker, it needs a clear explanation and when something is blocked, it needs an
> owner, otherwise it points into the dark and will be left alone. Even if the assigned party is not the
> right or final assignee, at least it is assigned and someone needs to process it.

The measured state that made this worth doing: production carried **7 open manual blocks, the oldest 10
days old**. Reading them, every one was legitimate - waiting on hardware, on a decision, on a demo
finishing. The problem was never that they were wrong. It was that nothing would ever bring them back.

## Decision

**`task_block` cannot record an unaccountable block.** It requires:

- `unblock_condition` - what would LIFT it. Written at the moment of blocking, which is the one moment the
  person actually knows the answer.
- an owner of the unblock - `unblock_owner` for an agent, `unblock_human` for a person, resolved through
  the same `resolveAssignee` the assignee field uses. One addressing vocabulary covers assigning and
  unblocking, and naming an agent in the human field gets 061's corrective error rather than a mis-route.

**Required in the HANDLER, not in the tool schema.** An agent whose client cached the pre-074 tool list
still sends the old two-argument call, and a bare schema rejection tells it only that something is invalid.
Each refusal instead names the exact corrective call - decision 040's tombstone lesson, applied to a
tightened contract rather than a removed tool.

**The owner is told.** `whats_new` gains `waiting_on_you`: the blocks whose unblock you own, each with what
would lift it. This is the half that makes naming an owner mean anything - a name recorded on a detail page
that only someone already looking at that task will open is the same dead end 074 exists to close. It is
deliberately NOT folded into `my_open_tasks`: the task is someone else's work, and yours is the one thing
standing in front of it. The field is omitted entirely when nothing waits on you.

**A block on a task that goes TERMINAL leaves the owner's plate.** Nothing resolves a blocker row when
its task ships or is cancelled, and production already carried exactly that shape (llm-bus task 384:
cancelled 2026-08-13, its manual block still open). Without the exclusion, a block whose task is later
cancelled would sit on its owner's plate permanently - an item no amount of doing the work could clear.
Found by checking the live table right after deploying this decision. The row itself is kept: it is the
historical record of why that task stalled, and only the READ excludes it.

**Pre-074 rows show their gaps as gaps.** The 7 existing blocks cannot have an exit condition invented for
them, so both fields stay null and the page says so in as many words ("No exit condition was recorded",
"Nobody owns lifting this"). A blank would render identically to a block with no work to do, which is
precisely the state this decision exists to end.

## Consequences

- A block is now a piece of routed work rather than a note. Someone has it.
- `task_block` is a stricter contract than it was. An agent on a cached tool list gets one directive error
  and can retry immediately; no client is stranded, because a new PARAMETER reaches a stale client fine
  (decision 064's split - it is a new TOOL that a cached client cannot call).
- Four additive nullable columns on `task_blockers` plus two partial indexes. Two indexes, not one
  composite: the owner columns are mutually exclusive (an agent OR a human), so a composite would be half
  nulls on every row and answer neither question well.
- The web board still cannot create a manual block at all - there is no `taskBlockFromOwner`, so MCP is the
  only write path and there is no second surface where an unaccountable block could still be written. That
  asymmetry (a human cannot block from `/admin/tasks`) is pre-existing and untouched here.

**Not done, deliberately.**

- **Option C, a review date that returns the task to the board.** 073's reasoning stands: C is the answer
  IF blocks still rot once they carry an exit condition and an owner. Adding it now would invent a sweep
  that needs its own supervision, before knowing whether A and B alone are enough.
- **An author column.** The task title named "no author" alongside "no release mechanism", and A/B were the
  fixes offered for the second. B is strictly more actionable than an author: who must ACT beats who set
  it. If attribution is wanted later it is one more column, and the block event already records the actor.
- **Back-filling the 7 existing blocks.** Their exit conditions are not knowable from the record.

## Verification

`test/blockers.accountable.test.ts`: each field is required and each refusal names the corrective call and
BOTH namespaces; a refused block writes no partial row; the owner resolves to a real participation, not
just a display string; the block appears on that owner's plate as `waiting_on_you` with its exit condition,
does NOT appear as their own task, does NOT appear on the blocker's own plate, and leaves the plate when
resolved; a non-member named as the unblock owner is refused.

`test/board.panel.test.ts`: the detail carries and renders both fields with labels, and a row written
straight to the table in the pre-074 shape still loads, carries nulls, and renders both gaps by name.

Confirmed to FAIL against each weakening:

| mutation | what failed |
| --- | --- |
| drop the owner requirement | the block was recorded unowned; the "no partial row" check found 1 row |
| render the missing owner as a blank | the pre-074 gap assertion; the page was silent about it |
| drop the terminal-task exclusion from `waiting_on_you` | a cancelled task's block stayed on the owner's plate |
