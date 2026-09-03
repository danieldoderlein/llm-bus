# 041 - Task board redesign: scannable status-grouped list + task detail page, links as first-class items

**Date:** 2026-08-11
**Status:** Accepted. Refines [039](039-llm-bus-v2-task-and-message-model.md) (the human `/admin/tasks`
control surface from 039 keeps its membership-scoped data model and write layer unchanged; only its
PRESENTATION changes - the crammed five-column board becomes a scannable list plus a task detail/working
page). Refined by [042](042-human-task-response-and-lifecycle-controls.md) (the detail page gains the prose
Respond/Hand-off controls, an explicit Status dropdown, and task `#id`s), then by
[045](045-task-surface-ui-redesign.md) (the professional/design-system/mobile-first restyle), and by
[048](048-task-queue-ergonomics-and-toasts.md) (queue ergonomics: oldest-first FIFO sort, auto-advance after
answering, uniform toasts), by [049](049-create-flow-toast-confirmation.md) (post-create navigation:
land on the board with a confirmation toast + View link, not the new task's detail page), and by
[050](050-task-board-at-scale.md) (board at scale: assignee filter, capped Done with load-more, colon-labelled
glance), and by [051](051-image-task-links-inline-thumbnails.md) (image task-links preview inline as
thumbnails). Number claimed on the bus (`claim("decisions")` -> 041).
Refined by [073](073-a-blocked-task-says-what-is-blocking-it.md) (the detail page renders the blocker reason
and links a dependency's target task, instead of a bare count).

## Context

The v2 `/admin/tasks` board (039) rendered five fixed columns (todo/in_progress/blocked/done/cancelled) by
reusing the `.actcard`/`.actlist` classes built for the tiny 3-box activity panel. Each column was
`flex:1; min-width:190px`, so on a ~1080px page every column was ~200px wide - and into that ~200px strip
the board dumped the FULL task detail (long operator rulings), a decision-answer textarea, an assignee
dropdown, and the lifecycle buttons. A consuming rig's operator reported it plainly: long text in a narrow
column wraps into an unscannable vertical ribbon; the forms and buttons crammed alongside are not usable.
The data model was fine; the presentation was wrong - the working controls belonged on a surface with room,
not inline on every card. The same report noted that artifact links read best as DISCRETE listed items on a
task (the v2 model already stores `links[]`), not mixed into body text.

Best-in-class task tools (Linear, Height, GitHub Projects, Todoist, Asana) resolve exactly this by
separating the two jobs: a dense, scannable INDEX (a list grouped by status, one line per item - title +
a little metadata) for "what is where", and a DETAIL surface (a page or panel) with room for the full body
and the controls for "work this one". A board of full-detail cards conflates them.

## Decision

Split the two jobs; the data model, membership predicate, and write layer are untouched.

1. **`/admin/tasks` becomes a scannable, status-GROUPED LIST.** Each of the five effective statuses that has
   tasks renders as a section (label + count); empty statuses are omitted. Each task is ONE row: the title
   (a link to its detail page, ellipsized so a long title never wraps into a ribbon), an at-a-glance meta
   line (project + lane), the assignee pill, and a couple of badges (`decision` when it carries options,
   `N links`, `blocked` with the manual-blocker count). No body text, no inline forms - the board is for
   scanning and navigation. It is read-only, so it needs neither a roster nor CSRF.
2. **A new task DETAIL / working page** at `GET /admin/projects/:id/tasks/:rid` (loader
   `loadOwnerBoardTask`): full title + status pill + meta, the complete detail body (`white-space: pre-wrap`),
   the decision options, artifact LINKS rendered as a DISCRETE listed set (`<ul class="linklist">`, each an
   `isHttpUrl`-gated anchor), and every control (start/ship/answer/assign/cancel/reopen) - the existing
   `taskCardControls`, now with room. Every control POST redirects back to this page, so the human stays on
   the task and sees the new state (incl. terminal + Reopen). Creating a task also lands here.
3. **Links are first-class on authoring too.** The New-task form gains a `Links` textarea (`label | url` per
   line, parsed by `parseLinksField` -> the existing `normalizeLinks` -> `tasks.links`), so a human attaches
   links as discrete items, matching how they render.

## Isolation (invariant 3, unchanged predicate)

`loadOwnerBoardTask` carries the SAME decision-037 membership predicate as `listTasksForOwnerBoard`: a
project owner/admin loads any task in the project; a plain member only a task assigned to them; everyone
else, a foreign/missing/non-finite id -> null, and the handler 404s exactly like a bad id (no 403 oracle).
The detail GET route is placed AFTER `/projects/:id/tasks/new` in the handler so "new" is matched there
first (`matchTwoIds` would read `rid=NaN` for it; the loader also rejects a non-finite id). CSRF on every
control POST; every value `esc()`'d; links behind `isHttpUrl` (invariant 4). The new page routes through
`layout()` (analytics chokepoint + `esc()` + HEAD-as-GET), guarded by `test:analytics-allpages`.

## Consequences

- Presentation-only for the human surface: no schema change, no MCP change, no change to what an agent sees
  on the bus. `tasksPage` loses its `rosters`/`csrf` params (the board no longer posts); the detail page
  carries the roster for the assignee dropdown.
- One new admin GET route and one new read query; no new tool, no count change.

## Reversibility

Pure presentation; revertible by restoring the previous `tasksPage`. No data or contract migration.

## Testing

`test/membership.isolation.test.ts` extended: `loadOwnerBoardTask` honours the membership predicate (owner
loads any, member only their assigned task, non-member/foreign/missing/non-finite -> null) and a task's
links round-trip as discrete items on the loader. `test/analytics.allpages.test.ts` renders the new
`taskDetailPage` through the chokepoint and updates `tasksPage` to the new signature. Full `npm run verify`
green.
