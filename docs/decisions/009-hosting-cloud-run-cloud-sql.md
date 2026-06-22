# 009 - Hosted service on Cloud Run + Cloud SQL (Postgres)

**Date:** 2026-06-16
**Status:** Deferred (the scale/HA escape hatch). The commercial launch runs on the existing
`odina-vm` per [014](014-commercial-launch-on-odina-vm.md); this Cloud Run + Cloud SQL design is kept
built and ready for when scale or managed-HA demands justify Cloud SQL's standing cost, not adopted
at launch.

Supersedes the hosting portion of [002](002-stack-atomic-claim-hosting.md) (the `odina-vm` /
systemd / Caddy arrangement) **only when the escape hatch is taken**; until then 002's VM deploy
stands and is the launch target (014). The stack and the atomic-claim mechanism in 002 are unchanged.
Adopting this needs the full feature pipeline (CLAUDE.md §11), a re-proof of the load-bearing
invariants on the new infrastructure (notably the 500-concurrency claim on Cloud SQL and the IAP/JWT
admin boundary), and an `architecture.md` update landing with the code.

## Decision

Run the hosted commercial service on **Google Cloud Run** with **Cloud SQL for PostgreSQL 16**.
Database stays Postgres - decided and locked - because the atomic gap-free `claim` (invariant 2)
depends on the single-statement `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` row lock, proven
at 500 concurrency. No migration to Firestore or any non-Postgres store.

Concrete shape:
- **Connection:** the Cloud SQL Node.js connector (`@google-cloud/cloud-sql-connector`) with IAM auth
  (no DB password), a direct `pg` pool. Initialize the connector once per container; use lazy
  certificate refresh (Cloud Run throttles CPU outside request handling and can starve a background
  refresh timer). `DATABASE_URL` / connection config from Secret Manager.
- **No transaction-mode pooler in the claim path.** A transaction-mode PgBouncer breaks the row-lock
  serialization the claim relies on. Use a direct pool; if pooling is ever needed, use Cloud SQL
  Managed Connection Pooling, not a transaction-mode proxy in front of `claim`.
- **Pool sizing under autoscale:** total connections = instances x pool_size against a fixed Cloud SQL
  `max_connections` (and a hard 100-connections-per-instance Cloud Run limit). Start `pg` pool
  `max: 5`, `--concurrency=80`, `--min-instances=1` (avoid cold-start + connector-init latency), and
  cap `--max-instances` so `max_instances * pool_size` stays under `max_connections` with headroom.
- **Bind address:** Cloud Run requires binding `0.0.0.0:$PORT`. The platform provides the network
  boundary and TLS, replacing the VM's "bind 127.0.0.1 behind Caddy" arrangement. Invariant 7's
  TLS-via-platform property is preserved; its literal 127.0.0.1 bind clause relaxes for the Cloud Run
  topology (recorded here as the contract change).

**The sharp edge - invariant 4 (admin trust boundary).** Cloud Run does NOT strip arbitrary
client-supplied headers; it only overwrites a few infra headers. A lift-and-shift that keeps reading
a plain `x-auth-request-email` is immediately spoofable. Replacement:
- Front `/admin` with Identity-Aware Proxy (IAP). IAP injects `X-Goog-IAP-JWT-Assertion`, an ES256
  JWT signed by IAP.
- On every `/admin` request, verify the JWT: `alg=ES256`, signature against IAP public keys,
  `iss == https://cloud.google.com/iap`, `exp`/`iat` within skew, and `aud` exactly equal to the
  service's resource path. Take the email from the verified payload, never an unsigned header.
- Set Cloud Run ingress to `internal-and-cloud-load-balancing` AND disable the default `run.app` URL,
  so nothing bypasses IAP and the load balancer to reach the container and forge headers.
- Keep `/mcp` on bearer-token auth (allow-unauthenticated at the Cloud Run IAM layer; the app enforces
  its sha-256 token). Agents need programmatic access and must not sit behind IAP.

This makes invariant 4 strictly stronger ("trust because the signature verifies" rather than "trust
because the proxy stripped it"). The `admin.authheader` guard test is rewritten to assert a forged
email with no valid signed assertion is rejected.

## Context

Decision 002 deliberately chose a namespaced slot on the shared `odina-vm`; PLAN milestone 2 always
flagged dedicated hosting off the shared VM as a pre-commercialization step. Commercialization needs
isolated, self-serve, scalable hosting and a clean separation from other tenants on the VM. GCP keeps
the DB native-Postgres (no claim rework) and offers a free compute tier (Cloud Run Always Free) plus
startup credits to offset Cloud SQL (the only meaningful recurring cost; see the sponsorship note in
the strategy doc).

## Alternatives considered

- **Stay on the shared VM.** Rejected: entangled with a private monorepo and other tenants; not a
  clean commercial posture; PLAN milestone 2 already called for moving off it.
- **Firestore / serverless DB.** Rejected and locked: no single-statement equivalent of the gap-free
  claim; would rebuild coordination on transactions/distributed counters and re-prove 500-concurrency
  correctness for no offsetting gain.
- **Unix-socket / password Cloud SQL connection.** Acceptable for a quick start but rejected as the
  target: IAM auth removes a long-lived DB password.
- **Containerize but keep oauth2-proxy as the strip.** Possible as a Cloud Run sidecar, but IAP +
  signed-JWT verification is the cleaner, platform-native replacement and removes the "trust an
  upstream-set header" pattern entirely.

## Consequences

- New build artifacts: `Dockerfile`, `.dockerignore`, `ops/cloudrun/` (service config + runbook,
  Secret Manager wiring). Docker as a build surface supersedes 002's "no Docker for the app" for the
  Cloud Run target only.
- New runtime dependency `@google-cloud/cloud-sql-connector` - additive, gated by this decision and an
  `architecture.md` import-rule update at implementation time.
- **Mandatory gate before any cutover:** run `test/concurrency.claim` against the Cloud SQL instance
  and confirm 500 distinct gap-free ids. Do not cut over if it does not pass.
- The live VM service stays primary and untouched until a deliberate DNS/cutover; all new infra is
  parallel (staging Cloud Run service on a non-production domain first).
- `/admin` either co-ships with the IAP/JWT change or the first Cloud Run deploy is MCP-only, to avoid
  ever exposing a spoofable admin header.

## Follow-ups

- Apply to the Google for Startups Cloud Program Start tier ($2k credits) to offset Cloud SQL; plan
  for the ~1-year credit cliff (Cloud SQL has no permanent free tier).
- Decide backup/HA posture for Cloud SQL at cutover.
- See [010](010-oauth-self-serve-signup-and-invites.md) (sequenced with the `/admin` auth change) and
  [011](011-stripe-billing-over-the-ledger.md).
