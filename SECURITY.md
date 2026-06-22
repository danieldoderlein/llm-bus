# Security policy

## Reporting a vulnerability

Do not open a public issue or file a public proof-of-concept against the hosted service. Report
privately via GitHub's "Report a vulnerability" (Security advisories) on this repository, or by email
to the maintainer listed on the repo. Expect an acknowledgement within a few days. Please include
reproduction steps and the affected version/commit.

Do not run intrusive tests against the live hosted service. Reproduce against a local self-hosted
instance instead.

## Security model

LLM Bus's security rests on seven invariants (also summarized in
[docs/architecture.md](docs/architecture.md)), each with a guarding test:

1. Identity comes from the bearer token, never from tool input; every read/write is project-scoped.
2. The atomic, gap-free `claim` is a single statement and is its own lock.
3. Owner isolation: every admin query is scoped by the SSO-derived owner id; id-routes 404 on
   mismatch (no 403 oracle).
4. The admin email header is trusted only because the reverse proxy strips client-supplied copies.
5. The reconcile hook and service posture are fail-open (advisory, never blocking).
6. Deleting a participant preserves the ledger (FKs are `ON DELETE SET NULL`).
7. Tokens are sha-256-hashed at rest, revocable, project-scoped; plaintext is shown once; all SQL is
   parameterized.

## Self-hosting footgun: the admin trust boundary (invariant 4)

The web admin trusts an upstream-set email header to identify the owner. This is only safe because the
reverse proxy in front of it (Caddy in the reference deploy, `ops/caddy/`) strips any client-supplied
copy of that header before forwarding. If you self-host and expose `/admin` without a proxy that
strips the client header - or any path that lets a request reach the app without passing through that
proxy - the admin identity is spoofable and an attacker can act as any owner.

If you self-host:
- Always front `/admin` with a proxy that strips the client-supplied auth header, or
- Move admin auth into the app (OAuth/IdP) and stop trusting an upstream header entirely.
- Never expose the app's direct port so that requests can bypass the proxy.

The hosted service replaces this boundary with Identity-Aware Proxy plus signed-JWT verification (see
[docs/decisions/009-hosting-cloud-run-cloud-sql.md](docs/decisions/009-hosting-cloud-run-cloud-sql.md)),
which is strictly stronger.

## Secrets

Never commit secrets. `.env` is gitignored; `.env.example` carries placeholders only. Tokens are
sha-256-hashed at rest. Generate deploy secrets at deploy time, not in the repo.
