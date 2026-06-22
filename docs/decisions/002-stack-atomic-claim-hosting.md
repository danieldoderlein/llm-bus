# 002 - Stack, atomic-claim mechanism, hosting

**Date:** 2026-06-10
**Status:** Accepted

## Decision

- **Stack:** TypeScript on Node (>= 22; the VM runs 22, the dev Mac runs 25). ESM with NodeNext and
  `.js` import specifiers. The official `@modelcontextprotocol/sdk` served as a **remote MCP server
  over Streamable HTTP** (stateful sessions, JSON responses). **PostgreSQL** (via `pg`) for all
  state. `zod` for input validation. Per-participation **bearer tokens**, sha-256-hashed at rest -
  token = identity = attribution. No web framework: hand-rolled HTTP plus a server-rendered admin.
  Versions pinned exactly in `package.json`.
- **Atomic claim mechanism:** a single fused statement -
  `INSERT INTO sequences (...) VALUES (...) ON CONFLICT (project_id, name) DO UPDATE SET current =
  current + 1 RETURNING current` - with the `claim` event appended in the **same transaction**. The
  `ON CONFLICT DO UPDATE` row lock serializes concurrent claimers at READ COMMITTED, so two
  concurrent claims can never receive the same id and no id is handed out without a logged event.
  Empirically verified: 500 concurrent claims -> 500 distinct, gap-free ids, 500 events
  (`test/concurrency.claim.test.ts`).
- **Hosting:** the shared `odina-vm` (GCP), namespaced to `yolo` - own `/opt/yolo`, own Postgres
  role + database on the existing cluster (port 5433), own `yolo.service` systemd unit bound to
  `127.0.0.1:8787`, public via one additive Caddy vhost at `https://yolo.doderlein.com`. No Docker
  on the VM for the app itself.

## Context

The product needed a stack and an allocation primitive that is provably collision-free and
gap-free while emitting an audit event atomically. Slice 0 established these; later slices kept them
unchanged.

## Alternatives considered

- **Postgres `SEQUENCE` / `nextval()`** for allocation - rejected: non-transactional (gaps on
  rollback) and awkward to pair atomically with a ledger event. The `ON CONFLICT` counter is gap-free
  and commits with its event.
- **Stateless MCP transport** - rejected: the standard MCP client expects session continuity after
  `initialize`; stateful sessions with per-request bearer auth are the reliable path.
- **Managed Postgres (Cloud SQL) / Docker Postgres on the VM** - rejected: the VM already runs native
  Postgres; a separate DB + role on that cluster is isolated and non-disruptive.

## Consequences

- The verification suite runs the tool's `npm run verify` against a local Postgres 16 (port 5440,
  database `llm_bus`); the 500-concurrency proof is permanent.
- Deploy is namespaced and reversible (`ops/`); see [ops/README.md](../../ops/README.md). Dedicated
  hosting off the shared VM is a future decision (tracked in PLAN.md).

## Follow-ups

- Revisit hosting (HA / managed Postgres / off the shared VM) before commercialization.
  Resolved: the hosting portion is superseded by [009](009-hosting-cloud-run-cloud-sql.md) (Cloud Run
  + Cloud SQL). The stack and the atomic-claim mechanism in this decision stand unchanged; Postgres is
  reaffirmed and locked because the gap-free claim depends on it.
