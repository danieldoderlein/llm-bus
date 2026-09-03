# 046 - Task surface UX pass 2: harmonized glance line, happy-path decision answer, explained alternatives

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, from hands-on use of the 045 surface, 2026-08-12). Refines
[045](045-task-surface-ui-redesign.md). Refined by [047](047-task-surface-ux-pass-3.md) (list/detail glance
parity, boxed detail, decision copy, one Reassign), and by [050](050-task-board-at-scale.md) (colon-labelled
glance keys, assignee filter). Number claimed on the bus (`claim("decisions")` -> 046).

## Context

The operator drove the 045 surface for real and found it still made the core job unclear - "I made the tool
and I do not know how to use it." A load-bearing framing came with the feedback: **~95% of the tasks a human
touches on the board are DECISIONS their agents ask them**, so the happy path (answer the decision) must be
dominant and instantly obvious, and every alternative must be present but clearly separated and explained -
"if you cannot act as intended you glance down and find the way out." And the invariant: **when you leave the
view, the task has progressed to someone** - answering is not a dismiss, it SENDS your answer back to the
asking agent (which then closes the task).

Specific defects in 045:
- The row split at-a-glance facts across two places (some under the title, some as badges floating right), the
  `#id` was a mono span at a different size/baseline than the rest ("numbers are higher"), and the row showed
  the assignee rather than **who asked** - the fact a human most needs when a decision lands on their plate.
- The detail page was three stacked lines (status overline, title, meta) instead of the list's shape.
- "Work this task" read as one blurb. "RESPOND" + a "Your response / note" label + a placeholder was triple
  cognitive load for one input. The hand-off control sat ambiguously beside the answer with no explanation of
  whether it was part of answering or a separate action. And **"Answer & close" implied a dismiss** when the
  action actually sends the answer back to the agent.

## Decision

Presentation-only in `src/admin/html.ts`, plus one read-only query addition in `src/admin/queries.ts`:

1. **Harmonized glance line (one shape, both views).** A single `.glance` strip under the title - one font,
   one size, baseline-aligned, middot-separated - carries every at-a-glance fact in ONE place, in the
   operator's order: **id, from (who asked), type, lane** (the list adds project on the "all projects" view +
   a link count; the detail prepends the status pill and appends project + assignee). The list row now shows
   the **requester** (`from owner/project-c-dev-agent`) instead of the assignee. To surface it,
   `listTasksForOwnerBoard` gains the same `created_by_name` subquery the detail loader already used, so the
   requester renders in the SAME `<owner-handle>/<participant>` format everywhere.

2. **Detail is two lines** - title, then the one glance line. The 045 status overline is gone (status leads
   the glance line instead), so the header is never a three-line stack; the list and detail read identically.

3. **"Work this task" is happy-path-first.** The dominant block is **Answer the decision**: the option chips
   (big, primary) with a one-line sub-head naming who the answer goes back to, an optional note that rides
   with the answer, and a quiet ghost escape ("None of these fit? Send a written answer instead") for a
   note-only answer. A plain (non-decision) task shows **Answer this task** with a note and a **Send answer**
   button. The redundant "Your response / note" label is gone - the section heading + placeholder are the
   only two cues. Below a divider, **Other ways to handle it** lists the ~5% escapes as clearly-separated,
   each-explained actions: **Hand to an agent** (delegate - the agent picks it up), **Reassign** (give it to
   someone else, no answer sent), **Change status** (pause / cancel / reopen). Terminal tasks collapse to a
   single Manage row.

4. **"Send answer", not "Answer & close".** The label and sub-heads say the answer is SENT back to the asker
   and the task closes - matching what the code always did (the answer routes to `created_by_id` as a post)
   and killing the "did I just dismiss it?" read.

## Non-goals / boundary

No schema, MCP tool, route, or task-state-machine change. The one query change is a read-only `SELECT`
addition (the requester name); the `/respond` `/status` `/assign` handler contract is untouched (hand-off
still tolerates a null note - it posts a brief only when one is given). The membership predicate (invariant
3), `esc()` / CSRF / analytics chokepoint (invariant 4), and `isHttpUrl` gate are unchanged; every dynamic
value stays `esc()`'d and the one inline `onchange` navigator interpolates only our own project ids.

## Verification

`npm run verify` green (no test-file / tool-count change; `test:doc-counts` unaffected). The
`test:analytics-allpages` task assertions were updated to the new copy (Send answer / Hand to an agent /
Change status / Create a task) and extended for the requester-in-glance and the terminal-only options readout.
Each surface was rendered and screenshotted at 1320 and 375 and reviewed by eye against the operator's points
before merge.

Refines 045.
