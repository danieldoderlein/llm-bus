# 044 - Globally-unique numbering across independent peer projects: auto-qualified ids

**Date:** 2026-08-12
**Status:** Accepted (operator-directed design, 2026-08-12). Extends [040](040-v2-migration-hardening.md)'s
sequence-safety work to the cross-project case. Number claimed on the bus (`claim("decisions")` -> 044).
Refined by [070](070-one-connection-many-projects.md) (the qualified `<ownerHandle>/<slug>` address now also
disambiguates a PROJECT when one connection holds two memberships whose slugs collide).

## Context

A consuming rig hit a live duplicate-number trap: the same sequence name (`adr`/`migration`) exists on the
Kvad platform + the project-c + minter product buses, and each emits a BARE id (`R181`) that collides across the
shared bus (a read-only sweep found project-c AND minter both at R180 -> R181, migration project-c at 51 -> 52; the
original report named only project-c).

**Topology (operator input, load-bearing):** these are **independent PEER projects**, not a hub and its
spokes. The Kvad **platform** is its own project/codebase; **BU2** (a health-coach product) and **Minter** run
ON the platform but are their own separate codebases; if the platform stopped at a release, BU2 and Minter
would continue on their own. They collaborate over the shared bus by choice, not dependency. So obtaining a
number *from* a "main" project (an authority) is the WRONG model - it manufactures the coupling the operator
rejects. Each project owns its numbering outright.

**Requirements (operator):** (1) a project **PUTs** its existing local numbering onto the bus once (seed) and
uses the bus from then on; (2) the **local number is preserved** - `R123` stays `R123`, no reshuffling of
files - while a **unique element** keeps `R123` in one project from clashing with `R123` in another (the case
that bites a participant in MANY projects, a key bus benefit - AI agents that see across everything; the
operator is in 5); (3) **nobody claims a project-name-based unique combination** - that would breed "this name
is taken" friction, so the unique element must be automatic.

## Why the engine cannot detect this at claim time (and must not try)

`claim()` is atomic and gap-free **within one project** (invariant 2); each counter is legitimately its own.
Project isolation (invariant 1 - a token sees only its own project) is exactly what stops the engine from
seeing another project's counter, and MUST stay so - an authority-proxy would breach isolation and re-couple
the tenants. So the fix is not detection or a shared authority; it is to make each id carry its project so
collisions are impossible by construction, using an identity that already exists (no new claim).

## Decision

`claim()` keeps returning the **bare local id** (`R123`) for the repo filename - unchanged, no reshuffle - and
ADDITIONALLY returns an **auto-qualified bus id**:

    qualified = "<project-owner-handle>/<project-slug>#<local-formatted-id>"      e.g.  owner/project-c#R123

- The qualifier is the project's existing canonical bus address - the **project OWNER's globally-unique handle
  + the project slug** (NOT the caller's handle: a task claimed in a project you're a MEMBER of qualifies as
  `alice/app#...`, so everyone cites the same id). Both parts already exist, so nothing is ever claimed and
  "taken" cannot happen (requirement 3). Globally unique because the handle is globally unique and the slug is
  unique within that owner.
- Additive: the local id is untouched (requirement 2); existing bare ids across every repo are grandfathered
  (still valid in their own project); the qualified id is the reference form used ACROSS projects / by a
  multi-project agent.
- The counter and the **PUT** (seed) are unchanged (requirement 1): a project seeds its local counter onto the
  bus (`seed_sequence`) and the qualifier rides on top automatically.
- Surfaced on the three number surfaces: `claim` (adds `qualified`), `list_sequences` (adds
  `next_qualified`), `latest_claims` (adds `qualified`). A shared `qualifyId(handle, slug, formatted)` helper
  is the single source. Clients MAY shorten the display to `project-c#R123` when it is unambiguously the caller's
  own project; the engine always returns the full canonical form.
- Convention (agent guide + decision): cite a number from ANOTHER project by its qualified id; a number in
  your own repo stays bare. Added to `coordinationGuide()`.

This makes the live BU2/Minter cross-project collision impossible (`owner/project-c#R181` != `owner/minter#R181`)
without touching either counter. Any WITHIN-project staleness (a counter drifted below its own repo's max) is
a separate 040-class re-sync, owner-gated to minter-dev (OI-10) - qualification does not mask that.

## Consequences / reversibility

- No project depends on another for numbering (the core requirement). Isolation intact - the qualifier is
  built from the caller's OWN project's owner+slug, resolved server-side; no cross-project read.
- Additive only: `formatId`/counters unchanged; a new returned field + a guide convention. Existing records
  keep their bare ids. Reversible by dropping the field.
- Not built here (optional follow-up): an operator-only cross-project "same sequence name on N projects"
  divergence view. With auto-qualification collisions are structurally impossible, so it is a nicety, not a
  guard - deferred.

## Testing

`concurrency.claim` unchanged (per-project atomicity intact). New: two projects (distinct owner/slug) claiming
the same sequence yield the SAME bare `formatted` but DISTINCT `qualified` ids; the qualifier equals
`<owner-handle>/<slug>#<formatted>` and is built from the PROJECT owner (a member-claimed task in a foreign
project qualifies with that project's owner, not the caller); `list_sequences`/`latest_claims` carry the
qualified form. Full `npm run verify` green.
