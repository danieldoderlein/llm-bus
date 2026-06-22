# 010 - Google/GitHub OAuth, self-serve signup, frictionless invite exchange

**Date:** 2026-06-16
**Status:** Proposed

Implementation is gated on the full feature pipeline (CLAUDE.md §11) and is sequenced with the
`/admin` auth-boundary change in [009](009-hosting-cloud-run-cloud-sql.md). Lifts the cross-owner
sharing deferral in [004](004-owner-participant-model-and-web-admin.md). Proposed until its code and
`architecture.md` update land.

## Decision

Make onboarding frictionless - the moat. Add **Google and GitHub OAuth** for human signup/login and
for invite acceptance; keep **long-lived sha-256 bearer tokens for agents/MCP unchanged**.

**Auth plane split (preserves invariant 1):**
- `/mcp` stays bearer-token-only. An OAuth session must never authorize an MCP tool call. Identity for
  tools still comes from the token -> `Ctx`, never from input.
- `/admin` and signup/invite acceptance move to OAuth (human plane).

**Self-serve owner signup.** `resolveOwner()` already get-or-creates, so at the code level signup is
mostly: remove the IdP-edge email-domain restriction, create a free-tier owner record on first verified
login. Minimal code change beyond the auth wiring.

**OAuth implementation (as built).** Google is OIDC; GitHub is plain OAuth 2.0 (no `id_token`, no
`email_verified`). Implemented dependency-free in `src/admin/oauth.ts`: a plain authorization-code
exchange followed by a direct call to the provider's userinfo/user API over TLS (Google
`openidconnect.googleapis.com/v1/userinfo`; GitHub `api.github.com/user` + `/user/emails`). Because
the access token comes straight from the provider's token endpoint and the email is read straight
from the provider over TLS, no self-issued `id_token` signature has to be verified - so we add NO new
OAuth runtime dependency (the only new dep is the Cloud SQL connector from 009). `openid-client` was
evaluated and installed, then dropped in favor of this flow: less surface, and the email-extraction
steps (`googleIdentity`, `githubPrimaryEmail`) are pure and unit-tested. The existing session / CSRF
/ `esc()` chokepoints are preserved; the OAuth handshake `state` is bound to the session, and the
session cookie relaxes from SameSite=Strict to Lax in OAuth mode so the cross-site callback carries
it (CSRF tokens still gate every POST). No framework (Passport / Auth.js / full IdP) is added.

**Account linking - verified email only.** Link a provider login to an email-keyed owner only when
the email is verified (Google `email_verified === true`; GitHub primary+verified from `/user/emails`).
Store provider + provider-subject (`sub` / GitHub id), not just email, so re-logins match a stable
subject. This closes the unverified-email-takeover attack.

**Frictionless invite exchange.** Reuse the existing token machinery (32-byte CSPRNG token, store only
`sha256(token)`, plaintext shown once). An `invites` table (additive, idempotent) carries
`project_id`, `token_hash`, role, optional target `email`/`domain`, `reusable`, `state`, ledger-safe
`created_by`/`accepted_by` (`ON DELETE SET NULL`, invariant 6), and `expires_at`. The accept flow:
resolve context server-side from the token hash (never from URL/form - the invite-flow analogue of
invariant 1), continue with Google/GitHub (token carried in signed, CSRF-bound OAuth state), gate on
the verified email, then in one transaction upsert owner -> upsert participation -> flip the invite
`pending -> accepted WHERE state='pending'` (race loser sees already-accepted) -> issue the bearer
token -> show `/mcp` config. Same atomicity discipline as `claim`.

Three phases, each with a guarding test: (1) targeted single-use links, (2) reusable project links,
(3) verified-domain auto-join (Slack model: verified emails only, owner proves domain ownership,
public/disposable-domain blocklist, default off) - phase 3 gated behind `/security-review`.

**Forward-compat hedge (cheap, do early):** serve `/.well-known/oauth-protected-resource` (RFC 9728)
and return `401 + WWW-Authenticate: Bearer resource_metadata="..."` on unauthenticated `/mcp`
requests. Existing bearer clients never hit the 401 branch, so nothing breaks, but the server becomes
auto-discoverable the day we add an authorization server for the consumer connector pickers
(claude.ai / ChatGPT refuse user-pasted static tokens and require the OAuth discovery dance). Defer
the actual authorization server until that reach is needed; when added, delegate it (WorkOS / Logto /
Auth0) and adopt Client ID Metadata Documents, not the now-deprecated Dynamic Client Registration.

## Context

The commercialization thesis: self-host is free, but everyone you collaborate with is already on the
hosted service, so joining is the path of least resistance. That only holds if signup and invite
exchange are near-zero-friction, which means OAuth identity and one-click invite acceptance. The MCP
authorization spec (2025-06-18 onward) makes OAuth optional and casts the MCP server as a resource
server only; static bearers remain spec-legal for agents we provision, so the pragmatic split is
OAuth for humans, bearer tokens for agents.

## Alternatives considered

- **OAuth for MCP tool calls too.** Rejected: breaks invariant 1 (identity from token, not session)
  and adds friction for agents that work fine with a provisioned bearer. The PRM 401 stub is the
  forward-compat path instead.
- **Dynamic Client Registration now.** Rejected: demoted to MAY and deprecated (2025-11-25); an
  operational liability. Use CIMD if/when an AS is added.
- **A full IdP/auth framework (Better Auth / Auth.js / Passport).** Rejected: imposes its own schema
  and patterns (a structural change), heavier than a standalone service needs.
- **Keep the email-domain restriction (current oauth2-proxy `--email-domain`).** Rejected: it is the
  one thing blocking self-serve signup; removing it at the IdP edge is most of the work.

## Consequences

- No new OAuth runtime dependency (built dependency-free with `fetch`); new `src/admin/oauth.ts` and
  `src/invite-accept.ts`; `src/admin/session.ts` extended with the OAuth email + handshake state. The
  identity block in `src/admin/handlers.ts` is config-selected: header mode (default) is byte-identical
  to before (invariant 4, `test/admin.authheader` green unchanged); OAuth mode reads the verified
  session email and never the header.
- New `owner_identities` + `invites` schema in the idempotent ALTER section; cross-owner invite
  acceptance keeps the participant under the PROJECT owner's namespace, so the accepter gains a token
  but no project access (invariant 3; `test/admin.isolation` green, `test/invite.accept` adds the
  cross-owner case). Lifts the 004 deferral.
- New tests: `test/oauth.signup` (pure verification logic + signup idempotency) and
  `test/invite.accept` (the accept transaction, single-use, expiry/revoke/targeting, isolation).
- The hosted `/admin` IAP + signed-JWT boundary (decision 009) is the separate, still-open piece;
  in-app OAuth is the session source of truth implemented here.
- Keeps the open-core boundary from [008](008-open-source-agpl-and-open-core-boundary.md): a
  self-hoster gets a BYO-OAuth path; the hosted cross-org network is the commercial layer.

## Follow-ups

- Stand up a delegated authorization server for consumer connector pickers when that reach is needed.
- Domain-ownership proof for auto-join (DNS TXT) beyond "matches the owner's own verified domain."
