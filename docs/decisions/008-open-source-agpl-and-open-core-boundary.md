# 008 - Open-source under AGPL-3.0; open-core boundary

**Date:** 2026-06-16
**Status:** Accepted

## Decision

Open-source the entire LLM Bus coordination engine under **AGPL-3.0-only**, and sell the hosted
service plus a thin band of org-trust features. The moat is the hosted cross-org identity/invite
network and managed operation, not feature-gating.

Why AGPL and not a permissive or source-available license: AGPL's network-use clause means a
competitor cannot take the code, run it as a closed managed service, and keep their changes private.
This is the same defensive choice Cal.com, Grafana, and MongoDB made. It removes the need to cripple
the open build to protect the business, and being genuinely OSI-open is itself a go-to-market asset
with the developer/HN audience. We explicitly reject source-available licenses (BSL/FSL): AGPL
already neutralizes the clone-and-close threat, and fake-open licensing costs credibility with the
launch audience.

**Open-core boundary** (model copied from Cal.com: fully open core, thin enterprise edition):

OSS (AGPL-3.0), everything needed to self-host a complete, real bus:
- The full MCP coordination surface (all current tools): allocation (`claim`, `seed_sequence`,
  `latest_claims`), presence, handoffs, leases, the task graph, `query_events`/`whats_new`.
- The atomic gap-free allocation core (invariant 2). Hiding the credibility anchor would be
  self-defeating.
- The full Postgres schema and idempotent migrations.
- The web admin (`/admin`): projects, participants, grant/mint/rotate/revoke.
- Self-assemble invites (`/join`) within a single self-hosted instance.
- The adherence kit (`kit/`): the fail-open reconcile hook, CLAUDE.md blocks, `install.sh`.
- A bring-your-own-OAuth admin login path so a self-hoster can wire their own Google/GitHub app.

Commercial-only (hosted, plus a future `commercial/` or `/ee` directory under a separate license):
- **Managed hosting** of the live service (the product; AGPL protects it from being cloned-and-closed).
- **The cross-org identity and invite network** - the global graph where an invite reaches anyone and
  the people you already work with are one click away. A hosted-only property by nature; it cannot be
  self-hosted into existence. This is the durable moat.
- **SSO/SAML/SCIM**, **audit log + compliance export**, **SLA + priority support + dedicated/VPC**.

Design constraint carried into the hosting/OAuth/billing work: keep billing and the hosted-only
OAuth glue in clearly separable modules (a future `src/billing/`, OAuth handling at the `/admin`
edge) so the open-core line is a directory boundary, not scattered conditionals.

AGPL §13 compliance for our own hosted service: we publish the deployed source. The separable
commercial layer (managed-network glue, future `/ee`) stays optional and is what a customer pays for
rather than self-hosts.

## Repository structure (two repos)

The open-core boundary is realized as two repositories:

- **`llm-bus`** (public, AGPL-3.0): the product - engine, admin, operator console, OAuth, invites,
  kit, schema, tests, and GENERIC self-host deploy examples (`deploy/`). What the community contributes
  to.
- **`llm-bus-cloud`** (private): the operator's real deploy config (real hosts/proxy/infra) plus the
  commercial-only modules (Stripe billing, the hosted cross-org network, future `/ee` features). The
  hosted service deploys from here, composing the open core + this layer.

Until launch everything stays in one private working repo; the split is a publish-time transformation,
so the live deploy never breaks and nothing public is created until we deliberately
flip `llm-bus` public. AGPL §13 (network use) is satisfied by publishing the open core; the commercial
modules are kept behind clean interfaces (billing webhook-driven, the network as its own service) so
they stay proprietary rather than pulled into the copyleft.

## Context

The owner decided to commercialize: open-source the project so people can self-host, and offer a
ready-made, quality-hosted commercial service (possibly sponsor-backed). The audience (developers
running fleets of coding agents) rarely pays personally - an employer or client usually does - which
argues for a generous free tier for virality and a low-friction, expensable team tier. Comparable
2025/2026 open-core companies (PostHog, Supabase, Cal.com, n8n, Sentry) show that hosting + the
network, not capability gates, is where this kind of product monetizes; n8n's SSO paywall is the
friction trap to avoid pre-network.

## Alternatives considered

- **Permissive (MIT/Apache-2.0).** Maximizes adoption but lets any cloud rehost a closed rival.
  Rejected: the hosted service is the business and needs the AGPL shield.
- **Source-available (BSL/FSL).** Strongest nominal protection but not OSI-open; the launch audience
  penalizes it and AGPL already closes the clone-and-close hole. Rejected.
- **n8n-style feature gating (SSO/RBAC/audit behind a key on a "business" self-host plan).** Rejected
  pre-network: every self-hoster is a potential evangelist; gating what a hobbyist needs to feel the
  product kills word of mouth. Gate only true org-trust features a 200-person company cares about.

## Consequences

- A root `LICENSE` (AGPL-3.0 canonical text) and `package.json` `"license": "AGPL-3.0-only"` land in
  the OSS-readiness pass, with `CONTRIBUTING.md`, `SECURITY.md`, and issue/PR templates.
- A CI workflow (`.github/workflows/verify.yml`) running `npm ci && npm run verify` against a
  Postgres 16 service is an additive build/CI surface (not in the runtime path); noted here per §02.
- SECURITY.md must prominently document the self-host footgun: the admin email header is trusted only
  because the reverse proxy strips client copies (invariant 4); a self-hoster who skips that strip has
  a spoofable admin. See [009](009-hosting-cloud-run-cloud-sql.md) for how the hosted service replaces
  that boundary.
- A secrets scrub precedes any public push: no plaintext token or live `DATABASE_URL` in the tree or
  history; private-host references (`odina`, `doderlein.com`) genericized outside the operator-private
  `ops/` deploy notes.

## Follow-ups

- Open-core mechanics for a future `/ee` (SSO/SAML/audit) get their own decision when first built.
- Pricing and the cross-org network are specified in
  [010](010-oauth-self-serve-signup-and-invites.md) and [011](011-stripe-billing-over-the-ledger.md)
  and the go-to-market strategy doc (`docs/strategy/`).
