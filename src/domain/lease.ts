import type pg from "pg";
import type { Ctx } from "../context.js";
import { appendEvent } from "../events.js";
import { query } from "../db.js";

export interface LeaseResult {
  lease_id: number;
  surface: string;
  expires_at: string;
  others: { actor: string; expires_at: string }[];
}

/**
 * Acquire an *advisory* lease on `surface`. Advisory means it never blocks: it always
 * records the holder and returns who else currently holds an active (unreleased, unexpired)
 * lease on the same surface so the caller can decide for itself. The insert and its ledger
 * event commit together in the caller's transaction.
 */
export async function acquireLease(
  client: pg.PoolClient,
  ctx: Ctx,
  opts: { surface: string; ttl_seconds?: number; note?: string },
): Promise<LeaseResult> {
  const ttl = opts.ttl_seconds ?? 1800;
  const ins = await client.query<{ id: string; expires_at: string }>(
    `INSERT INTO leases (project_id, surface, participation_id, actor_name, note, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     RETURNING id, expires_at`,
    [ctx.project.id, opts.surface, ctx.participation.id, ctx.actor, opts.note ?? null, ttl],
  );
  const others = await client.query<{ actor: string; expires_at: string }>(
    `SELECT actor_name AS actor, expires_at
       FROM leases
      WHERE project_id = $1
        AND surface = $2
        AND participation_id <> $3
        AND released_at IS NULL
        AND expires_at > now()`,
    [ctx.project.id, opts.surface, ctx.participation.id],
  );
  await appendEvent(client, ctx, "lease", { surface: opts.surface, ttl_seconds: ttl });
  return {
    lease_id: Number(ins.rows[0].id),
    surface: opts.surface,
    expires_at: ins.rows[0].expires_at,
    others: others.rows,
  };
}

/** Release every active lease this participation holds on `surface`; reports how many were released. */
export async function release(
  client: pg.PoolClient,
  ctx: Ctx,
  surface: string,
): Promise<{ released: number }> {
  const res = await client.query(
    `UPDATE leases
        SET released_at = now()
      WHERE project_id = $1
        AND surface = $2
        AND participation_id = $3
        AND released_at IS NULL`,
    [ctx.project.id, surface, ctx.participation.id],
  );
  await appendEvent(client, ctx, "release", { surface });
  return { released: res.rowCount ?? 0 };
}

/** Active (unreleased, unexpired) leases in this project, optionally filtered to one surface.
 *  Returns absolute expiry AND seconds-remaining so a caller can tell "actively held" from
 *  "about to lapse" without doing timestamp math (Q&A: visible expiry beats "held since forever"). */
export async function whoHolds(
  ctx: Ctx,
  surface?: string,
): Promise<
  { surface: string; actor: string; expires_at: string; expires_in_seconds: number; note: string | null }[]
> {
  const params: unknown[] = [ctx.project.id];
  let surfaceClause = "";
  if (surface) {
    params.push(surface);
    surfaceClause = `AND surface = $${params.length}`;
  }
  const res = await query<{
    surface: string;
    actor: string;
    expires_at: string;
    expires_in_seconds: number;
    note: string | null;
  }>(
    `SELECT surface, actor_name AS actor, expires_at,
            GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now())))::int AS expires_in_seconds,
            note
       FROM leases
      WHERE project_id = $1
        AND released_at IS NULL
        AND expires_at > now()
        ${surfaceClause}
      ORDER BY acquired_at DESC`,
    params,
  );
  return res.rows.map((r) => ({ ...r, expires_in_seconds: Number(r.expires_in_seconds) }));
}
