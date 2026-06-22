# Architecture

Single source of truth for the technical structure of LLM Bus. This **describes the system that
ships** (decision [005](decisions/005-adopt-genesis-protocol-v1.3.md) locked it); it is not a
redesign. Change it only alongside a new file in [decisions/](decisions/).

## Stack and versions (pinned)

| Concern | Choice | Version |
|---|---|---|
| Language / runtime | TypeScript on Node | Node >= 22 (VM 22, dev 25); `tsc` 6.0.3 |
| Module system | ESM, `module`/`moduleResolution` = NodeNext, `.js` import specifiers | - |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP (stateful sessions, JSON responses) | 1.29.0 |
| Database | PostgreSQL via `pg` | pg 8.21.0; PG 16 local (port 5440), PG 16 prod (port 5433) |
| Validation | `zod` | 4.4.3 |
| Dev runner | `tsx` | 4.22.4 |
| Types | `@types/node`, `@types/pg` | 25.9.2, 8.20.0 |
| Web framework | none (hand-rolled `node:http`); server-rendered admin, no client JS | - |

Versions are pinned exactly in [package.json](../package.json). Do not float them; a bump is a
deliberate change (decision [002](decisions/002-stack-atomic-claim-hosting.md)).

## Module boundaries

Source lives under `src/`:

- `server.ts` - entry point: load config, fail-fast DB check, bind `127.0.0.1:PORT`.
- `http.ts` - the hand-rolled HTTP router: routes `/mcp`, `/healthz`, `/join`, `/admin/*`.
- `config.ts` - environment config loader.
- `db.ts` - the `pg` pool and `query` helper; the single DB access point.
- `auth.ts` - `authenticate()`: resolve a bearer token to a `Ctx`. Identity comes from here, never
  from tool input.
- `context.ts` - the `Ctx` type (participation -> project + participant + owner).
- `mcp.ts` - registers the MCP tool surface; each tool receives a `Ctx`.
- `events.ts` - the append-only event ledger writer.
- `presence-mw.ts` - implicit-heartbeat middleware (any tool call refreshes liveness).
- `invite.ts` - the public `/join` redeem flow.
- `invite-accept.ts` - the hosted OAuth-accepted invite flow (`invites` table); the in-app analogue
  of `/join`. Mints/accepts invites; the participant is created under the project owner's namespace so
  acceptance grants a token but no project access (invariant 3). Used only in the hosted topology.
- `domain/` - one file per coordination concern, pure-ish over the DB: `claim`, `post`, `lease`,
  `task`, `presence`, `digest`, `query`.
- `admin/` - the SSO-gated web admin: `router`, `session`, `handlers`, `queries`, `owner`, `html`
  (the single `esc()` XSS chokepoint), and `oauth` (the in-app Google/GitHub login for the hosted
  topology; active only when `ADMIN_AUTH_SOURCE=oauth`). Every admin query is owner-scoped;
  `handlers.resolveIdentity` is the shared header/oauth identity resolver.

Supporting trees: `db/` (schema + migrate), `scripts/` (operational one-offs), `ops/` (deploy),
`kit/` (the client-side adherence kit), `test/`.

## Import / dependency rules

1. **All database access goes through `db.ts`.** Domain and admin modules import `query`/the pool
   from there; no module constructs its own `pg` client.
2. **Identity flows one way: `auth.ts` -> `Ctx` -> tools.** No domain or admin code reads a
   caller-supplied project or identity; it reads `Ctx`. This is invariant 1.
3. **`domain/` must not import from `admin/`**, and neither imports from `server.ts`. HTTP/transport
   wiring lives in `http.ts`/`mcp.ts`/`admin/router.ts`, not in domain logic.
4. **All HTML output goes through `admin/html.ts`'s `esc()`.** No ad-hoc string interpolation into
   markup (invariant 4: XSS chokepoint; no client JS).
5. **All SQL is parameterized.** No string-built queries.
6. Runtime dependencies are deliberately minimal (`@modelcontextprotocol/sdk`, `pg`, `zod`, plus
   `@google-cloud/cloud-sql-connector` which is loaded by a dynamic import only in the Cloud Run
   topology - decision 009). Adding one requires a decision file. The in-app OAuth (decision 010) is
   deliberately dependency-free (`fetch` + provider userinfo), so it adds none.

## Directory conventions

- `src/domain/<concern>.ts` - one coordination concern per file.
- `src/admin/<role>.ts` - admin split by role (routing, session, handlers, queries, rendering).
- `test/<area>.<kind>.test.ts` - one test file per concern; each is an executable `tsx` script with
  its own `npm run test:*` entry.
- `db/schema.sql` - idempotent (`CREATE ... IF NOT EXISTS`) with an "Idempotent upgrades" ALTER
  section at the bottom for changes to existing tables.
- `ops/` - deploy: `systemd/`, `caddy/`, `setup.sh`, `token.sh`, `bootstrap-owner.sh`, runbook.
- `kit/` - shipped to consumers, not used by the server itself. Includes `kit/okf/`, a structure-only
  OKF knowledge-wiki starter seeded by `install.sh --with-okf` (advisory; the bus never stores
  knowledge - see decision [007](decisions/007-okf-knowledge-layer-support.md)).

## State management

All state is in PostgreSQL; the app process is stateless (no on-disk writes;
`ProtectSystem=strict` in the unit). Tokens are sha-256-hashed at rest and revocable. Everything is
**project-scoped** and isolated by owner. The bind address is config-driven (`BIND_ADDRESS`,
default `127.0.0.1`): the VM topology binds loopback behind Caddy; the Cloud Run topology binds
`0.0.0.0` and the platform provides the network boundary + TLS (decision 009 relaxes invariant 7's
literal bind clause for Cloud Run while preserving the TLS-via-platform property). The DB pool is the
direct `pg` pool by default, or an IAM-authed Cloud SQL connector pool when `CLOUD_SQL_INSTANCE` is
set (no transaction-mode pooler in the claim path - invariant 2). The atomic claim is a single fused
`INSERT ... ON CONFLICT (project_id, name) DO UPDATE SET current = current + 1 RETURNING` that takes
its event in the same transaction (invariant 2; decision
[002](decisions/002-stack-atomic-claim-hosting.md)). Schema changes are additive and reversible -
there is a production DB on the VM.

## API patterns

- **MCP surface (26 tools):** allocation (`claim`, `seed_sequence`, `latest_claims`), presence
  (`register`, `who_is_active`), handoffs (`post`, `read_posts`, `ack`), leases (`lease`, `release`,
  `who_holds`), tasks (`task_create/assign/start/block/resolve/ship`, `list_tasks`), knowledge
  (`query_events`, `whats_new`), identity/admin (`whoami`, `list_participants`, `admin_provision`,
  `create_invite`, `admin_revoke`, `admin_rotate`). Query is exact-match only. Tools take a `Ctx`,
  never a project/identity argument.
  Responses are small and stable by design (context cost).
- **HTTP routes:** `/mcp` (the MCP transport, bearer-authed; an unauthenticated request gets a 401
  with an RFC 9728 `WWW-Authenticate` challenge), `/.well-known/oauth-protected-resource` (public PRM
  metadata, forward-compat for MCP OAuth discovery; decision 010), `/healthz` (public), `/join`
  (public, rate-limited invite redeem), `/admin/*` (owner-scoped owner dashboard). CSRF on every
  admin POST.
- **Admin trust boundary (config-selected by `ADMIN_AUTH_SOURCE`):** in `header` mode (default; the
  live service) the SSO-derived email header is trusted **only** because Caddy strips any
  client-supplied copy (`ops/caddy/yolo.caddy`). In `oauth` mode (the hosted topology) there is no
  trusted header: identity is a verified Google/GitHub login bound to the session
  (`/admin/login`, `/admin/auth/:provider/start|callback`), and the hosted edge additionally fronts
  `/admin` with IAP + signed-JWT verification (decision 009). The two modes never both apply. Either
  way id-routes re-prove ownership and 404 on mismatch (no 403 oracle). Invariants 3 and 4.
- **Hosted invites:** `/admin/accept?token=...` signs the joiner in (carrying the invite through the
  OAuth `state`) and, on callback, accepts the invite in one transaction (`invites` table; decision
  010). The participant is created under the project owner, so the accepter gets a token but no admin
  over the project (invariant 3).

## Testing pyramid

Integration-first against a real local Postgres (no mocks for the DB). 16 test files, each an
executable script run by `tsx`, with a shared `test/_setup.ts`:

- `concurrency.claim` - 500 concurrent claims -> 500 distinct gap-free ids + 500 events (guards
  invariant 2).
- `smoke.mcp` - full MCP round-trip.
- `post.ack`, `lease.expiry`, `task.statemachine`, `digest.cursor` - coordination flows.
- `isolation.project` - project scoping (invariant 1).
- `hook.failopen` - the kit hook warns and proceeds when the service is down (invariant 5).
- `admin.crud`, `admin.isolation`, `admin.authheader` - admin CRUD, owner isolation (invariant 3),
  the trusted header boundary (invariant 4).
- `invite.redeem` - the `/join` flow.
- `invite.accept` - the hosted OAuth-accepted invite transaction: single-use, expiry/revoke,
  targeted-email refusal, and that acceptance grants a token but no project access (invariant 3).
- `oauth.signup` - verified-email-only provider linking (rejects unverified Google / non-primary
  GitHub), the authorize-URL builder, and self-serve signup idempotency.
- `email.smtp` - the SMTP email path.

If you change behavior, add or extend a test here.

## Required verification commands

The verification gate (see [CONTRIBUTING.md](../CONTRIBUTING.md)) binds to:

```bash
npm run verify   # tsc --noEmit, then all 16 tests
```

Prerequisite: a local Postgres 16 on port 5440 with an `llm_bus` database. `DATABASE_URL`
defaults to `postgres://<you>@127.0.0.1:5440/llm_bus`. `npm run typecheck` and the individual
`npm run test:*` scripts exist for narrower runs. `verify` is the gate - do not merge red.

## Coding standards

1. ESM with `.js` import specifiers (NodeNext); `tsc --noEmit` must be clean.
2. All SQL parameterized; all DB access via `db.ts`; all HTML via `esc()`.
3. No new runtime dependency without a decision file.
4. Schema edits are additive/reversible and idempotent (`IF NOT EXISTS` / the ALTER section).
5. Style: no em dashes, no emoji in code/docs/commits, terse prose, one H1 per
   markdown file, relative links within the repo.
6. The seven invariants (see [SECURITY.md](../SECURITY.md)) are load-bearing; a change touching one
   needs the relevant guard test green and, if it alters the contract, a decision file.
