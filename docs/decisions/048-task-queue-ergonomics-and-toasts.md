# 048 - Task queue ergonomics: oldest-first sort, auto-advance after answering, uniform toasts

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, 2026-08-12). Refines
[041](041-task-board-list-and-detail.md) (the board + detail surface it extends). Refined by
[049](049-create-flow-toast-confirmation.md) (the toast component gains an optional in-app link; the create
flow lands on the board with a confirmation toast). Number claimed on the bus (`claim("decisions")` -> 048).
Refined by [062](062-plate-never-truncated.md) (the within-column FIFO sort this set is preserved, but the
QUERY feeding it no longer lets the archive crowd actionable rows out of the page it sorts).

## Context

Two ergonomics questions from the operator, plus a shared-component request:
- **Sort order.** The board had no intentional sort (`ORDER BY t.id DESC` = newest-first within each status
  group). For a work queue, that buries the longest-waiting task at the bottom. The operator's instinct:
  oldest-first, so nothing rots.
- **Where to go after finishing a task.** Answering landed you back on the just-answered task's own detail
  page - a dead-end that only shows "answer sent". The operator's instinct: advance to the next task in line.
- **A uniform toast** for status messages, centered at the top (mobile-first), sliding in and auto-dismissing
  after a beat - unless it is an error, which should stay until dismissed.

## Decision

Presentation + navigation, in `src/admin/html.ts` + `src/admin/handlers.ts` + one read-only query:

1. **Oldest-first sort (FIFO) for actionable groups.** In `tasksPage`, the Todo / In progress / Blocked
   groups sort oldest-first (the longest-waiting task on top); Done / Cancelled stay newest-first (a
   recent-completions archive). Sorted in the render by `taskId` (monotonic with creation), so no query or
   schema change.

2. **Auto-advance after answering.** After a human ANSWERS a task (the `respond` verb, not the dormant
   hand-off), the handler redirects to the NEXT task in their queue for that project - the oldest open
   (effective `todo`) task assigned to them, via the new read-only `nextOwnerTaskInProject` - or the board if
   the queue is empty. This is the inbox-zero rhythm: answer one, land on the next. Every OTHER task write
   keeps the decision-041 behavior (land back on the task, or the board if no longer visible).

3. **Uniform toast.** A `Toast` type + `renderToast` render a status notice fixed at the top-center
   (mobile-first). Info/success **auto-dismisses via a pure CSS animation** (slide in, hold, slide out +
   `visibility:hidden` - no JS, respects `prefers-reduced-motion`); an **error is sticky with a dismiss X**
   (one inline `onclick`). `layout()` gains an optional `toast` param that `tasksPage`/`taskDetailPage`
   forward. The post-answer confirmation is delivered by a server-composed `?done=<id>` code on the redirect
   (a fixed template rendered from the numeric id, never reflected free text, `esc()`'d) - so the destination
   shows "Answered #<id> - next up" (or "... you're all caught up" on the board).

## Non-goals / boundary

No schema change. `nextOwnerTaskInProject` is a read-only, parameterized `SELECT` keyed on
`assignee_owner_id = owner` (assigned-to-them means already visible under the membership predicate, invariant
3; the detail loader re-proves on render regardless). The `esc()` / CSRF / analytics chokepoint (invariant 4)
is untouched; the toast message is composed server-side and `esc()`'d. The toast component is shared infra -
other one-off confirmations (e.g. "message sent") can migrate onto it later.

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` extended for the toast
(info auto-dismiss vs sticky error) and the FIFO/terminal sort ordering; `test:membership` extended for
`nextOwnerTaskInProject` (oldest-first, exclude-id, empty-queue null). Rendered and screenshotted (board with
toast + sorted groups; sticky error toast) before merge.

## Reviews

Gatekeeper CLEAN + code-review CLEAN (no HIGH/MEDIUM). Both confirmed `nextOwnerTaskInProject`'s visibility is
a strict SUBSET of the membership predicate (invariant 3) and read-only/parameterized (invariant 7), the
redirect gating correct (only a non-handoff `respond` auto-advances; `status`/`assign`/hand-off keep the 041
behavior), the toast injection-safe (esc()'d, `?done` validated `^\d+$`, static inline X), and the sort
non-mutating. **Fixed-before-merge:** the queue-empty toast copy ("you're all caught up in this project" ->
"nothing else waiting for you here"), since the auto-advance only counts `todo` (a human may still have
in_progress/blocked tasks). **Accepted-no-fix:** the handler-layer redirect gating rests on inspection, not a
unit test - consistent with the repo (the admin handler layer has no unit tests; the query, toast, and sort
ARE tested); and `?done` persisting in the URL re-shows the info toast on a manual reload (presentation-only,
esc()'d + digit-only).

Refines 041.
