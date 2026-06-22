# 004 - Owner/participant model + web admin

**Date:** 2026-06-10
**Status:** Accepted

## Decision

Evolve tenancy to be **owner-centric** and add a **web admin**. Locked structure:

- **Owner** - a human user (email + card-on-file). Free to exist and create projects; the **billing
  entity**; authenticates via Google SSO.
- **Project** - owned by an Owner; the coordination space (sequences / events / posts / leases /
  tasks / presence scoped here).
- **Participant** - an identity the Owner creates (agent **or** person); the unique entity "on the
  ledger."
- **Participation** - a Participant granted into a Project; carries a **token**; the **billable
  unit**.

A bearer token resolves to `(participation -> project + participant + owner)`. MCP tools never accept
a project or identity as input - both come from the token.

**Web admin** (behind the platform's Google SSO via oauth2-proxy): create/list an owner's projects
and participants; grant participants into projects (mint a participation token); show a per-grant
hand-out card (token + ready `.mcp.json`); rename; revoke; delete; a per-project participation view;
one-use expiring **invites** for self-assembling onboarding. Server-rendered HTML, a single `esc()`
XSS chokepoint, no client JS.

**Billing (structure locked, implementation deferred):** per participation, on a project basis;
later also on coordination **volume** (a credits concept); no free allowance beyond being an owner
and creating empty projects. Stripe + metering + credits + free tier are a later pass.

## Context

Onboarding several projects and agents by hand (tokens pasted in chat) proved unmanageable. A
workshop converged on this owner-centric model. The v1 `actors` table already was "a participant in
a project," so v2 is an **additive refactor** (add `owners`/`participants` + project ownership;
rename workspace -> project, actor -> participation), not a rewrite. The MCP coordination tools are
unchanged.

## Alternatives considered

- **A "Company" tier above Owner** - dropped: the Owner is the top entity.
- **A free coordination allowance** - rejected for now: free to be an owner and create empty
  projects (the gateway); pay per participation.
- **Per-owner API keys instead of per-participation tokens** - rejected: token-per-participation is
  what makes every act attributable and project-scoped.

## Consequences

- Schema added `owners`, `participants`, project ownership, and tokens on participation; coordination
  tables renamed for clarity with semantics unchanged.
- New surface: the admin web UI plus oauth2-proxy integration, gated by the anti-spoof header strip
  in Caddy (see CLAUDE.md invariants and [ops/README.md](../../ops/README.md)).
- Deleting a participant preserves the ledger (FKs are `ON DELETE SET NULL`).

## Follow-ups

- Stripe billing over the participation/event ledger; credits/volume model; free tier (PLAN.md).
  Addressed by [011](011-stripe-billing-over-the-ledger.md) (flat tier + free tier; meter
  participations; Postgres mirror).
- Multi-admin-per-owner and cross-owner project sharing - deferred; the model does not preclude them.
  Cross-owner sharing via the invite network is taken up by
  [010](010-oauth-self-serve-signup-and-invites.md).
- First-class `revoke`/`rotate`: shipped 2026-06-16 (web-admin Rotate button + `admin_rotate`/`admin_revoke` MCP tools; revoke already shipped in the web admin with the model).
