# Architecture

Single source of truth for the technical structure of LLM Bus. This **describes the system that
ships** (decision [005](decisions/005-adopt-genesis-protocol-v1.3.md) locked it); it is not a
redesign. Change it only alongside a new file in [decisions/](decisions/).

## Stack and versions (pinned)

| Concern | Choice | Version |
|---|---|---|
| Language / runtime | TypeScript on Node | Node >= 22 (VM 22, dev 25); `tsc` 6.0.3 |
| Module system | ESM, `module`/`moduleResolution` = NodeNext, `.js` import specifiers | - |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP (stateless per-request, JSON responses; decision 030) | 1.29.0 |
| Database | PostgreSQL via `pg` | pg 8.21.0; PG 16 local (port 5440), PG 16 prod (port 5433) |
| Validation | `zod` | 4.4.3 |
| Dev runner | `tsx` | 4.22.4 |
| Types | `@types/node`, `@types/pg` | 25.9.2, 8.20.0 |
| Web framework | none (hand-rolled `node:http`); server-rendered admin + a few small static inline scripts (copy handler, cookie banner, GA loader, connect-card status poll - decision 028); no client framework/build/external asset | - |

Versions are pinned exactly in [package.json](../package.json). Do not float them; a bump is a
deliberate change (decision [002](decisions/002-stack-atomic-claim-hosting.md)).

## Module boundaries

Source lives under `src/`:

- `server.ts` - entry point: load config, fail-fast DB check, bind `127.0.0.1:PORT`.
- `http.ts` - the hand-rolled HTTP router: routes `/mcp`, `/healthz`, `/join`, `/p/*`, `/admin/*`.
- `config.ts` - environment config loader (zod). Validates at boot and fails LOUD on broken config
  rather than degrading silently at use time: `SMTP_FROM` must be an email / `Name <email>`, `SMTP_HOST`
  requires `SMTP_FROM`, and `SMTP_USER`/`SMTP_PASSWORD` are both-or-neither.
- `db.ts` - the `pg` pool and `query` helper; the single DB access point.
- `auth.ts` - `authenticate()`: resolve a bearer token to a `Ctx`. Identity comes from here, never
  from tool input. The displayed/written bus actor is the globally-qualified `handle/label` (decisions
  018, 056), composed here - the single composition point - from the token-resolved **bound human**
  handle (`participations.human_owner_id`), falling back to the project-owner handle, plus the
  participant label. NB: `ctx.project.ownerHandle` stays the PROJECT-owner handle (the decision-044
  cross-project qualifier), and `ctx.owner` / billing / the non-payment suspension gate stay keyed on
  the project owner - only the DISPLAYED actor prefers the bound human.
- `context.ts` - the `Ctx` type (participation -> project + participant + owner); carries `actor` (the
  qualified `handle/label`, bound-human-preferring) and `participant.handle`.
- `admin/username.ts` - derive + allocate the globally-unique owner handle (decision 018).
- `mcp.ts` - registers the MCP tool surface; each tool receives a `Ctx`.
- `events.ts` - the append-only event ledger writer.
- `presence-mw.ts` - implicit-heartbeat middleware (any tool call refreshes liveness).
- `platform-identity.ts` - the `PLATFORM_ACTORS` / `PLATFORM_ACTORS_SQL` chokepoint (decision 072): the one
  place that names the platform's own actors, so a rename cannot leave half the code addressing a stale
  identity. Same single-constant shape as the `analytics.ts` and `brand.ts` chokepoints.
- `invite.ts` - invite helpers; the open `/join` redeem flow AND the request-to-join `/p/*` pages are
  RETIRED (decisions 037/038 - `POST /join` and `/p/*` both return 410). Targeted invites live in
  `invite-accept.ts`.
- `invite-accept.ts` - the targeted, SSO-accepted invite flow (`invites` table) - the ONLY collaborator
  join path (decision 037). Mints/accepts invites; the participant is created under the project owner's
  namespace and the accepter becomes a project member, so acceptance grants a token + their membership-scoped
  rows on the `/admin/tasks` board but no owner-level project access (invariant 3).
  Exports the shared `grantParticipation()` (the race-safe participant+participation+token mint, which
  now also stamps `human_owner_id`) and `acceptInviteById()` (the OAuth consent-picker accept, strictly
  limited to a targeted invite whose email matches the SSO-verified identity).
- `oauth-as.ts` - the OAuth 2.1 authorization server core (decision 024): RFC 8414 metadata, RFC 7591
  DCR, PKCE S256, single-use hashed authorization codes, access/refresh issuance (the access token is a
  normal `tokens` row), and the consent-picker enumeration. Pure functions (metadata/PKCE/redirect
  validation) are unit-tested network-free; the rest is DB-backed. A leaf module (no admin imports).
- Request-to-join (decision 020) is RETIRED (decision 038): enrollment is targeted-invite-only. The
  `join-request.ts` module and the public `/p/*` pages were removed; `/p/:handle/:slug` (+ `.../request`)
  now return **410**. The `join_requests` table + `projects.request_mode` column are retained dormant (no
  live path reads or writes them; additive/reversible schema only).
- `analytics.ts` - the single analytics chokepoint (decision 021): `gaHead()` + `cookieBanner()`,
  consent-gated on `GA_MEASUREMENT_ID`, self-contained CSS so they drop into any page. EVERY HTML page
  (landing, `renderLegal`, `BRAND_HTML`, admin `layout()`) includes both; new pages import from here.
  `gaHead(params?)` optionally emits a strictly-whitelisted `gtag('set',{...})` before config so the auto
  page_view carries a dimension (decision 027, gap-D: the landing bakes `{landing_variant}` per variant);
  the whitelist (key `/^[a-z_]+$/`, value enum `everyone|dev`) preserves the injection-safety guarantee,
  and the no-params call is byte-identical so all other pages are unchanged.
- `brand.ts` - the single design-token chokepoint (decision 026): exports `TOKENS` (a `:root` custom-
  property block + a global `:focus-visible` ring). EVERY served surface (both landing variants,
  `renderLegal`, `BRAND_HTML`, admin `layout()`) injects `${TOKENS}` into its inline `<style>` and declares
  no `:root` of its own, so colours/type/spacing can't drift (they did: six inline `:root` blocks). Marketing
  owns the values; `brand/system.css` is the human-readable mirror, not the runtime source. `test:brand-tokens`
  guards single-source consumption. Parallel to `analytics.ts`; CSP-safe (no CDN, no build step). The token
  module is a design-system LOOP (decision 055): a visual component lives in the tokens + its CSS and is SHOWN
  on `/brand`; a new component is added to the tokens and rendered on `/brand` in the same change. First such
  component: the per-state task shades (`--state-<status>-wash/-edge`, WCAG-AA-guarded), applied by
  `.taskrow.s-*` / `.taskcard.s-*` on the task board.
- `domain/` - one file per coordination concern, pure-ish over the DB: `claim`, `post`, `lease`,
  `task`, `presence`, `digest`, `query`, `roster`, `links`, `projects` (the last also home to the shared
  `reachClause`/`liveTokenClause` predicates - see below). This list is a map, not an inventory: `ls
  src/domain/` is the authority, and it drifted to 8-of-10 once already. `listTasks` is an INDEX read (decision 064): bodies are
  previewed with `left()` IN SQL (so a 4000-char detail never crosses the wire), the default excludes the
  terminal archive, and `task_ids` is the paired precise read returning named tasks in full whatever their
  state - a filter rather than a new tool, so no connected agent needs an MCP reconnect to use it. EVERY MCP tool delegates here; none carries its own SQL.
  That is not tidiness - `list_participants` was the one exception, inline in the tool registration, and it
  was correspondingly the one project-scoped read with no isolation test, because there was no function to
  call. A tool with inline SQL is a tool nobody can test.
- `admin/` - the SSO-gated web admin: `router`, `session`, `handlers`, `queries`, `owner`, `html`
  (the single `esc()` XSS chokepoint), `oauth` (the in-app Google/GitHub login for the hosted
  topology; active only when `ADMIN_AUTH_SOURCE=oauth`), and the operator console
  (`operator-handlers`, `operator-queries`, `operator-html`; decision 013). `operator-queries` is the
  ONLY cross-tenant reader and must never be imported by the owner-dashboard code. `handlers.resolveIdentity`
  is the shared header/oauth identity resolver used by both surfaces.

Supporting trees: `db/` (schema + migrate), `scripts/` (operational one-offs), `deploy/` (generic examples),
`kit/` (the client-side adherence kit), `test/`.

## Import / dependency rules

1. **All database access goes through `db.ts`.** Domain and admin modules import `query`/the pool
   from there; no module constructs its own `pg` client.
2. **Identity flows one way: `auth.ts` -> `Ctx` -> tools.** No domain or admin code reads a
   caller-supplied project or identity; it reads `Ctx`. This is invariant 1.
3. **`domain/` must not import from `admin/`**, and neither imports from `server.ts`. HTTP/transport
   wiring lives in `http.ts`/`mcp.ts`/`admin/router.ts`, not in domain logic.
4. **All HTML output goes through `admin/html.ts`'s `esc()`.** No ad-hoc string interpolation into
   markup (invariant 4: XSS chokepoint). Client JS is limited to a few small static inline scripts
   (copy handler, cookie banner, GA loader, connect-card status poll - decision 028); no framework/build.
5. **All SQL is parameterized.** No string-built queries.
6. Runtime dependencies are deliberately minimal (`@modelcontextprotocol/sdk`, `pg`, `zod`, `stripe`
   for billing (decisions 015/016), plus `@google-cloud/cloud-sql-connector` which is loaded by a
   dynamic import only in the Cloud Run topology - decision 009). Adding one requires a decision file. The in-app OAuth (decision 010) is
   deliberately dependency-free (`fetch` + provider userinfo), so it adds none.

## Directory conventions

- `src/domain/<concern>.ts` - one coordination concern per file.
- `src/admin/<role>.ts` - admin split by role (routing, session, handlers, queries, rendering).
- `test/<area>.<kind>.test.ts` - one test file per concern; each is an executable `tsx` script with
  its own `npm run test:*` entry.
- `db/schema.sql` - idempotent (`CREATE ... IF NOT EXISTS`) with an "Idempotent upgrades" ALTER
  section at the bottom for changes to existing tables.
- `deploy/` - generic self-host examples (Docker, Compose, systemd).
- `tools/<name>/` - vendored, self-verifying developer tooling that is NOT part of the service: plain
  `.cjs` run directly, no dependencies, not compiled into `dist/`, each with its own README and its own
  test script (not wired into `npm run verify`, which gates the SERVICE). `tools/auto-mode/` is the
  falling-edge Stop hook (decision
  [071](decisions/071-auto-mode-falling-edge-hook.md)), vendored from the canon method library and
  re-synced from there rather than forked - only its `REASON` constant is local. Its harness contract is
  volatile and re-checking it is a section 06 drift trigger.
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

- **MCP surface (37 tools):** 34 v2 tools + 3 transitional retirement tombstones (decision 040). Allocation
  (`claim`, `seed_sequence`, `latest_claims` - reads the authoritative `sequences` counter, so it agrees with
  `list_sequences` and survives a ledger flush (decision 040), `list_sequences`) - each carries the bare local
  id AND an auto-qualified cross-project id `<owner-handle>/<slug>#<id>` built server-side from the caller's own
  project owner+slug, so the same bare id in two projects can never clash (decision 044; isolation preserved,
  nothing claimed), presence
  (`register`, `who_is_active`), handoffs (`post`, `read_posts` - reading is the receipt; `ack` was retired by
  decision 039), leases (`lease`, `release`,
  `who_holds`), tasks (`task_create/assign/start/ship/answer/edit/depend/undepend/block/resolve/cancel/reopen`,
  `list_tasks`) - the v2 five-state model (todo/in_progress/blocked-derived/done/cancelled) with assignee as an
  editable field, first-class dependency edges, and task options + answer (decision 039; this retired the
  `review`/`answer_review` tools of decisions 033/034 - now transitional tombstones `review`/`answer_review`/
  `ack` that throw a one-round-trip redirect to their v2 replacement instead of vanishing as a "disconnected
  server" (decision 040); removed at end of the migration window, returning the count to 33), knowledge
  (`query_events`, `whats_new`), identity/onboarding (`whoami`, `guide` - returns the coordination
  protocol so an agent can pull the latest any time), admin (`list_participants`, `admin_provision`,
  `create_invite`, `admin_revoke`, `admin_rotate`), and projects (`list_projects`). Query is exact-match only.
  **IDENTITY still comes only from the token, but SCOPE is now selectable among the memberships that token
  already holds** (decision [070](decisions/070-one-connection-many-projects.md)): every tool takes an
  optional `project`, injected once in `reg` so the surface has no exceptions, and `src/domain/projects.ts`
  resolves it to that membership's `Ctx` or refuses. Omitted, a call acts in the token's own project exactly
  as before. Handlers receive their `Ctx` as a PARAMETER (`buildServer`'s own is named `baseCtx`), so a
  handler that forgets it fails to compile rather than silently acting in the default project. A response
  from a non-default project carries `_project`.
  **Assignment is TWO-NAMESPACED** (decision 061): `owner:` names an AGENT participation (a process that
  only sees the task if it polls) and `human:` a project MEMBER (a person, whose work lands on the web
  board, whose WRITE path filters `assignee_owner_id`; its read path shows the project since 078). `list_participants` returns BOTH - agents from
  `participations` plus human members from `project_members` - each row carrying `assign_with`, the field
  that routes to it, derived from the row source. The `tasks.owner_name` display snapshot is composed from
  the ASSIGNEE's own bound human (`COALESCE(human_owner_id, participants.owner_id)`), never from the
  caller, on both the MCP and web write paths. Naming one namespace's target in the other field throws a
  directive error naming the corrective call; both probes are project-scoped, so a cross-tenant name gets
  the byte-identical generic message (no existence oracle, invariant 3).
  **What a stale tool schema does and does not prevent** (decision 064's amendment, corrected): an MCP
  client fetches `tools/list` - including every `inputSchema` - ONCE, at connect time, and the stateless
  transport has no session on which to send `tools/list_changed`. So an agent connected before a parameter
  shipped is never TOLD it exists. It is NOT prevented from using it: measured, the SDK client transmits an
  argument absent from its cached schema and the server receives it (guarded in `smoke.mcp`). **A stale
  schema is an informational gap, not a mechanical one.** The practical rule: a new parameter needs no
  reconnect to WORK, only to be DISCOVERED, so ship it with a way for an uninformed caller to learn of it -
  a response-borne note naming the parameter is sufficient, because no cache can stale a response. A new
  TOOL is different: there is no response to hang the notice on until the tool is called, so it genuinely
  strands connected agents until they reconnect. That asymmetry, not "send versus receive", is the reason
  to prefer a parameter over a tool. The mirror case (decision 066): zod STRIPS an argument a tool does
  not declare, so a misspelled parameter succeeds silently and returns an answer to a different question.
  Every response therefore carries `_ignored_params` when the call sent keys the tool does not have,
  naming the nearest real one - reported rather than refused, since refusing would break every caller on a
  stricter build. The keys are captured in `http.ts` before zod runs, because by handler time the evidence
  is gone.
  Responses are small and stable by design (context cost). The transport is stateless (decision 030): a
  fresh `buildServer(ctx)` is built per request from the re-authenticated token, so `ctx` is never a stale
  snapshot. The admin gates and `whoami` additionally re-read `is_admin` LIVE from the DB (`liveIsAdmin`)
  so an owner's grant/revoke takes effect on the next tool call. (Lane needs no such re-read: it is never
  consumed from the per-request ctx -
  `register` takes it from input, `list_participants` reads it live, and delivery resolves it live per
  query. That is what keeps the stateless-transport guarantee: no lane decision is ever made from a
  snapshot taken at authentication time.)

  **A LANE is a role/stream label inside a project** (`dev`, `marketing`) - a shared room, not a wall, and
  not a permission boundary: the project already scopes the product, and any member can read any lane's
  archive. A participation has ONE routing lane, resolved LIVE-then-PROVISIONED (decision 065):
  `presence.lane`, written by `register()`, falling back to `participations.lane`, set at provision/invite
  time and shown by `list_participants`. Strict COALESCE, so `register()` MOVES an agent's lane rather than
  adding a second, and it dual-writes `participations.lane` so the two columns cannot diverge. One exported
  helper (`laneDeliverySql` in `src/domain/post.ts`) is the ONLY expression of that rule, consumed by every
  delivery site - `readPosts(to_me)`, the read-receipt insert, `unreadCount`, and `whats_new.unread_posts`;
  the same resolution is reported by `who_is_active`, `list_participants` and `active_peers`, so no "who"
  surface can disagree with delivery. The provisioned arm is bounded by `LANE_FALLBACK_FROM`, a release
  constant, so 065 did not retroactively push the pre-065 lane archive into live inboxes; that history stays
  readable via `read_posts(to_lane:)`. A lane that exists in NEITHER column is REFUSED on both `post` and
  `read_posts` (an empty result for a lane nobody holds is indistinguishable from an empty lane), and `post`
  always returns `reaches` + `recipients` so an empty audience cannot be missed by not reading prose. The
  read receipt written on a lane read is scoped to the ADDRESSEE where the operator's unread bucket is
  concerned, so a bystander in the lane cannot clear a directed post's nag. Task `lane` is an independent
  filter label and routes nothing.
- **HTTP routes:** `/` (the public marketing landing - a SINGLE brand-reviewed page, marketing's
  relaunch-2026-08 landed via `src/landing-relaunch.ts`, decision 060; `landingDoc()` wraps it with the
  analytics chokepoint (021), the shared `${TOKENS}` (026), the live `/api/stats` KPI wiring, and the signup
  instrument; static doc with client-side animation. `?v=everyone|dev` + the `aud` cookie (**default
  everyone**) + the `llmbus_variant` CTA UTM are RETAINED from decision 027 as write-only campaign attribution
  only - decision 060 retired the on-page toggle + content A/B, so the two pre-rendered variants now serve
  IDENTICAL content and differ only in the SERVER-set `mode-dev` body class + `data-aud` + the `gaHead`
  `landing_variant` pageview dimension; `landing_variant` is still captured first-party into
  `owners.landing_variant` on a NEW owner only, enum-validated, never read into identity/authz (invariant 1;
  decisions 027/060, gap-B)), `/api/stats` (public, cached 60s aggregate counts for the
  landing KPIs; cross-tenant, excludes the `billing` actor),
  **`/api/wait` (the WAKE CHANNEL, decision 079)** - bearer-authed like `/mcp`, holds the request open
  until the CALLING participation has work, then answers with COUNTS ONLY (`work`/`tasks`/`unread`/
  `unassigned`) and never content, so it can never become a second inbox competing with the board.
  Deliberately not an MCP tool: a tool call happens inside a turn and would block it, and this is meant
  to be held by a detached process while no turn is running. Backed by one `pg_notify` trigger on
  `events` carrying only the project id, plus ONE shared `LISTEN` connection fanning out in process
  (`src/domain/wait.ts`) - a connection per waiter would die at Postgres's ~100 `max_connections`. The
  trigger is dumb ON PURPOSE: each waiter re-evaluates its own queue with the same predicates
  `whats_new` uses, so "what counts as work" is never forked into SQL that can drift. Window clamps to
  1-300s; re-arming costs an HTTP round trip, not a model turn, so short server windows and indefinite
  client patience are not in tension. Fails LOUD (503), because a wait endpoint that quietly answers
  "nothing" when its channel is broken is indistinguishable from a quiet bus, `/terms` `/privacy` `/pricing` (markdown
  rendered through the design system), `/brand`. Every HTML page carries consent-gated analytics
  (decision 021); `HEAD` on any GET route is served as GET with no body. `/mcp` (the MCP transport, bearer-authed; an unauthenticated request gets a 401 with an
  RFC 9728 `WWW-Authenticate` challenge), `/.well-known/oauth-protected-resource` (public PRM metadata;
  advertises the authorization server when it is enabled, decision 024), `/healthz` (public), `/join` (public;
  open-code redeem RETIRED per decision 037, returns 410), `/p/:handle/:slug` (+ `.../request`) (public;
  request-to-join RETIRED per decision 038, returns 410), `/notifications` +
  `/admin/*` (owner-scoped admin),
- **OAuth 2.1 authorization server (decision 024, `src/oauth-as.ts`):** the one-click "Add LLM Bus to
  Claude" connector - claude.ai speaks OAuth, not a pasted bearer. Stateless endpoints in `http.ts`:
  `/.well-known/oauth-authorization-server` (RFC 8414 metadata), `/register` (RFC 7591 DCR, public PKCE
  clients, https+loopback redirect_uri allowlist), `/token` (auth-code + PKCE S256 exchange + refresh
  rotation). Session-bound endpoints in `handleAdmin`: `/admin/authorize` (the connector consent screen
  after SSO) + `/admin/authorize/consent` + `/admin/connection-status` (owner-scoped connect-card presence
  poll, 404-no-oracle; decision 028). The issuer is the ADMIN origin (`OAUTH_REDIRECT_BASE`, where
  the SSO login + `__Host-` cookie + consent live), NOT the resource origin (`PUBLIC_URL`); the PRM on
  the resource origin points to it. An issued access token is a normal `tokens` row with `expires_at`
  so `authenticate()` resolves it unchanged (invariant 1); refresh tokens live in `oauth_refresh_tokens`
  so they never resolve as a bearer; codes/access/refresh are all sha-256-hashed (invariant 7); codes are
  single-use (`consumed_at` under `FOR UPDATE`) + short-lived. All AS routes 404 when SSO is off
  (`ADMIN_AUTH_SOURCE=header`/self-host), so a bearer-only deployment advertises no dead endpoint
  (fail-open, invariant 5). At the consent screen the verified human picks the participation: accept a
  pending invite targeted at their email (inline, no pasted token), reconnect an existing membership, or
  create a personal project.
- **Admin information architecture (decisions 023/039):** a two-level nav rendered by `layout()`. Account level
  (owner-gated header nav): Projects (`/admin`), Tasks (`/admin/tasks`, decisions 039/041 - the cross-project,
  membership-scoped task control board, rendered as a scannable status-GROUPED LIST where each task opens a
  detail/working page (`/admin/projects/:id/tasks/:rid`) to create/assign/edit/answer/cancel/reopen it, declare
  dependencies, and see its links; `?project=` narrows), Participants
  (`/admin/participants`), Billing (`/admin/billing`), Settings (`/admin/settings`, which absorbed the old
  `/admin/handle`). `/admin/review` 302-redirects to `/admin/tasks` (the review board was retired by 039).
  Project level (a tab strip on `/admin/projects/:id`): Board (default - the Activity mirror + Tasks-by-status
  in the 5 effective columns + Decisions, decision 022; READ-ONLY, driven from `/admin/tasks`),
  Access (`/access` - members + targeted email invites; decision 038), Settings (`/settings`,
  replacing the old `/edit` - rename, hosted-structure placeholder, delete). Old `/admin/handle` and
  `/admin/projects/:id/edit` 302 to their new homes (still owner-checked, 404 on mismatch). Every page
  routes through `layout()` so the analytics chokepoint (021) + HEAD-as-GET hold; each project sub-route
  gates on `loadOwnedProject` (invariant 3). Permanent "what this is" intros are collapsed `<details>`.
- **Connect card + live indicator (decision 028):** the three post-provision surfaces (`acceptedPage`,
  `wizardConnectCard`, `requestClaimedPage`) share ONE tabbed `connectCard()` (per-client tabs via a
  CSS-only hidden-radio switch - zero JS; a one-click "Add to Claude" deep link; token shown once inside
  copy blocks). `GET /admin/connection-status?participation=<id>` -> JSON is an owner-session-scoped
  presence read (`connectionStatus`): it re-proves the participation via `human_owner_id = $owner OR
  projects.owner_id = $owner`, 404s identically on mismatch (no 403 oracle, invariant 3), never returns
  the token, and reports a positive edge only (`seen:false` = "not yet", never "offline" - invariant 5).
  A single static inline poll in `layout()` flips the banner grey->green on the first check-in.
- **Human task control surface (decision 039):** `/admin/tasks` is the cross-project board where a HUMAN
  drives the task graph from the web - create/assign/edit/answer/cancel/reopen a task, declare a dependency,
  send a message - so a human can run a headless agent through the bus alone. A human holds no token, so the
  writes live in the owner-keyed `src/admin/task-writes.ts` (the twin of `postFromOwner`, NOT Ctx-keyed
  `domain/`); each mutator LOCKS the task and re-proves the decision-037 membership predicate in the SAME SQL
  (an OWNER or `admin` member acts on ANY task in the project - a supervisor override; a plain MEMBER only on
  tasks assigned to THEM; zero rows -> null -> the handler 404s, no 403 oracle - invariant 3). The assignee
  dropdown value tag (`agent:<pid>` / `human:<ownerId>`) is re-proven in-project before the write, so it
  grants no identity (invariant 1). The cross-project read (`listTasksForOwnerBoard`) carries the same
  predicate; every NON-task owner surface stays owner-scoped (`loadOwnedProject`/participants/activity), so a
  plain member gains their task-board rows only. **Two budgets, never one (decision 062):** the read caps ONLY
  the terminal archive - a `ranked` CTE numbers rows within a terminal column and assigns 0 to everything
  actionable, so the plate passes through whatever the cap is, by construction rather than by a limit chosen
  to be large; `groupTotal` (`count(*) OVER (PARTITION BY status)`) carries each column's true pre-cap depth so
  a capped column never states a trimmed number. The same rule governs the two agent-facing plate surfaces:
  `list_tasks` sorts terminal rows LAST (a page limit can only eat archive) and reports `truncated`;
  `whats_new.my_open_tasks` reports its true size. Guarded by `board.truncation`. **A manual block is accountable (decision 074).** `task_block` REFUSES the old two-argument call: it
requires `unblock_condition` (what would lift it) and an owner of the unblock (`unblock_owner` for an agent,
`unblock_human` for a person), resolved through the same `resolveAssignee` the assignment path uses, so a
name is never identity (invariant 1). `task_blockers` carries four additive nullable columns
(`unblock_condition`, `unblock_participation_id`, `unblock_owner_id`, `unblock_name`), both FKs
`ON DELETE SET NULL` with the name as the surviving display snapshot (invariant 6). The block then lands on
that owner's plate as `whats_new.waiting_on_you`, excluding terminal tasks - a block on a cancelled task
could never be cleared by doing the work - and reporting its true total when the cap cuts it. **Known gap,
open as bus task #1262:** `unblock_owner_id` has no HUMAN-facing surface; a block naming a person reaches the
agent channel only, and decision 076 files it under "not yours to action" in that person's digest.
A DECISION is a task carrying `options`; `task_answer` records
  the choice + completes it + delivers to every dependent's assignee (which unblocks them, blocked being
  derived). `/admin/review` 302s here; the review flow (`review`/`answer_review`/`task_reviews`/the review
  board) was retired by 039, `task_reviews` retained dormant. Guarded by `admin.taskwrites` (the load-bearing
  isolation test) + the rewritten `membership.isolation`. **Presentation (decision 041):** the board is a
  scannable status-grouped LIST (one line per task - title link + at-a-glance meta + `decision`/`N links`/
  `blocked` badges; no body, no inline forms), and the work happens on a task DETAIL page (`GET
  /admin/projects/:id/tasks/:rid`, loader `loadOwnerBoardTask` carrying the same 037 predicate -> null/404 on
  a foreign/missing/non-finite id, placed after `/tasks/new` so "new" matches first) that shows the full body,
  the controls, and artifact links as DISCRETE listed items; the New-task form authors links (`label | url`
  per line). The detail loader's isolation is guarded by the extended `membership.isolation`.
  **Response + lifecycle controls (decision 042):** the detail page renders a prose RESPONSE field on EVERY
  task (not just option-tasks) - "Answer & close" records the note + completes, and the answer is delivered
  back to the ASKING agent (`created_by_id`), not only to dependents, closing the human "ask me" round trip;
  "Hand to agent" reassigns to a chosen agent WITH the note. An explicit STATUS dropdown (Todo/In progress/
  Done/Cancelled mapping to start/un-start/ship/cancel/reopen; `/status` + `/respond` replace the per-verb
  routes) removes the ambiguous "Cancel" and adds the in_progress->todo un-start (`taskStop`, additive
  `task_stop` event). Every row + the detail page show the task `#id`. Guarded by `admin.taskwrites`
  (hand-off/stop/answer-to-asker isolation) + `task.statemachine` (taskStop + answer-notifies-asker).
  **Legibility (decision 055):** each task row + the detail card carry per-state shading (`.taskrow.s-*` /
  `.taskcard.s-*` off the `--state-<status>-*` tokens); the five status columns always render (an empty group
  shows one placeholder row - a celebration for an empty Todo); and a human-authored task shows "from" via the
  additive `tasks.created_by_owner_id` (a human is not a participation, so `created_by_id` is NULL - the board
  `created_by_name` COALESCEs the owner handle in). The column is `ON DELETE SET NULL` (invariant 6).
- **One-time platform announcements (decision 035):** `whats_new` carries a one-time `announcements`
  array of server-authored notices so a launched capability reaches every connected agent platform-wide
  with nobody told by hand. The source is an ordered, append-only constant list `ANNOUNCEMENTS`
  (`src/announcements.ts`, `{id, body}`, monotonic ids; ids 1-4 carry the v2 task model after the decision-039
  relaunch rewrite, id 4 the "v2 is live" notice). Delivery is keyed by `participations.announced_through` (a `BIGINT`
  high-water mark, additive/reversible, existing rows default 0 so they receive all current
  announcements once): `whats_new` returns the announcements with an id above the marker and, on an
  advancing call, advances the marker to the max delivered id in the SAME transaction as the event
  cursor - the exact twin of the one-time `welcome`. It honors `advance_cursor` (a peek surfaces but does
  not consume) and is best-effort: the block is `SAVEPOINT`-guarded so any failure (e.g. a pre-migration
  missing column) rolls back to the savepoint and returns the real `whats_new` payload without
  announcements, never failing the call (the transaction-safe analogue of the `mcp.ts` nudge-count
  swallowing). No new MCP tool; the change is isolated to `whats_new`. Invariant 1: the marker is keyed
  by the token-derived `ctx.participation.id` and matched only against the server-authored list, never
  from tool input.
- **Open-core split (decision 017):** this repo (`llm-bus-cloud`, private) is the commercial source;
  this repository IS the public AGPL engine. `src/billing/*` is a set of inert stubs behind the
  `billingEnabled()` seam, and the cross-tenant operator console is not part of it - a hosted service
  composes the commercial layer on top rather than forking this.
- **Admin trust boundary (config-selected by `ADMIN_AUTH_SOURCE`):** in `header` mode (default; the
  live service) the SSO-derived email header is trusted **only** because Caddy strips any
  client-supplied copy (your reverse proxy's config). In `oauth` mode (the hosted topology) there is no
  trusted header: identity is a verified Google/GitHub login bound to the session
  (`/admin/login`, `/admin/auth/:provider/start|callback`), and the hosted edge additionally fronts
  `/admin` with IAP + signed-JWT verification (decision 009). The two modes never both apply. Either
  way id-routes re-prove ownership and 404 on mismatch (no 403 oracle). Invariants 3 and 4.
- **Hosted invites:** `/admin/accept?token=...` signs the joiner in (carrying the invite through the
  OAuth `state`) and, on callback, accepts the invite in one transaction (`invites` table; decision
  010). The participant is created under the project owner, so the accepter gets a token but no admin
  over the project (invariant 3).

## Invariants (do not break)

The seven load-bearing invariants, moved here from CLAUDE.md §02 by the Genesis v1.7 migration
(structurally loaded where they matter; CLAUDE.md keeps the pointer). Each has a guarding test; a
change touching one needs that test green and, if the contract shifts, a decision file.

1. **Identity comes from the token, never from tool input; scope comes from that token's OWN memberships.**
   `authenticate()` resolves a bearer token to `(participation -> project + participant + owner)`; tools
   receive a `Ctx`. Every query is project-scoped; the displayed actor is the participant name.
   **Amended by decision [070](decisions/070-one-connection-many-projects.md)**, **narrowed by
   [077](decisions/077-a-token-is-its-agent-not-its-human.md)**: a tool MAY name a project, but only one
   **THIS AGENT** holds a seat in - `list_projects` enumerates exactly that set and `resolveProject` opens
   exactly that set, from ONE reach predicate so what you can see and what you can act in cannot drift apart.
   The identity that scopes a token is the AGENT, not the human behind it: 070's predicate carried a second
   arm reaching every seat bound to the same human, and since the `Ctx` is composed from the row that is
   reached, a token minted for a deliberately non-admin agent resolved to a DIFFERENT agent's seat with that
   seat's name and `is_admin`. Arm 1's driver guard survives (a seat of this same participant driven by
   another human is still refused, so a re-homed membership cannot bridge two people), and privilege still
   comes from the seat you land on - what changed is which seats you can land on. The old wording ("there is NO tool that names a project or enumerates
   them") made isolation a side effect of the token having nowhere else to point; the guarantee is now
   asserted directly. Naming any other project is refused with a message BYTE-IDENTICAL to the one for a
   project that does not exist, so the refusal is never an existence oracle. `isolation.project`
   guards the reads (events, posts, leases, tasks, sequences), the WHO surfaces (`listRoster` - agents AND
   human members, including a handle-less member's EMAIL - and `who_is_active`), the assign-probe errors
   (not an existence oracle), the token->project binding, AND that a token can enumerate and act in only its
   own memberships (`multiproject` carries the reach rule itself, `smoke.mcp` the live surface). Each isolation assertion is PAIRED with a
   positive control, because a test that only checks the other tenant's rows are absent passes just as
   happily when the query returns nothing at all. (`isolation.project`)
2. **`claim` is atomic + gap-free.** The fused `INSERT ... ON CONFLICT (project_id, name) DO UPDATE
   SET current = current + 1 RETURNING` is the lock - keep it one statement, event in the same
   transaction. (`concurrency.claim`, 500 concurrent)
3. **Owner isolation** (web admin): every `/admin` query is scoped by the SSO-derived owner id;
   id-routes re-prove ownership and 404 on mismatch (no 403 oracle). **The `/admin/tasks` board is
   membership-scoped (decisions 037/039, **amended by 078**):** MEMBERSHIP MEANS SEEING THE PROJECT -
   an owner, an admin member and a plain member all READ every task in it; a non-member reads nothing
   and is refused with the same null as a bad id. **Read and write predicates DIVERGE on purpose and
   must not be re-merged:** a plain member still writes only tasks assigned to them
   (`task-writes.ts`), and the board's `mine` flag marks which rows are theirs - seeing is not owning.
   Before 078 the same membership already permitted opening the project, reading its roster and
   CREATING tasks in it while the read predicate hid every task but the member's own, so a member
   could add a task to a board they could not read. The project's OWN pages (overview/access/settings)
   are the admin line: the owner or an `admin` member READS them, through `projectReadClause()` defined
   ONCE and used by all six read sites (the route loader plus `listParticipations`, `listInvites`,
   `loadProjectActivity` and BOTH queries in `loadProjectBoard`) - gating the route alone leaves the
   loaders owner-only and renders the page blank, which is how the first attempt failed. Every mutation
   stays on `loadOwnedProject`, so a visibility rule can never hand out the power to mint or revoke
   credentials (the 077 coupling). Every OTHER admin surface stays owner-scoped. (`admin.isolation`, `membership.isolation`, `admin.taskwrites`)
4. **The `/admin` email header is trusted only because Caddy strips client copies**
   (your reverse proxy's config). Never read it without that boundary. CSRF on every POST; all HTML via
   the `esc()` chokepoint. (`admin.authheader`)
5. **The reconcile hook and service posture are fail-open** - advisory, never block work when
   unreachable. (`hook.failopen`)
6. **Deleting a participant preserves the ledger** - event/post/task rows keep `actor_name`; the FK
   is `ON DELETE SET NULL`. Do not make those FKs cascade.
7. **Tokens are sha-256-hashed at rest**, revocable; plaintext shown once. The app binds `127.0.0.1`
   (public/TLS via Caddy). All SQL parameterized.

**Schema changes:** `db/schema.sql` is idempotent (`CREATE ... IF NOT EXISTS`) plus an "Idempotent
upgrades" ALTER section for changes to existing tables. `npm run migrate` applies it. There is a
production DB on the VM - additive, reversible migrations only.

**Web pages carry analytics (decision 021):** every server-rendered HTML page MUST include the shared
analytics chokepoint - `gaHead()` in `<head>` and `cookieBanner()` before `</body>`, both from
`src/analytics.ts`. Never hand-roll gtag on a page. Both are empty when `GA_MEASUREMENT_ID` is unset
(self-host / open engine / dev render nothing), and consent is opt-in (Consent Mode v2 default-denied
until the banner is accepted). When you add a new HTML page or document template, wire it through
that chokepoint; `test:analytics-allpages` guards the existing surfaces. `HEAD` is served as `GET`
with no body - do not add `GET`-only routes that 404 on `HEAD`.

## Testing pyramid

Integration-first against a real local Postgres (no mocks for the DB). 62 test files, each an
executable script run by `tsx`, with a shared `test/_setup.ts`:

- `concurrency.claim` - 500 concurrent claims -> 500 distinct gap-free ids + 500 events (guards
  invariant 2).
- `smoke.mcp` - full MCP round-trip.
- `post.ack`, `lane.delivery`, `lease.expiry`, `task.statemachine`, `digest.cursor` - coordination flows.
- `participant.delete` - removing an agent: the ledger survives it, and its open work goes somewhere
  deliberate (a chosen successor, else back on the board) rather than nowhere.
- `onboarding.flow` - the JOURNEY, not a function: enroll -> project -> agent connected -> assign from the
  web -> answer on both surfaces -> rename. Guards the gaps BETWEEN correct functions, which is where every
  cross-surface defect this month has lived.
- `admin.taskwrites` - the load-bearing v2 isolation test (decision 039): the owner web task-write layer is
  membership-scoped - a non-member and a cross-owner get null from every mutator with the target row
  byte-identical and indistinguishable from a bad id (no 403 oracle), the assignee tag grants no identity
  (out-of-project agent/human tags refused, invariant 1), a plain member acts only on their own tasks, the
  owner has full authority + supervisor override, self-dep/cycle edges refused; plus the read board +
  assign-roster isolation.
- `isolation.project` - project scoping (invariant 1).
- `hook.failopen` - the kit hook warns and proceeds when the service is down (invariant 5).
  cross-tenant list, comp/suspend require operator + CSRF, query-layer guards are inert without an
  operator (invariant 3 exception, decision 013).
- `admin.crud`, `admin.isolation`, `admin.authheader` - admin CRUD, owner isolation (invariant 3),
  the trusted header boundary (invariant 4).
- `invite.redeem` - the (retired) open-invite redeem function (decision 037).
- `invite.accept` - the hosted OAuth-accepted invite transaction: single-use, expiry/revoke,
  targeted-email refusal, and that acceptance grants a token but no project access (invariant 3).
- `oauth.signup` - verified-email-only provider linking (rejects unverified Google / non-primary
  GitHub), the authorize-URL builder, and self-serve signup idempotency.
  idempotently, skips comped owners (cursor fast-forwarded), and lets the balance go negative without
  blocking an action (fail-open, decision 015).
  PaymentIntent id; setup_intent stores the card and grants the welcome credit once.
  configured, and never re-granted on subsequent logins.
- `activity.panel`, `board.panel` - the read-only owner-scoped project surfaces on `/admin/projects/:id`
  (the Activity mirror: events -> plain-language summaries, active leases, sequence state, live agents;
  the Board: tasks grouped by status with assignee + the decision record). Each is isolation-tested - a
  non-owner sees empty lists, never a cross-tenant leak (invariant 3) - and escapes rendered values.

If you change behavior, add or extend a test here.

## Required verification commands

The Definition of Done and the Verification Mandate (CLAUDE.md §04, §05) bind to:

```bash
npm run verify   # the docs checks (decisions-index, supersession, doc-counts, claude-size), then tsc --noEmit + the full test suite
```

`test:claude-size` (Genesis v1.7 attention budget) counts CLAUDE.md lines: warn above 200, fail
above 250; raising the ceiling is a decision, not an edit.

Prerequisite: a local Postgres 16 on port 5440 with an `llm_bus` database. `DATABASE_URL`
defaults to `postgres://<you>@127.0.0.1:5440/llm_bus`. `npm run typecheck` and the individual
`npm run test:*` scripts exist for narrower runs. `verify` is the gate - do not merge red.

## Coding standards

1. ESM with `.js` import specifiers (NodeNext); `tsc --noEmit` must be clean.
2. All SQL parameterized; all DB access via `db.ts`; all HTML via `esc()`.
3. No new runtime dependency without a decision file.
4. Schema edits are additive/reversible and idempotent (`IF NOT EXISTS` / the ALTER section).
5. Style (CLAUDE.md §12): no em dashes, no emoji in code/docs/commits, terse prose, one H1 per
   markdown file, relative links within the repo.
6. The seven invariants in "Invariants (do not break)" above are load-bearing; a change touching one
   needs the relevant guard test green and, if it alters the contract, a decision file.
