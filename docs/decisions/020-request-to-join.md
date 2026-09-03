# 020 - Request-to-join + authenticated outbound email

**Date:** 2026-06-23 (Phase 2 amendment 2026-07-06)
**Status:** Accepted, then Reversed by [038](038-targeted-invite-only-enrollment.md) (the open
request-to-join enrollment is retired - enrollment is targeted-invite-only; the `join_requests` table +
`request_mode` column are retained dormant, no live path). Builds on
[010](010-oauth-self-serve-signup-and-invites.md) (invites) and [018](018-global-handle-identity.md)
(global handles). Phase 2 (2026-07-06) removed the owner-relay step - see the Update section below.

## Context

Cross-owner connection was push-only: an owner mints a one-use invite and hands it over (`/join`).
There was no way for someone else to ask in. That blocked creator audience join links, a "request free
access" gate for OSS, and organic cross-team collaboration. Decision 018 (every owner has a globally
unique handle) made a project addressable as `<handle>/<slug>`, which unblocks the pull direction.

Separately, the service needs reliable outbound email beyond the IP-allowlisted Workspace relay
(deliverability as support@, used by billing too); the operational credential must stay out of the
public AGPL repo.

## Decision

Add a requester-initiated, owner-approved path into a project - the pull counterpart to invites.

- A public, OAuth-gated request page at `GET /p/:handle/:slug`; submission at `POST .../request`.
  Identity comes only from the verified session (never a header - invariant 4); rate-limited per IP and
  per requester; one open request per requester (a partial UNIQUE).
- A per-project `request_mode`: `off` (default, the project is unreachable - no existence oracle),
  `manual` (queue for owner approval), `auto` (grant on request - the creator audience link).
- Approval reuses a new shared `grantParticipation()` (extracted from `acceptInvite`): the participant
  is minted under the PROJECT owner's namespace, so the requester's own account gains no admin over the
  project (invariant 3); race-safe (`WHERE state='pending'` / `FOR UPDATE`, minting exactly once). In
  `auto` mode the token is shown once inline to the present requester. In `manual` mode, approval is a
  PERMISSION grant only and the requester self-serves the token from their own dashboard (Phase 2, see
  Update) - the original Phase-1 behavior relayed a hand-out card to the owner.
- Owner console: a pending-requests list with approve/deny and a request-mode control, all owner-scoped
  with id-route ownership re-proof (404 on mismatch, no 403 oracle), CSRF on POST, HTML via `esc()`.
- Email is outbound-only - an event relay with "click here" deep links into the signed-in dashboard;
  no inbound, no IMAP, no reply-to-approve. The SMTP sender gains optional AUTH LOGIN over TLS
  (`SMTP_USER`/`SMTP_PASSWORD`, the password from Secret Manager `YOLO_SMTP_PASSWORD`), falling back to
  the relay when unset. The credential and authenticated path are operational and excluded from the
  public curation; the open engine keeps the creds-free relay/noop seam.

## Schema (additive, idempotent, reversible)

`join_requests` (project_id CASCADE; requester_owner_id / decided_by / granted_participation_id all
ON DELETE SET NULL with a snapshotted `requester_handle`, so the ledger survives owner deletion -
invariant 6; partial UNIQUE `(project_id, requester_owner_id) WHERE state='pending'`). One additive
`projects.request_mode` column defaulting `off` (existing projects unaffected).

## Consequences

- Enables the creator-audience funnel (auto link), the OSS request-access gate (manual), and
  cross-owner collaboration, all on one mechanism, without a public directory (a project is reachable
  only if its owner shares the link and sets request_mode off `off`).
- The `/p/` route requires `ADMIN_AUTH_SOURCE=oauth` (no Caddy-stripped header on a public path); in
  header mode the page reports unavailable rather than read an untrusted header (invariant 4).
- New tests: `join.request` (manual/auto/deny, race-safe approve, invariants 1/3/6) and
  `admin.requests` (owner isolation), wired into `npm run verify`.

## Alternatives considered

- Token in the requester's dashboard after manual approval: deferred in Phase 1 (tokens are hashed at
  rest and shown once, so nothing can be re-shown later), adopted in Phase 2 by minting AT CLAIM TIME
  instead of at approval - see the Update section.
- Inbound IMAP reply-to-approve: rejected - email is outbound-only; all acceptance is click-through to
  the dashboard, avoiding email-spoofing-as-approval.

## Update (2026-07-06) - Phase 2: requester self-serve claim

Phase 1 made the owner the man in the middle: approving minted the token immediately and showed it on
the owner's hand-out card for the owner to relay. That defeats the point of a pull path. Phase 2
decouples approval from minting:

- `approveRequest(ownerId, projectId, requestId)` now flips the request to `approved` as a permission
  grant only - it mints nothing and returns no token to the owner (a single owner-scoped, race-safe
  `UPDATE ... WHERE state='pending'`). The owner's view just confirms "approved; they can connect
  themselves."
- The requester sees their requests on their own dashboard ("Your access requests"). On an approved
  one they click **Connect**, which POSTs to `/admin/my-requests/:id/claim`. `claimApprovedRequest`
  (requester-owner-scoped, `FOR UPDATE`, guarded by `granted_participation_id IS NULL`) mints the
  participation+token under the PROJECT owner via `grantParticipation` and stamps
  `granted_participation_id` so it mints exactly once. The token is shown once on a full onboarding
  card (`.mcp.json`-first, cross-surface). A second claim, or a claim by any owner who is not the
  requester, 404s (no oracle).
- The approval email (`notifyRequesterApproved`, now delivering after the SMTP_FROM unit fix) already
  deep-links to the dashboard, which is exactly where the claim button lives.
- One additive column, `join_requests.claimed_at TIMESTAMPTZ` (idempotent `ADD COLUMN IF NOT EXISTS`,
  reversible), is the delete-immune claimed-once guard. `granted_participation_id` cannot serve as the
  guard: it is `ON DELETE SET NULL`, so deleting the granted participant would reset it and re-open the
  self-serve claim (re-minting a token the owner just removed). `claimed_at` has no FK, survives the
  delete, and stays the exactly-once guard; a removed member's request reads "connected", never
  re-claimable. Invariants 1/3/6/7 preserved; isolation + self-serve + delete-immunity tests added.
