# 023 - Admin information architecture: two-level account + project navigation

**Date:** 2026-07-09
**Status:** Accepted (the operator approved the proposal + mockup). Implements
[docs/design/admin-ia-proposal.md](../design/admin-ia-proposal.md). Builds on decision
[022](022-two-door-hosted-structure-board.md) (the read-only Board is the project front page).

## Context

The web admin had no navigation model. Every account concern was stacked on one `/admin` page
(`dashboardPage`) and every project concern on one `/admin/projects/:id` page (`projectPage`) - four
unrelated jobs per scroll, with several permanent "what this is" intro boxes rendered on every visit.
the operator: "we threw everything into the dashboard ... we need navigation ... make it delightful for
humans." An independent UX review confirmed the crowding and produced the proposal this decision records.

## Decision

Introduce a two-level navigation model over the existing server-rendered admin. No new framework,
router, build system, or SPA - server-rendered pages through the single `layout()` + `esc()` chokepoint,
plain nav links, `<details>`/CSS for disclosure. This decision authorizes the route/nav reorganization
and nothing beyond it (architecture otherwise stays locked, decision 005 / CLAUDE.md §02).

1. **Account-level nav** (in `layout()`, owner-gated): **Projects** (`GET /admin`), **Participants**
   (`GET /admin/participants`), **Billing** (`GET /admin/billing`), **Settings** (`GET /admin/settings`).
   `dashboardPage` splits into one page per item. The nav renders only for a signed-in owner (never on
   public `/p/*` or the login page).

2. **Project-level tabs** (an in-body tab strip on `/admin/projects/:id`): **Board**
   (`GET /admin/projects/:id`, default - the Activity mirror + Tasks-by-status + Decisions, decision 022),
   **Access** (`GET /admin/projects/:id/access` - members, invites, requests-to-join), **Settings**
   (`GET /admin/projects/:id/settings`, replaces `/edit` - rename/slug, request-mode, danger-zone delete,
   and a placeholder for the future decision-022 hosted-structure toggle). `projectPage` splits accordingly.

3. **Old paths keep working:** `GET /admin/handle` -> `302 /admin/settings`; `GET /admin/projects/:id/edit`
   -> `302 /admin/projects/:id/settings` (still owner-checked, 404 on mismatch - same failure shape, no
   403 oracle). POST action URLs are unchanged; only their post/redirect/get targets move to the new
   sub-pages (e.g. member/request/invite POSTs land on the project's Access tab; billing POSTs on Billing).

4. **Progressive disclosure:** the permanent `.help` intro boxes become collapsed `<details>` or one-line
   captions (the concept explainer, the Grant/Rotate/Revoke primer, the requests explainer, the inline
   billing pricing); form-page primers tighten to one sentence. First-run still teaches via the wizard.

## Non-goals

- **Landing commercial-first copy** (demote open-source per the OSS steer) is a SEPARATE change, held for
  marketing coordination (the landing is a shared surface). Not in this decision's scope.
- No schema change, no new query - pure presentation/routing over existing owner-scoped queries.
- No functional hosted-structure toggle yet (decision 022 fast-follow) - only a placeholder.

## Invariants preserved

Every new page routes through `layout()`, so the analytics chokepoint (decision 021) and HEAD-as-GET come
free; `test:analytics-allpages` is extended to cover the new pages. Every project sub-route re-proves
ownership via `loadOwnedProject(owner.id, id)` and 404s on mismatch (invariant 3, no 403 oracle);
`test:admin-isolation` is extended per new sub-route. `esc()` on all rendered values and CSRF on every POST
are unchanged (no POST action URL changes). Token identity (1), atomic claim (2), the Caddy-stripped admin
header (4), fail-open (5), ledger-preserving deletes (6), hashed tokens (7) are untouched.

## Consequences

- The admin becomes legible: a human goes straight to billing, or to a project's members, without
  scrolling past everything else - the situational-awareness Board is the project front door.
- Built in phases (each lands green): (1) account nav + dashboard split, (2) project tabs + Board,
  (4) disclosure polish. Phase 3 (landing copy) is deferred to a marketing-coordinated change.
- `docs/architecture.md` route map, `README.md`, and `USING.md` are updated to match (§07).
