# 050 - Task board at scale: assignee filter, capped Done with load-more, colon-labelled glance

**Date:** 2026-08-12
**Status:** Accepted (operator-directed, 2026-08-12). Refines
[041](041-task-board-list-and-detail.md) (the board surface) and
[045](045-task-surface-ui-redesign.md)/[046](046-task-surface-ux-pass-2.md) (its glance line and
filter bar). Number claimed on the bus (`claim("decisions")` -> 050). Ships operator tasks 447/448/449.
Refined by [062](062-plate-never-truncated.md) (this decision's terminal-group cap was render-level only,
so the flat query LIMIT underneath it still let the archive starve whole projects of actionable rows; 062
moves the cap into the query and makes "actionable groups are never capped" true rather than intended).
Refined by [055](055-task-board-legibility-design-system.md) (per-state row shading, always-visible
columns, and the human-author from-field) and [058](058-sticky-board-filters.md) (default @me across
all projects, a persisted filter cookie, and the empty-state escape chain).

## Context

Now that agents drive the bus actively (registering future work and completed tasks), the human `/admin/tasks`
board grows fast, and three operator tasks landed together - all the same surface, all about legibility at
scale:
- **447** - the Done list grows without bound; cap it at a reasonable number with a "load more".
- **448** - the glance line reads `from X  lane Y  for Z`; use colon labels (`from: X`) like a mail/message
  header, everywhere the glance appears.
- **449** - the old "show only mine" filter was lost; bring back a way to see only the tasks assigned to a
  chosen participant (dropdown: all / me / each other participant), since the list is now long.

## Decision

Presentation + one new render-level filter, in `src/admin/html.ts` + `src/admin/handlers.ts` (no schema, no
query change):

1. **Colon-labelled glance (448).** One scoped CSS rule - `.glance .k::after { content: ":" }` - colon-labels
   every glance key. Because `.k` is used ONLY inside `.glance`, this covers BOTH the list row and the detail
   page glance ("everywhere") with a single rule, and any future glance key inherits it.

2. **Capped terminal groups with load-more (447).** In `tasksPage`, the terminal groups (Done / Cancelled)
   render only the most recent `TERMINAL_CAP` (8) rows with a "Load more (N more)" link that lifts the cap via
   `?alldone=1` (and a "Show fewer" to collapse). Actionable groups (Todo / In progress / Blocked) are NEVER
   capped - they are the plate. The section header always shows the true total. Render-level (the data is
   already loaded); no server pagination.

3. **Assignee filter (449).** A second select in the filter bar - "Assignee: Everyone / Me / <each other
   participant>" - narrows the board to one assignee. `"@me"` filters on the `OwnerBoardTask.mine` flag (tasks
   assigned to me the human); an exact handle filters on the assignee string. The owner's own handle is folded
   into "Me" so the other entries are the other participants; the picker shows only when there are >=2 buckets
   to choose among. Both selects live in ONE GET form (changing either preserves the other); `?alldone` rides
   as a hidden field. The picker is built from the assignees actually present in the (project-scoped) set.

## Non-goals / boundary

**The assignee filter is a render-level NARROWING of the already membership-scoped board - it only HIDES rows
already visible under the decision-037 predicate (invariant 3), never widens.** No change to
`listTasksForOwnerBoard` or any query; the board data scope is byte-for-byte what it was. The `?assignee`
param is user-controlled but is only string-compared against the loaded rows and URL-encoded into hrefs
(`esc()`'d), never rendered as raw markup; `?alldone` is a boolean. The `esc()` / CSRF / analytics chokepoint
(invariant 4) is untouched (the board is read-only - no forms/CSRF). Terminal-group pagination is presentation
only; a future server-side `LIMIT` for very large ledgers is out of scope (noted, not built).

## Verification

`npm run verify` green (no test-file / tool-count change). `test:analytics-allpages` extended: the colon
`::after` rule is present; the assignee select lists Everyone/Me/others with the owner's handle folded into Me;
filtering by a handle and by `@me` hides non-matching rows; a terminal group caps at 8 with "Load more (N
more)", `?alldone` expands all with "Show fewer", and actionable groups are never capped. (Visual screenshot
self-review was blocked by a wedged local browser daemon - a tooling failure, not a render one; the render
path is unchanged from the prior screenshot-verified board and the layout reuses the existing filter-bar
pattern.)

## Reviews

Three independent reviews. **Security-review: SAFE, no findings** - confirmed `listTasksForOwnerBoard` is
byte-for-byte unchanged (the assignee filter is a render-level `.filter` that only narrows, invariant 3
intact), `?assignee`/`?alldone` never reach HTML unescaped (only string-compared + URL-encoded + `esc()`'d) or
SQL, no oracle, no CSRF. **Code-review: CLEAN** on all six focus areas (cap boundaries at 8/9 correct, the
`@me` fold and `>=2` gate correct, `boardUrl` preserves filters, XSS-safe). **Gatekeeper: verify green, all
seven invariants intact.**

**Fixed-before-merge:**
- MEDIUM (gatekeeper): USING.md documented the sibling `?project=` filter but not the new Assignee filter /
  capped-Done load-more - added them (and reconciled adjacent stale decision-047 response-control copy:
  "Answer & close"/"Hand to agent" -> "Send reply"/"Reassign").
- LOW: switching the Project filter now clears a stale `?assignee` (the project select's onchange resets it) so
  the board never lands empty-with-a-mismatched-picker.
- LOW: anchored the `owner_name` dedup assumption (agent handles carry a `/` and are never `mine`) with a code
  comment, so a future rename that breaks it is caught.
- Test coverage: added the N=8 (no control) / N=9 ("1 more") cap boundaries, the single-assignee gate hides the
  select, and an XSS-shaped `?assignee` renders no raw markup + empties the board (no oracle).

**Accepted-no-fix:** `?alldone` is board-global (expands Done and Cancelled together) - by design; and the
assignee filter matches on the `owner_name` display snapshot, so two participants with an identical display
name would collapse into one option - fully contained within the membership-scoped board, requires an exact
name collision.

Refines 041, 045, 046.
