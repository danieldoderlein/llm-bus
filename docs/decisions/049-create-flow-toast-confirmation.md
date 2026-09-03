# 049 - Create-flow confirmation: land on the board with a toast + View link, not the new task's detail page

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, 2026-08-12). Refines
[048](048-task-queue-ergonomics-and-toasts.md) (extends the toast component) and
[041](041-task-board-list-and-detail.md) (changes the post-create navigation it set). Number claimed on the
bus (`claim("decisions")` -> 049).

## Context

After creating a task in the web UI, decision 041 landed the human on the NEW task's own detail page. But the
human just AUTHORED that task and (in the 95%-are-decisions model, decision 046) handed it to an agent or a
teammate - there is nothing for THEM to do on its detail page. The operator hit this creating a task for their
agent and called the landing "worthless": a dead-end detail view with a "Work this task" block for a task they
have no intent to work. What they wanted was a lightweight confirmation with a way back to the task if needed.

The toast component (decision 048) already existed but only fired on the ANSWER flow (`?done`). It could not
carry a link.

## Decision

Presentation + navigation, in `src/admin/html.ts` + `src/admin/handlers.ts` (no schema, no query change):

1. **Land on the board after create.** The `POST .../tasks/new` handler now redirects to
   `/admin/tasks?project=<pid>&created=<taskId>` - the human's plate (the new task also shows in the Todo
   column, membership-scoped as always), keeping the project filter. (Was: the new task's detail page.)

2. **A toast confirms it, with a View link when the creator can see the task.** `createdToast(url)` composes
   the notice server-side from the numeric `?created=<id>` (+ `?project=<id>`) - never reflected free text,
   validated `^\d+$` - as `Created #<id>` carrying an in-app `View` link to `/admin/projects/<pid>/tasks/<id>`.
   The link is **gated on visibility**: the create redirect appends `&view=1` only when
   `loadOwnerBoardTask(owner, pid, taskId)` proves the creator can load the task (invariant 3). A plain member
   who assigns a task away cannot see it, so they get the confirmation WITHOUT a link that would 404 (the board
   they land on never 404s). The board GET resolves `answeredToast(url) ?? createdToast(url)` (answer flow keeps
   precedence; a plain visit shows neither).

3. **The toast component gains an optional link.** `Toast.link = { label, url }`, rendered as
   `<a class="toast-link">` next to the message and `esc()`'d regardless. Defense-in-depth: `renderToast` emits
   the anchor ONLY when the url is an internal same-origin path (`/...`, not `//...` or a scheme), so a future
   caller cannot inject a `javascript:`/absolute href. Hovering OR focusing the toast pauses the CSS
   auto-dismiss (`.toast:hover, .toast:focus-within { animation-play-state: paused }`) so a link inside a
   self-dismissing toast stays reachable for both pointer and keyboard users.

## Non-goals / boundary

No schema, no new query, no state-machine change. Every OTHER task write keeps its decision-041/048 landing
(`afterTaskWriteDest` for status/assign; `afterAnswerDest` auto-advance for answers). The toast link is an
internal path composed from validated numeric ids and `esc()`'d - the `esc()` / CSRF / analytics chokepoint
(invariant 4) is untouched. The View link is a convenience: the task is on the board the human lands on, so
the auto-dismiss never strands them.

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` extended: a toast with a
`link` renders a `View` anchor; a link-less toast renders none; a non-internal link url
(`javascript:`/absolute/protocol-relative) renders NO anchor; and `createdToast` (now exported) is unit-tested
across its branches - `view=1`+numeric project -> link, missing `view` -> no link (the member-assigned-away
case), missing project -> no link, non-numeric/absent `created` -> no toast. Rendered and screenshotted (board
with the `Created #<id> - View` toast, desktop 1320 + mobile 375) before merge.

## Reviews

Gatekeeper CLEAN (verify green, all seven surface invariants intact, no schema/query/state change, docs loop
consistent). Code-review found one MEDIUM + LOWs, no HIGH. **Fixed-before-merge:**
- MEDIUM: the `View` link 404'd for a plain member who created a task and assigned it away (invisible to them
  under the membership predicate). Fixed by gating the link on a `loadOwnerBoardTask` visibility check
  (`&view=1`) at the redirect - restoring the guard the replaced `afterTaskWriteDest` carried.
- LOW: the toast href had no scheme allowlist - added the internal-same-origin-path guard in `renderToast`.
- LOW: pause-on-hover had no keyboard equivalent - added `:focus-within`.
- LOW: the URL-parsing branch was untested - exported `createdToast` and unit-tested its branches.

Refines 048, 041.
