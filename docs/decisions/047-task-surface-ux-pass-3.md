# 047 - Task surface UX pass 3: list/detail parity, boxed detail, decision copy, gated written-reply, one Reassign

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, from continued hands-on use of the 046 surface, 2026-08-12). Refines
[046](046-task-surface-ux-pass-2.md). Number claimed on the bus (`claim("decisions")` -> 047).

## Context

The operator kept using the surface and filed a precise punch-list comparing the list and detail views:
- The detail's glance line led with a status **pill**, pushing the info a nudge right vs the list row, so the
  two lines did not read as the same thing; and the assignee ("for daniel") showed on the detail but not the
  list. Type/state and assignee should sit in the SAME place in both.
- The breadcrumb ended with the task **title**, immediately repeated as the `h1` right below it - stating it
  twice for no value.
- The detail was grey-on-grey - "a big blurry canvas" - vs the list's white rows; there was no visual break
  between the title/info, the body, and the controls.
- "Answer the decision" is not English ("you can provide a decision or answer a question").
- The written-reply escape was a quiet link; it should be a proper second-level button that cannot submit
  until there is text.
- In "Other ways to handle it" the controls drifted to the right, away from their labels.
- **"Hand to an agent" and "Reassign" were indistinguishable** - "I made the bus and it is not obvious to me."

## Decision

Presentation-only in `src/admin/html.ts`:

1. **List/detail glance parity.** Both views render the identical glance line - `#id | from <who-asked> |
   <type> | lane | [in <project>] | for <assignee>` - starting at `#id`. The detail's status pill moves OUT
   of the glance line onto the **title line** (a single task is not status-grouped, so the pill has a natural
   home there and no longer offsets the info line). The list row gains **`for <assignee>`** so assignee shows
   in both at the same spot.

2. **Breadcrumb = the task ID.** The last crumb is `#<id>`, not the title (the title is the `h1` directly
   below).

3. **The detail is a white card.** The task sits in a `.taskcard` panel (white, bordered, shadowed) off the
   grey page, with internal dividers separating the header (title + glance) from the body from "Work this
   task" - so what is title/info vs body vs actions reads at a glance.

4. **Decision copy.** "Answer the decision" -> **"Your decision"** (plain tasks: "Your reply"). The sub-head
   is "Pick an option, your reply goes back to `<asker>`, and closes this task." The primary button on a plain
   task is "Send reply".

5. **Gated written-reply button.** The escape is now a second-level button at the end of the options, above
   the box: **"None of the above. Follow the instructions provided below"**, `disabled` until the reply box
   has text (a tiny inline `oninput` handler toggles it; the server still validates the empty case).

6. **Controls under their text.** Each "Other ways to handle it" row stacks - the dropdown + action button sit
   directly under the explanation, not drifting right.

7. **One "Reassign", not two.** "Hand to an agent" and "Reassign" are merged into a single **Reassign** (any
   agent or teammate via `/assign`, defaulting to the agent that asked; they pick it up on their next check).
   The distinction was invisible even to the bus's author, so it is gone. `taskHandoffFromOwner` and the
   `/respond action=handoff` route stay in the backend (dormant, reversible), just unused by the UI.

## Non-goals / boundary

No schema, MCP tool, route, query, or task-state-machine change (the 046 requester query is untouched). The
`esc()` / CSRF / analytics chokepoint (invariant 4), `isHttpUrl`, and the membership predicate (invariant 3)
are unchanged; every dynamic value stays `esc()`'d and the one inline `oninput` handler is static (no data
interpolation). The merged Reassign uses the existing `taskAssignFromOwner` write path.

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` updated to the new copy
(Your decision / None of the above / Send reply / Reassign) + the gated-button `disabled` state + the
list-row `for <assignee>` parity. Rendered and screenshotted at 1320 and 375 and reviewed against the
operator's punch-list before merge.

## Reviews

Gatekeeper PASS + code-review CLEAN (no HIGH/MEDIUM). **Accepted-no-fix (both reviewers, LOW):** the "None of
the above" written-reply button ships `disabled` and is enabled only by the inline JS, so a JS-off user on a
decision task cannot use the written-reply escape - a narrow regression from 046's always-enabled ghost.
Accepted because the operator explicitly required "do not allow this button to submit before there is text",
this is a first-party JS-context admin, the option chips (the ~95% path) still submit without JS, and the
server still validates the empty case (`option=other` requires a note, `task-writes.ts`). Stale comments
(handlers.ts "Answer & close", the `createdByName` interface doc) fixed before merge.

Refines 046.
