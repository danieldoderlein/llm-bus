# 058 - Sticky task-board filters: default @me across all projects, persisted selection, empty-state escape chain

**Date:** 2026-08-14
**Status:** Accepted (operator-directed, bus task #611). Refines
[050](050-task-board-at-scale.md) (the assignee filter and board-at-scale behavior it introduced).
Number claimed on the bus (`claim("decisions")` -> 058). Ships operator task #611.

## Context

The operator's own use of `/admin/tasks` (task #611): "The thing I care about the most is always MY
tasks across ALL projects. And the first thing I will do if any filtering is needed is to pick a
project and then work through that list before I pick another project." Two frustrations behind that:

- The board defaulted to **Everyone / All projects** (decision 050's filter with no params), so the
  operator re-selected **Me** on every visit - the filter state lived only in the URL query string
  and reset to Everyone on any bare navigation (clicking back to `/admin/tasks`, landing after an
  answer auto-advance, opening a fresh tab the next day).
- An empty Todo column under a filter was a dead end: it said "Nothing to do" with no hint of what to
  do next (widen to all projects, or genuinely inbox-zero).

`mine` on the board is `tasks.assignee_owner_id = <the SSO owner>` (`src/admin/queries.ts`), i.e. the
task is assigned to the **bound human**, not to one of their agents. So "MY tasks" (`@me`) is exactly
the human's own plate - the decisions their agents ask them plus work routed to them - which on this
board is deliberately a short, often-empty list. That is precisely why the two supports below are
load-bearing: the escape hatch (Q2) and the empty-state chain (Q5).

## Decision

Presentation + one client-held preference cookie, in `src/admin/html.ts`, `src/admin/handlers.ts`,
and `src/admin/session.ts`. No schema change, no new query, no widening of the membership predicate.

1. **Default view = `@me` across all projects.** When neither the URL nor the stored preference names
   an assignee, the board defaults to `@me` (the operator's own plate) with no project filter. A small
   static hint notes that actionable lists sort oldest-first (longest-waiting on top).

2. **Sticky selection via a persistent nav cookie.** The project + assignee selection is persisted in
   a browser cookie (`__Host-yolo_board` in prod / `yolo_board` in dev), reusing decision 027's `aud`
   client-held nav-cookie pattern: HttpOnly, SameSite=Lax, Path=/, a one-year Max-Age (survives
   deploys and session expiry - "stick as far as possible"), Secure in prod. The cookie is **never**
   identity or authz (invariant 1); it only drives a render-level narrowing of the already
   membership-scoped board (invariant 3). Both fields are validated on read (`asBoardAssignee`,
   `Number.isFinite`) - a forged or garbage value is dropped, never reflected (invariant 4). `alldone`
   (the Load-more cap lift) stays URL-only transient - it is not a filter preference.

3. **URL wins, cookie fills in - per field, keyed on presence.** `resolveBoardFilter` blends the two:
   for each of project and assignee independently, an explicit URL param (present, even if empty) is
   authoritative and is re-persisted; otherwise the stored cookie applies; otherwise the `@me`/all
   default. Keying on parameter **presence** (not truthiness) makes two links work correctly: the "in
   `<project>`" row link (carries only `?project=`) keeps the current assignee lens, and the
   empty-state "View all projects" link (an explicit empty `?project=`) clears the project while
   keeping the assignee. The `@me` default applies only when **no cookie exists**, so an operator who
   deliberately saved **Everyone** ("") still gets Everyone.

4. **The assignee select is the escape hatch.** With `@me` the default, unassigned and agent-assigned
   tasks are hidden; the select back to **Everyone** must therefore always be reachable. It now renders
   whenever a narrowing filter is active (`asg !== ""`), not only with the 050 ">=2 buckets" rule, and
   the current selection is always representable (Me shows even when the owner has no mine-task; a
   concrete-handle filter with no rows on the current board is injected as a selected option).
   Switching project **preserves** the assignee lens (the onchange no longer resets it to Everyone).

5. **Empty-Todo escape chain.** An empty Todo column now guides the next move: under a project filter
   it reads "All clear in this project." with a **View all projects** link (explicit `project=`,
   keeps the assignee); the all-projects `@me` inbox-zero is the celebratory end of the line ("Inbox
   zero across every project ... Go grab a drink ;)"); Everyone-with-nothing keeps the quiet "Nothing
   to do". Non-Todo empty columns are unchanged ("Nothing here").

## Consequences

- The operator lands on their own plate every time without re-filtering, and a completed queue points
  the way forward instead of dead-ending. The URL stays shareable (the cookie is set alongside the
  render, no redirect - the `aud` model).
- The cookie is client-held nav state, so the app process stays stateless (no on-disk write,
  invariant 7 posture intact) and the change is trivially reversible (drop the cookie read, restore
  the default line).
- `resolveBoardFilter` and the `session.ts` cookie helpers are exported and unit-tested
  (`test/board.filter.test.ts`), and the render behavior (escape hatch, empty-state chain, oldest-first
  hint, project-switch-preserves-assignee) is covered in `test/analytics.allpages.test.ts`. Invariant 3
  (membership isolation) stays guarded by `test:membership`/`test:taskwrites`.
