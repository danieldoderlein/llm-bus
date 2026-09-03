# 045 - Task surface UI redesign: professional hierarchy, design-system spacing, mobile-first controls

**Date:** 2026-08-12
**Status:** Accepted (operator-directed "solid UI session", 2026-08-12; independent design critic + rendered-
screenshot review). Refines [041](041-task-board-list-and-detail.md) and
[042](042-human-task-response-and-lifecycle-controls.md) (presentation-only - their data model, write layer, and
routes are unchanged; only the rendering changes). Refined by
[046](046-task-surface-ux-pass-2.md) (the UX pass 2 from hands-on use - harmonized glance line, happy-path
decision answer, explained alternatives), and by [050](050-task-board-at-scale.md) (board at scale: the glance
line gains colon labels, the filter bar gains an assignee filter). Number claimed on the bus
(`claim("decisions")` -> 045).

## Context

Field feedback (the Project B project agent, with board screenshots) called the shipped v2 `/admin/tasks`
visuals unworkable, and the operator asked for a deliberate UI session: use a critic on layout, information
structure, and action-button placement; make it look professional with spacing per the design system; then
apply the same to the responsive version, because **most users drive their bus tasks on a phone**.

An independent design critic plus a rendered-and-screenshotted review (desktop 1280, mobile 375, across
board / detail-decision / detail-plain / detail-done / create / filtered) found two P0 failures and systemic
drift. The create form (`newTaskPage`) was already correct - one filled primary + one ghost secondary - and
became the model the rest of the surface was pulled toward.

**P0 - the mobile board was broken.** `.taskrow` was a rigid horizontal flex with no `@media` rule, so on a
375px phone the title ellipsized to nothing ("Migra..."), the `#id`/project meta collided with the side
badges, and the assignee pill overflowed the card. Unusable exactly where the surface is used most.

**P0 - the detail "Work this task" block was an ungrouped wall.** For a decision task the option chips (the
actual answer), "Hand to agent", the status dropdown, and "Assign" were all identical `.btn.sm` ghosts - no
primary action, no separation between Respond / Status / Assign, and every target under the 44px touch
minimum.

**Systemic drift.** Half-pixel fonts (12.5 / 13.5 / 14.5px, soft on non-retina), off-scale gaps (26 / 14 /
20 / 18px) ignoring the `--s*` 4px scale, and inline `style="..."` attributes the mobile media query could
not reach - the "eyeball-tuned, not systematic" tell.

## Decision

A presentation-only pass over `src/admin/html.ts` (the `STYLE` constant + `tasksPage` / `taskDetailPage` /
`taskCardControls`), consuming the shared tokens (`src/brand.ts`), no new CSS system:

1. **Board.** The whole row is the tap target (a stretched link over the title, matching the pre-existing
   hover cue), so a thumb never has to hit one line of text. The assignee drops from a heavy bordered mono
   pill to muted meta text showing just the agent/lane **leaf** (the repeated `owner/` owner prefix is
   stripped), so the title wins the row and the amber `decision` badge is what pops. The project link is
   suppressed when the board is already filtered to one project. On a phone the row **stacks** (title wraps
   in full; meta, badges, and assignee flow onto their own lines) so nothing is crushed. The button-wall
   chrome (one "New task in X" button per project + a separate filter form + a big intro box) becomes a
   single `.taskbar`: one New-task control (a primary button for a single project, a select-navigate for
   several) on the left, the project filter on the right; the intro help is hidden on mobile.

2. **Detail.** Status becomes an **overline** (mono chip + `#id`) above the title, so it stops floating in
   the vertical middle of a wrapping title; reading order is status -> title -> meta. "Work this task"
   splits into three labelled sub-sections - **Respond**, **Status**, **Assign to** - where the answer is the
   **filled primary** (the decision option chips, or "Answer & close" on a plain task) and everything else
   (Hand to agent, Update status, Assign) is a quiet ghost; "Other answer" is set apart as a ghost link so it
   is never fat-fingered as a real option. The `done` status pill recedes to a muted grey (it was a solid
   black chip that shouted louder than an in-progress task). Decision options render read-only **only** once
   the task is terminal (while live the chips carry them - no more showing them twice).

3. **System.** Every task value snaps to the 4px token scale, the half-pixel fonts become integers, and the
   load-bearing inline styles are promoted to classes so the mobile block can reach them. On a phone the
   working controls are 44px targets with 16px inputs (which also stops iOS Safari's zoom-on-focus) and stack
   one-action-per-row full-width.

## Non-goals / boundary

No schema, MCP tool, data-model, or route change. The membership predicate (invariant 3), the `esc()` / CSRF
/ analytics chokepoint (invariant 4), and the `isHttpUrl` link gate are untouched; every dynamic value stays
`esc()`'d and the one inline `onchange` navigator interpolates only our own project ids, never user input.
This is the capability-surface counterpart to 041/042: the model did not change, its presentation did.

## Verification

`npm run verify` green (no test-file/tool-count change, so `test:doc-counts` unaffected;
`test:analytics-allpages` still renders every task page through the chokepoint). Each surface was rendered and
screenshotted at 1280 and 375 and reviewed by eye against the critic's prioritized findings before merge.

Refines 041/042.
