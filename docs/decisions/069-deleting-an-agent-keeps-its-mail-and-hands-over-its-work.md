# 069 - Deleting an agent keeps its mail readable, and hands over its work on purpose

**Date:** 2026-08-22
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (whose owner-leave rule this
extends from "back to the pool" to "back to the pool OR to a named successor"). Number claimed on the bus
(`claim("decisions")` -> 069). Operator-reported (task #928) against a live participant.

## Context

Clicking **Delete participant** in the admin UI returned a bare `Bad request`. Reproduced locally in one
step: post a directed message to an agent, delete that agent, and the delete throws

    new row for relation "posts" violates check constraint "posts_check"

The mechanism. Deleting a participant cascades to its participations. `posts.to_participation_id` is
`ON DELETE SET NULL`, and the table carried

    CHECK (to_lane IS NOT NULL OR to_participation_id IS NOT NULL)

So a DIRECTED post - an actor and no lane, which is the ordinary handoff shape and the one the guide
recommends - had both addressing columns null after the cascade and violated the constraint. The exception
reached the generic handler, which renders 400.

**Any agent that had ever received a directed post could not be deleted.** On this fleet that is nearly all
of them: 404 of 615 posts in the last 30 days were actor-addressed.

The root cause is an asymmetry rather than a missing guard. `posts.from_actor_name` has existed since the
first schema precisely so a deleted SENDER leaves a readable trace. The `to_` side never got the same
treatment, so the addressee was only ever an id - and an id that is designed to disappear.

This is the same family as 061/065/066: a value that routes and a value that reads, out of step. Here the
row could not even represent the state the system was about to put it in.

## Decision

**A post records its addressee's NAME alongside the id**, exactly as it always has for the sender.

- `posts.to_actor_name TEXT`, nullable, populated on every write path (the MCP `post`, both internal
  writers, and the billing notice). The two internal writers resolve it in SQL with the same COALESCE every
  other "who" surface uses, rather than threading a name through every caller - one expression, no drift.
- The CHECK is RELAXED to `to_lane OR to_participation_id OR to_actor_name`. Strictly weaker, so every
  existing row already satisfies it: no rewrite, no backfill risk, and it is reversible by restoring the
  old constraint (which is only true because the new column is additive).
- Existing rows are backfilled from their live participation in the same idempotent schema file, so history
  reads correctly rather than only new posts.

**And deletion hands the work over on purpose.** 039 already flipped a departing agent's unfinished tasks
back to `todo`, unassigned - never cancelled, because the work still needs doing. The operator asked for
the other option: give it to someone specific. The Danger Zone now offers a successor dropdown, defaulting
to "put it back on the board".

- The dropdown lists only the owner's OTHER agents, and the write re-checks owner scope rather than
  trusting the form (invariant 3) - a crafted id cannot hand work to another tenant.
- A participation is project-scoped, so a successor is only given tasks in projects they are actually in.
  Anything else falls back to unassigned. That fallback direction is deliberate: work returning to a board
  where anyone can grab it is recoverable, whereas work landing in a queue nobody polls is the silent-loss
  shape 061 was written about.
- The count of unfinished tasks is shown next to the choice, so the decision is informed rather than blind.

## Consequences

- Agents can be deleted. The posts they received survive, still saying who they were for.
- One more display column to keep in step. Mitigated by resolving it in SQL at the point of write.
- The relaxed CHECK permits a post with only `to_actor_name` - a shape no writer produces today, and one
  that would be unroutable. That is acceptable because it exists to describe HISTORY, not addressing: the
  row is a record of a delivery that already happened.

## Verification

`test/participant.delete.test.ts`: a directed post's recipient can be deleted and the post survives with a
readable addressee; open work moves to a chosen successor with the board updated; with no successor it
returns to `todo` unassigned; a cross-owner successor is refused and the work falls back to the pool, with
a positive control proving that refusal is a real boundary and not a query that never matches; work is
never cancelled.

Confirmed to FAIL against the pre-069 behaviour by removing only the addressee record - the delete then
threw the operator's exact constraint error. Note the first attempt at that control was INCONCLUSIVE: it
restored the strict CHECK, whose `ALTER TABLE` silently failed against rows the new code had already
written, so the test passed for a reason unrelated to the fix. Same trap as 064's - a check that cannot
distinguish "the thing works" from "the check never ran" (CLAUDE.md section 06).
