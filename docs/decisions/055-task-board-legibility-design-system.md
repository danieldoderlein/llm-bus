# 055 - Task-board legibility II: a design-system loop, per-state shading, always-visible columns, human-author from-field

**Date:** 2026-08-13
**Status:** Accepted. Refines [026](026-shared-design-token-module.md) (the single design-token module
-> a design-system "loop" convention + a per-state token scale) and
[050](050-task-board-at-scale.md) (the task board surface; board lineage 041 -> 045 -> 046 -> 050).
Records the additive `tasks.created_by_owner_id` column. Number claimed on the bus
(`claim("decisions")` -> 055).

## Context

Two operator tasks on the `/admin/tasks` surface (bus tasks 540, 541):

- **540 (UI color / design system).** The admin UI's colours/spacing are ad-hoc; there is no formal
  "design system" beyond the token module (026) and the public `/brand` page. The concrete ask: when a
  human clears all their tasks, the next status list slides up into the place Todo occupied, and the
  abrupt content shift where the eye expects Todo is confusing. Distinct per-state shading fixes that.
- **541 (task-board list optimization).** (a) A task the operator authors in the web UI arrives with NO
  "from" - it should read "from me". (b) Empty status columns vanish (on filter, or at inbox-zero),
  making the board feel like it magically rearranges; the operator wants the five columns as a fixed,
  always-visible structure.

## Decision

Presentation + one additive column + one write/query change, in `src/brand.ts`, `src/admin/html.ts`,
`src/admin/queries.ts`, `src/admin/task-writes.ts`, `src/http.ts` (`/brand`), `db/schema.sql`:

1. **The design system is a loop (convention, Refines 026).** A visual component lives in the tokens
   (`src/brand.ts`, the single `:root`) + its CSS, and is SHOWN on `/brand`. A new component is added to
   the tokens and rendered on `/brand` in the same commit. This increment adds the first such component
   (task-state shading) and its `/brand` swatch section; the broad admin typography/spacing sweep is a
   deferred Phase 2 (PLAN.md), not bundled (§02 small-refactors-over-rewrites).

2. **Per-state task shading (540).** Five new token pairs `--state-<status>-wash` / `--state-<status>-edge`
   (todo/in_progress/blocked/done/cancelled). A task row (`.taskrow.s-<status>`) and the detail card
   (`.taskcard.s-<status>`) render a faint wash + a left-edge accent (an inset box-shadow, so the edge
   survives hover). Each wash is near-white so body text clears WCAG AA (guarded by `test:brand-tokens`).
   The row's `s-<status>` class mirrors the existing detail `statuspill.s-<status>` family.

3. **Always-visible columns (541b).** The five status columns always render; an empty group shows ONE
   placeholder row (`.taskrow.empty`) instead of being omitted. An empty Todo is inbox-zero and shows a
   small celebration (the operator asked for the emoji; §12's no-emoji rule is "unless the user asks");
   every other empty column is a quiet "Nothing here". The board-empty fallback is retired (the columns
   are now the fixed structure; the intro help still orients a first-run user).

4. **Human-author from-field (541a).** A human authoring via `/admin` is not a participation, so
   `tasks.created_by_id` (a participations FK) was left NULL and the board showed no "from". New additive
   column `tasks.created_by_owner_id BIGINT REFERENCES owners(id) ON DELETE SET NULL` records the
   authoring human; `taskCreateFromOwner` binds `owner.id`; the board `created_by_name` COALESCEs it in as
   a fallback when `created_by_id` is NULL (`SELECT username FROM owners WHERE id = t.created_by_owner_id`).
   Consistent with decision 054's "who-belongs-to-whom must agree" rigor. Legacy human-authored rows keep
   `created_by_owner_id` NULL (no "from" until re-touched - honest, no misattribution).

## Non-goals / boundary

Presentation + one additive column; no new framework/build step/state system (§02); no owner/membership
isolation predicate change (invariant 3 - the `created_by_name` addition is a SELECT projection only, WHERE
byte-identical, exactly as 054 Part A); the FK is `ON DELETE SET NULL` (invariant 6, never cascade); every
new interpolation stays `esc()`'d (invariant 4); the analytics chokepoint (`gaHead()`/`cookieBanner()`) is
untouched; new tokens live ONLY in the single `:root` (`test:brand-tokens`). The broad admin
typography/spacing cleanup (540's "apply it fully, it's messy") is Phase 2, deferred to PLAN.md.

## Verification

`npm run verify` green (schema additive/idempotent - `ADD COLUMN IF NOT EXISTS`; migrate is a no-op on
re-run). Tests: `test:analytics-allpages` (row `s-<status>` class; detail card class; state tokens ride the
token module; all five columns render when empty; the empty-Todo celebration + `@me` variant; the quiet
non-Todo placeholder); `test:brand-tokens` (the five wash/edge tokens exist + body text clears WCAG AA on
each wash, single `:root` intact); `test:taskwrites` (a human-authored task shows the author as "from" via
`created_by_owner_id`).

## Reviews

Gatekeeper on the diff (multi-file, schema + query + presentation, §11). [Filled in at review.]

Refines 026, 050.
