# 024 - MCP OAuth 2.1 authorization server (one-click Claude connector)

**Date:** 2026-07-09
**Status:** Accepted + DEPLOYED + E2E-VERIFIED 2026-07-10 (`67724e2` on `main`). Built:
`src/oauth-as.ts` + the `/authorize`/`/token`/`/register`/well-known routes + the consent picker +
`human_owner_id` threading + `test/oauth.authserver.test.ts` + `test/oauth.http.test.ts`. `npm run verify`
green (38). Post-review hardening: connection revoke/rotate also revokes OAuth refresh tokens; the consent
screen discloses the token-destination host + marks the client unverified. Gatekeeper + security-review
passed. **Live E2E confirmed:** claude.ai one-click "Add LLM Bus" -> discovery -> DCR -> consent -> connected
with zero pasted token, all 28 tools loaded, `whoami` returned the chosen participation. Onboarding polish
followed (`fix/oauth-onboarding-polish`): the all-green brand mark on the consent header, and every
verify-step reworded to "run whoami on LLM Bus" (a bare `whoami` triggers the shell, not the connector -
caught in the live test). (the operator: "build the OAuth thingy ... dramatically improves our flows and adoption".)
**Amends decision [010](010-oauth-self-serve-signup-and-invites.md)** - which DEFERRED the authorization
server and preferred Client-ID-Metadata-Documents over Dynamic Client Registration. This implements the AS
now, with DCR. See the Status note added to 010.

## Context

Claude.ai's web/desktop "add custom connector" flow authenticates a remote MCP server via **OAuth only**
(Dynamic Client Registration or Client-ID-Metadata-Document) - there is no field for an individual user to
paste a bearer token (confirmed: Anthropic connector docs + open issue anthropics/claude-ai-mcp#112). So our
one-click "Add LLM Bus to Claude" deep-link
(`claude.ai/customize/connectors?modal=add-custom-connector&connectorName=LLM+Bus&connectorUrl=…`) prefills
the modal but fails at the auth step today. The Claude Code CLI still connects fine with
`claude mcp add --header "Authorization: Bearer <token>"`. Building an OAuth AS makes the one-click connect
work end-to-end and lets an invited human connect with **zero token pasting** - the biggest non-dev
usability + virality unlock (see `docs/strategy/collaboration-usability-virality-gaps.md`).

## Decision

Add a minimal, hand-rolled OAuth 2.1 authorization server (node:crypto only, no new dependency). Endpoints:
`/.well-known/oauth-authorization-server` (RFC 8414), `/register` (RFC 7591 DCR, public PKCE clients),
`/authorize` (auth code + PKCE S256; the human authenticates via the EXISTING verified-email SSO), `/token`
(code exchange + refresh). The existing `/.well-known/oauth-protected-resource` (RFC 9728) advertises the AS.

**Identity integration (the crux).** An OAuth connector is per-user and the connector URL is generic, but our
identity is participation-scoped (a token = one project + one participant). Resolution:
1. **A connection maps to one participation, chosen at a consent screen** after SSO. The generic URL cannot
   carry a project, so Claude's picker won't; we pick it ourselves at consent.
2. **New user:** the picker offers "create a personal project" (same sequence as the first-run wizard).
3. **Invited user (the main win):** the picker also lists pending invites targeted at the verified email;
   picking one runs the existing `acceptInvite` inline, minting the participation under the PROJECT owner
   (invariant 3) - no new grant path.
4. **The OAuth access token is a normal `tokens` row** with `expires_at` set, so `authenticate()` resolves it
   to a `Ctx` unchanged - there is no second identity spine (invariant 1). Refresh tokens live in their own
   table so they can never resolve as a bearer.

A new `participations.human_owner_id` records which human drives a participation, so the picker can enumerate
a returning user's memberships. It is read ONLY by the AS authorize flow; `/admin` owner-scoping stays keyed
on `projects.owner_id`/`participants.owner_id` (invariant 3).

## Invariants preserved

1 (identity from the token - OAuth tokens are `tokens` rows; the only change is an additive expiry clause).
3 (owner isolation - `human_owner_id` is AS-only; admin scoping unchanged). 4 (the AS endpoints are PUBLIC,
outside `/admin`/`/operator`, so oauth2-proxy never fronts them and they never read the Caddy-stripped admin
header). 5 (fail-open - the AS is a setup path, never a tool hot path; if down, bearer/CLI + all coordination
still work). 7 (access tokens, refresh tokens, and codes are all sha-256-hashed at rest). PKCE S256 is
mandatory; redirect_uri is exact-matched to a registered value; codes are single-use + short-lived.

## Non-goals (deferred)

CIMD (an SSRF surface - fetching an arbitrary client-metadata URL); verified-domain auto-join (010 phase 3);
per-project connector URLs / the `resource` param; multiple scopes (phase 1 issues a single `mcp` scope). The
Claude Code CLI bearer path is untouched and keeps working.

## Consequences

- One-click "Add LLM Bus to Claude" works for claude.ai web/desktop; invited users connect with no pasted
  token. The consent screen's look/copy aligns with the enrollment-flow redesign (co-designed with marketing).
- New tables (`oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`) + `tokens.expires_at` +
  `participations.human_owner_id`; all additive/reversible in `db/schema.sql`. Auth-critical - ships only
  after a security review.
