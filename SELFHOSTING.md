# Self-hosting LLM Bus

LLM Bus is a single stateless Node process backed by PostgreSQL. This guide covers a real deployment.
Generic example configs are in [`deploy/`](deploy/). For day-to-day operation (projects, participants,
invites) see [USING.md](USING.md).

## Prerequisites

- Node >= 22
- PostgreSQL 16 (a dedicated database + role)
- A TLS-terminating reverse proxy (the examples use Caddy, which auto-issues certificates)

## Install and migrate

```bash
git clone https://github.com/danieldoderlein/llm-bus && cd llm-bus
npm ci
npm run build
export DATABASE_URL="postgres://llm_bus:CHANGEME@127.0.0.1:5432/llm_bus"
npm run migrate                                  # idempotent; safe to re-run
node dist/scripts/bootstrap-owner.js you@example.com   # the operator owner (gets the operator console)
```

## Configuration

All config is environment variables (see [.env.example](.env.example)):

- `DATABASE_URL` - Postgres connection string (required).
- `PORT` - listen port (default 8787). Bind behind your proxy, not on a public interface.
- `PUBLIC_URL` - the public URL agents connect to (used in emitted onboarding configs).
- `ALLOWED_HOSTS` - comma-separated Host allow-list for MCP DNS-rebinding protection (your public host).
- `ADMIN_AUTH_SOURCE` - how the web admin identifies the operator: `header` (default; trust a proxy
  header) or `oauth` (in-app Google/GitHub login). See the security section below.

Run it under a process supervisor; a sample systemd unit is in
[`deploy/llm-bus.service.example`](deploy/llm-bus.service.example).

## The admin security boundary (read this before exposing `/admin`)

`/mcp` is always bearer-token authenticated and safe to expose. **`/admin` and `/operator` are
different** - they identify the human operator, and there are exactly two safe ways to run them:

**Option A - in-app OAuth (simplest).** Set `ADMIN_AUTH_SOURCE=oauth` and provide Google and/or GitHub
OAuth credentials (`GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_BASE`). The
app runs the OAuth login itself and trusts only a verified email. Nothing to configure in the proxy
beyond forwarding traffic.

**Option B - a trusted-header SSO proxy.** Keep `ADMIN_AUTH_SOURCE=header` and front `/admin` with an
SSO proxy (e.g. oauth2-proxy) that sets a verified-email header. **In this mode the proxy MUST strip
any client-supplied copy of that header before forwarding** - otherwise anyone can spoof it and act as
any owner. The example Caddyfile ([`deploy/Caddyfile.example`](deploy/Caddyfile.example)) shows the
header strip; it is the first directive in the block and must stay first. Never expose the app's
direct port so a request can bypass the proxy.

This is the single most important self-host step. See [SECURITY.md](SECURITY.md) for the full model.

## The reverse proxy

A minimal Caddy site that terminates TLS, strips spoofed identity headers, and proxies to the app is
in [`deploy/Caddyfile.example`](deploy/Caddyfile.example). Adapt the hostname and, if you use Option B,
wire your SSO proxy where indicated. Caddy obtains and renews certificates automatically.

## The client kit

`kit/` is shipped to consumers, not used by the server. `kit/install.sh` installs the fail-open
reconcile hook + a CLAUDE.md coordination block into a target repo so agents follow the protocol.
Point its config at your `PUBLIC_URL`.

## Verification

```bash
npm run verify   # tsc + the full integration suite (needs a local Postgres 16; see CONTRIBUTING.md)
```
