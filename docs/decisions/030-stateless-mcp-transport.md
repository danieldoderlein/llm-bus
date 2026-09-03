# 030 - Stateless MCP transport (drop the in-memory session map)

**Date:** 2026-07-13
**Status:** Accepted (the operator greenlit the reliability fix on 2026-07-13). Number claimed on the bus
(`claim("decisions")` -> 030). Fixes the HIGH-severity reliability bug found by an investigation this session.

## Context

The `/mcp` endpoint ran the MCP Streamable-HTTP transport in **stateful** mode: a POST `initialize` minted a
session id (`sessionIdGenerator: () => randomUUID()`), the transport was stored in an in-memory `Map`
(`sessions`), and later requests presented `mcp-session-id` to reuse it. Sessions were idle-reaped after 10
min and capped at 2000.

That map is **process-local and non-durable**, which makes a connected agent's bus session fragile in exactly
the way that matters for "connect an agent and leave it running to watch it coordinate":

- **Every deploy restarts the process** (`systemctl restart yolo.service`), wiping the map.
- **A >10-min idle gap** reaps the session.

After either, the server correctly returns `404 unknown session` - but the MCP SDK client (1.29.0) does **not
self-heal** on a 404: it throws and keeps the dead session id, so every subsequent bus call also 404s. The
agent's bus tools silently stay broken until a human restarts/reconnects the client. For a service that
deploys frequently, this is the felt reliability gate.

Crucially, the stateful machinery bought us **nothing** here: every `/mcp` request already re-authenticates
the bearer token and rebuilds `ctx` from scratch, and the server sends **zero** server-initiated
notifications (no `sendNotification`/logging/resource-update anywhere), so there is no server->client stream
that needs a durable session.

## Decision

Run the transport **stateless**: `sessionIdGenerator: undefined`, a **fresh** `StreamableHTTPServerTransport`
+ `buildServer(ctx)` per POST `/mcp`, torn down when the response closes (`enableJsonResponse: true` was
already set, so responses are single JSON bodies, not SSE streams). No session id is issued, so there is no
in-memory session to lose on restart or idle - the next request from the same agent simply works. `GET`/`DELETE
/mcp` return `405` (stateless mode has no session stream to open or session to tear down).

Removed: the `sessions` map, `Session` type, `SESSION_TTL_MS`, `MAX_SESSIONS`, the session sweeper's session
pass (the interval stays, now only expiring the public rate-limit windows), the `mcp-session-id` lookup
branch, and the initialize-gate. Identity safety is unchanged and actually simpler: every request derives
identity from the token (invariant 1), so the old "session id vs token mismatch -> 403" case cannot arise.

## Consequences

- A deploy or idle gap is now transparent to connected agents; no manual reconnect.
- Per-request transport+server construction is cheap and already exercised at scale - the 500-concurrent
  `concurrency.claim` invariant test and the real-client `smoke.mcp` test both pass on stateless (they use the
  actual MCP SDK client doing initialize + many tool calls), which is the empirical proof the handshake works.
- No memory growth from accumulated sessions; the `MAX_SESSIONS` 503 backpressure is gone (per-request
  lifetime replaces it).
- `docs/architecture.md` stack line updated from "stateful sessions" to "stateless per-request".
- The atomic-claim (invariant 2) and fail-open (invariant 5) properties are untouched; this changes only the
  transport lifecycle, not any domain logic.

## Alternatives considered

- **Keep stateful, raise the TTL / tolerate re-initialize.** Rejected: does not fix the deploy case (restart
  still wipes the map), and the client still won't self-heal on the 404.
- **Server-side session persistence (Redis/DB).** Rejected: heavy new infrastructure for a transport that
  carries no server->client state; stateless removes the need entirely.
- **Auto-recreate a session on an unknown id.** Rejected: cannot rebuild the SDK's initialize handshake
  mid-stream without the client's cooperation; stateless is the clean form of the same idea.
